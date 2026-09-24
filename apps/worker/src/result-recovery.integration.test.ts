/** 仅在显式指定独立本机 Redis 时运行，不连接应用队列、数据库或真实 Provider。 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import type { RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import { createProviderJobRecord, type ProviderExecution } from './index';
import {
  createAuthorizedTestRunWorker as createRunWorker,
  withTestExecutionBindings,
} from './test-execution-fixtures';
import { workflowSnapshotFingerprint } from './workflow-dag';

/** 专用测试 Redis；默认跳过，不读取 REDIS_URL 或任何应用凭据。 */
const isolatedRedis = process.env.RESULT_RECOVERY_TEST_REDIS_URL;

describe.skipIf(!isolatedRedis)('真实 Redis 的结果暂存与 Worker 重启恢复', () => {
  it('保留加密输出和 TTL，第二个 Worker 仅归档且清理暂存', async () => {
    const url = new URL(isolatedRedis!);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '16389' ||
      url.protocol !== 'redis:' ||
      url.username ||
      url.password
    )
      throw new Error('归档恢复验收只允许独立本机 16389 端口的无凭据测试 Redis');
    const queueName = `result-recovery-test-${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const nodeId = 'node_image';
    const snapshot: RunSnapshot = withTestExecutionBindings({
      projectId: randomUUID(),
      canvasRevision: 1,
      targetNodeId: nodeId,
      modelAlias: 'synthetic-image-only',
      parameters: {},
      submittedAt: '2026-09-24T00:00:00.000Z',
      nodes: [
        {
          id: nodeId,
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: '合成图片',
            mediaType: 'image',
            mode: 'generate',
            modelAlias: 'synthetic-image-only',
          },
        },
      ],
      edges: [],
      inputs: [],
    });
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=';
    let generations = 0;
    let archives = 0;
    const options: Parameters<typeof createRunWorker>[0] = {
      connection: { host: '127.0.0.1', port: 16389 },
      queueName,
      stepDelayMs: 0,
      providerName: 'newapi',
      resultStagingKeyring: new CredentialEncryptionKeyring({
        currentSecret: 'synthetic-integration-key',
      }),
      provider: {
        async execute(): Promise<ProviderExecution> {
          generations++;
          return {
            result: {
              provider: 'newapi',
              targetNodeId: nodeId,
              mediaType: 'image',
              summary: 'synthetic',
              inputCount: 0,
            },
            output: { mediaType: 'image', kind: 'base64', base64: png, mimeType: 'image/png' },
          };
        },
      },
      resultArchiver: async (input) => {
        archives++;
        if (archives === 1) throw new Error('synthetic storage interruption');
        expect(input.archiveInput?.content).toEqual(Buffer.from(png, 'base64'));
        return { assetId: 'asset_synthetic_recovered', version: 1, mimeType: 'image/png' };
      },
    };
    const first = createRunWorker(options);
    let second: ReturnType<typeof createRunWorker> | undefined;
    const workerErrors: string[] = [];
    first.worker.on('error', (error) => workerErrors.push(error.message));
    try {
      await first.worker.waitUntilReady();
      const failed = new Promise<void>((resolve) => first.worker.once('failed', () => resolve()));
      await first.queue.add(
        'run',
        {
          runId,
          snapshot,
          attempt: 1,
          provider: 'newapi',
          providerJob: createProviderJobRecord(runId, 'newapi'),
          cancelRequested: false,
        } satisfies RunJobData,
        { jobId: runId, attempts: 1 },
      );
      await failed;
      const failedJob = await first.queue.getJob(runId);
      expect(await failedJob?.getState()).toBe('failed');
      expect(failedJob?.failedReason).toContain(
        '生成已完成，归档失败：synthetic storage interruption',
      );
      const identity = {
        runId,
        projectId: snapshot.projectId,
        nodeId,
        snapshotFingerprint: workflowSnapshotFingerprint(snapshot),
        requestProviderJobId: `provider_job_${runId}`,
      };
      const hash = createHash('sha256')
        .update(JSON.stringify(['worker-result-staging', 1, queueName, identity]))
        .digest('hex');
      const key = `${queueName}:result-staging:v1:${hash}`;
      const client = await first.queue.client;
      const ciphertext = await client.get(key);
      expect(ciphertext).toMatch(/^mc:v2:/);
      expect(ciphertext).not.toContain(png);
      client.defineCommand('syntheticStagingTtl', {
        numberOfKeys: 1,
        lua: "return redis.call('TTL', KEYS[1])",
      });
      const ttl = await client.runCommand('syntheticStagingTtl', [key]);
      expect(ttl).toBeGreaterThan(86300);
      expect(ttl).toBeLessThanOrEqual(86400);
      await first.worker.close();
      await first.queue.close();
      second = createRunWorker(options);
      second.worker.on('error', (error) => workerErrors.push(error.message));
      await second.worker.waitUntilReady();
      const completed = new Promise<void>((resolve) =>
        second!.worker.once('completed', () => resolve()),
      );
      const retryJob = await second.queue.getJob(runId);
      await retryJob!.retry();
      await completed;
      const recovered = await second.queue.getJob(runId);
      expect(await recovered?.getState()).toBe('completed');
      expect(recovered?.returnvalue).toMatchObject({
        status: 'succeeded',
        result: { asset: { assetId: 'asset_synthetic_recovered', version: 1 } },
      });
      expect(await (await second.queue.client).get(key)).toBeNull();
      expect(generations).toBe(1);
      expect(archives).toBe(2);
      expect(workerErrors).toEqual([]);
    } finally {
      await first.worker.close();
      await first.queue.close();
      if (second) {
        await second.worker.close();
        await second.queue.obliterate({ force: true });
        await second.queue.close();
      }
    }
  }, 20000);
});

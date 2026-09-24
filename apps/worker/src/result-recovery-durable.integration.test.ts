/** 真实 PostgreSQL/Redis 的归档恢复回归；只有 Provider 与实时凭据复核使用合成桩。 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import {
  executionDatabaseRunId,
  executionSnapshotFingerprint,
  PrismaExecutionService,
} from '@multimodal-canvas/execution';
import type { RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import {
  createRunWorker,
  createProviderJobRecord,
  type WorkerExecutionAuthorization,
} from './index';
import { WorkerPrismaRunPersistence } from './prisma-persistence';
import { withTestExecutionBindings } from './test-execution-fixtures';

/** 显式隔离入口；不回退到业务 DATABASE_URL/REDIS_URL。 */
const databaseUrl = process.env.RESULT_RECOVERY_TEST_DATABASE_URL;
const redisUrl = process.env.RESULT_RECOVERY_TEST_REDIS_URL;

/** 防止把故障注入、清理或合成结果写入业务服务。 */
function assertIsolatedServices(): void {
  const database = new URL(databaseUrl!);
  const redis = new URL(redisUrl!);
  if (
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '16390' ||
    database.pathname !== '/result_recovery_test' ||
    database.username !== 'recovery_test' ||
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    redis.port !== '16389' ||
    redis.username ||
    redis.password
  ) {
    throw new Error('归档恢复验收仅允许独立本机 result_recovery_test:16390 与 Redis:16389');
  }
}

/** 注入不可用的合成凭据，真实执行服务和 Prisma 生命周期写入保持不变。 */
class SyntheticPersistence extends WorkerPrismaRunPersistence {
  /** 只在指定场景模拟首次已归档回执写入失败，之后恢复正常写入。 */
  failArchivedReceipt = false;

  override async upsertProviderJob(
    input: Parameters<WorkerPrismaRunPersistence['upsertProviderJob']>[0],
  ) {
    if (this.failArchivedReceipt && input.providerJob.payload?.deliveryState === 'archived') {
      this.failArchivedReceipt = false;
      throw new Error('synthetic archived receipt interruption');
    }
    return super.upsertProviderJob(input);
  }

  override async getProviderCredentials() {
    return { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-not-a-real-key' };
  }
}

describe.skipIf(!databaseUrl || !redisUrl)('真实持久授权的图片归档恢复', () => {
  it.each(['same-run', 'retry', 'cancelled', 'cached'] as const)(
    '%s：原结果恢复不重新生成，数据库状态与归档一致',
    async (mode) => {
      assertIsolatedServices();
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const service = new PrismaExecutionService(prisma);
      const persistence = new SyntheticPersistence(prisma, 'synthetic-integration-key');
      persistence.failArchivedReceipt = mode === 'cached';
      const userId = randomUUID();
      const projectId = randomUUID();
      const runId = `run_${randomUUID()}`;
      const retryId = `run_${randomUUID()}`;
      const queueName = `result-recovery-durable-${randomUUID()}`;
      const nodeId = 'synthetic-image';
      const runIds = [runId, retryId];
      const snapshot: RunSnapshot = withTestExecutionBindings({
        projectId,
        canvasRevision: 1,
        targetNodeId: nodeId,
        modelAlias: 'synthetic-image-only',
        credentialId: randomUUID(),
        credentialVersion: 1,
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
      const data: RunJobData = {
        runId,
        userId,
        snapshot,
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi'),
        cancelRequested: false,
      };
      /** 只插入测试专用冻结事实，不建立真实账号、密钥或上游授权。 */
      async function seed(payload: RunJobData): Promise<void> {
        await prisma.$transaction([
          prisma.run.create({
            data: {
              id: executionDatabaseRunId(payload.runId),
              userId,
              projectId,
              status: 'QUEUED',
              modelAlias: snapshot.modelAlias,
              attempt: payload.attempt,
              ...(payload.retryOf ? { retryOf: executionDatabaseRunId(payload.retryOf) } : {}),
              snapshot: snapshot as Prisma.InputJsonValue,
            },
          }),
          prisma.executionAuthorization.create({
            data: {
              runId: payload.runId,
              databaseRunId: executionDatabaseRunId(payload.runId),
              userId,
              projectId,
              snapshot: snapshot as Prisma.InputJsonValue,
              snapshotFingerprint: executionSnapshotFingerprint(snapshot),
            },
          }),
          prisma.runOutbox.create({
            data: {
              runId: payload.runId,
              queueName,
              payload: payload as unknown as Prisma.InputJsonValue,
            },
          }),
        ]);
      }
      let generations = 0;
      let archives = 0;
      let sendClaims = 0;
      let receiptWrites = 0;
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=';
      const execution: WorkerExecutionAuthorization = {
        async authorizeRun(id, frozen, owner) {
          const authorized = await service.requireAuthorization(id, frozen);
          if (authorized.userId !== owner) throw new Error('合成请求归属不一致');
        },
        async authorizeNode(id, _node, frozen) {
          await service.requireAuthorization(id, frozen);
        },
        async beginSend(input) {
          sendClaims++;
          await service.beginSend(input);
        },
        async finishSend(input) {
          receiptWrites++;
          if (mode === 'cached') {
            await service.finishSend(input);
            return;
          }
          throw new Error('synthetic send receipt interruption');
        },
        async assertRetrySafe(input) {
          await service.assertRetrySafe(input);
        },
        async reconcileReceived(input) {
          await service.reconcileReceived(input);
        },
      };
      const options: Parameters<typeof createRunWorker>[0] = {
        connection: { host: '127.0.0.1', port: 16389 },
        queueName,
        stepDelayMs: 0,
        providerName: 'newapi',
        execution,
        persistence,
        resolveDatabaseRunId: executionDatabaseRunId,
        onPersistenceError(error) {
          throw error;
        },
        resultStagingKeyring: new CredentialEncryptionKeyring({
          currentSecret: 'synthetic-integration-key',
        }),
        provider: {
          async execute(request) {
            await request.onRequestPrompt?.({
              schemaVersion: 1,
              runId: request.runId!,
              nodeId,
              attempt: request.attempt!,
              requestIdentity: 'POST /images/generations#1',
              provider: 'newapi',
              modelAlias: snapshot.modelAlias,
              mediaType: 'image',
              format: 'plain',
              parts: [{ order: 0, text: 'Generate a synthetic test pixel.' }],
              resources: [],
              sendStatus: 'pending',
              createdAt: '2026-09-24T00:00:00.000Z',
            });
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
              usage: { amount: '1.25', currency: 'USD' },
            };
          },
        },
        resultArchiver: async (input) => {
          archives++;
          expect(input.archiveInput?.content).toEqual(Buffer.from(png, 'base64'));
          return { assetId: 'synthetic-recovered-image', version: 1, mimeType: 'image/png' };
        },
      };
      let first: ReturnType<typeof createRunWorker> | undefined;
      let second: ReturnType<typeof createRunWorker> | undefined;
      try {
        await prisma.user.create({
          data: { id: userId, displayName: 'synthetic result recovery' },
        });
        await prisma.project.create({
          data: { id: projectId, ownerId: userId, name: 'synthetic result recovery' },
        });
        await seed(data);
        first = createRunWorker(options);
        await first.worker.waitUntilReady();
        const failed = new Promise<void>((resolve) =>
          first!.worker.once('failed', () => resolve()),
        );
        await first.queue.add('run', data, { jobId: runId, attempts: 1 });
        await failed;
        expect((await first.queue.getJob(runId))?.failedReason).toContain(
          mode === 'cached'
            ? 'synthetic archived receipt interruption'
            : 'synthetic send receipt interruption',
        );
        expect(generations).toBe(1);
        expect(archives).toBe(mode === 'cached' ? 1 : 0);
        expect(receiptWrites).toBe(mode === 'cached' ? 1 : 2);
        const originalIdentity = { runId, nodeId, attempt: 1 };
        expect(
          await prisma.runSendIntent.findUnique({
            where: { runId_nodeId_attempt: originalIdentity },
          }),
        ).toMatchObject({ status: mode === 'cached' ? 'sent' : 'sending' });
        if (mode === 'cached') {
          const failedRun = await prisma.run.findUniqueOrThrow({
            where: { id: executionDatabaseRunId(runId) },
          });
          expect(failedRun.nodeTimings).toMatchObject({ [nodeId]: { outcome: 'failed' } });
        }
        await first.worker.close();
        // 模拟发送记录丢失，但保留独立的授权、outbox、Run 与加密原响应。
        if (mode !== 'cached') await prisma.runSendIntent.deleteMany({ where: { runId } });
        if (mode === 'cancelled') await service.requestCancellation(runId);
        const retryData: RunJobData = {
          ...data,
          runId: retryId,
          retryOf: runId,
          attempt: 2,
          providerJob: createProviderJobRecord(retryId, 'newapi'),
        };
        if (mode === 'retry') await seed(retryData);
        second = createRunWorker(options);
        await second.worker.waitUntilReady();
        const completed = new Promise<void>((resolve, reject) => {
          second!.worker.once('completed', () => resolve());
          second!.worker.once('failed', (_job, error) => reject(error));
        });
        if (mode === 'retry')
          await second.queue.add('run', retryData, { jobId: retryId, attempts: 1 });
        else await (await second.queue.getJob(runId))!.retry();
        await completed;
        const activeId = mode === 'retry' ? retryId : runId;
        const recovered = await second.queue.getJob(activeId);
        expect(recovered?.returnvalue).toMatchObject({
          status: mode === 'cancelled' ? 'cancelled' : 'succeeded',
        });
        expect(generations).toBe(1);
        expect(sendClaims).toBe(1);
        expect(archives).toBe(mode === 'cancelled' ? 0 : 1);
        expect(
          await prisma.runSendIntent.findUnique({
            where: { runId_nodeId_attempt: originalIdentity },
          }),
        ).toMatchObject({ status: 'sent', requestIdentity: `provider_job_${runId}` });
        expect(await prisma.runSendIntent.count({ where: { runId: retryId } })).toBe(0);
        const run = await prisma.run.findUniqueOrThrow({
          where: { id: executionDatabaseRunId(activeId) },
        });
        expect(run.status).toBe(mode === 'cancelled' ? 'CANCELLED' : 'SUCCEEDED');
        if (mode !== 'cancelled') {
          expect(run.error).toBeNull();
          expect(run.result).toMatchObject({
            asset: { assetId: 'synthetic-recovered-image', version: 1 },
          });
          expect(run.nodeTimings).toMatchObject({ [nodeId]: { outcome: 'succeeded' } });
        }
        expect(recovered?.data.providerJob?.payload).toMatchObject({
          usageStatus: 'external',
          reportedUsage: { runId: executionDatabaseRunId(runId), amount: '1.25' },
        });
        await expect(
          service.assertRetrySafe({ runId, nodeId, snapshot, userId }),
        ).rejects.toMatchObject({ code: 'send_requires_review' });
      } finally {
        await first?.worker.close();
        await second?.worker.close();
        if (first) await first.queue.obliterate({ force: true });
        await first?.queue.close();
        await second?.queue.close();
        await prisma.runSendIntent.deleteMany({ where: { runId: { in: runIds } } });
        await prisma.runOutbox.deleteMany({ where: { runId: { in: runIds } } });
        await prisma.executionAuthorization.deleteMany({ where: { runId: { in: runIds } } });
        await prisma.project.deleteMany({ where: { id: projectId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.$disconnect();
      }
    },
    20000,
  );
});

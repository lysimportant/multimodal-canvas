/** 真实 BullMQ 并发验收：仅访问显式 16389 隔离 Redis 的随机队列，Provider 和持久化均为内存桩。 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoopObservability } from '@multimodal-canvas/observability';
import { reportRequestPrompt } from '@multimodal-canvas/providers';
import type { RunJobData, RunJobResult, RunSnapshot } from '@multimodal-canvas/domain';
import {
  createProviderJobRecord,
  createRunWorker,
  type ProviderExecution,
  type WorkerExecutionAuthorization,
  type WorkerProviderRequest,
} from './index';
import { withTestExecutionBindings } from './test-execution-fixtures';

/** 不读取业务 REDIS_URL；缺少显式测试地址时跳过真实队列测试。 */
const isolatedRedis = process.env.WORKER_CONCURRENCY_TEST_REDIS_URL;

/** 可手动释放或模拟请求结果未知的屏障；失败清理也必须释放等待者。 */
function createGate() {
  let release!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  return { promise, release, reject };
}

/** 两个 Run 复用节点 ID，但项目、凭据和产物身份各自独立，用于发现跨 Run 状态串扰。 */
function createSnapshot(): RunSnapshot {
  const nodes: RunSnapshot['nodes'] = ['draft', 'final'].map((id) => ({
    id,
    type: 'text',
    position: { x: id === 'draft' ? 0 : 200, y: 0 },
    data: { label: id, mediaType: 'text', mode: 'generate', modelAlias: 'synthetic-text' },
  }));
  return withTestExecutionBindings({
    projectId: randomUUID(),
    canvasRevision: 1,
    credentialId: randomUUID(),
    credentialVersion: 1,
    targetNodeId: 'final',
    modelAlias: 'synthetic-text',
    parameters: {},
    submittedAt: '2026-09-26T00:00:00.000Z',
    nodes,
    edges: [
      {
        id: 'draft-final',
        sourceNodeId: 'draft',
        sourceHandle: 'output:text',
        targetNodeId: 'final',
        targetHandle: 'input:content',
        order: 0,
      },
    ],
    inputs: [{ nodeId: 'draft', role: 'content', sortOrder: 0, snapshot: nodes[0]! }],
  });
}

/** 校验专用端口后创建唯一队列；不接触数据库、业务命名空间或任何网络 Provider。 */
function createFixture() {
  const url = new URL(isolatedRedis!);
  if (
    url.protocol !== 'redis:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '16389' ||
    url.username ||
    url.password ||
    !['', '/', '/0'].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('并发验收只允许独立本机 redis://127.0.0.1:16389/0，禁止业务 Redis');
  }
  const queueName = 'worker-concurrency-test-' + randomUUID();
  const runs = [0, 1].map(() => ({
    runId: randomUUID(),
    snapshot: createSnapshot(),
    gate: createGate(),
  }));
  const entered = new Set<string>();
  const sentRequests: Array<{ runId: string; nodeId: string }> = [];
  const signals = new Map<string, AbortSignal>();
  const settled = new Map<string, RunJobResult | Error>();
  const workerErrors: Error[] = [];
  const sendStatuses = new Map<string, string>();
  const beginSend = vi.fn<WorkerExecutionAuthorization['beginSend']>(async (input) => {
    const key = input.runId + '/' + input.nodeId + '/' + input.attempt;
    if (sendStatuses.has(key)) throw new Error('合成持久发送意图已存在，禁止重发');
    sendStatuses.set(key, 'sending');
  });
  const finishSend = vi.fn<WorkerExecutionAuthorization['finishSend']>(async (input) => {
    sendStatuses.set(input.runId + '/' + input.nodeId + '/' + input.attempt, input.status);
  });
  const recordUsage = vi.fn(async () => {});
  const execute = vi.fn(async (request: WorkerProviderRequest): Promise<ProviderExecution> => {
    const run = runs.find(({ runId }) => runId === request.runId);
    if (!run) throw new Error('收到本测试以外的 Run');
    expect(request.snapshot.projectId).toBe(run.snapshot.projectId);
    const nodeId = request.snapshot.targetNodeId;
    await reportRequestPrompt({
      ...request,
      provider: 'newapi',
      mediaType: 'text',
      requestIdentity: 'POST /chat/completions#1',
      format: 'plain',
      parts: [{ order: 0, text: 'Synthetic isolated generation' }],
      resources: [],
    });
    sentRequests.push({ runId: run.runId, nodeId });
    if (nodeId === 'draft') {
      expect(request.signal).toBeDefined();
      signals.set(run.runId, request.signal!);
      entered.add(run.runId);
      await run.gate.promise;
      if (request.signal?.aborted) throw new Error('合成 Provider 观察到取消');
    } else {
      expect(request.snapshot.inputs).toEqual([
        expect.objectContaining({
          nodeId: 'draft',
          sourceAssetId: 'asset_' + run.runId + '_draft',
        }),
      ]);
    }
    return {
      result: {
        provider: 'newapi',
        summary: run.runId + '/' + nodeId,
        targetNodeId: nodeId,
        mediaType: 'text',
        inputCount: request.snapshot.inputs.length,
      },
      output: {
        mediaType: 'text',
        kind: 'text',
        text: run.runId + '/' + nodeId,
        mimeType: 'text/plain',
        format: 'txt',
      },
      usage: { amount: '0.25', currency: 'USD' },
    };
  });
  const resultArchiver = vi.fn(
    async (
      input: Parameters<NonNullable<Parameters<typeof createRunWorker>[0]['resultArchiver']>>[0],
    ) => {
      const text = input.runId + '/' + input.snapshot.targetNodeId;
      expect(input.output).toMatchObject({ kind: 'text', text });
      return {
        assetId: 'asset_' + input.runId + '_' + input.snapshot.targetNodeId,
        version: 1,
        mimeType: 'text/plain',
        contentUrl: 'data:text/plain,' + encodeURIComponent(text),
      };
    },
  );
  const { worker, queue } = createRunWorker({
    connection: {
      host: '127.0.0.1',
      port: 16389,
      maxRetriesPerRequest: null,
      connectTimeout: 2_000,
    },
    queueName,
    providerName: 'newapi',
    stepDelayMs: 0,
    cancellationPollMs: 10,
    observability: createNoopObservability(),
    provider: { execute },
    resultArchiver,
    execution: {
      async authorizeRun() {},
      async authorizeNode() {},
      beginSend,
      finishSend,
    },
    persistence: {
      async getProviderCredentials(reference) {
        expect(runs.some(({ snapshot }) => snapshot.credentialId === reference.credentialId)).toBe(
          true,
        );
        return { baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-unusable-key' };
      },
      async upsertProviderJob() {},
      async upsertRequestPromptRecord() {},
      recordUsage,
    },
  });
  worker.on('error', (error) => workerErrors.push(error));
  worker.on('completed', (job, result) => settled.set(job.id!, result));
  worker.on('failed', (job, error) => {
    if (job) settled.set(job.id!, error);
  });
  return {
    worker,
    queue,
    runs,
    entered,
    sentRequests,
    signals,
    settled,
    workerErrors,
    execute,
    resultArchiver,
    beginSend,
    finishSend,
    recordUsage,
    sendStatuses,
    /** 一次入队两个独立 Run；每个 job 仅允许一次尝试，无收费请求或自动重试。 */
    async enqueue() {
      await worker.waitUntilReady();
      await queue.addBulk(
        runs.map(({ runId, snapshot }) => ({
          name: 'run',
          data: {
            runId,
            snapshot,
            attempt: 1,
            provider: 'newapi',
            providerJob: createProviderJobRecord(runId, 'newapi'),
            cancelRequested: false,
          } satisfies RunJobData,
          opts: { jobId: runId, attempts: 1 },
        })),
      );
    },
    /** 先释放屏障并关闭 Worker，再仅清除此夹具持有的 UUID 队列。 */
    async close() {
      for (const run of runs) run.gate.release();
      try {
        await worker.close();
        await queue.obliterate();
      } finally {
        await queue.close();
      }
    },
  };
}

describe.skipIf(!isolatedRedis)('隔离 Redis 的真实 Worker Run 并发', () => {
  beforeEach(() => {
    vi.stubEnv('WORKER_CONCURRENCY', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('并发测试禁止外部 HTTP 请求');
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('默认并发让两个 Run 都 entered 后才 release，且各自遵守 DAG 和产物隔离', async () => {
    const fixture = createFixture();
    try {
      await fixture.enqueue();
      // 旧的串行 Worker 会卡在第一个 gate；不能先 release 再推断出现过并发。
      await expect
        .poll(() => [...fixture.entered].sort(), { timeout: 4_000 })
        .toEqual(fixture.runs.map(({ runId }) => runId).sort());
      expect(fixture.worker.opts.concurrency).toBe(4);
      expect(await fixture.queue.getActiveCount()).toBe(2);
      expect(fixture.execute.mock.calls.map(([request]) => request.snapshot.targetNodeId)).toEqual([
        'draft',
        'draft',
      ]);
      expect(fixture.resultArchiver).not.toHaveBeenCalled();
      expect(fixture.settled.size).toBe(0);
      for (const run of fixture.runs) run.gate.release();
      await expect.poll(() => fixture.settled.size, { timeout: 5_000 }).toBe(2);
      for (const run of fixture.runs) {
        expect(fixture.settled.get(run.runId)).toMatchObject({
          status: 'succeeded',
          result: { asset: { assetId: 'asset_' + run.runId + '_final' } },
        });
        const job = await fixture.queue.getJob(run.runId);
        expect(job?.data.snapshot).toEqual(run.snapshot);
        expect(job?.data.workflowState?.nodes).toEqual([
          expect.objectContaining({
            nodeId: 'draft',
            status: 'succeeded',
            result: expect.objectContaining({
              asset: expect.objectContaining({ assetId: 'asset_' + run.runId + '_draft' }),
            }),
          }),
          expect.objectContaining({
            nodeId: 'final',
            status: 'succeeded',
            result: expect.objectContaining({
              asset: expect.objectContaining({ assetId: 'asset_' + run.runId + '_final' }),
            }),
          }),
        ]);
        expect(
          fixture.execute.mock.calls
            .filter(([request]) => request.runId === run.runId)
            .map(([request]) => request.snapshot.targetNodeId),
        ).toEqual(['draft', 'final']);
      }
      expect(fixture.beginSend).toHaveBeenCalledTimes(4);
      expect(fixture.finishSend).toHaveBeenCalledTimes(4);
      expect([...fixture.sendStatuses.values()]).toEqual(['sent', 'sent', 'sent', 'sent']);
      expect(fixture.resultArchiver).toHaveBeenCalledTimes(4);
      expect(fixture.recordUsage).not.toHaveBeenCalled();
      expect(fixture.workerErrors).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it('显式并发 1 在第一个 Run 的 gate 释放前保留第二个 Run 排队', async () => {
    vi.stubEnv('WORKER_CONCURRENCY', '1');
    const fixture = createFixture();
    try {
      await fixture.enqueue();
      await expect.poll(() => fixture.entered.size).toBe(1);
      expect(await fixture.queue.getJobCounts('active', 'waiting')).toMatchObject({
        active: 1,
        waiting: 1,
      });
      expect(fixture.worker.opts.concurrency).toBe(1);
      expect(fixture.execute).toHaveBeenCalledTimes(1);
      for (const run of fixture.runs) run.gate.release();
      await expect.poll(() => fixture.settled.size, { timeout: 5_000 }).toBe(2);
      for (const run of fixture.runs)
        expect(fixture.settled.get(run.runId)).toMatchObject({ status: 'succeeded' });
      expect(fixture.execute.mock.calls.map(([request]) => request.runId)).toEqual(
        fixture.runs.flatMap(({ runId }) => [runId, runId]),
      );
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it.each(['cancel', 'unknown'] as const)(
    '一个 Run %s 不污染另一个 Run，且不重发未知请求',
    async (outcome) => {
      const fixture = createFixture();
      try {
        await fixture.enqueue();
        await expect.poll(() => fixture.entered.size, { timeout: 4_000 }).toBe(2);
        const [affected, unaffected] = fixture.runs;
        const job = (await fixture.queue.getJob(affected!.runId))!;
        if (outcome === 'cancel') {
          await job.updateData({ ...job.data, cancelRequested: true });
          await expect.poll(() => fixture.signals.get(affected!.runId)?.aborted).toBe(true);
          expect(fixture.signals.get(unaffected!.runId)?.aborted).toBe(false);
          affected!.gate.release();
        } else {
          affected!.gate.reject(new TypeError('synthetic connection lost after send'));
        }
        await expect.poll(() => fixture.settled.has(affected!.runId)).toBe(true);
        expect(fixture.settled.has(unaffected!.runId)).toBe(false);
        expect(fixture.sendStatuses.get(affected!.runId + '/draft/1')).toBe('unknown');
        if (outcome === 'cancel') {
          expect(fixture.settled.get(affected!.runId)).toMatchObject({ status: 'cancelled' });
        } else {
          expect(fixture.settled.get(affected!.runId)).toBeInstanceOf(Error);
          fixture.settled.delete(affected!.runId);
          await job.retry();
          await expect.poll(() => fixture.settled.has(affected!.runId)).toBe(true);
          expect(fixture.settled.get(affected!.runId)).toBeInstanceOf(Error);
        }
        unaffected!.gate.release();
        await expect.poll(() => fixture.settled.size, { timeout: 5_000 }).toBe(2);
        expect(fixture.settled.get(unaffected!.runId)).toMatchObject({
          status: 'succeeded',
          result: { asset: { assetId: 'asset_' + unaffected!.runId + '_final' } },
        });
        expect(fixture.sentRequests.filter(({ runId }) => runId === affected!.runId)).toHaveLength(
          1,
        );
        expect(
          fixture.execute.mock.calls
            .filter(([request]) => request.runId === unaffected!.runId)
            .map(([request]) => request.snapshot.targetNodeId),
        ).toEqual(['draft', 'final']);
        expect(fixture.recordUsage).not.toHaveBeenCalled();
        expect(fixture.workerErrors).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
    15_000,
  );
});

/** 只访问显式 16389 隔离 Redis 的随机队列；绝不发送真实 Provider 请求。 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GENERATION_CONCURRENCY,
  type RunJobData,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { createNoopObservability } from '@multimodal-canvas/observability';
import { createProviderJobRecord, type WorkerProviderRequest } from './index';
import {
  createAuthorizedTestRunWorker,
  withTestExecutionBindings,
} from './test-execution-fixtures';
import { startWorkerConcurrencySync, type WorkerConcurrencySync } from './generation-concurrency';

/** 与已有并发回归共用隔离入口，不读取业务 REDIS_URL。 */
const isolatedRedis = process.env.WORKER_CONCURRENCY_TEST_REDIS_URL;
/** 手动释放当前合成请求，观察满载调度及缩容期间的真实占用。 */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
/** 创建独立项目和节点快照，不读写真实画布或数据库。 */
function snapshot(): RunSnapshot {
  return withTestExecutionBindings({
    projectId: randomUUID(),
    canvasRevision: 1,
    targetNodeId: 'generate',
    modelAlias: 'synthetic-text',
    parameters: {},
    submittedAt: '2026-09-26T00:00:00.000Z',
    nodes: [
      {
        id: 'generate',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: 'Synthetic generation',
          mode: 'generate',
          mediaType: 'text',
          modelAlias: 'synthetic-text',
        },
      },
    ],
    edges: [],
    inputs: [],
  });
}
const cleanups: Array<() => Promise<void>> = [];
/** 实际 Run Worker、实际 BullMQ Lua 限流和合成 Provider；删除范围仅为本次 UUID 队列。 */
async function fixture(initialConcurrency = DEFAULT_GENERATION_CONCURRENCY) {
  if (isolatedRedis !== 'redis://127.0.0.1:16389/0')
    throw new Error('只允许显式隔离 Redis 16389/0，禁止业务 Redis');
  const name = 'generation-concurrency-test-' + randomUUID();
  const connection = {
    host: '127.0.0.1',
    port: 16389,
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
  };
  const queue = new Queue<RunJobData>(name, { connection });
  const jobs = new Map<string, ReturnType<typeof gate>>();
  const runIdsByProject = new Map<string, string>();
  const entered = new Map<string, AbortSignal | undefined>();
  const completed = new Set<string>();
  const errors: Error[] = [];
  const syncErrors: unknown[] = [];
  const instances: Array<
    ReturnType<typeof createAuthorizedTestRunWorker> & { sync?: WorkerConcurrencySync }
  > = [];
  /** 所有任务都由测试释放，等待正常关闭后才清理本队列，不取消其他命名空间。 */
  const close = async () => {
    for (const item of jobs.values()) item.release();
    await Promise.all(
      instances.map(async ({ worker, queue: workerQueue, sync }) => {
        await sync?.close();
        await worker.close();
        await workerQueue.close();
      }),
    );
    await queue.obliterate();
    await queue.close();
  };
  cleanups.push(close);
  /** 多个进程式 Worker 共享同一全局并发，而不是相加各自的本地容量。 */
  const addWorker = async (initial = initialConcurrency) => {
    const created = createAuthorizedTestRunWorker({
      connection,
      queueName: name,
      autorun: false,
      providerName: 'mock',
      stepDelayMs: 0,
      observability: createNoopObservability(),
      resultArchiver: async ({ runId }) => ({
        assetId: 'synthetic-' + runId,
        version: 1,
        mimeType: 'text/plain',
        contentUrl: 'data:text/plain,Synthetic%20output',
      }),
      provider: {
        async execute(request: WorkerProviderRequest) {
          const runId = runIdsByProject.get(request.snapshot.projectId);
          const current = runId ? jobs.get(runId) : undefined;
          if (!current || !runId) throw new Error('收到本夹具以外的任务');
          entered.set(runId, request.signal);
          await current.promise;
          return {
            result: {
              provider: 'mock',
              summary: 'Synthetic completed',
              targetNodeId: 'generate',
              mediaType: 'text',
              inputCount: 0,
            },
            output: {
              mediaType: 'text',
              kind: 'text',
              text: 'Synthetic output',
              mimeType: 'text/plain',
              format: 'txt',
            },
          };
        },
      },
    });
    const instance = { ...created, sync: undefined as WorkerConcurrencySync | undefined };
    instances.push(instance);
    created.worker.on('error', (error) => errors.push(error));
    created.worker.on('failed', (_job, error) => errors.push(error));
    created.worker.on('completed', (job) => completed.add(job.id!));
    instance.sync = await startWorkerConcurrencySync({
      queue: created.queue,
      worker: created.worker,
      initialConcurrency: initial,
      onError: (error) => syncErrors.push(error),
    });
    void created.worker.run().catch((error: Error) => errors.push(error));
    return instance;
  };
  await addWorker();
  return {
    queue,
    entered,
    completed,
    errors,
    syncErrors,
    instances,
    jobs,
    addWorker,
    /** 每个 Run 只入队一次且 attempts=1，无法触发付费重试。 */
    async enqueue(count: number) {
      await queue.addBulk(
        Array.from({ length: count }, () => {
          const runId = randomUUID();
          jobs.set(runId, gate());
          const runSnapshot = snapshot();
          runIdsByProject.set(runSnapshot.projectId, runId);
          return {
            name: 'run',
            data: {
              runId,
              snapshot: runSnapshot,
              attempt: 1,
              provider: 'mock',
              providerJob: createProviderJobRecord(runId, 'mock'),
              cancelRequested: false,
            } satisfies RunJobData,
            opts: { jobId: runId, attempts: 1 },
          };
        }),
      );
    },
    /** 等待实际进入 Provider 的 Run 数，不靠按钮状态或耗时猜测并发。 */
    async waitEntered(count: number) {
      await vi.waitFor(
        () => {
          expect(errors).toEqual([]);
          expect(entered.size).toBe(count);
        },
        { timeout: 2500, interval: 20 },
      );
    },
  };
}

describe.skipIf(!isolatedRedis)('隔离 Redis 动态真实生成并发', () => {
  beforeEach(() => {
    vi.stubEnv('WORKER_CONCURRENCY', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('并发测试禁止外部 HTTP 请求');
      }),
    );
  });
  afterEach(async () => {
    try {
      await Promise.all(cleanups.splice(0).map((close) => close()));
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('默认 20 个真实 Run 同时进入 Provider，第 21 个等待空位', async () => {
    const f = await fixture();
    await f.enqueue(21);
    await f.waitEntered(20);
    expect(f.instances[0]!.worker.concurrency).toBe(20);
    expect(await f.queue.getGlobalConcurrency()).toBe(20);
    expect(await f.queue.getActiveCount()).toBe(20);
    expect(f.completed.size).toBe(0);
    f.jobs.get(f.entered.keys().next().value!)!.release();
    await f.waitEntered(21);
    expect(await f.queue.getActiveCount()).toBeLessThanOrEqual(20);
    expect(f.syncErrors).toEqual([]);
  });

  it('从 1 增至 32，满载时在下一任务完成后扩容，不重启 Worker', async () => {
    const f = await fixture(1);
    await f.enqueue(34);
    await f.waitEntered(1);
    await f.queue.setGlobalConcurrency(32);
    await vi.waitFor(() => expect(f.instances[0]!.worker.concurrency).toBe(32), { timeout: 2500 });
    expect(f.entered.size).toBe(1);
    expect(f.completed.size).toBe(0);
    f.jobs.get(f.entered.keys().next().value!)!.release();
    await f.waitEntered(33);
    expect(f.completed.size).toBe(1);
    expect(await f.queue.getActiveCount()).toBe(32);
    expect(await f.queue.getWaitingCount()).toBe(1);
    expect(f.syncErrors).toEqual([]);
  });

  it('扩容后同步间隔内的新提交仍受旧本地上限约束，下一次调度按新值执行', async () => {
    const f = await fixture(1);
    await f.enqueue(1);
    await f.waitEntered(1);
    await f.queue.setGlobalConcurrency(4);
    await f.enqueue(4);
    await vi.waitFor(() => expect(f.instances[0]!.worker.concurrency).toBe(4), { timeout: 2500 });
    expect(f.entered.size).toBe(1);
    f.jobs.get(f.entered.keys().next().value!)!.release();
    await f.waitEntered(5);
    expect(f.completed.size).toBe(1);
    expect(await f.queue.getActiveCount()).toBe(4);
  });

  it('从 3 减至 1，不取消已有请求，降至空位后才领取等待任务', async () => {
    const f = await fixture(3);
    await f.enqueue(5);
    await f.waitEntered(3);
    const active = [...f.entered.keys()];
    await f.queue.setGlobalConcurrency(1);
    await vi.waitFor(() => expect(f.instances[0]!.worker.concurrency).toBe(1), { timeout: 2500 });
    expect(await f.queue.getActiveCount()).toBe(3);
    expect([...f.entered.values()].every((signal) => signal && !signal.aborted)).toBe(true);
    f.jobs.get(active[0]!)!.release();
    f.jobs.get(active[1]!)!.release();
    await vi.waitFor(() => expect(f.completed.size).toBe(2));
    expect(f.entered.size).toBe(3);
    expect(await f.queue.getActiveCount()).toBe(1);
    f.jobs.get(active[2]!)!.release();
    await f.waitEntered(4);
    expect(await f.queue.getActiveCount()).toBe(1);
    expect(f.syncErrors).toEqual([]);
  });

  it('满载时先调低再调高保留在途请求，下一次调度按新上限执行', async () => {
    const f = await fixture(3);
    await f.enqueue(6);
    await f.waitEntered(3);
    await f.queue.setGlobalConcurrency(1);
    await vi.waitFor(() => expect(f.instances[0]!.worker.concurrency).toBe(1), { timeout: 2500 });
    expect(f.entered.size).toBe(3);
    await f.queue.setGlobalConcurrency(4);
    await vi.waitFor(() => expect(f.instances[0]!.worker.concurrency).toBe(4), { timeout: 2500 });
    expect(f.entered.size).toBe(3);
    expect(f.completed.size).toBe(0);
    f.jobs.get(f.entered.keys().next().value!)!.release();
    await f.waitEntered(5);
    expect(f.completed.size).toBe(1);
    expect(await f.queue.getActiveCount()).toBe(4);
  });

  it('两个 Worker 的真实活动任务总数遵守同一全局上限', async () => {
    const f = await fixture(3);
    await f.addWorker(20);
    await f.enqueue(7);
    await f.waitEntered(3);
    expect(await f.queue.getGlobalConcurrency()).toBe(3);
    expect(await f.queue.getActiveCount()).toBe(3);
    await f.queue.setGlobalConcurrency(5);
    await f.waitEntered(5);
    expect(await f.queue.getActiveCount()).toBe(5);
    expect(f.completed.size).toBe(0);
    expect(f.syncErrors).toEqual([]);
  });

  it('运行中删除全局配置也不会无界领取，检测后暂停并等待管理员恢复', async () => {
    const f = await fixture(2);
    await f.enqueue(6);
    await f.waitEntered(2);
    const worker = f.instances[0]!.worker;
    const active = [...f.entered.keys()];
    await f.queue.removeGlobalConcurrency();
    await f.enqueue(1);
    await vi.waitFor(() => expect(worker.isPaused()).toBe(true), { timeout: 2500 });
    expect(worker.concurrency).toBe(2);
    expect(f.entered.size).toBe(2);
    expect(await f.queue.getGlobalConcurrency()).toBeNull();
    expect(f.syncErrors).toHaveLength(1);
    expect([...f.entered.values()].every((signal) => signal && !signal.aborted)).toBe(true);
    for (const runId of active) f.jobs.get(runId)!.release();
    await vi.waitFor(() => expect(f.completed.size).toBe(2));
    expect(f.entered.size).toBe(2);
    expect(await f.queue.getActiveCount()).toBe(0);
    expect(await f.queue.getWaitingCount()).toBe(5);
    await f.queue.setGlobalConcurrency(1);
    await f.waitEntered(3);
    expect(worker.concurrency).toBe(1);
    expect(await f.queue.getActiveCount()).toBe(1);
    expect(f.errors).toEqual([]);
  });

  it('配置连接真实断开时暂停新领取且不取消在途请求，恢复后按最新值继续', async () => {
    const f = await fixture(2);
    await f.enqueue(7);
    await f.waitEntered(2);
    const instance = f.instances[0]!;
    const client = await instance.queue.client;
    const active = [...f.entered.keys()];
    // 只断开本次 UUID 夹具的配置客户端，不停止 Redis 或其它 Worker 的连接。
    client.disconnect();
    try {
      await vi.waitFor(() => expect(instance.worker.isPaused()).toBe(true), { timeout: 2500 });
      expect(instance.worker.concurrency).toBe(2);
      expect(f.entered.size).toBe(2);
      expect(f.syncErrors).toHaveLength(1);
      expect([...f.entered.values()].every((signal) => signal && !signal.aborted)).toBe(true);
      expect(f.completed.size).toBe(0);
      expect(await f.queue.getWaitingCount()).toBe(5);
      await f.queue.setGlobalConcurrency(3);
    } finally {
      await client.connect();
    }
    await vi.waitFor(
      () => {
        expect(instance.worker.isPaused()).toBe(false);
        expect(instance.worker.concurrency).toBe(3);
      },
      { timeout: 2500 },
    );
    expect(f.entered.size).toBe(2);
    expect([...f.entered.values()].every((signal) => signal && !signal.aborted)).toBe(true);
    for (const runId of active) f.jobs.get(runId)!.release();
    await vi.waitFor(() => expect(f.completed.size).toBe(2));
    await f.waitEntered(5);
    expect(instance.worker.concurrency).toBe(3);
    expect(await f.queue.getActiveCount()).toBe(3);
    expect(f.errors).toEqual([]);
  });

  it('Worker 和队列客户端重建后仍保留设置，不被遗留环境值 4 覆盖', async () => {
    const f = await fixture();
    await f.queue.setGlobalConcurrency(32);
    const first = f.instances[0]!;
    await first.sync?.close();
    await first.worker.close();
    const next = await f.addWorker(4);
    expect(next.worker.concurrency).toBe(32);
    expect(await next.queue.getGlobalConcurrency()).toBe(32);
    await f.enqueue(32);
    await f.waitEntered(32);
    expect(f.completed.size).toBe(0);
    expect(f.syncErrors).toEqual([]);
  });
});

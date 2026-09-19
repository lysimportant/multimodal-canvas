import { describe, expect, it, vi } from 'vitest';
import type { ProviderJob, RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import type { WorkerBilling } from './billing-execution';
import type { RunPersistence, WorkerProviderRequest } from './index';

/** 只替代 BullMQ 调度；Provider、账务与归档均使用隔离桩，不访问真实服务。 */
const queueState = vi.hoisted(() => ({
  jobs: new Map<
    string,
    {
      id: string;
      data: RunJobData;
      updateData(data: RunJobData): Promise<void>;
      updateProgress(value: unknown): Promise<void>;
    }
  >(),
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      queueState.processor = processor;
    }
  },
  Job: class {
    static fromId(_queue: unknown, id: string) {
      return queueState.jobs.get(id);
    }
  },
}));
import { createProviderJobRecord, createRunWorker } from './index';

/** 独立图片任务，冻结绑定由服务端产生。 */
const snapshot: RunSnapshot = {
  projectId: '123e4567-e89b-42d3-a456-426614174210',
  canvasRevision: 1,
  credentialId: '123e4567-e89b-42d3-a456-426614174211',
  credentialVersion: 1,
  targetNodeId: 'node_image',
  modelAlias: 'exact-image-id',
  parameters: {},
  submittedAt: '2026-09-19T00:00:00.000Z',
  edges: [],
  inputs: [],
  nodes: [
    {
      id: 'node_image',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { label: '图片', mediaType: 'image', mode: 'generate' },
    },
  ],
  billingBindings: {
    node_image: {
      platformModelId: '123e4567-e89b-42d3-a456-426614174212',
      bindingId: '123e4567-e89b-42d3-a456-426614174213',
      pricingVersionId: '123e4567-e89b-42d3-a456-426614174214',
      contract: 'openai-images',
    },
  },
};

/** 建立可重投的同一 Run，便于观察请求数和账务调用顺序。 */
function fixture(frozenSnapshot = snapshot) {
  queueState.jobs.clear();
  const runId = '123e4567-e89b-42d3-a456-426614174215';
  const job = {
    id: runId,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      runId,
      snapshot: frozenSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    } as RunJobData,
    async updateData(data: RunJobData) {
      this.data = data;
    },
    async updateProgress() {},
  };
  queueState.jobs.set(runId, job);
  const events: string[] = [];
  let sent = false;
  const billing = {
    authorizeRun: vi.fn(async () => {}),
    begin: vi.fn(
      async (_runId: string, _nodeId: string, fullSnapshot: RunSnapshot, taskId?: string) => {
        expect(fullSnapshot).toEqual(frozenSnapshot);
        if (sent && !taskId) throw new Error('原调用结果待核实，禁止再次发起生成');
        sent = true;
        events.push('begin');
      },
    ),
    recordRequest: vi.fn(async () => {}),
    deliver: vi.fn(async () => {
      events.push('settle');
    }),
    recordCost: vi.fn(async () => {
      events.push('cost');
    }),
    interrupt: vi.fn(async () => {}),
    deferDelivery: vi.fn(async () => {}),
  } satisfies WorkerBilling;
  const persisted = new Map<string, ProviderJob>();
  const persistence: RunPersistence = {
    async getProviderCredentials() {
      return { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-test-key' };
    },
    async upsertProviderJob({ providerJob }) {
      persisted.set(providerJob.id, structuredClone(providerJob));
      if (providerJob.payload?.deliveryState === 'archived') events.push('durable');
    },
    async recordUsage() {
      events.push('usage');
    },
  };
  const execute = vi.fn(async (request: WorkerProviderRequest) => {
    events.push('execute');
    return {
      result: {
        provider: 'newapi',
        summary: 'generated',
        targetNodeId: request.snapshot.targetNodeId,
        mediaType: request.snapshot.nodes.at(-1)!.data.mediaType,
        inputCount: 0,
      },
      output: {
        kind: 'url' as const,
        mediaType: request.snapshot.nodes.at(-1)!.data.mediaType as 'image' | 'video',
        url: 'https://provider.example/result.png',
        mimeType:
          request.snapshot.nodes.at(-1)!.data.mediaType === 'video' ? 'video/mp4' : 'image/png',
      },
      usage: { amount: '0.01', currency: 'USD' },
    };
  });
  const options: Parameters<typeof createRunWorker>[0] = {
    connection: { host: '127.0.0.1', port: 6379 },
    providerName: 'newapi',
    stepDelayMs: 0,
    billing,
    requireBilling: true,
    persistence,
    provider: { execute },
    videoProvider: { execute },
    resultArchiver: async () => ({
      assetId: 'asset_worker_bill',
      version: 1,
      mimeType: 'image/png',
    }),
  };
  return { runId, job, billing, persistence, execute, events, options, persisted };
}

describe('Worker billed lifecycle', () => {
  it('preserves precise provider cost without rounding it into the legacy usage ledger', async () => {
    const f = fixture();
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request) => ({
      ...(await original(request)),
      usage: { amount: '1.23e-10', currency: 'USD' },
    }));
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.job.data.providerJob?.payload).toMatchObject({
      reportedUsage: { amount: '0.000000000123', currency: 'USD' },
      usageStatus: 'legacy_unrepresentable',
      usageReason: expect.stringContaining('Decimal(18,6)'),
    });
    expect(f.events).not.toContain('usage');
    expect(f.billing.deliver).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'archive'] as const)(
    'retains the returned cost independently when %s prevents delivery',
    async (failure) => {
      const f = fixture();
      const original = f.execute.getMockImplementation()!;
      if (failure === 'cancel')
        f.execute.mockImplementation(async (request) => {
          const execution = await original(request);
          f.job.data.cancelRequested = true;
          return execution;
        });
      else
        f.options.resultArchiver = vi.fn(async () => {
          throw new Error('archive unavailable');
        });
      createRunWorker(f.options);
      const result = queueState.processor?.(f.job);
      if (failure === 'cancel')
        await expect(result).resolves.toMatchObject({ status: 'cancelled' });
      else await expect(result).rejects.toThrow('archive unavailable');
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.billing.deliver).not.toHaveBeenCalled();
      expect(f.billing.recordCost).toHaveBeenCalledWith(
        f.runId,
        'node_image',
        snapshot,
        expect.objectContaining({
          payload: expect.objectContaining({
            deliveryState: 'received',
            reportedUsage: expect.objectContaining({ amount: '0.01', currency: 'USD' }),
          }),
        }),
      );
      expect(f.events).toContain('usage');
    },
  );

  it('repairs returned cost after cancellation without a second provider request', async () => {
    const f = fixture();
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request) => {
      const execution = await original(request);
      f.job.data.cancelRequested = true;
      return execution;
    });
    f.billing.recordCost.mockRejectedValueOnce(new Error('cost database unavailable'));
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow('cost database unavailable');
    expect(f.job.data.providerJob?.payload).toMatchObject({
      deliveryState: 'received',
      reportedUsage: { amount: '0.01', currency: 'USD' },
    });
    f.job.attemptsMade = 1;
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.billing.deliver).not.toHaveBeenCalled();
    expect(f.billing.recordCost).toHaveBeenCalledTimes(2);
    expect(f.events.filter((event) => event === 'usage')).toHaveLength(1);
  });

  it('repairs archived accounting before completing a concurrent cancellation', async () => {
    const f = fixture();
    f.billing.deliver.mockImplementationOnce(async () => {
      f.job.data.cancelRequested = true;
      throw new Error('settlement unavailable during cancellation');
    });
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow(
      'settlement unavailable during cancellation',
    );
    expect(f.billing.interrupt).not.toHaveBeenCalled();
    f.job.attemptsMade = 1;
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.billing.begin).toHaveBeenCalledOnce();
    expect(f.billing.deliver).toHaveBeenCalledTimes(2);
    expect(f.billing.interrupt).toHaveBeenCalledOnce();
  });

  it('retries archived accounting only and defers exhausted recovery without releasing', async () => {
    const f = fixture();
    f.billing.deliver.mockRejectedValue(new Error('settlement unavailable'));
    createRunWorker(f.options);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      f.job.attemptsMade = attempt;
      await expect(queueState.processor?.(f.job)).rejects.toThrow('settlement unavailable');
    }
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.billing.begin).toHaveBeenCalledOnce();
    expect(f.billing.deliver).toHaveBeenCalledTimes(3);
    expect(f.billing.interrupt).not.toHaveBeenCalled();
    expect(f.billing.deferDelivery).toHaveBeenCalledTimes(1);
    expect(f.billing.deferDelivery).toHaveBeenCalledWith(
      f.runId,
      'node_image',
      snapshot,
      expect.objectContaining({
        payload: expect.objectContaining({
          deliveryState: 'archived',
          result: expect.objectContaining({
            asset: { assetId: 'asset_worker_bill', version: 1, mimeType: 'image/png' },
          }),
        }),
      }),
    );
  });

  it('reads durable cancellation even when the delivered queue payload is stale', async () => {
    const f = fixture();
    f.persistence.isCancellationRequested = vi.fn(async () => true);
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.job.data.cancelRequested).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.billing.begin).not.toHaveBeenCalled();
    expect(f.billing.interrupt).toHaveBeenCalledWith(f.runId, snapshot, undefined);
  });

  it('checks database intent again after credential resolution and before the provider send', async () => {
    const f = fixture();
    let cancelled = false;
    f.persistence.isCancellationRequested = vi.fn(async () => cancelled);
    f.persistence.getProviderCredentials = async () => {
      cancelled = true;
      return { baseUrl: 'https://provider.example', apiKey: 'synthetic-key' };
    };
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.billing.begin).not.toHaveBeenCalled();
  });

  it.each(['text', 'image', 'audio', 'video'] as const)(
    'built-in Mock %s produces an archivable output before settling',
    async (mediaType) => {
      const mockSnapshot = structuredClone(snapshot);
      mockSnapshot.nodes[0]!.type = mediaType;
      mockSnapshot.nodes[0]!.data.mediaType = mediaType;
      const f = fixture(mockSnapshot);
      f.job.data.provider = 'mock';
      f.job.data.providerJob = createProviderJobRecord(f.runId, 'mock');
      const archiver = vi.fn(async () => ({ assetId: 'mock-asset', version: 1 }));
      createRunWorker({
        ...f.options,
        providerName: 'mock',
        provider: undefined,
        videoProvider: undefined,
        resultArchiver: archiver,
      });
      await expect(queueState.processor?.(f.job)).resolves.toMatchObject({
        status: 'succeeded',
        result: { simulated: true },
      });
      expect(archiver).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ mediaType }),
          archiveInput: expect.objectContaining({ content: expect.any(Buffer) }),
        }),
      );
      expect(f.billing.deliver).toHaveBeenCalledTimes(1);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('authorizes before execution, persists delivery before settlement, and never replays on cost repair', async () => {
    const f = fixture();
    f.billing.deliver.mockImplementationOnce(async () => {
      f.events.push('settle');
      throw new Error('provider cost write unavailable');
    });
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow('provider cost write unavailable');
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.events.indexOf('begin')).toBeLessThan(f.events.indexOf('execute'));
    expect(f.events.indexOf('durable')).toBeLessThan(f.events.indexOf('settle'));
    expect(f.billing.interrupt).not.toHaveBeenCalled();
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.billing.begin).toHaveBeenCalledOnce();
    expect(f.billing.deliver).toHaveBeenCalledTimes(2);
    expect(f.events).toContain('usage');
  });

  it('blocks generation without a frozen wallet authorization', async () => {
    const f = fixture();
    f.billing.authorizeRun.mockRejectedValue(new Error('没有冻结授权'));
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow('没有冻结授权');
    expect(f.execute).not.toHaveBeenCalled();
    createRunWorker({ ...f.options, billing: undefined });
    await expect(queueState.processor?.(f.job)).rejects.toThrow('必须配置持久钱包授权');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('retains an unknown synchronous request instead of sending it after redelivery', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error('network response lost'));
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow('network response lost');
    await expect(queueState.processor?.(f.job)).rejects.toThrow('禁止再次发起生成');
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.billing.interrupt).toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'classifies local cancellation %s sending through the wallet state',
    async (timing) => {
      const f = fixture();
      if (timing === 'before') f.job.data.cancelRequested = true;
      else {
        const original = f.execute.getMockImplementation()!;
        f.execute.mockImplementation(async (request) => {
          const output = await original(request);
          f.job.data.cancelRequested = true;
          return output;
        });
      }
      createRunWorker(f.options);
      await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });
      expect(f.billing.interrupt).toHaveBeenCalledWith(
        f.runId,
        snapshot,
        timing === 'before' ? undefined : 'node_image',
      );
      expect(f.billing.begin).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
      expect(f.billing.deliver).not.toHaveBeenCalled();
    },
  );

  it('keeps the frozen video contract and resumes only the persisted upstream task', async () => {
    const video = structuredClone(snapshot);
    video.nodes[0]!.type = 'video';
    video.nodes[0]!.data.mediaType = 'video';
    video.billingBindings!.node_image!.contract = 'newapi-unified-v1';
    const f = fixture(video);
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(async (request) => {
      expect(request.providerJob?.payload?.contract).toBe('newapi-unified-v1');
      await request.onProviderJob?.({
        provider: 'newapi',
        platformJobId: 'original-upstream-task',
        status: 'submitted',
        payload: { contract: 'legacy-v1' },
      });
      throw new Error('poll interrupted');
    });
    createRunWorker(f.options);
    await expect(queueState.processor?.(f.job)).rejects.toThrow('poll interrupted');
    f.execute.mockImplementation(async (request) => {
      expect(request.providerJob).toMatchObject({
        platformJobId: 'original-upstream-task',
        payload: { contract: 'newapi-unified-v1' },
      });
      return original(request);
    });
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.billing.recordRequest).toHaveBeenCalledWith(
      f.runId,
      'node_image',
      video,
      'original-upstream-task',
    );
    expect(f.billing.begin).toHaveBeenLastCalledWith(
      f.runId,
      'node_image',
      video,
      'original-upstream-task',
    );
  });
});

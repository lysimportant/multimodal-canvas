import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';

import type { ProviderJob, RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProviderError, reportRequestPrompt } from '@multimodal-canvas/providers';
import type { SendIntentStatus } from '@multimodal-canvas/execution';

import {
  createProviderJobRecord,
  createRunWorker,
  type RunPersistence,
  type WorkerExecutionAuthorization,
  type WorkerProviderRequest,
} from './index';

const queueState = vi.hoisted(() => ({
  jobs: new Map<string, TestJob>(),
  processor: undefined as ((job: TestJob) => Promise<unknown>) | undefined,
}));

vi.mock('bullmq', async (importOriginal) => ({
  UnrecoverableError: (await importOriginal<typeof import('bullmq')>()).UnrecoverableError,
  Queue: class {},
  Worker: class {
    constructor(_name: string, processor: (job: TestJob) => Promise<unknown>) {
      queueState.processor = processor;
    }
  },
  Job: class {
    static fromId(_queue: unknown, id: string) {
      return queueState.jobs.get(id);
    }
  },
}));

type TestJob = {
  id: string;
  attemptsMade: number;
  opts: { attempts: number };
  data: RunJobData;
  updateData(data: RunJobData): Promise<void>;
  updateProgress(value: unknown): Promise<void>;
};

const authority = {
  issuer: 'https://newapi.example',
  externalUserId: 'upstream-user',
  instanceId: 'canvas-instance',
  grantId: 'grant-1',
  tokenId: 'token-1',
  credentialRevision: 'credential-1',
  group: 'default',
  permissionRevision: 'permission-1',
  autoGroups: [] as string[],
};

/** 创建单节点冻结快照；是否包含新执行授权由测试显式决定。 */
function snapshot(mediaType: 'image' | 'video', authorized: boolean): RunSnapshot {
  const credentialId = '123e4567-e89b-42d3-a456-426614174211';
  const value: RunSnapshot = {
    projectId: '123e4567-e89b-42d3-a456-426614174210',
    canvasRevision: 1,
    credentialId,
    credentialVersion: 1,
    targetNodeId: 'target',
    modelAlias: mediaType === 'video' ? 'video-model' : 'image-model',
    parameters: {},
    submittedAt: '2026-09-21T00:00:00.000Z',
    edges: [],
    inputs: [],
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: '目标',
          mediaType,
          mode: 'generate',
          modelAlias: mediaType === 'video' ? 'video-model' : 'image-model',
        },
      },
    ],
  };
  if (authorized) {
    value.executionBindings = {
      target: {
        credentialId,
        credentialVersion: 1,
        modelAlias: value.modelAlias,
        mediaType,
        contract: mediaType === 'video' ? 'newapi-unified-v1' : 'openai-images',
        authority,
      },
    };
  }
  return value;
}

/** 建立隔离 Worker 任务；Provider 桩将恢复轮询与新建请求分开计数。 */
function fixture(frozen: RunSnapshot, providerJob?: ProviderJob) {
  queueState.jobs.clear();
  const runId = '123e4567-e89b-42d3-a456-426614174215';
  const job: TestJob = {
    id: runId,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      runId,
      userId: '123e4567-e89b-42d3-a456-426614174216',
      snapshot: frozen,
      attempt: 1,
      provider: 'newapi',
      providerJob: providerJob ?? createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    },
    async updateData(data) {
      this.data = data;
    },
    async updateProgress() {},
  };
  queueState.jobs.set(runId, job);

  const persisted = new Map<string, ProviderJob>();
  const persistence: RunPersistence = {
    async getProviderCredentials() {
      return { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-test-key' };
    },
    async upsertProviderJob({ providerJob: current }) {
      persisted.set(current.id, structuredClone(current));
    },
    async upsertRequestPromptRecord() {},
  };
  let creationCalls = 0;
  let resumeCalls = 0;
  const execute = vi.fn(async (request: WorkerProviderRequest) => {
    const mediaType = request.snapshot.nodes.at(-1)!.data.mediaType as 'image' | 'video';
    const resumedId = request.providerJob?.platformJobId;
    if (resumedId) resumeCalls += 1;
    else {
      await reportRequestPrompt({
        ...request,
        provider: 'newapi',
        mediaType,
        requestIdentity: 'POST /generate#1',
        format: 'plain',
        parts: [{ order: 0, text: 'Synthetic generation' }],
        resources: [],
      });
      creationCalls += 1;
    }
    return {
      result: {
        provider: 'newapi',
        summary: 'generated',
        targetNodeId: request.snapshot.targetNodeId,
        mediaType,
        inputCount: 0,
      },
      output: {
        kind: 'url' as const,
        mediaType,
        url: `https://provider.example/result.${mediaType === 'video' ? 'mp4' : 'png'}`,
        mimeType: mediaType === 'video' ? 'video/mp4' : 'image/png',
      },
      providerJob: {
        provider: 'newapi',
        ...(resumedId ? { platformJobId: resumedId } : {}),
        status: 'succeeded' as const,
        progress: 100,
        payload: request.providerJob?.payload,
      },
      usage: { metadata: { amount: '0.01', currency: 'USD' } },
    };
  });
  const options: Parameters<typeof createRunWorker>[0] = {
    connection: { host: '127.0.0.1', port: 6379 },
    providerName: 'newapi',
    stepDelayMs: 0,
    persistence,
    provider: { execute },
    videoProvider: { execute },
    resultArchiver: async ({ result }) => ({
      assetId: '123e4567-e89b-42d3-a456-426614174217',
      version: 1,
      mimeType: result.mediaType === 'video' ? 'video/mp4' : 'image/png',
    }),
  };
  return {
    job,
    execute,
    options,
    persisted,
    creationCalls: () => creationCalls,
    resumeCalls: () => resumeCalls,
  };
}

/** 模拟持久发送终态：只有 pending 可领取，同一发送的终态不能被重投覆盖。 */
function singleSendAuthorization() {
  let status: SendIntentStatus = 'pending';
  const execution = {
    authorizeRun: vi.fn(async () => undefined),
    authorizeNode: vi.fn(async () => undefined),
    beginSend: vi.fn(async () => {
      if (status !== 'pending') throw new Error('原请求可能已经送达，禁止重复创建');
      status = 'sending';
    }),
    finishSend: vi.fn(async (input: Parameters<WorkerExecutionAuthorization['finishSend']>[0]) => {
      if (status === 'sending') status = input.status;
    }),
  } satisfies WorkerExecutionAuthorization;
  return { execution, status: () => status };
}

/** 按 attempts 和 BullMQ 不可重试错误模拟自动重投，不连接 Redis。 */
async function processWithQueueRetries(job: TestJob): Promise<unknown[]> {
  const failures: unknown[] = [];
  while (job.attemptsMade < job.opts.attempts) {
    try {
      await queueState.processor!(job);
      break;
    } catch (error) {
      failures.push(error);
      job.attemptsMade += 1;
      if (error instanceof UnrecoverableError) break;
    }
  }
  return failures;
}

/** Provider 桩先走真实提示词/发送授权回调，再以合成错误拒绝唯一创建请求。 */
function rejectCreation(f: ReturnType<typeof fixture>, failure: Error) {
  const post = vi.fn(async () => {
    throw failure;
  });
  f.execute.mockImplementation(async (request) => {
    await reportRequestPrompt({
      ...request,
      provider: 'newapi',
      mediaType: 'image',
      requestIdentity: 'POST /images/generations#1',
      format: 'plain',
      parts: [{ order: 0, text: 'Synthetic generation' }],
      resources: [],
    });
    return post();
  });
  return post;
}

describe('Worker 中性执行授权', () => {
  it.each([400, 422])('上游明确 HTTP %s 拒绝后停止队列重投，保留原始错误', async (status) => {
    const f = fixture(snapshot('image', true));
    const failure = new NewApiProviderError(
      'This model is not supported on the Chat Completions endpoint',
      { status, requestId: 'synthetic-rejected-request' },
    );
    const post = rejectCreation(f, failure);
    const authorization = singleSendAuthorization();
    const updateRun = vi.fn(async () => undefined);
    f.options.persistence!.updateRun = updateRun;
    createRunWorker({ ...f.options, execution: authorization.execution });

    const failures = await processWithQueueRetries(f.job);

    expect(updateRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: failure.message }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(UnrecoverableError);
    expect(failures[0]).toMatchObject({ message: failure.message, cause: failure });
    expect(authorization.status()).toBe('failed');
    expect(authorization.execution.beginSend).toHaveBeenCalledOnce();
    expect(authorization.execution.finishSend).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'target', status: 'failed', error: failure.message }),
    );
    expect(post).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each([undefined, 408, 425, 429, 500])(
    '创建送达未知（HTTP %s）时重投仍严格禁止第二次 POST',
    async (status) => {
      const f = fixture(snapshot('image', true));
      const failure = new NewApiProviderError('creation delivery unknown', { status });
      const post = rejectCreation(f, failure);
      const authorization = singleSendAuthorization();
      createRunWorker({ ...f.options, execution: authorization.execution });

      const failures = await processWithQueueRetries(f.job);
      await expect(queueState.processor?.(f.job)).rejects.toThrow('禁止重复创建');

      expect(failures[0]).toBe(failure);
      expect(authorization.status()).toBe('unknown');
      expect(authorization.execution.finishSend).toHaveBeenCalledOnce();
      expect(authorization.execution.finishSend).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'target', status: 'unknown' }),
      );
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it('显式新建的授权 retryOf 不继承前驱 Run 的不可重试标记', async () => {
    const original = fixture(snapshot('image', true));
    const failure = new NewApiProviderError('upstream rejected the request', { status: 400 });
    const originalPost = rejectCreation(original, failure);
    createRunWorker({ ...original.options, execution: singleSendAuthorization().execution });
    await expect(queueState.processor?.(original.job)).rejects.toBeInstanceOf(UnrecoverableError);

    const retry = fixture(snapshot('image', true));
    const retryRunId = '123e4567-e89b-42d3-a456-426614174221';
    retry.job.id = retryRunId;
    retry.job.data = {
      ...retry.job.data,
      runId: retryRunId,
      retryOf: original.job.data.runId,
      attempt: 2,
      providerJob: createProviderJobRecord(retryRunId, 'newapi'),
    };
    queueState.jobs.clear();
    queueState.jobs.set(retryRunId, retry.job);
    retry.options.persistence!.findProviderJobsByRunId = async (runId) =>
      runId === original.job.data.runId ? [...original.persisted.values()] : [];
    const authorization = singleSendAuthorization();
    const assertRetrySafe = vi.fn(async () => undefined);
    createRunWorker({
      ...retry.options,
      execution: { ...authorization.execution, assertRetrySafe },
    });

    await expect(queueState.processor?.(retry.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(assertRetrySafe).toHaveBeenCalledWith(
      expect.objectContaining({ runId: original.job.data.runId, nodeId: 'target' }),
    );
    expect(originalPost).toHaveBeenCalledOnce();
    expect(retry.creationCalls()).toBe(1);
    expect(authorization.execution.beginSend).toHaveBeenCalledOnce();
    expect(authorization.status()).toBe('sent');
  });

  it('带平台 ID 的轮询 HTTP 400 仍可恢复，不重新创建异步任务', async () => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'submitted', 35),
      platformJobId: 'accepted-platform-task',
      payload: { contract: 'newapi-unified-v1', phase: 'polling' },
    };
    const f = fixture(snapshot('video', true), providerJob);
    const failure = new NewApiProviderError('polling response unavailable', { status: 400 });
    f.execute.mockRejectedValueOnce(failure);
    const beginSend = vi.fn(
      async (input: Parameters<WorkerExecutionAuthorization['beginSend']>[0]) => {
        expect(input.resumePlatformJobId).toBe('accepted-platform-task');
      },
    );
    createRunWorker({
      ...f.options,
      execution: {
        async authorizeRun() {},
        async authorizeNode() {},
        beginSend,
        async finishSend() {},
      },
    });

    const failures = await processWithQueueRetries(f.job);

    expect(failures).toEqual([failure]);
    expect(f.job.data.providerJob).toMatchObject({
      status: 'succeeded',
      platformJobId: 'accepted-platform-task',
    });
    expect(beginSend).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(1);
  });

  it('发送前本地校验失败不创建发送记录，重复消费仍保留原错误', async () => {
    const f = fixture(snapshot('video', true));
    f.execute.mockRejectedValue(new Error('首尾帧模式需要同时连接首帧和尾帧'));
    const execution: WorkerExecutionAuthorization = {
      authorizeRun: vi.fn(async () => undefined),
      authorizeNode: vi.fn(async () => undefined),
      beginSend: vi.fn(async () => undefined),
      finishSend: vi.fn(async () => undefined),
    };
    createRunWorker({ ...f.options, execution });
    await expect(queueState.processor?.(f.job)).rejects.toThrow('首尾帧模式需要同时连接首帧和尾帧');
    await expect(queueState.processor?.(f.job)).rejects.toThrow('首尾帧模式需要同时连接首帧和尾帧');
    expect(execution.beginSend).not.toHaveBeenCalled();
    expect(execution.finishSend).not.toHaveBeenCalled();
    expect(f.creationCalls()).toBe(0);
  });

  it('最终请求落库后发送授权失效仍阻止 Provider POST', async () => {
    const f = fixture(snapshot('image', true));
    const execution: WorkerExecutionAuthorization = {
      authorizeRun: vi.fn(async () => undefined),
      authorizeNode: vi.fn(async () => undefined),
      beginSend: vi.fn(async () => {
        throw new Error('授权已撤销');
      }),
      finishSend: vi.fn(async () => undefined),
    };
    createRunWorker({ ...f.options, execution });
    await expect(queueState.processor?.(f.job)).rejects.toThrow('授权已撤销');
    expect(execution.beginSend).toHaveBeenCalledOnce();
    expect(execution.finishSend).not.toHaveBeenCalled();
    expect(f.creationCalls()).toBe(0);
  });

  it('新任务只走执行授权，并从 executionBindings 冻结 Provider 协议', async () => {
    const frozen = snapshot('image', true);
    const f = fixture(frozen);
    const execution: WorkerExecutionAuthorization = {
      authorizeRun: vi.fn(async () => undefined),
      authorizeNode: vi.fn(async () => undefined),
      beginSend: vi.fn(async () => undefined),
      finishSend: vi.fn(async () => undefined),
    };
    createRunWorker({ ...f.options, execution });

    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(execution.authorizeRun).toHaveBeenCalledOnce();
    expect(execution.authorizeNode).toHaveBeenCalledOnce();
    expect(execution.beginSend).toHaveBeenCalledOnce();
    expect(execution.finishSend).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'target', status: 'sent' }),
    );
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerJob: expect.objectContaining({
          payload: expect.objectContaining({ contract: 'openai-images' }),
        }),
      }),
    );
    expect(f.creationCalls()).toBe(1);
  });

  it('无执行授权的历史未发送节点零创建调用', async () => {
    const f = fixture(snapshot('image', false));
    createRunWorker(f.options);

    await expect(queueState.processor?.(f.job)).rejects.toThrow(/禁止创建 Provider 请求/);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(0);
  });

  it('已受理视频在登录权限修订后沿用原任务归档，仍校验持久发送身份', async () => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'submitted', 35),
      platformJobId: 'accepted-platform-task',
      payload: { contract: 'newapi-unified-v1', phase: 'submitted' },
    };
    const f = fixture(snapshot('video', true), providerJob);
    const execution: WorkerExecutionAuthorization = {
      authorizeRun: vi.fn(async () => undefined),
      authorizeNode: vi.fn(async () => {
        throw new Error('权限修订已变化');
      }),
      beginSend: vi.fn(async () => undefined),
      finishSend: vi.fn(async () => undefined),
    };
    createRunWorker({ ...f.options, execution });

    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(execution.authorizeRun).toHaveBeenCalledOnce();
    expect(execution.authorizeNode).not.toHaveBeenCalled();
    expect(execution.beginSend).toHaveBeenCalledWith(
      expect.objectContaining({ resumePlatformJobId: 'accepted-platform-task' }),
    );
    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(1);
    expect(f.job.data.providerJob?.payload).toMatchObject({ deliveryState: 'archived' });
  });

  it('历史视频只恢复已冻结的平台任务，归档重放不会再次调用 Provider', async () => {
    const frozen = snapshot('video', false);
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'submitted', 35),
      platformJobId: 'existing-platform-task',
      payload: { contract: 'newapi-unified-v1', phase: 'submitted' },
    };
    const f = fixture(frozen, providerJob);
    createRunWorker(f.options);

    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(1);
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerJob: expect.objectContaining({
          platformJobId: 'existing-platform-task',
          payload: expect.objectContaining({ contract: 'newapi-unified-v1' }),
        }),
      }),
    );
    expect(
      [...f.persisted.values()].some(
        (entry) => entry.status === 'succeeded' && entry.payload?.deliveryState === 'archived',
      ),
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { ProviderJob, RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import { reportRequestPrompt } from '@multimodal-canvas/providers';

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

vi.mock('bullmq', () => ({
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
  const recordUsage = vi.fn(async () => undefined);
  const persistence: RunPersistence = {
    async getProviderCredentials() {
      return { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-test-key' };
    },
    async upsertProviderJob({ providerJob: current }) {
      persisted.set(current.id, structuredClone(current));
    },
    async upsertRequestPromptRecord() {},
    recordUsage,
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
      usage: { amount: '0.01', currency: 'USD' },
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
    recordUsage,
    creationCalls: () => creationCalls,
    resumeCalls: () => resumeCalls,
  };
}

describe('Worker 中性执行授权', () => {
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
    expect(f.recordUsage).not.toHaveBeenCalled();
    expect(f.job.data.providerJob?.payload).toMatchObject({ usageStatus: 'external' });
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

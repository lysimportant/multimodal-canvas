import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';

import {
  GLOBALSTORE_IMAGE_CONTRACT,
  GLOBALSTORE_VIDEO_CONTRACT,
  type ProviderJob,
  type RunJobData,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import {
  NewApiProvider,
  NewApiProviderError,
  NewApiVideoProvider,
  GlobalStoreImageProvider,
  reportRequestPrompt,
} from '@multimodal-canvas/providers';
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

afterEach(() => vi.unstubAllGlobals());

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
      return {
        baseUrl: 'https://provider.example/v1',
        apiKey: 'synthetic-test-key',
        ...(frozen.executionBindings?.target?.provider === 'globalstore'
          ? { provider: 'globalstore' }
          : {}),
      };
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

describe('GlobalStore 图片 Worker', () => {
  function globalstoreSnapshot() {
    const frozen = snapshot('image', true);
    frozen.modelAlias = 'seedream-5.0';
    frozen.executionBindings!.target = {
      credentialId: frozen.credentialId!,
      credentialVersion: frozen.credentialVersion!,
      provider: 'globalstore',
      modelAlias: frozen.modelAlias,
      mediaType: 'image',
      contract: GLOBALSTORE_IMAGE_CONTRACT,
    };
    return frozen;
  }

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO2kAAAAASUVORK5CYII=',
    'base64',
  );

  it.each([false, true])('图片提交/只读恢复后立即下载并归档，恢复=%s', async (resume) => {
    const frozen = globalstoreSnapshot();
    const task = resume
      ? {
          ...createProviderJobRecord(
            '123e4567-e89b-42d3-a456-426614174215',
            'globalstore',
            'submitted',
          ),
          platformJobId: 'gs-image-1',
          payload: { contract: GLOBALSTORE_IMAGE_CONTRACT, phase: 'polling' },
        }
      : undefined;
    const f = fixture(frozen, task);
    f.job.data.retrieveOnly = resume;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/tasks') && init?.method === 'POST') {
        // The accepted task identity must be durable before any query/download.
        expect(f.persisted.get(`provider_job_${f.job.id}`)?.payload?.phase).toBe('submitting');
        return Response.json({ id: 'gs-image-1', status: 'queued' });
      }
      if (url.endsWith('/tasks/gs-image-1')) {
        expect(f.persisted.get(`provider_job_${f.job.id}`)?.platformJobId).toBe('gs-image-1');
        return Response.json({
          id: 'gs-image-1',
          status: 'completed',
          result_url: 'https://images.example/image.png',
        });
      }
      if (url === 'https://images.example/image.png') {
        expect(init?.headers).toBeUndefined();
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      throw new Error('unexpected fixture request');
    });
    const authorization = singleSendAuthorization();
    const archive = vi.fn(f.options.resultArchiver!);
    f.options.provider = new GlobalStoreImageProvider({
      baseUrl: 'https://provider.example',
      apiKey: 'synthetic-test-key',
      pollIntervalMs: 1,
      fetchImpl,
    });
    createRunWorker({ ...f.options, resultArchiver: archive, execution: authorization.execution });

    await expect(queueState.processor!(f.job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(resume ? 0 : 1);
    expect(authorization.execution.authorizeNode).toHaveBeenCalledTimes(resume ? 0 : 1);
    expect(archive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        output: expect.objectContaining({
          kind: 'base64',
          mediaType: 'image',
          base64: png.toString('base64'),
        }),
      }),
    );
    expect(f.job.data.providerJob).toMatchObject({
      provider: 'globalstore',
      platformJobId: 'gs-image-1',
      status: 'succeeded',
      payload: { deliveryState: 'archived', contract: GLOBALSTORE_IMAGE_CONTRACT },
    });
    expect(JSON.stringify(f.job.data)).not.toContain('synthetic-test-key');
    expect(JSON.stringify(f.job.data)).not.toContain('https://images.example');
  });

  it('凭据供应商与冻结绑定不匹配时拒绝执行', async () => {
    const f = fixture(globalstoreSnapshot());
    f.options.persistence!.getProviderCredentials = async () => ({
      baseUrl: 'https://provider.example',
      apiKey: 'synthetic-test-key',
      provider: 'newapi',
    });
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });
    await expect(queueState.processor!(f.job)).rejects.toThrow('provider differs');
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe('GlobalStore 视频 Worker', () => {
  function globalstoreVideoSnapshot(): RunSnapshot {
    const frozen = snapshot('video', true);
    frozen.modelAlias = 'sd_2.0_special';
    frozen.parameters = {
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '720p',
      seed: 42,
      generate_audio: false,
    };
    frozen.nodes[0]!.data.prompt = 'A synthetic video prompt';
    frozen.executionBindings!.target = {
      credentialId: frozen.credentialId!,
      credentialVersion: frozen.credentialVersion!,
      provider: 'globalstore',
      modelAlias: frozen.modelAlias,
      mediaType: 'video',
      contract: GLOBALSTORE_VIDEO_CONTRACT,
    };
    return frozen;
  }

  function useBuiltInGlobalStoreVideoProvider(f: ReturnType<typeof fixture>) {
    delete f.options.provider;
    delete f.options.videoProvider;
    f.options.persistence!.getProviderCredentials = async () => ({
      baseUrl: 'https://provider.example',
      apiKey: 'synthetic-test-key',
      provider: 'globalstore',
    });
  }

  it('创建请求按文档发送 duration（没有 seconds）并归档结果 URL', async () => {
    const f = fixture(globalstoreVideoSnapshot());
    useBuiltInGlobalStoreVideoProvider(f);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        id: 'gs-video-1',
        object: 'video',
        status: 'completed',
        result_url: 'https://cdn.example/result.mp4',
      });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const archive = vi.fn(f.options.resultArchiver!);
    const authorization = singleSendAuthorization();
    createRunWorker({ ...f.options, resultArchiver: archive, execution: authorization.execution });

    await expect(queueState.processor!(f.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://provider.example/kyyReactApiServer/v2/model-center/tasks');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer synthetic-test-key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({
      model: 'sd_2.0_special',
      prompt: 'A synthetic video prompt',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '720p',
      seed: 42,
      generate_audio: false,
    });
    expect(body).not.toHaveProperty('seconds');
    expect(f.job.data.providerJob).toMatchObject({
      provider: 'globalstore',
      platformJobId: 'gs-video-1',
      status: 'succeeded',
      payload: { contract: GLOBALSTORE_VIDEO_CONTRACT, deliveryState: 'archived' },
    });
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          kind: 'url',
          mediaType: 'video',
          url: 'https://cdn.example/result.mp4',
        }),
      }),
    );
    expect(authorization.status()).toBe('sent');
    expect(JSON.stringify(f.job.data)).not.toContain('synthetic-test-key');
    expect(JSON.stringify(f.job.data)).not.toContain('cdn.example');
  });

  it('只读恢复通过任务 ID 查询，不会重新 POST 创建', async () => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord(
        '123e4567-e89b-42d3-a456-426614174215',
        'globalstore',
        'submitted',
        20,
      ),
      platformJobId: 'gs-video-existing',
      payload: { contract: GLOBALSTORE_VIDEO_CONTRACT, phase: 'polling' },
    };
    const f = fixture(globalstoreVideoSnapshot(), providerJob);
    f.job.data.retrieveOnly = true;
    useBuiltInGlobalStoreVideoProvider(f);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        calls.push(String(input));
        return Response.json({
          id: 'gs-video-existing',
          object: 'video',
          status: 'completed',
          video_url: 'https://cdn.example/existing.mp4',
        });
      }),
    );
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });

    await expect(queueState.processor!(f.job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(calls).toEqual([
      'https://provider.example/kyyReactApiServer/v2/model-center/tasks/gs-video-existing',
    ]);
    expect(f.job.data.providerJob).toMatchObject({
      provider: 'globalstore',
      platformJobId: 'gs-video-existing',
      payload: { contract: GLOBALSTORE_VIDEO_CONTRACT, deliveryState: 'archived' },
    });
  });
});

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

  it('Gemini 返回 HTTP 200 但无图片时保留原错误和响应诊断，停止无效重投', async () => {
    const frozen = snapshot('image', true);
    frozen.modelAlias = 'gemini-3.1-flash-image-preview';
    frozen.parameters = { prompt: 'Synthetic image generation' };
    frozen.executionBindings!.target = {
      ...frozen.executionBindings!.target!,
      modelAlias: frozen.modelAlias,
      contract: 'openai-chat-completions',
    };
    const f = fixture(frozen);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { choices: [{ finish_reason: 'stop', message: { content: 'No generated image.' } }] },
        {
          headers: {
            'x-request-id': 'original-request',
            'x-oneapi-request-id': 'gateway-request',
          },
        },
      ),
    );
    const provider = new NewApiProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'synthetic-test-key',
      fetchImpl,
    });
    f.options.provider = provider;
    const authorization = singleSendAuthorization();
    const updateRun = vi.fn(async () => undefined);
    const recordPrompt = vi.fn(async () => undefined);
    f.options.persistence!.updateRun = updateRun;
    f.options.persistence!.upsertRequestPromptRecord = recordPrompt;
    const archiver = vi.fn(f.options.resultArchiver!);
    createRunWorker({ ...f.options, resultArchiver: archiver, execution: authorization.execution });

    const failures = await processWithQueueRetries(f.job);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(UnrecoverableError);
    expect(failures[0]).toMatchObject({
      message: expect.stringContaining('缺少图片内容'),
      cause: { code: 'PROVIDER_IMAGE_OUTPUT_MISSING', retryable: false },
    });
    expect(updateRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('缺少图片内容') }),
    );
    expect(f.job.data.providerJob?.payload).toMatchObject({
      code: 'PROVIDER_IMAGE_OUTPUT_MISSING',
      retryable: false,
      requestId: 'original-request',
      newApiRequestId: 'gateway-request',
      statusResponse: {
        choiceCount: 1,
        contentType: 'string',
        textLength: 19,
        imageEntryCount: 0,
        finishReason: 'stop',
        hasRefusal: false,
      },
    });
    expect(authorization.status()).toBe('unknown');
    expect(authorization.execution.beginSend).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(archiver).not.toHaveBeenCalled();
    expect(JSON.stringify(f.job.data.providerJob)).not.toContain('No generated image.');
  });

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

  it.each(['cancelled', 'failed'] as const)(
    '历史%s视频只读恢复只轮询同一平台任务，不重新创建',
    async (terminalStatus) => {
      const providerJob: ProviderJob = {
        ...createProviderJobRecord(
          '123e4567-e89b-42d3-a456-426614174215',
          'newapi',
          terminalStatus,
          35,
        ),
        platformJobId: 'accepted-platform-task',
        payload: {
          contract: 'newapi-unified-v1',
          phase: 'failed',
          providerStatus: terminalStatus,
        },
      };
      const f = fixture(snapshot('video', true), providerJob);
      f.job.data.retrieveOnly = true;
      f.job.data.workflowState = {
        nodes: [{ nodeId: 'target', status: terminalStatus, providerJob }],
      };
      const archive = vi.fn(f.options.resultArchiver!);
      f.options.resultArchiver = archive;
      const isCancellationRequested = vi.fn(async (_runId: string, retrieveOnly?: boolean) => {
        return retrieveOnly !== true;
      });
      f.options.persistence!.isCancellationRequested = isCancellationRequested;
      const execution: WorkerExecutionAuthorization = {
        authorizeRun: vi.fn(async () => undefined),
        authorizeNode: vi.fn(async () => undefined),
        beginSend: vi.fn(async () => undefined),
        finishSend: vi.fn(async () => undefined),
      };
      createRunWorker({ ...f.options, execution });

      await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });

      expect(isCancellationRequested).not.toHaveBeenCalled();
      expect(execution.beginSend).toHaveBeenCalledWith(
        expect.objectContaining({ resumePlatformJobId: 'accepted-platform-task' }),
      );
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeOnly: true,
          providerJob: expect.objectContaining({ platformJobId: 'accepted-platform-task' }),
        }),
      );
      expect(f.creationCalls()).toBe(0);
      expect(f.resumeCalls()).toBe(1);
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ runId: f.job.id, userId: f.job.data.userId }),
      );
      await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'succeeded' });
      expect(f.resumeCalls()).toBe(1);
      expect(archive).toHaveBeenCalledOnce();
    },
  );

  it.each(['task_not_found', 'task_failed'] as const)(
    '视频 %s 标记失败并按原平台身份退款，终态失败不重复生成',
    async (reason) => {
      const providerJob: ProviderJob = {
        ...createProviderJobRecord(
          '123e4567-e89b-42d3-a456-426614174215',
          'newapi',
          'submitted',
          35,
        ),
        platformJobId: 'accepted-platform-task',
        payload: { contract: 'newapi-unified-v1', phase: 'submitted' },
      };
      const f = fixture(snapshot('video', true), providerJob);
      const refundFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            task_id: providerJob.platformJobId,
            status: 'failed',
            refund_status: 'refunded',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', refundFetch);
      f.execute.mockRejectedValue(
        new NewApiProviderError('合成视频失败', {
          code: reason === 'task_not_found' ? 'VIDEO_TASK_NOT_FOUND' : 'VIDEO_GENERATION_FAILED',
          platformJobId: providerJob.platformJobId,
          retryable: false,
        }),
      );
      createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });
      await expect(queueState.processor?.(f.job)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(refundFetch).toHaveBeenCalledOnce();
      expect(refundFetch).toHaveBeenCalledWith(
        'https://provider.example/v1/canvas/tasks/accepted-platform-task/cancel',
        expect.objectContaining({ body: JSON.stringify({ reason }) }),
      );
      expect(f.job.data.providerJob).toMatchObject({
        status: 'failed',
        platformJobId: providerJob.platformJobId,
        payload: { refundStatus: 'refunded', error: expect.stringContaining('费用已退还') },
      });
      expect(
        [...f.persisted.values()].some((job) => job.payload?.refundStatus === 'refunded'),
      ).toBe(true);
      expect(f.creationCalls()).toBe(0);
    },
  );

  it('视频创建开始后忽略迟到取消，继续查询并归档结果且不退款', async () => {
    const f = fixture(snapshot('video', true));
    let resolveCreate!: (response: Response) => void;
    let creationSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      creationSent = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = String(url);
      if (init?.method === 'POST') {
        creationSent();
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      if (requestUrl.endsWith('/video/generations/late-platform-task')) {
        return new Response(
          JSON.stringify({
            task_id: 'late-platform-task',
            status: 'completed',
            url: 'https://provider.example/result.mp4',
            format: 'mp4',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (requestUrl.endsWith('/result.mp4')) {
        return new Response(new Uint8Array([0, 1, 2, 3]), {
          headers: { 'content-type': 'video/mp4' },
        });
      }
      throw new Error(`unexpected request: ${requestUrl}`);
    });
    f.options.videoProvider = new NewApiVideoProvider({
      baseUrl: 'https://provider.example/v1',
      apiKey: 'synthetic-test-key',
      videoContract: 'newapi-unified-v1',
      fetchImpl,
      awaitSubmissionOnCancel: true,
      timeoutMs: 5000,
      pollIntervalMs: 0,
    });
    const refundFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          task_id: 'late-platform-task',
          status: 'failed',
          refund_status: 'refunded',
        }),
      ),
    );
    vi.stubGlobal('fetch', refundFetch);
    const archive = vi.fn(f.options.resultArchiver!);
    f.options.resultArchiver = archive;
    f.options.cancellationPollMs = 5;
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });
    const processing = queueState.processor!(f.job);
    await sent;
    f.job.data.cancelRequested = true;
    await vi.waitFor(() =>
      expect((fetchImpl.mock.calls[0]?.[1]?.signal as AbortSignal | undefined)?.aborted).not.toBe(
        true,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveCreate(
      new Response(JSON.stringify({ task_id: 'late-platform-task', status: 'queued' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(processing).resolves.toMatchObject({
      status: 'succeeded',
      providerJob: { platformJobId: 'late-platform-task', status: 'succeeded' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(refundFetch).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledOnce();
  });

  it('已处理退款的视频只读恢复不能复活，零 Provider 调用', async () => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'failed', 35),
      platformJobId: 'refunded-task',
      payload: {
        contract: 'newapi-unified-v1',
        phase: 'failed',
        refundStatus: 'refunded',
        error: '视频已取消；NewAPI 费用已退还',
      },
    };
    const f = fixture(snapshot('video', true), providerJob);
    f.job.data.retrieveOnly = true;
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });
    await expect(queueState.processor?.(f.job)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.job.data.providerJob?.status).toBe('failed');
  });

  it('临时查询网络失败保留原任务，不触发退款或重新生成', async () => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'submitted', 35),
      platformJobId: 'existing-task',
      payload: { contract: 'newapi-unified-v1', phase: 'submitted' },
    };
    const f = fixture(snapshot('video', true), providerJob);
    const refundFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', refundFetch);
    f.execute.mockRejectedValue(
      new NewApiProviderError('网络超时', {
        code: 'PROVIDER_TIMEOUT',
        platformJobId: 'existing-task',
        retryable: true,
      }),
    );
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });
    await expect(queueState.processor?.(f.job)).rejects.toThrow('网络超时');
    expect(refundFetch).not.toHaveBeenCalled();
    expect(f.job.data.providerJob?.platformJobId).toBe('existing-task');
    expect(f.creationCalls()).toBe(0);
  });

  it.each([false, true])('新取消意图在只读标志 %s 时仍阻止轮询与创建', async (retrieveOnly) => {
    const f = fixture(snapshot('video', true));
    f.job.data.cancelRequested = true;
    f.job.data.retrieveOnly = retrieveOnly;
    const isCancellationRequested = vi.fn(async () => true);
    f.options.persistence!.isCancellationRequested = isCancellationRequested;
    createRunWorker({ ...f.options, execution: singleSendAuthorization().execution });

    await expect(queueState.processor?.(f.job)).resolves.toMatchObject({ status: 'cancelled' });

    expect(isCancellationRequested).toHaveBeenCalledWith(f.job.id, retrieveOnly);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(0);
  });

  it.each(['缺少平台 ID', '合同不匹配'])('只读视频恢复%s时零 Provider 调用', async (failure) => {
    const providerJob: ProviderJob = {
      ...createProviderJobRecord('123e4567-e89b-42d3-a456-426614174215', 'newapi', 'cancelled', 35),
      ...(failure === '缺少平台 ID' ? {} : { platformJobId: 'accepted-platform-task' }),
      payload: {
        contract: failure === '合同不匹配' ? 'legacy-v1' : 'newapi-unified-v1',
        phase: 'submitted',
      },
    };
    const f = fixture(snapshot('video', true), providerJob);
    f.job.data.retrieveOnly = true;
    f.options.persistence!.isCancellationRequested = async () => false;
    const execution = singleSendAuthorization().execution;
    createRunWorker({ ...f.options, execution });

    await expect(queueState.processor?.(f.job)).rejects.toThrow('缺少可只读恢复');

    expect(execution.beginSend).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.creationCalls()).toBe(0);
    expect(f.resumeCalls()).toBe(0);
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

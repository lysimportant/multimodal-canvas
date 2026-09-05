import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiVideoProvider, type NewApiVideoContract, type ProviderJobUpdate } from './index.js';

/** 官方通用视频的最小冻结输入，仅使用合成模型与媒体，不访问供应商。 */
function videoSnapshot(parameters: Record<string, unknown> = { duration: 5 }): RunSnapshot {
  return {
    projectId: 'contract-test',
    canvasRevision: 1,
    targetNodeId: 'video',
    modelAlias: 'synthetic-video-model',
    submittedAt: '2026-09-05T00:00:00.000Z',
    parameters,
    nodes: [
      {
        id: 'video',
        type: 'video',
        position: { x: 0, y: 0 },
        data: { label: '视频测试', mediaType: 'video', mode: 'generate', prompt: 'A camera move' },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 构造官方 JSON 响应，可注入关联请求头用于脱敏回归。 */
function jsonResponse(
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 默认显式选择统一合同，所有公网形式地址均由注入式 fetch 截获。 */
function providerFor(
  fetchImpl: typeof fetch,
  videoContract: NewApiVideoContract = 'newapi-unified-v1',
): NewApiVideoProvider {
  return new NewApiVideoProvider({
    baseUrl: 'https://newapi.example/v1',
    apiKey: 'synthetic-key',
    videoContract,
    fetchImpl,
    pollIntervalMs: 0,
    maxPollAttempts: 2,
    timeoutMs: 100,
  });
}

/** 使用外部媒体 URL 验证 Provider 不擅自下载，归档属于 Worker 的边界。 */
const completed = {
  task_id: 'task-1',
  status: 'completed',
  url: 'https://cdn.example/output',
  format: 'webm',
  metadata: { duration: 5, width: 640, height: 480, fps: 24, seed: 42 },
};

describe('New API 官方统一视频合同', () => {
  it('POST 前等待合同持久化，按官方路径提交和查询，不采用 completion ID', async () => {
    let releasePersistence: () => void = () => undefined;
    const persisted = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const onProviderJob = vi.fn().mockImplementationOnce(() => persisted);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            task_id: 'task-1',
            id: 'completion-not-task',
            request_id: 'request-not-task',
            status: 'queued',
            usage: { total_tokens: 9 },
          },
          { 'x-request-id': 'create-request' },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'in_progress' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ...completed,
            metadata: {
              ...completed.metadata,
              key: 'synthetic-key',
              url: 'https://private.example?token=secret',
            },
          },
          { 'x-request-id': 'poll-request' },
        ),
      );
    const snapshot = videoSnapshot({
      prompt: '参数提示词',
      duration: 5.5,
      width: 640,
      height: 480,
      fps: 24,
      seed: 42,
      n: 1,
      response_format: 'url',
      user: 'synthetic-user',
      inferenceStrength: 'medium',
    });
    snapshot.inputs.push({
      nodeId: 'frame',
      role: 'firstFrame',
      sortOrder: 0,
      snapshot: {
        id: 'frame',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '首帧',
          mediaType: 'image',
          mode: 'source',
          contentUrl: 'https://assets.example/frame.png',
        },
      },
    });
    const execution = providerFor(fetchImpl).execute({ snapshot, onProviderJob });
    expect(onProviderJob).toHaveBeenCalledExactlyOnceWith({
      provider: 'newapi',
      status: 'queued',
      progress: 0,
      payload: {
        contract: 'newapi-unified-v1',
        phase: 'submitting',
        modelAlias: 'synthetic-video-model',
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    releasePersistence();
    const result = await execution;
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://newapi.example/v1/video/generations', 'POST'],
      ['https://newapi.example/v1/video/generations/task-1', 'GET'],
      ['https://newapi.example/v1/video/generations/task-1', 'GET'],
    ]);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'synthetic-video-model',
      prompt: '参数提示词',
      duration: 5.5,
      width: 640,
      height: 480,
      fps: 24,
      seed: 42,
      n: 1,
      response_format: 'url',
      user: 'synthetic-user',
      image: 'https://assets.example/frame.png',
    });
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'idempotency-key': expect.any(String),
    });
    expect(result.providerJob).toMatchObject({
      platformJobId: 'task-1',
      status: 'succeeded',
      payload: {
        contract: 'newapi-unified-v1',
        phase: 'completed',
        requestId: 'poll-request',
        mediaMetadata: completed.metadata,
      },
    });
    expect(result.output).toEqual({
      mediaType: 'video',
      kind: 'url',
      url: completed.url,
      mimeType: 'video/webm',
      format: 'webm',
    });
    expect(result.usage).toEqual({ metadata: { total_tokens: 9 } });
    expect(JSON.stringify(result.providerJob)).not.toMatch(
      /synthetic-key|private\.example|completion-not-task/,
    );
  });

  it.each(['missing', 'failed', 'cancelled'] as const)(
    '创建前持久化边界 %s 零请求',
    async (boundary) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const controller = new AbortController();
      const onProviderJob =
        boundary === 'missing'
          ? undefined
          : vi.fn(() => {
              if (boundary === 'failed') throw new Error('private database message');
              controller.abort();
            });
      await expect(
        providerFor(fetchImpl).execute({
          snapshot: videoSnapshot(),
          onProviderJob,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        code:
          boundary === 'missing'
            ? 'VIDEO_CONTRACT_PERSISTENCE_REQUIRED'
            : boundary === 'failed'
              ? 'VIDEO_CONTRACT_PERSISTENCE_FAILED'
              : 'ABORTED',
        retryable: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['newapi-unified-v1', 'newapi-video-v1', '/videos/task-1'],
    ['newapi-unified-v1', undefined, '/videos/task-1'],
    ['newapi-unified-v1', 'legacy-v1', '/videos/task-1'],
    ['legacy-v1', 'newapi-unified-v1', '/video/generations/task-1'],
  ] as const)('构造合同 %s 恢复冻结合同 %s 时只查询正确路径', async (selected, frozen, path) => {
    const unified = frozen === 'newapi-unified-v1';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          unified
            ? completed
            : { status: 'done', video: { url: 'https://cdn.example/legacy.mp4' } },
        ),
      );
    const result = await providerFor(fetchImpl, selected).execute({
      snapshot: videoSnapshot(unified ? { duration: 5 } : { resolution: '480p', seconds: '5' }),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task-1',
        payload: { ...(frozen ? { contract: frozen } : {}), phase: 'submitted' },
      },
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://newapi.example/v1${path}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.providerJob?.payload?.contract).toBe(frozen ?? 'legacy-v1');
  });

  it.each([
    { contract: 'sora-v1' },
    { contract: 'unknown', phase: 'submitted' },
    { contract: null },
    { contract: 'newapi-unified-v1', phase: 'submitting' },
    { contract: 'legacy-v1', phase: 'submitting' },
  ])('无 ID 的冻结记录 %# 不重复创建或猜测合同', async (payload) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: videoSnapshot(),
        onProviderJob: vi.fn(),
        providerJob: { provider: 'newapi', payload },
      }),
    ).rejects.toMatchObject({
      code:
        payload.phase === 'submitting' ? 'VIDEO_SUBMISSION_UNKNOWN' : 'VIDEO_CONTRACT_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('未知冻结合同保留旧平台 ID 并禁止查询', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: videoSnapshot(),
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-1',
          payload: { contract: 'unknown' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_CONTRACT_UNSUPPORTED', platformJobId: 'task-1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { seconds: 5 },
    { resolution: '480p' },
    { size: '640x480' },
    { quality: 'high' },
    { aspectRatio: '4:3' },
    { metadata: { negative_prompt: 'unsupported' } },
    { input_reference: 'file' },
    { n: 2 },
    { response_format: 'b64_json' },
  ])('未确认或无法完整归档的参数 %# 在 POST 前失败', async (parameters) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onProviderJob = vi.fn();
    await expect(
      providerFor(fetchImpl).execute({ snapshot: videoSnapshot(parameters), onProviderJob }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
  });

  it.each([
    { duration: 0 },
    { duration: Infinity },
    { duration: '5' },
    { width: 0 },
    { height: 1.5 },
    { fps: -1 },
    { seed: Number.MAX_SAFE_INTEGER + 1 },
    { user: 12 },
    { prompt: ' ' },
  ])('非法通用参数 %# 不隐式转换或丢弃', async (parameters) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: videoSnapshot(parameters),
        onProviderJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'completion-id' },
    { request_id: 'request-id' },
    { task_id: 123 },
    { data: { task_id: 'nested-id' } },
  ])('创建响应 %# 不能代替官方 task_id', async (payload) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ status: 'queued', ...payload }, { 'x-request-id': 'correlation-only' }),
      );
    await expect(
      providerFor(fetchImpl).execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'VIDEO_REQUEST_ID_MISSING',
      requestId: 'correlation-only',
      retryable: false,
      providerPayload: { contract: 'newapi-unified-v1', phase: 'submitting' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...completed, task_id: 'different' }, 'VIDEO_TASK_ID_MISMATCH'],
    [{ ...completed, task_id: undefined }, 'VIDEO_TASK_ID_MISMATCH'],
    [{ ...completed, status: 'done' }, 'VIDEO_STATUS_UNKNOWN'],
    [{ ...completed, url: undefined }, 'VIDEO_OUTPUT_URL_INVALID'],
    [{ ...completed, url: '/v1/videos/task-1/content' }, 'VIDEO_OUTPUT_URL_INVALID'],
    [{ ...completed, url: 'data:video/mp4;base64,AA==' }, 'VIDEO_OUTPUT_URL_INVALID'],
    [{ ...completed, format: 'gif' }, 'VIDEO_OUTPUT_FORMAT_UNSUPPORTED'],
    [{ ...completed, format: 123 }, 'VIDEO_OUTPUT_FORMAT_UNSUPPORTED'],
    [
      { task_id: 'task-1', status: 'failed', error: { message: 'synthetic-key rejected' } },
      'VIDEO_GENERATION_FAILED',
    ],
  ] as const)('异常查询 %# 保留任务与冻结合同，不回退其他协议', async (payload, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));
    const error = await providerFor(fetchImpl)
      .execute({
        snapshot: videoSnapshot(),
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-1',
          payload: { contract: 'newapi-unified-v1' },
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code,
      platformJobId: 'task-1',
      retryable: false,
      providerPayload: { contract: 'newapi-unified-v1' },
    });
    expect(String(error)).not.toContain('synthetic-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'done', undefined])(
    '创建返回未知状态 %s 仍保留已读到的 task_id，禁止自动重试',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ task_id: 'task-1', status }));
      await expect(
        providerFor(fetchImpl).execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({
        code: 'VIDEO_STATUS_UNKNOWN',
        platformJobId: 'task-1',
        retryable: false,
        providerPayload: { contract: 'newapi-unified-v1', phase: 'submitted' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('创建立即失败保留 task_id，错误与关联信息脱敏', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        task_id: 'task-1',
        status: 'failed',
        error: { message: 'synthetic-key denied' },
      }),
    );
    await expect(
      providerFor(fetchImpl).execute({ snapshot: videoSnapshot(), onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'VIDEO_GENERATION_FAILED',
      platformJobId: 'task-1',
      providerPayload: { contract: 'newapi-unified-v1', phase: 'failed' },
      message: '[REDACTED] denied',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('恢复查询未返回关联头时保留已有脱敏请求 ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(completed));
    const result = await providerFor(fetchImpl).execute({
      snapshot: videoSnapshot(),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task-1',
        payload: { contract: 'newapi-unified-v1', requestId: 'old-request synthetic-key' },
      },
    });
    expect(result.providerJob?.payload?.requestId).toBe('old-request [REDACTED]');
  });

  it('网络创建结果未知时仅一次 POST，冻结记录阻止下一次执行重放', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('lost response'));
    let frozenJob: ProviderJobUpdate | undefined;
    const onProviderJob = (job: ProviderJobUpdate) => {
      frozenJob = job;
    };
    const provider = providerFor(fetchImpl);
    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
    await expect(
      provider.execute({ snapshot: videoSnapshot(), onProviderJob, providerJob: frozenJob }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('查询响应体取消保留已知身份与合同，关闭读取流', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              controller.abort();
            },
            cancel: cancelled,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: videoSnapshot(),
        signal: controller.signal,
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-1',
          payload: { contract: 'newapi-unified-v1' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false,
      platformJobId: 'task-1',
      providerPayload: { contract: 'newapi-unified-v1' },
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('轮询期间取消只中止本地请求，不猜测远程取消接口或发送 DELETE', async () => {
    const controller = new AbortController();
    let pollStarted!: () => void;
    const pollReady = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/video/generations')) {
        return jsonResponse({ task_id: 'task-1', status: 'queued' });
      }
      if (requestUrl.endsWith('/video/generations/task-1')) {
        pollStarted();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('operation aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected request: ${requestUrl}`);
    });

    const execution = providerFor(fetchImpl).execute({
      snapshot: videoSnapshot(),
      signal: controller.signal,
      onProviderJob: vi.fn(),
    });
    await pollReady;
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: 'ABORTED',
      platformJobId: 'task-1',
      retryable: false,
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('轮询耗尽保留合同、身份与非终态，不再 POST', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ task_id: 'task-1', status: 'queued' }));
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: videoSnapshot(),
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-1',
          payload: { contract: 'newapi-unified-v1' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'VIDEO_POLL_TIMEOUT',
      retryable: true,
      platformJobId: 'task-1',
      providerPayload: { contract: 'newapi-unified-v1', phase: 'polling' },
    });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET']);
  });

  it('本地 HTTP 官方响应走通冻结、创建、查询、同源下载与 usage 输出', async () => {
    const updates: ProviderJobUpdate[] = [];
    const requests: {
      method?: string;
      path?: string;
      body: string;
      contractBeforeRequest?: unknown;
    }[] = [];
    let baseUrl = '';
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          method: request.method,
          path: request.url,
          body,
          contractBeforeRequest: updates[0]?.payload?.contract,
        });
        if (request.method === 'POST' && request.url === '/v1/video/generations') {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'http-create',
          });
          response.end(JSON.stringify({ task_id: 'task-1', status: 'queued' }));
        } else if (request.method === 'GET' && request.url === '/v1/video/generations/task-1') {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'http-poll',
          });
          response.end(
            JSON.stringify({
              ...completed,
              format: 'mp4',
              url: `${baseUrl}/media/final.mp4`,
              usage: { total_tokens: 4 },
            }),
          );
        } else if (request.method === 'GET' && request.url === '/media/final.mp4') {
          response.writeHead(200, { 'content-type': 'video/mp4' });
          response.end(Buffer.from([0, 1, 2, 3]));
        } else {
          response.writeHead(404);
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('本地 HTTP 监听失败');
      baseUrl = `http://127.0.0.1:${address.port}`;
      const result = await new NewApiVideoProvider({
        baseUrl,
        apiKey: 'synthetic-local-only',
        videoContract: 'newapi-unified-v1',
        pollIntervalMs: 0,
        timeoutMs: 2000,
      }).execute({
        snapshot: videoSnapshot(),
        onProviderJob: (job) => {
          updates.push(job);
        },
      });
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'POST /v1/video/generations',
        'GET /v1/video/generations/task-1',
        'GET /media/final.mp4',
      ]);
      expect(requests[0]?.contractBeforeRequest).toBe('newapi-unified-v1');
      expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
        model: 'synthetic-video-model',
        prompt: 'A camera move',
        duration: 5,
      });
      expect(result.output).toEqual({
        mediaType: 'video',
        kind: 'base64',
        base64: 'AAECAw==',
        mimeType: 'video/mp4',
        format: 'mp4',
      });
      expect(result.providerJob?.payload).toMatchObject({
        contract: 'newapi-unified-v1',
        mediaMetadata: completed.metadata,
        requestId: 'http-poll',
      });
      expect(result.usage).toEqual({ metadata: { total_tokens: 4 } });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});

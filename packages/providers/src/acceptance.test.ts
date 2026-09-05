import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { MediaType, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiProviderError, NewApiVideoProvider } from './index';

/** 构造不依赖外部凭据或网络的最小生成快照。 */
function snapshotFor(mediaType: MediaType): RunSnapshot {
  return {
    projectId: 'local-acceptance',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias: `${mediaType}-test`,
    submittedAt: '2026-09-05T00:00:00.000Z',
    parameters: mediaType === 'audio' ? { voice: 'alloy' } : {},
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: { label: 'local test', mediaType, mode: 'generate', prompt: 'test prompt' },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 返回测试专用 JSON 响应，不发送真实 Provider 请求。 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

/** 构造已经返回响应头、正在等待下一段内容的可取消流。 */
function stalledResponse(contentType: string) {
  let markReading: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          markReading();
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': contentType } },
  );
  return { response, reading, cancelled };
}

describe('Provider 本地契约验收', () => {
  it.each(['text', 'image', 'audio'] as const)(
    '%s 响应体中途取消时释放流且不重试',
    async (mediaType) => {
      const controller = new AbortController();
      const stream = stalledResponse(mediaType === 'audio' ? 'audio/mpeg' : 'application/json');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-local',
        fetchImpl,
      });
      const result = provider.execute({
        snapshot: snapshotFor(mediaType),
        signal: controller.signal,
      });
      const assertion = expect(result).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
      await stream.reading;
      controller.abort(new Error('private cancellation reason'));
      await assertion;
      expect(stream.cancelled).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
    1_000,
  );

  it.each(['create', 'poll', 'download'] as const)(
    '视频 %s 响应体取消保留已知任务身份',
    async (phase) => {
      const controller = new AbortController();
      const stream = stalledResponse(phase === 'download' ? 'video/mp4' : 'application/json');
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (phase === 'download' && !String(url).endsWith('/content'))
          return jsonResponse({ status: 'done' });
        return stream.response;
      });
      const provider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-local',
        fetchImpl,
        pollIntervalMs: 0,
      });
      const result = provider.execute({
        snapshot: snapshotFor('video'),
        signal: controller.signal,
        ...(phase === 'create'
          ? { onProviderJob: vi.fn() }
          : { providerJob: { provider: 'newapi' as const, platformJobId: 'known-job' } }),
      });
      const assertion = expect(result).rejects.toMatchObject({
        code: 'ABORTED',
        retryable: false,
        ...(phase === 'create' ? {} : { platformJobId: 'known-job' }),
      });
      await stream.reading;
      controller.abort();
      await assertion;
      expect(stream.cancelled).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(phase === 'download' ? 2 : 1);
    },
    1_000,
  );

  it('恢复调用开始前已经取消也保留平台任务 ID', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    await expect(
      provider.execute({
        snapshot: snapshotFor('video'),
        signal: AbortSignal.abort(),
        providerJob: { provider: 'newapi', platformJobId: 'known-job' },
      }),
    ).rejects.toMatchObject({ code: 'ABORTED', retryable: false, platformJobId: 'known-job' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['image', 'audio', 'video'] as const)(
    '%s 不透传或丢弃未知参考参数',
    async (mediaType) => {
      for (const parameter of [
        'reference_images',
        'referenceImages',
        'negative_prompt',
        'last_frame',
        'audio_track',
      ]) {
        const fetchImpl = vi.fn<typeof fetch>();
        const options = {
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'synthetic-local',
          fetchImpl,
        };
        const provider =
          mediaType === 'video' ? new NewApiVideoProvider(options) : new NewApiProvider(options);
        const snapshot = snapshotFor(mediaType);
        snapshot.parameters[parameter] = [
          'https://assets.example/one.png',
          'https://assets.example/two.png',
        ];
        await expect(provider.execute({ snapshot })).rejects.toMatchObject({
          code: 'UNSUPPORTED_PROVIDER_PARAMETER',
          retryable: false,
        });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    },
  );

  it('不把多张图片请求静默改为单张', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    const snapshot = snapshotFor('image');
    snapshot.parameters.n = 2;
    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['create', 'poll', 'download'] as const)(
    '视频 %s 响应体超时有界且不重新创建任务',
    async (phase) => {
      vi.useFakeTimers();
      try {
        const stream = stalledResponse(phase === 'download' ? 'video/mp4' : 'application/json');
        const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          if (phase === 'download' && !String(url).endsWith('/content'))
            return jsonResponse({ status: 'done' });
          return stream.response;
        });
        const provider = new NewApiVideoProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'synthetic-local',
          fetchImpl,
          pollIntervalMs: 0,
          maxPollAttempts: 1,
          timeoutMs: 50,
        });
        const result = provider.execute({
          snapshot: snapshotFor('video'),
          ...(phase === 'create'
            ? { onProviderJob: vi.fn() }
            : { providerJob: { provider: 'newapi' as const, platformJobId: 'known-job' } }),
        });
        const assertion = expect(result).rejects.toMatchObject(
          phase === 'create'
            ? { code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false }
            : { code: 'TIMEOUT', retryable: true, platformJobId: 'known-job' },
        );
        await stream.reading;
        await vi.advanceTimersByTimeAsync(51);
        await assertion;
        expect(stream.cancelled).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(phase === 'download' ? 2 : 1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['text', 'image', 'audio'] as const)('%s 响应体超时释放流和监听', async (mediaType) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, 'addEventListener');
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const stream = stalledResponse(mediaType === 'audio' ? 'audio/mpeg' : 'application/json');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-local',
        fetchImpl,
        timeoutMs: 50,
      });
      const result = provider.execute({
        snapshot: snapshotFor(mediaType),
        signal: controller.signal,
      });
      const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
      await stream.reading;
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(stream.cancelled).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('视频下载请求在响应头返回前也能取消', async () => {
    const controller = new AbortController();
    let markDownload: () => void = () => undefined;
    const downloading = new Promise<void>((resolve) => {
      markDownload = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/content')) return jsonResponse({ status: 'done' });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private abort reason')), {
          once: true,
        });
        markDownload();
      });
    });
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
      pollIntervalMs: 0,
    });
    const result = provider.execute({
      snapshot: snapshotFor('video'),
      signal: controller.signal,
      providerJob: { provider: 'newapi', platformJobId: 'known-job' },
    });
    await downloading;
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: 'ABORTED',
      platformJobId: 'known-job',
      retryable: false,
      message: 'New API 请求已取消',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['text', 'video'] as const)('%s 完成回调期间取消不能返回成功', async (mediaType) => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          mediaType === 'text'
            ? { choices: [{ message: { content: 'done' } }] }
            : { status: 'done', url: 'https://assets.example/result.mp4' },
        ),
      );
    const options = {
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
      pollIntervalMs: 0,
    };
    const provider =
      mediaType === 'video' ? new NewApiVideoProvider(options) : new NewApiProvider(options);
    await expect(
      provider.execute({
        snapshot: snapshotFor(mediaType),
        signal: controller.signal,
        providerJob: { provider: 'newapi', platformJobId: 'known-job' },
        reportProgress: (progress) => {
          if (progress === 100) controller.abort();
        },
      }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false,
      ...(mediaType === 'video' ? { platformJobId: 'known-job' } : {}),
    });
  });

  it('进度回调异常保留已创建身份且脱敏', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ request_id: 'created-job' }));
    const onProviderJob = vi.fn();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    await expect(
      provider.execute({
        snapshot: snapshotFor('video'),
        onProviderJob,
        reportProgress: () => {
          throw new Error('private callback data');
        },
      }),
    ).rejects.toMatchObject({
      code: 'VIDEO_PROGRESS_FAILED',
      retryable: false,
      platformJobId: 'created-job',
      message: '视频任务进度回调失败',
    });
    expect(onProviderJob).toHaveBeenCalledWith(
      expect.objectContaining({ platformJobId: 'created-job' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('持久化回调抛出 Provider 类型错误也不误重试轮询', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ status: 'running' }));
    const onProviderJob = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(
        new NewApiProviderError('private persistence detail', {
          code: 'NETWORK_ERROR',
          retryable: true,
        }),
      );
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
      pollIntervalMs: 0,
    });
    await expect(
      provider.execute({
        snapshot: snapshotFor('video'),
        onProviderJob,
        providerJob: { provider: 'newapi', platformJobId: 'known-job' },
      }),
    ).rejects.toMatchObject({
      code: 'VIDEO_JOB_PERSISTENCE_FAILED',
      retryable: false,
      platformJobId: 'known-job',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['text/html', 'image/png', 'audio/mpeg'])(
    '不把 %s 下载内容伪装为视频',
    async (mimeType) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ status: 'done' }))
        .mockResolvedValueOnce(
          new Response('not video', { headers: { 'content-type': mimeType } }),
        );
      const provider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-local',
        fetchImpl,
        pollIntervalMs: 0,
      });
      await expect(
        provider.execute({
          snapshot: snapshotFor('video'),
          providerJob: { provider: 'newapi', platformJobId: 'known-job' },
        }),
      ).rejects.toMatchObject({
        code: 'VIDEO_CONTENT_TYPE_INVALID',
        platformJobId: 'known-job',
        retryable: false,
      });
    },
  );

  it('明确保留已知图像可选参数，不把标准 style 当作参考图角色', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    const snapshot = snapshotFor('image');
    snapshot.parameters = {
      size: '1024x1024',
      quality: 'hd',
      style: 'natural',
      background: 'auto',
      moderation: 'auto',
      user: 'local-test',
      response_format: 'b64_json',
      output_format: 'png',
      n: 1,
    };
    await provider.execute({ snapshot });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      prompt: 'test prompt',
    });
  });

  it.each([0.25, 4])('按官方 TTS 格式映射边界语速 %s', async (speed) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'audio/wav' } }),
      );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    const snapshot = snapshotFor('audio');
    snapshot.parameters = {
      voice: 'nova',
      speed,
      response_format: 'wav',
      input: 'read this',
      inferenceStrength: 'medium',
    };
    const result = await provider.execute({ snapshot });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      voice: 'nova',
      speed,
      response_format: 'wav',
      input: 'read this',
      model: snapshot.modelAlias,
    });
    expect(result.output).toMatchObject({ kind: 'base64', mimeType: 'audio/wav', format: 'wav' });
  });

  it.each([
    { voice: undefined },
    { voice: 'unknown-voice' },
    { speed: 0.24 },
    { speed: 4.01 },
    { speed: Number.NaN },
    { speed: '1' },
    { response_format: 'ogg' },
    { input: 'a'.repeat(4097) },
  ])('TTS 非法配置在发送前失败 %#', async (parameters) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    const snapshot = snapshotFor('audio');
    snapshot.parameters = { ...snapshot.parameters, ...parameters };
    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['image', 'audio', 'video'] as const)(
    '%s 对未知参数显式失败且不回显内容',
    async (mediaType) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const options = {
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-local',
        fetchImpl,
      };
      const provider =
        mediaType === 'video' ? new NewApiVideoProvider(options) : new NewApiProvider(options);
      const snapshot = snapshotFor(mediaType);
      snapshot.parameters.vendor_unknown = 'private prompt';
      await expect(provider.execute({ snapshot })).rejects.toMatchObject({
        code: 'UNSUPPORTED_PROVIDER_PARAMETER',
        retryable: false,
        message: `New API ${mediaType} 尚不支持参数：vendor_unknown`,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['image', 'audio'] as const)('%s 多项响应不能只归档第一项', async (mediaType) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ b64_json: 'AA==' }, { b64_json: 'AQ==' }] }));
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    await expect(provider.execute({ snapshot: snapshotFor(mediaType) })).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_CARDINALITY_UNSUPPORTED',
      retryable: false,
    });
  });

  it.each(['image', 'audio'] as const)(
    '%s 不归档损坏编码或带凭据的 URL 字符串',
    async (mediaType) => {
      for (const data of [
        '%%%',
        'data:image/png;base64,%%%',
        'https://user:secret@assets.example/result.png',
      ]) {
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ data: [{ data }] }));
        const provider = new NewApiProvider({
          baseUrl: 'https://newapi.example/v1',
          apiKey: 'synthetic-local',
          fetchImpl,
        });
        await expect(provider.execute({ snapshot: snapshotFor(mediaType) })).rejects.toMatchObject({
          retryable: false,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    { mediaType: 'image' as const, parameters: { imageSize: '1024x1024', size: '1536x1024' } },
    {
      mediaType: 'image' as const,
      parameters: { background: 'transparent', output_format: 'jpeg' },
    },
    { mediaType: 'video' as const, parameters: { duration: 5, seconds: '8' } },
    { mediaType: 'video' as const, parameters: { duration: -1 } },
  ])('拒绝矛盾参数及无效时长 %#', async ({ mediaType, parameters }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const options = { baseUrl: 'https://newapi.example/v1', apiKey: 'synthetic-local', fetchImpl };
    const provider =
      mediaType === 'video' ? new NewApiVideoProvider(options) : new NewApiProvider(options);
    const snapshot = snapshotFor(mediaType);
    snapshot.parameters = parameters;
    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])('冻结首帧内容损坏时拒绝创建或恢复：resume=%s', async (resume) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    const snapshot = snapshotFor('video');
    snapshot.inputs = [
      {
        nodeId: 'frame',
        role: 'firstFrame',
        sortOrder: 0,
        snapshot: {
          id: 'frame',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            mediaType: 'image',
            mode: 'source',
            label: 'frame',
            contentUrl: 'data:image/png;base64,%%%',
          },
        },
      },
    ];
    await expect(
      provider.execute({
        snapshot,
        ...(resume
          ? { providerJob: { provider: 'newapi' as const, platformJobId: 'known-job' } }
          : {}),
      }),
    ).rejects.toMatchObject({ code: 'INPUT_ROLE_VALUE_MISSING', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('超过响应头声明的大小限制时关闭未消费流', async () => {
    const stream = stalledResponse('application/json');
    stream.response.headers.set('content-length', '200');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
      maxResponseBytes: 10,
    });
    await expect(provider.execute({ snapshot: snapshotFor('text') })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
  });

  it.each(['text', 'image', 'audio'] as const)('%s 预取消不发送请求', async (mediaType) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-local',
      fetchImpl,
    });
    await expect(
      provider.execute({ snapshot: snapshotFor(mediaType), signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('真实 loopback HTTP 视频下载中途取消会关闭连接且保留任务身份', async () => {
    const controller = new AbortController();
    let markHeaders: () => void = () => undefined;
    const headersReceived = new Promise<void>((resolve) => {
      markHeaders = resolve;
    });
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      if (request.url === '/v1/videos/known-job') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'done' }));
      } else if (request.url === '/v1/videos/known-job/content') {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        response.write(new Uint8Array([0, 1, 2, 3]));
        response.once('close', markClosed);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback listener missing');
      const fetchImpl: typeof fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).endsWith('/content')) markHeaders();
        return response;
      };
      const provider = new NewApiVideoProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'synthetic-local-only',
        fetchImpl,
        pollIntervalMs: 0,
        timeoutMs: 2_000,
      });
      const result = provider.execute({
        snapshot: snapshotFor('video'),
        signal: controller.signal,
        providerJob: { provider: 'newapi', platformJobId: 'known-job' },
      });
      const assertion = expect(result).rejects.toMatchObject({
        code: 'ABORTED',
        retryable: false,
        platformJobId: 'known-job',
      });
      await headersReceived;
      await nextTurn();
      controller.abort();
      await assertion;
      await closed;
      expect(paths).toEqual(['GET /v1/videos/known-job', 'GET /v1/videos/known-job/content']);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});

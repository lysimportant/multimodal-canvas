import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider, type NewApiVideoContract } from './index.js';

/** 本文件仅覆盖非图片请求；所有 HTTP 调用均由注入式 fetch 截获。 */
type NonImageMediaType = 'text' | 'audio' | 'video';

/** 构造无真实用户、凭据或素材的冻结快照，参数仅作用于目标节点。 */
function snapshotFor(
  mediaType: NonImageMediaType,
  parameters: Record<string, unknown>,
  modelAlias = `synthetic-${mediaType}`,
): RunSnapshot {
  return {
    projectId: 'non-image-parameters',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias,
    parameters,
    submittedAt: '2026-09-29T00:00:00.000Z',
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: 'Synthetic target',
          mediaType,
          mode: 'generate',
          prompt: 'Describe a calm coastal scene.',
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' as const } : {}),
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 构造本地 JSON 响应，不启动 HTTP 服务或访问模型网关。 */
function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

/** 注入唯一网络出口；此适配器用于文本和 OpenAI 兼容 TTS。 */
function standardProvider(fetchImpl: typeof fetch): NewApiProvider {
  return new NewApiProvider({
    baseUrl: 'https://newapi.example/v1',
    apiKey: 'synthetic-parameter-test-key',
    fetchImpl,
  });
}

/** 为三种已实现合同提供各自任务身份和终态，不混用响应协议。 */
function videoHarness(contract: NewApiVideoContract) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      jsonResponse(
        contract === 'newapi-unified-v1'
          ? { task_id: 'synthetic-task', status: 'queued' }
          : contract === 'newapi-video-v1'
            ? { id: 'synthetic-task', status: 'queued' }
            : { request_id: 'synthetic-task' },
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse(
        contract === 'newapi-unified-v1'
          ? {
              task_id: 'synthetic-task',
              status: 'completed',
              url: 'https://cdn.example/synthetic.mp4',
              format: 'mp4',
            }
          : {
              id: 'synthetic-task',
              status: contract === 'newapi-video-v1' ? 'completed' : 'done',
              video: { url: 'https://cdn.example/synthetic.mp4' },
            },
      ),
    );
  return {
    fetchImpl,
    onProviderJob: vi.fn(),
    provider: new NewApiVideoProvider({
      baseUrl: 'https://newapi.example/v1',
      apiKey: 'synthetic-parameter-test-key',
      videoContract: contract,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl,
    }),
  };
}

/** 读取被截获的 JSON 请求体；断言字段全集，避免漏传或多传被局部匹配掩盖。 */
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('非图片参数的出站字段', () => {
  it('文本保留采样、长度、惩罚、随机种子和格式，推理别名只生成一个字段', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
      );
    const parameters = {
      prompt: 'Return a short description.',
      temperature: 0,
      top_p: 0.9,
      max_tokens: 128,
      presence_penalty: -0.5,
      frequency_penalty: 0.5,
      seed: 0,
      stop: ['END'],
      response_format: { type: 'json_object' },
      inferenceStrength: ' high ',
      reasoning_effort: 'high',
      n: 1,
      stream: false,
    };
    await standardProvider(fetchImpl).execute({ snapshot: snapshotFor('text', parameters) });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example/v1/chat/completions');
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      temperature: 0,
      top_p: 0.9,
      max_tokens: 128,
      presence_penalty: -0.5,
      frequency_penalty: 0.5,
      seed: 0,
      stop: ['END'],
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      n: 1,
      stream: false,
      model: 'synthetic-text',
      messages: [{ role: 'user', content: 'Return a short description.' }],
    });
    expect(parameters.inferenceStrength).toBe(' high ');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { voice: 'alloy', speed: 0.25, response_format: 'mp3' },
    { voice: 'echo', speed: 0.5, response_format: 'opus' },
    { voice: 'fable', speed: 1, response_format: 'aac' },
    { voice: 'onyx', speed: 1.234, response_format: 'flac' },
    { voice: 'nova', speed: 2, response_format: 'wav' },
    { voice: 'shimmer', speed: 4, response_format: 'pcm' },
  ])('TTS 精确传递 $voice / $speed / $response_format', async (parameters) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(new Uint8Array([0, 1]), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const snapshot = snapshotFor('audio', {
      ...parameters,
      input: 'Read this sentence.',
      inferenceStrength: 'high',
    });
    await standardProvider(fetchImpl).execute({ snapshot });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example/v1/audio/speech');
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      ...parameters,
      model: 'synthetic-audio',
      input: 'Read this sentence.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['language', 'seed', 'temperature', 'volume', 'pitch'])(
    'TTS 未接通的 %s 不会被静默丢弃或擅自透传',
    async (parameter) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        standardProvider(fetchImpl).execute({
          snapshot: snapshotFor('audio', { voice: 'nova', [parameter]: 'unverified' }),
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['legacy-v1', 'newapi-video-v1'] as const)(
    '%s 保留时长、分辨率、像素尺寸、质量和比例的别名值',
    async (contract) => {
      const { provider, fetchImpl, onProviderJob } = videoHarness(contract);
      const parameters = {
        durationSeconds: '8',
        videoResolution: '720p',
        videoSize: '1280x720',
        videoQuality: 'high',
        aspectRatio: '16:9',
        inferenceStrength: 'high',
      };
      await provider.execute({ snapshot: snapshotFor('video', parameters), onProviderJob });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        `https://newapi.example/v1/${contract === 'legacy-v1' ? 'videos/generations' : 'videos'}`,
      );
      expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
        model: 'synthetic-video',
        prompt: 'Describe a calm coastal scene.',
        duration: 8,
        ...(contract === 'newapi-video-v1' ? { seconds: '8' } : {}),
        resolution: '720p',
        size: '1280x720',
        quality: 'high',
        aspect_ratio: '16:9',
      });
      expect(parameters.durationSeconds).toBe('8');
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    },
  );

  it.each([
    { duration: 8, seconds: '10' },
    { resolution: '720p', videoResolution: '1080p' },
    { size: '1280x720', videoSize: '720x1280' },
    { quality: 'high', videoQuality: 'low' },
    { aspect_ratio: '16:9', aspectRatio: '9:16' },
  ])('视频冲突别名在写入发送意图和 POST 之前失败 %#', async (parameters) => {
    const { provider, fetchImpl, onProviderJob } = videoHarness('newapi-video-v1');
    await expect(
      provider.execute({ snapshot: snapshotFor('video', parameters), onProviderJob }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
  });

  it('统一视频合同保留小数时长、显式宽高、帧率和零随机种子', async () => {
    const { provider, fetchImpl, onProviderJob } = videoHarness('newapi-unified-v1');
    const parameters = {
      duration: 5.5,
      width: 720,
      height: 1280,
      fps: 24,
      seed: 0,
      n: 1,
      response_format: 'url',
      user: 'synthetic-user',
    };
    await provider.execute({ snapshot: snapshotFor('video', parameters), onProviderJob });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example/v1/video/generations');
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      model: 'synthetic-video',
      prompt: 'Describe a calm coastal scene.',
      ...parameters,
    });
  });

  it.each(
    (['legacy-v1', 'newapi-video-v1'] as const).flatMap((contract) =>
      ['seed', 'audio', 'generate_audio', 'audio_enabled', 'negative_prompt'].map((parameter) => ({
        contract,
        parameter,
      })),
    ),
  )('$contract 未确认的 $parameter 在 POST 前明确拒绝', async ({ contract, parameter }) => {
    const { provider, fetchImpl, onProviderJob } = videoHarness(contract);
    await expect(
      provider.execute({
        snapshot: snapshotFor('video', { [parameter]: 1 }),
        onProviderJob,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'wan3.0-video', resolution: '1080P', expected: '1080P', topLevel: true },
    { model: 'wan3.0-video-prime', resolution: '720P', expected: '720P', topLevel: true },
    { model: 'MiniMax-H3', resolution: '768P', expected: '768P', topLevel: false },
    { model: 'minimax-h3', resolution: '1080P', expected: '1080P', topLevel: false },
    { model: 'seedance-2-0-official', resolution: '4K', expected: '4k', topLevel: false },
    { model: 'seedance-2-0-fast-official', resolution: '720P', expected: '720p', topLevel: false },
    {
      model: 'doubao-seedance-2-5-260628',
      resolution: '1080P',
      expected: '1080p',
      topLevel: false,
    },
  ])('$model 按已实现插件合同写入清晰度、比例与秒数', async (testCase) => {
    const { provider, fetchImpl, onProviderJob } = videoHarness('newapi-video-v1');
    await provider.execute({
      snapshot: snapshotFor(
        'video',
        { durationSeconds: '8', videoResolution: testCase.resolution, aspectRatio: '9:16' },
        testCase.model,
      ),
      onProviderJob,
    });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      model: testCase.model,
      prompt: 'Describe a calm coastal scene.',
      seconds: '8',
      duration: 8,
      ...(testCase.topLevel
        ? { resolution: testCase.expected, ratio: '9:16', metadata: { input: { media: [] } } }
        : {
            metadata: {
              content: [{ type: 'text', text: 'Describe a calm coastal scene.' }],
              resolution: testCase.expected,
              ratio: '9:16',
            },
          }),
    });
  });

  it('Wan 负向提示仅由已校验连线写入 metadata.input.negative_prompt', async () => {
    const { provider, fetchImpl, onProviderJob } = videoHarness('newapi-video-v1');
    const snapshot = snapshotFor('video', { duration: 8 }, 'wan3.0-video');
    snapshot.inputs.push({
      nodeId: 'negative',
      role: 'negativePrompt',
      sortOrder: 0,
      snapshot: {
        id: 'negative',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: 'Negative', mediaType: 'text', mode: 'source', prompt: 'No captions.' },
      },
    });
    await provider.execute({ snapshot, onProviderJob });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      model: 'wan3.0-video',
      prompt: 'Describe a calm coastal scene.',
      seconds: '8',
      duration: 8,
      resolution: '720P',
      ratio: '16:9',
      metadata: { input: { media: [], negative_prompt: 'No captions.' } },
    });
  });
});

describe('非图片参数的别名与单项输出兼容', () => {
  it.each([
    { inferenceStrength: 'high', reasoning_effort: 'high' },
    { inferenceStrength: ' high ', reasoning_effort: ' high ' },
    { inferenceStrength: '\thigh\n', reasoning_effort: 'high' },
    { inferenceStrength: 'high' },
    { reasoning_effort: 'high' },
    { inferenceStrength: '  ', reasoning_effort: 'high' },
    { inferenceStrength: 'high', reasoning_effort: '  ' },
  ])('相同推理别名和首尾空格保持兼容 %#', async (parameters) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
      );
    const original = { ...parameters };
    await standardProvider(fetchImpl).execute({ snapshot: snapshotFor('text', parameters) });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      reasoning_effort: 'high',
      model: 'synthetic-text',
      messages: [{ role: 'user', content: 'Describe a calm coastal scene.' }],
    });
    expect(parameters).toEqual(original);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('动态推理标识的相同别名不受固定枚举限制', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
      );
    await standardProvider(fetchImpl).execute({
      snapshot: snapshotFor('text', { inferenceStrength: ' xhigh ', reasoning_effort: 'xhigh' }),
    });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1]).reasoning_effort).toBe('xhigh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { n: 1 }, { stream: false }, { n: 1, stream: false }])(
    '显式或省略单项非流式参数都只创建一次请求 %#',
    async (parameters) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
        );
      const result = await standardProvider(fetchImpl).execute({
        snapshot: snapshotFor('text', parameters),
      });
      expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
        ...parameters,
        model: 'synthetic-text',
        messages: [{ role: 'user', content: 'Describe a calm coastal scene.' }],
      });
      expect(result.output).toMatchObject({ kind: 'text', text: 'Synthetic text' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { prompt: 'Read this sentence.', input: 'Read this sentence.' },
    { prompt: '  Read this sentence.  ', input: 'Read this sentence.' },
    { prompt: 'Read this sentence.', input: '\tRead this sentence.\n' },
  ])('TTS 同值正文别名与首尾空格保持兼容 %#', async (parameters) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'audio/mpeg' } }),
      );
    const original = { ...parameters };
    await standardProvider(fetchImpl).execute({
      snapshot: snapshotFor('audio', { ...parameters, voice: 'nova' }),
    });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1])).toEqual({
      voice: 'nova',
      model: 'synthetic-audio',
      input: 'Read this sentence.',
    });
    expect(parameters).toEqual(original);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('非图片参数的静默覆盖与未实现输出回归', () => {
  it.each([
    { n: 2 },
    { n: 0 },
    { n: 1.5 },
    { n: '1' },
    { n: null },
    { stream: true },
    { stream: 'false' },
    { stream: 0 },
    { stream: null },
  ])('文本不能发送当前归档不支持的输出参数 %#', async (parameters) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
      );
    await expect(
      standardProvider(fetchImpl).execute({ snapshot: snapshotFor('text', parameters) }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('文本推理强度别名冲突不能静默覆写供应商字段', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }),
      );
    await expect(
      standardProvider(fetchImpl).execute({
        snapshot: snapshotFor('text', { inferenceStrength: 'high', reasoning_effort: 'low' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('TTS prompt 与 input 不同时在 POST 前拒绝而不是丢弃 input', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'audio/mpeg' } }),
      );
    await expect(
      standardProvider(fetchImpl).execute({
        snapshot: snapshotFor('audio', {
          voice: 'nova',
          prompt: 'Read north.',
          input: 'Read south.',
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      choices: [
        { message: { content: 'First choice' } },
        { message: { content: 'Second choice' } },
      ],
    },
    { choices: [{ text: 'First choice' }, { text: 'Second choice' }] },
  ])('多候选响应保留请求身份、拒绝归档且不重试 %#', async ({ choices }) => {
    const response = jsonResponse({ choices });
    response.headers.set('x-request-id', 'synthetic-create-request');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const reportProgress = vi.fn();
    await expect(
      standardProvider(fetchImpl).execute({ snapshot: snapshotFor('text', {}), reportProgress }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_CARDINALITY_UNSUPPORTED',
      retryable: false,
      requestId: 'synthetic-create-request',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reportProgress).not.toHaveBeenCalled();
  });
});

describe('显式推理参数类型不会被别名吞掉', () => {
  it.each([null, false, 42, {}, []])('原生字段为 %j 时拒绝用别名覆盖', async (reasoning_effort) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      standardProvider(fetchImpl).execute({
        snapshot: snapshotFor('text', { inferenceStrength: 'high', reasoning_effort }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([null, false, 42])('推理强度别名类型 %j 非法时不静默丢弃', async (inferenceStrength) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      standardProvider(fetchImpl).execute({ snapshot: snapshotFor('text', { inferenceStrength }) }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('单独的原生 null 保持原合同，不擅自改成 high', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'Synthetic text' } }] }));
    await standardProvider(fetchImpl).execute({
      snapshot: snapshotFor('text', { reasoning_effort: null }),
    });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1]).reasoning_effort).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

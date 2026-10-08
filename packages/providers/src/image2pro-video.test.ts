import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MediaType,
  PortRole,
  RequestPromptRecord,
  RunInputSnapshot,
  RunSnapshot,
  VideoMode,
} from '@multimodal-canvas/domain';
import {
  NewApiVideoProvider,
  resolveProviderMentions,
  type NewApiVideoContract,
  type ProviderJobUpdate,
} from './index.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('本测试禁止真实网络请求')));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** Image2Pro 插件已登记的精确 ID；近似名称不能沿用它们的参考图合同。 */
const models = ['Seedance2.0 0.9r'];

/** 创建不含用户数据的冻结快照；测试仅通过注入 fetch 捕获请求。 */
function snapshotFor(modelAlias = models[0]!): RunSnapshot {
  return {
    projectId: 'image2pro-contract',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias,
    submittedAt: '2026-10-07T00:00:00.000Z',
    parameters: { duration: 5, aspectRatio: '16:9' },
    nodes: [
      {
        id: 'target',
        type: 'video',
        position: { x: 0, y: 0 },
        data: {
          label: '视频',
          mediaType: 'video',
          mode: 'generate',
          videoMode: 'text_to_video',
          prompt: 'A camera moves through the room.',
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 构造明确版本与角色的引用，URL 只由 fetch 替身观察，不访问外网。 */
function inputFor(
  assetId: string,
  role: PortRole = 'referenceImage',
  sortOrder = 0,
  mediaType: MediaType = 'image',
  assetVersion = 1,
): RunInputSnapshot {
  return {
    nodeId: `${assetId}-${role}`,
    role,
    sortOrder,
    sourceAssetId: assetId,
    sourceAssetVersion: assetVersion,
    snapshot: {
      id: `${assetId}-${role}`,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: assetId,
        mediaType,
        mode: 'source',
        assetId,
        mimeType: `${mediaType}/${mediaType === 'image' ? 'png' : mediaType === 'video' ? 'mp4' : 'mpeg'}`,
        contentUrl: `https://assets.invalid/${assetId}-v${assetVersion}.${mediaType === 'image' ? 'png' : mediaType === 'video' ? 'mp4' : 'mp3'}`,
      },
    },
  };
}

/** 模拟 New API 公共任务信封，私有上游 ID 与关联请求 ID 故意不同。 */
function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

/** 使用已有 New API 视频协议，关闭等待以验证创建和只读轮询的请求序列。 */
function providerFor(
  fetchImpl: typeof fetch,
  videoContract: NewApiVideoContract = 'newapi-video-v1',
): NewApiVideoProvider {
  return new NewApiVideoProvider({
    baseUrl: 'https://newapi.invalid/v1',
    apiKey: 'synthetic-key',
    videoContract,
    fetchImpl,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
  });
}

/** 完成信封的外部 URL 交回 Worker 归档，不向成片地址泄露 New API 凭据。 */
function completedFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'task-public-image2pro',
        task_id: '0123456789abcdef',
        request_id: 'correlation-only',
        object: 'video',
        status: 'queued',
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({ id: 'task-public-image2pro', status: 'in_progress', progress: 50 }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'task-public-image2pro',
        status: 'completed',
        url: 'https://media.invalid/generated.mp4',
      }),
    );
}

describe('Image2Pro 视频插件合同', () => {
  it.each(['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'])(
    '%s 不因合同或缺少模式回落到通用创建路径',
    async (modelAlias) => {
      for (const contract of ['legacy-v1', 'newapi-video-v1', 'newapi-unified-v1'] as const) {
        for (const videoMode of [undefined, 'text_to_video'] as const) {
          const snapshot = snapshotFor(modelAlias);
          snapshot.nodes[0]!.data.videoMode = videoMode;
          const fetchImpl = vi.fn<typeof fetch>();
          const onProviderJob = vi.fn();
          await expect(
            providerFor(fetchImpl, contract).execute({ snapshot, onProviderJob }),
          ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT_COMBINATION', retryable: false });
          expect(fetchImpl).not.toHaveBeenCalled();
          expect(onProviderJob).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(models)('%s 使用规范字段创建，按公共 ID 查询并返回成片 URL', async (model) => {
    const snapshot = snapshotFor(model);
    const before = structuredClone(snapshot);
    const fetchImpl = completedFetch();
    const onProviderJob = vi.fn();
    const result = await providerFor(fetchImpl).execute({ snapshot, onProviderJob });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      model,
      content: [{ type: 'text', text: 'A camera moves through the room.' }],
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://newapi.invalid/v1/videos', 'POST'],
      ['https://newapi.invalid/v1/videos/task-public-image2pro', 'GET'],
      ['https://newapi.invalid/v1/videos/task-public-image2pro', 'GET'],
    ]);
    expect(result.output).toEqual({
      mediaType: 'video',
      kind: 'url',
      url: 'https://media.invalid/generated.mp4',
      mimeType: 'video/mp4',
      format: 'mp4',
    });
    expect(result.providerJob).toMatchObject({
      platformJobId: 'task-public-image2pro',
      status: 'succeeded',
      payload: { contract: 'newapi-video-v1', phase: 'completed', modelAlias: model },
    });
    expect(onProviderJob.mock.calls[0]![0]).toMatchObject({
      payload: { contract: 'newapi-video-v1', phase: 'submitting' },
    });
    expect(snapshot).toEqual(before);
  });

  it.each(['legacy-v1', 'newapi-unified-v1'] as const)(
    '%s 不得为 Image2Pro 创建任务',
    async (contract) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const onProviderJob = vi.fn();
      await expect(
        providerFor(fetchImpl, contract).execute({ snapshot: snapshotFor(), onProviderJob }),
      ).rejects.toMatchObject({ code: 'VIDEO_CONTRACT_UNSUPPORTED', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onProviderJob).not.toHaveBeenCalled();
    },
  );

  it('角色图片、冻结提及和请求记录按同一资源顺序发送，重复同版本提及只发送一次', async () => {
    const snapshot = snapshotFor();
    const target = snapshot.nodes[0]!.data;
    target.videoMode = 'omni_reference';
    snapshot.inputs = [inputFor('style', 'style', 2), inputFor('person', 'character', 1)];
    const mentions = [
      { mentionId: 'scene-v1', assetId: 'scene', assetVersion: 1, blockOrder: 1 },
      { mentionId: 'scene-v2', assetId: 'scene', assetVersion: 2, blockOrder: 3 },
      { mentionId: 'scene-v2-repeat', assetId: 'scene', assetVersion: 2, blockOrder: 5 },
    ].map((mention) => ({
      ...mention,
      nodeId: 'target',
      mediaType: 'image' as const,
      label: `${mention.assetId}@${mention.assetVersion}`,
    }));
    snapshot.promptMentions = mentions;
    target.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: 'Use ' },
        ...mentions.flatMap((mention) => [
          {
            ...mention,
            type: 'mention' as const,
            mimeType: 'image/png',
            contentUrl: `data:image/png;base64,${Buffer.from(mention.label).toString('base64')}`,
          },
          { type: 'text' as const, text: ' / ' },
        ]),
      ],
    };
    target.resourceRefs = [
      ['scene', 2],
      ['person', 1],
      ['scene', 1],
      ['style', 1],
    ].map(([assetId, assetVersion]) => ({
      id: `ordered:${assetId}@${assetVersion}`,
      assetId: String(assetId),
      assetVersion: Number(assetVersion),
      mediaType: 'image',
      name: String(assetId),
    }));
    const before = structuredClone(snapshot);
    const fetchImpl = completedFetch();
    const records: RequestPromptRecord[] = [];
    await providerFor(fetchImpl).execute({
      snapshot,
      runId: 'reference-order',
      onProviderJob: vi.fn(),
      resolvedMentions: resolveProviderMentions(snapshot),
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body).toEqual({
      model: models[0],
      content: [
        { type: 'text', text: 'Use scene@1 / scene@2 / scene@2 / ' },
        ...[
          `data:image/png;base64,${Buffer.from('scene@2').toString('base64')}`,
          'https://assets.invalid/person-v1.png',
          `data:image/png;base64,${Buffer.from('scene@1').toString('base64')}`,
          'https://assets.invalid/style-v1.png',
        ].map((url) => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
      ],
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
    });
    expect(records).toHaveLength(1);
    expect(
      records[0]!.resources.map(({ assetId, assetVersion, role, sortOrder }) => [
        assetId,
        assetVersion,
        role,
        sortOrder,
      ]),
    ).toEqual([
      ['scene', 2, 'referenceImage', 0],
      ['person', 1, 'character', 1],
      ['scene', 1, 'referenceImage', 2],
      ['style', 1, 'style', 3],
    ]);
    expect(records[0]!.requestIdentity).toBe('POST /videos#1');
    expect(JSON.stringify(records)).not.toContain('https://assets.invalid');
    expect(JSON.stringify(records)).not.toContain('data:image/png');
    expect(snapshot).toEqual(before);
  });

  it('保留整数秒数与一致参数别名，九张普通参考图不转成首尾帧', async () => {
    const snapshot = snapshotFor('Seedance2.0 0.9r');
    snapshot.parameters = { duration: 5, seconds: '5.00', ratio: '9:16' };
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = Array.from({ length: 9 }, (_, index) =>
      inputFor(`image-${index}`, 'referenceImage', index),
    );
    const fetchImpl = completedFetch();
    await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      model: 'Seedance2.0 0.9r',
      content: [
        { type: 'text', text: 'A camera moves through the room.' },
        ...snapshot.inputs.map((input) => ({
          type: 'image_url',
          image_url: { url: input.snapshot.data.contentUrl },
          role: 'reference_image',
        })),
      ],
      duration: 5,
      resolution: '720p',
      ratio: '9:16',
    });
  });

  it.each([
    { label: '视频编辑', mode: 'video_edit', role: 'content', mediaType: 'video' },
    { label: '视频延长', mode: 'video_extend', role: 'content', mediaType: 'video' },
    { label: '纯音频参考', mode: 'omni_reference', role: 'audioTrack', mediaType: 'audio' },
  ] satisfies { label: string; mode: VideoMode; role: PortRole; mediaType: MediaType }[])(
    '不发送未确认的 $label 输入',
    async ({ mode, role, mediaType }) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = mode;
      snapshot.inputs = [inputFor('unsupported', role, 0, mediaType)];
      const fetchImpl = vi.fn<typeof fetch>();
      const onProviderJob = vi.fn();
      await expect(
        providerFor(fetchImpl).execute({ snapshot, onProviderJob }),
      ).rejects.toMatchObject({ retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onProviderJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: '质量',
      parameters: { duration: 5, quality: 'high' },
      code: 'UNSUPPORTED_PROVIDER_PARAMETER',
    },
    {
      label: '参数冲突',
      parameters: { duration: 5, seconds: 6 },
      code: 'INVALID_PROVIDER_PARAMETER',
    },
    { label: '缺少时长', parameters: {}, code: 'INVALID_PROVIDER_PARAMETER' },
    { label: '小数时长', parameters: { duration: 5.5 }, code: 'INVALID_PROVIDER_PARAMETER' },
    { label: '自动时长', parameters: { duration: -1 }, code: 'INVALID_PROVIDER_PARAMETER' },
    {
      label: '非法分辨率',
      parameters: { duration: 5, resolution: '2k' },
      code: 'INVALID_PROVIDER_PARAMETER',
    },
  ])('$label 在持久化提交前拒绝，原参数保持可恢复', async ({ parameters, code }) => {
    const snapshot = snapshotFor();
    snapshot.parameters = parameters;
    const before = structuredClone(snapshot);
    const fetchImpl = vi.fn<typeof fetch>();
    const onProviderJob = vi.fn();
    const onRequestPrompt = vi.fn();
    await expect(
      providerFor(fetchImpl).execute({ snapshot, onProviderJob, onRequestPrompt }),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
    expect(onRequestPrompt).not.toHaveBeenCalled();
    expect(snapshot).toEqual(before);
  });

  it('第十张图在 POST 前失败，不静默截断参考素材', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = Array.from({ length: 10 }, (_, index) =>
      inputFor(`image-${index}`, 'referenceImage', index),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.inputs).toHaveLength(10);
  });

  it.each(['video', 'audio'] as const)(
    '冻结 %s 单段或累计时长非法时，零 POST 且不进入 submitting',
    async (mediaType) => {
      for (const durations of [[1.99], [15.01], [8, 8]]) {
        const snapshot = snapshotFor();
        snapshot.nodes[0]!.data.videoMode = 'omni_reference';
        snapshot.inputs = [
          inputFor('image'),
          ...durations.map((sourceDurationSeconds, index) => ({
            ...inputFor(
              `media-${index}`,
              mediaType === 'video' ? 'content' : 'audioTrack',
              index + 1,
              mediaType,
            ),
            sourceDurationSeconds,
          })),
        ];
        const before = structuredClone(snapshot);
        const fetchImpl = vi.fn<typeof fetch>();
        const onProviderJob = vi.fn();
        const onRequestPrompt = vi.fn();
        await expect(
          providerFor(fetchImpl).execute({ snapshot, onProviderJob, onRequestPrompt }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT_COMBINATION', retryable: false });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(onProviderJob).not.toHaveBeenCalled();
        expect(onRequestPrompt).not.toHaveBeenCalled();
        expect(snapshot).toEqual(before);
      }
    },
  );

  it.each([[2], [15], [2, 13], [7.5, 7.5]].map((durations) => ({ durations })))(
    '音视频各自合法时长 $durations 使用原生 content，不发送时长元数据',
    async ({ durations }) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = 'omni_reference';
      snapshot.inputs = [
        inputFor('image'),
        ...(['video', 'audio'] as const).flatMap((mediaType) =>
          durations.map((sourceDurationSeconds, index) => ({
            ...inputFor(
              `${mediaType}-${index}`,
              mediaType === 'video' ? 'content' : 'audioTrack',
              index + 1,
              mediaType,
            ),
            sourceDurationSeconds,
          })),
        ),
      ];
      const fetchImpl = completedFetch();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
      for (const part of body.content.filter((part: { type: string }) => part.type !== 'text')) {
        expect(Object.keys(part).sort()).toEqual(['role', 'type', part.type].sort());
      }
      expect(JSON.stringify(body.content)).not.toContain('duration');
    },
  );

  it.each(['first_frame', 'first_last_frame', 'omni_reference'] as const)(
    '%s 使用顶层官方 content 并保留角色、清晰度、开关与冻结素材顺序',
    async (videoMode) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = videoMode;
      snapshot.parameters = {
        duration: 15,
        resolution: '4K',
        ratio: 'adaptive',
        generate_audio: false,
        watermark: false,
        return_last_frame: true,
      };
      snapshot.inputs =
        videoMode === 'omni_reference'
          ? [
              inputFor('image', 'referenceImage', 2),
              inputFor('video', 'content', 0, 'video'),
              inputFor('audio', 'audioTrack', 1, 'audio'),
            ]
          : [
              inputFor('first', 'firstFrame', 0),
              ...(videoMode === 'first_last_frame' ? [inputFor('last', 'lastFrame', 1)] : []),
            ];
      const fetchImpl = completedFetch();
      const records: RequestPromptRecord[] = [];
      await providerFor(fetchImpl).execute({
        snapshot,
        runId: 'run-official-content',
        onProviderJob: vi.fn(),
        onRequestPrompt: (record) => {
          records.push(record);
        },
      });
      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
      const ordered = [...snapshot.inputs].sort((a, b) => a.sortOrder - b.sortOrder);
      expect(body).toEqual({
        model: 'Seedance2.0 0.9r',
        duration: 15,
        resolution: '4k',
        ratio: 'adaptive',
        generate_audio: false,
        watermark: false,
        return_last_frame: true,
        content: [
          { type: 'text', text: 'A camera moves through the room.' },
          ...ordered.map((input) => ({
            type: `${input.snapshot.data.mediaType}_url`,
            [`${input.snapshot.data.mediaType}_url`]: { url: input.snapshot.data.contentUrl },
            role:
              input.role === 'firstFrame'
                ? 'first_frame'
                : input.role === 'lastFrame'
                  ? 'last_frame'
                  : `reference_${input.snapshot.data.mediaType}`,
          })),
        ],
      });
      expect(records[0]!.resources.map((resource) => resource.assetId)).toEqual(
        ordered.map((input) => input.sourceAssetId),
      );
      expect(JSON.stringify(records)).not.toContain('https://assets.invalid');
    },
  );

  it('图音频 Data URL 保留可用，视频 Data URL 在 POST 前明确拒绝', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = [inputFor('image'), inputFor('audio', 'audioTrack', 1, 'audio')];
    for (const input of snapshot.inputs)
      input.snapshot.data.contentUrl = `data:${input.snapshot.data.mimeType};base64,${Buffer.from(input.nodeId).toString('base64')}`;
    const fetchImpl = completedFetch();
    await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).content[2].audio_url.url).toBe(
      snapshot.inputs[1]!.snapshot.data.contentUrl,
    );
    const video = inputFor('video', 'content', 2, 'video');
    video.snapshot.data.contentUrl = 'data:video/mp4;base64,AQID';
    snapshot.inputs.push(video);
    const rejectedFetch = vi.fn<typeof fetch>();
    await expect(
      providerFor(rejectedFetch).execute({ snapshot, onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({ code: 'VIDEO_REFERENCE_PUBLIC_URL_REQUIRED' });
    expect(rejectedFetch).not.toHaveBeenCalled();
  });

  it('视觉参考允许空提示词，记录实际空文本而不把节点标签发给上游', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.prompt = '';
    snapshot.nodes[0]!.data.videoMode = 'first_frame';
    snapshot.inputs = [inputFor('first', 'firstFrame')];
    const fetchImpl = completedFetch();
    await providerFor(fetchImpl).execute({
      snapshot,
      runId: 'run-empty-visual-prompt',
      onProviderJob: vi.fn(),
      onRequestPrompt: vi.fn(),
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).content).toEqual([
      {
        type: 'image_url',
        image_url: { url: snapshot.inputs[0]!.snapshot.data.contentUrl },
        role: 'first_frame',
      },
    ]);
  });

  it.each(['node', 'parameter', 'connected'] as const)(
    '%s 提示词不能以尾随标记覆盖显式参数',
    async (source) => {
      const snapshot = snapshotFor();
      const prompt = 'A scene --duration 15';
      if (source === 'parameter') snapshot.parameters.prompt = prompt;
      else if (source === 'node') snapshot.nodes[0]!.data.prompt = prompt;
      else {
        snapshot.nodes[0]!.data.prompt = undefined;
        const input = inputFor('connected', 'prompt', 0, 'text');
        input.snapshot.data.mimeType = 'text/plain';
        input.snapshot.data.contentUrl = `data:text/plain;base64,${Buffer.from(prompt).toString('base64')}`;
        snapshot.inputs = [input];
      }
      const fetchImpl = vi.fn<typeof fetch>();
      const onProviderJob = vi.fn();
      await expect(
        providerFor(fetchImpl).execute({ snapshot, onProviderJob }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onProviderJob).not.toHaveBeenCalled();
    },
  );

  it.each(['audio/ogg', 'audio/aac'])('拒绝官方未支持的音频 Data URL：%s', async (mimeType) => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    const audio = inputFor('audio', 'audioTrack', 1, 'audio');
    audio.snapshot.data.mimeType = mimeType;
    audio.snapshot.data.contentUrl = `data:${mimeType};base64,AQID`;
    snapshot.inputs = [inputFor('image'), audio];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { mediaType: 'audio', mimeType: 'audio/aac' },
    { mediaType: 'video', mimeType: 'video/webm' },
  ] as const)(
    '公网引用也拒绝官方未支持的 $mimeType，零 POST 且不进入 submitting',
    async ({ mediaType, mimeType }) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = 'omni_reference';
      const media = inputFor(
        'unsupported-format',
        mediaType === 'audio' ? 'audioTrack' : 'content',
        1,
        mediaType,
      );
      media.snapshot.data.mimeType = mimeType;
      snapshot.inputs = [inputFor('image'), media];
      const before = structuredClone(snapshot);
      const fetchImpl = vi.fn<typeof fetch>();
      const onProviderJob = vi.fn();
      const onRequestPrompt = vi.fn();
      await expect(
        providerFor(fetchImpl).execute({ snapshot, onProviderJob, onRequestPrompt }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onProviderJob).not.toHaveBeenCalled();
      expect(onRequestPrompt).not.toHaveBeenCalled();
      expect(snapshot).toEqual(before);
    },
  );

  it.each([
    { mediaType: 'audio', mimeType: 'audio/wav' },
    { mediaType: 'video', mimeType: 'video/quicktime' },
  ] as const)('官方 $mimeType 公网引用保留 URL 与角色', async ({ mediaType, mimeType }) => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    const media = inputFor(
      'supported-format',
      mediaType === 'audio' ? 'audioTrack' : 'content',
      1,
      mediaType,
    );
    media.snapshot.data.mimeType = mimeType;
    snapshot.inputs = [inputFor('image'), media];
    const fetchImpl = completedFetch();
    await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.content).toContainEqual({
      type: `${mediaType}_url`,
      [`${mediaType}_url`]: { url: media.snapshot.data.contentUrl },
      role: `reference_${mediaType}`,
    });
  });

  it('拒绝插件未接受的 SVG 数据 URL', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    const image = inputFor('svg');
    image.snapshot.data.mimeType = 'image/svg+xml';
    image.snapshot.data.contentUrl = `data:image/svg+xml;base64,${Buffer.from('<svg />').toString('base64')}`;
    snapshot.inputs = [image];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() }),
    ).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['Seedance2.0 0.9r', '无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'])(
    '%s 已有公共任务只按冻结合同 GET，退役或历史参数不触发重新提交',
    async (modelAlias) => {
      const snapshot = snapshotFor(modelAlias);
      snapshot.parameters = { resolution: '720p' };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          id: 'task-frozen-image2pro',
          status: 'completed',
          url: 'https://media.invalid/resumed.mp4',
        }),
      );
      const result = await providerFor(fetchImpl, 'legacy-v1').execute({
        snapshot,
        resumeOnly: true,
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-frozen-image2pro',
          payload: { contract: 'newapi-video-v1' },
        },
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        'https://newapi.invalid/v1/videos/task-frozen-image2pro',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.output).toMatchObject({
        kind: 'url',
        url: 'https://media.invalid/resumed.mp4',
      });
    },
  );

  it('创建缺少宿主公共 id 时保留未知提交状态，不把 request_id 或上游 task_id 用于查询', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        task_id: '0123456789abcdef',
        request_id: 'correlation-only',
        status: 'queued',
      }),
    );
    const provider = providerFor(fetchImpl);
    const snapshot = snapshotFor();
    let frozenJob: ProviderJobUpdate | undefined;
    const onProviderJob = (job: ProviderJobUpdate) => {
      frozenJob = job;
    };
    await expect(provider.execute({ snapshot, onProviderJob })).rejects.toMatchObject({
      code: 'VIDEO_REQUEST_ID_MISSING',
      retryable: false,
    });
    expect(frozenJob).toMatchObject({ payload: { phase: 'submitting' } });
    await expect(
      provider.execute({ snapshot, onProviderJob, providerJob: frozenJob }),
    ).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(
    ['Seedance2.0 0.9r', '无限制-Flash-中配-Video', '无限制-Flash-MAX-Video'].flatMap(
      (modelAlias) => [undefined, 'different-task'].map((id) => ({ modelAlias, id })),
    ),
  )('$modelAlias 查询公共 ID 为 $id 时拒绝下载或归档其他结果', async ({ modelAlias, id }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        id,
        task_id: 'task-frozen-image2pro',
        status: 'completed',
        url: 'https://media.invalid/wrong.mp4',
      }),
    );
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: snapshotFor(modelAlias),
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-frozen-image2pro',
          payload: { contract: 'newapi-video-v1' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_TASK_ID_MISMATCH', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]!.method).toBe('GET');
  });

  it('完成响应的同源制品地址仍走有界鉴权下载并交出可归档内容', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'task-frozen-image2pro',
          status: 'completed',
          url: 'https://newapi.invalid/v1/videos/task-frozen-image2pro/content',
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }),
      );
    const result = await providerFor(fetchImpl).execute({
      snapshot: snapshotFor(),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task-frozen-image2pro',
        payload: { contract: 'newapi-video-v1' },
      },
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://newapi.invalid/v1/videos/task-frozen-image2pro', 'GET'],
      ['https://newapi.invalid/v1/videos/task-frozen-image2pro/content', 'GET'],
    ]);
    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({
      authorization: 'Bearer synthetic-key',
    });
    expect(result.output).toEqual({
      mediaType: 'video',
      kind: 'base64',
      base64: 'AAECAw==',
      mimeType: 'video/mp4',
      format: 'mp4',
    });
  });

  it('创建响应丢失保留 submitting 状态，再执行也不得第二次 POST', async () => {
    const snapshot = snapshotFor();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
    let frozenJob: ProviderJobUpdate | undefined;
    const onProviderJob = (job: ProviderJobUpdate) => {
      frozenJob = job;
    };
    const provider = providerFor(fetchImpl);
    await expect(provider.execute({ snapshot, onProviderJob })).rejects.toMatchObject({
      code: 'VIDEO_SUBMISSION_UNKNOWN',
      retryable: false,
    });
    expect(frozenJob).toMatchObject({
      payload: { contract: 'newapi-video-v1', phase: 'submitting' },
    });
    await expect(
      provider.execute({ snapshot, onProviderJob, providerJob: frozenJob }),
    ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

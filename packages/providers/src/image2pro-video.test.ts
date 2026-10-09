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
const models = ['Seedance2.0 0.9r', '无限制-Flash-MAX-Video'];

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

  it.each(models)('%s 冻结提及与请求记录保持同一资源顺序和版本', async (modelAlias) => {
    const snapshot = snapshotFor(modelAlias);
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
      model: modelAlias,
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

  it.each(['video', 'audio'] as const)(
    '冻结 %s 单段或累计时长交给上游判断，不在本地阻断',
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
        const fetchImpl = completedFetch();
        const onProviderJob = vi.fn();
        const onRequestPrompt = vi.fn();
        await providerFor(fetchImpl).execute({
          snapshot,
          onProviderJob,
          onRequestPrompt,
          runId: `run-invalid-${mediaType}`,
        });
        expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(onProviderJob).toHaveBeenCalled();
        expect(onRequestPrompt).toHaveBeenCalledOnce();
        const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
        expect(body.content.slice(1).map((part: { role: string }) => part.role)).toEqual([
          'reference_image',
          ...durations.map(() => `reference_${mediaType}`),
        ]);
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
    '%s 提示词正文保留尾随标记并交给上游解释',
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
      const fetchImpl = completedFetch();
      const onProviderJob = vi.fn();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob });
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).content[0]).toEqual({
        type: 'text',
        text: prompt,
      });
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

  it.each(models)('%s 创建缺少公共 id 时保留未知提交状态，不误用私有身份', async (modelAlias) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        task_id: '0123456789abcdef',
        request_id: 'correlation-only',
        status: 'queued',
      }),
    );
    const provider = providerFor(fetchImpl);
    const snapshot = snapshotFor(modelAlias);
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
    const execution = providerFor(fetchImpl).execute({
      snapshot: snapshotFor(modelAlias),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task-frozen-image2pro',
        payload: { contract: 'newapi-video-v1' },
      },
    });
    if (modelAlias === '无限制-Flash-中配-Video' && id === undefined) {
      await expect(execution).resolves.toMatchObject({
        output: { kind: 'url', url: 'https://media.invalid/wrong.mp4' },
      });
    } else {
      await expect(execution).rejects.toMatchObject({
        code: 'VIDEO_TASK_ID_MISMATCH',
        retryable: false,
      });
    }
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

  it.each(models)('%s 创建响应丢失保留 submitting 状态，不重复 POST', async (modelAlias) => {
    const snapshot = snapshotFor(modelAlias);
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

describe('Image2Pro Flash-MAX H3 序列化', () => {
  const modelAlias = '无限制-Flash-MAX-Video';

  it.each([false, true])(
    'H3 空白节点或文档由已水合 prompt 连线提供正文：document=%s',
    async (document) => {
      const snapshot = snapshotFor(modelAlias);
      snapshot.nodes[0]!.data.prompt = '';
      if (document)
        snapshot.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: ' ' }],
        };
      const prompt = 'Use the frozen connected text.';
      const input = inputFor('text', 'prompt', 0, 'text', 1);
      input.snapshot.data.mimeType = 'text/plain';
      input.snapshot.data.contentUrl = `data:text/plain;base64,${Buffer.from(prompt).toString('base64')}`;
      snapshot.inputs = [input];
      const fetchImpl = completedFetch();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).content).toEqual([
        { type: 'text', text: prompt },
      ]);
    },
  );

  it.each(['document', 'connected'] as const)(
    'H3 %s 实际文字覆盖旧参数后发送原文，不误用节点标签或 Seedance 命令语法',
    async (source) => {
      const snapshot = snapshotFor(modelAlias);
      const prompt = 'Write --duration 15 on the sign.';
      snapshot.parameters = { duration: 5, prompt: 'old'.repeat(3000) };
      if (source === 'document')
        snapshot.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: prompt }],
        };
      else {
        const text = inputFor('text', 'content', 0, 'text', 2);
        text.snapshot.data.mimeType = 'text/plain';
        text.snapshot.data.contentUrl = `data:text/plain;base64,${Buffer.from(prompt).toString('base64')}`;
        snapshot.inputs = [text];
      }
      const fetchImpl = completedFetch();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).content).toEqual([
        { type: 'text', text: prompt },
      ]);
      expect(snapshot.parameters.prompt).toBe('old'.repeat(3000));
    },
  );

  it.each(['first_frame', 'first_last_frame', 'omni_reference'] as const)(
    '%s 使用 H3 角色与默认 adaptive，保留冻结素材次序和版本',
    async (videoMode) => {
      const snapshot = snapshotFor(modelAlias);
      snapshot.parameters = { duration: 12, resolution: '720p' };
      snapshot.nodes[0]!.data.videoMode = videoMode;
      snapshot.inputs =
        videoMode === 'first_frame'
          ? [inputFor('first', 'firstFrame', 0, 'image', 2)]
          : videoMode === 'first_last_frame'
            ? [
                inputFor('first', 'firstFrame', 0, 'image', 2),
                inputFor('last', 'lastFrame', 1, 'image', 3),
              ]
            : [
                { ...inputFor('audio', 'audioTrack', 3, 'audio', 2), sourceDurationSeconds: 15 },
                inputFor('image', 'style', 1, 'image', 3),
                { ...inputFor('video', 'content', 2, 'video', 4), sourceDurationSeconds: 15 },
              ];
      const before = structuredClone(snapshot);
      const fetchImpl = completedFetch();
      const records: RequestPromptRecord[] = [];
      await providerFor(fetchImpl).execute({
        snapshot,
        runId: `flash-h3-${videoMode}`,
        onProviderJob: vi.fn(),
        onRequestPrompt: (record) => {
          records.push(record);
        },
      });
      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
      expect(body).toMatchObject({
        model: modelAlias,
        duration: 12,
        resolution: '720p',
        ratio: 'adaptive',
      });
      expect(Object.keys(body).sort()).toEqual(
        ['model', 'content', 'duration', 'resolution', 'ratio'].sort(),
      );
      const ordered = [...snapshot.inputs].sort((left, right) => left.sortOrder - right.sortOrder);
      expect(body.content.slice(1)).toEqual(
        ordered.map((input) => {
          const mediaType = input.snapshot.data.mediaType;
          return {
            type: `${mediaType}_url`,
            [`${mediaType}_url`]: { url: input.snapshot.data.contentUrl },
            role:
              input.role === 'firstFrame'
                ? 'first_frame'
                : input.role === 'lastFrame'
                  ? 'last_frame'
                  : `reference_${mediaType}`,
          };
        }),
      );
      expect(
        records[0]!.resources.map(({ assetId, assetVersion }) => [assetId, assetVersion]),
      ).toEqual(ordered.map((input) => [input.sourceAssetId, input.sourceAssetVersion]));
      expect(snapshot).toEqual(before);
    },
  );

  it.each(['audio', 'video'] as const)(
    '支持 H3 纯 %s 参考的内联数据，不借用 Seedance 限制',
    async (mediaType) => {
      const snapshot = snapshotFor(modelAlias);
      snapshot.parameters = { duration: 4 };
      snapshot.nodes[0]!.data.videoMode = 'omni_reference';
      const media = inputFor(
        'inline',
        mediaType === 'audio' ? 'audioTrack' : 'content',
        0,
        mediaType,
        2,
      );
      media.snapshot.data.contentUrl = `data:${media.snapshot.data.mimeType};base64,AQID`;
      media.sourceDurationSeconds = 2;
      snapshot.inputs = [media];
      const fetchImpl = completedFetch();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({
        model: modelAlias,
        duration: 4,
        resolution: '720p',
        ratio: 'adaptive',
        content: [{ type: 'text' }, { type: `${mediaType}_url`, role: `reference_${mediaType}` }],
      });
    },
  );
});

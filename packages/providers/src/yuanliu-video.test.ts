import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  yuanliuVideoContractForModel,
  yuanliuVideoModelAliases,
  type MediaType,
  type PortRole,
  type RequestPromptRecord,
  type RunInputSnapshot,
  type RunSnapshot,
  type VideoMode,
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

/** 构造合成冻结快照，采用精确型号可用时长，不读取用户画布或凭据。 */
function snapshotFor(modelAlias = 'Yuan-Seedance-2.5-LJ-Full'): RunSnapshot {
  return {
    projectId: 'yuanliu-contract',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias,
    submittedAt: '2026-10-08T00:00:00.000Z',
    parameters: { duration: yuanliuVideoContractForModel(modelAlias)?.duration.min ?? 5 },
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

/** 构造冻结资源版本，invalid 域名仅交给注入 fetch 观察。 */
function inputFor(
  assetId: string,
  role: PortRole = 'referenceImage',
  sortOrder = 0,
  mediaType: MediaType = 'image',
  assetVersion = 1,
): RunInputSnapshot {
  const mimeType =
    mediaType === 'image'
      ? 'image/png'
      : mediaType === 'video'
        ? 'video/mp4'
        : mediaType === 'audio'
          ? 'audio/mpeg'
          : 'text/plain';
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
        mimeType,
        contentUrl: `https://assets.invalid/${assetId}-v${assetVersion}`,
      },
    },
  };
}

/** 模拟 New API JSON 信封，全部任务与关联身份均为合成值。 */
function jsonResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

/** 注入 Mock transport，关闭轮询等待，不调用真实供应商。 */
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

/** 公共平台 ID 与上游私有 task_id 故意不同，成片 URL 交给 Worker 归档。 */
function completedFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'task-public-yuanliu',
        task_id: 'private-upstream-task',
        request_id: 'correlation-only',
        object: 'video',
        status: 'queued',
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'task-public-yuanliu',
        task_id: 'private-upstream-task',
        status: 'in_progress',
        progress: 50,
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        id: 'task-public-yuanliu',
        status: 'completed',
        url: 'https://media.invalid/generated.mp4',
      }),
    );
}

describe('源流视频插件创建与普通参考合同', () => {
  it.each(
    yuanliuVideoModelAliases.flatMap((alias) => [
      alias,
      yuanliuVideoContractForModel(alias)!.upstreamModel,
    ]),
  )('%s 使用精确型号参数创建，按公共 id 查询', async (modelAlias) => {
    const snapshot = snapshotFor(modelAlias);
    const contract = yuanliuVideoContractForModel(modelAlias)!;
    snapshot.parameters = { seconds: String(contract.duration.max), aspectRatio: '9:16' };
    const before = structuredClone(snapshot);
    const fetchImpl = completedFetch();
    const onProviderJob = vi.fn();
    const result = await providerFor(fetchImpl).execute({ snapshot, onProviderJob });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({
      model: modelAlias,
      prompt: 'A camera moves through the room.',
      duration: contract.duration.max,
      resolution: '720p',
      aspect_ratio: '9:16',
      metadata: { content: [{ type: 'text', text: 'A camera moves through the room.' }] },
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://newapi.invalid/v1/videos', 'POST'],
      ['https://newapi.invalid/v1/videos/task-public-yuanliu', 'GET'],
      ['https://newapi.invalid/v1/videos/task-public-yuanliu', 'GET'],
    ]);
    expect(result.output).toMatchObject({
      kind: 'url',
      url: 'https://media.invalid/generated.mp4',
    });
    expect(result.providerJob).toMatchObject({
      platformJobId: 'task-public-yuanliu',
      status: 'succeeded',
      payload: { contract: 'newapi-video-v1', phase: 'completed', modelAlias },
    });
    expect(onProviderJob.mock.calls[0]![0]).toMatchObject({
      payload: { contract: 'newapi-video-v1', phase: 'submitting' },
    });
    expect(snapshot).toEqual(before);
  });

  it.each([
    { mode: 'first_frame', role: 'firstFrame', mediaType: 'image' },
    { mode: 'first_last_frame', role: 'lastFrame', mediaType: 'image' },
    { mode: 'video_edit', role: 'content', mediaType: 'video' },
    { mode: 'video_extend', role: 'content', mediaType: 'video' },
    { mode: undefined, role: 'firstFrame', mediaType: 'image' },
    { mode: undefined, role: 'lastFrame', mediaType: 'image' },
    { mode: 'omni_reference', role: 'negativePrompt', mediaType: 'text' },
    { mode: 'text_to_video', role: 'referenceImage', mediaType: 'image' },
    { mode: undefined, role: 'referenceImage', mediaType: 'video' },
  ] satisfies { mode: VideoMode | undefined; role: PortRole; mediaType: MediaType }[])(
    '$mode / $role / $mediaType 由 Provider 序列化后交给上游判断',
    async ({ mode, role, mediaType }) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = mode;
      snapshot.inputs = [inputFor('unsupported', role, 0, mediaType)];
      const fetchImpl = completedFetch();
      const onProviderJob = vi.fn();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob });
      expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(onProviderJob).toHaveBeenCalled();
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({
        model: snapshot.modelAlias,
        prompt: 'A camera moves through the room.',
      });
    },
  );

  it('资源条顺序、显式重复素材和不同角色进入相同脱敏记录', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = [
      inputFor('image', 'style', 2, 'image', 3),
      inputFor('video', 'content', 3, 'video', 2),
      inputFor('audio', 'audioTrack', 1, 'audio', 4),
      inputFor('image', 'referenceImage', 4, 'image', 3),
      inputFor('image', 'referenceImage', 5, 'image', 3),
    ];
    snapshot.nodes[0]!.data.resourceRefs = [
      snapshot.inputs[2]!,
      snapshot.inputs[1]!,
      snapshot.inputs[0]!,
    ].map((input) => ({
      id: `ordered:${input.sourceAssetId}@${input.sourceAssetVersion}`,
      assetId: input.sourceAssetId!,
      assetVersion: input.sourceAssetVersion!,
      mediaType: input.snapshot.data.mediaType,
      name: input.nodeId,
    }));
    const before = structuredClone(snapshot);
    const fetchImpl = completedFetch();
    const records: RequestPromptRecord[] = [];
    await providerFor(fetchImpl).execute({
      snapshot,
      runId: 'ordered-references',
      onProviderJob: vi.fn(),
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    const ordered = [
      snapshot.inputs[2]!,
      snapshot.inputs[1]!,
      snapshot.inputs[0]!,
      snapshot.inputs[3]!,
      snapshot.inputs[4]!,
    ];
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.metadata.content.slice(1)).toEqual(
      ordered.map(({ snapshot: input }) => ({
        type: `${input.data.mediaType}_url`,
        role: `reference_${input.data.mediaType}`,
        [`${input.data.mediaType}_url`]: { url: input.data.contentUrl },
      })),
    );
    expect(
      records[0]!.resources.map(({ assetId, assetVersion, role, sortOrder }) => [
        assetId,
        assetVersion,
        role,
        sortOrder,
      ]),
    ).toEqual(
      ordered.map((input, index) => [
        input.sourceAssetId,
        input.sourceAssetVersion,
        input.role,
        index,
      ]),
    );
    expect(records[0]!.parts[0]!.text).toBe(body.prompt);
    expect(JSON.stringify(records)).not.toContain('https://assets.invalid');

    expect(snapshot).toEqual(before);
  });

  it('无模式旧 content 图音输入仍为普通参考，40 项边界不静默截断', async () => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = undefined;
    snapshot.inputs = [inputFor('image', 'content', 1), inputFor('audio', 'content', 0, 'audio')];
    const accepted = completedFetch();
    await providerFor(accepted).execute({ snapshot, onProviderJob: vi.fn() });
    expect(JSON.parse(String(accepted.mock.calls[0]![1]!.body)).metadata.content.slice(1)).toEqual([
      {
        type: 'audio_url',
        role: 'reference_audio',
        audio_url: { url: snapshot.inputs[1]!.snapshot.data.contentUrl },
      },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: snapshot.inputs[0]!.snapshot.data.contentUrl },
      },
    ]);
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = [
      ...Array.from({ length: 30 }, (_, index) => inputFor('same', 'referenceImage', index)),
      ...Array.from({ length: 10 }, (_, index) =>
        inputFor('audio', 'audioTrack', 30 + index, 'audio'),
      ),
    ];
    const maximum = completedFetch();
    await providerFor(maximum).execute({ snapshot, onProviderJob: vi.fn() });
    expect(JSON.parse(String(maximum.mock.calls[0]![1]!.body)).metadata.content).toHaveLength(41);
    snapshot.inputs.push(inputFor('video', 'content', 40, 'video'));
    const expanded = completedFetch();
    const onProviderJob = vi.fn();
    await providerFor(expanded).execute({ snapshot, onProviderJob });
    expect(expanded.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(String(expanded.mock.calls[0]![1]!.body)).metadata.content).toHaveLength(42);
    expect(onProviderJob).toHaveBeenCalled();
    expect(snapshot.inputs).toHaveLength(41);
  });

  it.each(['http', 'https'])('%s 参考保留签名 URL 原文，不能改成内联', async (scheme) => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = [inputFor('image')];
    const url = `${scheme}://Assets.invalid/a%2Bb.png?sig=a%2Fb%2B&expires=123`;
    snapshot.inputs[0]!.snapshot.data.contentUrl = url;
    const fetchImpl = completedFetch();
    await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
    expect(
      JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).metadata.content[1].image_url.url,
    ).toBe(url);
  });

  it.each([
    'data:image/png;base64,AQID',
    'file:///tmp/image.png',
    '/v1/assets/image/versions/1/content',
    ' https://assets.invalid/image.png',
    'https://assets.invalid/image.png ',
    'https://assets.invalid/image.png#fragment',
    'https://user:password@assets.invalid/image.png',
    'https://@assets.invalid/image.png',
    'https://assets.invalid\\image.png',
    'https://assets.invalid/image\u0000.png',
    'https://assets.invalid/image\u007f.png',
    'https://assets.invalid/image\n.png',
  ])('非合同参考 URL %# 在 POST、记录和 submitting 前拒绝', async (url) => {
    const snapshot = snapshotFor();
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.inputs = [inputFor('image')];
    snapshot.inputs[0]!.snapshot.data.contentUrl = url;
    const fetchImpl = vi.fn<typeof fetch>();
    const onProviderJob = vi.fn();
    const onRequestPrompt = vi.fn();
    await expect(
      providerFor(fetchImpl).execute({ snapshot, onProviderJob, onRequestPrompt }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
    expect(onRequestPrompt).not.toHaveBeenCalled();
  });

  it.each(['audio', 'video'] as const)(
    '%s 同样拒绝 Base64，不能绕过 URL 约束',
    async (mediaType) => {
      const snapshot = snapshotFor();
      snapshot.nodes[0]!.data.videoMode = 'omni_reference';
      snapshot.inputs = [
        inputFor('inline', mediaType === 'audio' ? 'audioTrack' : 'content', 0, mediaType),
      ];
      snapshot.inputs[0]!.snapshot.data.contentUrl = `data:${snapshot.inputs[0]!.snapshot.data.mimeType};base64,AQID`;
      const fetchImpl = vi.fn<typeof fetch>();
      const onProviderJob = vi.fn();
      await expect(
        providerFor(fetchImpl).execute({ snapshot, onProviderJob }),
      ).rejects.toMatchObject({ code: 'VIDEO_REFERENCE_PUBLIC_URL_REQUIRED', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onProviderJob).not.toHaveBeenCalled();
    },
  );

  it.each(['document', 'content', 'prompt'] as const)(
    '使用实际 %s 文字，不套用标签或 Seedance 命令解析',
    async (source) => {
      const snapshot = snapshotFor();
      const prompt = 'Write --duration 15 on the sign.';
      if (source === 'document') {
        snapshot.parameters.prompt = 'stale'.repeat(4000);
        snapshot.nodes[0]!.data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: prompt }],
        };
      } else {
        snapshot.nodes[0]!.data.prompt = '';
        if (source === 'content') snapshot.parameters.prompt = 'stale'.repeat(4000);
        const text = inputFor('text', source, 0, 'text', 2);
        text.snapshot.data.contentUrl = `data:text/plain;base64,${Buffer.from(prompt).toString('base64')}`;
        snapshot.inputs = [text];
      }
      const fetchImpl = completedFetch();
      await providerFor(fetchImpl).execute({ snapshot, onProviderJob: vi.fn() });
      expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({
        prompt,
        duration: 5,
        metadata: { content: [{ type: 'text', text: prompt }] },
      });
    },
  );

  it('文字 content 覆盖节点正文后保留正文与资源引用，编号解释交给上游', async () => {
    const snapshot = snapshotFor();
    const text = inputFor('text', 'content', 0, 'text');
    text.snapshot.data.contentUrl = `data:text/plain;base64,${Buffer.from('@Image2').toString('base64')}`;
    snapshot.nodes[0]!.data.videoMode = 'omni_reference';
    snapshot.nodes[0]!.data.prompt = '@Image1';
    snapshot.inputs = [text, inputFor('image', 'referenceImage', 1)];
    const fetchImpl = completedFetch();
    const onProviderJob = vi.fn();
    await providerFor(fetchImpl).execute({ snapshot, onProviderJob });
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.prompt).toBe('@Image2');
    expect(body.metadata.content).toEqual([
      { type: 'text', text: '@Image2' },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: snapshot.inputs[1]!.snapshot.data.contentUrl },
      },
    ]);
    expect(onProviderJob).toHaveBeenCalled();
  });

  it('冻结提及按版本去重、按资源条排序，保留 HTTP(S) 原文与脱敏身份', async () => {
    const snapshot = snapshotFor();
    const target = snapshot.nodes[0]!.data;
    target.videoMode = 'text_to_video';
    const mentions = [
      { mentionId: 'scene-v1', assetId: 'scene', assetVersion: 1, mediaType: 'image' as const },
      { mentionId: 'scene-v2', assetId: 'scene', assetVersion: 2, mediaType: 'image' as const },
      {
        mentionId: 'scene-v2-repeat',
        assetId: 'scene',
        assetVersion: 2,
        mediaType: 'image' as const,
      },
      { mentionId: 'audio', assetId: 'audio', assetVersion: 3, mediaType: 'audio' as const },
      { mentionId: 'video', assetId: 'video', assetVersion: 4, mediaType: 'video' as const },
    ].map((mention, blockOrder) => ({
      ...mention,
      nodeId: 'target',
      blockOrder,
      label: `${mention.assetId}@${mention.assetVersion}`,
    }));
    snapshot.promptMentions = mentions;
    target.promptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: 'Use @Image2 @Video1 @Audio1: ' },
        ...mentions.flatMap((mention) => [
          {
            ...mention,
            type: 'mention' as const,
            mimeType: `${mention.mediaType}/${mention.mediaType === 'image' ? 'png' : mention.mediaType === 'audio' ? 'mpeg' : 'mp4'}`,
            contentUrl: `https://Assets.invalid/${mention.assetId}-v${mention.assetVersion}?sig=a%2Fb%2B`,
          },
          { type: 'text' as const, text: ' / ' },
        ]),
      ],
    };
    target.resourceRefs = [mentions[3]!, mentions[1]!, mentions[4]!, mentions[0]!].map(
      (mention) => ({
        id: `ordered:${mention.assetId}@${mention.assetVersion}`,
        assetId: mention.assetId,
        assetVersion: mention.assetVersion,
        mediaType: mention.mediaType,
        name: mention.label,
      }),
    );
    const resolved = resolveProviderMentions(snapshot);
    const fetchImpl = completedFetch();
    const records: RequestPromptRecord[] = [];
    await providerFor(fetchImpl).execute({
      runId: 'run-yuanliu-mentions',
      snapshot,
      resolvedMentions: resolved,
      onProviderJob: vi.fn(),
      onRequestPrompt: (record) => {
        records.push(record);
      },
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    const ordered = [mentions[3]!, mentions[1]!, mentions[4]!, mentions[0]!];
    expect(body.metadata.content.slice(1)).toEqual(
      ordered.map((mention) => ({
        type: `${mention.mediaType}_url`,
        role: `reference_${mention.mediaType}`,
        [`${mention.mediaType}_url`]: {
          url: `https://Assets.invalid/${mention.assetId}-v${mention.assetVersion}?sig=a%2Fb%2B`,
        },
      })),
    );
    expect(
      records[0]!.resources.map(({ assetId, assetVersion }) => [assetId, assetVersion]),
    ).toEqual(ordered.map(({ assetId, assetVersion }) => [assetId, assetVersion]));
    expect(JSON.stringify(records)).not.toContain('sig=');
    const hydrated = target.promptDocument.blocks[1]! as unknown as Record<string, unknown>;
    hydrated.contentUrl = ` ${String(hydrated.contentUrl)}`;
    const rejected = vi.fn<typeof fetch>();
    const onProviderJob = vi.fn();
    await expect(
      providerFor(rejected).execute({
        snapshot,
        resolvedMentions: resolveProviderMentions(snapshot),
        onProviderJob,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(rejected).not.toHaveBeenCalled();
    expect(onProviderJob).not.toHaveBeenCalled();
  });
});

describe('源流公共任务身份与冻结合同恢复', () => {
  it.each(yuanliuVideoModelAliases)(
    '%s 缺少宿主 id 时不误用 task_id/request_id 或重复提交',
    async (modelAlias) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          task_id: 'private-upstream-task',
          request_id: 'correlation-only',
          status: 'queued',
        }),
      );
      const snapshot = snapshotFor(modelAlias);
      const provider = providerFor(fetchImpl);
      let frozenJob: ProviderJobUpdate | undefined;
      const onProviderJob = (job: ProviderJobUpdate) => {
        frozenJob = job;
      };
      await expect(provider.execute({ snapshot, onProviderJob })).rejects.toMatchObject({
        code: 'VIDEO_REQUEST_ID_MISSING',
        retryable: false,
      });
      expect(frozenJob).toMatchObject({
        payload: { phase: 'submitting', contract: 'newapi-video-v1' },
      });
      await expect(
        provider.execute({ snapshot, onProviderJob, providerJob: frozenJob }),
      ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN', retryable: false });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, 'different-task'])('查询宿主 id=%s 时拒绝下载其它任务成片', async (id) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        id,
        task_id: 'task-frozen-yuanliu',
        status: 'completed',
        url: 'https://media.invalid/wrong.mp4',
      }),
    );
    await expect(
      providerFor(fetchImpl).execute({
        snapshot: snapshotFor(),
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-frozen-yuanliu',
          payload: { contract: 'newapi-video-v1' },
        },
      }),
    ).rejects.toMatchObject({ code: 'VIDEO_TASK_ID_MISMATCH', retryable: false });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'https://newapi.invalid/v1/videos/task-frozen-yuanliu',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each(['newapi-video-v1', 'legacy-v1', 'newapi-unified-v1'] as const)(
    '恢复按冻结 %s GET，不重新校验历史参数或素材',
    async (contract) => {
      const snapshot = snapshotFor();
      snapshot.parameters = { duration: -1, quality: 'old-unsupported' };
      snapshot.nodes[0]!.data.prompt = '';
      snapshot.nodes[0]!.data.videoMode = 'video_edit';
      snapshot.inputs = [inputFor('old', 'firstFrame')];
      snapshot.inputs[0]!.snapshot.data.contentUrl = '/v1/assets/old/versions/1/content';
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse({
          id: 'task-frozen-yuanliu',
          task_id: 'task-frozen-yuanliu',
          request_id: 'task-frozen-yuanliu',
          status: 'completed',
          url: 'https://media.invalid/resumed.mp4',
        }),
      );
      const result = await providerFor(fetchImpl, 'newapi-video-v1').execute({
        snapshot,
        resumeOnly: true,
        providerJob: {
          provider: 'newapi',
          platformJobId: 'task-frozen-yuanliu',
          payload: { contract },
        },
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `https://newapi.invalid/v1/${contract === 'newapi-unified-v1' ? 'video/generations' : 'videos'}/task-frozen-yuanliu`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.output).toMatchObject({
        kind: 'url',
        url: 'https://media.invalid/resumed.mp4',
      });
      expect(result.providerJob?.payload).toMatchObject({ contract, phase: 'completed' });
    },
  );

  it('创建响应丢失后保留 submitting，第二次调用不重发 POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('response lost'));
    const provider = providerFor(fetchImpl);
    const snapshot = snapshotFor();
    let frozenJob: ProviderJobUpdate | undefined;
    const onProviderJob = (job: ProviderJobUpdate) => {
      frozenJob = job;
    };
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

  it('同源 content 有界鉴权下载交出字节，外部成片不携带网关密钥', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'task-frozen-yuanliu',
          status: 'completed',
          url: 'https://newapi.invalid/v1/videos/task-frozen-yuanliu/content',
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }),
      );
    const result = await providerFor(fetchImpl).execute({
      snapshot: snapshotFor(),
      providerJob: {
        provider: 'newapi',
        platformJobId: 'task-frozen-yuanliu',
        payload: { contract: 'newapi-video-v1' },
      },
    });
    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://newapi.invalid/v1/videos/task-frozen-yuanliu', 'GET'],
      ['https://newapi.invalid/v1/videos/task-frozen-yuanliu/content', 'GET'],
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
});

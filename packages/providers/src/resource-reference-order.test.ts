import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MediaType,
  NodeResourceRef,
  PortRole,
  RequestPromptRecord,
  RunInputSnapshot,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import {
  describeVideoInputMedia,
  NewApiProvider,
  NewApiVideoProvider,
  resolveProviderMentions,
  type NewApiVideoContract,
} from './index';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('本测试禁止真实网络请求')));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** 构造显式排序项；名称和引用 ID 仅用于显示，不能充当资产版本身份。 */
function reference(
  assetId: string,
  assetVersion?: number,
  mediaType: MediaType = 'image',
): NodeResourceRef {
  return {
    id: `ordered:ref-${assetId}-${assetVersion}`,
    assetId,
    assetVersion,
    mediaType,
    name: '参考',
  };
}

/** 生成可辨认版本的内存图片或占位媒体地址；地址不会被下载。 */
function contentUrl(assetId: string, assetVersion: number | undefined, mediaType: MediaType) {
  return mediaType === 'image'
    ? `data:image/png;base64,${Buffer.from(`${assetId}@${assetVersion ?? 'unfrozen'}`).toString('base64')}`
    : `https://assets.invalid/${assetId}-v${assetVersion}.${mediaType === 'video' ? 'mp4' : 'mp3'}`;
}

/** 构造一条独立冻结连线；缺省版本表示旧输入未冻结，不从资源条回填。 */
function linkedInput(
  assetId: string,
  assetVersion: number | undefined,
  sortOrder: number,
  role: PortRole = 'referenceImage',
  mediaType: MediaType = 'image',
): RunInputSnapshot {
  const nodeId = `linked-${assetId}-${assetVersion}-${role}`;
  return {
    nodeId,
    role,
    sortOrder,
    sourceAssetId: assetId,
    sourceAssetVersion: assetVersion,
    snapshot: {
      id: nodeId,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: assetId,
        mediaType,
        mode: 'source',
        assetId,
        mimeType:
          mediaType === 'image' ? 'image/png' : mediaType === 'video' ? 'video/mp4' : 'audio/mpeg',
        contentUrl: contentUrl(assetId, assetVersion, mediaType),
      },
    },
  };
}

/** 构造仅供 Provider 映射的单节点快照，不读项目、目录或运行中的服务。 */
function snapshotFor(mediaType: 'image' | 'video'): RunSnapshot {
  return {
    projectId: 'reference-order-project',
    targetNodeId: 'target',
    canvasRevision: 1,
    submittedAt: '2026-10-03T00:00:00.000Z',
    modelAlias: mediaType === 'image' ? 'gpt-image-1' : 'grok-imagine-video-1.5.1',
    parameters: {},
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: 'Target',
          mode: 'generate',
          mediaType,
          prompt: 'Keep the scene.',
          ...(mediaType === 'video' ? { videoMode: 'omni_reference' as const } : {}),
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

/** 按正文顺序注入冻结提及及水合内容；重复资产仍有独立 mentionId/blockOrder。 */
function addMentions(
  snapshot: RunSnapshot,
  sources: readonly { assetId: string; assetVersion: number; mediaType?: MediaType }[],
): void {
  const mentions = sources.map((source, index) => ({
    ...source,
    mediaType: source.mediaType ?? 'image',
    nodeId: snapshot.targetNodeId,
    mentionId: `mention-${index}`,
    label: `${source.assetId}@${source.assetVersion}`,
    blockOrder: 1 + index * 2,
  }));
  snapshot.promptMentions = mentions;
  snapshot.nodes[0]!.data.promptDocument = {
    version: 1,
    blocks: [
      { type: 'text', text: 'Use ' },
      ...mentions.flatMap((mention) => [
        {
          ...mention,
          type: 'mention' as const,
          mimeType:
            mention.mediaType === 'image'
              ? 'image/png'
              : mention.mediaType === 'video'
                ? 'video/mp4'
                : 'audio/mpeg',
          contentUrl: contentUrl(mention.assetId, mention.assetVersion, mention.mediaType),
        },
        { type: 'text' as const, text: ' / ' },
      ]),
    ],
  };
}

/** 用 fetch 替身捕获 multipart 原图和脱敏记录，不进行上传或下载。 */
async function captureImages(snapshot: RunSnapshot) {
  const records: RequestPromptRecord[] = [];
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: 'https://assets.invalid/result.png' }] })),
    );
  await new NewApiProvider({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'test-placeholder',
    fetchImpl,
  }).execute({
    snapshot,
    runId: 'image-reference-order',
    resolvedMentions: resolveProviderMentions(snapshot),
    onRequestPrompt: (record) => {
      records.push(record);
    },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]![0]).toBe('https://provider.invalid/v1/images/edits');
  const form = fetchImpl.mock.calls[0]![1]!.body as FormData;
  const files = [...form.getAll('image'), ...form.getAll('image[]')] as File[];
  return { form, files, record: records[0]! };
}

/** 捕获视频创建体后用替身 503 终止；不会产生网络请求、轮询或付费重试。 */
async function captureVideo(
  snapshot: RunSnapshot,
  videoContract: NewApiVideoContract = 'newapi-video-v1',
) {
  const records: RequestPromptRecord[] = [];
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Capture only' } }), { status: 503 }),
    );
  await expect(
    new NewApiVideoProvider({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test-placeholder',
      videoContract,
      fetchImpl,
    }).execute({
      snapshot,
      runId: 'video-reference-order',
      resolvedMentions: resolveProviderMentions(snapshot),
      onProviderJob: vi.fn(),
      onRequestPrompt: (record) => {
        records.push(record);
      },
    }),
  ).rejects.toMatchObject({ code: 'VIDEO_SUBMISSION_UNKNOWN' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  return { body: JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)), record: records[0]! };
}

describe('图片参考资源显式顺序', () => {
  it('在混合连线和提及去重后排序实际图片字节与记录，不改变正文和冻结块顺序', async () => {
    const snapshot = snapshotFor('image');
    snapshot.inputs = [linkedInput('beta', 1, 2), linkedInput('alpha', 1, 1)];
    addMentions(snapshot, [
      { assetId: 'alpha', assetVersion: 1 },
      { assetId: 'alpha', assetVersion: 2 },
      { assetId: 'gamma', assetVersion: 1 },
      { assetId: 'gamma', assetVersion: 1 },
    ]);
    snapshot.nodes[0]!.data.resourceRefs = [
      reference('gamma', 1),
      reference('alpha', 2),
      reference('beta', 1),
    ];
    const before = structuredClone(snapshot);

    const { form, files, record } = await captureImages(snapshot);

    expect(await Promise.all(files.map((file) => file.text()))).toEqual([
      'gamma@1',
      'alpha@2',
      'beta@1',
      'alpha@1',
    ]);
    expect(
      record.resources.map(({ assetId, assetVersion, sortOrder }) => [
        assetId,
        assetVersion,
        sortOrder,
      ]),
    ).toEqual([
      ['gamma', 1, 0],
      ['alpha', 2, 1],
      ['beta', 1, 2],
      ['alpha', 1, 3],
    ]);
    expect(form.get('prompt')).toBe('Use alpha@1 / alpha@2 / gamma@1 / gamma@1 / ');
    expect(record.parts).toEqual([{ order: 0, text: form.get('prompt') }]);
    expect(snapshot).toEqual(before);
  });

  it.each([
    { label: '未设置', refs: undefined },
    { label: '空列表', refs: [] },
    {
      label: '未知身份',
      refs: [reference('missing', 1), reference('alpha', 99), reference('alpha')],
    },
  ])('缺省、空或完全不匹配的显式顺序保持连线优先和正文提及次序：$label', async ({ refs }) => {
    const snapshot = snapshotFor('image');
    snapshot.inputs = [linkedInput('alpha', 1, 4), linkedInput('beta', 1, 1)];
    addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 2 }]);
    snapshot.nodes[0]!.data.resourceRefs = refs;
    const { files } = await captureImages(snapshot);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual([
      'beta@1',
      'alpha@1',
      'alpha@2',
    ]);
  });

  it('重复排序项以首次出现为准，未知版本和未知资产不匹配，未列项稳定追加', async () => {
    const snapshot = snapshotFor('image');
    snapshot.inputs = [
      linkedInput('alpha', 1, 0),
      linkedInput('beta', 1, 0),
      linkedInput('gamma', 1, 0),
      linkedInput('alpha', undefined, 0),
    ];
    snapshot.nodes[0]!.data.resourceRefs = [
      reference('alpha', 99),
      reference('missing', 1),
      reference('gamma', 1),
      reference('beta', 1),
      reference('gamma', 1),
      reference('alpha'),
    ];
    const { files, record } = await captureImages(snapshot);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual([
      'gamma@1',
      'beta@1',
      'alpha@1',
      'alpha@unfrozen',
    ]);
    expect(record.resources[3]).not.toHaveProperty('assetVersion');
  });

  it('只读取目标节点的顺序，不采用来源节点的资源条或名称别名', async () => {
    const snapshot = snapshotFor('image');
    snapshot.inputs = [linkedInput('alpha', 1, 0), linkedInput('beta', 1, 1)];
    const other = structuredClone(snapshot.nodes[0]!);
    other.id = 'other';
    other.data.resourceRefs = [reference('beta', 1), reference('alpha', 1)];
    snapshot.nodes.unshift(other);
    const { files } = await captureImages(snapshot);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['alpha@1', 'beta@1']);
  });

  it('使用实际冻结身份与编辑来源版本，不采用节点展示资产身份', async () => {
    const snapshot = snapshotFor('image');
    const source = linkedInput('alpha', undefined, 1, 'imageEdit');
    source.snapshot.data.assetId = 'display-only';
    source.snapshot.data.contentUrl = contentUrl('alpha', 2, 'image');
    snapshot.inputs = [linkedInput('beta', 1, 0), source];
    snapshot.nodes[0]!.data.imageEditSource = {
      sourceNodeId: source.nodeId,
      assetId: 'alpha',
      version: 2,
    };
    snapshot.nodes[0]!.data.resourceRefs = [reference('display-only', 2), reference('alpha', 2)];
    const { files, record } = await captureImages(snapshot);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['alpha@2', 'beta@1']);
    expect(record.resources.map(({ assetId, assetVersion }) => [assetId, assetVersion])).toEqual([
      ['alpha', 2],
      ['beta', 1],
    ]);
    expect(source.sourceAssetVersion).toBeUndefined();
  });

  it('排序前仍拒绝同一冻结版本的冲突内容，不按资源条选择其中一份', async () => {
    const snapshot = snapshotFor('image');
    snapshot.inputs = [linkedInput('alpha', 1, 0)];
    snapshot.inputs[0]!.snapshot.data.contentUrl = contentUrl('different-content', 1, 'image');
    addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 1 }]);
    snapshot.nodes[0]!.data.resourceRefs = [reference('alpha', 1)];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      new NewApiProvider({
        baseUrl: 'https://provider.invalid/v1',
        apiKey: 'test-placeholder',
        fetchImpl,
      }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) }),
    ).rejects.toMatchObject({
      code: 'INPUT_ROLE_VALUE_MISSING',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['blockOrder', 'resolvedVersion', 'documentVersion'] as const)(
    '显式顺序不绕过冻结身份校验：%s',
    async (invalid) => {
      const snapshot = snapshotFor('image');
      addMentions(snapshot, [
        { assetId: 'alpha', assetVersion: 1 },
        { assetId: 'alpha', assetVersion: 2 },
      ]);
      snapshot.nodes[0]!.data.resourceRefs = [reference('alpha', 2), reference('alpha', 1)];
      const resolved = resolveProviderMentions(snapshot);
      if (invalid === 'blockOrder') snapshot.promptMentions![0]!.blockOrder = 3;
      if (invalid === 'resolvedVersion') resolved[0]!.assetVersion = 2;
      if (invalid === 'documentVersion') {
        const block = snapshot.nodes[0]!.data.promptDocument!.blocks[1]!;
        if (block.type === 'mention') block.assetVersion = 2;
      }
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiProvider({
          baseUrl: 'https://provider.invalid/v1',
          apiKey: 'test-placeholder',
          fetchImpl,
        }).execute({
          snapshot,
          resolvedMentions: resolved,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_MENTION_RESOLUTION_INVALID' });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe('视频参考资源显式顺序', () => {
  it.each(['legacy-v1', 'newapi-video-v1', 'newapi-unified-v1'] as const)(
    '%s 的 reference_images 按资源条排序，混合提及按冻结版本与角色去重',
    async (contract) => {
      const snapshot = snapshotFor('video');
      snapshot.inputs = [linkedInput('beta', 1, 2, 'style'), linkedInput('alpha', 1, 1)];
      addMentions(snapshot, [
        { assetId: 'alpha', assetVersion: 1 },
        { assetId: 'alpha', assetVersion: 2 },
        { assetId: 'alpha', assetVersion: 2 },
      ]);
      snapshot.nodes[0]!.data.resourceRefs = [
        reference('alpha', 2),
        reference('beta', 1),
        reference('alpha', 1),
      ];
      const before = structuredClone(snapshot);
      const { body, record } = await captureVideo(snapshot, contract);
      expect(body.reference_images).toEqual([
        { url: contentUrl('alpha', 2, 'image') },
        { url: contentUrl('beta', 1, 'image') },
        { url: contentUrl('alpha', 1, 'image') },
      ]);
      expect(
        record.resources.map(({ assetId, assetVersion, role }) => [assetId, assetVersion, role]),
      ).toEqual([
        ['alpha', 2, 'referenceImage'],
        ['beta', 1, 'style'],
        ['alpha', 1, 'referenceImage'],
      ]);
      expect(body.prompt).toBe('Use alpha@1 / alpha@2 / alpha@2 / ');
      expect(snapshot).toEqual(before);
    },
  );

  it.each([
    { label: '未设置', refs: undefined },
    { label: '空列表', refs: [] },
    {
      label: '未知身份',
      refs: [reference('missing', 1), reference('alpha', 99), reference('beta')],
    },
  ])('没有匹配排序项时保持视频旧 sortOrder/nodeId 顺序并保留重复角色：$label', async ({ refs }) => {
    const snapshot = snapshotFor('video');
    snapshot.inputs = [linkedInput('beta', 1, 0, 'style'), linkedInput('alpha', 1, 0, 'character')];
    addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 1 }]);
    snapshot.nodes[0]!.data.resourceRefs = refs;
    const { record } = await captureVideo(snapshot);
    expect(record.resources.map(({ assetId, role }) => [assetId, role])).toEqual([
      ['alpha', 'character'],
      ['beta', 'style'],
      ['alpha', 'referenceImage'],
    ]);
  });

  it('同一资产的不同冻结版本独立排序，无版本连线不借用资源条版本', async () => {
    const snapshot = snapshotFor('video');
    snapshot.inputs = [linkedInput('alpha', 1, 0), linkedInput('beta', undefined, 1)];
    addMentions(snapshot, [
      { assetId: 'alpha', assetVersion: 2 },
      { assetId: 'beta', assetVersion: 1 },
    ]);
    snapshot.nodes[0]!.data.resourceRefs = [
      reference('beta', 1),
      reference('alpha', 2),
      reference('alpha'),
    ];
    const { body, record } = await captureVideo(snapshot);
    expect(body.reference_images.map((item: { url: string }) => item.url)).toEqual([
      contentUrl('beta', 1, 'image'),
      contentUrl('alpha', 2, 'image'),
      contentUrl('alpha', 1, 'image'),
      contentUrl('beta', undefined, 'image'),
    ]);
    expect(record.resources.map(({ assetId, assetVersion }) => [assetId, assetVersion])).toEqual([
      ['beta', 1],
      ['alpha', 2],
      ['alpha', 1],
      ['beta', undefined],
    ]);
  });

  it.each(['assetId', 'assetVersion'] as const)(
    '视频显式排序不掩盖提及冻结身份不一致：%s',
    async (field) => {
      const snapshot = snapshotFor('video');
      addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 1 }]);
      snapshot.nodes[0]!.data.resourceRefs = [reference('alpha', 2), reference('alpha', 1)];
      const resolved = resolveProviderMentions(snapshot);
      if (field === 'assetId') resolved[0]!.assetId = 'other';
      else resolved[0]!.assetVersion = 2;
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        new NewApiVideoProvider({
          baseUrl: 'https://provider.invalid/v1',
          apiKey: 'test-placeholder',
          fetchImpl,
        }).execute({ snapshot, resolvedMentions: resolved, onProviderJob: vi.fn() }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_MENTION_RESOLUTION_INVALID',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('官方混合媒体数组、报价类型和请求记录遵循同一顺序，角色不改写', async () => {
    const snapshot = snapshotFor('video');
    snapshot.modelAlias = 'MiniMax-H3';
    snapshot.parameters = { duration: 5, resolution: '768P' };
    snapshot.inputs = [
      linkedInput('alpha', 1, 0, 'character'),
      linkedInput('clip', 1, 1, 'content', 'video'),
      linkedInput('sound', 1, 2, 'audioTrack', 'audio'),
    ];
    addMentions(snapshot, [
      { assetId: 'alpha', assetVersion: 1 },
      { assetId: 'alpha', assetVersion: 2 },
      { assetId: 'clip', assetVersion: 1, mediaType: 'video' },
    ]);
    snapshot.nodes[0]!.data.resourceRefs = [
      reference('sound', 1, 'audio'),
      reference('alpha', 2),
      reference('clip', 1, 'video'),
      reference('alpha', 1),
    ];
    const before = structuredClone(snapshot);
    const { body, record } = await captureVideo(snapshot);
    const expected = [
      {
        type: 'audio_url',
        role: 'reference_audio',
        audio_url: { url: contentUrl('sound', 1, 'audio') },
      },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: contentUrl('alpha', 2, 'image') },
      },
      {
        type: 'video_url',
        role: 'reference_video',
        video_url: { url: contentUrl('clip', 1, 'video') },
      },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: contentUrl('alpha', 1, 'image') },
      },
      {
        type: 'image_url',
        role: 'reference_image',
        image_url: { url: contentUrl('alpha', 1, 'image') },
      },
    ];
    expect(body.metadata.content).toEqual([
      { type: 'text', text: 'Use alpha@1 / alpha@2 / clip@1 / ' },
      ...expected,
    ]);
    expect(
      record.resources.map(({ assetId, assetVersion, role, sortOrder }) => [
        assetId,
        assetVersion,
        role,
        sortOrder,
      ]),
    ).toEqual([
      ['sound', 1, 'audioTrack', 0],
      ['alpha', 2, 'referenceImage', 1],
      ['clip', 1, 'content', 2],
      ['alpha', 1, 'character', 3],
      ['alpha', 1, 'referenceImage', 4],
    ]);
    expect(describeVideoInputMedia(snapshot)).toEqual(
      expected.map((item) => ({ type: item.type.replace('_url', ''), role: item.role })),
    );
    expect(snapshot).toEqual(before);
  });

  it('Wan 视频参考重排时，同版本时长 sidecar 与媒体一一对应', async () => {
    const snapshot = snapshotFor('video');
    snapshot.modelAlias = 'wan3.0-video';
    snapshot.inputs = [
      { ...linkedInput('clip', 1, 0, 'content', 'video'), sourceDurationSeconds: 4.5 },
      linkedInput('alpha', 1, 1),
      { ...linkedInput('clip', 2, 2, 'content', 'video'), sourceDurationSeconds: 7.25 },
    ];
    snapshot.nodes[0]!.data.resourceRefs = [reference('alpha', 1), reference('clip', 2, 'video')];
    const { body, record } = await captureVideo(snapshot);
    expect(body.metadata.input.media).toEqual([
      { type: 'reference_image', url: contentUrl('alpha', 1, 'image') },
      { type: 'reference_video', url: contentUrl('clip', 2, 'video') },
      { type: 'reference_video', url: contentUrl('clip', 1, 'video') },
    ]);
    expect(body.metadata.reference_video_durations).toEqual([7.25, 4.5]);
    expect(record.resources.map(({ assetId, assetVersion }) => [assetId, assetVersion])).toEqual([
      ['alpha', 1],
      ['clip', 2],
      ['clip', 1],
    ]);
  });

  it.each(['grok-imagine-video-1.5.1', 'MiniMax-H3', 'wan3.0-video'])(
    '%s 的首尾帧不受反向资源条顺序影响',
    async (model) => {
      const snapshot = snapshotFor('video');
      snapshot.modelAlias = model;
      snapshot.nodes[0]!.data.videoMode = 'first_last_frame';
      if (model === 'MiniMax-H3') snapshot.parameters = { duration: 5, resolution: '768P' };
      snapshot.inputs = [
        linkedInput('first', 1, 0, 'firstFrame'),
        linkedInput('last', 1, 1, 'lastFrame'),
      ];
      snapshot.nodes[0]!.data.resourceRefs = [reference('last', 1), reference('first', 1)];
      const before = structuredClone(snapshot);
      const { body, record } = await captureVideo(snapshot);
      if (model === 'grok-imagine-video-1.5.1') {
        expect(body.image).toBe(contentUrl('first', 1, 'image'));
        expect(body.last_frame).toBe(contentUrl('last', 1, 'image'));
      } else if (model === 'MiniMax-H3') {
        expect(body.metadata.content.slice(1)).toEqual([
          {
            type: 'image_url',
            role: 'first_frame',
            image_url: { url: contentUrl('first', 1, 'image') },
          },
          {
            type: 'image_url',
            role: 'last_frame',
            image_url: { url: contentUrl('last', 1, 'image') },
          },
        ]);
      } else {
        expect(body.metadata.input.media).toEqual([
          { type: 'first_frame', url: contentUrl('first', 1, 'image') },
          { type: 'last_frame', url: contentUrl('last', 1, 'image') },
        ]);
      }
      expect(record.resources.map(({ assetId, role }) => [assetId, role])).toEqual([
        ['first', 'firstFrame'],
        ['last', 'lastFrame'],
      ]);
      expect(snapshot).toEqual(before);
    },
  );
});

describe('旧别名不声明显式顺序', () => {
  it.each([undefined, 1])(
    '历史 connected:beta 别名（版本 %s）不改变图片 alpha、beta 输入顺序',
    async (assetVersion) => {
      const snapshot = snapshotFor('image');
      snapshot.inputs = [linkedInput('alpha', 1, 0), linkedInput('beta', 1, 1)];
      snapshot.nodes[0]!.data.resourceRefs = [
        { ...reference('beta', assetVersion), id: 'connected:beta', name: '旧别名' },
      ];
      const before = structuredClone(snapshot);
      const { files, record } = await captureImages(snapshot);
      expect(await Promise.all(files.map((file) => file.text()))).toEqual(['alpha@1', 'beta@1']);
      expect(record.resources.map(({ assetId }) => assetId)).toEqual(['alpha', 'beta']);
      expect(snapshot).toEqual(before);
    },
  );

  it.each(['legacy-v1', 'newapi-video-v1', 'newapi-unified-v1'] as const)(
    '%s 保留历史仅 connected:beta 别名的 alpha、beta 顺序',
    async (contract) => {
      const snapshot = snapshotFor('video');
      snapshot.inputs = [linkedInput('alpha', 1, 0), linkedInput('beta', 1, 1)];
      snapshot.nodes[0]!.data.resourceRefs = [
        { ...reference('beta', 1), id: 'connected:beta', name: '旧别名' },
      ];
      const before = structuredClone(snapshot);
      const { record } = await captureVideo(snapshot, contract);
      expect(record.resources.map(({ assetId }) => assetId)).toEqual(['alpha', 'beta']);
      expect(snapshot).toEqual(before);
    },
  );
});

describe('来源绑定只声明展示身份与顺序，不重写运行快照版本', () => {
  it.each([false, true])(
    '图片连线快照为 v3、refs 为 v1，是否已有冻结 mention：%s',
    async (hasMention) => {
      const snapshot = snapshotFor('image');
      snapshot.inputs = [linkedInput('alpha', 3, 0)];
      snapshot.nodes[0]!.data.resourceRefs = [
        {
          ...reference('alpha', 1),
          id: `ordered:connected:source:${encodeURIComponent(snapshot.inputs[0]!.nodeId)}:alpha`,
        },
      ];
      if (hasMention) addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 1 }]);
      const before = structuredClone(snapshot);
      const { files, record } = await captureImages(snapshot);
      expect(await Promise.all(files.map((file) => file.text()))).toEqual(
        hasMention ? ['alpha@1', 'alpha@3'] : ['alpha@3'],
      );
      expect(record.resources.map(({ assetVersion }) => assetVersion)).toEqual(
        hasMention ? [1, 3] : [3],
      );
      expect(snapshot).toEqual(before);
    },
  );

  it.each([false, true])(
    '视频连线快照为 v3、refs 为 v1，是否已有冻结 mention：%s',
    async (hasMention) => {
      const snapshot = snapshotFor('video');
      snapshot.inputs = [linkedInput('alpha', 3, 0)];
      snapshot.nodes[0]!.data.resourceRefs = [
        {
          ...reference('alpha', 1),
          id: `ordered:connected:source:${encodeURIComponent(snapshot.inputs[0]!.nodeId)}:alpha`,
        },
      ];
      if (hasMention) addMentions(snapshot, [{ assetId: 'alpha', assetVersion: 1 }]);
      const before = structuredClone(snapshot);
      const { body, record } = await captureVideo(snapshot);
      expect(body.reference_images.map((item: { url: string }) => item.url)).toEqual(
        hasMention
          ? [contentUrl('alpha', 1, 'image'), contentUrl('alpha', 3, 'image')]
          : [contentUrl('alpha', 3, 'image')],
      );
      expect(record.resources.map(({ assetVersion }) => assetVersion)).toEqual(
        hasMention ? [1, 3] : [3],
      );
      expect(snapshot).toEqual(before);
    },
  );
});

describe('非参考数组边界', () => {
  it('Chat 的连线消息和正文提及保持原次序，不应用图片视频资源条顺序', async () => {
    const snapshot = snapshotFor('image');
    snapshot.modelAlias = 'chat-test';
    snapshot.nodes[0]!.type = 'text';
    snapshot.nodes[0]!.data.mediaType = 'text';
    snapshot.inputs = [linkedInput('beta', 1, 1, 'content'), linkedInput('alpha', 1, 0, 'content')];
    addMentions(snapshot, [
      { assetId: 'alpha', assetVersion: 1 },
      { assetId: 'alpha', assetVersion: 2 },
    ]);
    snapshot.nodes[0]!.data.resourceRefs = [
      reference('alpha', 2),
      reference('beta', 1),
      reference('alpha', 1),
    ];
    const before = structuredClone(snapshot);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' } }],
        }),
      ),
    );
    await new NewApiProvider({
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test-placeholder',
      fetchImpl,
    }).execute({ snapshot, resolvedMentions: resolveProviderMentions(snapshot) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'image_url', image_url: { url: contentUrl('alpha', 1, 'image') } },
      { type: 'text', text: ' / ' },
      { type: 'image_url', image_url: { url: contentUrl('alpha', 2, 'image') } },
      { type: 'text', text: ' / ' },
    ]);
    expect(
      body.messages
        .slice(1)
        .map(
          (message: { content: { image_url: { url: string } }[] }) =>
            message.content[0]!.image_url.url,
        ),
    ).toEqual([contentUrl('alpha', 1, 'image'), contentUrl('beta', 1, 'image')]);
    expect(snapshot).toEqual(before);
  });
});

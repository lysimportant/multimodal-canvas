import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaType, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import type {
  AssetReferenceBlobStore,
  AssetReferenceRepository,
  StoredAssetReference,
  StoredAssetVersionReference,
} from './asset-reference-resolver';

type StubJob = {
  id: string;
  data: Record<string, unknown>;
  updateData(data: Record<string, unknown>): Promise<void>;
  updateProgress(progress: unknown): Promise<void>;
};

const bullmqState = vi.hoisted(() => ({
  job: undefined as StubJob | undefined,
  processor: undefined as ((job: StubJob) => Promise<unknown>) | undefined,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(..._args: unknown[]) {}
  }

  class Worker {
    constructor(_name: string, processor: (job: StubJob) => Promise<unknown>) {
      bullmqState.processor = processor;
    }
  }

  class Job {
    static async fromId() {
      return bullmqState.job;
    }
  }

  return { Job, Queue, Worker };
});

import {
  S3AssetReferenceBlobStore,
  StoredAssetReferenceResolver,
} from './asset-reference-resolver';
import { createInitialWorkflowState, createNodeRunSnapshot } from './workflow-dag';
import {
  createAuthorizedTestRunWorker,
  withTestExecutionBindings,
} from './test-execution-fixtures';

const projectId = '123e4567-e89b-42d3-a456-426614174700';
const otherProjectId = '123e4567-e89b-42d3-a456-426614174701';
const userId = '123e4567-e89b-42d3-a456-426614174702';
const otherUserId = '123e4567-e89b-42d3-a456-426614174703';
const textAssetId = '123e4567-e89b-42d3-a456-426614174710';
const imageAssetId = '123e4567-e89b-42d3-a456-426614174711';
const videoAssetId = '123e4567-e89b-42d3-a456-426614174712';

beforeEach(() => {
  bullmqState.job = undefined;
  bullmqState.processor = undefined;
});

/** 在 Worker 捕获队列数据前，为 New API 夹具补齐最终节点形态对应的授权。 */
function createRunWorker(options: Parameters<typeof createAuthorizedTestRunWorker>[0]) {
  const data = bullmqState.job?.data;
  if (data?.provider === 'newapi' && data.snapshot) {
    data.snapshot = withTestExecutionBindings(data.snapshot as RunSnapshot);
  }
  return createAuthorizedTestRunWorker(options);
}

describe('StoredAssetReferenceResolver', () => {
  it('signs the frozen object key against the explicit public provider endpoint', async () => {
    const blobStore = new S3AssetReferenceBlobStore('canvas', {
      endpoint: 'https://minio:9000',
      providerEndpoint: 'https://objects.example.com',
      region: 'us-east-1',
      accessKeyId: 'synthetic-access-key',
      secretAccessKey: 'synthetic-secret-key',
      forcePathStyle: true,
    });

    try {
      const signed = new URL(
        await blobStore.createProviderGetUrl!('assets/video/v2-frozen', {
          expiresIn: 3_600,
          contentType: 'video/mp4',
        }),
      );

      expect(signed.protocol).toBe('https:');
      expect(signed.host).toBe('objects.example.com');
      expect(signed.pathname).toBe('/canvas/assets/video/v2-frozen');
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(signed.searchParams.get('response-content-type')).toBe('video/mp4');
      expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await blobStore.close();
    }
  });

  it('uses real S3 signer availability for preferred fallback and required transport failure', async () => {
    const image = Buffer.from('preferred inline image');
    const video = Buffer.from('required signed video');
    const { repository } = fixtures({
      assets: [
        asset(imageAssetId, 'image', 'image/png', image, projectId),
        asset(videoAssetId, 'video', 'video/mp4', video, projectId),
      ],
    });
    const blobStore = new S3AssetReferenceBlobStore('canvas', {
      endpoint: 'https://minio:9000',
      region: 'us-east-1',
      accessKeyId: 'synthetic-access-key',
      secretAccessKey: 'synthetic-secret-key',
      forcePathStyle: true,
    });
    vi.spyOn(blobStore, 'get').mockImplementation(async (key) =>
      key === 'objects/image-current' ? image : key === 'objects/video-current' ? video : undefined,
    );

    try {
      expect(blobStore.createProviderGetUrl).toBeUndefined();
      const preferred = referenceSnapshot({
        sourceMediaType: 'image',
        targetMediaType: 'video',
        role: 'referenceImage',
        assetId: imageAssetId,
        mimeType: 'image/png',
        modelAlias: 'wan3.0-video',
      });
      const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
        preferred,
      );
      expect(hydrated.inputs[0]?.snapshot.data.contentUrl).toBe(
        `data:image/png;base64,${image.toString('base64')}`,
      );

      const required = referenceSnapshot({
        sourceMediaType: 'video',
        targetMediaType: 'video',
        role: 'content',
        assetId: videoAssetId,
        mimeType: 'video/mp4',
        modelAlias: 'wan3.0-video',
      });
      await expect(
        new StoredAssetReferenceResolver(repository, blobStore).resolve(required),
      ).rejects.toThrow('configure S3_PROVIDER_ENDPOINT');
    } finally {
      await blobStore.close();
    }
  });

  it.each([
    { modelAlias: 'wan3.0-video', mediaType: 'video' as const, role: 'content' as const },
    { modelAlias: 'wan3.0-video-prime', mediaType: 'audio' as const, role: 'audioTrack' as const },
    { modelAlias: 'wan3.0-video', mediaType: 'image' as const, role: 'referenceImage' as const },
    { modelAlias: 'MiniMax-H3', mediaType: 'image' as const, role: 'referenceImage' as const },
    { modelAlias: 'minimax-h3', mediaType: 'audio' as const, role: 'audioTrack' as const },
    {
      modelAlias: 'doubao-seedance-2-0-mini-260615',
      mediaType: 'video' as const,
      role: 'content' as const,
    },
    {
      modelAlias: 'doubao-seedance-2-5-260628',
      mediaType: 'video' as const,
      role: 'content' as const,
    },
    {
      modelAlias: 'doubao-seedance-2-0-260128',
      mediaType: 'audio' as const,
      role: 'audioTrack' as const,
    },
    {
      modelAlias: 'seedance-2-0-official',
      mediaType: 'image' as const,
      role: 'referenceImage' as const,
    },
  ])(
    'hydrates $modelAlias $mediaType input as one transient signed URL',
    async ({ modelAlias, mediaType, role }) => {
      const content = Buffer.from(`frozen-${modelAlias}-${mediaType}`);
      const mimeType =
        mediaType === 'video' ? 'video/mp4' : mediaType === 'audio' ? 'audio/wav' : 'image/png';
      const snapshot = referenceSnapshot({
        sourceMediaType: mediaType,
        targetMediaType: 'video',
        role,
        assetId: imageAssetId,
        mimeType,
        modelAlias,
      });
      const original = structuredClone(snapshot);
      const { repository, blobStore } = fixtures({
        assets: [asset(imageAssetId, mediaType, mimeType, content, projectId)],
        versions: [
          {
            assetId: imageAssetId,
            version: 1,
            sizeBytes: BigInt(content.byteLength),
            contentKey: `objects/${mediaType}-frozen-v1`,
          },
        ],
        blobs: { [`objects/${mediaType}-frozen-v1`]: content },
      });
      const createProviderGetUrl = vi.fn(async () =>
        Promise.resolve(
          `https://objects.example.com/canvas/objects/${mediaType}-frozen-v1?X-Amz-Signature=secret`,
        ),
      );
      blobStore.createProviderGetUrl = createProviderGetUrl;

      const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
        snapshot,
      );

      expect(hydrated.inputs[0]?.snapshot.data.contentUrl).toMatch(
        /^https:\/\/objects\.example\.com\//,
      );
      expect(createProviderGetUrl).toHaveBeenCalledOnce();
      expect(createProviderGetUrl).toHaveBeenCalledWith(`objects/${mediaType}-frozen-v1`, {
        expiresIn: 3_600,
        contentType: mimeType,
      });
      expect(blobStore.get).toHaveBeenCalledWith(
        `objects/${mediaType}-frozen-v1`,
        content.byteLength + 1,
      );
      expect(snapshot).toEqual(original);
      expect(JSON.stringify(snapshot)).not.toContain('X-Amz-Signature');
    },
  );

  it.each([
    { modelAlias: 'MiniMax-H3', mediaType: 'video' as const },
    { modelAlias: 'MiniMax-H3', mediaType: 'audio' as const },
    { modelAlias: 'wan3.0-video', mediaType: 'image' as const },
    { modelAlias: 'doubao-seedance-2-0-260128', mediaType: 'audio' as const },
  ])(
    'falls back to a data URL for optional $modelAlias $mediaType transport without a signer',
    async ({ modelAlias, mediaType }) => {
      const content = Buffer.from(`inline-${modelAlias}-${mediaType}`);
      const mimeType = `${mediaType}/${mediaType === 'video' ? 'mp4' : mediaType === 'audio' ? 'wav' : 'png'}`;
      const snapshot = promptMentionSnapshot({
        assetId: imageAssetId,
        assetVersion: 2,
        label: '参考素材',
        mediaType,
        modelAlias,
        targetMediaType: 'video',
      });
      const { repository, blobStore } = fixtures({
        assets: [asset(imageAssetId, mediaType, mimeType, content, projectId)],
        versions: [
          {
            assetId: imageAssetId,
            version: 2,
            sizeBytes: BigInt(content.byteLength),
            contentKey: 'objects/inline-v2',
          },
        ],
        blobs: { 'objects/inline-v2': content },
      });
      const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
        snapshot,
      );
      const mention = hydrated.nodes[0]?.data.promptDocument?.blocks.find(
        (block) => block.type === 'mention',
      );

      expect(mention).toMatchObject({
        contentUrl: `data:${mimeType};base64,${content.toString('base64')}`,
      });
    },
  );

  it('keeps text content as a data URL even when the Moon target has a signer', async () => {
    const content = Buffer.from('frozen text');
    const snapshot = promptMentionSnapshot({
      assetId: textAssetId,
      assetVersion: 1,
      label: '文字参考',
      mediaType: 'text',
      modelAlias: 'minimax-h3',
      targetMediaType: 'video',
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, projectId)],
      blobs: { 'objects/text-current': content },
    });
    const createProviderGetUrl = vi.fn(async () => 'https://objects.example.com/unexpected');
    blobStore.createProviderGetUrl = createProviderGetUrl;

    const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
      snapshot,
    );
    const mention = hydrated.nodes[0]?.data.promptDocument?.blocks.find(
      (block) => block.type === 'mention',
    );
    expect(mention && Reflect.get(mention, 'contentUrl')).toBe(
      `data:text/plain;base64,${content.toString('base64')}`,
    );
    expect(createProviderGetUrl).not.toHaveBeenCalled();
  });

  it('uses the actual DAG mention node model when choosing reference transport', async () => {
    const content = Buffer.from('frozen H3 reference video');
    const snapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 2,
      label: 'H3 参考视频',
      mediaType: 'video',
      modelAlias: 'wan3.0-video',
      targetMediaType: 'video',
    });
    const mentionNode = {
      ...snapshot.nodes[0]!,
      id: 'node_h3',
      data: { ...snapshot.nodes[0]!.data, modelAlias: 'MiniMax-H3' },
    };
    const finalTarget = {
      id: 'node_final',
      type: 'video' as const,
      position: { x: 400, y: 0 },
      data: {
        label: 'Final Wan target',
        mediaType: 'video' as const,
        mode: 'generate' as const,
        modelAlias: 'wan3.0-video',
        videoMode: 'text_to_video' as const,
      },
    };
    snapshot.nodes = [mentionNode, finalTarget];
    snapshot.targetNodeId = finalTarget.id;
    snapshot.promptMentions = snapshot.promptMentions?.map((mention) => ({
      ...mention,
      nodeId: mentionNode.id,
    }));
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'video', 'video/mp4', content, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(content.byteLength),
          contentKey: 'objects/h3-video-v2',
        },
      ],
      blobs: { 'objects/h3-video-v2': content },
    });
    const providerUrl = 'https://objects.example.com/canvas/objects/h3-video-v2';
    const createProviderGetUrl = vi.fn(async () => providerUrl);
    blobStore.createProviderGetUrl = createProviderGetUrl;

    const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
      snapshot,
    );
    const mention = hydrated.nodes
      .find((node) => node.id === mentionNode.id)
      ?.data.promptDocument?.blocks.find((block) => block.type === 'mention');

    expect(mention && Reflect.get(mention, 'contentUrl')).toBe(providerUrl);
    expect(createProviderGetUrl).toHaveBeenCalledOnce();
  });

  it('reuses one signed URL for repeated frozen Seedance video mentions', async () => {
    const content = Buffer.from('frozen seedance reference video');
    const snapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 2,
      label: '参考视频',
      mediaType: 'video',
      repeat: true,
      modelAlias: 'doubao-seedance-2-5-260628',
      targetMediaType: 'video',
    });
    const original = structuredClone(snapshot);
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'video', 'video/mp4', content, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(content.byteLength),
          contentKey: 'objects/seedance-video-v2',
        },
      ],
      blobs: { 'objects/seedance-video-v2': content },
    });
    const providerUrl =
      'https://objects.example.com/canvas/objects/seedance-video-v2?X-Amz-Signature=secret';
    const createProviderGetUrl = vi.fn(async () => providerUrl);
    blobStore.createProviderGetUrl = createProviderGetUrl;

    const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
      snapshot,
    );
    const mentions = hydrated.nodes[0]?.data.promptDocument?.blocks.filter(
      (block) => block.type === 'mention',
    );

    expect(mentions).toHaveLength(2);
    expect(mentions?.map((mention) => Reflect.get(mention, 'contentUrl'))).toEqual([
      providerUrl,
      providerUrl,
    ]);
    expect(blobStore.get).toHaveBeenCalledOnce();
    expect(createProviderGetUrl).toHaveBeenCalledOnce();
    expect(snapshot).toEqual(original);
    expect(JSON.stringify(snapshot)).not.toContain('X-Amz-Signature');
  });

  it.each([
    { modelAlias: 'wan3.0-video', mediaType: 'video' as const, role: 'content' as const },
    {
      modelAlias: 'minimax-h3',
      mediaType: 'image' as const,
      role: 'referenceImage' as const,
    },
    {
      modelAlias: 'seedance-2-0-fast-official',
      mediaType: 'audio' as const,
      role: 'audioTrack' as const,
    },
  ])(
    'fails before provider execution when required $modelAlias $mediaType transport has no signer',
    async ({ modelAlias, mediaType, role }) => {
      const content = Buffer.from(`${modelAlias} reference ${mediaType}`);
      const mimeType =
        mediaType === 'video' ? 'video/mp4' : mediaType === 'audio' ? 'audio/wav' : 'image/png';
      const snapshot = referenceSnapshot({
        sourceMediaType: mediaType,
        targetMediaType: 'video',
        role,
        assetId: imageAssetId,
        mimeType,
        modelAlias,
      });
      const { repository, blobStore } = fixtures({
        assets: [asset(imageAssetId, mediaType, mimeType, content, projectId)],
        blobs: { [`objects/${mediaType}-current`]: content },
      });

      await expect(
        new StoredAssetReferenceResolver(repository, blobStore).resolve(snapshot),
      ).rejects.toThrow('configure S3_PROVIDER_ENDPOINT');
      expect(blobStore.get).toHaveBeenCalledOnce();
    },
  );

  it('hydrates frozen inline prompt mentions in memory without mutating the durable snapshot', async () => {
    const content = Buffer.from('frozen image bytes');
    const snapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 2,
      label: '产品图',
      mediaType: 'image',
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(content.byteLength),
          contentKey: 'objects/image-v2',
        },
      ],
      blobs: { 'objects/image-v2': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    const hydrated = await resolver.resolve(snapshot);
    const mention = hydrated.nodes
      .find((node) => node.id === 'node_target')
      ?.data.promptDocument?.blocks.find((block) => block.type === 'mention');

    expect(mention).toMatchObject({
      mentionId: 'mention-1',
      assetId: imageAssetId,
      assetVersion: 2,
      mimeType: 'image/png',
      contentUrl: `data:image/png;base64,${content.toString('base64')}`,
    });
    expect(hydrated.promptMentions?.[0]).not.toHaveProperty('contentUrl');
    expect(snapshot.nodes.find((node) => node.id === 'node_target')?.data.promptDocument).toEqual(
      snapshot.nodes.find((node) => node.id === 'node_target')?.data.promptDocument,
    );
    expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 2);
    expect(blobStore.get).toHaveBeenCalledWith('objects/image-v2', content.byteLength + 1);
  });

  it('reuses one frozen load for repeated mentions while retaining block order', async () => {
    const content = Buffer.from('same image');
    const snapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 1,
      label: '产品图',
      mediaType: 'image',
      repeat: true,
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      blobs: { 'objects/image-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    const hydrated = await resolver.resolve(snapshot);
    const blocks = hydrated.nodes.find((node) => node.id === 'node_target')?.data.promptDocument
      ?.blocks;
    expect(
      blocks?.filter((block) => block.type === 'mention').map((block) => block.mentionId),
    ).toEqual(['mention-1', 'mention-2']);
    expect(repository.findVersion).toHaveBeenCalledTimes(1);
    expect(blobStore.get).toHaveBeenCalledTimes(1);
  });

  it('rejects archived assets before reading inline prompt bytes', async () => {
    const content = Buffer.from('archived');
    const archived = {
      ...asset(imageAssetId, 'image', 'image/png', content, projectId),
      status: 'archived' as const,
    };
    const { repository, blobStore } = fixtures({
      assets: [archived],
      blobs: { 'objects/image-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    await expect(
      resolver.resolve(
        promptMentionSnapshot({
          assetId: imageAssetId,
          assetVersion: 1,
          label: '归档图',
          mediaType: 'image',
        }),
      ),
    ).rejects.toThrow('is archived');
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it('fails closed when a frozen mention is not represented in the prompt document', async () => {
    const content = Buffer.from('image');
    const snapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 1,
      label: '图',
      mediaType: 'image',
    });
    snapshot.nodes[0]!.data.promptDocument = {
      version: 1,
      blocks: [{ type: 'text', text: '没有提及' }],
    };
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      blobs: { 'objects/image-current': content },
    });

    await expect(
      new StoredAssetReferenceResolver(repository, blobStore).resolve(snapshot),
    ).rejects.toThrow('is missing from node node_target');
  });

  it('hydrates an explicitly versioned text reference without mutating the durable snapshot', async () => {
    const content = Buffer.from('Hello reference', 'utf8');
    const snapshot = referenceSnapshot({ assetId: textAssetId, prompt: 'stale source prompt' });
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/markdown', content, projectId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    const hydrated = await resolver.resolve(snapshot);

    expect(hydrated.inputs[0]?.snapshot.data.contentUrl).toBe(
      `data:text/plain;base64,${content.toString('base64')}`,
    );
    expect(hydrated.nodes[0]?.data.contentUrl).toBe(hydrated.inputs[0]?.snapshot.data.contentUrl);
    expect(hydrated.nodes[0]?.data.mimeType).toBe('text/markdown');
    expect(hydrated.nodes[0]?.data.prompt).toBeUndefined();
    expect(hydrated.inputs[0]?.sourceAssetVersion).toBe(1);
    expect(snapshot.inputs[0]?.snapshot.data.contentUrl).toBe(
      `/v1/assets/${textAssetId}/versions/1/content`,
    );
    expect(repository.findVersion).toHaveBeenCalledWith(textAssetId, 1);
  });

  it('拒绝连线版本字段与冻结地址不一致，避免请求记录误指另一版本', async () => {
    const content = Buffer.from('frozen-image');
    const snapshot = referenceSnapshot({
      sourceMediaType: 'image',
      targetMediaType: 'text',
      role: 'content',
      assetId: imageAssetId,
    });
    snapshot.inputs[0]!.sourceAssetVersion = 2;
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      blobs: { 'objects/image-current': content },
    });

    await expect(
      new StoredAssetReferenceResolver(repository, blobStore).resolve(snapshot),
    ).rejects.toThrow('version does not match its frozen input');
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it('hydrates the frozen image-edit source version into provider-readable content', async () => {
    const frozen = Buffer.from('frozen-source-image');
    const latest = Buffer.from('newer-source-image');
    const snapshot = referenceSnapshot({
      sourceMediaType: 'image',
      targetMediaType: 'image',
      assetId: imageAssetId,
      mimeType: 'image/png',
      contentUrl: `/v1/assets/${imageAssetId}/versions/1/content`,
      role: 'prompt',
    });
    snapshot.targetNodeId = 'node_edit';
    snapshot.nodes.push({
      id: 'node_edit',
      type: 'image',
      position: { x: 200, y: 0 },
      data: {
        label: '修改 Source',
        mediaType: 'image',
        mode: 'generate',
        modelAlias: 'image-edit-v1',
        imageEditSource: {
          sourceNodeId: 'node_source',
          assetId: imageAssetId,
          version: 1,
          sourceKind: 'asset',
        },
      },
    });
    snapshot.edges = [
      {
        id: 'edge_source_edit',
        sourceNodeId: 'node_source',
        sourceHandle: 'output:image',
        targetNodeId: 'node_edit',
        targetHandle: 'input:imageEdit',
        order: 0,
      },
    ];
    snapshot.inputs = [
      {
        nodeId: 'node_source',
        role: 'imageEdit',
        sortOrder: 0,
        sourceAssetId: imageAssetId,
        snapshot: snapshot.nodes[0]!,
      },
    ];
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', latest, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 1,
          sizeBytes: BigInt(frozen.byteLength),
          contentKey: 'objects/image-v1',
        },
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(latest.byteLength),
          contentKey: 'objects/image-v2',
        },
      ],
      blobs: { 'objects/image-v1': frozen, 'objects/image-v2': latest },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    const hydrated = await resolver.resolve(snapshot);

    expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 1);
    expect(hydrated.inputs[0]?.snapshot.data.contentUrl).toBe(
      `data:image/png;base64,${frozen.toString('base64')}`,
    );
    // 来源节点在进程内也拿到已冻结版本的临时内容，编辑节点不读取最新版本。
    expect(hydrated.nodes.find((node) => node.id === 'node_source')?.data.contentUrl).toBe(
      `data:image/png;base64,${frozen.toString('base64')}`,
    );
    expect(hydrated.nodes.find((node) => node.id === 'node_edit')?.data.imageEditSource).toEqual({
      sourceNodeId: 'node_source',
      assetId: imageAssetId,
      version: 1,
      sourceKind: 'asset',
    });
    expect(snapshot.nodes.find((node) => node.id === 'node_source')?.data.contentUrl).toBe(
      `/v1/assets/${imageAssetId}/versions/1/content`,
    );
  });

  it('rejects an image-edit source without an immutable version before any read', async () => {
    const content = Buffer.from('unversioned-source');
    const snapshot = referenceSnapshot({
      sourceMediaType: 'image',
      targetMediaType: 'image',
      assetId: imageAssetId,
      mimeType: 'image/png',
      contentUrl: `/v1/assets/${imageAssetId}/content`,
    });
    snapshot.nodes[0]!.data.imageEditSource = {
      sourceNodeId: 'node_source',
      assetId: imageAssetId,
    };
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      blobs: { 'objects/image-current': content },
    });

    await expect(
      new StoredAssetReferenceResolver(repository, blobStore).resolve(snapshot),
    ).rejects.toThrow('is missing an immutable version');
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it('resolves a relative, explicit image version for a video first frame', async () => {
    const current = Buffer.from('current-image');
    const version = Buffer.from('version-two');
    const snapshot = referenceSnapshot({
      sourceMediaType: 'image',
      targetMediaType: 'video',
      role: 'firstFrame',
      assetId: imageAssetId,
      mimeType: 'image/png',
      contentUrl: `/v1/assets/${imageAssetId}/versions/2/content`,
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', current, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(version.byteLength),
          contentKey: 'objects/image-v2',
        },
      ],
      blobs: { 'objects/image-current': current, 'objects/image-v2': version },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    const hydrated = await resolver.resolve(snapshot);

    expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 2);
    expect(hydrated.inputs[0]?.snapshot.data.contentUrl).toBe(
      `data:image/png;base64,${version.toString('base64')}`,
    );
  });

  it.each([
    {
      name: 'matching frozen version',
      sourceAssetVersion: 2,
      storedDurationSeconds: 9,
      expectedDurationSeconds: 5,
    },
    {
      name: 'unbound duration with version metadata',
      sourceAssetVersion: undefined,
      storedDurationSeconds: 9,
      expectedDurationSeconds: 9,
    },
    {
      name: 'unbound duration without version metadata',
      sourceAssetVersion: undefined,
      storedDurationSeconds: undefined,
      expectedDurationSeconds: undefined,
    },
  ])(
    'binds a static target video duration to its immutable version: $name',
    async ({ sourceAssetVersion, storedDurationSeconds, expectedDurationSeconds }) => {
      const content = Buffer.from(`video-version-two-${String(storedDurationSeconds)}`);
      const snapshot = referenceSnapshot({
        sourceMediaType: 'video',
        targetMediaType: 'video',
        role: 'content',
        assetId: videoAssetId,
        mimeType: 'video/mp4',
        contentUrl: `/v1/assets/${videoAssetId}/versions/2/content`,
        modelAlias: 'wan3.0-video',
      });
      snapshot.inputs[0]!.sourceDurationSeconds = 5;
      if (sourceAssetVersion !== undefined) {
        snapshot.inputs[0]!.sourceAssetVersion = sourceAssetVersion;
      }
      const { repository, blobStore } = fixtures({
        assets: [asset(videoAssetId, 'video', 'video/mp4', content, projectId)],
        versions: [
          {
            assetId: videoAssetId,
            version: 2,
            sizeBytes: BigInt(content.byteLength),
            contentKey: 'objects/video-v2',
            ...(storedDurationSeconds !== undefined
              ? { durationSeconds: storedDurationSeconds }
              : {}),
          },
        ],
        blobs: { 'objects/video-v2': content },
      });
      blobStore.createProviderGetUrl = vi.fn(
        async () => 'https://objects.example.com/canvas/objects/video-v2?signature=test',
      );

      const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
        snapshot,
      );

      expect(hydrated.inputs[0]?.sourceAssetVersion).toBe(2);
      expect(hydrated.inputs[0]?.sourceDurationSeconds).toBe(expectedDurationSeconds);
    },
  );

  it('hydrates an intermediate Wan static video duration from its immutable version metadata', async () => {
    const content = Buffer.from('intermediate static video version two');
    const workflow = referenceSnapshot({
      sourceMediaType: 'video',
      targetMediaType: 'video',
      role: 'content',
      assetId: videoAssetId,
      mimeType: 'video/mp4',
      contentUrl: `/v1/assets/${videoAssetId}/versions/2/content`,
      modelAlias: 'final-video-model',
    });
    const wanNode = workflow.nodes.find((node) => node.id === 'node_target')!;
    wanNode.data.modelAlias = 'wan3.0-video';
    const finalNode = {
      id: 'node_final',
      type: 'video' as const,
      position: { x: 400, y: 0 },
      data: {
        label: 'Final video',
        mediaType: 'video' as const,
        mode: 'generate' as const,
        videoMode: 'omni_reference' as const,
      },
    };
    workflow.targetNodeId = finalNode.id;
    workflow.nodes.push(finalNode);
    workflow.edges.push({
      id: 'edge_wan_final',
      sourceNodeId: wanNode.id,
      sourceHandle: 'output:video',
      targetNodeId: finalNode.id,
      targetHandle: 'input:content',
      order: 0,
    });
    workflow.inputs = [
      {
        nodeId: wanNode.id,
        role: 'content',
        sortOrder: 0,
        snapshot: wanNode,
      },
    ];
    const nodeSnapshot = createNodeRunSnapshot(
      workflow,
      createInitialWorkflowState(workflow),
      wanNode.id,
    );
    expect(nodeSnapshot.inputs[0]?.sourceAssetVersion).toBeUndefined();
    expect(nodeSnapshot.inputs[0]?.sourceDurationSeconds).toBeUndefined();
    const { repository, blobStore } = fixtures({
      assets: [asset(videoAssetId, 'video', 'video/mp4', content, projectId)],
      versions: [
        {
          assetId: videoAssetId,
          version: 2,
          sizeBytes: BigInt(content.byteLength),
          contentKey: 'objects/intermediate-video-v2',
          durationSeconds: 6.75,
        },
      ],
      blobs: { 'objects/intermediate-video-v2': content },
    });
    blobStore.createProviderGetUrl = vi.fn(
      async () => 'https://objects.example.com/canvas/objects/intermediate-video-v2?signature=test',
    );

    const hydrated = await new StoredAssetReferenceResolver(repository, blobStore).resolve(
      nodeSnapshot,
    );

    expect(repository.findVersion).toHaveBeenCalledWith(videoAssetId, 2);
    expect(hydrated.inputs[0]).toMatchObject({
      sourceAssetId: videoAssetId,
      sourceAssetVersion: 2,
      sourceDurationSeconds: 6.75,
    });
  });

  it('rejects an asset owned by another project', async () => {
    const content = Buffer.from('private');
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, otherProjectId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    await expect(resolver.resolve(referenceSnapshot({ assetId: textAssetId }))).rejects.toThrow(
      'does not belong to the run project',
    );
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it('allows an owner-scoped global asset only for the run user', async () => {
    const content = Buffer.from('personal library asset');
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, null, userId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);
    const snapshot = referenceSnapshot({ assetId: textAssetId });

    await expect(resolver.resolve(snapshot, { userId })).resolves.toMatchObject({
      inputs: [{ snapshot: { data: { contentUrl: expect.stringMatching(/^data:text\/plain/) } } }],
    });
    await expect(resolver.resolve(snapshot, { userId: otherUserId })).rejects.toThrow(
      'does not belong to the run project',
    );
    await expect(resolver.resolve(snapshot)).rejects.toThrow('does not belong to the run project');
  });

  it('rejects a durable asset reference without an explicit version', async () => {
    const content = Buffer.from('mutable current content');
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, projectId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);

    await expect(
      resolver.resolve(referenceSnapshot({ assetId: textAssetId, contentUrl: null })),
    ).rejects.toThrow('missing an immutable version');
    expect(repository.findVersion).not.toHaveBeenCalled();
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it('fails explicitly when metadata, a requested version, or stored bytes are missing', async () => {
    const missing = fixtures();
    await expect(
      new StoredAssetReferenceResolver(missing.repository, missing.blobStore).resolve(
        referenceSnapshot({ assetId: textAssetId }),
      ),
    ).rejects.toThrow('was not found');

    const content = Buffer.from('current');
    const noVersion = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      blobs: { 'objects/image-current': content },
    });
    await expect(
      new StoredAssetReferenceResolver(noVersion.repository, noVersion.blobStore).resolve(
        referenceSnapshot({
          sourceMediaType: 'image',
          targetMediaType: 'video',
          role: 'firstFrame',
          assetId: imageAssetId,
          mimeType: 'image/png',
          contentUrl: `/v1/assets/${imageAssetId}/versions/9/content`,
        }),
      ),
    ).rejects.toThrow('version 9 was not found');

    const noBytes = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, projectId)],
    });
    await expect(
      new StoredAssetReferenceResolver(noBytes.repository, noBytes.blobStore).resolve(
        referenceSnapshot({ assetId: textAssetId }),
      ),
    ).rejects.toThrow('content is missing');
  });

  it('rejects oversized content and inconsistent media metadata before provider use', async () => {
    const content = Buffer.from('12345');
    const oversized = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, projectId)],
      blobs: { 'objects/text-current': content },
    });
    await expect(
      new StoredAssetReferenceResolver(oversized.repository, oversized.blobStore, {
        maxBytes: 4,
      }).resolve(referenceSnapshot({ assetId: textAssetId })),
    ).rejects.toThrow('exceeds the 4-byte limit');
    expect(oversized.blobStore.get).not.toHaveBeenCalled();

    const badMime = fixtures({
      assets: [asset(imageAssetId, 'image', 'text/plain', content, projectId)],
      blobs: { 'objects/image-current': content },
    });
    await expect(
      new StoredAssetReferenceResolver(badMime.repository, badMime.blobStore).resolve(
        referenceSnapshot({
          sourceMediaType: 'image',
          targetMediaType: 'video',
          role: 'firstFrame',
          assetId: imageAssetId,
        }),
      ),
    ).rejects.toThrow('MIME type does not match its media type');
  });
});

describe('createRunWorker asset hydration boundary', () => {
  it.each(['mentions', 'link-and-mentions'])(
    '多图 %s 水合后按顺序提交 image[]，不同冻结版本保留且所有 job 更新均不含字节',
    async (kind) => {
      const firstVersion = Buffer.from('worker-frozen-image-version-one');
      const secondVersion = Buffer.from('worker-frozen-image-version-two');
      const otherImage = Buffer.from('worker-another-frozen-image');
      const otherImageId = '123e4567-e89b-42d3-a456-426614174712';
      const references = [
        { assetId: imageAssetId, assetVersion: 2 },
        { assetId: otherImageId, assetVersion: 1 },
        { assetId: imageAssetId, assetVersion: 1 },
        { assetId: imageAssetId, assetVersion: 2 },
      ];
      const durableSnapshot = promptMentionSnapshot({
        ...references[0]!,
        label: '参考图',
        mediaType: 'image',
      });
      durableSnapshot.modelAlias = 'gpt-image-1';
      const mentionReferences = kind === 'link-and-mentions' ? references.slice(1) : references;
      const blocks = mentionReferences.map((reference, index) => ({
        type: 'mention' as const,
        mentionId: `image-reference-${index}`,
        ...reference,
        label: `参考图 ${index + 1}`,
        mediaType: 'image' as const,
      }));
      durableSnapshot.nodes[0]!.data.promptDocument = {
        version: 1,
        blocks: [{ type: 'text', text: 'Combine these images in order.' }, ...blocks],
      };
      durableSnapshot.promptMentions = blocks.map(
        ({ mentionId, assetId, assetVersion, mediaType, label }, index) => ({
          mentionId,
          assetId,
          assetVersion,
          mediaType,
          label,
          nodeId: 'node_target',
          blockOrder: index + 1,
        }),
      );
      if (kind === 'link-and-mentions') {
        const linked = referenceSnapshot({
          sourceMediaType: 'image',
          targetMediaType: 'image',
          role: 'referenceImage',
          assetId: imageAssetId,
          mimeType: 'image/png',
          contentUrl: `/v1/assets/${imageAssetId}/versions/2/content`,
        });
        durableSnapshot.inputs = linked.inputs;
        durableSnapshot.inputs[0]!.sourceAssetVersion = 2;
        durableSnapshot.edges = linked.edges;
        durableSnapshot.nodes.unshift(linked.nodes[0]!);
      }
      const originalSnapshot = structuredClone(durableSnapshot);
      const { repository, blobStore } = fixtures({
        assets: [
          asset(imageAssetId, 'image', 'image/png', Buffer.from('latest-image-bytes'), projectId),
          asset(otherImageId, 'image', 'image/png', Buffer.from('latest-other-bytes'), projectId),
        ],
        versions: [
          {
            assetId: imageAssetId,
            version: 1,
            sizeBytes: BigInt(firstVersion.byteLength),
            contentKey: 'objects/frozen-first-v1',
          },
          {
            assetId: imageAssetId,
            version: 2,
            sizeBytes: BigInt(secondVersion.byteLength),
            contentKey: 'objects/frozen-first-v2',
          },
          {
            assetId: otherImageId,
            version: 1,
            sizeBytes: BigInt(otherImage.byteLength),
            contentKey: 'objects/frozen-other-v1',
          },
        ],
        blobs: {
          'objects/frozen-first-v1': firstVersion,
          'objects/frozen-first-v2': secondVersion,
          'objects/frozen-other-v1': otherImage,
        },
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ data: [{ b64_json: Buffer.from('combined image').toString('base64') }] }),
        );
      const jobUpdates: unknown[] = [];
      const job: StubJob = {
        id: projectId,
        data: {
          runId: projectId,
          userId,
          snapshot: durableSnapshot,
          attempt: 1,
          provider: 'newapi',
          cancelRequested: false,
        },
        async updateData(data) {
          jobUpdates.push(structuredClone(data));
          this.data = data;
        },
        async updateProgress() {},
      };
      bullmqState.job = job;
      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        stepDelayMs: 0,
        providerName: 'newapi',
        provider: new NewApiProvider({
          baseUrl: 'https://newapi.example.test/v1',
          apiKey: 'synthetic-test-key',
          fetchImpl,
        }),
        assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
        resultArchiver: async () => ({
          assetId: 'asset_multiple_image_result',
          version: 1,
          mimeType: 'image/png',
        }),
      });

      await bullmqState.processor?.(job);

      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://newapi.example.test/v1/images/edits');
      const form = init!.body as FormData;
      expect(form.getAll('image')).toEqual([]);
      expect(form.getAll('image[]')).toHaveLength(3);
      expect(
        await Promise.all(
          form
            .getAll('image[]')
            .map(async (file) => Buffer.from(await (file as File).arrayBuffer())),
        ),
      ).toEqual([secondVersion, otherImage, firstVersion]);
      expect(repository.findVersion).toHaveBeenCalledTimes(3);
      expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 1);
      expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 2);
      expect(repository.findVersion).toHaveBeenCalledWith(otherImageId, 1);
      expect(blobStore.get).toHaveBeenCalledTimes(3);
      expect(durableSnapshot).toEqual(originalSnapshot);
      expect(job.data.snapshot).toEqual(withTestExecutionBindings(originalSnapshot));
      expect(jobUpdates.length).toBeGreaterThan(0);
      const durable = JSON.stringify([job.data, ...jobUpdates]);
      expect(durable).not.toContain('data:image/');
      for (const content of [firstVersion, secondVersion, otherImage]) {
        expect(durable).not.toContain(content.toString('base64'));
      }
    },
  );

  it.each(
    (['read-next-resource', 'capture-prompt'] as const).flatMap((phase) =>
      (['archived', 'revoked', 'deleted'] as const).map((change) => ({ phase, change })),
    ),
  )(
    '在 $phase 期间资源 $change 时不发出 Provider 请求，也不重读文件',
    async ({ phase, change }) => {
      const image = Buffer.from('private frozen image');
      const text = Buffer.from('Compare the image.');
      const privateAsset = asset(imageAssetId, 'image', 'image/png', image, null, userId);
      const textAsset = asset(textAssetId, 'text', 'text/plain', text, projectId);
      const durableSnapshot = referenceSnapshot({
        sourceMediaType: 'image',
        targetMediaType: 'text',
        role: 'content',
        assetId: imageAssetId,
        mimeType: 'image/png',
      });
      durableSnapshot.credentialId = userId;
      durableSnapshot.credentialVersion = 1;
      const mention = {
        nodeId: 'node_target',
        mentionId: 'document',
        assetId: textAssetId,
        assetVersion: 1,
        mediaType: 'text' as const,
        label: 'Document',
        blockOrder: 0,
      };
      durableSnapshot.promptMentions = [mention];
      durableSnapshot.nodes.find((node) => node.id === 'node_target')!.data.promptDocument = {
        version: 1,
        blocks: [{ type: 'mention', ...mention }],
      };
      const { repository, blobStore } = fixtures({
        assets: [privateAsset, textAsset],
        blobs: { 'objects/image-current': image, 'objects/text-current': text },
      });
      let changed = false;
      repository.findAsset.mockImplementation(async (id) => {
        if (id !== imageAssetId) return id === textAssetId ? textAsset : undefined;
        if (!changed) return privateAsset;
        if (change === 'deleted') return undefined;
        return change === 'archived'
          ? { ...privateAsset, status: 'archived' }
          : { ...privateAsset, ownerId: otherUserId };
      });
      blobStore.get.mockImplementation(async (key) => {
        if (key === 'objects/text-current') {
          if (phase === 'read-next-resource') changed = true;
          return text;
        }
        return key === 'objects/image-current' ? image : undefined;
      });
      const capture = vi.fn(async () => {
        if (phase === 'capture-prompt') changed = true;
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ choices: [{ message: { content: 'Unexpected request' } }] }),
        );
      const job: StubJob = {
        id: projectId,
        data: {
          runId: projectId,
          userId,
          snapshot: durableSnapshot,
          attempt: 1,
          provider: 'newapi',
          cancelRequested: false,
        },
        async updateData(data) {
          this.data = data;
        },
        async updateProgress() {},
      };
      bullmqState.job = job;
      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        stepDelayMs: 0,
        providerName: 'newapi',
        provider: new NewApiProvider({
          baseUrl: 'https://newapi.example.test/v1',
          apiKey: 'synthetic-test-key',
          fetchImpl,
        }),
        assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
        persistence: {
          async getProviderCredentials() {
            return { baseUrl: 'https://newapi.example.test/v1', apiKey: 'synthetic-test-key' };
          },
          upsertRequestPromptRecord: capture,
          async recordRequestPromptOutcome() {},
          async upsertProviderJob() {},
          async recordUsage() {},
          async updateRun() {},
        },
        resultArchiver: async () => ({
          assetId: 'asset_text_target',
          version: 1,
          mimeType: 'text/plain',
        }),
      });

      await expect(bullmqState.processor?.(job)).rejects.toThrow(
        change === 'archived'
          ? 'is archived'
          : change === 'revoked'
            ? 'does not belong to the run project'
            : 'was not found',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledTimes(phase === 'capture-prompt' ? 1 : 0);
      expect(blobStore.get).toHaveBeenCalledTimes(2);
      expect(repository.findVersion).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(job.data)).not.toContain(image.toString('base64'));
    },
  );

  it.each([
    { mediaType: 'text', mimeType: 'text/markdown', kind: 'mention' },
    { mediaType: 'image', mimeType: 'image/png', kind: 'mention' },
    { mediaType: 'audio', mimeType: 'audio/wav', kind: 'mention' },
    { mediaType: 'video', mimeType: 'video/mp4', kind: 'mention' },
    { mediaType: 'image', mimeType: 'image/png', kind: 'link' },
  ] as const)(
    '文字目标的 $mediaType $kind 将冻结内容送入聊天接口',
    async ({ mediaType, mimeType, kind }) => {
      const content = Buffer.from(`frozen-${mediaType}-reference`);
      const durableSnapshot =
        kind === 'mention'
          ? promptMentionSnapshot({
              assetId: imageAssetId,
              assetVersion: 2,
              label: '参考素材',
              mediaType,
            })
          : referenceSnapshot({
              sourceMediaType: 'image',
              targetMediaType: 'text',
              role: 'content',
              assetId: imageAssetId,
              mimeType,
              contentUrl: `/v1/assets/${imageAssetId}/versions/2/content`,
            });
      const target = durableSnapshot.nodes.find((node) => node.id === 'node_target')!;
      target.type = 'text';
      target.data.mediaType = 'text';
      target.data.prompt = 'Describe this resource.';
      const { repository, blobStore } = fixtures({
        assets: [
          asset(imageAssetId, mediaType, mimeType, Buffer.from('current-version'), projectId),
        ],
        versions: [
          {
            assetId: imageAssetId,
            version: 2,
            sizeBytes: BigInt(content.byteLength),
            contentKey: 'objects/frozen-v2',
          },
        ],
        blobs: { 'objects/frozen-v2': content },
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ choices: [{ message: { content: 'ACCEPTANCE_OK' } }] }));
      const provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-test-key',
        fetchImpl,
      });
      const job: StubJob = {
        id: projectId,
        data: {
          runId: projectId,
          userId,
          snapshot: durableSnapshot,
          attempt: 1,
          provider: 'newapi',
          cancelRequested: false,
        },
        async updateData(data) {
          this.data = data;
        },
        async updateProgress() {},
      };
      bullmqState.job = job;
      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        stepDelayMs: 0,
        assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
        providerName: 'newapi',
        provider,
        resultArchiver: async () => ({
          assetId: 'asset_text_target',
          version: 1,
          mimeType: 'text/plain',
        }),
      });

      await bullmqState.processor?.(job);

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/chat/completions');
      const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
      expect(JSON.stringify(body.messages)).toContain(
        mediaType === 'text' ? content.toString('utf8') : content.toString('base64'),
      );
      expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 2);
      expect(JSON.stringify(job.data)).not.toContain(content.toString('base64'));
      expect(JSON.stringify(job.data)).not.toContain('data:image/');
    },
  );

  it('uses the frozen asset version when a completed upstream node is recovered', async () => {
    const current = Buffer.from('newer mutable content', 'utf8');
    const frozen = Buffer.from('frozen generated result', 'utf8');
    const durableSnapshot = referenceSnapshot({
      assetId: textAssetId,
      sourceMode: 'generate',
      prompt: 'old generation instruction',
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', current, projectId)],
      versions: [
        {
          assetId: textAssetId,
          version: 2,
          sizeBytes: BigInt(frozen.byteLength),
          contentKey: 'objects/text-v2',
        },
      ],
      blobs: { 'objects/text-current': current, 'objects/text-v2': frozen },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);
    let providerSnapshot: RunSnapshot | undefined;
    const job: StubJob = {
      id: projectId,
      data: {
        runId: projectId,
        snapshot: durableSnapshot,
        attempt: 2,
        provider: 'mock',
        workflowState: {
          nodes: [
            {
              nodeId: 'node_source',
              status: 'succeeded',
              result: {
                provider: 'mock',
                summary: 'recovered upstream',
                targetNodeId: 'node_source',
                mediaType: 'text',
                inputCount: 0,
                asset: {
                  assetId: textAssetId,
                  version: 2,
                  mimeType: 'text/plain',
                },
              },
            },
            { nodeId: 'node_target', status: 'pending' },
          ],
        },
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      assetReferenceResolver: resolver,
      provider: {
        async execute(request) {
          providerSnapshot = request.snapshot;
          return {
            result: {
              provider: 'mock',
              summary: 'generated from recovered input',
              targetNodeId: 'node_target',
              mediaType: 'image' as const,
              inputCount: request.snapshot.inputs.length,
            },
            output: {
              mediaType: 'image' as const,
              kind: 'url' as const,
              url: 'https://assets.example/recovered.png',
              mimeType: 'image/png',
            },
          };
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_recovered_target',
        version: 1,
        mimeType: 'image/png',
      }),
    });

    await bullmqState.processor?.(job);

    expect(repository.findVersion).toHaveBeenCalledWith(textAssetId, 2);
    expect(providerSnapshot?.inputs[0]?.snapshot.data).toMatchObject({
      prompt: undefined,
      contentUrl: `data:text/plain;base64,${frozen.toString('base64')}`,
    });
    expect(providerSnapshot?.inputs[0]?.snapshot.data.contentUrl).not.toContain(
      current.toString('base64'),
    );
    expect(JSON.stringify(job.data)).not.toContain(frozen.toString('base64'));
  });

  it.each([
    { name: 'duration metadata present', durationSeconds: 7.25 },
    { name: 'duration metadata absent', durationSeconds: undefined },
  ])(
    'uses a newly archived upstream video version without inheriting old duration: $name',
    async ({ durationSeconds }) => {
      const versionOne = Buffer.from('generated video version one');
      const versionTwo = Buffer.from(`generated video version two ${String(durationSeconds)}`);
      const upstreamNode = {
        id: 'node_generated_video',
        type: 'video' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Generated source video',
          mediaType: 'video' as const,
          mode: 'generate' as const,
          modelAlias: 'upstream-video-model',
          videoMode: 'text_to_video' as const,
          prompt: 'Generate a source clip.',
          assetId: videoAssetId,
          contentUrl: `/v1/assets/${videoAssetId}/versions/1/content`,
          mimeType: 'video/mp4',
        },
      };
      const targetNode = {
        id: 'node_wan_target',
        type: 'video' as const,
        position: { x: 300, y: 0 },
        data: {
          label: 'Wan target',
          mediaType: 'video' as const,
          mode: 'generate' as const,
          videoMode: 'omni_reference' as const,
          prompt: 'Continue the archived clip.',
        },
      };
      const durableSnapshot: RunSnapshot = {
        projectId,
        canvasRevision: 1,
        targetNodeId: targetNode.id,
        modelAlias: 'wan3.0-video',
        parameters: { duration: 5, resolution: '720p', aspectRatio: '16:9' },
        submittedAt: '2026-08-27T00:00:00.000Z',
        nodes: [upstreamNode, targetNode],
        edges: [
          {
            id: 'edge_generated_wan',
            sourceNodeId: upstreamNode.id,
            sourceHandle: 'output:video',
            targetNodeId: targetNode.id,
            targetHandle: 'input:content',
            order: 0,
          },
        ],
        inputs: [
          {
            nodeId: upstreamNode.id,
            role: 'content',
            sortOrder: 0,
            sourceAssetId: videoAssetId,
            sourceAssetVersion: 1,
            sourceDurationSeconds: 4,
            snapshot: upstreamNode,
          },
        ],
      };
      const { repository, blobStore } = fixtures({
        assets: [asset(videoAssetId, 'video', 'video/mp4', versionTwo, projectId)],
        versions: [
          {
            assetId: videoAssetId,
            version: 1,
            sizeBytes: BigInt(versionOne.byteLength),
            contentKey: 'objects/generated-video-v1',
            durationSeconds: 4,
          },
          {
            assetId: videoAssetId,
            version: 2,
            sizeBytes: BigInt(versionTwo.byteLength),
            contentKey: 'objects/generated-video-v2',
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          },
        ],
        blobs: {
          'objects/generated-video-v1': versionOne,
          'objects/generated-video-v2': versionTwo,
        },
      });
      blobStore.createProviderGetUrl = vi.fn(
        async () => 'https://objects.example.com/canvas/objects/generated-video-v2?signature=test',
      );
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'wan-target-task', status: 'queued' })),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'wan-target-task',
              status: 'completed',
              video: { url: 'https://cdn.example.com/wan-target.mp4' },
            }),
          ),
        );
      const targetProvider = new NewApiVideoProvider({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-test-key',
        videoContract: 'newapi-video-v1',
        fetchImpl,
        pollIntervalMs: 0,
        maxPollAttempts: 1,
      });
      let targetProviderSnapshot: RunSnapshot | undefined;
      const job: StubJob = {
        id: projectId,
        data: {
          runId: projectId,
          userId,
          snapshot: durableSnapshot,
          attempt: 1,
          provider: 'newapi',
          cancelRequested: false,
        },
        async updateData(data) {
          this.data = data;
        },
        async updateProgress() {},
      };
      bullmqState.job = job;
      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        stepDelayMs: 0,
        providerName: 'newapi',
        videoProvider: {
          async execute(request) {
            if (request.snapshot.targetNodeId === upstreamNode.id) {
              return {
                result: {
                  provider: 'newapi',
                  summary: 'generated upstream video',
                  targetNodeId: upstreamNode.id,
                  mediaType: 'video' as const,
                  inputCount: 0,
                },
                output: {
                  mediaType: 'video' as const,
                  kind: 'url' as const,
                  url: 'https://cdn.example.com/generated-video-v2.mp4',
                  mimeType: 'video/mp4',
                },
              };
            }
            targetProviderSnapshot = request.snapshot;
            return targetProvider.execute(request);
          },
        },
        assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
        resultArchiver: async ({ result }) =>
          result.targetNodeId === upstreamNode.id
            ? { assetId: videoAssetId, version: 2, mimeType: 'video/mp4' }
            : {
                assetId: '123e4567-e89b-42d3-a456-426614174713',
                version: 1,
                mimeType: 'video/mp4',
              },
      });

      await bullmqState.processor?.(job);

      expect(repository.findVersion).toHaveBeenCalledWith(videoAssetId, 2);
      expect(repository.findVersion).not.toHaveBeenCalledWith(videoAssetId, 1);
      expect(targetProviderSnapshot?.inputs[0]).toMatchObject({
        sourceAssetId: videoAssetId,
        sourceAssetVersion: 2,
      });
      expect(targetProviderSnapshot?.inputs[0]?.sourceDurationSeconds).toBe(durationSeconds);
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      if (durationSeconds === undefined) {
        expect(body.metadata).not.toHaveProperty('reference_video_durations');
      } else {
        expect(body.metadata.reference_video_durations).toEqual([durationSeconds]);
      }
    },
  );

  it('passes only a transient hydrated snapshot to the provider', async () => {
    const content = Buffer.from('A frozen prompt', 'utf8');
    const durableSnapshot = referenceSnapshot({
      assetId: textAssetId,
      contentUrl: `/v1/assets/${textAssetId}/versions/1/content`,
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, null, userId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);
    let providerSnapshot: RunSnapshot | undefined;
    const job: StubJob = {
      id: projectId,
      data: {
        runId: projectId,
        userId,
        snapshot: durableSnapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      assetReferenceResolver: resolver,
      provider: {
        async execute(request) {
          providerSnapshot = request.snapshot;
          return {
            result: {
              provider: 'mock',
              summary: 'generated',
              targetNodeId: 'node_target',
              mediaType: 'image' as const,
              inputCount: request.snapshot.inputs.length,
            },
            output: {
              mediaType: 'image' as const,
              kind: 'url' as const,
              url: 'https://assets.example/generated.png',
              mimeType: 'image/png',
            },
          };
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_transient_target',
        version: 1,
        mimeType: 'image/png',
      }),
    });

    await bullmqState.processor?.(job);

    expect(providerSnapshot?.inputs[0]?.snapshot.data.contentUrl).toBe(
      `data:text/plain;base64,${content.toString('base64')}`,
    );
    expect(JSON.stringify(job.data)).not.toContain('data:text/plain');
    expect(JSON.stringify(job.data)).not.toContain(content.toString('base64'));
    expect(job.data).toMatchObject({
      snapshot: {
        inputs: [
          {
            snapshot: {
              data: { contentUrl: `/v1/assets/${textAssetId}/versions/1/content` },
            },
          },
        ],
      },
    });
  });

  it('无能力声明的图片引用按冻结版本水合后发送 edits，媒体内容不进入任务存储', async () => {
    const content = Buffer.from('resolved image bytes');
    const durableSnapshot = promptMentionSnapshot({
      assetId: imageAssetId,
      assetVersion: 2,
      label: '产品图',
      mediaType: 'image',
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'image', 'image/png', content, projectId)],
      versions: [
        {
          assetId: imageAssetId,
          version: 2,
          sizeBytes: BigInt(content.byteLength),
          contentKey: 'objects/image-v2',
        },
      ],
      blobs: { 'objects/image-v2': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);
    let providerMentions: unknown;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ b64_json: Buffer.from('generated image').toString('base64') }] }),
      );
    const provider = new NewApiProvider({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'synthetic-test-key',
      fetchImpl,
    });
    const job: StubJob = {
      id: projectId,
      data: {
        runId: projectId,
        userId,
        snapshot: durableSnapshot,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      assetReferenceResolver: resolver,
      providerName: 'newapi',
      provider: {
        async execute(request) {
          providerMentions = request.resolvedMentions;
          return provider.execute(request);
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_resolved_target',
        version: 1,
        mimeType: 'image/png',
      }),
    });

    await bullmqState.processor?.(job);

    expect(providerMentions).toMatchObject([
      {
        nodeId: 'node_target',
        mentionId: 'mention-1',
        assetId: imageAssetId,
        assetVersion: 2,
        blockOrder: 1,
        source: {
          kind: 'data-url',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${content.toString('base64')}`,
        },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://newapi.example.test/v1/images/edits');
    const form = init!.body as FormData;
    expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(content);
    expect(repository.findVersion).toHaveBeenCalledWith(imageAssetId, 2);
    expect(JSON.stringify(job.data)).not.toContain(content.toString('base64'));
  });

  it('redacts transient asset bytes when a provider echoes its request in an error', async () => {
    const content = Buffer.from('never persist this prompt', 'utf8');
    const durableSnapshot = referenceSnapshot({ assetId: textAssetId });
    const { repository, blobStore } = fixtures({
      assets: [asset(textAssetId, 'text', 'text/plain', content, projectId)],
      blobs: { 'objects/text-current': content },
    });
    const resolver = new StoredAssetReferenceResolver(repository, blobStore);
    const loggedErrors: unknown[] = [];
    const persistedRuns: unknown[] = [];
    const logger = {
      child() {
        return this;
      },
      debug() {},
      info() {},
      warn() {},
      error(bindings: unknown) {
        loggedErrors.push(bindings);
      },
    };
    const job: StubJob = {
      id: projectId,
      data: {
        runId: projectId,
        snapshot: durableSnapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      logger,
      assetReferenceResolver: resolver,
      persistence: {
        async upsertProviderJob() {},
        async recordUsage() {},
        async updateRun(input) {
          persistedRuns.push(input);
        },
      },
      provider: {
        async execute(request) {
          throw new Error(
            `provider echoed ${request.snapshot.inputs[0]?.snapshot.data.contentUrl}`,
          );
        },
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('[REDACTED_ASSET_DATA]');

    const encoded = content.toString('base64');
    expect(JSON.stringify(job.data)).not.toContain(encoded);
    expect(JSON.stringify(loggedErrors)).not.toContain(encoded);
    expect(JSON.stringify(persistedRuns)).not.toContain(encoded);
    expect(JSON.stringify(loggedErrors)).toContain('[REDACTED_ASSET_DATA]');
    expect(JSON.stringify(persistedRuns)).toContain('[REDACTED_ASSET_DATA]');
  });

  it('redacts a transient signed asset URL from job state, logs and persisted errors', async () => {
    const content = Buffer.from('provider-readable frozen video');
    const durableSnapshot = referenceSnapshot({
      sourceMediaType: 'video',
      targetMediaType: 'video',
      role: 'content',
      assetId: imageAssetId,
      mimeType: 'video/mp4',
      modelAlias: 'wan3.0-video',
    });
    const { repository, blobStore } = fixtures({
      assets: [asset(imageAssetId, 'video', 'video/mp4', content, projectId)],
      blobs: { 'objects/video-current': content },
    });
    const signedUrl =
      'https://objects.example.com/canvas/objects/video-current?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=never-persist-this-signature';
    blobStore.createProviderGetUrl = vi.fn(async () => signedUrl);
    const loggedErrors: unknown[] = [];
    const persistedRuns: unknown[] = [];
    const logger = {
      child() {
        return this;
      },
      debug() {},
      info() {},
      warn() {},
      error(bindings: unknown) {
        loggedErrors.push(bindings);
      },
    };
    const job: StubJob = {
      id: projectId,
      data: {
        runId: projectId,
        snapshot: durableSnapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      logger,
      assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
      persistence: {
        async upsertProviderJob() {},
        async recordUsage() {},
        async updateRun(input) {
          persistedRuns.push(input);
        },
      },
      provider: {
        async execute(request) {
          throw new Error(
            `provider echoed ${request.snapshot.inputs[0]?.snapshot.data.contentUrl}`,
          );
        },
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('[REDACTED_ASSET_URL]');

    for (const value of [job.data, loggedErrors, persistedRuns]) {
      const serialized = JSON.stringify(value);
      expect(serialized).not.toContain('never-persist-this-signature');
      expect(serialized).not.toContain('X-Amz-Signature');
    }
    expect(JSON.stringify(loggedErrors)).toContain('[REDACTED_ASSET_URL]');
    expect(JSON.stringify(persistedRuns)).toContain('[REDACTED_ASSET_URL]');
  });
});

function referenceSnapshot(options: {
  sourceMediaType?: MediaType;
  targetMediaType?: 'text' | 'image' | 'video';
  role?: 'prompt' | 'firstFrame' | 'content' | 'referenceImage' | 'audioTrack';
  assetId: string;
  sourceMode?: 'source' | 'generate';
  contentUrl?: string | null;
  mimeType?: string;
  prompt?: string;
  modelAlias?: string;
}): RunSnapshot {
  const sourceMediaType = options.sourceMediaType ?? 'text';
  const targetMediaType = options.targetMediaType ?? 'image';
  const role = options.role ?? 'prompt';
  const source = {
    id: 'node_source',
    type: sourceMediaType,
    position: { x: 0, y: 0 },
    data: {
      label: 'Source',
      mediaType: sourceMediaType,
      mode: options.sourceMode ?? ('source' as const),
      assetId: options.assetId,
      ...(options.contentUrl === null
        ? {}
        : {
            contentUrl: options.contentUrl ?? `/v1/assets/${options.assetId}/versions/1/content`,
          }),
      ...(options.sourceMode === 'generate' ? { modelAlias: 'source-model' } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  };
  const target = {
    id: 'node_target',
    type: targetMediaType,
    position: { x: 200, y: 0 },
    data: {
      label: 'Target',
      mediaType: targetMediaType,
      mode: 'generate' as const,
      ...(targetMediaType === 'video'
        ? {
            videoMode:
              role === 'firstFrame' ? ('first_frame' as const) : ('omni_reference' as const),
          }
        : {}),
    },
  };
  return {
    projectId,
    canvasRevision: 1,
    targetNodeId: target.id,
    modelAlias: options.modelAlias ?? 'target-model',
    parameters: {},
    submittedAt: '2026-08-27T00:00:00.000Z',
    nodes: [source, target],
    edges: [
      {
        id: 'edge_source_target',
        sourceNodeId: source.id,
        sourceHandle: `output:${sourceMediaType}`,
        targetNodeId: target.id,
        targetHandle: `input:${role}`,
        order: 0,
      },
    ],
    inputs: [
      {
        nodeId: source.id,
        role,
        sortOrder: 0,
        sourceAssetId: options.assetId,
        snapshot: source,
      },
    ],
  };
}

function promptMentionSnapshot(options: {
  assetId: string;
  assetVersion: number;
  label: string;
  mediaType: MediaType;
  repeat?: boolean;
  modelAlias?: string;
  targetMediaType?: 'image' | 'video';
}): RunSnapshot {
  const blocks = [
    { type: 'text' as const, text: '请使用 ' },
    {
      type: 'mention' as const,
      mentionId: 'mention-1',
      assetId: options.assetId,
      assetVersion: options.assetVersion,
      label: options.label,
      mediaType: options.mediaType,
    },
    ...(options.repeat
      ? [
          { type: 'text' as const, text: ' 和 ' },
          {
            type: 'mention' as const,
            mentionId: 'mention-2',
            assetId: options.assetId,
            assetVersion: options.assetVersion,
            label: options.label,
            mediaType: options.mediaType,
          },
        ]
      : []),
  ];
  const targetMediaType = options.targetMediaType ?? 'image';
  const target = {
    id: 'node_target',
    type: targetMediaType,
    position: { x: 200, y: 0 },
    data: {
      label: 'Target',
      mediaType: targetMediaType,
      mode: 'generate' as const,
      ...(targetMediaType === 'video' ? { videoMode: 'omni_reference' as const } : {}),
      promptDocument: { version: 1 as const, blocks },
    },
  };
  const mentions = blocks
    .filter((block) => block.type === 'mention')
    .map((block, index) => ({
      nodeId: target.id,
      mentionId: block.mentionId,
      assetId: block.assetId,
      assetVersion: options.assetVersion,
      mediaType: block.mediaType,
      label: block.label,
      blockOrder: index * 2 + 1,
    }));
  return {
    projectId,
    canvasRevision: 1,
    targetNodeId: target.id,
    modelAlias: options.modelAlias ?? 'target-model',
    parameters: {},
    submittedAt: '2026-08-27T00:00:00.000Z',
    nodes: [target],
    edges: [],
    inputs: [],
    promptMentions: mentions,
  };
}

function asset(
  id: string,
  mediaType: MediaType,
  mimeType: string,
  content: Buffer,
  ownerProjectId: string | null,
  ownerId: string | null = null,
): StoredAssetReference {
  return {
    id,
    projectId: ownerProjectId,
    ownerId,
    mediaType,
    mimeType,
    sizeBytes: BigInt(content.byteLength),
    contentKey: `objects/${mediaType}-current`,
  };
}

function fixtures(
  input: {
    assets?: StoredAssetReference[];
    versions?: StoredAssetVersionReference[];
    blobs?: Record<string, Buffer>;
  } = {},
): {
  repository: AssetReferenceRepository & {
    findAsset: ReturnType<typeof vi.fn<AssetReferenceRepository['findAsset']>>;
    findVersion: ReturnType<typeof vi.fn<AssetReferenceRepository['findVersion']>>;
  };
  blobStore: AssetReferenceBlobStore & {
    get: ReturnType<typeof vi.fn<AssetReferenceBlobStore['get']>>;
  };
} {
  const assets = new Map((input.assets ?? []).map((entry) => [entry.id, entry]));
  const versionRows =
    input.versions ??
    (input.assets ?? []).map((entry) => ({
      assetId: entry.id,
      version: 1,
      sizeBytes: entry.sizeBytes,
      contentKey: entry.contentKey,
    }));
  const versions = new Map(
    versionRows.map((entry) => [`${entry.assetId}:${entry.version}`, entry]),
  );
  const blobs = new Map(Object.entries(input.blobs ?? {}));
  const findAsset = vi.fn<AssetReferenceRepository['findAsset']>(async (assetId) =>
    assets.get(assetId),
  );
  const findVersion = vi.fn<AssetReferenceRepository['findVersion']>(async (assetId, version) =>
    versions.get(`${assetId}:${version}`),
  );
  const get = vi.fn<AssetReferenceBlobStore['get']>(async (key) => {
    const content = blobs.get(key);
    return content ? Buffer.from(content) : undefined;
  });
  return {
    repository: { findAsset, findVersion },
    blobStore: { get },
  };
}

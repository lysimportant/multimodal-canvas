import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
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

import { StoredAssetReferenceResolver } from './asset-reference-resolver';
import { createRunWorker } from './index';

const projectId = '123e4567-e89b-42d3-a456-426614174700';
const otherProjectId = '123e4567-e89b-42d3-a456-426614174701';
const userId = '123e4567-e89b-42d3-a456-426614174702';
const otherUserId = '123e4567-e89b-42d3-a456-426614174703';
const textAssetId = '123e4567-e89b-42d3-a456-426614174710';
const imageAssetId = '123e4567-e89b-42d3-a456-426614174711';

beforeEach(() => {
  bullmqState.job = undefined;
  bullmqState.processor = undefined;
});

describe('StoredAssetReferenceResolver', () => {
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
    expect(snapshot.inputs[0]?.snapshot.data.contentUrl).toBe(
      `/v1/assets/${textAssetId}/versions/1/content`,
    );
    expect(repository.findVersion).toHaveBeenCalledWith(textAssetId, 1);
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
  it('uses the frozen asset version when a completed upstream node is recovered', async () => {
    const current = Buffer.from('newer mutable content', 'utf8');
    const frozen = Buffer.from('frozen generated result', 'utf8');
    const durableSnapshot = referenceSnapshot({
      assetId: textAssetId,
      sourceMode: 'transform',
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

  it('passes provider-neutral resolved mentions without persisting their content', async () => {
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
          providerMentions = request.resolvedMentions;
          return {
            result: {
              provider: 'mock',
              summary: 'generated',
              targetNodeId: 'node_target',
              mediaType: 'image' as const,
              inputCount: 0,
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
});

function referenceSnapshot(options: {
  sourceMediaType?: 'text' | 'image';
  targetMediaType?: 'image' | 'video';
  role?: 'prompt' | 'firstFrame';
  assetId: string;
  sourceMode?: 'source' | 'transform';
  contentUrl?: string | null;
  mimeType?: string;
  prompt?: string;
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
      ...(options.sourceMode === 'transform' ? { modelAlias: 'source-model' } : {}),
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
    },
  };
  return {
    projectId,
    canvasRevision: 1,
    targetNodeId: target.id,
    modelAlias: 'target-model',
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
  mediaType: 'image';
  repeat?: boolean;
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
  const target = {
    id: 'node_target',
    type: 'image' as const,
    position: { x: 200, y: 0 },
    data: {
      label: 'Target',
      mediaType: 'image' as const,
      mode: 'generate' as const,
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
    modelAlias: 'target-model',
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
  mediaType: 'text' | 'image',
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

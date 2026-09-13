import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { RunResultAsset, RunSnapshot } from '@multimodal-canvas/domain';

import { applyVideoFinalFrame } from './final-frame';
import type { ResultBlobStore } from './result-archiver';

const projectId = '123e4567-e89b-12d3-a456-426614174000';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function videoSnapshot(
  action?: RunSnapshot['nodes'][number]['data']['completionAction'],
): RunSnapshot {
  return {
    projectId,
    canvasRevision: 1,
    targetNodeId: 'node_video',
    modelAlias: 'video-model',
    parameters: {},
    submittedAt: '2026-09-13T00:00:00.000Z',
    nodes: [
      {
        id: 'node_video',
        type: 'video',
        position: { x: 10, y: 20 },
        data: {
          label: '镜头',
          mediaType: 'video',
          mode: 'generate',
          ...(action ? { completionAction: action } : {}),
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

const archived: RunResultAsset = {
  assetId: '123e4567-e89b-12d3-a456-426614174010',
  version: 1,
  contentUrl: '/v1/assets/123e4567-e89b-12d3-a456-426614174010',
};

function blobStore(): ResultBlobStore & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async put(key: string) {
      puts.push(key);
    },
    async delete() {},
  };
}

describe('applyVideoFinalFrame', () => {
  it('skips extraction when the node action is omitted', async () => {
    const blob = blobStore();
    const result = await applyVideoFinalFrame({
      runId: 'run-1',
      snapshot: videoSnapshot(),
      archived,
      content: Buffer.from('video'),
      videoMimeType: 'video/mp4',
      contentKey: 'assets/video/v1',
      prisma: {} as PrismaClient,
      blobStore: blob,
      timeoutMs: 1000,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ status: 'skipped', action: 'none' });
    expect(blob.puts).toEqual([]);
  });

  it('stores a preview derivative without creating an image asset', async () => {
    const blob = blobStore();
    const updates: unknown[] = [];
    const prisma = {
      asset: {
        async findUnique() {
          return { metadata: {} };
        },
        async update(args: unknown) {
          updates.push(args);
        },
      },
    } as unknown as PrismaClient;
    const result = await applyVideoFinalFrame({
      runId: 'run-2',
      snapshot: videoSnapshot('preview_final_frame'),
      archived,
      content: Buffer.from('video'),
      videoMimeType: 'video/mp4',
      contentKey: 'assets/video/v1',
      prisma,
      blobStore: blob,
      timeoutMs: 1000,
      maxBytes: 1024,
      extractor: async () => ({ content: jpeg, mimeType: 'image/jpeg', seekWindowSeconds: 1 }),
    });
    expect(result.status).toBe('ready');
    expect(result.assetId).toBeUndefined();
    expect(result.previewUrl).toContain('/derivatives/final_frame');
    expect(blob.puts).toEqual(['assets/video/v1.derivatives/final_frame']);
    expect(updates).toHaveLength(1);
  });

  it('keeps the video successful when ffmpeg is missing', async () => {
    const result = await applyVideoFinalFrame({
      runId: 'run-3',
      snapshot: videoSnapshot('create_asset'),
      archived,
      content: Buffer.from('video'),
      videoMimeType: 'video/mp4',
      contentKey: 'assets/video/v1',
      prisma: {} as PrismaClient,
      blobStore: blobStore(),
      timeoutMs: 1000,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({
      status: 'failed',
      action: 'create_asset',
      errorCode: 'FFMPEG_UNAVAILABLE',
    });
  });
});

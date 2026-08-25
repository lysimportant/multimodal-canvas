import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ProviderJob, RunResult, RunSnapshot } from '@multimodal-canvas/domain';

import { PrismaResultAssetArchiver, type ResultBlobStore } from './result-archiver';

const projectId = '123e4567-e89b-12d3-a456-426614174000';
const userId = '123e4567-e89b-12d3-a456-426614174001';
const snapshot: RunSnapshot = {
  projectId,
  canvasRevision: 3,
  targetNodeId: 'node_text',
  modelAlias: 'gpt-test',
  parameters: { temperature: 0.2 },
  submittedAt: '2026-08-26T00:00:00.000Z',
  nodes: [
    {
      id: 'node_text',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: 'Generated copy', mediaType: 'text', mode: 'generate' },
    },
  ],
  edges: [],
  inputs: [],
};
const result: RunResult = {
  provider: 'newapi',
  summary: 'generated',
  targetNodeId: 'node_text',
  mediaType: 'text',
  inputCount: 0,
};
const providerJob: ProviderJob = {
  id: 'provider_job_1',
  provider: 'newapi',
  status: 'running',
  progress: 80,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

describe('PrismaResultAssetArchiver', () => {
  it('stores text output and creates an asset version with provenance metadata', async () => {
    const blob = createBlobStore();
    const rows: Record<string, unknown>[] = [];
    const prisma = fakePrisma(async (data) => {
      rows.push(data);
    });
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob });

    const archived = await archiver.archive({
      runId: 'run_1',
      userId,
      snapshot,
      result,
      providerJob,
      archiveInput: {
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('hello canvas', 'utf8'),
        metadata: { format: 'txt' },
      },
    });

    expect(archived).toMatchObject({
      version: 1,
      contentUrl: expect.stringMatching(/^\/v1\/assets\/.+\/content$/),
      mimeType: 'text/plain',
      sizeBytes: 12,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(blob.puts).toHaveLength(1);
    expect(blob.puts[0].content.toString('utf8')).toBe('hello canvas');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: archived?.assetId,
      projectId,
      ownerId: userId,
      contentKey: expect.stringContaining(`assets/${archived?.assetId}/v1`),
    });
    expect(rows[1]).toMatchObject({ assetId: archived?.assetId, version: 1 });
    expect(rows[0].metadata).toMatchObject({
      generated: true,
      runId: 'run_1',
      modelAlias: 'gpt-test',
      format: 'txt',
      parameters: { temperature: 0.2 },
    });
  });

  it('downloads a remote image URL with a bounded response', async () => {
    const blob = createBlobStore();
    const rows: Record<string, unknown>[] = [];
    const prisma = fakePrisma(async (data) => {
      rows.push(data);
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      }),
    );
    const archiver = new PrismaResultAssetArchiver(prisma, {
      blobStore: blob,
      fetchImpl,
      maxBytes: 10,
    });

    const archived = await archiver.archive({
      runId: 'run_image',
      snapshot: {
        ...snapshot,
        targetNodeId: 'node_image',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
      },
      result: { ...result, targetNodeId: 'node_image', mediaType: 'image' },
      providerJob,
      archiveInput: {
        mediaType: 'image',
        mimeType: 'image/png',
        contentUrl: 'https://cdn.example/image.png',
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example/image.png', {
      signal: expect.any(AbortSignal),
      redirect: 'error',
    });
    expect(archived?.mimeType).toBe('image/png');
    expect(blob.puts[0].content).toEqual(Buffer.from([1, 2, 3]));
    expect(rows).toHaveLength(2);
  });

  it('removes the blob if the database transaction fails', async () => {
    const blob = createBlobStore();
    const prisma = fakePrisma(async () => {
      throw new Error('database unavailable');
    });
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob });

    await expect(
      archiver.archive({
        runId: 'run_failed',
        snapshot,
        result,
        providerJob,
        archiveInput: { mediaType: 'text', mimeType: 'text/plain', content: Buffer.from('x') },
      }),
    ).rejects.toThrow('database unavailable');
    expect(blob.deletes).toHaveLength(1);
    expect(blob.deletes[0]).toBe(blob.puts[0].key);
  });

  it('rejects private provider URLs before making a network request', async () => {
    const blob = createBlobStore();
    const prisma = fakePrisma(async () => undefined);
    const fetchImpl = vi.fn<typeof fetch>();
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob, fetchImpl });

    await expect(
      archiver.archive({
        runId: 'run_private',
        snapshot: {
          ...snapshot,
          targetNodeId: 'node_image',
          nodes: [
            {
              id: 'node_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Image', mediaType: 'image', mode: 'generate' },
            },
          ],
        },
        result: { ...result, targetNodeId: 'node_image', mediaType: 'image' },
        providerJob,
        archiveInput: {
          mediaType: 'image',
          mimeType: 'image/png',
          contentUrl: 'https://127.0.0.1/private.png',
        },
      }),
    ).rejects.toThrow('private host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createBlobStore() {
  const store: ResultBlobStore & {
    puts: Array<{ key: string; content: Buffer; contentType?: string }>;
    deletes: string[];
  } = {
    puts: [],
    deletes: [],
    async put(key, content, contentType) {
      this.puts.push({ key, content: Buffer.from(content), contentType });
    },
    async delete(key) {
      this.deletes.push(key);
    },
  };
  return store;
}

function fakePrisma(record: (data: Record<string, unknown>) => Promise<void>) {
  const prisma = {
    async $transaction(callback: (transaction: unknown) => Promise<unknown>) {
      const transaction = {
        asset: { create: async ({ data }: { data: Record<string, unknown> }) => record(data) },
        assetVersion: {
          create: async ({ data }: { data: Record<string, unknown> }) => record(data),
        },
      };
      return callback(transaction);
    },
  };
  return prisma as unknown as PrismaClient;
}

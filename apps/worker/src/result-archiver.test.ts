import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ProviderJob, RunResult, RunSnapshot } from '@multimodal-canvas/domain';

import {
  PrismaResultAssetArchiver,
  WorkerFfprobeMediaMetadataExtractor,
  WorkerS3BlobStore,
  type ResultBlobStore,
} from './result-archiver';

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
  it('rejects DNS rebinding at the actual socket lookup without connecting to loopback', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('private');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const lookupHost = vi
      .fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const archiver = new PrismaResultAssetArchiver(
      fakePrisma(async () => undefined),
      {
        blobStore: createBlobStore(),
        strictDns: true,
        allowHttp: true,
        lookupHost,
        fetchTimeoutMs: 1000,
      },
    );
    try {
      await expect(
        archiver.archive({
          runId: 'dns-rebinding',
          snapshot,
          result,
          providerJob,
          archiveInput: {
            mediaType: 'image',
            mimeType: 'image/png',
            contentUrl: `http://public-provider.example:${address.port}/private`,
          },
        }),
      ).rejects.toThrow('transport failed');
      expect(lookupHost).toHaveBeenCalledTimes(2);
      expect(requests).toBe(0);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });

  it.each(['put', 'delete'] as const)('bounds a real stalled S3 %s request', async (method) => {
    const server = createServer((request) => {
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const storage = new WorkerS3BlobStore('media-test', {
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      accessKeyId: 'synthetic-test-user',
      secretAccessKey: 'synthetic-test-secret',
      timeoutMs: 100,
    });
    try {
      await expect(
        method === 'put'
          ? storage.put('media-test/object', Buffer.from('media'))
          : storage.delete('media-test/object'),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });

  it('archives MIME from the HTTP response and diagnoses failed auxiliary processing', async () => {
    const rows: Record<string, unknown>[] = [];
    const blob = createBlobStore();
    const archiver = new PrismaResultAssetArchiver(
      fakePrisma(async (data) => {
        rows.push(data);
      }),
      {
        blobStore: blob,
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('image', { headers: { 'content-type': 'image/webp' } })),
        metadataExtractor: {
          extract: async () => {
            throw new Error('synthetic-tool-secret');
          },
        },
        derivativeGenerator: {
          generate: async () => {
            throw new Error('synthetic-tool-secret');
          },
        },
      },
    );
    const archived = await archiver.archive({
      runId: 'mime-test',
      snapshot,
      result,
      providerJob,
      archiveInput: {
        mediaType: 'image',
        mimeType: 'image/png',
        contentUrl: 'https://cdn.example/image',
        metadata: {
          format:
            'https://synthetic-user:synthetic-tool-secret@cdn.example/a?signature=synthetic-tool-secret',
        },
      },
    });
    expect(archived?.mimeType).toBe('image/webp');
    expect(rows[0].metadata).toMatchObject({
      metadataStatus: 'failed',
      derivativeStatus: 'failed',
    });
    expect(JSON.stringify(rows.map((row) => row.metadata))).not.toContain('synthetic-tool-secret');
    expect(blob.puts).toHaveLength(1);
  });

  it('cancels rejected HTTP response bodies before writing an asset', async () => {
    for (const responseOptions of [
      { status: 503 },
      { headers: { 'content-length': '9999' } },
      { headers: { 'content-type': 'text/html' } },
    ] as ResponseInit[]) {
      const cancel = vi.fn();
      const blob = createBlobStore();
      const response = new Response(new ReadableStream({ cancel }), responseOptions);
      const archiver = new PrismaResultAssetArchiver(
        fakePrisma(async () => undefined),
        {
          blobStore: blob,
          maxBytes: 10,
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
        },
      );
      await expect(
        archiver.archive({
          runId: 'rejected-body',
          snapshot,
          result,
          providerJob,
          archiveInput: {
            mediaType: 'image',
            mimeType: 'image/png',
            contentUrl: 'https://cdn.example/image',
          },
        }),
      ).rejects.toThrow(/download|limit/);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(blob.puts).toHaveLength(0);
    }
  });

  it('bounds DNS lookup and prevents a request after cancellation during lookup', async () => {
    for (const cancelDuringLookup of [false, true]) {
      const controller = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>();
      const archiver = new PrismaResultAssetArchiver(
        fakePrisma(async () => undefined),
        {
          blobStore: createBlobStore(),
          strictDns: true,
          fetchTimeoutMs: 20,
          fetchImpl,
          lookupHost: async () => {
            if (cancelDuringLookup) {
              controller.abort();
              return [{ address: '8.8.8.8', family: 4 }];
            }
            return new Promise(() => undefined);
          },
        },
      );
      await expect(
        archiver.archive({
          runId: 'dns-timeout',
          snapshot,
          result,
          providerJob,
          signal: controller.signal,
          archiveInput: {
            mediaType: 'image',
            mimeType: 'image/png',
            contentUrl: 'https://cdn.example/image',
          },
        }),
      ).rejects.toThrow(/cancelled|cancellation|timed out/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it.each([
    'http://[::ffff:127.0.0.1]/a',
    'http://[::ffff:a00:1]/a',
    'http://100.64.0.1/a',
    'http://0.0.0.1/a',
  ])('rejects non-public address %s', async (contentUrl) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const archiver = new PrismaResultAssetArchiver(
      fakePrisma(async () => undefined),
      { blobStore: createBlobStore(), fetchImpl },
    );
    await expect(
      archiver.archive({
        runId: 'private-address',
        snapshot,
        result,
        providerJob,
        archiveInput: { mediaType: 'image', mimeType: 'image/png', contentUrl },
      }),
    ).rejects.toThrow('private host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a real HTTP response stalled after headers without leaking signed URL text', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const blob = createBlobStore();
    const archiver = new PrismaResultAssetArchiver(
      fakePrisma(async () => undefined),
      {
        blobStore: blob,
        fetchTimeoutMs: 150,
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
      },
    );
    try {
      await expect(
        archiver.archive({
          runId: 'stream-timeout',
          snapshot,
          result,
          providerJob,
          archiveInput: {
            mediaType: 'image',
            mimeType: 'image/png',
            contentUrl: 'https://cdn.example/a?signature=synthetic-signature',
          },
        }),
      ).rejects.toThrow('timed out');
      expect(blob.puts).toHaveLength(0);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });

  it('keeps possibly committed blobs when database reconciliation is unavailable', async () => {
    const blob = createBlobStore();
    const prisma = fakePrisma(async () => {
      throw new Error('commit outcome unknown');
    });
    Object.assign(prisma, {
      asset: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error('database unavailable')),
      },
    });
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob });
    await expect(
      archiver.archive({
        runId: 'unknown-commit',
        snapshot,
        result,
        providerJob,
        archiveInput: {
          mediaType: 'text',
          mimeType: 'text/plain',
          content: Buffer.from('original'),
        },
      }),
    ).rejects.toThrow('commit outcome unknown');
    expect(blob.puts).toHaveLength(1);
    expect(blob.deletes).toHaveLength(0);
  });

  it('cleans both original and derivative after a confirmed failed transaction', async () => {
    const blob = createBlobStore();
    const archiver = new PrismaResultAssetArchiver(
      fakePrisma(async () => {
        throw new Error('rollback');
      }),
      {
        blobStore: blob,
        derivativeGenerator: {
          generate: async () => [
            { kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('jpeg') },
          ],
        },
      },
    );
    await expect(
      archiver.archive({
        runId: 'rollback-derivatives',
        snapshot,
        result,
        providerJob,
        archiveInput: {
          mediaType: 'image',
          mimeType: 'image/png',
          content: Buffer.from('original'),
        },
      }),
    ).rejects.toThrow('rollback');
    expect(blob.puts).toHaveLength(2);
    expect(blob.deletes).toEqual(blob.puts.map((entry) => entry.key));
  });

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
      contentUrl: expect.stringMatching(/^\/v1\/assets\/.+\/versions\/1\/content$/),
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

  it('replays the same archive identity without creating a duplicate asset', async () => {
    const blob = createBlobStore();
    const state = statefulPrisma();
    const { prisma } = state;
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob });
    const input = {
      runId: 'run_archive_replay',
      snapshot,
      result,
      providerJob,
      archiveKey: 'snapshot-1:node_text:provider-job-1',
      archiveInput: {
        mediaType: 'text' as const,
        mimeType: 'text/plain',
        content: Buffer.from('same charged result'),
      },
    };

    const first = await archiver.archive(input);
    const replay = await archiver.archive(input);

    expect(replay).toEqual(first);
    expect(state.transactions).toBe(1);
    expect(blob.puts).toHaveLength(1);
  });

  it('rejects different content for an existing archive identity', async () => {
    const blob = createBlobStore();
    const { prisma } = statefulPrisma();
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob });
    const common = {
      runId: 'run_archive_collision',
      snapshot,
      result,
      providerJob,
      archiveKey: 'snapshot-1:node_text:provider-job-collision',
    };

    await archiver.archive({
      ...common,
      archiveInput: {
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('first result'),
      },
    });
    await expect(
      archiver.archive({
        ...common,
        archiveInput: {
          mediaType: 'text',
          mimeType: 'text/plain',
          content: Buffer.from('different result'),
        },
      }),
    ).rejects.toThrow('result archive identity collision');
    expect(blob.puts).toHaveLength(1);
  });

  it('aborts a remote result download before asset creation', async () => {
    const blob = createBlobStore();
    const prisma = fakePrisma(async () => undefined);
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      providerSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    });
    const archiver = new PrismaResultAssetArchiver(prisma, { blobStore: blob, fetchImpl });
    const pending = archiver.archive({
      runId: 'run_archive_cancel',
      snapshot,
      result,
      providerJob,
      signal: controller.signal,
      archiveInput: {
        mediaType: 'text',
        mimeType: 'text/plain',
        contentUrl: 'https://cdn.example/cancel.txt',
      },
    });

    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
    expect(blob.puts).toHaveLength(0);
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

  it('downloads and archives a generated video with ffprobe metadata', async () => {
    const blob = createBlobStore();
    const rows: Record<string, unknown>[] = [];
    const prisma = fakePrisma(async (data) => {
      rows.push(data);
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '8' },
      }),
    );
    const runner = vi.fn().mockResolvedValue(
      JSON.stringify({
        format: { format_name: 'mov,mp4', duration: '4.5', size: '8' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            r_frame_rate: '30/1',
          },
        ],
      }),
    );
    const archiver = new PrismaResultAssetArchiver(prisma, {
      blobStore: blob,
      fetchImpl,
      metadataExtractor: new WorkerFfprobeMediaMetadataExtractor({ binary: 'ffprobe', runner }),
    });
    const videoSnapshot: RunSnapshot = {
      ...snapshot,
      targetNodeId: 'node_video',
      nodes: [
        {
          id: 'node_video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: { label: 'Generated video', mediaType: 'video', mode: 'generate' },
        },
      ],
    };
    const videoProviderJob: ProviderJob = {
      ...providerJob,
      platformJobId: 'platform-video-1',
    };

    const archived = await archiver.archive({
      runId: 'run_video',
      snapshot: videoSnapshot,
      result: { ...result, targetNodeId: 'node_video', mediaType: 'video' },
      providerJob: videoProviderJob,
      archiveInput: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        contentUrl: 'https://cdn.example/generated.mp4',
      },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      'ffprobe',
      expect.arrayContaining(['-show_format', '-show_streams']),
      10_000,
    );
    expect(archived).toMatchObject({ mimeType: 'video/mp4', sizeBytes: 8 });
    expect(rows[0]).toMatchObject({
      mediaType: 'VIDEO',
      metadata: {
        platformJobId: 'platform-video-1',
        format: 'mov,mp4',
        durationSeconds: 4.5,
        codec: 'h264',
        width: 1280,
        height: 720,
        frameRate: 30,
      },
    });
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

  it('rejects a public-looking hostname that resolves to a private address', async () => {
    const blob = createBlobStore();
    const prisma = fakePrisma(async () => undefined);
    const fetchImpl = vi.fn<typeof fetch>();
    const archiver = new PrismaResultAssetArchiver(prisma, {
      blobStore: blob,
      fetchImpl,
      strictDns: true,
      lookupHost: async () => [{ address: '10.0.0.8', family: 4 }],
    });

    await expect(
      archiver.archive({
        runId: 'run_dns_private',
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
          contentUrl: 'https://cdn.example/private.png',
        },
      }),
    ).rejects.toThrow('resolves to a private host');
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

function statefulPrisma(): { prisma: PrismaClient; readonly transactions: number } {
  let assetRow:
    | {
        id: string;
        projectId: string;
        mediaType: string;
        mimeType: string;
        sizeBytes: bigint;
        sha256: string;
        contentKey: string;
        versions: Array<{
          version: number;
          sizeBytes: bigint;
          sha256: string;
          contentKey: string;
        }>;
      }
    | undefined;
  let transactionCount = 0;
  const prisma = {
    asset: {
      async findUnique() {
        return assetRow ? structuredClone(assetRow) : null;
      },
    },
    async $transaction(callback: (transaction: unknown) => Promise<unknown>) {
      transactionCount += 1;
      let createdAsset: Record<string, unknown> | undefined;
      let createdVersion: Record<string, unknown> | undefined;
      const result = await callback({
        asset: {
          async create({ data }: { data: Record<string, unknown> }) {
            createdAsset = data;
          },
        },
        assetVersion: {
          async create({ data }: { data: Record<string, unknown> }) {
            createdVersion = data;
          },
        },
      });
      if (createdAsset && createdVersion) {
        assetRow = {
          id: String(createdAsset.id),
          projectId: String(createdAsset.projectId),
          mediaType: String(createdAsset.mediaType),
          mimeType: String(createdAsset.mimeType),
          sizeBytes: BigInt(createdAsset.sizeBytes as bigint),
          sha256: String(createdAsset.sha256),
          contentKey: String(createdAsset.contentKey),
          versions: [
            {
              version: Number(createdVersion.version),
              sizeBytes: BigInt(createdVersion.sizeBytes as bigint),
              sha256: String(createdVersion.sha256),
              contentKey: String(createdVersion.contentKey),
            },
          ],
        };
      }
      return result;
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    get transactions() {
      return transactionCount;
    },
  };
}

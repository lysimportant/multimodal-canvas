import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSystemBlobStore, MemoryBlobStore, PrismaAssetStore } from './assets';

describe('BlobStore implementations', () => {
  it('copies bytes in memory and persists bytes in a local directory', async () => {
    const memory = new MemoryBlobStore();
    const source = Buffer.from('hello');
    await memory.put('a/b', source);
    source[0] = 0;
    expect(await memory.get('a/b')).toEqual(Buffer.from('hello'));

    const root = await mkdtemp(join(tmpdir(), 'multimodal-assets-'));
    const files = new FileSystemBlobStore(root);
    await files.put('a/b', Buffer.from('hello'));
    expect(await files.get('a/b')).toEqual(Buffer.from('hello'));
    expect(await readFile(join(root, 'a', 'b'))).toEqual(Buffer.from('hello'));
    await files.delete('a/b');
    expect(await files.get('a/b')).toBeUndefined();
  });

  it('rejects absolute and traversal keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multimodal-assets-'));
    const files = new FileSystemBlobStore(root);
    await expect(files.put('../outside', Buffer.from('x'))).rejects.toThrow(/escapes/);
    await expect(files.get(join(root, 'outside'))).rejects.toThrow(/relative/);
  });
});

describe('PrismaAssetStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores metadata and version bytes behind a BlobStore', async () => {
    const blobStore = new MemoryBlobStore();
    const prisma = createFakePrisma();
    const store = new PrismaAssetStore(prisma as never, { blobStore, projectId: 'project-1' });

    const created = await store.create({
      name: 'prompt.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('hello'),
      tags: ['prompt'],
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(await blobStore.get(`assets/${created.id}/v1`)).toEqual(Buffer.from('hello'));

    expect((await store.list())[0]).toMatchObject({ id: created.id, name: 'prompt.txt' });
    expect((await store.get(created.id))?.content).toEqual(Buffer.from('hello'));

    const version = await store.createVersion(created.id, {
      content: Buffer.from('hello v2'),
      metadata: { sourceRunId: 'run-1' },
    });
    expect(version).toMatchObject({ assetId: created.id, version: 2, sizeBytes: 8 });
    expect(await store.getVersionContent(created.id, 2)).toEqual(Buffer.from('hello v2'));
    expect(await store.listVersions(created.id)).toHaveLength(2);

    expect((await store.setArchived(created.id, true))?.status).toBe('archived');
    expect((await store.setArchived(created.id, false))?.status).toBe('ready');
  });

  it('does not expose assets from another project', async () => {
    const prisma = createFakePrisma();
    const store = new PrismaAssetStore(prisma as never, {
      blobStore: new MemoryBlobStore(),
      projectId: 'project-1',
    });
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.update('missing', { name: 'x' })).toBeUndefined();
    expect(await store.setArchived('missing', true)).toBeUndefined();
  });

  it('can explicitly scope global owner assets without widening to other projects', async () => {
    const prisma = createFakePrisma();
    const store = new PrismaAssetStore(prisma as never, { blobStore: new MemoryBlobStore() });

    await store.get('missing', { projectId: null, ownerId: 'owner-1' });

    expect(prisma.asset.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'missing', projectId: null, ownerId: 'owner-1' },
    });
  });
});

type FakeAsset = {
  id: string;
  projectId: string | null;
  ownerId: string | null;
  name: string;
  mediaType: string;
  mimeType: string;
  sizeBytes: bigint;
  sha256: string | null;
  status: string;
  contentKey: string;
  tags: string[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeVersion = {
  id: string;
  assetId: string;
  version: number;
  sizeBytes: bigint;
  sha256: string | null;
  contentKey: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

function createFakePrisma() {
  const assets = new Map<string, FakeAsset>();
  const versions = new Map<string, FakeVersion>();
  const now = () => new Date();
  const asset = {
    create: vi.fn(async ({ data }: { data: Partial<FakeAsset> & { id: string } }) => {
      const row = {
        projectId: null,
        ownerId: null,
        status: 'READY',
        tags: [],
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
        ...data,
      } as FakeAsset;
      assets.set(row.id, row);
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where?: { projectId?: string } } = {}) =>
      [...assets.values()].filter((row) => !where?.projectId || row.projectId === where.projectId),
    ),
    findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
      const row = assets.get(where.id);
      return row && (!where.projectId || row.projectId === where.projectId) ? row : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeAsset> }) => {
      const row = assets.get(where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: now() });
      return row;
    }),
  };
  const assetVersion = {
    create: vi.fn(
      async ({ data }: { data: Partial<FakeVersion> & { assetId: string; version: number } }) => {
        const row = {
          id: `${data.assetId}-${data.version}`,
          sizeBytes: 0n,
          sha256: null,
          metadata: null,
          createdAt: now(),
          ...data,
        } as FakeVersion;
        versions.set(`${row.assetId}:${row.version}`, row);
        return row;
      },
    ),
    findFirst: vi.fn(
      async ({
        where,
        orderBy,
      }: {
        where: { assetId: string; version?: number };
        orderBy?: unknown;
      }) => {
        const matching = [...versions.values()].filter(
          (row) =>
            row.assetId === where.assetId &&
            (where.version === undefined || row.version === where.version),
        );
        if (orderBy) return matching.sort((a, b) => b.version - a.version)[0] ?? null;
        return matching[0] ?? null;
      },
    ),
    findMany: vi.fn(async ({ where }: { where: { assetId: string } }) =>
      [...versions.values()]
        .filter((row) => row.assetId === where.assetId)
        .sort((a, b) => a.version - b.version),
    ),
  };
  const prisma = {
    asset,
    assetVersion,
    $transaction: vi.fn(async (callback: (transaction: typeof prisma) => unknown) =>
      callback(prisma),
    ),
  };
  return prisma;
}

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAssetStore, MemoryBlobStore, PrismaAssetStore, type BlobObjectInfo } from './assets';
import {
  hasActiveCountdown,
  isGeneratedAsset,
  isGeneratedAssetExpired,
  RETENTION_WINDOW_MS,
  STORAGE_EVICTION_THRESHOLD_BYTES,
  withStorageEvictionMarker,
} from './asset-retention-policy';
import { registerAssetExpiration } from './asset-expiration';

const generatedAt = '2026-10-23T00:00:00.000Z';
const expiresAt = '2026-10-26T00:00:00.000Z';
const deadline = Date.parse(expiresAt);
const metadata = { source: 'run', runId: 'run-test', generatedAt, expiresAt, retentionHours: 72 };

afterEach(() => vi.useRealTimers());

/** 支持列举的内存对象存储，用来验证孤儿对象回收。 */
class ListingBlobStore extends MemoryBlobStore {
  private readonly entries: BlobObjectInfo[] = [];

  constructor(entries: Array<[string, number, number]>) {
    super();
    for (const [key, sizeBytes, lastModifiedMs] of entries)
      this.entries.push({ key, sizeBytes, lastModifiedMs });
  }

  async *list(prefix: string): AsyncIterable<BlobObjectInfo> {
    for (const entry of [...this.entries]) if (entry.key.startsWith(prefix)) yield entry;
  }

  async delete(key: string): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.key === key);
    if (index >= 0) this.entries.splice(index, 1);
    await super.delete(key);
  }

  keys(): string[] {
    return this.entries.map((entry) => entry.key);
  }
}

describe('generated resource retention', () => {
  it('requires the explicit 72-hour policy and expires exactly at the boundary', () => {
    expect(isGeneratedAssetExpired(metadata, deadline - 1)).toBe(false);
    expect(isGeneratedAssetExpired(metadata, deadline)).toBe(true);
    for (const legacy of [
      undefined,
      {},
      { runId: 'old' },
      { expiresAt },
      { ...metadata, retentionHours: 24 },
      { ...metadata, generatedAt: 'invalid' },
    ]) {
      expect(isGeneratedAssetExpired(legacy, deadline)).toBe(false);
    }
  });

  it('accepts the eviction marker as a 72-hour countdown from the marking moment', () => {
    const markedAt = Date.parse('2026-11-05T00:00:00.000Z');
    const marked = withStorageEvictionMarker({ generated: true, generatedAt }, markedAt);
    expect(marked).toMatchObject({
      retentionHours: 72,
      evictionReason: 'storage_pressure',
      evictionStartedAt: '2026-11-05T00:00:00.000Z',
      expiresAt: '2026-11-08T00:00:00.000Z',
    });
    expect(Date.parse(String(marked.expiresAt)) - markedAt).toBe(RETENTION_WINDOW_MS);
    expect(hasActiveCountdown(marked, markedAt)).toBe(true);
    expect(isGeneratedAssetExpired(marked, markedAt + RETENTION_WINDOW_MS - 1)).toBe(false);
    expect(isGeneratedAssetExpired(marked, markedAt + RETENTION_WINDOW_MS)).toBe(true);
    // 已有倒计时不会被覆盖或撤销，即使资源已经过期。
    const later = withStorageEvictionMarker(marked, markedAt + 60_000);
    expect(later.expiresAt).toBe(marked.expiresAt);
    expect(later.evictionStartedAt).toBe(marked.evictionStartedAt);
  });

  it('only treats generated resources as evictable', () => {
    expect(isGeneratedAsset({ generated: true })).toBe(true);
    expect(isGeneratedAsset({ generatedAt })).toBe(true);
    for (const upload of [
      undefined,
      {},
      { name: 'upload.png' },
      { generated: false },
      { generatedAt: 'x' },
    ])
      expect(isGeneratedAsset(upload)).toBe(false);
  });

  it('blocks content and late stream opens before cleanup, then purges all memory bytes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deadline - 1);
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'generated.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('generated'),
      metadata,
      derivatives: { thumbnail: { content: Buffer.from('preview'), mimeType: 'image/jpeg' } },
    });
    await store.createVersion(asset.id, { content: Buffer.from('version 2') });
    const source = await store.getContentSource(asset.id);
    const version = await store.getVersionContentSource(asset.id, 1);
    expect(await store.get(asset.id)).toBeDefined();
    vi.setSystemTime(deadline);
    expect(await source!.open()).toBeUndefined();
    expect(await version!.open()).toBeUndefined();
    expect(await store.get(asset.id)).toBeUndefined();
    expect(await store.getContentSource(asset.id)).toBeUndefined();
    expect(await store.hasContent(asset.id)).toBe(false);
    expect(await store.getDerivative(asset.id, 'thumbnail')).toBeUndefined();
    expect(await store.getVersionContent(asset.id, 1)).toBeUndefined();
    expect(await store.listVersions(asset.id)).toEqual([]);
    expect(
      await store.createVersion(asset.id, { content: Buffer.from('resurrection') }),
    ).toBeUndefined();
    expect(await store.setArchived(asset.id, false)).toBeUndefined();
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 1, failed: 0 });
    expect((await store.getMetadata(asset.id))?.metadata?.expiredAt).toBe(expiresAt);
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 0, failed: 0 });
    // 私有容器检查确保隐藏内容的同时确实释放了版本、预览和当前内容字节。
    const internals = store as unknown as {
      assets: Map<string, { content: Buffer }>;
      versions: Map<string, unknown>;
      derivatives: Map<string, unknown>;
    };
    expect(internals.assets.get(asset.id)?.content.byteLength).toBe(0);
    expect(internals.versions.has(asset.id)).toBe(false);
    expect(internals.derivatives.has(asset.id)).toBe(false);
  });

  it('keeps uploads, historical generated resources and unexpired resources', async () => {
    const store = new MemoryAssetStore();
    for (const policy of [
      undefined,
      { runId: 'historical' },
      { ...metadata, generatedAt: expiresAt, expiresAt: '2026-10-29T00:00:00.000Z' },
    ]) {
      await store.create({
        name: 'keep.txt',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('keep'),
        metadata: policy,
      });
    }
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 0, failed: 0 });
    expect((await store.list()).length).toBe(3);
  });

  it('marks the oldest generated resources only after the owner crosses the storage threshold', async () => {
    const store = new MemoryAssetStore();
    const ownerId = 'user-1';
    const internals = store as unknown as {
      assets: Map<string, { sizeBytes: number }>;
      assetTimes: Map<string, { createdAt: string; updatedAt: string }>;
    };
    const gib = 3 * 1024 ** 3; // 三个 3 GiB 生成资源 = 9 GiB，越过 10 GiB × 75% 阈值
    const create = async (
      name: string,
      metadata: Record<string, unknown>,
      createdAt: string,
    ): Promise<string> => {
      const asset = await store.create({
        name,
        mediaType: 'video',
        mimeType: 'video/mp4',
        content: Buffer.alloc(1),
        ownerId,
        metadata,
      });
      internals.assets.get(asset.id)!.sizeBytes = gib;
      internals.assetTimes.set(asset.id, { createdAt, updatedAt: createdAt });
      return asset.id;
    };
    const generated = { generated: true, generatedAt: '2026-11-01T00:00:00.000Z' };
    const oldest = await create('oldest.mp4', { ...generated }, '2026-11-01T00:00:00.000Z');
    const middle = await create('middle.mp4', { ...generated }, '2026-11-02T00:00:00.000Z');
    const newest = await create('newest.mp4', { ...generated }, '2026-11-03T00:00:00.000Z');
    const upload = await create('upload.png', {}, '2026-10-01T00:00:00.000Z');
    const now = Date.parse('2026-11-05T00:00:00.000Z');

    // 低于阈值时一个都不打标，上传资源永不参与淘汰。
    internals.assets.get(oldest)!.sizeBytes = 1;
    internals.assets.get(middle)!.sizeBytes = 1;
    expect(await store.evictUnderStoragePressure(now)).toEqual({ evicted: 0, bytes: 0 });

    // 越过阈值后从最早的生成资源开始打标，直到回落到阈值以下。
    internals.assets.get(oldest)!.sizeBytes = gib;
    internals.assets.get(middle)!.sizeBytes = gib;
    const first = await store.evictUnderStoragePressure(now);
    expect(first.evicted).toBeGreaterThan(0);
    const marked = (id: string) =>
      internals.assets.get(id)! as unknown as {
        metadata?: Record<string, unknown>;
      };
    expect(marked(oldest).metadata).toMatchObject({
      retentionHours: 72,
      evictionReason: 'storage_pressure',
    });
    expect(marked(upload).metadata?.retentionHours).toBeUndefined();
    expect(marked(upload).metadata?.expiresAt).toBeUndefined();
    expect(marked(newest).metadata?.expiresAt).toBeUndefined();

    // 已打标的倒计时不会被撤销，重复执行只补打剩下的资源。
    const startedAt = marked(oldest).metadata?.evictionStartedAt;
    const expiresAtMarked = marked(oldest).metadata?.expiresAt;
    await store.evictUnderStoragePressure(now);
    expect(marked(oldest).metadata?.evictionStartedAt).toBe(startedAt);
    expect(marked(oldest).metadata?.expiresAt).toBe(expiresAtMarked);
    expect(await store.evictUnderStoragePressure(now)).toEqual({ evicted: 0, bytes: 0 });
  });

  it('cleans database-backed versions and both derivative layouts, retries failed deletes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deadline);
    const blobs = new MemoryBlobStore();
    const row = {
      id: 'generated-asset',
      contentKey: 'assets/generated/v2',
      metadata: { ...metadata },
    };
    const versions = [{ contentKey: 'assets/generated/v1' }, { contentKey: row.contentKey }];
    const prisma = {
      asset: {
        findMany: vi.fn(async () => (row.metadata && !('expiredAt' in row.metadata) ? [row] : [])),
        findFirst: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: { metadata: typeof metadata } }) => {
          row.metadata = data.metadata;
          return row;
        }),
      },
      assetVersion: { findMany: vi.fn(async () => versions) },
    };
    const store = new PrismaAssetStore(prisma as never, { blobStore: blobs });
    const keys = [
      'assets/generated/v1',
      row.contentKey,
      'assets/generated/v1.derivatives/thumbnail',
      'assets/generated/v2/derivatives/poster',
      'assets/generated/v2.derivatives/final_frame',
    ];
    for (const key of keys) await blobs.put(key, Buffer.from('bytes'));
    await blobs.put('uploads/keep', Buffer.from('keep'));
    const deletion = vi.spyOn(blobs, 'delete');
    deletion.mockRejectedValueOnce(new Error('temporary storage failure'));
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 0, failed: 1 });
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(await store.get(row.id)).toBeUndefined();
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 1, failed: 0 });
    for (const key of keys) expect(await blobs.get(key)).toBeUndefined();
    expect(await blobs.get('uploads/keep')).toEqual(Buffer.from('keep'));
    expect(row.metadata).toMatchObject({ expiredAt: expiresAt });
    expect(await store.expireGeneratedAssets(deadline)).toEqual({ deleted: 0, failed: 0 });
  });

  it('walks owners through the database and stops marking once back under the threshold', async () => {
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    const gib = 1024 ** 3;
    type Row = {
      id: string;
      ownerId: string;
      sizeBytes: bigint;
      metadata: Record<string, unknown>;
      createdAt: Date;
    };
    const rows: Row[] = [
      {
        id: 'a-upload',
        ownerId: 'u-1',
        sizeBytes: BigInt(1 * gib),
        metadata: { name: 'upload.png' },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        id: 'b-oldest',
        ownerId: 'u-1',
        sizeBytes: BigInt(3 * gib),
        metadata: { generated: true, generatedAt: '2026-11-01T00:00:00.000Z' },
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      },
      {
        id: 'c-middle',
        ownerId: 'u-1',
        sizeBytes: BigInt(3 * gib),
        metadata: { generated: true, generatedAt: '2026-11-02T00:00:00.000Z' },
        createdAt: new Date('2026-11-02T00:00:00.000Z'),
      },
      {
        id: 'd-newest',
        ownerId: 'u-1',
        sizeBytes: BigInt(3 * gib),
        metadata: { generated: true, generatedAt: '2026-11-03T00:00:00.000Z' },
        createdAt: new Date('2026-11-03T00:00:00.000Z'),
      },
    ];
    type KeysetClause = { createdAt?: { gt?: Date }; id?: { gt?: string } };
    const prisma = {
      asset: {
        groupBy: vi.fn(async () => [{ ownerId: 'u-1', _sum: { sizeBytes: BigInt(10 * gib) } }]),
        findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
          let found = rows.filter((row) => !row.metadata.expiredAt);
          const gt = (where?.id as { gt?: string } | undefined)?.gt;
          if (gt) found = found.filter((row) => row.id > gt);
          const or = where?.OR as KeysetClause[] | undefined;
          if (or)
            found = found.filter((row) =>
              or.some((clause) =>
                clause.createdAt?.gt
                  ? row.createdAt > clause.createdAt.gt
                  : Boolean(clause.id?.gt) && row.id > (clause.id!.gt ?? ''),
              ),
            );
          return [...found].sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.id.localeCompare(right.id),
          );
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: { metadata: unknown } }) => {
            const row = rows.find((candidate) => candidate.id === where.id)!;
            row.metadata = data.metadata as Record<string, unknown>;
            return row;
          },
        ),
      },
    };
    const store = new PrismaAssetStore(prisma as never, { blobStore: new MemoryBlobStore() });
    // 10 GiB 超过 7.5 GiB 阈值；打掉最旧的 3 GiB 生成资源后回落到 7 GiB，立即停手，上传原件永不淘汰。
    const first = await store.evictUnderStoragePressure(now);
    expect(first.evicted).toBe(1);
    expect(rows.find((row) => row.id === 'b-oldest')!.metadata).toMatchObject({
      retentionHours: 72,
      evictionReason: 'storage_pressure',
    });
    expect(rows.find((row) => row.id === 'c-middle')!.metadata.retentionHours).toBeUndefined();
    expect(rows.find((row) => row.id === 'd-newest')!.metadata.retentionHours).toBeUndefined();
    expect(rows.find((row) => row.id === 'a-upload')!.metadata.expiresAt).toBeUndefined();
    // 已打标的字节离开水位后一轮即停手，不会继续追问更新的资源。
    expect(await store.evictUnderStoragePressure(now)).toEqual({ evicted: 0, bytes: 0 });
  });

  it('prunes unreferenced objects after the grace period and keeps live keys', async () => {
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const old = now - 3 * day;
    const blobs = new ListingBlobStore([
      ['assets/keep/v1', 10, old],
      ['assets/keep/v1.derivatives/thumbnail', 2, old],
      ['assets/ver/v2', 10, old],
      // 版本 1 已不在 assetVersion 表里，属于孤儿。
      ['assets/ver/v1', 10, old],
      // 资源行已过期（字节已删），残留对象也要回收。
      ['assets/gone/v1', 10, old],
      ['assets/orphan/v1', 10, old],
      // 宽限期内的新对象不动，避免删掉「写完字节但事务未提交」的资源。
      ['assets/fresh/v1', 10, now - 60 * 60 * 1000],
    ]);
    const prisma = {
      asset: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { gt?: string } } } = {}) => {
          const rows = [
            { id: 'a-keep', contentKey: 'assets/keep/v1', metadata: { generated: true } },
            {
              id: 'a-gone',
              contentKey: 'assets/gone/v1',
              metadata: { retentionHours: 72, expiredAt: expiresAt },
            },
          ];
          return where?.id?.gt ? rows.filter((row) => row.id > where.id!.gt!) : rows;
        }),
      },
      assetVersion: {
        findMany: vi.fn(async ({ where }: { where?: { id?: { gt?: string } } } = {}) => {
          const rows = [{ id: 'v-2', contentKey: 'assets/ver/v2' }];
          return where?.id?.gt ? rows.filter((row) => row.id > where.id!.gt!) : rows;
        }),
      },
    };
    const store = new PrismaAssetStore(prisma as never, { blobStore: blobs });
    expect(await store.pruneOrphanAssets(now)).toEqual({ evicted: 3, bytes: 30 });
    expect([...blobs.keys()].sort()).toEqual([
      'assets/fresh/v1',
      'assets/keep/v1',
      'assets/keep/v1.derivatives/thumbnail',
      'assets/ver/v2',
    ]);
    expect(await store.pruneOrphanAssets(now)).toEqual({ evicted: 0, bytes: 0 });
  });

  it('skips orphan pruning when the blob store cannot list objects', async () => {
    const store = new PrismaAssetStore(
      { asset: { findMany: vi.fn() }, assetVersion: { findMany: vi.fn() } } as never,
      { blobStore: new MemoryBlobStore() },
    );
    expect(await store.pruneOrphanAssets()).toEqual({ evicted: 0, bytes: 0 });
  });

  it('marks evictions before expiring and prunes orphans once at startup', async () => {
    vi.useFakeTimers();
    const store = new MemoryAssetStore();
    const order: string[] = [];
    vi.spyOn(store, 'evictUnderStoragePressure').mockImplementation(async () => {
      order.push('evict');
      return { evicted: 0, bytes: 0 };
    });
    vi.spyOn(store, 'expireGeneratedAssets').mockImplementation(async () => {
      order.push('expire');
      return { deleted: 0, failed: 0 };
    });
    const prune = vi.fn(async () => {
      order.push('prune');
      return { evicted: 0, bytes: 0 };
    });
    // 内存实现没有对象存储，孤儿回收只在支持列举的存储上存在。
    Object.assign(store, { pruneOrphanAssets: prune });
    const app = Fastify();
    registerAssetExpiration(app, store);
    await app.ready();
    expect(order).toEqual(['evict', 'expire', 'prune']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order).toEqual(['evict', 'expire', 'prune', 'evict', 'expire']);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(prune).toHaveBeenCalledTimes(2);
    await app.close();
    const calls = order.length;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(order).toHaveLength(calls);
  });

  it('sweeps on startup, periodically retries and stops its timer on close', async () => {
    vi.useFakeTimers();
    const store = new MemoryAssetStore();
    const sweep = vi
      .spyOn(store, 'expireGeneratedAssets')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ deleted: 0, failed: 0 });
    const app = Fastify();
    registerAssetExpiration(app, store);
    await app.ready();
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await app.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

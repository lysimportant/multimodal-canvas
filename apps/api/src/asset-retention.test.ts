import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAssetStore, MemoryBlobStore, PrismaAssetStore } from './assets';
import { isGeneratedAssetExpired } from './asset-retention-policy';
import { registerAssetExpiration } from './asset-expiration';

const generatedAt = '2026-10-23T00:00:00.000Z';
const expiresAt = '2026-10-26T00:00:00.000Z';
const deadline = Date.parse(expiresAt);
const metadata = { source: 'run', runId: 'run-test', generatedAt, expiresAt, retentionHours: 72 };

afterEach(() => vi.useRealTimers());

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

import { describe, expect, it } from 'vitest';

import { MemoryAssetStore, type AssetListOptions, type AssetScope } from './assets';
import { queryPrisma, queryRow } from './fixtures/asset-query';

describe('Prisma asset query boundaries', () => {
  it('returns only the requested 50 metadata rows for a 10000-row list/count pair', async () => {
    const fixture = queryPrisma(Array.from({ length: 10_000 }, (_, index) => queryRow(index)));
    const assets = await fixture.store.list({ ownerId: 'owner-a' }, { page: 37, pageSize: 50 });
    const total = await fixture.store.count({ ownerId: 'owner-a' });
    expect(assets).toHaveLength(50);
    expect(total).toBe(10_000);
    expect(fixture.returnedRows).toEqual([50]);
    expect(fixture.asset.count).toHaveBeenCalledOnce();
    expect(fixture.reads).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
  });

  it('pushes owner/project, media type, status, skip/take and a stable tie-breaker into Prisma', async () => {
    const fixture = queryPrisma([
      queryRow(2, { projectId: null }),
      queryRow(1, { projectId: null }),
      queryRow(3, { projectId: null, ownerId: 'owner-b' }),
      queryRow(4, { projectId: 'project-a' }),
      queryRow(5, { projectId: null, status: 'ARCHIVED' }),
      queryRow(6, { projectId: null, mediaType: 'VIDEO' }),
    ]);
    const scope = { ownerId: 'owner-a', projectId: null };
    const options = { mediaType: 'image', status: 'ready', page: 2, pageSize: 1 } as const;
    const result = await fixture.store.list(scope, options);
    expect(result.map((asset) => asset.id)).toEqual([queryRow(2).id]);
    expect(await fixture.store.count(scope, options)).toBe(2);
    const expectedWhere = { ...scope, mediaType: 'IMAGE', status: 'READY' };
    expect(fixture.asset.findMany).toHaveBeenCalledExactlyOnceWith({
      where: expectedWhere,
      skip: 1,
      take: 1,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        mediaType: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        status: true,
        tags: true,
        archivedAt: true,
        metadata: true,
        versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
      },
    });
    expect(fixture.asset.count).toHaveBeenCalledExactlyOnceWith({ where: expectedWhere });
    expect(result[0]).not.toHaveProperty('content');
    expect(result[0]).not.toHaveProperty('contentKey');
    expect(result[0]).not.toHaveProperty('ownerId');
    expect(result[0]).not.toHaveProperty('projectId');
  });

  it('honors store defaults while allowing an explicit global project scope', async () => {
    const fixture = queryPrisma(
      [
        queryRow(1),
        queryRow(2, { projectId: null }),
        queryRow(3, { projectId: null, ownerId: 'owner-b' }),
        queryRow(4, { ownerId: 'owner-b' }),
      ],
      { ownerId: 'owner-a', projectId: 'project-a' },
    );
    expect((await fixture.store.list()).map((asset) => asset.id)).toEqual([queryRow(1).id]);
    expect((await fixture.store.list({ projectId: null })).map((asset) => asset.id)).toEqual([
      queryRow(2).id,
    ]);
    expect(await fixture.store.count({ projectId: null })).toBe(1);
    expect((await fixture.store.list({ ownerId: 'owner-b' })).map((asset) => asset.id)).toEqual([
      queryRow(4).id,
    ]);
    const page = await fixture.store.listPage([{ projectId: null }, {}], { pageSize: 1, page: 2 });
    expect(page.total).toBe(2);
    expect(page.assets.map((asset) => asset.id)).toEqual([queryRow(1).id]);
  });

  it('does not implicitly hide archived rows and uses status rather than archivedAt to filter', async () => {
    const fixture = queryPrisma([
      queryRow(1),
      queryRow(2, { status: 'ARCHIVED', archivedAt: null }),
      queryRow(3, { status: 'ARCHIVED', archivedAt: new Date('2026-01-02') }),
    ]);
    expect(await fixture.store.count()).toBe(3);
    expect(await fixture.store.count({}, { status: 'archived' })).toBe(2);
    expect((await fixture.store.list({}, { status: 'archived' })).map((asset) => asset.id)).toEqual(
      [queryRow(2).id, queryRow(3).id],
    );
  });

  it('orders by updatedAt descending then id ascending across repeated pages', async () => {
    const fixture = queryPrisma([
      queryRow(4),
      queryRow(1),
      queryRow(3, { updatedAt: new Date('2026-01-02') }),
      queryRow(2),
    ]);
    const first = await fixture.store.list({}, { page: 1, pageSize: 2 });
    const second = await fixture.store.list({}, { page: 2, pageSize: 2 });
    expect([...first, ...second].map((asset) => asset.id)).toEqual(
      [3, 1, 2, 4].map((index) => queryRow(index).id),
    );
    expect(await fixture.store.list({}, { page: 2, pageSize: 2 })).toEqual(second);
  });

  it('selects the latest immutable version without exposing storage fields', async () => {
    const fixture = queryPrisma([queryRow(1, { metadata: { version: 99, alias: 'hero' } })]);
    const [asset] = await fixture.store.list();
    expect(asset).toMatchObject({ latestVersion: 3, metadata: { alias: 'hero', version: 3 } });
    expect(asset).not.toHaveProperty('versions');
    expect(asset).not.toHaveProperty('updatedAt');
    expect(fixture.reads).not.toHaveBeenCalled();
  });

  it.each([
    [{ page: 2 }, 50, 50],
    [{ pageSize: 7 }, 0, 7],
    [{ page: 0, pageSize: 0 }, 0, 50],
    [{ page: -1, pageSize: -1 }, 0, 50],
    [{ page: 1.5, pageSize: 1.5 }, 0, 50],
    [{ page: NaN, pageSize: Infinity }, 0, 50],
    [{ page: 2, pageSize: 1000 }, 200, 200],
  ] as const)(
    'normalizes pagination %j identically to the memory store',
    async (options, skip, take) => {
      const fixture = queryPrisma([]);
      await fixture.store.list({}, options);
      expect(fixture.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip, take }));
    },
  );

  it('preserves unpaged list calls and ignores pagination in count', async () => {
    const fixture = queryPrisma(Array.from({ length: 230 }, (_, index) => queryRow(index)));
    expect(await fixture.store.list()).toHaveLength(230);
    const call = fixture.asset.findMany.mock.calls[0]![0]!;
    expect(call).not.toHaveProperty('skip');
    expect(call).not.toHaveProperty('take');
    const options = { page: 999, pageSize: 1, status: 'ready' } as const;
    expect(await fixture.store.count({}, options)).toBe(230);
    expect(fixture.asset.count).toHaveBeenCalledExactlyOnceWith({ where: { status: 'READY' } });
  });

  it('treats blank query/tags as no search and leaves the input unchanged', async () => {
    const fixture = queryPrisma([queryRow(1)]);
    const options = Object.freeze({ query: ' \n ', tags: Object.freeze(['', '\t ']), pageSize: 1 });
    await fixture.store.list({}, options);
    expect(await fixture.store.count({}, options)).toBe(1);
    expect(fixture.asset.findMany).toHaveBeenCalledOnce();
    expect(fixture.asset.count).toHaveBeenCalledOnce();
    expect(options).toEqual({ query: ' \n ', tags: ['', '\t '], pageSize: 1 });
  });

  it('returns an empty deep page without passing an unsafe offset to Prisma', async () => {
    const fixture = queryPrisma([queryRow(1)]);
    expect(await fixture.store.list({}, { page: Number.MAX_SAFE_INTEGER, pageSize: 200 })).toEqual(
      [],
    );
    const page = await fixture.store.listPage([{}], {
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 200,
    });
    expect(page).toMatchObject({
      assets: [],
      total: 1,
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 200,
    });
    expect(fixture.asset.findMany).not.toHaveBeenCalled();
  });

  it('propagates metadata query failures instead of treating them as empty results', async () => {
    const fixture = queryPrisma([]);
    const error = new Error('synthetic database failure');
    fixture.asset.findMany.mockRejectedValueOnce(error);
    await expect(fixture.store.list({}, { pageSize: 1 })).rejects.toBe(error);
    fixture.asset.count.mockRejectedValueOnce(error);
    await expect(fixture.store.count()).rejects.toBe(error);
    fixture.asset.findMany.mockRejectedValueOnce(error);
    await expect(fixture.store.count({}, { query: 'hero' })).rejects.toBe(error);
  });
});

/** 合成两种仓库的同义输入，便于检查旧内存搜索合同而不是在 mock 里重复实现搜索。 */
async function searchFixture() {
  const rows = [
    queryRow(1, {
      name: '主视觉.png',
      tags: [' Product ', 'HERO', '　参考\t'],
      metadata: { alias: 'Canvas主视觉', aliases: ['Cover Art', 123, null, { title: 'hidden' }] },
    }),
    queryRow(2, { name: '50%_discount\\image.png', metadata: { aliases: ['Literal%_'] } }),
    queryRow(3, {
      name: 'İSTANBUL-ΟΣ-K.png',
      metadata: { alias: 'Σ', aliases: ['İstanbul', 'CAFÉ'] },
      tags: ['\u00a0ÉQUIPE\ufeff', '产品'],
    }),
    queryRow(4, { name: 'ignored-alias.png', metadata: { alias: 123, aliases: 'not-an-array' } }),
    queryRow(5, { name: 'array-metadata.png', metadata: ['not-an-object'] }),
    queryRow(6, { name: 'archived.png', status: 'ARCHIVED', metadata: { alias: 'Canvas' } }),
    queryRow(7, { name: 'hero-video', mediaType: 'VIDEO', mimeType: 'video/mp4', tags: ['hero'] }),
    queryRow(8, { name: 'foreign-hero', ownerId: 'owner-b', metadata: { alias: 'Canvas' } }),
    queryRow(9, { name: 'legacy-project-hero', ownerId: null }),
    queryRow(10, { name: 'personal-hero', projectId: null }),
  ];
  const memory = new MemoryAssetStore();
  for (const row of rows) {
    const asset = await memory.create({
      ...(row.projectId === null ? {} : { projectId: row.projectId }),
      ...(row.ownerId === null ? {} : { ownerId: row.ownerId }),
      name: row.name,
      mediaType: row.mediaType.toLowerCase() as 'image' | 'video',
      mimeType: row.mimeType,
      content: Buffer.from('synthetic'),
      tags: row.tags,
      metadata: row.metadata as Record<string, unknown> | undefined,
    });
    if (row.status === 'ARCHIVED') await memory.setArchived(asset.id, true);
  }
  return { ...queryPrisma(rows), memory };
}

describe('asset search compatibility and bounded scans', () => {
  it.each([
    { query: ' canvas主视觉 ' },
    { query: 'COVER ART' },
    { query: 'png' },
    { query: '参考' },
    { query: '%_' },
    { query: '\\image' },
    { query: 'image/png\u0000 Product ' },
    { query: 'i\u0307stanbul' },
    { query: 'ΟΣ' },
    { query: 'K' },
    { query: 'CAFÉ' },
    { query: 'hidden' },
    { query: '123' },
    { query: 'not-an-array' },
    { query: 'not-an-object' },
    { query: "' OR 1=1 --" },
    { tags: ['product', ' HERO ', '参考'] },
    { tags: ['équipe', '产品'] },
    { tags: ['hero', 'missing'] },
    { tags: ['hero', 'hero', ''] },
    { query: 'canvas', tags: ['product'], mediaType: 'image', status: 'ready' },
    { query: 'canvas', status: 'archived' },
    { query: 'hero', mediaType: 'video' },
  ] satisfies AssetListOptions[])(
    'matches memory search/count semantics for %j',
    async (options) => {
      const fixture = await searchFixture();
      const scope = { ownerId: 'owner-a' };
      const expected = await fixture.memory.list(scope, options);
      const actual = await fixture.store.list(scope, options);
      expect(actual.map((asset) => asset.name)).toEqual(expected.map((asset) => asset.name));
      expect(await fixture.store.count(scope, options)).toBe(
        await fixture.memory.count(scope, options),
      );
      for (const args of fixture.asset.findMany.mock.calls.map(([args]) => args!)) {
        expect(args.take).toBeGreaterThan(0);
        expect(args.take).toBeLessThanOrEqual(200);
        expect(args.select).not.toHaveProperty('contentKey');
      }
      expect(fixture.reads).not.toHaveBeenCalled();
      expect(fixture.writes).not.toHaveBeenCalled();
    },
  );

  it('does not apply the requested page until sparse matches beyond scan boundaries are found', async () => {
    const fixture = queryPrisma(
      Array.from({ length: 1000 }, (_, index) =>
        queryRow(index, { metadata: { aliases: index % 137 === 0 ? ['rare hero'] : [] } }),
      ),
    );
    const options = { query: 'rare hero', page: 3, pageSize: 2 };
    const assets = await fixture.store.list({ ownerId: 'owner-a' }, options);
    expect(assets.map((asset) => asset.id)).toEqual([548, 685].map((index) => queryRow(index).id));
    expect(await fixture.store.count({ ownerId: 'owner-a' }, options)).toBe(8);
    expect(fixture.asset.count).not.toHaveBeenCalled();
    const calls = fixture.asset.findMany.mock.calls.map(([args]) => args!);
    const scans = calls.filter((args) => !args.select?.versions);
    const hydration = calls.filter((args) => args.select?.versions);
    expect(hydration.map((args) => args.take)).toEqual([1, 1]);
    expect(scans.every((args) => args.take === 200 && args.skip === undefined)).toBe(true);
    expect(scans[1]!.where).toEqual({
      AND: [
        { ownerId: 'owner-a' },
        {
          OR: [
            { updatedAt: { lt: queryRow(199).updatedAt } },
            { updatedAt: queryRow(199).updatedAt, id: { gt: queryRow(199).id } },
          ],
        },
      ],
    });
    expect(Math.max(...fixture.returnedRows)).toBe(200);
    expect(scans.every((args) => !args.select?.sizeBytes && !args.select?.sha256)).toBe(true);
    const beyond = await fixture.store.list({}, { query: 'rare hero', page: 5, pageSize: 2 });
    expect(beyond).toEqual([]);
  });

  it('counts a 10000-row search in batches of at most 200 without version hydration', async () => {
    const fixture = queryPrisma(
      Array.from({ length: 10_000 }, (_, index) =>
        queryRow(index, { tags: index % 10 === 0 ? ['\t TaG  '] : [] }),
      ),
    );
    expect(await fixture.store.count({}, { tags: ['tag'] })).toBe(1000);
    expect(fixture.returnedRows.reduce((sum, count) => sum + count, 0)).toBe(10_000);
    expect(Math.max(...fixture.returnedRows)).toBe(200);
    expect(fixture.asset.findMany).toHaveBeenCalledTimes(51);
    expect(
      fixture.asset.findMany.mock.calls.every(
        ([args]) => args?.take === 200 && !args.select?.versions && !args.select?.contentKey,
      ),
    ).toBe(true);
  });

  it('pushes permission/status/type filters into every search scan and hydration', async () => {
    const fixture = await searchFixture();
    const options = { query: 'hero', status: 'ready', mediaType: 'image', pageSize: 1 } as const;
    await fixture.store.list({ projectId: 'project-a', ownerId: 'owner-a' }, options);
    const where = {
      projectId: 'project-a',
      ownerId: 'owner-a',
      status: 'READY',
      mediaType: 'IMAGE',
    };
    const calls = fixture.asset.findMany.mock.calls.map(([args]) => args!);
    expect(calls[0]!.where).toEqual(where);
    expect(calls[1]!.where).toMatchObject({ AND: [where, { id: { in: [queryRow(1).id] } }] });
  });

  it('advances the composite search cursor across timestamp groups without gaps or duplicates', async () => {
    const rows = Array.from({ length: 430 }, (_, index) =>
      queryRow(index, {
        updatedAt: new Date(index % 2 === 0 ? '2026-01-02' : '2026-01-01'),
        metadata: { aliases: ['hero'] },
      }),
    ).reverse();
    const fixture = queryPrisma(rows);
    const expected = [...rows].sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
    );
    const result = await fixture.store.list({}, { query: 'hero', page: 2, pageSize: 200 });
    expect(result.map((asset) => asset.id)).toEqual(expected.slice(200, 400).map((row) => row.id));
    expect(await fixture.store.count({}, { query: 'hero' })).toBe(430);
    const scans = fixture.asset.findMany.mock.calls
      .map(([args]) => args!)
      .filter((args) => !args.select?.versions);
    expect(scans.some((args) => JSON.stringify(args.where).includes('2026-01-01'))).toBe(true);
  });

  it('keeps full unpaged search results while bounding each hydration query', async () => {
    const fixture = queryPrisma(
      Array.from({ length: 450 }, (_, index) => queryRow(index, { metadata: { alias: 'hero' } })),
    );
    expect(await fixture.store.list({}, { query: 'hero' })).toHaveLength(450);
    expect(fixture.returnedRows).toEqual([200, 200, 200, 200, 50, 50]);
  });
});

describe('multi-scope asset pages', () => {
  it('keeps scope priority, excludes other projects and owners, and counts without metadata scans', async () => {
    const fixture = queryPrisma([
      queryRow(1, { ownerId: null }),
      queryRow(2, { projectId: null, updatedAt: new Date('2026-01-02') }),
      queryRow(3, { projectId: null, ownerId: 'owner-b' }),
      queryRow(4, { projectId: 'project-b' }),
      queryRow(5, { ownerId: 'owner-b' }),
    ]);
    const scopes = [{ projectId: 'project-a' }, { projectId: null, ownerId: 'owner-a' }];
    const first = await fixture.store.listPage(scopes, { page: 1, pageSize: 2 });
    const second = await fixture.store.listPage(scopes, { page: 2, pageSize: 2 });
    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.assets.map((asset) => asset.id)).toEqual([queryRow(1).id, queryRow(5).id]);
    expect(second.assets.map((asset) => asset.id)).toEqual([queryRow(2).id]);
    expect(fixture.returnedRows).toEqual([2, 1]);
    expect(fixture.asset.count).toHaveBeenCalledTimes(4);
  });

  it('deduplicates overlapping/repeated scopes without excluding nullable owners/projects', async () => {
    const fixture = queryPrisma([
      queryRow(1),
      queryRow(2, { ownerId: null }),
      queryRow(3, { projectId: null }),
      queryRow(4, { ownerId: null, projectId: null }),
      queryRow(5, { ownerId: 'owner-b', projectId: 'project-b' }),
    ]);
    const scopes = [
      { ownerId: 'owner-a' },
      { ownerId: 'owner-a' },
      { projectId: 'project-a' },
      {},
      { ownerId: 'owner-b' },
    ];
    const page = await fixture.store.listPage(scopes, { page: 2, pageSize: 2 });
    expect(page.total).toBe(5);
    expect(page.assets.map((asset) => asset.id)).toEqual([queryRow(2).id, queryRow(4).id]);
    expect(fixture.asset.count).toHaveBeenCalledTimes(4);
    expect(fixture.returnedRows).toEqual([1, 1]);
    const all = await fixture.store.listPage(scopes, { pageSize: 200 });
    expect(all.assets.map((asset) => asset.id)).toEqual(
      [1, 3, 2, 4, 5].map((index) => queryRow(index).id),
    );
  });

  it('excludes a conjunction only when both scope fields match', async () => {
    const fixture = queryPrisma([
      queryRow(1),
      queryRow(2, { ownerId: null }),
      queryRow(3, { projectId: null }),
      queryRow(4, { ownerId: 'owner-b' }),
    ]);
    const result = await fixture.store.listPage([
      { ownerId: 'owner-a', projectId: 'project-a' },
      {},
    ]);
    expect(result.total).toBe(4);
    expect(result.assets.map((asset) => asset.id)).toEqual(
      [1, 2, 3, 4].map((index) => queryRow(index).id),
    );
  });

  it('returns at most 50 metadata rows across a page spanning two scopes totaling 20000 rows', async () => {
    const fixture = queryPrisma(
      Array.from({ length: 20_000 }, (_, index) =>
        queryRow(index, { projectId: index < 10_025 ? 'project-a' : null }),
      ),
    );
    const page = await fixture.store.listPage(
      [{ projectId: 'project-a' }, { projectId: null, ownerId: 'owner-a' }],
      { page: 201, pageSize: 50 },
    );
    expect(page.total).toBe(20_000);
    expect(page.assets).toHaveLength(50);
    expect(page.assets[0]!.id).toBe(queryRow(10_000).id);
    expect(page.assets[49]!.id).toBe(queryRow(10_049).id);
    expect(fixture.returnedRows).toEqual([25, 25]);
    expect(fixture.asset.count).toHaveBeenCalledTimes(2);
  });

  it('does not treat an empty authorized scope list as an unrestricted query', async () => {
    const fixture = queryPrisma([queryRow(1)]);
    expect(await fixture.store.listPage([])).toEqual({
      assets: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(fixture.asset.findMany).not.toHaveBeenCalled();
    expect(fixture.asset.count).not.toHaveBeenCalled();
    expect(await new MemoryAssetStore().listPage([])).toEqual({
      assets: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
  });

  it.each([
    {},
    { query: 'hero' },
    { tags: ['HERO'] },
    { status: 'archived' },
    { mediaType: 'video' },
  ] satisfies AssetListOptions[])(
    'preserves memory dedup/page/count behavior for %j',
    async (filters) => {
      const fixture = await searchFixture();
      const scopes: AssetScope[] = [
        { projectId: 'project-a' },
        { projectId: null, ownerId: 'owner-a' },
        { projectId: 'project-a' },
        { ownerId: 'owner-a' },
      ];
      for (const page of [1, 2, 3, 6, 20]) {
        const options = { ...filters, page, pageSize: 2 };
        const expected = await fixture.memory.listPage(scopes, options);
        const actual = await fixture.store.listPage(scopes, options);
        expect(actual.total).toBe(expected.total);
        expect(actual.page).toBe(expected.page);
        expect(actual.pageSize).toBe(expected.pageSize);
        expect(actual.assets.map((asset) => asset.name)).toEqual(
          expected.assets.map((asset) => asset.name),
        );
      }
    },
  );
});

describe('authorized Prisma project page predicates', () => {
  it('filters owner conflicts before limit/count while keeping legacy null owners in the same ordered partition', async () => {
    const fixture = queryPrisma(
      [
        queryRow(0, { ownerId: 'owner-b' }),
        queryRow(1, { ownerId: null }),
        queryRow(2),
        queryRow(3, { projectId: null }),
        queryRow(4, { projectId: null, ownerId: null }),
        queryRow(5, { projectId: 'project-b' }),
      ],
      {},
      new Map([
        ['project-a', 'owner-a'],
        ['project-b', 'owner-b'],
      ]),
    );
    const input = { projectId: 'project-a', ownerId: 'owner-a' };
    const options = { page: 1, pageSize: 2, mediaType: 'image', status: 'ready' } as const;
    const first = await fixture.store.listAuthorizedProjectPage(input, options);
    expect(first.total).toBe(3);
    expect(first.assets.map((asset) => asset.id)).toEqual([queryRow(1).id, queryRow(2).id]);
    const projectWhere = {
      AND: [
        { projectId: 'project-a', mediaType: 'IMAGE', status: 'READY' },
        { OR: [{ ownerId: 'owner-a' }, { ownerId: null }] },
        { project: { is: { ownerId: 'owner-a' } } },
      ],
    };
    expect(fixture.asset.count).toHaveBeenNthCalledWith(1, { where: projectWhere });
    expect(fixture.asset.count).toHaveBeenNthCalledWith(2, {
      where: { projectId: null, ownerId: 'owner-a', mediaType: 'IMAGE', status: 'READY' },
    });
    expect(fixture.asset.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: projectWhere,
        skip: 0,
        take: 2,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      }),
    );
    const second = await fixture.store.listAuthorizedProjectPage(input, { ...options, page: 2 });
    expect(second.assets.map((asset) => asset.id)).toEqual([queryRow(3).id]);
    expect(fixture.returnedRows).toEqual([2, 1]);
    expect(fixture.asset.findUnique).not.toHaveBeenCalled();
  });

  it('preserves constructor owner restrictions instead of widening project rows', async () => {
    const fixture = queryPrisma(
      [
        queryRow(1, { ownerId: null }),
        queryRow(2),
        queryRow(3, { ownerId: 'owner-b' }),
        queryRow(4, { projectId: null }),
      ],
      { ownerId: 'owner-b' },
      new Map([['project-a', 'owner-a']]),
    );
    const result = await fixture.store.listAuthorizedProjectPage({
      projectId: 'project-a',
      ownerId: 'owner-a',
    });
    expect(result.total).toBe(1);
    expect(result.assets.map((asset) => asset.id)).toEqual([queryRow(4).id]);
  });

  it.each(['owner-b', null, undefined])(
    'does not expose project rows when current project ownership becomes %s',
    async (owner) => {
      const projects = new Map<string, string | null>();
      if (owner !== undefined) projects.set('project-a', owner);
      const fixture = queryPrisma(
        [queryRow(1, { ownerId: null }), queryRow(2), queryRow(3, { projectId: null })],
        {},
        projects,
      );
      const result = await fixture.store.listAuthorizedProjectPage({
        projectId: 'project-a',
        ownerId: 'owner-a',
      });
      expect(result.total).toBe(1);
      expect(result.assets.map((asset) => asset.id)).toEqual([queryRow(3).id]);
    },
  );

  it('keeps the same authorization predicates on every complex-search scan and hydration', async () => {
    const fixture = queryPrisma(
      [
        queryRow(0, { ownerId: 'owner-b', metadata: { alias: 'İstanbul' } }),
        queryRow(1, { ownerId: null, metadata: { alias: 'İstanbul' }, tags: [' Hero '] }),
        queryRow(2, { projectId: null, metadata: { aliases: ['İstanbul', 123] }, tags: ['hero'] }),
      ],
      {},
      new Map([['project-a', 'owner-a']]),
    );
    const result = await fixture.store.listAuthorizedProjectPage(
      { projectId: 'project-a', ownerId: 'owner-a' },
      { query: 'i\u0307stanbul', tags: ['hero'], pageSize: 1 },
    );
    expect(result.total).toBe(2);
    expect(result.assets.map((asset) => asset.id)).toEqual([queryRow(1).id]);
    expect(fixture.asset.findUnique).not.toHaveBeenCalled();
    expect(fixture.asset.count).not.toHaveBeenCalled();
    const calls = fixture.asset.findMany.mock.calls.map(([args]) => args!);
    expect(calls.every((args) => args.take !== undefined && args.take <= 200)).toBe(true);
    expect(calls.every((args) => JSON.stringify(args.where).includes('owner-a'))).toBe(true);
    expect(
      calls
        .filter((args) => JSON.stringify(args.where).includes('project-a'))
        .every((args) =>
          JSON.stringify(args.where).includes('"project":{"is":{"ownerId":"owner-a"}}'),
        ),
    ).toBe(true);
  });

  it.each([
    { projectId: '', ownerId: 'owner-a' },
    { projectId: 'project-a', ownerId: ' ' },
  ])('rejects incomplete internal authorization input %j without database reads', async (input) => {
    const fixture = queryPrisma([]);
    await expect(fixture.store.listAuthorizedProjectPage(input)).rejects.toBeInstanceOf(TypeError);
    await expect(new MemoryAssetStore().listAuthorizedProjectPage(input)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fixture.asset.findMany).not.toHaveBeenCalled();
    expect(fixture.asset.count).not.toHaveBeenCalled();
  });
});

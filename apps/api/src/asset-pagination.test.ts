import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore, type AssetStore } from './assets';
import { TestAuthContext } from './fixtures/auth-session';
import { buildApp } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { queryPrisma, queryRow } from './fixtures/asset-query';

/** 每个用例关闭自己的 Fastify 实例；inject 不监听端口、不启动外部服务。 */
const applications: FastifyInstance[] = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-asset-pagination-secret');
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 区分可选分页适配器、两种旧合同，以及生产使用的完整归属权限包装链路。 */
type AdapterMode = 'paged' | 'legacy' | 'legacy-no-count' | 'ownership';

/**
 * 用内存元数据、合成身份和实际 Fastify 路由验证 HTTP 合同。
 * 自定义适配器故意不提供 getOwnership，只用于可选接口调度；ownership 模式单独验证权限包装器。
 */
async function createFixture(mode: AdapterMode = 'ownership') {
  const auth = new TestAuthContext();
  const owner = await auth.session({ email: 'pagination-owner@example.test' });
  const other = await auth.session({ email: 'pagination-other@example.test' });
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create(
    { name: 'Selected project' },
    { ownerId: owner.user.id },
  );
  const sibling = await projectStore.create(
    { name: 'Other own project' },
    { ownerId: owner.user.id },
  );
  const foreign = await projectStore.create(
    { name: 'Foreign project' },
    { ownerId: other.user.id },
  );
  const storage = new MemoryAssetStore();
  const list = vi.spyOn(storage, 'list');
  const count = vi.spyOn(storage, 'count');
  const listPage = vi.spyOn(storage, 'listPage');
  const authorizedPage = vi.spyOn(storage, 'listAuthorizedProjectPage');
  const ownershipReads = vi.spyOn(storage, 'getOwnership');
  const projectReads = vi.spyOn(projectStore, 'get');
  const adapted: AssetStore = {
    create: storage.create.bind(storage),
    list: storage.list.bind(storage),
    ...(mode === 'legacy-no-count' ? {} : { count: storage.count.bind(storage) }),
    ...(mode === 'paged' ? { listPage: storage.listPage.bind(storage) } : {}),
    get: storage.get.bind(storage),
    delete: storage.delete.bind(storage),
    createVersion: storage.createVersion.bind(storage),
    listVersions: storage.listVersions.bind(storage),
    getVersionContent: storage.getVersionContent.bind(storage),
    getDerivative: storage.getDerivative.bind(storage),
    update: storage.update.bind(storage),
    setArchived: storage.setArchived.bind(storage),
  };
  const app = buildApp({
    logger: false,
    assetStore: mode === 'ownership' ? storage : adapted,
    projectStore,
    ...auth.appOptions,
  });
  applications.push(app);
  const headers = { authorization: `Bearer ${owner.accessToken}` };
  const inputs = [
    { name: 'project-legacy.png', projectId: project.id },
    { name: 'project-owned.png', projectId: project.id, ownerId: owner.user.id },
    { name: 'project-archived.png', projectId: project.id, ownerId: owner.user.id },
    { name: 'personal.png', ownerId: owner.user.id },
    { name: 'sibling.png', projectId: sibling.id, ownerId: owner.user.id },
    { name: 'foreign-project.png', projectId: foreign.id, ownerId: other.user.id },
    { name: 'foreign-personal.png', ownerId: other.user.id },
  ];
  const assets = [];
  for (const input of inputs) {
    const asset = await storage.create({
      ...input,
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('synthetic'),
      tags: [' Hero ', 'Reference'],
      metadata: { alias: '主视觉', aliases: ['İstanbul', 'Cover Art', '50%_literal', 123] },
    });
    const { content: _content, ...publicAsset } = asset;
    assets.push(publicAsset);
    if (input.name === 'project-archived.png') await storage.setArchived(asset.id, true);
  }
  await storage.create({
    name: 'video.mp4',
    projectId: project.id,
    ownerId: owner.user.id,
    mediaType: 'video',
    mimeType: 'video/mp4',
    content: Buffer.from('synthetic-video'),
    tags: ['Hero', 'Reference'],
    metadata: { alias: '主视觉' },
  });
  return {
    app,
    headers,
    owner,
    other,
    project,
    foreign,
    storage,
    assets,
    list,
    count,
    listPage,
    authorizedPage,
    ownershipReads,
    projectReads,
  };
}

describe('GET /v1/assets pagination dispatch', () => {
  it('uses optional listPage and preserves the public four-field response', async () => {
    const fixture = await createFixture('paged');
    const query = new URLSearchParams({
      projectId: fixture.project.id,
      query: ' 主视觉 ',
      mediaType: 'image',
      status: 'ready',
      tags: 'hero,REFERENCE',
      page: '2',
      pageSize: '2',
    });
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/v1/assets?${query}`,
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['assets', 'page', 'pageSize', 'total']);
    expect(response.json()).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual([
      'personal.png',
    ]);
    expect(fixture.listPage).toHaveBeenCalledExactlyOnceWith(
      [{ projectId: fixture.project.id }, { projectId: null, ownerId: fixture.owner.user.id }],
      {
        query: '主视觉',
        mediaType: 'image',
        status: 'ready',
        tags: ['hero', 'REFERENCE'],
        page: 2,
        pageSize: 2,
      },
    );
    expect(fixture.count).not.toHaveBeenCalled();
    expect(response.json().assets[0]).not.toHaveProperty('content');
    expect(response.json().assets[0]).not.toHaveProperty('ownerId');
  });

  it('routes a single owner scope through listPage with default page metadata', async () => {
    const fixture = await createFixture('paged');
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 5, page: 1, pageSize: 50 });
    expect(fixture.listPage).toHaveBeenCalledExactlyOnceWith([{ ownerId: fixture.owner.user.id }], {
      page: 1,
      pageSize: 50,
    });
  });

  it.each(['legacy', 'legacy-no-count'] as const)(
    'retains the single-scope %s fallback',
    async (mode) => {
      const fixture = await createFixture(mode);
      const response = await fixture.app.inject({
        method: 'GET',
        url: '/v1/assets?mediaType=image&status=ready&page=2&pageSize=1',
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ total: 3, page: 2, pageSize: 1 });
      expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual([
        'personal.png',
      ]);
      expect(fixture.listPage).not.toHaveBeenCalled();
      if (mode === 'legacy') {
        expect(fixture.count).toHaveBeenCalledExactlyOnceWith(
          { ownerId: fixture.owner.user.id },
          { mediaType: 'image', status: 'ready' },
        );
      } else {
        expect(fixture.count).not.toHaveBeenCalled();
        expect(fixture.list).toHaveBeenCalledTimes(2);
        expect(fixture.list).toHaveBeenLastCalledWith(
          { ownerId: fixture.owner.user.id },
          { mediaType: 'image', status: 'ready' },
        );
      }
    },
  );

  it.each(['paged', 'legacy'] as const)(
    'deduplicates overlapping adapter results before HTTP pagination through %s',
    async (mode) => {
      const fixture = await createFixture(mode);
      const [projectAsset, shared, , personal] = fixture.assets;
      fixture.list.mockImplementation(async (scope) =>
        scope?.projectId === fixture.project.id ? [projectAsset!, shared!] : [shared!, personal!],
      );
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/v1/assets?projectId=${fixture.project.id}&page=2&pageSize=2`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        assets: [{ id: personal!.id }],
        total: 3,
        page: 2,
        pageSize: 2,
      });
      expect(response.json().assets).toHaveLength(1);
      expect(fixture.count).not.toHaveBeenCalled();
      expect(fixture.list).toHaveBeenCalledTimes(2);
      expect(
        fixture.list.mock.calls.every(
          ([, options]) => options?.page === undefined && options?.pageSize === undefined,
        ),
      ).toBe(true);
    },
  );

  it('does not silently fall back to all-row queries when listPage fails', async () => {
    const fixture = await createFixture('paged');
    fixture.listPage.mockRejectedValueOnce(new Error('synthetic pagination failure'));
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/v1/assets',
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.count).not.toHaveBeenCalled();
  });
});

describe('GET /v1/assets filters and permissions', () => {
  it.each(['paged', 'legacy', 'legacy-no-count', 'ownership'] as const)(
    'preserves project/personal filtering and page boundaries through %s',
    async (mode) => {
      const fixture = await createFixture(mode);
      for (const [page, names] of [
        [1, ['project-legacy.png', 'project-owned.png']],
        [2, ['personal.png']],
        [3, []],
      ] as const) {
        const query = new URLSearchParams({
          projectId: fixture.project.id,
          query: '主视觉',
          mediaType: 'image',
          status: 'ready',
          tags: 'hero,REFERENCE',
          page: String(page),
          pageSize: '2',
        });
        const response = await fixture.app.inject({
          method: 'GET',
          url: `/v1/assets?${query}`,
          headers: fixture.headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ total: 3, page, pageSize: 2 });
        expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual(names);
      }
      for (const [filter, names] of [
        ['status=archived&mediaType=image', ['project-archived.png']],
        ['status=ready&mediaType=video', ['video.mp4']],
      ] as const) {
        const response = await fixture.app.inject({
          method: 'GET',
          url: `/v1/assets?projectId=${fixture.project.id}&${filter}`,
          headers: fixture.headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ total: 1, page: 1, pageSize: 50 });
        expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual(names);
      }
    },
  );

  it.each(['İstanbul', 'i\u0307stanbul', 'COVER ART', '%_', '主视觉'])(
    'preserves Unicode and literal alias search for %s through the ownership wrapper',
    async (query) => {
      const fixture = await createFixture();
      const params = new URLSearchParams({
        projectId: fixture.project.id,
        query,
        mediaType: 'image',
        status: 'ready',
      });
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/v1/assets?${params}`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(3);
      expect(response.json().assets.map((asset: { name: string }) => asset.name)).toEqual([
        'project-legacy.png',
        'project-owned.png',
        'personal.png',
      ]);
    },
  );

  it.each(['paged', 'ownership'] as const)(
    'checks project ownership before querying %s assets',
    async (mode) => {
      const fixture = await createFixture(mode);
      for (const projectId of [fixture.foreign.id, '00000000-0000-4000-8000-000000000000']) {
        const response = await fixture.app.inject({
          method: 'GET',
          url: `/v1/assets?projectId=${projectId}&page=1&pageSize=1`,
          headers: fixture.headers,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'project not found' });
      }
      expect(fixture.listPage).not.toHaveBeenCalled();
      expect(fixture.list).not.toHaveBeenCalled();
      expect(fixture.count).not.toHaveBeenCalled();
      const anonymous = await fixture.app.inject({ method: 'GET', url: '/v1/assets' });
      expect(anonymous.statusCode).toBe(401);
    },
  );

  it('keeps unscoped owner queries on the original permission fallback', async () => {
    const fixture = await createFixture();
    await fixture.storage.create({
      projectId: fixture.foreign.id,
      ownerId: fixture.owner.user.id,
      name: 'cross-owner.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('synthetic-conflict'),
    });
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/v1/assets?page=1&pageSize=50',
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(5);
    expect(response.json().assets.map((asset: { name: string }) => asset.name)).not.toContain(
      'cross-owner.png',
    );
    expect(fixture.authorizedPage).not.toHaveBeenCalled();
    expect(fixture.listPage).not.toHaveBeenCalled();
    expect(fixture.ownershipReads).toHaveBeenCalled();
    expect(
      fixture.list.mock.calls.every(
        ([, options]) => options?.page === undefined && options?.pageSize === undefined,
      ),
    ).toBe(true);
  });

  it.each(['page=0', 'pageSize=201', 'mediaType=invalid', 'status=invalid'])(
    'rejects invalid query %s before repository dispatch',
    async (query) => {
      const fixture = await createFixture('paged');
      const response = await fixture.app.inject({
        method: 'GET',
        url: `/v1/assets?${query}`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(400);
      expect(fixture.listPage).not.toHaveBeenCalled();
      expect(fixture.list).not.toHaveBeenCalled();
      expect(fixture.count).not.toHaveBeenCalled();
    },
  );

  it('excludes ownership conflicts before pagination through the authorized fast path', async () => {
    const fixture = await createFixture();
    await fixture.storage.create({
      projectId: fixture.project.id,
      ownerId: fixture.other.user.id,
      name: 'conflicting-owner.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('synthetic-conflict'),
    });
    const response = await fixture.app.inject({
      method: 'GET',
      url: `/v1/assets?projectId=${fixture.project.id}&page=1&pageSize=50`,
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(5);
    expect(response.json().assets.map((asset: { name: string }) => asset.name)).not.toContain(
      'conflicting-owner.png',
    );
    expect(fixture.authorizedPage).toHaveBeenCalledExactlyOnceWith(
      { projectId: fixture.project.id, ownerId: fixture.owner.user.id },
      { page: 1, pageSize: 50 },
    );
    expect(fixture.listPage).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.count).not.toHaveBeenCalled();
    expect(fixture.ownershipReads).not.toHaveBeenCalled();
    expect(fixture.projectReads).toHaveBeenCalledTimes(2);
  });
});

describe('GET /v1/assets Prisma ownership pagination', () => {
  it('bounds metadata reads through the real route and ownership wrapper for 10000 candidates', async () => {
    const auth = new TestAuthContext();
    const owner = await auth.session({ email: 'prisma-page-owner@example.test' });
    const projects = new MemoryProjectStore();
    const project = await projects.create(
      { name: 'Synthetic project' },
      { ownerId: owner.user.id },
    );
    const projectReads = vi.spyOn(projects, 'get');
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      queryRow(index, {
        projectId: index < 7025 ? project.id : null,
        ownerId:
          index < 6025
            ? index % 2 === 0
              ? null
              : owner.user.id
            : index < 7025
              ? 'foreign-owner'
              : owner.user.id,
      }),
    );
    const database = queryPrisma(rows, {}, new Map([[project.id, owner.user.id]]));
    const app = buildApp({
      logger: false,
      assetStore: database.store,
      projectStore: projects,
      ...auth.appOptions,
    });
    applications.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/assets?projectId=${project.id}&page=121&pageSize=50`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 9000, page: 121, pageSize: 50 });
    expect(response.json().assets.map((entry: { id: string }) => entry.id)).toEqual(
      [...rows.slice(6000, 6025), ...rows.slice(7025, 7050)].map((row) => row.id),
    );
    expect({
      metadataRows: database.returnedRows,
      countQueries: database.asset.count.mock.calls.length,
      ownershipReads: database.asset.findUnique.mock.calls.length,
      projectReads: projectReads.mock.calls.length,
    }).toEqual({ metadataRows: [25, 25], countQueries: 2, ownershipReads: 0, projectReads: 2 });
    expect(database.reads).not.toHaveBeenCalled();
    expect(database.writes).not.toHaveBeenCalled();
  });
});

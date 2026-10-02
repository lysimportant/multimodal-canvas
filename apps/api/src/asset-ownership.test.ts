import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { withAssetOwnershipPolicy } from './asset-ownership';
import { MemoryAuthStore } from './auth-store';
import { MemoryProjectStore } from './projects';
import { issueTestSession, TestAuthContext } from './fixtures/auth-session';

afterEach(() => vi.unstubAllEnvs());

describe('历史项目资源的受约束授权读取', () => {
  it('只有明确属于当前用户的项目可接续空 owner 资源，不能扩大已有项目或个人资源范围', async () => {
    const projects = new MemoryProjectStore();
    const raw = new MemoryAssetStore();
    const projectA = await projects.create({ name: '用户 A 项目' }, { ownerId: 'owner-a' });
    const projectB = await projects.create({ name: '用户 B 项目' }, { ownerId: 'owner-b' });
    const legacy = await raw.create({
      projectId: projectA.id,
      name: '历史文本',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('legacy-source'),
    });
    const unassigned = await raw.create({
      name: '无归属文本',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('unassigned-source'),
    });
    const assets = withAssetOwnershipPolicy(raw, projects);

    expect(await raw.get(legacy.id, { ownerId: 'owner-a' })).toBeUndefined();
    expect((await assets.get(legacy.id, { ownerId: 'owner-a' }))?.content.toString()).toBe(
      'legacy-source',
    );
    expect(await assets.listVersions(legacy.id, { ownerId: 'owner-a' })).toHaveLength(1);
    expect((await assets.getVersionContent(legacy.id, 1, { ownerId: 'owner-a' }))?.toString()).toBe(
      'legacy-source',
    );
    for (const scope of [
      { ownerId: 'owner-b' },
      { ownerId: 'owner-a', projectId: null },
      { ownerId: 'owner-a', projectId: projectB.id },
    ]) {
      expect(await assets.get(legacy.id, scope)).toBeUndefined();
      expect(await assets.listVersions(legacy.id, scope)).toEqual([]);
      expect(await assets.getVersionContent(legacy.id, 1, scope)).toBeUndefined();
    }
    expect(await assets.get(unassigned.id, { ownerId: 'owner-a' })).toBeUndefined();
    expect(await raw.getOwnership(legacy.id)).toEqual({ ownerId: null, projectId: projectA.id });
  });

  it('旧版资源列表、版本、源文件、衍生预览和短效链接允许项目所有者且拒绝其他用户', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_JWT_SECRET', 'synthetic-legacy-asset-secret');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_AUTH_RATE_LIMIT_PER_MINUTE', '1000');
    const raw = new MemoryAssetStore();
    const projects = new MemoryProjectStore();
    const mail = new TestAuthContext();
    const app = buildApp({
      logger: false,
      assetStore: raw,
      projectStore: projects,
      ...mail.appOptions,
    });
    try {
      const a = (
        await issueTestSession(app, mail, {
          email: 'legacy-a@example.test',
          password: 'correct-password',
        })
      ).json();
      const b = (
        await issueTestSession(app, mail, {
          email: 'legacy-b@example.test',
          password: 'correct-password',
        })
      ).json();
      const project = await projects.create({ name: '历史项目' }, { ownerId: a.user.id });
      const asset = await raw.create({
        projectId: project.id,
        name: '历史图片',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('synthetic-image-bytes'),
        derivatives: {
          thumbnail: { mimeType: 'image/png', content: Buffer.from('synthetic-thumbnail') },
        },
      });
      const headersA = { authorization: `Bearer ${a.accessToken}` };
      const headersB = { authorization: `Bearer ${b.accessToken}` };
      const listed = await app.inject({
        method: 'GET',
        url: `/v1/assets?projectId=${project.id}`,
        headers: headersA,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().assets.map((entry: { id: string }) => entry.id)).toEqual([asset.id]);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/assets?projectId=${project.id}`,
            headers: headersB,
          })
        ).statusCode,
      ).toBe(404);
      for (const suffix of [
        '/content',
        '/versions',
        '/versions/1/content',
        '/derivatives/thumbnail',
      ]) {
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/v1/assets/${asset.id}${suffix}`,
              headers: headersA,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `/v1/assets/${asset.id}${suffix}`,
              headers: headersB,
            })
          ).statusCode,
        ).toBe(404);
      }
      const access = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers: headersA,
        payload: { version: 1 },
      });
      expect(access.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: access.json().url })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/assets/${asset.id}/access-url`,
            headers: headersB,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/v1/assets/${asset.id}`,
        headers: headersA,
        payload: { name: '已恢复的历史图片' },
      });
      expect(renamed.statusCode).toBe(200);
      expect(await raw.getOwnership(asset.id)).toEqual({ ownerId: null, projectId: project.id });
    } finally {
      await app.close();
    }
  });
});

/** 合成混合归属资源；冲突记录刻意位于合法记录之前，防止页后过滤掩盖错误。 */
async function ownershipPageFixture() {
  const projects = new MemoryProjectStore();
  const project = await projects.create({ name: 'Owner project' }, { ownerId: 'owner-a' });
  const foreign = await projects.create({ name: 'Foreign project' }, { ownerId: 'owner-b' });
  const unowned = await projects.create({ name: 'Unowned project' });
  const raw = new MemoryAssetStore();
  for (const input of [
    { name: 'conflict', projectId: project.id, ownerId: 'owner-b' },
    { name: 'legacy', projectId: project.id },
    { name: 'owned', projectId: project.id, ownerId: 'owner-a' },
    { name: 'personal', ownerId: 'owner-a' },
    { name: 'foreign-personal', ownerId: 'owner-b' },
    { name: 'unassigned-personal' },
    { name: 'foreign-project', projectId: foreign.id, ownerId: 'owner-a' },
    { name: 'unowned-project', projectId: unowned.id, ownerId: 'owner-a' },
  ]) {
    await raw.create({
      ...input,
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('synthetic'),
      tags: [' Hero '],
      metadata: { aliases: ['İstanbul', '主视觉', 123] },
    });
  }
  const list = vi.spyOn(raw, 'list');
  const plainPage = vi.spyOn(raw, 'listPage');
  const authorizedPage = vi.spyOn(raw, 'listAuthorizedProjectPage');
  const ownership = vi.spyOn(raw, 'getOwnership');
  const projectReads = vi.spyOn(projects, 'get');
  return {
    raw,
    projects,
    project,
    foreign,
    unowned,
    list,
    plainPage,
    authorizedPage,
    ownership,
    projectReads,
    assets: withAssetOwnershipPolicy(raw, projects),
  };
}

describe('项目与个人资源的前置权限分页', () => {
  it('只核验一次项目归属，在计数和取页前排除冲突并保留空 owner 历史数据', async () => {
    const fixture = await ownershipPageFixture();
    const scopes = [{ projectId: fixture.project.id }, { projectId: null, ownerId: 'owner-a' }];
    const result = await fixture.assets.listPage!(scopes, { page: 1, pageSize: 2 });
    expect(result).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(result.assets.map((asset) => asset.name)).toEqual(['legacy', 'owned']);
    expect(fixture.authorizedPage).toHaveBeenCalledExactlyOnceWith(
      { projectId: fixture.project.id, ownerId: 'owner-a' },
      { page: 1, pageSize: 2 },
    );
    expect(fixture.projectReads).toHaveBeenCalledExactlyOnceWith(fixture.project.id, {
      ownerId: 'owner-a',
    });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.ownership).not.toHaveBeenCalled();
    expect(fixture.plainPage).not.toHaveBeenCalled();
    const second = await fixture.assets.listPage!(scopes, { page: 2, pageSize: 2 });
    expect(second.total).toBe(3);
    expect(second.assets.map((asset) => asset.name)).toEqual(['personal']);
    expect(await fixture.assets.listPage!(scopes, { page: 3, pageSize: 2 })).toMatchObject({
      assets: [],
      total: 3,
    });
  });

  it.each([
    { query: 'i\u0307stanbul', tags: ['hero'], status: 'ready' as const },
    { query: '主视觉', mediaType: 'image' as const },
    { query: '%_' },
    { status: 'archived' as const },
  ])('筛选 %j 与旧版逐项鉴权结果等价', async (options) => {
    const fixture = await ownershipPageFixture();
    const scopes = [{ projectId: fixture.project.id }, { projectId: null, ownerId: 'owner-a' }];
    const expected = (
      await Promise.all(scopes.map((scope) => fixture.assets.list(scope, options)))
    ).flat();
    const result = await fixture.assets.listPage!(scopes, { ...options, page: 2, pageSize: 1 });
    expect(result.total).toBe(expected.length);
    expect(result.assets).toEqual(expected.slice(1, 2));
  });

  it.each([
    'owner-only',
    'project-only',
    'reversed',
    'anonymous',
    'extra-field',
    'unknown-field',
    'owner-mismatch',
    'unowned-project',
    'empty',
  ] as const)('%s 范围不激活快路径，保持原权限过滤和去重', async (kind) => {
    const fixture = await ownershipPageFixture();
    const projectScope = { projectId: fixture.project.id };
    const personalScope = { projectId: null, ownerId: 'owner-a' };
    const scopes =
      kind === 'owner-only'
        ? [{ ownerId: 'owner-a' }]
        : kind === 'project-only'
          ? [projectScope]
          : kind === 'reversed'
            ? [personalScope, projectScope]
            : kind === 'anonymous'
              ? [projectScope, { projectId: null }]
              : kind === 'extra-field'
                ? [{ ...projectScope, ownerId: 'owner-a' }, personalScope]
                : kind === 'unknown-field'
                  ? [projectScope, { ...personalScope, includeAll: true }]
                  : kind === 'owner-mismatch'
                    ? [projectScope, { ...personalScope, ownerId: 'owner-b' }]
                    : kind === 'unowned-project'
                      ? [{ projectId: fixture.unowned.id }, personalScope]
                      : [];
    const lists = await Promise.all(scopes.map((scope) => fixture.assets.list(scope)));
    const expected = [...new Map(lists.flat().map((asset) => [asset.id, asset])).values()];
    const result = await fixture.assets.listPage!(scopes, { page: 1, pageSize: 2 });
    expect(result.total).toBe(expected.length);
    expect(result.assets).toEqual(expected.slice(0, 2));
    expect(fixture.authorizedPage).not.toHaveBeenCalled();
    expect(fixture.plainPage).not.toHaveBeenCalled();
  });

  it('项目核验或已授权查询失败直接报错，不退回更宽的查询', async () => {
    const fixture = await ownershipPageFixture();
    const scopes = [{ projectId: fixture.project.id }, { projectId: null, ownerId: 'owner-a' }];
    const error = new Error('synthetic ownership failure');
    fixture.projectReads.mockRejectedValueOnce(error);
    await expect(fixture.assets.listPage!(scopes)).rejects.toBe(error);
    expect(fixture.authorizedPage).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    fixture.authorizedPage.mockRejectedValueOnce(error);
    await expect(fixture.assets.listPage!(scopes)).rejects.toBe(error);
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it('没有内部授权分页能力的旧仓库不暴露未经鉴权的 listPage', async () => {
    const fixture = await ownershipPageFixture();
    Object.defineProperty(fixture.raw, 'listAuthorizedProjectPage', { value: undefined });
    const legacy = withAssetOwnershipPolicy(fixture.raw, fixture.projects);
    expect(legacy.listPage).toBeUndefined();
    const rows = await legacy.list({ projectId: fixture.project.id });
    expect(rows.map((asset) => asset.name)).toEqual(['legacy', 'owned']);
    expect(fixture.plainPage).not.toHaveBeenCalled();
  });
});

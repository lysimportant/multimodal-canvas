import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { withAssetOwnershipPolicy } from './asset-ownership';
import { MemoryAuthStore } from './auth-store';
import { MemoryProjectStore } from './projects';
import { registerVerifiedTestUser, TestAccountMailSender } from './fixtures/account-mail';

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
    const mail = new TestAccountMailSender();
    const app = buildApp({
      logger: false,
      authStore: new MemoryAuthStore(),
      assetStore: raw,
      projectStore: projects,
      accountMailSender: mail,
    });
    try {
      const a = (
        await registerVerifiedTestUser(app, mail, {
          email: 'legacy-a@example.test',
          password: 'correct-password',
        })
      ).json();
      const b = (
        await registerVerifiedTestUser(app, mail, {
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

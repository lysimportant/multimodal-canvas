import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { AuthService } from './auth-service';
import { MemoryAuthStore } from './auth-store';
import {
  ModelMarketplaceError,
  type ModelMarketplace,
  type ResolvedMarketplaceModel,
} from './model-marketplace';
import { publicModelDefaults, resolvePublicModelDefaults } from './model-defaults-public';
import { MemoryProjectStore } from './projects';
import { AiSettingsStore } from './settings';

/** 合成商品只用于默认视图，测试不会请求真实上游或持久化数据库。 */
function resolvedModel(platformModelId = randomUUID(), modelAlias = 'current-image-model') {
  return {
    model: { id: platformModelId, mediaType: 'IMAGE' },
    binding: { upstreamModelId: modelAlias },
  } as ResolvedMarketplaceModel;
}

/** 两个解析方法由用例指定结果，故意不提供首项或目录回退。 */
function marketplaceFixture() {
  const resolved = resolvedModel();
  const service = {
    resolvePublishedModel: vi.fn(async () => resolved),
    resolveLegacyModel: vi.fn(async () => resolved),
  };
  return { resolved, service };
}

/** 已启动的测试应用统一关闭，环境变量不跨用例污染其他测试。 */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('默认模型公开解析', () => {
  it('裁剪内部连接且保留旧字符串与稳定 ID，不修改原对象', () => {
    const credentialId = randomUUID();
    const platformModelId = randomUUID();
    const defaults = {
      text: 'legacy-text',
      image: { modelAlias: 'legacy-image', platformModelId, credentialId },
    };
    expect(publicModelDefaults(defaults)).toEqual({
      text: 'legacy-text',
      image: { modelAlias: 'legacy-image', platformModelId },
    });
    expect(defaults.image.credentialId).toBe(credentialId);
  });

  it('原 alias、连接与媒体类型精确传入服务端解析，不按前端同名商品猜测', async () => {
    const { service, resolved } = marketplaceFixture();
    const credentialId = randomUUID();
    const output = await resolvePublicModelDefaults(
      { image: { modelAlias: 'legacy-image', credentialId } },
      service,
    );
    expect(service.resolveLegacyModel).toHaveBeenCalledExactlyOnceWith(
      'legacy-image',
      credentialId,
      'image',
    );
    expect(service.resolvePublishedModel).not.toHaveBeenCalled();
    expect(output).toEqual({
      image: { modelAlias: 'current-image-model', platformModelId: resolved.model.id },
    });
    expect(JSON.stringify(output)).not.toContain(credentialId);
  });

  it('已保存平台 ID 优先；API 切换后返回当前 alias，忽略过时连接提示', async () => {
    const { service, resolved } = marketplaceFixture();
    const output = await resolvePublicModelDefaults(
      {
        image: {
          modelAlias: 'previous-provider-model',
          credentialId: randomUUID(),
          platformModelId: resolved.model.id,
        },
      },
      service,
    );
    expect(service.resolvePublishedModel).toHaveBeenCalledExactlyOnceWith(resolved.model.id);
    expect(service.resolveLegacyModel).not.toHaveBeenCalled();
    expect(output.image).toEqual({
      modelAlias: 'current-image-model',
      platformModelId: resolved.model.id,
    });
  });

  it('无绑定 alias 仍按唯一解析，不附加当前连接或填充未配置媒体', async () => {
    const { service } = marketplaceFixture();
    await resolvePublicModelDefaults({ image: 'legacy-image' }, service);
    expect(service.resolveLegacyModel).toHaveBeenCalledExactlyOnceWith(
      'legacy-image',
      undefined,
      'image',
    );
    service.resolveLegacyModel.mockClear();
    expect(await resolvePublicModelDefaults({}, service)).toEqual({});
    expect(service.resolveLegacyModel).not.toHaveBeenCalled();
  });

  it.each(['model_selection_ambiguous', 'model_not_published', 'binding_unavailable'])(
    '%s 保留原选择而不自动切换商品',
    async (code) => {
      const { service } = marketplaceFixture();
      service.resolveLegacyModel.mockRejectedValue(new ModelMarketplaceError(code, '不可用', 409));
      expect(
        await resolvePublicModelDefaults(
          { image: { modelAlias: 'keep-this-model', credentialId: randomUUID() } },
          service,
        ),
      ).toEqual({ image: { modelAlias: 'keep-this-model' } });
      expect(service.resolvePublishedModel).not.toHaveBeenCalled();
    },
  );

  it('停用的稳定身份与无效旧记录保留；媒体冲突也不改写默认值', async () => {
    const { service, resolved } = marketplaceFixture();
    const platformModelId = randomUUID();
    service.resolvePublishedModel.mockRejectedValue(
      new ModelMarketplaceError('model_not_published', '已暂停', 409),
    );
    expect(
      await resolvePublicModelDefaults(
        { image: { modelAlias: 'paused-image', platformModelId } },
        service,
      ),
    ).toEqual({ image: { modelAlias: 'paused-image', platformModelId } });
    service.resolveLegacyModel.mockRejectedValue(new z.ZodError([]));
    expect(await resolvePublicModelDefaults({ image: 'invalid-legacy' }, service)).toEqual({
      image: { modelAlias: 'invalid-legacy' },
    });
    service.resolveLegacyModel.mockResolvedValue({
      ...resolved,
      model: { ...resolved.model, mediaType: 'TEXT' },
    });
    expect(await resolvePublicModelDefaults({ image: 'wrong-type' }, service)).toEqual({
      image: { modelAlias: 'wrong-type' },
    });
  });

  it('数据库与服务故障不伪装成未配置', async () => {
    const { service } = marketplaceFixture();
    const failure = new Error('synthetic database unavailable');
    service.resolveLegacyModel.mockRejectedValue(failure);
    await expect(resolvePublicModelDefaults({ image: 'legacy' }, service)).rejects.toBe(failure);
    const unavailable = new ModelMarketplaceError('marketplace_unavailable', '不可用', 503);
    service.resolveLegacyModel.mockRejectedValue(unavailable);
    await expect(resolvePublicModelDefaults({ image: 'legacy' }, service)).rejects.toBe(
      unavailable,
    );
  });
});

/** 用真实会话与项目存储验证公开路由；所有凭据和账户均为本测试合成值。 */
async function routeFixture() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-model-defaults-session-secret');
  const authStore = new MemoryAuthStore();
  const authService = new AuthService({
    store: authStore,
    jwtSecret: 'synthetic-model-defaults-session-secret',
  });
  const settingsStore = new AiSettingsStore('synthetic-model-defaults-encryption-key');
  const projectStore = new MemoryProjectStore();
  const { resolved, service } = marketplaceFixture();
  const app = buildApp({
    logger: false,
    authStore,
    authService,
    settingsStore,
    projectStore,
    marketplace: service as unknown as ModelMarketplace,
  });
  apps.push(app);
  /** 会话由 AuthService 签发，测试不通过未核验 JWT 角色取得管理权限。 */
  const account = async (role: 'admin' | 'user') => {
    const user = await authStore.createUser({
      email: `${randomUUID()}@example.invalid`,
      passwordHash: 'synthetic-unused-hash',
      role,
      status: 'active',
    });
    const token = await authService.issueToken(user);
    return { user, headers: { authorization: `Bearer ${token.accessToken}` } };
  };
  return { app, account, projectStore, settingsStore, service, resolved };
}

describe('默认模型公开 HTTP 响应', () => {
  it('旧上游目录的所有查询均要求管理权限，普通账户不能绕过连接或价格边界', async () => {
    const { app, account, settingsStore } = await routeFixture();
    const admin = await account('admin');
    const user = await account('user');
    settingsStore.update({
      baseUrl: 'https://catalog.example.invalid/v1',
      apiKey: 'synthetic-catalog-key',
    });
    const credentialId = settingsStore.getCredentialReference().credentialId!;
    settingsStore.replaceModels(
      [
        {
          id: 'unpublished-provider-image',
          name: 'Provider-only candidate',
          mediaTypes: ['image'],
          capabilities: { endpoint: 'https://private.example.invalid/admin', apiKey: 'synthetic' },
          price: { amount: '0.001', currency: 'USD' },
          refreshedAt: new Date().toISOString(),
        },
      ],
      credentialId,
    );
    const listModels = vi.spyOn(settingsStore, 'listModels');
    for (const query of ['', '?mediaType=image', `?credentialId=${credentialId}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/models${query}`,
        headers: user.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'platform credential access is not permitted' });
      expect(response.body).not.toContain(credentialId);
      expect(response.body).not.toContain('USD');
      expect(response.body).not.toContain('private.example.invalid');
    }
    expect(listModels).not.toHaveBeenCalled();
    for (const query of ['?mediaType=image', `?credentialId=${credentialId}&mediaType=image`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/models${query}`,
        headers: admin.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().models).toEqual([
        expect.objectContaining({
          id: 'unpublished-provider-image',
          credentialId,
          price: { amount: '0.001', currency: 'USD' },
        }),
      ]);
    }
  });

  it('全局管理设置原样保留，resolvedDefaults 只解析当前 settings 默认且普通用户仍不可读设置', async () => {
    const { app, account, settingsStore, service, resolved } = await routeFixture();
    const admin = await account('admin');
    const user = await account('user');
    const credentialId = randomUUID();
    settingsStore.update({
      defaultModels: { image: { modelAlias: 'selected-image', credentialId } },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/settings/ai',
      headers: admin.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.defaultModels).toEqual({
      image: { modelAlias: 'selected-image', credentialId },
    });
    expect(response.json().resolvedDefaults).toEqual({
      image: { modelAlias: 'current-image-model', platformModelId: resolved.model.id },
    });
    expect(service.resolveLegacyModel).toHaveBeenCalledExactlyOnceWith(
      'selected-image',
      credentialId,
      'image',
    );
    expect(
      (await app.inject({ method: 'GET', url: '/v1/settings/ai', headers: user.headers }))
        .statusCode,
    ).toBe(403);
  });

  it('普通账户 GET/PATCH 不回显内部连接，精确映射独立保留，项目归属检查继续生效', async () => {
    const { app, account, projectStore, resolved } = await routeFixture();
    const owner = await account('user');
    const other = await account('user');
    const project = await projectStore.create(
      { name: 'Private defaults' },
      { ownerId: owner.user.id },
    );
    const credentialId = randomUUID();
    await projectStore.updateModelDefaults(project.id, {
      image: { modelAlias: 'legacy-image', credentialId },
    });
    const url = `/v1/projects/${project.id}/models/defaults`;
    const get = await app.inject({ method: 'GET', url, headers: owner.headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      defaults: { image: { modelAlias: 'legacy-image' } },
      resolvedDefaults: {
        image: { modelAlias: 'current-image-model', platformModelId: resolved.model.id },
      },
    });
    expect(JSON.stringify(get.json())).not.toContain(credentialId);
    expect((await projectStore.getModelDefaults(project.id))?.image).toMatchObject({
      credentialId,
    });
    expect((await app.inject({ method: 'GET', url, headers: other.headers })).statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH',
      url,
      headers: owner.headers,
      payload: {
        image: {
          modelAlias: 'old-alias',
          platformModelId: resolved.model.id,
          credentialId,
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().defaults).toEqual({
      image: { modelAlias: 'old-alias', platformModelId: resolved.model.id },
    });
    expect(patch.json().resolvedDefaults).toEqual({
      image: { modelAlias: 'current-image-model', platformModelId: resolved.model.id },
    });
    expect(JSON.stringify(patch.json())).not.toContain(credentialId);
  });

  it('管理员项目默认管理视图保留原引用；无法映射时不更换模型', async () => {
    const { app, account, projectStore, service } = await routeFixture();
    const owner = await account('admin');
    const project = await projectStore.create(
      { name: 'Admin defaults' },
      { ownerId: owner.user.id },
    );
    const credentialId = randomUUID();
    await projectStore.updateModelDefaults(project.id, {
      image: { modelAlias: 'unmapped-image', credentialId },
    });
    service.resolveLegacyModel.mockRejectedValue(
      new ModelMarketplaceError('model_not_published', '无商品', 409),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/models/defaults`,
      headers: owner.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaults: { image: { modelAlias: 'unmapped-image', credentialId } },
      resolvedDefaults: { image: { modelAlias: 'unmapped-image' } },
    });
  });
});

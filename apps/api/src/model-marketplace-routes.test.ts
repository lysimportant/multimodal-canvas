import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from './auth-service';
import { ModelMarketplaceError, type ModelMarketplace } from './model-marketplace';
import { registerModelMarketplaceRoutes } from './model-marketplace-routes';

/** 合成测试账户与会话由测试 hook 注入，服务 token 不产生真实会话。 */
const actorId = '11111111-1111-4111-8111-111111111111';
/** 所有测试 Fastify 实例均在用例后关闭。 */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** 路由替身验证权限和参数传递；账务与模型行为由服务测试覆盖。 */
function fixture(configured = true) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const sessions = new WeakMap<object, AuthenticatedSession>();
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    if (role !== 'admin' && role !== 'user') return;
    const now = new Date();
    sessions.set(request, {
      user: {
        id: actorId,
        email: 'synthetic@example.invalid',
        role,
        status: 'active',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      session: {
        id: randomUUID(),
        userId: actorId,
        tokenHash: 'synthetic-session-hash',
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: now,
      },
      claims: { sub: actorId, role },
    });
  });
  const service = {
    listPublished: vi.fn(async () => ({ items: [], page: 1, pageSize: 30, total: 0 })),
    listAdmin: vi.fn(async () => ({ items: [], page: 1, pageSize: 30, total: 0 })),
    getAdmin: vi.fn(async () => ({ id: randomUUID(), status: 'draft' })),
    createModel: vi.fn(async () => ({ id: randomUUID(), status: 'draft' })),
    updateModel: vi.fn(async () => ({ id: randomUUID(), status: 'paused' })),
    deleteModel: vi.fn(async () => undefined),
    listBindings: vi.fn(async () => ({ items: [], page: 1, pageSize: 30, total: 0 })),
    createBinding: vi.fn(async () => ({ id: randomUUID() })),
    listPricing: vi.fn(async () => ({ items: [], page: 1, pageSize: 30, total: 0 })),
    createPricing: vi.fn(async () => ({ id: randomUUID(), currency: 'CNY' })),
    sync: vi.fn(async () => ({ id: randomUUID(), status: 'succeeded' })),
    syncConnections: vi.fn(async () => ({ connections: [] })),
    getSync: vi.fn(async () => null),
  };
  registerModelMarketplaceRoutes(app, {
    marketplace: configured ? (service as unknown as ModelMarketplace) : undefined,
    sessions,
  });
  return { app, service };
}

describe('model marketplace routes', () => {
  it('管理员可同步指定或全部连接，禁止额外字段或无效凭据 ID', async () => {
    const { app, service } = fixture();
    const url = '/v1/admin/model-marketplace/connections/sync';
    const headers = { 'x-test-role': 'admin' };
    const credentialId = randomUUID();
    for (const payload of [{}, { credentialId }]) {
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
      expect(service.syncConnections).toHaveBeenLastCalledWith(payload.credentialId, actorId);
    }
    for (const payload of [{ credentialId: 'bad' }, { actorId }, { apiKey: 'synthetic' }])
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
  });
  it('管理员删除返回空 204，路径与业务错误明确返回', async () => {
    const { app, service } = fixture();
    const id = randomUUID();
    const request = {
      method: 'DELETE' as const,
      url: `/v1/admin/model-marketplace/models/${id}`,
      headers: { 'x-test-role': 'admin' },
    };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(service.deleteModel).toHaveBeenCalledWith(id);
    expect(
      (await app.inject({ ...request, url: '/v1/admin/model-marketplace/models/invalid' }))
        .statusCode,
    ).toBe(400);
    service.deleteModel.mockRejectedValueOnce(
      new ModelMarketplaceError('platform_model_not_found', '平台模型不存在', 404),
    );
    expect((await app.inject(request)).statusCode).toBe(404);
  });
  it('所有管理接口拒绝匿名、服务 token 和普通用户', async () => {
    const { app, service } = fixture();
    const modelId = randomUUID();
    const routes = [
      ['GET', '/v1/admin/model-marketplace/models'],
      ['POST', '/v1/admin/model-marketplace/models'],
      ['GET', `/v1/admin/model-marketplace/models/${modelId}`],
      ['PATCH', `/v1/admin/model-marketplace/models/${modelId}`],
      ['DELETE', `/v1/admin/model-marketplace/models/${modelId}`],
      ['GET', `/v1/admin/model-marketplace/models/${modelId}/bindings`],
      ['POST', `/v1/admin/model-marketplace/models/${modelId}/bindings`],
      ['GET', `/v1/admin/pricing-versions?platformModelId=${modelId}`],
      ['POST', '/v1/admin/pricing-versions'],
      ['GET', `/v1/admin/model-marketplace/sync?credentialId=${randomUUID()}`],
      ['POST', '/v1/admin/model-marketplace/sync'],
      ['POST', '/v1/admin/model-marketplace/connections/sync'],
    ] as const;
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { authorization: 'Bearer synthetic-service-token' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method, url, headers: { 'x-test-role': 'user' } })).statusCode,
      ).toBe(403);
    }
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });

  it('已登录普通用户读取公开目录，无法自定义草稿状态或超出分页上限', async () => {
    const { app, service } = fixture();
    expect((await app.inject({ method: 'GET', url: '/v1/model-marketplace' })).statusCode).toBe(
      401,
    );
    const headers = { 'x-test-role': 'user' };
    const response = await app.inject({
      method: 'GET',
      url: '/v1/model-marketplace?mediaType=image&pageSize=20',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.listPublished).toHaveBeenCalledWith({
      mediaType: 'image',
      page: 1,
      pageSize: 20,
    });
    for (const query of ['status=draft', 'pageSize=101', 'credentialId=private']) {
      expect(
        (await app.inject({ method: 'GET', url: `/v1/model-marketplace?${query}`, headers }))
          .statusCode,
      ).toBe(400);
    }
  });

  it('管理员创建与同步使用服务端会话身份，不接受请求体冒充操作者', async () => {
    const { app, service } = fixture();
    const headers = { 'x-test-role': 'admin' };
    const payload = { name: '手工模型', mediaType: 'image' };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-marketplace/models',
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toHaveProperty('model.id');
    expect(service.createModel).toHaveBeenCalledWith(payload, actorId);
    const credentialId = randomUUID();
    const sync = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-marketplace/sync',
      headers,
      payload: { credentialId },
    });
    expect(sync.statusCode).toBe(200);
    expect(service.sync).toHaveBeenCalledWith(credentialId, actorId, 'models');
    const pricing = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-marketplace/sync',
      headers,
      payload: { credentialId, sourceType: 'newapi_pricing' },
    });
    expect(pricing.statusCode).toBe(200);
    expect(service.sync).toHaveBeenCalledWith(credentialId, actorId, 'newapi_pricing');
    expect(
      (
        await app.inject({
          url: `/v1/admin/model-marketplace/sync?credentialId=${credentialId}&sourceType=newapi_pricing`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.getSync).toHaveBeenCalledWith(credentialId, 'newapi_pricing');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/model-marketplace/sync',
          headers,
          payload: { credentialId, sourceType: 'other', url: 'https://synthetic.invalid' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/model-marketplace/sync',
          headers,
          payload: { credentialId, createdBy: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('无持久化服务时返回503，已知模型错误保留稳定状态码', async () => {
    const unavailable = fixture(false);
    expect(
      (
        await unavailable.app.inject({
          method: 'GET',
          url: '/v1/model-marketplace',
          headers: { 'x-test-role': 'user' },
        })
      ).statusCode,
    ).toBe(503);
    const { app, service } = fixture();
    service.updateModel.mockRejectedValue(
      new ModelMarketplaceError('model_setup_incomplete', '模型需要售价', 409),
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/model-marketplace/models/${randomUUID()}`,
      headers: { 'x-test-role': 'admin' },
      payload: { status: 'published' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'model_setup_incomplete', error: '模型需要售价' });
  });
});

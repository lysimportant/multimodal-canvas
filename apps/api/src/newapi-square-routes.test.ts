import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialEncryptionError } from '@multimodal-canvas/credential-crypto';
import type { AuthenticatedSession } from './auth-service';
import { NewApiSquareError, type PrismaNewApiSquare } from './newapi-square';
import { registerNewApiSquareRoutes } from './newapi-square-routes';

/** 测试 hook 只注入合成真实会话；服务令牌不能产生会话。 */
const actorId = randomUUID();
/** 每个路由实例独立关闭，不共享登录状态。 */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** 权限测试覆盖所有入口，服务层行为由持久化与上游测试验证。 */
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
        email: 'square@example.invalid',
        role,
        status: 'active',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      session: {
        id: randomUUID(),
        userId: actorId,
        tokenHash: 'synthetic-unused',
        expiresAt: new Date(Date.now() + 60000),
        createdAt: now,
      },
      claims: { sub: actorId, role },
    });
  });
  const service = {
    published: vi.fn(async () => ({
      configured: false,
      url: null,
      snapshot: null,
      availableModels: [],
    })),
    admin: vi.fn(async () => ({ authorized: false })),
    configure: vi.fn(async () => ({})),
    sync: vi.fn(async () => ({ results: [] })),
    edit: vi.fn(async () => ({})),
    saveDraft: vi.fn(async () => ({})),
    discard: vi.fn(async () => ({})),
  };
  registerNewApiSquareRoutes(app, {
    square: configured ? (service as unknown as PrismaNewApiSquare) : undefined,
    sessions,
  });
  return { app, service };
}

describe('New API 广场权限边界', () => {
  it('匿名、服务令牌和普通用户均不能管理来源、授权、草稿或写回', async () => {
    const { app, service } = fixture();
    const root = '/v1/admin/model-marketplace/newapi';
    const routes = [
      ['GET', root],
      ['PUT', root],
      ['POST', `${root}/sync`],
      ['GET', `${root}/price?modelName=Exact`],
      ['PUT', `${root}/price`],
      ['DELETE', `${root}/price?modelName=Exact&revision=1&sourceRevision=1`],
    ] as const;
    for (const [method, url] of routes) {
      for (const headers of [{}, { authorization: 'Bearer synthetic-service-token' }])
        expect((await app.inject({ method, url, headers })).statusCode).toBe(401);
      expect(
        (await app.inject({ method, url, headers: { 'x-test-role': 'user' } })).statusCode,
      ).toBe(403);
    }
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/v1/model-marketplace/newapi',
      headers: { 'x-test-role': 'user' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).not.toHaveProperty('authorized');
  });

  it('管理员传递精确模型名、当前来源和会话身份；非法撤销请求不会调用服务', async () => {
    const { app, service } = fixture();
    const headers = { 'x-test-role': 'admin' };
    const url = '/v1/admin/model-marketplace/newapi/price';
    const payload = {
      modelName: 'Exact/Name（按次）',
      revision: 0,
      sourceRevision: 1,
      expectedVersion: 'v1',
      pricing: { ModelPrice: 3 },
    };
    expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledWith(payload, actorId);
    expect(
      (await app.inject({ method: 'DELETE', url: `${url}?modelName=Exact&revision=1`, headers }))
        .statusCode,
    ).toBe(400);
    expect(service.discard).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `${url}?modelName=Exact&revision=2&sourceRevision=3`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.discard).toHaveBeenCalledWith('Exact', 2, 3);
  });

  it('未配置数据库、价格冲突和不可解密授权分别返回稳定错误', async () => {
    const headers = { 'x-test-role': 'admin' };
    const url = '/v1/admin/model-marketplace/newapi/sync';
    expect((await fixture(false).app.inject({ method: 'POST', url, headers })).statusCode).toBe(
      503,
    );
    const { app, service } = fixture();
    service.sync.mockRejectedValueOnce(
      new NewApiSquareError('upstream_price_conflict', '价格冲突', 409),
    );
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { sourceRevision: 1 } }))
        .statusCode,
    ).toBe(409);
    service.sync.mockRejectedValueOnce(
      new CredentialEncryptionError('decryption_failed', 'synthetic-sensitive-value'),
    );
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { sourceRevision: 1 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('synthetic-sensitive-value');
  });
});

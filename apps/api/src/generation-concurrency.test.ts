import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './fixtures/test-app';
import { TestAuthContext } from './fixtures/auth-session';
import { createGenerationConcurrencyStore } from './generation-concurrency';

/** 模拟 Redis 元数据；重建 API 存储对象不会清除同一队列的设置。 */
function queueFixture() {
  let saved: number | null = null;
  const queue = {
    getGlobalConcurrency: vi.fn(async () => saved),
    setGlobalConcurrency: vi.fn(async (value: number) => {
      saved = value;
      return 1;
    }),
    removeGlobalConcurrency: vi.fn(async () => {
      saved = null;
    }),
  };
  return { queue, store: createGenerationConcurrencyStore(queue) };
}
const apps: FastifyInstance[] = [];
/** 创建真实认证会话和隔离内存业务存储，不访问业务数据库。 */
async function fixture(role: 'admin' | 'user' = 'admin') {
  const context = new TestAuthContext();
  const token = await context.session({ email: role + '@example.test', role });
  const queue = queueFixture();
  const app = buildApp({
    ...context.appOptions,
    generationConcurrencyStore: queue.store,
    logger: false,
  });
  apps.push(app);
  return {
    ...queue,
    app,
    context,
    token,
    headers: { authorization: 'Bearer ' + token.accessToken },
  };
}
const endpoint = '/v1/admin/generation-concurrency';
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-concurrency-session-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('管理员生成并发 API', () => {
  it('API 先启动时明确未初始化，管理员保存 32 后读回且重建存储保留', async () => {
    const f = await fixture();
    const missing = await f.app.inject({ method: 'GET', url: endpoint, headers: f.headers });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().code).toBe('generation_concurrency_unconfigured');
    expect(missing.json()).not.toHaveProperty('settings');
    expect(await f.store.get()).toBeNull();
    expect(f.queue.setGlobalConcurrency).not.toHaveBeenCalled();
    const updated = await f.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: f.headers,
      payload: { concurrency: 32 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ settings: { concurrency: 32, scope: 'queue' } });
    expect(
      (await f.app.inject({ method: 'GET', url: endpoint, headers: f.headers })).json(),
    ).toEqual(updated.json());
    expect(await createGenerationConcurrencyStore(f.queue).get()).toEqual(updated.json().settings);
    expect(f.queue.setGlobalConcurrency).toHaveBeenCalledExactlyOnceWith(32);
  });

  it('已保存 20 的配置丢失后也返回缺失状态，允许明确重新保存同值', async () => {
    const f = await fixture();
    await f.store.update(20);
    await f.queue.removeGlobalConcurrency();
    const missing = await f.app.inject({ method: 'GET', url: endpoint, headers: f.headers });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().code).toBe('generation_concurrency_unconfigured');
    expect(missing.json()).not.toHaveProperty('settings');
    expect(await f.queue.getGlobalConcurrency()).toBeNull();
    expect(f.queue.setGlobalConcurrency).toHaveBeenCalledTimes(1);
    const restored = await f.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: f.headers,
      payload: { concurrency: 20 },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ settings: { concurrency: 20, scope: 'queue' } });
    expect(await f.store.get()).toEqual(restored.json().settings);
    expect(f.queue.setGlobalConcurrency).toHaveBeenCalledTimes(2);
  });

  it.each([1, 21, 100, Number.MAX_SAFE_INTEGER])('接受正安全整数 %s', async (concurrency) => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          method: 'PATCH',
          url: endpoint,
          headers: f.headers,
          payload: { concurrency },
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    {},
    { concurrency: 0 },
    { concurrency: -1 },
    { concurrency: 1.5 },
    { concurrency: '20' },
    { concurrency: null },
    { concurrency: Number.MAX_SAFE_INTEGER + 1 },
    { concurrency: 20, scope: 'project' },
    { concurrency: 20, userId: 'forged' },
  ])('拒绝非法更新 %j，队列不写入', async (payload) => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: f.headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_generation_concurrency');
    expect(f.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('普通用户读写均为 403，不能通过请求体声称管理员', async () => {
    const f = await fixture('user');
    for (const method of ['GET', 'PATCH'] as const) {
      const response = await f.app.inject({
        method,
        url: endpoint,
        headers: f.headers,
        ...(method === 'PATCH' ? { payload: { concurrency: 32, role: 'admin' } } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('admin_required');
    }
    expect(f.queue.getGlobalConcurrency).not.toHaveBeenCalled();
    expect(f.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('即使本机匿名设置被允许，也不开放全局队列配置', async () => {
    vi.stubEnv('API_JWT_SECRET', '');
    vi.stubEnv('API_ALLOW_ANONYMOUS_SETTINGS', 'true');
    const q = queueFixture();
    const app = buildApp({ generationConcurrencyStore: q.store, logger: false });
    apps.push(app);
    for (const method of ['GET', 'PATCH'] as const) {
      const response = await app.inject({
        method,
        url: endpoint,
        ...(method === 'PATCH' ? { payload: { concurrency: 32 } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(q.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('静态服务令牌不是管理员会话', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'synthetic-service-token');
    const f = await fixture();
    const response = await f.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: { authorization: 'Bearer synthetic-service-token' },
      payload: { concurrency: 32 },
    });
    expect(response.statusCode).toBe(401);
    expect(f.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('无状态 JWT 的 admin 声明不能提升为可信管理员', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const prefix =
      encode({ alg: 'HS256', typ: 'JWT' }) +
      '.' +
      encode({ sub: randomUUID(), exp: Math.floor(Date.now() / 1000) + 600, role: 'admin' });
    const jwt =
      prefix +
      '.' +
      createHmac('sha256', process.env.API_JWT_SECRET!).update(prefix).digest('base64url');
    const q = queueFixture();
    const app = buildApp({
      userExists: async () => true,
      generationConcurrencyStore: q.store,
      logger: false,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: { authorization: 'Bearer ' + jwt },
      payload: { concurrency: 32 },
    });
    expect(response.statusCode).toBe(401);
    expect(q.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('会话撤销后旧管理员凭证也不能继续保存', async () => {
    const f = await fixture();
    await f.context.store.revokeAllSessions(f.token.user.id, new Date());
    const response = await f.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: f.headers,
      payload: { concurrency: 32 },
    });
    expect(response.statusCode).toBe(401);
    expect(f.queue.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('没有实际队列配置存储时返回 503，不提供伪持久化', async () => {
    const f = await fixture();
    const app = buildApp({ ...f.context.appOptions, logger: false });
    apps.push(app);
    for (const method of ['GET', 'PATCH'] as const) {
      expect(
        (
          await app.inject({
            method,
            url: endpoint,
            headers: f.headers,
            ...(method === 'PATCH' ? { payload: { concurrency: 32 } } : {}),
          })
        ).statusCode,
      ).toBe(503);
    }
  });

  it.each(['GET', 'PATCH'] as const)('Redis 失败时 %s 明确失败且不泄露连接内容', async (method) => {
    const f = await fixture();
    const failure = new Error('synthetic-sensitive-connection-details');
    f.queue.getGlobalConcurrency.mockRejectedValue(failure);
    f.queue.setGlobalConcurrency.mockRejectedValue(failure);
    const response = await f.app.inject({
      method,
      url: endpoint,
      headers: f.headers,
      ...(method === 'PATCH' ? { payload: { concurrency: 32 } } : {}),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('generation_concurrency_unavailable');
    expect(response.body).not.toContain(failure.message);
  });

  it('已保存配置损坏时显式失败，不静默回退默认值', async () => {
    const f = await fixture();
    f.queue.getGlobalConcurrency.mockResolvedValue(0);
    const response = await f.app.inject({ method: 'GET', url: endpoint, headers: f.headers });
    expect(response.statusCode).toBe(503);
  });
});

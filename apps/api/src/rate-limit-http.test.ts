import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { FallbackRateLimiter, MemoryRateLimiter } from './rate-limit';
import { openApiDocument } from './openapi';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('API_AUTH_TOKEN', 'synthetic-rate-limit-token');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-rate-limit-jwt');
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '2');
  vi.stubEnv('API_SSE_RATE_LIMIT_PER_MINUTE', '2');
});

afterEach(() => vi.unstubAllEnvs());

describe('生产全局限流 HTTP 故障边界', () => {
  it('OpenAPI 区分全局限流依赖故障并记录重试秒数契约', () => {
    const response = openApiDocument.components.responses.RateLimitUnavailable;
    expect(response.headers['Retry-After'].schema.minimum).toBe(1);
    expect(response.content['application/json'].schema.properties.code.const).toBe(
      'rate_limit_unavailable',
    );
    expect(openApiDocument.paths['/v1/projects'].get.responses['503']).toEqual({
      $ref: '#/components/responses/RateLimitUnavailable',
    });
    expect(openApiDocument.paths['/v1/projects/{projectId}/events'].get.responses['503']).toEqual({
      $ref: '#/components/responses/RateLimitUnavailable',
    });
  });

  it.each([
    { method: 'GET' as const, url: '/v1/projects' },
    { method: 'GET' as const, url: '/v1/projects/test-project/events' },
    { method: 'POST' as const, url: '/v1/auth/login' },
    { method: 'POST' as const, url: '/v1/auth/register' },
  ])('$method $url 在 Redis 故障期间返回可诊断的 503 且不消费本机额度', async (route) => {
    const primary = { consume: vi.fn().mockRejectedValue(new Error('private-redis-password')) };
    const fallback = { consume: vi.fn() };
    const logs: string[] = [];
    const app = buildApp({
      logger: { stream: { write: (message) => logs.push(message) } },
      rateLimiter: new FallbackRateLimiter(primary, fallback, {
        failureMode: 'closed',
        failureCooldownMs: 30_000,
      }),
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          ...route,
          headers: { authorization: 'Bearer synthetic-rate-limit-token' },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          error: 'rate limit service unavailable',
          code: 'rate_limit_unavailable',
          requestId: expect.any(String),
          retryAfterSeconds: expect.any(Number),
        });
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(response.body).not.toContain('private-redis-password');
        expect(response.headers['x-ratelimit-remaining']).toBeUndefined();
      }
      expect(primary.consume).toHaveBeenCalledOnce();
      expect(fallback.consume).not.toHaveBeenCalled();
      expect(logs.join('')).not.toContain('private-redis-password');
      expect(logs.join('')).toContain('global rate limiter unavailable');
    } finally {
      await app.close();
    }
  });

  it('故障时健康检查仍可用，未认证请求仍返回 401', async () => {
    const primary = { consume: vi.fn().mockRejectedValue(new Error('unavailable')) };
    const app = buildApp({
      logger: false,
      rateLimiter: new FallbackRateLimiter(primary, new MemoryRateLimiter(), {
        failureMode: 'closed',
      }),
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/projects' })).statusCode).toBe(401);
      expect(primary.consume).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('真实 HTTP 监听完成健康检查、授权访问、故障拒绝和恢复冒烟', async () => {
    /** 注入的故障开关只影响当前冒烟实例，不操作真实 Redis 服务。 */
    let unavailable = false;
    const sharedPrimary = new MemoryRateLimiter();
    const app = buildApp({
      logger: false,
      rateLimiter: new FallbackRateLimiter(
        {
          consume: async (key, options) => {
            if (unavailable) throw new Error('unavailable');
            return sharedPrimary.consume(key, options);
          },
        },
        new MemoryRateLimiter(),
        { failureMode: 'closed', failureCooldownMs: 0 },
      ),
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const headers = { authorization: 'Bearer synthetic-rate-limit-token' };
      const health = await fetch(`${address}/health`, { signal: AbortSignal.timeout(5_000) });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });
      const allowed = await fetch(`${address}/v1/projects`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      expect(allowed.status).toBe(200);
      await allowed.arrayBuffer();
      unavailable = true;
      const blocked = await fetch(`${address}/v1/projects`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(await blocked.json()).toMatchObject({ code: 'rate_limit_unavailable' });
      unavailable = false;
      const recovered = await fetch(`${address}/v1/projects`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      expect(recovered.status).toBe(200);
      await recovered.arrayBuffer();
    } finally {
      await app.close();
    }
  });

  it('跨两个 HTTP 实例共享额度，故障恢复后不重置窗口', async () => {
    let now = 0;
    const sharedPrimary = new MemoryRateLimiter({ now: () => now });
    let unavailable = false;
    const primary = {
      consume: vi.fn(async (key, options) => {
        if (unavailable) throw new Error('unavailable');
        return sharedPrimary.consume(key, options);
      }),
    };
    const apps = Array.from({ length: 2 }, () =>
      buildApp({
        logger: false,
        rateLimiter: new FallbackRateLimiter(primary, new MemoryRateLimiter(), {
          failureMode: 'closed',
          failureCooldownMs: 1_000,
          now: () => now,
        }),
      }),
    );
    const request = {
      method: 'GET' as const,
      url: '/v1/projects',
      headers: { authorization: 'Bearer synthetic-rate-limit-token' },
    };
    try {
      expect((await apps[0]!.inject(request)).statusCode).toBe(200);
      expect((await apps[1]!.inject(request)).statusCode).toBe(200);
      unavailable = true;
      expect((await apps[0]!.inject(request)).statusCode).toBe(503);
      expect((await apps[1]!.inject(request)).statusCode).toBe(503);
      unavailable = false;
      now = 1_000;
      expect((await apps[0]!.inject(request)).statusCode).toBe(429);
      expect((await apps[1]!.inject(request)).statusCode).toBe(429);
      now = 60_000;
      expect((await apps[0]!.inject(request)).statusCode).toBe(200);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });
});

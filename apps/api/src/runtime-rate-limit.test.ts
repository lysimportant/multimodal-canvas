import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Redis from 'ioredis';
import { RateLimitUnavailableError } from './rate-limit';
import { createApiRateLimiter } from './runtime-rate-limit';

/** 隔离 Redis 网络和诊断事件，验证入口真实使用的策略。 */
const redisClient = vi.hoisted(() => ({
  connect: vi.fn(),
  eval: vi.fn(),
  quit: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
}));

vi.mock('ioredis', () => ({ default: vi.fn(() => redisClient) }));

beforeEach(() => {
  vi.clearAllMocks();
  redisClient.connect.mockResolvedValue(undefined);
  redisClient.eval.mockResolvedValue([1, 60_000, 1]);
  redisClient.quit.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('API 入口限流策略', () => {
  it('开发环境默认只使用内存，不建立 Redis 连接', async () => {
    const limiter = await createApiRateLimiter({ NODE_ENV: 'development' });
    expect(Redis).not.toHaveBeenCalled();
    expect(await limiter.consume('client', { limit: 1, windowMs: 60_000 })).toMatchObject({
      allowed: true,
    });
    expect(await limiter.consume('client', { limit: 1, windowMs: 60_000 })).toMatchObject({
      allowed: false,
    });
  });

  it.each([
    { NODE_ENV: 'production' },
    {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://127.0.0.1:6379',
      API_RATE_LIMIT_REDIS_ENABLED: 'false',
    },
  ])('生产配置不完整时不能构造内存限流器', async (environment) => {
    await expect(createApiRateLimiter(environment)).rejects.toThrow('Redis 全局限流');
    expect(Redis).not.toHaveBeenCalled();
  });

  it('等待 Redis 就绪后才返回，避免首次正常请求误入故障冷却', async () => {
    const limiter = await createApiRateLimiter({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
    expect(redisClient.connect).toHaveBeenCalledOnce();
    expect(Redis).toHaveBeenCalledWith(
      'redis://127.0.0.1:6379',
      expect.objectContaining({
        enableOfflineQueue: false,
        connectTimeout: 1_000,
        commandTimeout: 1_000,
      }),
    );
    expect(await limiter.consume('client', { limit: 1, windowMs: 60_000 })).toMatchObject({
      allowed: true,
    });
    redisClient.eval.mockRejectedValue(new Error('private-redis-diagnostic'));
    await expect(limiter.consume('client', { limit: 1, windowMs: 60_000 })).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      'private-redis-diagnostic',
    );
    await limiter.close?.();
    expect(redisClient.quit).toHaveBeenCalledOnce();
  });

  it('生产首次连接失败会关闭客户端，并且异常和诊断不包含连接凭据', async () => {
    redisClient.connect.mockRejectedValue(new Error('redis://user:private-password@invalid'));
    await expect(
      createApiRateLimiter({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(redisClient.disconnect).toHaveBeenCalledOnce();
    const errorListener = redisClient.on.mock.calls.find(([event]) => event === 'error')?.[1];
    expect(errorListener).toBeTypeOf('function');
    errorListener(new Error('private-password'));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-password');
  });

  it('开发环境显式启用 Redis 后仍允许连接故障时有界回退', async () => {
    redisClient.connect.mockRejectedValue(new Error('unavailable'));
    redisClient.eval.mockRejectedValue(new Error('unavailable'));
    const limiter = await createApiRateLimiter({
      NODE_ENV: 'development',
      API_RATE_LIMIT_REDIS_ENABLED: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
    expect(await limiter.consume('client', { limit: 1, windowMs: 60_000 })).toMatchObject({
      allowed: true,
    });
    expect(await limiter.consume('client', { limit: 1, windowMs: 60_000 })).toMatchObject({
      allowed: false,
    });
    await limiter.close?.();
  });
});

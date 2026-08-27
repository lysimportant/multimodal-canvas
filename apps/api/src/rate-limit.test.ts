import { describe, expect, it, vi } from 'vitest';

import {
  FallbackRateLimiter,
  MemoryRateLimiter,
  RedisRateLimiter,
  type RedisRateLimitClient,
} from './rate-limit';

describe('MemoryRateLimiter', () => {
  it('tracks a fixed window and exposes reset metadata', async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter({ now: () => now });

    await expect(
      limiter.consume('client-a', { limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 61_000,
    });
    await expect(
      limiter.consume('client-a', { limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(
      limiter.consume('client-a', { limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    now = 61_000;
    await expect(
      limiter.consume('client-a', { limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 121_000,
    });
  });

  it('bounds the fallback map and removes expired keys', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter({ maxEntries: 2, now: () => now });

    await limiter.consume('a', { limit: 1, windowMs: 100 });
    await limiter.consume('b', { limit: 1, windowMs: 100 });
    await limiter.consume('c', { limit: 1, windowMs: 100 });
    expect(limiter.size).toBe(2);

    now = 100;
    await limiter.consume('d', { limit: 1, windowMs: 100 });
    expect(limiter.size).toBe(1);
  });
});

describe('RedisRateLimiter', () => {
  it('uses an atomic script and hashes client keys', async () => {
    const evalMock = vi.fn().mockResolvedValue(['2', '45000']);
    const client: RedisRateLimitClient = { eval: evalMock };
    let now = 10_000;
    const limiter = new RedisRateLimiter(client, { keyPrefix: 'test-prefix', now: () => now });

    const decision = await limiter.consume('ip:127.0.0.1', { limit: 2, windowMs: 60_000 });
    expect(decision).toEqual({
      allowed: true,
      limit: 2,
      remaining: 0,
      resetAt: 55_000,
      retryAfterSeconds: 45,
    });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keyCount, key, windowMs, limit] = evalMock.mock.calls[0] as [
      string,
      number,
      string,
      string,
      string,
    ];
    expect(script).toContain("redis.call('INCR'");
    expect(keyCount).toBe(1);
    expect(key).toMatch(/^test-prefix:/);
    expect(windowMs).toBe('60000');
    expect(limit).toBe('2');
  });
});

describe('FallbackRateLimiter', () => {
  it('keeps enforcing limits when Redis is unavailable', async () => {
    let now = 0;
    const primary: RedisRateLimitClient = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const fallback = new MemoryRateLimiter({ now: () => now });
    const errors: unknown[] = [];
    const limiter = new FallbackRateLimiter(
      new RedisRateLimiter(primary, { now: () => now }),
      fallback,
      { failureCooldownMs: 10_000, now: () => now, onPrimaryError: (error) => errors.push(error) },
    );

    await expect(
      limiter.consume('client-a', { limit: 1, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      limiter.consume('client-a', { limit: 1, windowMs: 60_000 }),
    ).resolves.toMatchObject({
      allowed: false,
    });
    expect(errors).toHaveLength(1);
    expect(primary.eval).toHaveBeenCalledTimes(1);

    now = 10_000;
    await limiter.consume('client-b', { limit: 1, windowMs: 60_000 });
    expect(primary.eval).toHaveBeenCalledTimes(2);
  });
});

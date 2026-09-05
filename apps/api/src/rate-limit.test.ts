import { describe, expect, it, vi } from 'vitest';

import {
  FallbackRateLimiter,
  MemoryRateLimiter,
  RateLimitUnavailableError,
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

describe('RateLimitUnavailableError', () => {
  it('允许无参构造，公开固定消息与默认重试秒数且不包含 cause', () => {
    const error = new RateLimitUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RateLimitUnavailableError);
    expect(error.name).toBe('RateLimitUnavailableError');
    expect(error.message).toBe('Rate limit service unavailable');
    expect(error.retryAfterSeconds).toBe(1);
    expect(error).not.toHaveProperty('cause');
    expect(new RateLimitUnavailableError(31).retryAfterSeconds).toBe(31);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝无效重试秒数 %s',
    (retryAfterSeconds) => {
      expect(() => new RateLimitUnavailableError(retryAfterSeconds)).toThrow(TypeError);
    },
  );
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

  it('closed 首次故障和冷却期间只抛脱敏错误，按剩余时间向上取整且不消费内存', async () => {
    let now = 1_000;
    const primaryError = new Error('private Redis diagnostic');
    const primary = { consume: vi.fn().mockRejectedValue(primaryError) };
    const fallback = new MemoryRateLimiter({ now: () => now });
    const consumeFallback = vi.spyOn(fallback, 'consume');
    const onPrimaryError = vi.fn();
    const limiter = new FallbackRateLimiter(primary, fallback, {
      failureMode: 'closed',
      failureCooldownMs: 2_501,
      now: () => now,
      onPrimaryError,
    });

    for (const [time, retryAfterSeconds] of [
      [1_000, 3],
      [1_501, 2],
      [2_501, 1],
      [3_500, 1],
    ]) {
      now = time;
      const request = limiter.consume('client-a', { limit: 1, windowMs: 60_000 });
      await expect(request).rejects.toBeInstanceOf(RateLimitUnavailableError);
      await expect(request).rejects.toMatchObject({
        message: 'Rate limit service unavailable',
        retryAfterSeconds,
      });
      await expect(request).rejects.not.toHaveProperty('cause');
      await expect(request).rejects.toHaveProperty(
        'stack',
        expect.not.stringContaining(primaryError.message),
      );
      await expect(request).rejects.toHaveProperty(
        'message',
        expect.not.stringContaining(primaryError.message),
      );
    }
    expect(primary.consume).toHaveBeenCalledTimes(1);
    expect(onPrimaryError).toHaveBeenCalledExactlyOnceWith(primaryError);
    expect(consumeFallback).not.toHaveBeenCalled();
    expect(fallback.size).toBe(0);
  });

  it.each(['fallback', 'closed'] as const)(
    '%s 在冷却边界恢复主限流，后续再次失败重新计时',
    async (failureMode) => {
      let now = 0;
      const evalMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce([1, 60_000, 1])
        .mockResolvedValueOnce([1, 60_000, 0])
        .mockRejectedValueOnce(new Error('unavailable again'))
        .mockResolvedValue([1, 60_000, 1]);
      const fallback = new MemoryRateLimiter({ now: () => now });
      const consumeFallback = vi.spyOn(fallback, 'consume');
      const onPrimaryError = vi.fn();
      const limiter = new FallbackRateLimiter(
        new RedisRateLimiter({ eval: evalMock }, { now: () => now }),
        fallback,
        { failureMode, failureCooldownMs: 2_501, now: () => now, onPrimaryError },
      );

      const first = limiter.consume('client-a', { limit: 1, windowMs: 60_000 });
      if (failureMode === 'closed') {
        await expect(first).rejects.toMatchObject({ retryAfterSeconds: 3 });
      } else {
        await expect(first).resolves.toMatchObject({ allowed: true });
      }
      now = 2_501;
      await expect(
        limiter.consume('client-a', { limit: 1, windowMs: 60_000 }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        limiter.consume('client-a', { limit: 1, windowMs: 60_000 }),
      ).resolves.toMatchObject({ allowed: false });
      now = 3_000;
      const second = limiter.consume('client-a', { limit: 1, windowMs: 60_000 });
      if (failureMode === 'closed') {
        await expect(second).rejects.toMatchObject({ retryAfterSeconds: 3 });
      } else {
        await expect(second).resolves.toMatchObject({ allowed: false });
      }
      now = 5_501;
      await expect(
        limiter.consume('client-a', { limit: 1, windowMs: 60_000 }),
      ).resolves.toMatchObject({ allowed: true });
      expect(evalMock).toHaveBeenCalledTimes(5);
      expect(onPrimaryError).toHaveBeenCalledTimes(2);
      expect(consumeFallback).toHaveBeenCalledTimes(failureMode === 'closed' ? 0 : 2);
    },
  );

  it.each(['fallback', 'closed'] as const)(
    '%s 隔离观察回调同步抛错，冷却期间不重复调用回调',
    async (failureMode) => {
      const primaryError = new Error('private Redis diagnostic');
      const callbackError = new Error('private callback diagnostic');
      const primary = { consume: vi.fn().mockRejectedValue(primaryError) };
      const fallback = new MemoryRateLimiter();
      const consumeFallback = vi.spyOn(fallback, 'consume');
      const onPrimaryError = vi.fn(() => {
        throw callbackError;
      });
      const limiter = new FallbackRateLimiter(primary, fallback, {
        failureMode,
        now: () => 0,
        onPrimaryError,
      });

      for (const allowed of [true, false]) {
        const request = limiter.consume('client-a', { limit: 1, windowMs: 60_000 });
        if (failureMode === 'closed') {
          await expect(request).rejects.toBeInstanceOf(RateLimitUnavailableError);
          await expect(request).rejects.toMatchObject({ retryAfterSeconds: 30 });
          await expect(request).rejects.not.toHaveProperty('cause');
          await expect(request).rejects.not.toBe(callbackError);
          await expect(request).rejects.toHaveProperty(
            'stack',
            expect.not.stringContaining(callbackError.message),
          );
        } else {
          await expect(request).resolves.toMatchObject({ allowed });
        }
      }
      expect(onPrimaryError).toHaveBeenCalledExactlyOnceWith(primaryError);
      expect(primary.consume).toHaveBeenCalledTimes(1);
      expect(consumeFallback).toHaveBeenCalledTimes(failureMode === 'closed' ? 0 : 2);
    },
  );

  it('零冷却仍提供至少 1 秒 Retry-After，下一次调用立即重试主限流器', async () => {
    const primary = { consume: vi.fn().mockRejectedValue(new Error('unavailable')) };
    const fallback = { consume: vi.fn() };
    const limiter = new FallbackRateLimiter(primary, fallback, {
      failureMode: 'closed',
      failureCooldownMs: 0,
      now: () => 0,
    });
    for (const key of ['client-a', 'client-b']) {
      await expect(limiter.consume(key, { limit: 1, windowMs: 1 })).rejects.toMatchObject({
        retryAfterSeconds: 1,
      });
    }
    expect(primary.consume).toHaveBeenCalledTimes(2);
    expect(fallback.consume).not.toHaveBeenCalled();
  });

  describe.each(['fallback', 'closed'] as const)('%s 输入验证', (failureMode) => {
    it.each([
      ['', { limit: 1, windowMs: 1 }],
      ['  ', { limit: 1, windowMs: 1 }],
      ['client-a', { limit: 0, windowMs: 1 }],
      ['client-a', { limit: -1, windowMs: 1 }],
      ['client-a', { limit: 1.5, windowMs: 1 }],
      ['client-a', { limit: NaN, windowMs: 1 }],
      ['client-a', { limit: 1, windowMs: 0 }],
      ['client-a', { limit: 1, windowMs: Infinity }],
      ['client-a', { limit: 1, windowMs: Number.MAX_SAFE_INTEGER + 1 }],
    ])('坏输入 %j %j 不触发主请求、回调或备用限流', async (key, options) => {
      const primary = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
      const fallback = { consume: vi.fn() };
      const onPrimaryError = vi.fn();
      const limiter = new FallbackRateLimiter(primary, fallback, {
        failureMode,
        onPrimaryError,
        now: () => 0,
      });
      await expect(limiter.consume(key, options)).rejects.toBeInstanceOf(TypeError);
      expect(primary.consume).not.toHaveBeenCalled();
      expect(onPrimaryError).not.toHaveBeenCalled();
      expect(fallback.consume).not.toHaveBeenCalled();
      await expect(limiter.consume('valid', { limit: 1, windowMs: 1 })).resolves.toEqual({
        allowed: true,
      });
      expect(primary.consume).toHaveBeenCalledTimes(1);
    });

    it('冷却期也先验证输入，不改变原有冷却边界', async () => {
      let now = 0;
      const primary = { consume: vi.fn().mockRejectedValue(new Error('unavailable')) };
      const fallback = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
      const onPrimaryError = vi.fn();
      const limiter = new FallbackRateLimiter(primary, fallback, {
        failureMode,
        failureCooldownMs: 1_000,
        now: () => now,
        onPrimaryError,
      });
      const first = limiter.consume('valid', { limit: 1, windowMs: 1 });
      if (failureMode === 'closed') {
        await expect(first).rejects.toBeInstanceOf(RateLimitUnavailableError);
      } else {
        await expect(first).resolves.toEqual({ allowed: true });
      }
      now = 500;
      await expect(limiter.consume('', { limit: 1, windowMs: 1 })).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(primary.consume).toHaveBeenCalledTimes(1);
      expect(onPrimaryError).toHaveBeenCalledTimes(1);
      expect(fallback.consume).toHaveBeenCalledTimes(failureMode === 'closed' ? 0 : 1);
      now = 1_000;
      primary.consume.mockResolvedValue({ allowed: true });
      await expect(limiter.consume('valid', { limit: 1, windowMs: 1 })).resolves.toEqual({
        allowed: true,
      });
      expect(primary.consume).toHaveBeenCalledTimes(2);
    });
  });

  it.each(['fallback', 'closed'] as const)(
    '%s close 释放 Redis 和已有内存计数',
    async (failureMode) => {
      const client = { eval: vi.fn(), quit: vi.fn().mockResolvedValue('OK') };
      const fallback = new MemoryRateLimiter();
      await fallback.consume('existing', { limit: 1, windowMs: 60_000 });
      const limiter = new FallbackRateLimiter(new RedisRateLimiter(client), fallback, {
        failureMode,
      });
      await expect(limiter.close()).resolves.toBeUndefined();
      expect(client.quit).toHaveBeenCalledTimes(1);
      expect(fallback.size).toBe(0);
    },
  );

  it('主限流器 close 失败仍清理备用限流器，并传播清理异常', async () => {
    const closeError = new Error('close failed');
    const primary = { consume: vi.fn(), close: vi.fn().mockRejectedValue(closeError) };
    const fallback = new MemoryRateLimiter();
    await fallback.consume('existing', { limit: 1, windowMs: 60_000 });
    const limiter = new FallbackRateLimiter(primary, fallback, { failureMode: 'closed' });
    await expect(limiter.close()).rejects.toBe(closeError);
    expect(primary.close).toHaveBeenCalledTimes(1);
    expect(fallback.size).toBe(0);
  });

  it('Redis quit 失败时调用 disconnect 并清理备用内存', async () => {
    const client = {
      eval: vi.fn(),
      quit: vi.fn().mockRejectedValue(new Error('quit failed')),
      disconnect: vi.fn(),
    };
    const fallback = new MemoryRateLimiter();
    await fallback.consume('existing', { limit: 1, windowMs: 60_000 });
    const limiter = new FallbackRateLimiter(new RedisRateLimiter(client), fallback);
    await expect(limiter.close()).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(fallback.size).toBe(0);
  });

  it('没有 close 方法的限流器可安全清理', async () => {
    const limiter = new FallbackRateLimiter({ consume: vi.fn() }, { consume: vi.fn() });
    await expect(limiter.close()).resolves.toBeUndefined();
  });
});

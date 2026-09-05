import { createHash } from 'node:crypto';

export type RateLimitConsumeOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  consume(key: string, options: RateLimitConsumeOptions): Promise<RateLimitDecision>;
  close?(): Promise<void> | void;
};

export type MemoryRateLimiterOptions = {
  /** Maximum number of active keys retained to prevent unbounded memory use. */
  maxEntries?: number;
  now?: () => number;
};

type MemoryBucket = {
  startedAt: number;
  count: number;
};

/**
 * Fixed-window limiter for a single API process. The bounded map is an
 * intentional fallback for local development and Redis outages.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryRateLimiterOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 10_000, 'maxEntries');
    this.now = options.now ?? (() => Date.now());
  }

  async consume(key: string, options: RateLimitConsumeOptions): Promise<RateLimitDecision> {
    const { limit, windowMs } = validateOptions(options);
    const normalizedKey = normalizeKey(key);
    const now = this.now();
    let bucket = this.buckets.get(normalizedKey);

    if (!bucket || now - bucket.startedAt >= windowMs || now < bucket.startedAt) {
      this.prune(now, windowMs);
      if (!bucket && this.buckets.size >= this.maxEntries) this.evictOldest();
      bucket = { startedAt: now, count: 0 };
      this.buckets.set(normalizedKey, bucket);
    }

    const allowed = bucket.count < limit;
    if (allowed) bucket.count += 1;
    return decisionFromBucket(bucket, limit, windowMs, now, allowed);
  }

  clear(): void {
    this.buckets.clear();
  }

  /** 释放全部内存计数；可重复调用，不影响其他限流器。 */
  close(): void {
    this.clear();
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number, windowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= windowMs || now < bucket.startedAt) {
        this.buckets.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestStartedAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.startedAt < oldestStartedAt) {
        oldestKey = key;
        oldestStartedAt = bucket.startedAt;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}

/** Minimal Redis shape used by the atomic Lua limiter. */
export type RedisRateLimitClient = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
};

export type RedisRateLimiterOptions = {
  keyPrefix?: string;
  now?: () => number;
};

const REDIS_RATE_LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[2])
if current >= limit then
  return {current, redis.call('PTTL', KEYS[1]), 0}
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('PTTL', KEYS[1]), 1}
`;

/**
 * Redis-backed fixed-window limiter. The Lua script keeps increment and expiry
 * atomic across API instances while avoiding growth from blocked requests.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(
    private readonly client: RedisRateLimitClient,
    options: RedisRateLimiterOptions = {},
  ) {
    this.keyPrefix = normalizePrefix(options.keyPrefix ?? 'multimodal:rate-limit');
    this.now = options.now ?? (() => Date.now());
  }

  async consume(key: string, options: RateLimitConsumeOptions): Promise<RateLimitDecision> {
    const { limit, windowMs } = validateOptions(options);
    const redisKey = `${this.keyPrefix}:${hashKey(normalizeKey(key))}`;
    const result = await this.client.eval(
      REDIS_RATE_LIMIT_SCRIPT,
      1,
      redisKey,
      String(windowMs),
      String(limit),
    );
    const [rawCount, rawTtl, rawAllowed] = parseRedisResult(result);
    const count = Math.max(0, rawCount);
    const ttlMs = rawTtl > 0 ? rawTtl : windowMs;
    const now = this.now();
    const resetAt = now + ttlMs;
    return {
      allowed: rawAllowed === 1,
      limit,
      remaining: Math.max(0, limit - Math.min(count, limit)),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  async close(): Promise<void> {
    if (this.client.quit) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect?.();
      }
      return;
    }
    this.client.disconnect?.();
  }
}

/** 主限流器失败后的处理策略、冷却时间和内部错误观察配置。 */
export type FallbackRateLimiterOptions = {
  /** 默认 fallback 使用备用限流器；生产调用方应显式选用 closed 拒绝请求。 */
  failureMode?: 'fallback' | 'closed';
  /** 失败后的重试间隔，单位毫秒，非负安全整数；默认 30 秒，0 表示立即重试。 */
  failureCooldownMs?: number;
  /** 返回当前时间的毫秒值；测试可注入时钟控制冷却与恢复。 */
  now?: () => number;
  /** 仅供内部观察原始错误，不得直接输出到 HTTP；同步抛错不会改变限流策略。 */
  onPrimaryError?: (error: unknown) => void;
};

/** 限流依赖不可用的公开错误；仅携带固定消息和重试秒数，不保留原始错误或 cause。 */
export class RateLimitUnavailableError extends Error {
  /** HTTP Retry-After 可使用的正整数秒数，最小为 1。 */
  readonly retryAfterSeconds: number;

  /**
   * 创建可安全返回给 HTTP 层的依赖不可用错误。
   * @param retryAfterSeconds 向上取整后的重试秒数，默认为 1，必须为正安全整数。
   * @throws {TypeError} 重试秒数不是正安全整数。
   */
  constructor(retryAfterSeconds = 1) {
    super('Rate limit service unavailable');
    this.name = 'RateLimitUnavailableError';
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 'retryAfterSeconds');
  }
}

/**
 * 优先使用主限流器，失败后在冷却期内按显式策略处理请求，冷却结束后重试主限流器。
 * 默认使用备用限流器保持开发兼容；closed 模式始终拒绝故障期间的请求，不消费备用额度。
 */
export class FallbackRateLimiter implements RateLimiter {
  /** 主限流器故障时采用的策略。 */
  private readonly failureMode: 'fallback' | 'closed';
  /** 每次故障后的冷却时长，单位毫秒。 */
  private readonly failureCooldownMs: number;
  /** 当前时间来源，单位毫秒。 */
  private readonly now: () => number;
  /** 下一次允许尝试主限流器的时间，单位毫秒；0 表示未处于冷却期。 */
  private primaryUnavailableUntil = 0;

  /**
   * 创建支持故障冷却和恢复的组合限流器，不主动访问或消费任一限流器。
   * @param primary 正常请求使用的主限流器。
   * @param fallback 仅在 fallback 模式故障期间使用的备用限流器。
   * @param options 故障策略、冷却时间、时钟和内部错误观察回调。
   * @throws {TypeError} 冷却时间不是非负安全整数。
   */
  constructor(
    /** 主限流器及其可选资源清理接口。 */
    private readonly primary: RateLimiter,
    /** 备用限流器及其可选资源清理接口。 */
    private readonly fallback: RateLimiter,
    options: FallbackRateLimiterOptions = {},
  ) {
    this.failureMode = options.failureMode ?? 'fallback';
    this.failureCooldownMs = nonNegativeInteger(
      options.failureCooldownMs ?? 30_000,
      'failureCooldownMs',
    );
    this.now = options.now ?? (() => Date.now());
    this.onPrimaryError = options.onPrimaryError;
  }

  /** 内部错误观察回调；其异常不得越过既定故障处理边界。 */
  private readonly onPrimaryError?: (error: unknown) => void;

  /**
   * 验证输入后消费主限流额度，失败或冷却期间执行所选故障策略。
   * @param key 非空客户端标识；验证失败不会访问主、备用限流器或更新冷却状态。
   * @param options 正整数请求额度及毫秒窗口。
   * @returns 主限流器或 fallback 模式备用限流器的限流结果。
   * @throws {TypeError} 输入无效。
   * @throws {RateLimitUnavailableError} closed 模式下主限流器失败或尚未结束冷却。
   */
  async consume(key: string, options: RateLimitConsumeOptions): Promise<RateLimitDecision> {
    validateOptions(options);
    normalizeKey(key);
    const remainingMs = this.primaryUnavailableUntil - this.now();
    if (remainingMs > 0) {
      return this.consumeWhenUnavailable(key, options, remainingMs);
    }
    try {
      const result = await this.primary.consume(key, options);
      this.primaryUnavailableUntil = 0;
      return result;
    } catch (error) {
      this.primaryUnavailableUntil = this.now() + this.failureCooldownMs;
      try {
        this.onPrimaryError?.(error);
      } catch {
        // 观察回调失败不能泄露错误或改变拒绝请求、备用限流的既定策略。
      }
      return this.consumeWhenUnavailable(key, options, this.failureCooldownMs);
    }
  }

  /**
   * 按故障策略拒绝请求或消费备用额度；closed 不访问备用限流器。
   * @param key 已验证的客户端标识。
   * @param options 已验证的限流额度与毫秒窗口。
   * @param remainingMs 剩余冷却毫秒数；首次故障传入完整冷却时长。
   * @returns 备用限流器结果。
   * @throws {RateLimitUnavailableError} closed 模式返回至少 1 秒的向上取整重试时间。
   */
  private consumeWhenUnavailable(
    key: string,
    options: RateLimitConsumeOptions,
    remainingMs: number,
  ): Promise<RateLimitDecision> {
    if (this.failureMode === 'closed') {
      throw new RateLimitUnavailableError(Math.max(1, Math.ceil(remainingMs / 1000)));
    }
    return this.fallback.consume(key, options);
  }

  /** 依次清理主、备用限流器；即使主清理失败也清理备用资源，清理异常继续向调用方传播。 */
  async close(): Promise<void> {
    try {
      await this.primary.close?.();
    } finally {
      await this.fallback.close?.();
    }
  }
}

function decisionFromBucket(
  bucket: MemoryBucket,
  limit: number,
  windowMs: number,
  now: number,
  allowed: boolean,
): RateLimitDecision {
  const resetAt = bucket.startedAt + windowMs;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - Math.min(bucket.count, limit)),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, resetAt - now) / 1000)),
  };
}

function validateOptions(options: RateLimitConsumeOptions): RateLimitConsumeOptions {
  return {
    limit: positiveInteger(options.limit, 'limit'),
    windowMs: positiveInteger(options.windowMs, 'windowMs'),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeKey(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError('rate limit key cannot be empty');
  return normalized;
}

function normalizePrefix(value: string): string {
  const normalized = value.trim().replace(/:+$/, '');
  if (!normalized || normalized.includes(' ') || normalized.includes('{')) {
    throw new TypeError('rate limit key prefix is invalid');
  }
  return normalized;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRedisResult(result: unknown): [number, number, number] {
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error('Redis rate limiter returned an invalid result');
  }
  const count = Number(result[0]);
  const ttl = Number(result[1]);
  // Older test doubles/deployments may return only count + TTL. The current
  // Lua script always returns the explicit accepted flag; treat the legacy
  // two-field response as accepted for compatibility with that contract.
  const accepted = result.length >= 3 ? Number(result[2]) : 1;
  if (!Number.isFinite(count) || !Number.isFinite(ttl) || !Number.isFinite(accepted)) {
    throw new Error('Redis rate limiter returned non-numeric values');
  }
  return [count, ttl, accepted];
}

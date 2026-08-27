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

export type FallbackRateLimiterOptions = {
  /** Avoid hammering an unavailable Redis instance on every request. */
  failureCooldownMs?: number;
  now?: () => number;
  onPrimaryError?: (error: unknown) => void;
};

/**
 * Uses Redis when available and falls back to the bounded in-memory limiter
 * after a Redis failure. The fallback deliberately remains limiting, rather
 * than failing open during an outage.
 */
export class FallbackRateLimiter implements RateLimiter {
  private readonly failureCooldownMs: number;
  private readonly now: () => number;
  private primaryUnavailableUntil = 0;

  constructor(
    private readonly primary: RateLimiter,
    private readonly fallback: RateLimiter,
    options: FallbackRateLimiterOptions = {},
  ) {
    this.failureCooldownMs = nonNegativeInteger(
      options.failureCooldownMs ?? 30_000,
      'failureCooldownMs',
    );
    this.now = options.now ?? (() => Date.now());
    this.onPrimaryError = options.onPrimaryError;
  }

  private readonly onPrimaryError?: (error: unknown) => void;

  async consume(key: string, options: RateLimitConsumeOptions): Promise<RateLimitDecision> {
    if (this.now() < this.primaryUnavailableUntil) {
      return this.fallback.consume(key, options);
    }
    try {
      const result = await this.primary.consume(key, options);
      this.primaryUnavailableUntil = 0;
      return result;
    } catch (error) {
      this.primaryUnavailableUntil = this.now() + this.failureCooldownMs;
      this.onPrimaryError?.(error);
      return this.fallback.consume(key, options);
    }
  }

  async close(): Promise<void> {
    await this.primary.close?.();
    await this.fallback.close?.();
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

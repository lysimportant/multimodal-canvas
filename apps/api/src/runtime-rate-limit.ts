import Redis from 'ioredis';

import {
  FallbackRateLimiter,
  MemoryRateLimiter,
  RedisRateLimiter,
  RateLimitUnavailableError,
  type RateLimiter,
} from './rate-limit';

/**
 * 创建 API 入口使用的限流器，并在返回前等待首次 Redis 连接。
 * @param environment 部署配置；生产环境必须启用 Redis，不能降级为进程内额度。
 * @returns 带关闭方法的限流器；开发环境仍允许有界内存回退。
 * @throws 生产配置缺失或首次连接失败时抛出不含连接凭据的错误。
 */
export async function createApiRateLimiter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RateLimiter> {
  const production = environment.NODE_ENV === 'production';
  const enabled = production || environment.API_RATE_LIMIT_REDIS_ENABLED === 'true';
  const redisUrl = environment.REDIS_URL?.trim();
  if (production && (!redisUrl || environment.API_RATE_LIMIT_REDIS_ENABLED === 'false')) {
    throw new Error('生产 API 必须配置并启用 Redis 全局限流');
  }
  const memoryLimiter = new MemoryRateLimiter();
  if (!enabled || !redisUrl) return memoryLimiter;

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(1_000, Math.max(100, attempt * 100)),
  });
  client.on('error', reportRateLimitConnectionError);
  try {
    await client.connect();
  } catch {
    if (production) {
      client.disconnect();
      throw new RateLimitUnavailableError();
    }
    reportRateLimitConnectionError();
  }
  return new FallbackRateLimiter(new RedisRateLimiter(client), memoryLimiter, {
    failureMode: production ? 'closed' : 'fallback',
    onPrimaryError: reportRateLimitConnectionError,
  });
}

/** 仅输出固定诊断，不转发可能包含 Redis URL、密码或原始命令的异常。 */
function reportRateLimitConnectionError(): void {
  console.warn('Redis 全局限流暂不可用，请检查连接状态；生产请求不会回退到本机额度');
}

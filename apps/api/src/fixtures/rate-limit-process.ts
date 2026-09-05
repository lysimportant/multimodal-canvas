/** 隔离限流演练进程：只操作随机测试前缀中的短 TTL 键，不清理任何既有数据。 */
import Redis from 'ioredis';
import { RedisRateLimiter } from '../rate-limit';

/**
 * 连接显式测试 Redis 并竞争同一客户端的七次额度，结果仅输出 PID 和放行标志。
 * @throws 缺配置或 Redis 故障时向进程边界传播；边界只记录固定诊断。
 */
async function main(): Promise<void> {
  const redisUrl = process.env.TEST_REDIS_URL;
  const namespace = process.env.TEST_REDIS_NAMESPACE;
  const requests = Number(process.env.RATE_LIMIT_TEST_REQUESTS);
  if (!redisUrl || !namespace || !Number.isSafeInteger(requests) || requests < 1 || requests > 20) {
    throw new Error('invalid test configuration');
  }
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => process.stderr.write('隔离 Redis 连接不可用\n'));
  const limiter = new RedisRateLimiter(client, { keyPrefix: namespace });
  try {
    await client.connect();
    const decisions = await Promise.all(
      Array.from({ length: requests }, () =>
        limiter.consume('shared-test-client', { limit: 7, windowMs: 60_000 }),
      ),
    );
    process.stdout.write(
      JSON.stringify({ pid: process.pid, allowed: decisions.map((decision) => decision.allowed) }),
    );
  } finally {
    await limiter.close();
  }
}

void main().catch(() => {
  process.stderr.write('隔离 Redis 限流演练失败\n');
  process.exitCode = 1;
});

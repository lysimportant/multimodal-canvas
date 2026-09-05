import { defineConfig } from 'vitest/config';

/** 独立真实 Redis 验收入口：缺少显式隔离配置即失败，避免 CI 以跳过掩盖环境缺失。 */
export default defineConfig({
  test: {
    include: ['src/rate-limit.integration.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    env: { REQUIRE_RATE_LIMIT_INTEGRATION: 'true' },
  },
});

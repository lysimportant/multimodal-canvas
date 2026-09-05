import { defineConfig } from 'vitest/config';

/** API 测试通过环境变量切换 Provider 和部署模式，文件间必须串行隔离 process.env。 */
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      RUN_SERVICE: 'memory',
      WORKER_PROVIDER: 'mock',
    },
  },
});

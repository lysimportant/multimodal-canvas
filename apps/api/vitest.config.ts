import { defineConfig } from 'vitest/config';

/** API 测试通过环境变量切换 Provider 和部署模式，文件间必须串行隔离 process.env。 */
export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      RUN_SERVICE: 'memory',
      WORKER_PROVIDER: 'mock',
      // 单测不继承本机真实认证配置；认证用例自行显式注入合成凭据。
      API_AUTH_TOKEN: '',
      API_JWT_SECRET: '',
      // 测试默认固定开发端口，避免仓库根目录 .env 的本地端口覆盖 CORS 默认契约。
      WEB_PORT: '5173',
    },
  },
});

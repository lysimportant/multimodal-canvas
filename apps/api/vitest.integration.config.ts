import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/prisma.integration.test.ts', 'src/settings-sync.integration.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 60_000,
    env: {
      REQUIRE_INTEGRATION_SERVICES: 'true',
    },
  },
});

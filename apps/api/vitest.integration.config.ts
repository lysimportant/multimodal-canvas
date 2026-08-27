import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      REQUIRE_INTEGRATION_SERVICES: 'true',
    },
  },
});

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loveTvSeo } from './seo-build';

export default defineConfig({
  plugins: [tailwindcss(), react(), loveTvSeo()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/ui/test-setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
});

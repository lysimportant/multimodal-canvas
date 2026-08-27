import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
  },
  test: {
    environment: 'jsdom',
    restoreMocks: true,
    clearMocks: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
});

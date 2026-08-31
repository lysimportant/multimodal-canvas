import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryProjectStore } from './projects';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API CORS', () => {
  it.each(['http://127.0.0.1:5173', 'http://localhost:5173'])(
    'allows the development origin %s',
    async (origin) => {
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/health',
          headers: { origin },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(response.headers['access-control-allow-credentials']).toBe('true');
        expect(response.headers.vary).toContain('Origin');
      } finally {
        await app.close();
      }
    },
  );

  it('does not allow a non-default development port unless explicitly configured', async () => {
    vi.stubEnv('CORS_ORIGIN', '');
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://localhost:5174' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it.each(['http://127.0.0.1:5199', 'http://localhost:5199'])(
    'keeps loopback origins symmetric when WEB_PORT is overridden: %s',
    async (origin) => {
      vi.stubEnv('WEB_PORT', '5199');
      const app = buildApp({ logger: false });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/health',
          headers: { origin },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
      } finally {
        await app.close();
      }
    },
  );

  it('answers authenticated-route preflight before application authentication', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'cors-test-api-token');
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/projects/project-1/events',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,last-event-id',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-headers']).toBe('authorization,last-event-id');
    } finally {
      await app.close();
    }
  });

  it('preserves CORS headers after the SSE route hijacks the raw response', async () => {
    vi.stubEnv('API_SSE_MAX_BYTES', '1');
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'CORS stream' });
    const app = buildApp({ logger: false, projectStore });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/events`,
        headers: { origin: 'http://localhost:5173' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('uses only configured origins in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', 'https://canvas.example.com');
    const app = buildApp({ logger: false });
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://canvas.example.com' },
      });
      const developmentOrigin = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'http://localhost:5173' },
      });

      expect(allowed.headers['access-control-allow-origin']).toBe('https://canvas.example.com');
      expect(developmentOrigin.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('never combines a wildcard origin with credentialed CORS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', '*');
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://unexpected.example.com' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

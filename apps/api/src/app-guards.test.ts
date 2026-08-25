import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { buildApp } from './app';
import { MemoryRunService } from './runs';
import type { Observability, ObservabilitySpan } from '@multimodal-canvas/observability';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('API authentication guard', () => {
  it('rejects a validly signed JWT when its database user no longer exists', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_JWT_SECRET', 'test-jwt-secret');
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode({ sub: '123e4567-e89b-12d3-a456-426614174000' });
    const signature = createHmac('sha256', 'test-jwt-secret')
      .update(`${header}.${body}`)
      .digest('base64url');
    const authorization = `Bearer ${header}.${body}.${signature}`;
    const app = buildApp({ logger: false, userExists: async () => false });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/projects/project_missing',
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'authentication required' });
    } finally {
      await app.close();
    }
  });

  it('returns 503 for protected routes when production has no API_AUTH_TOKEN', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_AUTH_TOKEN', '');
    const app = buildApp({ logger: false });

    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health?check=1' })).statusCode).toBe(200);
      const response = await app.inject({ method: 'GET', url: '/v1/projects/project_missing' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'API_AUTH_TOKEN is required in production' });
    } finally {
      await app.close();
    }
  });

  it('requires the configured Bearer token for protected routes', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', 'test-api-token');
    const app = buildApp({ logger: false });

    try {
      const missing = await app.inject({ method: 'GET', url: '/v1/projects/project_missing' });
      const wrong = await app.inject({
        method: 'GET',
        url: '/v1/projects/project_missing',
        headers: { authorization: 'Bearer wrong-token' },
      });
      const valid = await app.inject({
        method: 'GET',
        url: '/v1/projects/project_missing',
        headers: { authorization: 'Bearer test-api-token' },
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(valid.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it.each([
    '/v1/projects',
    '/v1/assets',
    '/v1/models',
    '/v1/settings/ai',
    '/v1/runs/missing',
    '/v1/assets/missing/content',
    '/v1/projects/missing/canvas',
    '/v1/projects/missing/runs',
  ])('protects %s with the Bearer token', async (url) => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', 'test-api-token');
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('keeps the webhook route outside Bearer authentication', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', 'test-api-token');
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload: { type: 'completed' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'webhook event id is required' });
    } finally {
      await app.close();
    }
  });

  it('requires and validates the webhook signature in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_AUTH_TOKEN', 'test-api-token');
    vi.stubEnv('NEW_API_WEBHOOK_SECRET', 'webhook-test-secret');
    const app = buildApp({ logger: false });
    const payload = { id: 'event_1', type: 'completed' };

    try {
      const missing = await app.inject({ method: 'POST', url: '/v1/webhooks/newapi', payload });
      const wrong = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
        headers: { 'x-newapi-signature': 'invalid' },
      });
      const signature = createHmac('sha256', 'webhook-test-secret')
        .update(JSON.stringify(payload))
        .digest('hex');
      const valid = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload,
        headers: { 'x-newapi-signature': signature },
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(valid.statusCode).toBe(202);
      expect(valid.json()).toMatchObject({ accepted: true, eventId: 'event_1' });
    } finally {
      await app.close();
    }
  });
});

describe('API CORS and rate limit guards', () => {
  it('only emits CORS headers for configured production origins', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', 'https://allowed.example, https://second.example');
    const app = buildApp({ logger: false });

    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://allowed.example' },
      });
      const denied = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://denied.example' },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://allowed.example');
      expect(denied.statusCode).toBe(200);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('disables cross-origin response headers by default in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ORIGIN', '');
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { origin: 'https://any.example' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('limits authenticated v1 requests per client without limiting health or webhooks', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', 'test-api-token');
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '1');
    const app = buildApp({ logger: false });

    try {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { authorization: 'Bearer test-api-token' },
      });
      const limited = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { authorization: 'Bearer test-api-token' },
      });
      const health = await app.inject({ method: 'GET', url: '/health' });
      const webhook = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/newapi',
        payload: { type: 'completed' },
      });

      expect(first.statusCode).toBe(200);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(health.statusCode).toBe(200);
      expect(webhook.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('project run concurrency guard', () => {
  it('rejects a new run while the project has the configured number of active runs', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '1');
    const runService = new MemoryRunService({ stepDelayMs: 100 });
    const app = buildApp({ logger: false, runService });

    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Concurrency guard test' },
      });
      const projectId = projectResponse.json().project.id as string;
      const canvasResponse = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      expect(canvasResponse.statusCode).toBe(200);

      const first = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_text/runs',
        payload: { projectId },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_text/runs',
        payload: { projectId },
      });

      expect(first.statusCode).toBe(202);
      expect(first.json().run.status).toBe('queued');
      expect(second.statusCode).toBe(429);
      expect(second.json()).toEqual({
        error: 'project run quota exceeded',
        retryAfterSeconds: 30,
      });
    } finally {
      await app.close();
    }
  });
});

describe('API observability boundary', () => {
  it('creates and closes an HTTP span without exporting request content', async () => {
    const spans: Array<{
      name: string;
      attributes: Record<string, string | number | boolean>;
      status?: string;
    }> = [];
    const observability: Observability = {
      startSpan(name, attributes = {}) {
        const record = { name, attributes: { ...attributes } } as (typeof spans)[number];
        spans.push(record);
        const span: ObservabilitySpan = {
          setAttribute(key, value) {
            record.attributes[key] = value;
          },
          recordException: vi.fn(),
          end(status) {
            record.status = status;
          },
        };
        return span;
      },
      captureException: vi.fn(),
    };
    const app = buildApp({ logger: false, observability });

    try {
      const response = await app.inject({ method: 'GET', url: '/health?apiKey=do-not-record' });
      expect(response.statusCode).toBe(200);
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: 'http.request',
        status: 'ok',
        attributes: { 'http.method': 'GET', 'http.status_code': 200 },
      });
      expect(JSON.stringify(spans)).not.toContain('do-not-record');
    } finally {
      await app.close();
    }
  });
});

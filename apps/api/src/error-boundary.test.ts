import { describe, expect, it } from 'vitest';

import type { RunRecord } from '@multimodal-canvas/domain';

import { buildApp } from './app';
import type { RunService } from './runs';
import { AiSettingsStore } from './settings';

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 1_000;
  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('SSE stream did not publish the expected event');
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SSE stream read timed out')), remaining),
      ),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

function testRunService(listByProject: RunService['listByProject']): RunService {
  return {
    create: async () => {
      throw new Error('not used by this test');
    },
    get: async () => undefined,
    listByProject,
    retry: async () => {
      throw new Error('not used by this test');
    },
    cancel: async () => {
      throw new Error('not used by this test');
    },
    close: async () => undefined,
  };
}

describe('API error boundary', () => {
  it.each([
    '{"apiKey":"synthetic-parser-secret",',
    '{"name":"synthetic-parser-secret","__proto__":{"polluted":true}}',
    '{"name":"synthetic-parser-secret","constructor":{"prototype":{"polluted":true}}}',
  ])('JSON 解析失败返回脱敏 400，原型污染字段同样拒绝', async (payload) => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'internal_error',
        requestId: expect.any(String),
      });
      expect(response.body).not.toContain('synthetic-parser-secret');
      expect(Object.prototype).not.toHaveProperty('polluted');
    } finally {
      await app.close();
    }
  });

  it('does not expose an upstream model refresh diagnostic', async () => {
    const diagnosticMarker = 'upstream-model-refresh-internal-diagnostic';
    const settingsStore = new AiSettingsStore('error-boundary-test-secret', {
      fetchImpl: async () => {
        throw new Error(diagnosticMarker);
      },
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });
    settingsStore.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'synthetic-key' });
    const app = buildApp({ logger: false, settingsStore });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'model catalog refresh failed',
        code: 'upstream_error',
      });
      expect(response.body).not.toContain(diagnosticMarker);
    } finally {
      await app.close();
    }
  });

  it('does not expose an unexpected error message and returns a correlatable request id', async () => {
    const app = buildApp({ logger: false });
    const diagnosticMarker = 'internal-only-diagnostic-marker';
    app.get('/__test/error-boundary', async () => {
      throw new Error(diagnosticMarker);
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/__test/error-boundary' });
      const body = response.json();

      expect(response.statusCode).toBe(500);
      expect(body).toEqual({
        error: 'internal server error',
        code: 'internal_error',
        requestId: expect.any(String),
      });
      expect(response.body).not.toContain(diagnosticMarker);
      expect(response.body).not.toContain('stack');
    } finally {
      await app.close();
    }
  });

  it('preserves a valid Fastify error status without returning its details', async () => {
    const app = buildApp({ logger: false });
    const diagnosticMarker = 'internal-only-status-diagnostic-marker';
    app.get('/__test/error-boundary-status', async () => {
      throw Object.assign(new Error(diagnosticMarker), { statusCode: 429, code: 'E_UPSTREAM' });
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/__test/error-boundary-status' });
      const body = response.json();

      expect(response.statusCode).toBe(429);
      expect(body).toMatchObject({
        error: 'internal server error',
        code: 'internal_error',
        requestId: expect.any(String),
      });
      expect(response.body).not.toContain(diagnosticMarker);
    } finally {
      await app.close();
    }
  });

  it('publishes only the public run fields over SSE', async () => {
    const internalMarker = 'internal-run-boundary-marker';
    let projectId = '';
    const runService = testRunService(async (requestedProjectId) => {
      if (requestedProjectId !== projectId) return [];
      const run = {
        id: 'run-public-boundary',
        userId: internalMarker,
        projectId,
        targetNodeId: 'node-target',
        status: 'failed',
        progress: 100,
        attempt: 2,
        provider: 'mock',
        modelAlias: 'mock-text',
        snapshot: {
          projectId,
          canvasRevision: 0,
          targetNodeId: 'node-target',
          modelAlias: 'mock-text',
          parameters: { internal: internalMarker },
          submittedAt: '2026-08-29T00:00:00.000Z',
          nodes: [
            {
              id: 'node-target',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Target', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
          inputs: [],
        },
        result: {
          provider: 'mock',
          summary: 'public result',
          targetNodeId: 'node-target',
          mediaType: 'text',
          inputCount: 0,
          asset: {
            assetId: 'asset-public',
            version: 2,
            contentUrl: '/v1/assets/asset-public/content',
            mimeType: 'text/plain',
            sizeBytes: 12,
          },
        },
        providerJob: {
          id: 'provider-job-internal',
          provider: 'mock',
          platformJobId: 'platform-job-internal',
          status: 'failed',
          progress: 100,
          payload: { internal: internalMarker },
          createdAt: '2026-08-29T00:00:00.000Z',
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
        idempotencyKey: internalMarker,
        error: `provider authorization: Bearer ${internalMarker}`,
        retryOf: 'run-original',
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      } as RunRecord;
      return [run];
    });
    const app = buildApp({ logger: false, runService });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'SSE public boundary' },
      });
      projectId = project.json().project.id;
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/v1/projects/${projectId}/events`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const streamReader = response.body?.getReader();
      expect(streamReader).toBeDefined();
      if (!streamReader) throw new Error('SSE response body is missing');
      reader = streamReader;
      const text = await readSseUntil(streamReader, (value) =>
        value.includes('event: run.updated'),
      );
      const eventBlock = text.split('\n\n').find((block) => block.includes('event: run.updated'));
      const dataLine = eventBlock?.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        id: 'run-public-boundary',
        projectId,
        targetNodeId: 'node-target',
        status: 'failed',
        progress: 100,
        attempt: 2,
        provider: 'mock',
        modelAlias: 'mock-text',
        result: {
          provider: 'mock',
          summary: 'public result',
          targetNodeId: 'node-target',
          mediaType: 'text',
          inputCount: 0,
          asset: {
            assetId: 'asset-public',
            version: 2,
            mimeType: 'text/plain',
            sizeBytes: 12,
          },
        },
        error: 'provider authorization: Bearer [REDACTED]',
        retryOf: 'run-original',
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      });
      expect(text).not.toContain(internalMarker);
      expect(text).not.toContain('/v1/assets/asset-public/content');
      await reader.cancel();
    } finally {
      controller.abort();
      await reader?.cancel();
      await app.close();
    }
  });

  it('does not publish an SSE read error message to the client', async () => {
    const diagnosticMarker = 'sse-internal-diagnostic-marker';
    const app = buildApp({
      logger: false,
      runService: testRunService(async () => {
        throw new Error(diagnosticMarker);
      }),
    });
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'SSE error boundary' },
      });
      const projectId = project.json().project.id;
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/v1/projects/${projectId}/events`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const streamReader = response.body?.getReader();
      expect(streamReader).toBeDefined();
      if (!streamReader) throw new Error('SSE response body is missing');
      reader = streamReader;
      const text = await readSseUntil(streamReader, (value) => value.includes('event: error'));
      const eventBlock = text.split('\n\n').find((block) => block.includes('event: error'));
      const dataLine = eventBlock?.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        error: 'internal server error',
        code: 'internal_error',
        requestId: expect.any(String),
      });
      expect(text).not.toContain(diagnosticMarker);
      await reader.cancel();
    } finally {
      controller.abort();
      await reader?.cancel();
      await app.close();
    }
  });
});

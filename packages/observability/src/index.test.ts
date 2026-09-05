import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExportingObservability,
  createEnvironmentObservability,
  createLoggingObservability,
  createNoopObservability,
  sanitizeExceptionForObservability,
} from './index';

async function flushTelemetry() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('observability boundary', () => {
  it('preserves numeric token usage while redacting actual credential tokens', () => {
    const error = vi.fn();
    createLoggingObservability({ info: vi.fn(), error }).captureException(new Error('safe'), {
      'usage.inputTokens': 12,
      'usage.promptTokens': 8,
      'auth.token': 'synthetic-secret',
    });
    expect(error.mock.calls[0][0]).toMatchObject({
      'usage.inputTokens': 12,
      'usage.promptTokens': 8,
      'auth.token': '[REDACTED]',
    });
  });
  it('isolates throwing loggers and removes signed URLs and user payloads', () => {
    const bindings: unknown[] = [];
    const logger = {
      info(value: unknown) {
        bindings.push(value);
        throw new Error('disk failure');
      },
      error(value: unknown) {
        bindings.push(value);
        throw new Error('disk failure');
      },
    };
    const observability = createLoggingObservability(logger);
    expect(() => {
      const span = observability.startSpan('request', {
        prompt: 'synthetic-user-content',
        signedUrl:
          'https://synthetic-user:synthetic-password@cdn.example/image?X-Amz-Signature=synthetic-signature&other=synthetic-query',
      });
      span.recordException(new Error('https://cdn.example/?token=synthetic-token'));
      span.end('ok');
      observability.captureException(new Error('disk error'));
    }).not.toThrow();
    expect(bindings).toHaveLength(3);
    expect(JSON.stringify(bindings)).not.toMatch(/synthetic-/);
  });

  it('bounds malformed attributes and repeated exception payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null));
    const observability = createExportingObservability({
      otlpEndpoint: 'http://collector.example',
      fetch: fetchMock,
    });
    const span = observability.startSpan('bounded', { count: Number.POSITIVE_INFINITY });
    for (let index = 0; index < 100; index += 1) {
      span.setAttribute(`item-${index}`, index);
      span.recordException(new Error('bounded'));
    }
    span.end();
    span.end();
    await flushTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attributes.length).toBeLessThanOrEqual(96);
    expect(attributes.find((entry: { key: string }) => entry.key === 'count')).toBeUndefined();
  });

  it('creates a detached redacted error while preserving safe diagnostics and causes', () => {
    const source = new Error(
      'provider rejected Authorization: Bearer synthetic-bearer-fixture while rendering',
      {
        cause: new Error('model lookup failed apiKey=synthetic-key-fixture after timeout'),
      },
    );
    source.name = 'ProviderError';

    const sanitized = sanitizeExceptionForObservability(source);
    const cause = sanitized.cause;

    expect(sanitized).not.toBe(source);
    expect(sanitized.name).toBe('ProviderError');
    expect(sanitized.message).toContain('provider rejected');
    expect(sanitized.message).toContain('while rendering');
    expect(sanitized.message).toContain('[REDACTED]');
    expect(sanitized.stack).not.toContain('synthetic-bearer-fixture');
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('model lookup failed');
    expect((cause as Error).message).toContain('after timeout');
    expect((cause as Error).message).toContain('[REDACTED]');
    expect(
      JSON.stringify({ message: sanitized.message, cause: (cause as Error).message }),
    ).not.toMatch(/synthetic-(?:bearer|key)-fixture/);
    expect(source.message).toContain('synthetic-bearer-fixture');
  });

  it('provides an offline no-op implementation', () => {
    const observability = createNoopObservability();
    expect(() => {
      const span = observability.startSpan('test');
      span.setAttribute('answer', 42);
      span.recordException(new Error('ignored'));
      span.end('ok');
      observability.captureException(new Error('ignored'));
    }).not.toThrow();
  });

  it('logs span completion and redacts credential-like exception text', () => {
    const info = vi.fn();
    const error = vi.fn();
    const observability = createLoggingObservability({ info, error });
    const span = observability.startSpan('run.process', { 'run.id': 'run_1' });
    span.recordException(new Error('Authorization: Bearer secret-token apiKey=secret-key'));
    span.end('error');
    observability.captureException(new Error('api_key=second-secret'), { component: 'worker' });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'telemetry.span', span: 'run.process', status: 'error' }),
      expect.any(String),
    );
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(error.mock.calls)).not.toContain('second-secret');
  });

  it('exports sanitized spans to an injected OTLP endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const observability = createExportingObservability({
      otlpEndpoint: 'https://telemetry.example/v1',
      fetch: fetchMock,
      now: (() => {
        let value = 1_000;
        return () => (value += 10);
      })(),
    });
    const span = observability.startSpan('api.request', {
      'http.method': 'GET',
      secret: 'must-be-explicitly-redacted-by-callers',
    });
    span.recordException(new Error('Authorization: Bearer do-not-export'));
    span.end('error');
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('do-not-export');
    expect(JSON.stringify(payload)).toContain('Bearer [REDACTED]');
  });

  it('sends a protocol-shaped OTLP request with configured headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const observability = createExportingObservability({
      otlpEndpoint: 'https://collector.example',
      otlpHeaders: {
        authorization: 'Bearer exporter-secret',
        'x-tenant-id': 'tenant-1',
        'content-type': 'text/plain',
      },
      service: 'test-api',
      fetch: fetchMock,
      now: (() => {
        let value = 2_000;
        return () => (value += 25);
      })(),
    });

    const span = observability.startSpan('run.process', { 'run.id': 'run_1', count: 2 });
    span.end('ok');
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://collector.example/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer exporter-secret',
      'x-tenant-id': 'tenant-1',
      'content-type': 'application/json',
    });

    const payload = JSON.parse(String(init.body));
    const exportedSpan = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(payload.resourceSpans[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'test-api' } },
    ]);
    expect(exportedSpan.name).toBe('run.process');
    expect(exportedSpan.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exportedSpan.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(exportedSpan.startTimeUnixNano).toBe('2025000000');
    expect(exportedSpan.endTimeUnixNano).toBe('2050000000');
    expect(exportedSpan.status).toEqual({ code: 1 });
    expect(exportedSpan.attributes).toEqual([
      { key: 'run.id', value: { stringValue: 'run_1' } },
      { key: 'count', value: { doubleValue: 2 } },
    ]);
  });

  it('falls back to the generic OTLP endpoint when trace-specific env is blank', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '   ');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://generic.example/');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const observability = createExportingObservability({ fetch: fetchMock });

    observability.startSpan('fallback').end('ok');
    await flushTelemetry();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://generic.example/v1/traces');
  });

  it('exports a redacted exception in a Sentry envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const observability = createExportingObservability({
      sentryDsn: 'https://public-key@sentry.example/42',
      service: 'test-worker',
      fetch: fetchMock,
    });

    observability.captureException(
      new Error('Authorization: Bearer sentry-secret api_key=another-secret'),
      { component: 'worker', runId: 'run_1' },
    );
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://sentry.example/api/42/envelope/?sentry_version=7&sentry_key=public-key',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/x-sentry-envelope' });
    const lines = String(init.body).split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({
      event_id: expect.any(String),
      dsn: expect.stringContaining('public-key'),
    });
    expect(JSON.parse(lines[1])).toEqual({ type: 'event' });
    const event = JSON.parse(lines[2]);
    expect(event.server_name).toBe('test-worker');
    expect(event.exception.values[0]).toEqual({
      type: 'Error',
      value: 'Authorization: Bearer [REDACTED] api_key=[REDACTED]',
    });
    expect(JSON.stringify(event)).not.toContain('sentry-secret');
    expect(JSON.stringify(event)).not.toContain('another-secret');
  });

  it('redacts sensitive attributes and honors OTLP environment headers', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'https://collector.example/base?tenant=one');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://wrong.example');
    vi.stubEnv(
      'OTEL_EXPORTER_OTLP_HEADERS',
      'authorization=Bearer%20env-secret,x-tenant-id=tenant-1,malformed',
    );
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'x-traces-only=preferred');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    try {
      const observability = createEnvironmentObservability();
      observability.captureException(new Error('request failed'), {
        apiKey: 'attribute-secret',
        safe: 'Authorization: Bearer value-secret',
      });
      await flushTelemetry();
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
      else delete (globalThis as { fetch?: typeof fetch }).fetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://collector.example/base/v1/traces?tenant=one');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-traces-only': 'preferred',
    });
    const payload = JSON.parse(String(init.body));
    const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attributes).toEqual([
      { key: 'apiKey', value: { stringValue: '[REDACTED]' } },
      { key: 'safe', value: { stringValue: 'Authorization: Bearer [REDACTED]' } },
      { key: 'exception.message', value: { stringValue: 'request failed' } },
      { key: 'exception.type', value: { stringValue: 'Error' } },
    ]);
    expect(JSON.stringify(payload)).not.toContain('attribute-secret');
    expect(JSON.stringify(payload)).not.toContain('value-secret');
  });

  it('rejects non-http Sentry DSNs and preserves a valid path prefix without DSN passwords', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const invalid = createExportingObservability({
      sentryDsn: 'javascript://public-key@evil.example/42',
      fetch: fetchMock,
    });
    invalid.captureException(new Error('ignored'));
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();

    const valid = createExportingObservability({
      sentryDsn: 'https://public-key:private-secret@sentry.example/sentry/prefix/42',
      fetch: fetchMock,
    });
    valid.captureException(new Error('visible failure'), { apiKey: 'attribute-secret' });
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://sentry.example/sentry/prefix/api/42/envelope/?sentry_version=7&sentry_key=public-key',
    );
    const [headerLine, , eventLine] = String(init.body).split('\n');
    expect(JSON.parse(headerLine).dsn).toBe('https://public-key@sentry.example/sentry/prefix/42');
    expect(headerLine).not.toContain('private-secret');
    expect(eventLine).not.toContain('attribute-secret');
  });

  it('contains exporter failures and still attempts each configured exporter', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith('https://sentry.example')) {
        return Promise.reject(new Error('sentry unavailable'));
      }
      return Promise.reject(new Error('collector unavailable'));
    });
    const observability = createExportingObservability({
      otlpEndpoint: 'https://collector.example',
      sentryDsn: 'https://public-key@sentry.example/42',
      fetch: fetchMock,
    });

    expect(() => {
      const span = observability.startSpan('run.process');
      span.recordException(new Error('failed'));
      span.end('error');
      observability.captureException(new Error('failed again'));
    }).not.toThrow();
    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://collector.example/v1/traces',
      'https://sentry.example/api/42/envelope/?sentry_version=7&sentry_key=public-key',
      'https://sentry.example/api/42/envelope/?sentry_version=7&sentry_key=public-key',
      'https://collector.example/v1/traces',
    ]);
  });

  it('keeps malformed exporter configuration offline', () => {
    const fetchMock = vi.fn();
    const observability = createExportingObservability({
      otlpEndpoint: 'file:///not-supported',
      sentryDsn: 'not-a-dsn',
      fetch: fetchMock,
    });
    observability.captureException(new Error('ignored'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('selects environment exporters before opt-in logging', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://collector.example');
    vi.stubEnv('SENTRY_DSN', '');
    vi.stubEnv('OBSERVABILITY_LOGGING', 'true');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const info = vi.fn();
    const error = vi.fn();

    try {
      const observability = createEnvironmentObservability({ logger: { info, error } });
      observability.captureException(new Error('environment failure'));
      await flushTelemetry();
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
      else delete (globalThis as { fetch?: typeof fetch }).fetch;
      vi.unstubAllEnvs();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('uses logging only when explicitly enabled and no exporter is configured', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('SENTRY_DSN', '');
    vi.stubEnv('OBSERVABILITY_LOGGING', 'true');
    const info = vi.fn();
    const error = vi.fn();
    const observability = createEnvironmentObservability({ logger: { info, error } });

    observability.captureException(new Error('logged failure'));

    expect(error).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('defaults to no-op when no exporter or logging adapter is enabled', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('SENTRY_DSN', '');
    vi.stubEnv('OBSERVABILITY_LOGGING', 'false');
    const info = vi.fn();
    const error = vi.fn();
    const observability = createEnvironmentObservability({ logger: { info, error } });

    observability.startSpan('offline').end('ok');
    observability.captureException(new Error('ignored'));

    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('contains clock and exception serialization failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const now = vi.fn(() => {
      throw new Error('clock unavailable');
    });
    const observability = createExportingObservability({
      otlpEndpoint: 'https://collector.example',
      fetch: fetchMock,
      now,
    });
    const hostileError = {
      toString() {
        throw new Error('cannot stringify');
      },
    };

    expect(() => {
      const span = observability.startSpan('hostile');
      span.recordException(hostileError);
      span.end('error');
      observability.captureException(hostileError);
    }).not.toThrow();
    await flushTelemetry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

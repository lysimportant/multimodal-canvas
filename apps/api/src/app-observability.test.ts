import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';

function diagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: cause ? { name: cause.name, message: cause.message, stack: cause.stack } : error.cause,
  });
}

describe('API observability boundary', () => {
  it('does not log query parameters or short-lived access tokens', async () => {
    const logLines: string[] = [];
    const app = buildApp({
      logger: {
        stream: {
          write: (message) => logLines.push(message),
        },
      },
    });
    app.get('/__test/observability-log', async (request) => ({ requestId: request.id }));
    const token = 'synthetic-short-lived-access-token';
    let closed = false;

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/__test/observability-log?access_token=${token}&scope=asset-content`,
      });

      expect(response.statusCode).toBe(200);
      await app.close();
      closed = true;

      const output = logLines.join('');
      expect(output).toContain('/__test/observability-log');
      expect(output).toMatch(/"reqId"\s*:\s*"req-/);
      expect(output).not.toContain(token);
      expect(output).not.toContain('?access_token=');
      expect(output).not.toContain('scope=asset-content');
    } finally {
      if (!closed) await app.close();
    }
  });

  it('passes only a redacted diagnostic copy to span and exception adapters', async () => {
    const recordException = vi.fn();
    const captureException = vi.fn();
    const app = buildApp({
      logger: false,
      observability: {
        startSpan: () => ({ setAttribute: vi.fn(), recordException, end: vi.fn() }),
        captureException,
      },
    });
    const source = new Error(
      'request failed Authorization: Bearer synthetic-api-bearer before provider response',
      { cause: new Error('credential rejected apiKey=synthetic-api-key during lookup') },
    );
    app.get('/__test/observability-error', async () => {
      throw source;
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/__test/observability-error' });

      expect(response.statusCode).toBe(500);
      expect(recordException).toHaveBeenCalledOnce();
      expect(captureException).toHaveBeenCalledOnce();
      const spanError = recordException.mock.calls[0][0];
      const capturedError = captureException.mock.calls[0][0];
      expect(spanError).toBe(capturedError);
      expect(spanError).not.toBe(source);
      expect(diagnosticText(spanError)).toContain('request failed');
      expect(diagnosticText(spanError)).toContain('before provider response');
      expect(diagnosticText(spanError)).toContain('during lookup');
      expect(diagnosticText(spanError)).toContain('[REDACTED]');
      expect(diagnosticText(spanError)).not.toMatch(/synthetic-api-(?:bearer|key)/);
      expect(captureException.mock.calls[0][1]).toMatchObject({ component: 'api' });
    } finally {
      await app.close();
    }
  });
});

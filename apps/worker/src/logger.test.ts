import { beforeEach, describe, expect, it, vi } from 'vitest';

const pinoState = vi.hoisted(() => {
  const base = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    base,
    factory: vi.fn(() => base),
  };
});

vi.mock('pino', () => ({
  default: pinoState.factory,
}));

import { createWorkerLogger, redactWorkerLogValue, serializeWorkerError } from './logger';

beforeEach(() => {
  vi.clearAllMocks();
  pinoState.factory.mockReturnValue(pinoState.base);
  pinoState.base.child.mockReturnValue(pinoState.base);
});

describe('worker logger redaction', () => {
  it('redacts sensitive assignments, bearer values, and URL credentials in error text', () => {
    const serialized = serializeWorkerError(
      new Error(
        'request failed password=synthetic-password secret: "synthetic-secret" client_secret=\'synthetic-client\' Authorization: Bearer synthetic-bearer https://synthetic-user:synthetic-pass@example.test/callback?client_secret=synthetic-query&keep=1',
      ),
    );

    expect(serialized.errorMessage).toContain('[REDACTED]');
    expect(serialized.errorMessage).toContain('keep=1');
    expect(serialized.errorMessage).not.toMatch(
      /synthetic-(?:password|secret|client|bearer|query|user|pass)/,
    );
  });

  it('redacts nested sensitive fields while retaining safe metadata', () => {
    const redacted = redactWorkerLogValue({
      apiKey: 'synthetic-api-key',
      request: {
        password: 'synthetic-password',
        clientSecret: 'synthetic-client-secret',
        client_secret: 'synthetic-client-secret-2',
        secretValue: 'synthetic-secret-value',
        privateKey: 'synthetic-private-key',
        accessToken: 'synthetic-access-token',
        safeStatus: 'processing',
      },
      attempts: [{ cookie: 'synthetic-cookie' }, { token: 'synthetic-token' }],
    }) as Record<string, unknown>;

    expect(redacted).toMatchObject({
      apiKey: '[REDACTED]',
      request: {
        password: '[REDACTED]',
        clientSecret: '[REDACTED]',
        client_secret: '[REDACTED]',
        secretValue: '[REDACTED]',
        privateKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        safeStatus: 'processing',
      },
      attempts: [{ cookie: '[REDACTED]' }, { token: '[REDACTED]' }],
    });
    expect(JSON.stringify(redacted)).not.toMatch(
      /synthetic-(?:api|password|client|secret|private|access|cookie|token)/,
    );
  });

  it('redacts Error causes, stacks, and custom sensitive properties', () => {
    const source = Object.assign(new Error('outer failed secret=synthetic-outer-secret'), {
      password: 'synthetic-error-password',
      cause: new Error('inner failed client_secret=synthetic-inner-secret'),
    });

    const redacted = redactWorkerLogValue(source) as {
      message: string;
      cause: { message: string };
      password: string;
    };

    expect(redacted.message).not.toContain('synthetic-outer-secret');
    expect(redacted.cause.message).not.toContain('synthetic-inner-secret');
    expect(redacted.password).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toMatch(/synthetic-(?:outer|inner|error)/);
  });

  it('sanitizes child bindings, log bindings, and messages before calling Pino', () => {
    const logger = createWorkerLogger({ level: 'silent', service: 'worker-test' });
    const child = logger.child({
      clientSecret: 'synthetic-child-secret',
      runId: 'run-safe',
    });

    child.error(
      {
        password: 'synthetic-log-password',
        metadata: { secret: 'synthetic-log-secret' },
      },
      'failed password=synthetic-message-password',
    );

    expect(pinoState.base.child).toHaveBeenCalledWith({
      clientSecret: '[REDACTED]',
      runId: 'run-safe',
    });
    expect(pinoState.base.error).toHaveBeenCalledWith(
      {
        password: '[REDACTED]',
        metadata: { secret: '[REDACTED]' },
      },
      'failed password=[REDACTED]',
    );
  });
});

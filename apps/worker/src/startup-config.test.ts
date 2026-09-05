import { describe, expect, it } from 'vitest';

import {
  assertWorkerStartupConfiguration,
  shouldStartWorkerProcess,
  StartupConfigurationError,
  validateWorkerStartupConfiguration,
  type StartupEnvironment,
} from './startup-config';

const productionEnvironment: StartupEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:password@database.example:5432/multimodal_canvas',
  REDIS_URL: 'rediss://cache.example:6380/2',
  S3_BUCKET: 'multimodal-canvas-production',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
  NEW_API_BASE_URL: 'https://newapi.example.com/v1',
  NEW_API_API_KEY: 'test-new-api-key',
  WORKER_PROVIDER: 'newapi',
  RUN_SERVICE: 'bullmq',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
};

describe('Worker production startup configuration', () => {
  it('accepts durable production configuration without a database AI credential', () => {
    expect(validateWorkerStartupConfiguration(productionEnvironment)).toEqual([]);
    expect(() => assertWorkerStartupConfiguration(productionEnvironment)).not.toThrow();
  });

  it('rejects every missing durable dependency before startup', () => {
    const issues = validateWorkerStartupConfiguration({ NODE_ENV: 'production' });

    expect(issues.map(({ variable }) => variable)).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'S3_BUCKET',
      'S3_REGION',
      'NEW_API_BASE_URL',
      'NEW_API_API_KEY',
      'AI_CREDENTIAL_ENCRYPTION_KEY',
      'WORKER_PROVIDER',
    ]);
    expect(() => assertWorkerStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      StartupConfigurationError,
    );
    expect(() => assertWorkerStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      /REDIS_URL is required/,
    );
  });

  it('allows database-backed credentials to omit static New API URL and key', () => {
    const {
      NEW_API_BASE_URL: _baseUrl,
      NEW_API_API_KEY: _apiKey,
      ...databaseBacked
    } = productionEnvironment;

    expect(validateWorkerStartupConfiguration(databaseBacked)).toEqual([]);
  });

  it('requires static New API URL and key without a complete durable credential store', () => {
    const missingDatabase = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      DATABASE_URL: '',
      NEW_API_BASE_URL: '  ',
      NEW_API_API_KEY: '  ',
    });
    expect(missingDatabase).toContainEqual({
      variable: 'NEW_API_BASE_URL',
      message: 'is required',
    });
    expect(missingDatabase).toContainEqual({ variable: 'NEW_API_API_KEY', message: 'is required' });

    const missingEncryptionKey = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      AI_CREDENTIAL_ENCRYPTION_KEY: '',
      NEW_API_BASE_URL: '  ',
      NEW_API_API_KEY: '  ',
    });
    expect(missingEncryptionKey).toContainEqual({
      variable: 'NEW_API_BASE_URL',
      message: 'is required',
    });
    expect(missingEncryptionKey).toContainEqual({
      variable: 'NEW_API_API_KEY',
      message: 'is required',
    });
  });

  it.each([
    ['userinfo', 'https://user:marker@newapi.example.com/v1', 'must not include userinfo'],
    ['query', 'https://newapi.example.com/v1?token=marker', 'must not include query parameters'],
    ['hash', 'https://newapi.example.com/v1#marker', 'must not include a fragment'],
  ])(
    'rejects production New API URL with %s without echoing URL contents',
    (_kind, baseUrl, message) => {
      const environment = { ...productionEnvironment, NEW_API_BASE_URL: baseUrl };
      const issues = validateWorkerStartupConfiguration(environment);

      expect(issues).toContainEqual({ variable: 'NEW_API_BASE_URL', message });

      let error: unknown;
      try {
        assertWorkerStartupConfiguration(environment);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StartupConfigurationError);
      expect((error as Error).message).not.toContain('marker');
    },
  );

  it('rejects mock, volatile and invalid provider choices in production', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      DATABASE_URL: 'mysql://database.example/canvas',
      REDIS_URL: 'redis:///2',
      S3_ENDPOINT: 'not a URL',
      S3_ACCESS_KEY: '',
      NEW_API_BASE_URL: 'http://newapi.example.com/v1',
      WORKER_PROVIDER: 'mock',
      RUN_SERVICE: 'memory',
    });

    expect(issues.map(({ variable }) => variable)).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'NEW_API_BASE_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY/S3_SECRET_KEY',
      'WORKER_PROVIDER',
      'RUN_SERVICE',
    ]);
  });

  it('requires credentials when a custom S3 endpoint is configured', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      S3_ENDPOINT: 'https://minio.example.com',
      S3_ACCESS_KEY: '',
      S3_SECRET_KEY: '',
    });

    expect(issues).toContainEqual({
      variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
      message: 'are required when S3_ENDPOINT is configured',
    });
  });

  it('rejects non-loopback plaintext Redis and S3 endpoints in production', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      REDIS_URL: 'redis://cache.example:6379/2',
      S3_ENDPOINT: 'http://objects.example.com',
    });

    expect(issues).toContainEqual({
      variable: 'REDIS_URL',
      message: 'must use rediss: in production unless the endpoint is loopback',
    });
    expect(issues).toContainEqual({
      variable: 'S3_ENDPOINT',
      message: 'must use HTTPS in production unless the endpoint is loopback',
    });
  });

  it('allows plaintext endpoints only for loopback sidecars', () => {
    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        REDIS_URL: 'redis://127.0.0.2:6379/2',
        S3_ENDPOINT: 'http://localhost:9000',
      }),
    ).toEqual([]);
  });

  it('allows the AWS SDK IAM role chain when no custom S3 endpoint is configured', () => {
    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        S3_ACCESS_KEY: '',
        S3_SECRET_KEY: '',
      }),
    ).toEqual([]);
  });

  it('accepts a valid credential key rotation configuration', () => {
    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        AI_CREDENTIAL_ENCRYPTION_KEY_ID: 'current-2026',
        AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ 'retired-2025': 'secret' }),
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'bad key',
      undefined,
      'AI_CREDENTIAL_ENCRYPTION_KEY_ID',
      'must be a 1-64 character key identifier',
    ],
    [undefined, 'not-json', 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS', 'must be a JSON object'],
    [
      'current',
      JSON.stringify({ current: 'duplicate' }),
      'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      'must not repeat AI_CREDENTIAL_ENCRYPTION_KEY_ID',
    ],
  ])(
    'rejects invalid credential rotation configuration',
    (keyId, previousKeys, variable, message) => {
      const issues = validateWorkerStartupConfiguration({
        ...productionEnvironment,
        ...(keyId === undefined ? {} : { AI_CREDENTIAL_ENCRYPTION_KEY_ID: keyId }),
        ...(previousKeys === undefined
          ? {}
          : { AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: previousKeys }),
      });
      expect(issues).toContainEqual({ variable, message });
    },
  );

  it('accepts explicit positive safe integer New API limits in production', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      NEW_API_TIMEOUT_MS: '120000',
      NEW_API_MAX_RESPONSE_BYTES: '52428800',
      NEW_API_VIDEO_POLL_INTERVAL_MS: '2000',
      NEW_API_VIDEO_MAX_POLL_ATTEMPTS: '120',
      NEW_API_VIDEO_MAX_CONTENT_BYTES: '52428800',
    });

    expect(issues).toEqual([]);
  });

  it.each(['0', '-1', '1.5', '1e3', '9007199254740992', 'not-a-number', '  '])(
    'rejects invalid explicit New API numeric value %s in production',
    (value) => {
      const issues = validateWorkerStartupConfiguration({
        ...productionEnvironment,
        NEW_API_TIMEOUT_MS: value,
      });

      expect(issues).toContainEqual({
        variable: 'NEW_API_TIMEOUT_MS',
        message: 'must be a positive safe integer',
      });
    },
  );

  it('keeps explicit New API numeric values compatible outside production', () => {
    expect(
      validateWorkerStartupConfiguration({
        NODE_ENV: 'development',
        NEW_API_TIMEOUT_MS: 'not-a-number',
        NEW_API_VIDEO_POLL_INTERVAL_MS: '0',
      }),
    ).toEqual([]);
  });

  it('validates every explicit New API numeric setting in production', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      NEW_API_MAX_RESPONSE_BYTES: '0',
      NEW_API_VIDEO_POLL_INTERVAL_MS: '1.2',
      NEW_API_VIDEO_MAX_POLL_ATTEMPTS: '9007199254740992',
      NEW_API_VIDEO_MAX_CONTENT_BYTES: '-4',
    });

    expect(issues.map(({ variable }) => variable)).toEqual([
      'NEW_API_MAX_RESPONSE_BYTES',
      'NEW_API_VIDEO_POLL_INTERVAL_MS',
      'NEW_API_VIDEO_MAX_POLL_ATTEMPTS',
      'NEW_API_VIDEO_MAX_CONTENT_BYTES',
    ]);
  });

  it('rejects one-sided S3 credentials even without a custom endpoint', () => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      S3_ACCESS_KEY: 'access-only',
      S3_SECRET_KEY: '',
    });

    expect(issues).toContainEqual({
      variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
      message: 'must be configured together',
    });
  });

  it('accepts the bounded result asset limit and an explicit ffprobe command', () => {
    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        RESULT_ASSET_MAX_BYTES: String(50 * 1024 * 1024),
        FFPROBE_ENABLED: 'true',
        FFPROBE_PATH: 'ffprobe',
      }),
    ).toEqual([]);
  });

  it.each(['0', '-1', '1.5', '1e3', '52428801', '9007199254740992', 'not-a-number', '  '])(
    'rejects invalid explicit result asset limit %s in production',
    (value) => {
      const issues = validateWorkerStartupConfiguration({
        ...productionEnvironment,
        RESULT_ASSET_MAX_BYTES: value,
      });

      expect(issues).toContainEqual({
        variable: 'RESULT_ASSET_MAX_BYTES',
        message: 'must be a positive safe integer no greater than 52428800',
      });
    },
  );

  it.each([
    ['yes', 'must be "true" or "false"'],
    ['', 'must be "true" or "false"'],
  ])('rejects invalid FFPROBE_ENABLED value %s in production', (value, message) => {
    const issues = validateWorkerStartupConfiguration({
      ...productionEnvironment,
      FFPROBE_ENABLED: value,
    });

    expect(issues).toContainEqual({ variable: 'FFPROBE_ENABLED', message });
  });

  it('rejects an empty ffprobe path and a disabled tool with a path', () => {
    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        FFPROBE_PATH: '  ',
      }),
    ).toContainEqual({
      variable: 'FFPROBE_PATH',
      message: 'must not be empty when configured',
    });

    expect(
      validateWorkerStartupConfiguration({
        ...productionEnvironment,
        FFPROBE_ENABLED: 'false',
        FFPROBE_PATH: 'custom-ffprobe',
      }),
    ).toContainEqual({
      variable: 'FFPROBE_ENABLED',
      message: 'cannot be "false" when FFPROBE_PATH is configured',
    });
  });

  it('validates production before honoring the local memory worker switch', () => {
    expect(() =>
      shouldStartWorkerProcess({
        ...productionEnvironment,
        RUN_SERVICE: 'memory',
      }),
    ).toThrow(/RUN_SERVICE must be "bullmq" when configured/);
  });

  it('starts only non-test BullMQ worker processes outside production', () => {
    expect(shouldStartWorkerProcess({ NODE_ENV: 'development', RUN_SERVICE: 'bullmq' })).toBe(true);
    expect(shouldStartWorkerProcess({ NODE_ENV: 'development', RUN_SERVICE: 'memory' })).toBe(
      false,
    );
    expect(shouldStartWorkerProcess({ NODE_ENV: 'test', RUN_SERVICE: 'bullmq' })).toBe(false);
  });

  it.each(['development', 'test', undefined])(
    'keeps explicit local fallbacks available outside production (%s)',
    (nodeEnvironment) => {
      expect(validateWorkerStartupConfiguration({ NODE_ENV: nodeEnvironment })).toEqual([]);
      expect(() => assertWorkerStartupConfiguration({ NODE_ENV: nodeEnvironment })).not.toThrow();
    },
  );
});

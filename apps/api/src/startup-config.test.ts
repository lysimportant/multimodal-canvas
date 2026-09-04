import { describe, expect, it } from 'vitest';

import {
  assertApiStartupConfiguration,
  StartupConfigurationError,
  validateApiStartupConfiguration,
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
  NEW_API_WEBHOOK_SECRET: 'test-webhook-secret',
  API_AUTH_TOKEN: 'test-api-auth-token',
  WORKER_PROVIDER: 'newapi',
  RUN_SERVICE: 'bullmq',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
};

describe('API production startup configuration', () => {
  it('accepts durable production configuration without a database AI credential', () => {
    expect(validateApiStartupConfiguration(productionEnvironment)).toEqual([]);
    expect(() => assertApiStartupConfiguration(productionEnvironment)).not.toThrow();
  });

  it('rejects every missing durable dependency before startup', () => {
    const issues = validateApiStartupConfiguration({ NODE_ENV: 'production' });

    expect(issues.map(({ variable }) => variable)).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'S3_BUCKET',
      'S3_REGION',
      'NEW_API_BASE_URL',
      'NEW_API_API_KEY',
      'NEW_API_WEBHOOK_SECRET',
      'AI_CREDENTIAL_ENCRYPTION_KEY',
      'API_AUTH_TOKEN/API_JWT_SECRET',
      'WORKER_PROVIDER',
    ]);
    expect(() => assertApiStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      StartupConfigurationError,
    );
    expect(() => assertApiStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('allows database-backed credentials to omit static New API URL and key', () => {
    const {
      NEW_API_BASE_URL: _baseUrl,
      NEW_API_API_KEY: _apiKey,
      ...databaseBacked
    } = productionEnvironment;

    expect(validateApiStartupConfiguration(databaseBacked)).toEqual([]);
  });

  it('requires static New API URL and key without a complete durable credential store', () => {
    const missingDatabase = validateApiStartupConfiguration({
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

    const missingEncryptionKey = validateApiStartupConfiguration({
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
      const issues = validateApiStartupConfiguration(environment);

      expect(issues).toContainEqual({ variable: 'NEW_API_BASE_URL', message });

      let error: unknown;
      try {
        assertApiStartupConfiguration(environment);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StartupConfigurationError);
      expect((error as Error).message).not.toContain('marker');
    },
  );

  it('rejects volatile run, storage and invalid endpoint choices in production', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      DATABASE_URL: 'mysql://database.example/canvas',
      REDIS_URL: 'redis:///2',
      S3_ENDPOINT: 'not a URL',
      S3_SECRET_KEY: '',
      NEW_API_BASE_URL: 'http://newapi.example.com/v1',
      WORKER_PROVIDER: 'mock',
      RUN_SERVICE: 'memory',
      API_RATE_LIMIT_REDIS_ENABLED: 'false',
    });

    expect(issues.map(({ variable }) => variable)).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'NEW_API_BASE_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY/S3_SECRET_KEY',
      'WORKER_PROVIDER',
      'RUN_SERVICE',
      'API_RATE_LIMIT_REDIS_ENABLED',
    ]);
  });

  it('requires credentials when a custom S3 endpoint is configured', () => {
    const issues = validateApiStartupConfiguration({
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

  it('allows the AWS SDK IAM role chain when no custom S3 endpoint is configured', () => {
    expect(
      validateApiStartupConfiguration({
        ...productionEnvironment,
        S3_ACCESS_KEY: '',
        S3_SECRET_KEY: '',
      }),
    ).toEqual([]);
  });

  it('rejects one-sided S3 credentials even without a custom endpoint', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      S3_ACCESS_KEY: 'access-only',
      S3_SECRET_KEY: '',
    });

    expect(issues).toContainEqual({
      variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
      message: 'must be configured together',
    });
  });

  it('rejects wildcard CORS when credentials are enabled', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      CORS_ORIGIN: 'https://canvas.example.com, *',
    });

    expect(issues).toContainEqual({
      variable: 'CORS_ORIGIN',
      message: 'must not include wildcard "*" when credentials are enabled',
    });
  });

  it('accepts explicit media tool switches and PATH-compatible command names', () => {
    expect(
      validateApiStartupConfiguration({
        ...productionEnvironment,
        FFPROBE_ENABLED: 'true',
        FFPROBE_PATH: 'ffprobe',
        FFMPEG_ENABLED: 'false',
      }),
    ).toEqual([]);
  });

  it.each([
    ['FFPROBE_ENABLED', 'yes'],
    ['FFMPEG_ENABLED', 'TRUE'],
    ['FFPROBE_ENABLED', ''],
  ])('rejects invalid %s value %s in production', (variable, value) => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      [variable]: value,
    });

    expect(issues).toContainEqual({
      variable,
      message: 'must be "true" or "false"',
    });
  });

  it.each(['FFPROBE_PATH', 'FFMPEG_PATH'])(
    'rejects an empty %s value in production',
    (variable) => {
      const issues = validateApiStartupConfiguration({
        ...productionEnvironment,
        [variable]: '  ',
      });

      expect(issues).toContainEqual({
        variable,
        message: 'must not be empty when configured',
      });
    },
  );

  it.each([
    ['FFPROBE_ENABLED', 'FFPROBE_PATH'],
    ['FFMPEG_ENABLED', 'FFMPEG_PATH'],
  ])('rejects a disabled media tool with an explicit %s path', (enabledVariable, pathVariable) => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      [enabledVariable]: 'false',
      [pathVariable]: 'custom-tool',
    });

    expect(issues).toContainEqual({
      variable: enabledVariable,
      message: `cannot be "false" when ${pathVariable} is configured`,
    });
  });

  it('accepts explicit positive safe integer New API limits in production', () => {
    const issues = validateApiStartupConfiguration({
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
      const issues = validateApiStartupConfiguration({
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
      validateApiStartupConfiguration({
        NODE_ENV: 'development',
        NEW_API_TIMEOUT_MS: 'not-a-number',
        NEW_API_VIDEO_POLL_INTERVAL_MS: '0',
      }),
    ).toEqual([]);
  });

  it('validates every explicit New API numeric setting in production', () => {
    const issues = validateApiStartupConfiguration({
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

  it('accepts either production API authentication mechanism', () => {
    expect(
      validateApiStartupConfiguration({
        ...productionEnvironment,
        API_AUTH_TOKEN: '',
        API_JWT_SECRET: 'test-jwt-secret',
      }),
    ).toEqual([]);
  });

  it('rejects production without API authentication', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      API_AUTH_TOKEN: '',
      API_JWT_SECRET: '',
    });

    expect(issues).toContainEqual({
      variable: 'API_AUTH_TOKEN/API_JWT_SECRET',
      message: 'one is required',
    });
  });

  it.each(['development', 'test', undefined])(
    'keeps explicit local fallbacks available outside production (%s)',
    (nodeEnvironment) => {
      expect(validateApiStartupConfiguration({ NODE_ENV: nodeEnvironment })).toEqual([]);
      expect(() => assertApiStartupConfiguration({ NODE_ENV: nodeEnvironment })).not.toThrow();
    },
  );
});

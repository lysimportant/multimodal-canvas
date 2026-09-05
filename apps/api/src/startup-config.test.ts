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
  it.each([undefined, '0', '1'])('accepts bounded API proxy trust %s', (hops) => {
    const environment = { ...productionEnvironment, API_TRUST_PROXY_HOPS: hops };
    expect(validateApiStartupConfiguration(environment)).toEqual([]);
    expect(() => assertApiStartupConfiguration(environment)).not.toThrow();
  });

  it.each(['', 'true', 'false', '2', '-1', '1.0', ' 1', '*'])(
    'rejects invalid production API proxy trust %j',
    (hops) => {
      const environment = { ...productionEnvironment, API_TRUST_PROXY_HOPS: hops };
      expect(validateApiStartupConfiguration(environment)).toContainEqual({
        variable: 'API_TRUST_PROXY_HOPS',
        message: 'must be "0" or "1"',
      });
      expect(() => assertApiStartupConfiguration(environment)).toThrow(StartupConfigurationError);
    },
  );

  it.each(['development', 'test', undefined])(
    'rejects unbounded API proxy trust outside production (%s)',
    (nodeEnvironment) => {
      expect(() =>
        assertApiStartupConfiguration({ NODE_ENV: nodeEnvironment, API_TRUST_PROXY_HOPS: 'true' }),
      ).toThrow('API_TRUST_PROXY_HOPS must be "0" or "1"');
    },
  );

  it.each([undefined, 'direct', 'proxy'])('accepts S3 download mode %s', (mode) => {
    const environment = { ...productionEnvironment, S3_DOWNLOAD_MODE: mode };
    expect(validateApiStartupConfiguration(environment)).toEqual([]);
    expect(() => assertApiStartupConfiguration(environment)).not.toThrow();
  });

  it.each(['', ' ', 'Proxy', 'DIRECT', ' proxy', 'direct ', 'unsupported'])(
    'rejects invalid S3 download mode %j before production startup',
    (mode) => {
      const environment = { ...productionEnvironment, S3_DOWNLOAD_MODE: mode };
      expect(validateApiStartupConfiguration(environment)).toContainEqual({
        variable: 'S3_DOWNLOAD_MODE',
        message: 'must be "proxy" or "direct"',
      });
      expect(() => assertApiStartupConfiguration(environment)).toThrow(StartupConfigurationError);
      expect(() => assertApiStartupConfiguration(environment)).toThrow(
        'S3_DOWNLOAD_MODE must be "proxy" or "direct"',
      );
    },
  );

  it.each(['development', 'test', undefined])(
    'rejects invalid S3 download mode outside production (%s)',
    (nodeEnvironment) => {
      expect(() =>
        assertApiStartupConfiguration({
          NODE_ENV: nodeEnvironment,
          S3_DOWNLOAD_MODE: 'unsupported',
        }),
      ).toThrow('S3_DOWNLOAD_MODE must be "proxy" or "direct"');
    },
  );

  it.each([undefined, 'direct', 'proxy'])('accepts S3 upload mode %s', (mode) => {
    const environment = { ...productionEnvironment, S3_UPLOAD_MODE: mode };
    expect(validateApiStartupConfiguration(environment)).toEqual([]);
    expect(() => assertApiStartupConfiguration(environment)).not.toThrow();
  });

  it.each(['', ' ', 'Proxy', 'DIRECT', ' proxy', 'direct ', 'unsupported'])(
    'rejects invalid S3 upload mode %j before production startup',
    (mode) => {
      const environment = { ...productionEnvironment, S3_UPLOAD_MODE: mode };
      expect(validateApiStartupConfiguration(environment)).toContainEqual({
        variable: 'S3_UPLOAD_MODE',
        message: 'must be "proxy" or "direct"',
      });
      expect(() => assertApiStartupConfiguration(environment)).toThrow(StartupConfigurationError);
      expect(() => assertApiStartupConfiguration(environment)).toThrow(
        'S3_UPLOAD_MODE must be "proxy" or "direct"',
      );
    },
  );

  it.each(['development', 'test', undefined])(
    'rejects invalid S3 upload mode outside production (%s)',
    (nodeEnvironment) => {
      expect(() =>
        assertApiStartupConfiguration({ NODE_ENV: nodeEnvironment, S3_UPLOAD_MODE: 'unsupported' }),
      ).toThrow('S3_UPLOAD_MODE must be "proxy" or "direct"');
    },
  );

  it('does not let proxy uploads bypass production storage or TLS requirements', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      S3_UPLOAD_MODE: 'proxy',
      S3_DOWNLOAD_MODE: 'proxy',
      S3_BUCKET: '',
      REDIS_URL: 'redis://redis:6379',
      S3_ENDPOINT: 'http://minio:9000',
    });
    expect(issues.map(({ variable }) => variable)).toEqual([
      'S3_BUCKET',
      'REDIS_URL',
      'S3_ENDPOINT',
    ]);
  });

  it.each(['newapi-unified-v1', 'legacy-v1'])('accepts video contract %s', (contract) => {
    expect(
      validateApiStartupConfiguration({
        ...productionEnvironment,
        NEW_API_VIDEO_CONTRACT: contract,
      }),
    ).toEqual([]);
  });

  it.each(['', 'sora', 'newapi-video-v1', ' legacy-v1'])(
    'rejects video contract %s',
    (contract) => {
      expect(
        validateApiStartupConfiguration({
          ...productionEnvironment,
          NEW_API_VIDEO_CONTRACT: contract,
        }),
      ).toContainEqual({
        variable: 'NEW_API_VIDEO_CONTRACT',
        message: 'must be "newapi-unified-v1" or "legacy-v1"',
      });
    },
  );
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

  it('rejects non-loopback plaintext Redis and S3 endpoints in production', () => {
    const issues = validateApiStartupConfiguration({
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
      validateApiStartupConfiguration({
        ...productionEnvironment,
        REDIS_URL: 'redis://127.0.0.2:6379/2',
        S3_ENDPOINT: 'http://localhost:9000',
      }),
    ).toEqual([]);
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

  it('rejects malformed or insecure production CORS origins', () => {
    const issues = validateApiStartupConfiguration({
      ...productionEnvironment,
      CORS_ORIGIN: 'http://canvas.example.com/path,not-a-url',
    });

    expect(issues).toContainEqual({
      variable: 'CORS_ORIGIN',
      message: 'origins must use HTTPS in production',
    });
    expect(issues).toContainEqual({
      variable: 'CORS_ORIGIN',
      message: 'origins must not include a path',
    });
    expect(issues).toContainEqual({
      variable: 'CORS_ORIGIN',
      message: 'origins must be valid URLs',
    });
  });

  it.each(['0', '65536', 'not-a-port'])(
    'rejects invalid API port %s before production startup',
    (port) => {
      const issues = validateApiStartupConfiguration({ ...productionEnvironment, API_PORT: port });

      expect(issues).toContainEqual({
        variable: 'API_PORT',
        message: 'must be a TCP port between 1 and 65535',
      });
    },
  );

  it('accepts a valid credential key rotation configuration', () => {
    expect(
      validateApiStartupConfiguration({
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
      const issues = validateApiStartupConfiguration({
        ...productionEnvironment,
        ...(keyId === undefined ? {} : { AI_CREDENTIAL_ENCRYPTION_KEY_ID: keyId }),
        ...(previousKeys === undefined
          ? {}
          : { AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: previousKeys }),
      });
      expect(issues).toContainEqual({ variable, message });
    },
  );

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

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
  WORKER_PROVIDER: 'newapi',
  RUN_SERVICE: 'bullmq',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
};

describe('Worker production startup configuration', () => {
  it('accepts the durable production configuration without a preconfigured API key', () => {
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

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
  WORKER_PROVIDER: 'newapi',
  RUN_SERVICE: 'bullmq',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
};

describe('API production startup configuration', () => {
  it('accepts the durable production configuration without a preconfigured API key', () => {
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
      'AI_CREDENTIAL_ENCRYPTION_KEY',
      'WORKER_PROVIDER',
    ]);
    expect(() => assertApiStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      StartupConfigurationError,
    );
    expect(() => assertApiStartupConfiguration({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

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

  it.each(['development', 'test', undefined])(
    'keeps explicit local fallbacks available outside production (%s)',
    (nodeEnvironment) => {
      expect(validateApiStartupConfiguration({ NODE_ENV: nodeEnvironment })).toEqual([]);
      expect(() => assertApiStartupConfiguration({ NODE_ENV: nodeEnvironment })).not.toThrow();
    },
  );
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const bullmqConstructors = vi.hoisted(() => ({
  queue: vi.fn(),
  worker: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Job: class Job {},
  Queue: class Queue {
    constructor() {
      bullmqConstructors.queue();
    }
  },
  Worker: class Worker {
    constructor() {
      bullmqConstructors.worker();
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  bullmqConstructors.queue.mockClear();
  bullmqConstructors.worker.mockClear();
});

describe('Worker process entrypoint', () => {
  it(
    'fails closed before constructing BullMQ in production with missing durable config',
    { timeout: 15_000 },
    async () => {
      vi.stubEnv('NODE_ENV', 'production');
      for (const variable of [
        'DATABASE_URL',
        'REDIS_URL',
        'S3_BUCKET',
        'S3_REGION',
        'NEW_API_BASE_URL',
        'AI_CREDENTIAL_ENCRYPTION_KEY',
        'WORKER_PROVIDER',
        'RUN_SERVICE',
      ]) {
        vi.stubEnv(variable, '');
      }

      await expect(import('./index')).rejects.toThrow(
        /Worker cannot start in production: DATABASE_URL is required/,
      );
      expect(bullmqConstructors.queue).not.toHaveBeenCalled();
      expect(bullmqConstructors.worker).not.toHaveBeenCalled();
    },
  );
});

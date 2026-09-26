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

describe('Worker 并发启动门禁', () => {
  it.each(['production', 'development', 'test'])(
    '在 %s 的进程入口拒绝非法并发，且不建立 Redis 连接',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('WORKER_CONCURRENCY', '1.5');
      await expect(import('./index')).rejects.toThrow(
        /WORKER_CONCURRENCY must be a positive safe integer/,
      );
      expect(bullmqConstructors.queue).not.toHaveBeenCalled();
      expect(bullmqConstructors.worker).not.toHaveBeenCalled();
    },
  );

  it('直接调用 Worker 工厂也必须在连接队列前拒绝非法并发', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_CONCURRENCY', undefined);
    const { createRunWorker } = await import('./index');
    vi.stubEnv('WORKER_CONCURRENCY', '0');
    expect(() => createRunWorker({ connection: { host: '127.0.0.1', port: 16389 } })).toThrow(
      /WORKER_CONCURRENCY must be a positive safe integer/,
    );
    expect(bullmqConstructors.queue).not.toHaveBeenCalled();
    expect(bullmqConstructors.worker).not.toHaveBeenCalled();
  });
});

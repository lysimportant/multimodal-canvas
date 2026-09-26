/** 管理员 API 对真实隔离 Redis 的读写及 API 重启验收，不向队列提交任务。 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './fixtures/test-app';
import { TestAuthContext } from './fixtures/auth-session';
import { BullMqRunService } from './runs';

const isolatedRedis = process.env.WORKER_CONCURRENCY_TEST_REDIS_URL;
const endpoint = '/v1/admin/generation-concurrency';

describe.skipIf(!isolatedRedis)('隔离 Redis 的管理员并发持久化', () => {
  beforeEach(() => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-concurrency-session-secret');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('API 首次初始化、重建及配置丢失恢复均反映真实 Redis 状态且不新增任务', async () => {
    if (isolatedRedis !== 'redis://127.0.0.1:16389/0')
      throw new Error('只允许显式隔离 Redis 16389/0，禁止业务 Redis');
    const queueName = 'generation-concurrency-api-test-' + randomUUID();
    const connection = {
      host: '127.0.0.1',
      port: 16389,
      maxRetriesPerRequest: null,
      connectTimeout: 2000,
    };
    const queue = new Queue(queueName, { connection });
    const apps: FastifyInstance[] = [];
    const services: BullMqRunService[] = [];
    const context = new TestAuthContext();
    const admin = await context.session({ email: 'admin@example.test', role: 'admin' });
    const headers = { authorization: 'Bearer ' + admin.accessToken };
    /** 新实例仍连接同一随机队列，模拟 API 进程重启而非前端 localStorage 缓存。 */
    const createApp = () => {
      const runs = new BullMqRunService({ connection, queueName });
      services.push(runs);
      const app = buildApp({
        ...context.appOptions,
        runService: runs,
        generationConcurrencyStore: runs.generationConcurrency,
        logger: false,
      });
      apps.push(app);
      return app;
    };
    try {
      const first = createApp();
      const unconfigured = await first.inject({ method: 'GET', url: endpoint, headers });
      expect(unconfigured.statusCode).toBe(503);
      expect(unconfigured.json().code).toBe('generation_concurrency_unconfigured');
      expect(unconfigured.json()).not.toHaveProperty('settings');
      expect(await queue.getGlobalConcurrency()).toBeNull();
      const updated = await first.inject({
        method: 'PATCH',
        url: endpoint,
        headers,
        payload: { concurrency: 32 },
      });
      expect(updated.statusCode).toBe(200);
      expect(await queue.getGlobalConcurrency()).toBe(32);
      await first.close();
      // 内存身份夹具随 API 关闭清空；重启后重新登录，队列配置仍必须保留。
      const restartedAdmin = await context.session({ email: 'admin@example.test', role: 'admin' });
      headers.authorization = 'Bearer ' + restartedAdmin.accessToken;
      const second = createApp();
      const current = await second.inject({ method: 'GET', url: endpoint, headers });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toEqual({ settings: { concurrency: 32, scope: 'queue' } });
      const invalid = await second.inject({
        method: 'PATCH',
        url: endpoint,
        headers,
        payload: { concurrency: 0 },
      });
      expect(invalid.statusCode).toBe(400);
      expect(await queue.getGlobalConcurrency()).toBe(32);
      await queue.removeGlobalConcurrency();
      const missing = await second.inject({ method: 'GET', url: endpoint, headers });
      expect(missing.statusCode).toBe(503);
      expect(missing.json().code).toBe('generation_concurrency_unconfigured');
      expect(missing.json()).not.toHaveProperty('settings');
      expect(await queue.getGlobalConcurrency()).toBeNull();
      const restored = await second.inject({
        method: 'PATCH',
        url: endpoint,
        headers,
        payload: { concurrency: 20 },
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toEqual({ settings: { concurrency: 20, scope: 'queue' } });
      expect(await queue.getGlobalConcurrency()).toBe(20);
      const reread = await second.inject({ method: 'GET', url: endpoint, headers });
      expect(reread.statusCode).toBe(200);
      expect(reread.json()).toEqual(restored.json());
      expect(await queue.getJobCounts('active', 'waiting', 'completed', 'failed')).toMatchObject({
        active: 0,
        waiting: 0,
        completed: 0,
        failed: 0,
      });
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await Promise.all(services.map((service) => service.close()));
      await queue.obliterate();
      await queue.close();
    }
  });
});

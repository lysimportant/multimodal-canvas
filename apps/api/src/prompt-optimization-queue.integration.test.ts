import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPromptOptimizationCanvas,
  PROMPT_OPTIMIZATION_NODE_ID,
  PROMPT_SKILLS,
} from '@multimodal-canvas/domain';
import { BullMqRunService, createRunSnapshot, redisConnectionFromUrl } from './runs';
import { PrismaRunPersistence } from './run-persistence';

/** 仅使用明确确认的隔离设施；不回退到应用连接，也不清空 Redis 数据库。 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const redisUrl = process.env.TEST_REDIS_URL?.trim();
if (databaseUrl && redisUrl) {
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true' ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !database.pathname.endsWith('_test') ||
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error('Skill 队列测试需要本机 _test 数据库及专用 Redis DB 15');
}

/** 未配置设施时保留显式跳过，真实发布只在下列随机队列中进行。 */
const queueDescribe = databaseUrl && redisUrl ? describe : describe.skip;
queueDescribe('Skill queue recovery with PostgreSQL and Redis', () => {
  const projectId = randomUUID();
  const queueName = `skill-test-${randomUUID()}`;
  let prisma: PrismaClient;
  let queue: Queue;
  let service: BullMqRunService;
  let persistence: PrismaRunPersistence;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await prisma.project.create({ data: { id: projectId, name: 'Skill queue synthetic test' } });
    persistence = new PrismaRunPersistence(prisma);
    const connection = redisConnectionFromUrl(redisUrl!);
    queue = new Queue(queueName, { connection });
    service = new BullMqRunService({ connection, queueName, providerName: 'mock', persistence });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await service?.close();
    if (queue) {
      // 只清理本用例随机命名且没有消费者的队列。
      await queue.obliterate();
      await queue.close();
    }
    if (prisma) {
      await prisma.project.delete({ where: { id: projectId } });
      await prisma.$disconnect();
    }
  });

  it('发布失败后跨服务恢复原冻结任务，终态队列移除后不重发', async () => {
    const input = {
      version: 1 as const,
      blocks: [{ type: 'text' as const, text: '完善章节要求' }],
    };
    const skill = PROMPT_SKILLS[0]!;
    const snapshot = {
      ...createRunSnapshot(
        projectId,
        createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'text' }),
        PROMPT_OPTIMIZATION_NODE_ID,
      ),
      promptOptimization: {
        nodeId: 'source',
        skillId: skill.id,
        skillVersion: skill.version,
        input,
        instruction: skill.instruction,
      },
    };
    const add = vi
      .spyOn(Queue.prototype, 'add')
      .mockRejectedValueOnce(new Error('synthetic queue publish failure'));
    await expect(service.create(snapshot, { idempotencyKey: 'same-click' })).rejects.toThrow(
      'publish failure',
    );
    const [durable] = await persistence.listRunsByProject(projectId);
    expect(durable).toMatchObject({ status: 'queued', provider: 'mock', snapshot });
    expect(await queue.getWaitingCount()).toBe(0);
    add.mockRestore();
    await service.close();
    service = new BullMqRunService({
      connection: redisConnectionFromUrl(redisUrl!),
      queueName,
      providerName: 'mock',
      persistence,
    });
    const recovered = await service.create(durable!.snapshot, { idempotencyKey: 'same-click' });
    const repeated = await service.create(durable!.snapshot, { idempotencyKey: 'same-click' });
    expect(repeated.id).toBe(recovered.id);
    expect(await queue.getWaitingCount()).toBe(1);
    expect(recovered.snapshot).toEqual(snapshot);
    expect(await persistence.listRunsByProject(projectId)).toHaveLength(1);
    await persistence.updateRun({
      runId: recovered.id,
      status: 'failed',
      error: 'synthetic terminal result',
    });
    await (await queue.getJob(recovered.id))!.remove();
    expect((await service.create(snapshot, { idempotencyKey: 'same-click' })).status).toBe(
      'failed',
    );
    expect(await queue.getWaitingCount()).toBe(0);
  });
});

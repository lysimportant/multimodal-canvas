import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { ExecutionError, PrismaExecutionService } from '@multimodal-canvas/execution';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaRunPersistence } from './run-persistence';
import { BullMqRunService, redisConnectionFromUrl } from './runs';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const redisUrl = process.env.TEST_REDIS_URL?.trim();
if (process.env.REQUIRE_INTEGRATION_SERVICES === 'true' && (!databaseUrl || !redisUrl)) {
  throw new Error(
    'Integration test configuration is incomplete: TEST_DATABASE_URL and TEST_REDIS_URL are required',
  );
}
if (databaseUrl || redisUrl) {
  if (!databaseUrl || !redisUrl)
    throw new Error('执行集成验收必须同时提供 TEST_DATABASE_URL 与 TEST_REDIS_URL');
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !/(?:_test|_ci)$/.test(database.pathname) ||
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error('执行验收仅接受已确认隔离的本机 _test/_ci 数据库和 Redis DB 15');
}

const integrationDescribe = databaseUrl && redisUrl ? describe : describe.skip;
integrationDescribe('中性执行授权与 outbox（隔离 PostgreSQL + Redis）', () => {
  const schemaName = `execution_${randomUUID().replaceAll('-', '')}`;
  const queueName = `execution-api-test-${randomUUID()}`;
  const projectId = randomUUID();
  const userId = randomUUID();
  const credentialId = randomUUID();
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const prismaCli = fileURLToPath(
    new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
  );
  const prismaSchema = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
  const execFileAsync = promisify(execFile);
  let prisma: PrismaClient;
  let queue: Queue;
  let service: BullMqRunService;
  let execution: PrismaExecutionService;

  beforeAll(async () => {
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('schema', schemaName);
    await execFileAsync(
      process.execPath,
      [prismaCli, 'db', 'push', '--schema', prismaSchema, '--skip-generate'],
      {
        cwd: workspaceRoot,
        env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
    await prisma.$connect();
    await prisma.user.create({
      data: { id: userId, role: 'USER', status: 'active' },
    });
    await prisma.project.create({
      data: { id: projectId, ownerId: userId, name: 'Execution integration' },
    });
    await prisma.aiCredential.create({
      data: {
        id: credentialId,
        ownerId: userId,
        label: 'Canvas default',
        baseUrl: 'https://newapi.example/v1',
        encryptedApiKey: 'synthetic-encrypted-key',
        keyFingerprint: 'synthetic-fingerprint',
        version: 1,
      },
    });
    const connection = redisConnectionFromUrl(redisUrl!);
    queue = new Queue(queueName, { connection });
    execution = new PrismaExecutionService(prisma);
    service = new BullMqRunService({
      connection,
      queueName,
      providerName: 'newapi',
      persistence: new PrismaRunPersistence(prisma),
      execution,
    });
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await service?.close();
    if (queue) {
      await queue.obliterate();
      await queue.close();
    }
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await prisma.$disconnect();
    }
  }, 30_000);

  it('Redis 发布失败后保留同一授权和 outbox，恢复与重复派发不新增 job', async () => {
    const snapshot = executionSnapshot();
    const add = vi
      .spyOn(Queue.prototype, 'add')
      .mockRejectedValueOnce(new Error('synthetic queue publish failure'));

    const accepted = await service.create(snapshot, {
      userId,
      idempotencyKey: 'atomic-submission',
    });
    expect(accepted.status).toBe('queued');
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await prisma.executionAuthorization.count({ where: { runId: accepted.id } })).toBe(1);
    expect(await prisma.runOutbox.count({ where: { runId: accepted.id, publishedAt: null } })).toBe(
      1,
    );
    add.mockRestore();

    await service.dispatchOutbox();
    await service.dispatchOutbox();
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await prisma.executionAuthorization.count({ where: { runId: accepted.id } })).toBe(1);
    expect(await prisma.runOutbox.count({ where: { runId: accepted.id } })).toBe(1);

    const repeated = await service.create(snapshot, {
      userId,
      idempotencyKey: 'atomic-submission',
    });
    expect(repeated.id).toBe(accepted.id);
    expect(await queue.getWaitingCount()).toBe(1);

    await expect(
      service.create(snapshot, {
        userId: randomUUID(),
        idempotencyKey: 'atomic-submission',
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
  });

  it('取消先更新 PostgreSQL，迟到派发只能发布 cancelRequested 的原任务', async () => {
    const add = vi
      .spyOn(Queue.prototype, 'add')
      .mockRejectedValueOnce(new Error('synthetic queue publish failure'));
    const accepted = await service.create(executionSnapshot(), {
      userId,
      idempotencyKey: 'cancel-before-publish',
    });
    add.mockRestore();

    const cancelled = await service.cancel(accepted.id);
    expect(cancelled.status).toBe('cancel_requested');
    const outbox = await prisma.runOutbox.findUniqueOrThrow({ where: { runId: accepted.id } });
    expect(outbox.payload).toMatchObject({ cancelRequested: true });

    await service.dispatchOutbox();
    const job = await queue.getJob(accepted.id);
    expect(job?.data).toMatchObject({ runId: accepted.id, cancelRequested: true });
    await expect(
      execution.beginSend({
        runId: accepted.id,
        nodeId: 'target',
        attempt: 1,
        requestIdentity: 'cancelled-request',
      }),
    ).rejects.toMatchObject({ code: 'authorization_revoked' });
  });

  it('同一幂等身份并发受理只创建一个 Run、授权、outbox 和 job', async () => {
    const accepted = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.create(executionSnapshot(), {
          userId,
          idempotencyKey: 'concurrent-submission',
        }),
      ),
    );
    const runIds = new Set(accepted.map((run) => run.id));
    expect(runIds.size).toBe(1);
    const [runId] = runIds;
    expect(await prisma.executionAuthorization.count({ where: { runId } })).toBe(1);
    expect(await prisma.runOutbox.count({ where: { runId } })).toBe(1);
    expect(await queue.getJob(runId!)).toBeTruthy();
  });

  it('拒绝缺少逐节点执行授权的 New API 新任务，且不写 outbox 或队列', async () => {
    const unauthorized = executionSnapshot();
    delete unauthorized.executionBindings;
    const before = {
      authorizations: await prisma.executionAuthorization.count(),
      outbox: await prisma.runOutbox.count(),
      waiting: await queue.getWaitingCount(),
    };

    await expect(
      service.create(unauthorized, {
        userId,
        idempotencyKey: 'missing-execution-binding',
      }),
    ).rejects.toMatchObject({ code: 'binding_required' });

    expect(await prisma.executionAuthorization.count()).toBe(before.authorizations);
    expect(await prisma.runOutbox.count()).toBe(before.outbox);
    expect(await queue.getWaitingCount()).toBe(before.waiting);
  });

  function executionSnapshot(): RunSnapshot {
    return {
      projectId,
      canvasRevision: 1,
      targetNodeId: 'target',
      modelAlias: 'model-1',
      parameters: {},
      submittedAt: '2026-09-21T00:00:00.000Z',
      nodes: [
        {
          id: 'target',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: 'Target',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'model-1',
          },
        },
      ],
      edges: [],
      inputs: [],
      nodeCredentialReferences: {
        target: {
          credentialId,
          credentialVersion: 1,
          newApi: authority(),
        },
      },
      executionBindings: {
        target: {
          credentialId,
          credentialVersion: 1,
          modelAlias: 'model-1',
          mediaType: 'text',
          contract: 'newapi-chat-v1',
          authority: authority(),
        },
      },
    };
  }

  function authority() {
    return {
      issuer: 'https://newapi.example',
      externalUserId: 'upstream-user',
      instanceId: 'canvas-instance',
      grantId: 'grant-1',
      tokenId: 'token-1',
      credentialRevision: 'credential-1',
      group: 'default',
      permissionRevision: 'revision-1',
      autoGroups: ['default'],
    };
  }
});

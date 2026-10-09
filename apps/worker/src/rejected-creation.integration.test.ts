/** 真实 Redis/PostgreSQL 的创建拒绝回归；Provider 全部合成，禁止任何 HTTP 调用。 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { ConnectionOptions, Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { runJobDataSchema, type RunJobData, type RunSnapshot } from '@multimodal-canvas/domain';
import {
  executionDatabaseRunId,
  executionSnapshotFingerprint,
  PrismaExecutionService,
} from '@multimodal-canvas/execution';
import { NewApiProviderError, reportRequestPrompt } from '@multimodal-canvas/providers';
import {
  createProviderJobRecord,
  createRunWorker,
  type WorkerExecutionAuthorization,
  type WorkerProviderRequest,
} from './index';
import { WorkerPrismaRunPersistence } from './prisma-persistence';
import { withTestExecutionBindings } from './test-execution-fixtures';

/** 仅接受显式隔离地址；缺失时跳过，绝不读取业务 DATABASE_URL。 */
const databaseUrl = process.env.RESULT_RECOVERY_TEST_DATABASE_URL;
/** 仅接受独立测试 Redis；缺失时跳过，绝不读取业务 REDIS_URL。 */
const redisUrl = process.env.RESULT_RECOVERY_TEST_REDIS_URL;
/** 被目标图片依赖的合成文字节点；所有发送记录必须属于该节点。 */
const upstreamNodeId = 'synthetic-upstream-text';
/** 图片节点只作为目标存在，文字请求被拒绝后不能执行它。 */
const targetNodeId = '7';
/** 复现错误媒体端点组合的冻结模型名，不触发真实模型调用。 */
const modelAlias = 'gpt-image-2';
/** HTTP 400 的原始错误文本，不允许被重复发送保护提示覆盖。 */
const rejectionMessage = 'This model is not supported on the Chat Completions endpoint';
/** 合成文字创建请求的留存身份，区别于节点的持久发送身份。 */
const requestIdentity = 'POST /chat/completions#1';
/** 当前测试拥有的真实 Worker 和同命名空间 Queue。 */
type TestWorker = ReturnType<typeof createRunWorker>;

/**
 * 在创建客户端前校验专用端口、库名和用户，返回显式连接配置。
 * 地址缺失或指向其它服务时抛错；不执行连接、探测或清理。
 */
function isolatedConnections(): { databaseUrl: string; connection: ConnectionOptions } {
  if (!databaseUrl || !redisUrl) throw new Error('缺少显式 RESULT_RECOVERY_TEST 隔离地址');
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '16390' ||
    database.pathname !== '/result_recovery_test' ||
    database.username !== 'recovery_test' ||
    database.search ||
    database.hash ||
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    redis.port !== '16389' ||
    redis.username ||
    redis.password ||
    (redis.pathname !== '' && redis.pathname !== '/0') ||
    redis.search ||
    redis.hash
  ) {
    throw new Error('创建拒绝验收仅允许 result_recovery_test:16390 与本机 Redis:16389');
  }
  return { databaseUrl, connection: { host: redis.hostname, port: Number(redis.port) } };
}

/** 保留真实 Prisma 写入与恢复查询；只替换不参与联网的凭据解析。 */
class SyntheticPersistence extends WorkerPrismaRunPersistence {
  /** 返回不可用合成凭据，不访问真实账号；Provider 必须由 fixture 注入。 */
  override async getProviderCredentials() {
    return { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-not-a-real-key' };
  }
}

/** 等待当前随机队列内指定任务进入 failed；10 秒未结束或任务消失时测试失败。 */
async function waitForFailure(instance: TestWorker, runId: string): Promise<Job<RunJobData>> {
  await expect
    .poll(async () => (await instance.queue.getJob(runId))?.getState(), {
      timeout: 10_000,
      interval: 25,
    })
    .toBe('failed');
  const job = await instance.queue.getJob(runId);
  if (!job) throw new Error('合成失败任务在断言前消失');
  return job;
}

/**
 * 只读取本 fixture 的 Run，核对原错、上游节点、发送终态与请求身份。
 * 返回完整发送及提示词记录，用于确认人工重投不会改写已持久化证据。
 */
async function assertPersistedRejection(prisma: PrismaClient, runId: string) {
  const databaseRunId = executionDatabaseRunId(runId);
  const run = await prisma.run.findUniqueOrThrow({ where: { id: databaseRunId } });
  expect(run).toMatchObject({
    status: 'FAILED',
    error: { message: rejectionMessage },
    result: null,
  });
  expect(run.nodeTimings).toMatchObject({ [upstreamNodeId]: { outcome: 'failed' } });
  expect(run.nodeTimings).not.toHaveProperty(targetNodeId);

  const intents = await prisma.runSendIntent.findMany({ where: { runId } });
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    runId,
    nodeId: upstreamNodeId,
    attempt: 1,
    requestIdentity: `provider_job_${runId}_${upstreamNodeId}`,
    status: 'failed',
    error: rejectionMessage,
    platformJobId: null,
  });
  const prompts = await prisma.runRequestPrompt.findMany({ where: { runId: databaseRunId } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    requestRunId: runId,
    nodeId: upstreamNodeId,
    attempt: 1,
    requestIdentity,
    mediaType: 'TEXT',
    modelAlias,
    sendStatus: 'failed',
    assetId: null,
    assetVersion: null,
  });
  const upstreamJob = await prisma.providerJob.findFirstOrThrow({
    where: {
      runId: databaseRunId,
      payload: { path: ['workflowNodeId'], equals: upstreamNodeId },
    },
  });
  expect(upstreamJob).toMatchObject({
    status: 'failed',
    payload: { workflowNodeId: upstreamNodeId, sendStatus: 'failed', error: rejectionMessage },
  });
  return { intents, prompts };
}

/** 未显式提供隔离入口时不建立任何数据库或 Redis 客户端。 */
describe.skipIf(!databaseUrl || !redisUrl)('真实 BullMQ 的确定性创建 400 拒绝', () => {
  it.each(['queue-retry', 'restarted-database-replay'] as const)(
    '%s：attempts=4 只执行一次 fake POST，重投保留上游原错',
    async (mode) => {
      const isolated = isolatedConnections();
      const prisma = new PrismaClient({ datasources: { db: { url: isolated.databaseUrl } } });
      const restartedPrisma = new PrismaClient({
        datasources: { db: { url: isolated.databaseUrl } },
      });
      const userId = randomUUID();
      const projectId = randomUUID();
      const runId = 'run_' + randomUUID();
      const databaseRunId = executionDatabaseRunId(runId);
      const queueName = 'rejected-creation-integration-' + randomUUID();
      const snapshot: RunSnapshot = withTestExecutionBindings({
        projectId,
        canvasRevision: 1,
        targetNodeId,
        modelAlias,
        credentialId: randomUUID(),
        credentialVersion: 1,
        parameters: {},
        submittedAt: '2026-09-29T00:00:00.000Z',
        nodes: [
          {
            id: upstreamNodeId,
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: '合成上游文字', mediaType: 'text', mode: 'generate', modelAlias },
          },
          {
            id: targetNodeId,
            type: 'image',
            position: { x: 300, y: 0 },
            data: { label: '合成目标图片 7', mediaType: 'image', mode: 'generate', modelAlias },
          },
        ],
        edges: [
          {
            id: 'synthetic-text-to-image',
            sourceNodeId: upstreamNodeId,
            sourceHandle: 'output:text',
            targetNodeId,
            targetHandle: 'input:prompt',
            order: 0,
          },
        ],
        inputs: [],
      });
      const data: RunJobData = {
        runId,
        userId,
        snapshot,
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi'),
        cancelRequested: false,
      };
      const httpRequests = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('该集成 fixture 禁止 HTTP；Provider 必须使用合成实现');
      });
      const post = vi.fn(async () => {
        throw new NewApiProviderError(rejectionMessage, { status: 400, retryable: false });
      });
      const provider = {
        execute: vi.fn(async (request: WorkerProviderRequest) => {
          expect(request.snapshot.targetNodeId).toBe(upstreamNodeId);
          expect(request.onRequestPrompt).toBeTypeOf('function');
          await reportRequestPrompt({
            ...request,
            provider: 'newapi',
            mediaType: 'text',
            requestIdentity,
            format: 'plain',
            parts: [{ order: 0, text: 'Generate a synthetic test description.' }],
            resources: [],
          });
          return post();
        }),
      };
      const archive = vi.fn(async () => {
        throw new Error('被拒绝的请求不应进入归档');
      });
      let sendClaims = 0;
      const workerErrors: Error[] = [];
      const failures: Error[] = [];

      /** 每次创建新的授权服务和持久化适配器；只绕过真实账号的远端校验。 */
      function startWorker(client: PrismaClient): TestWorker {
        const service = new PrismaExecutionService(client);
        const execution: WorkerExecutionAuthorization = {
          async authorizeRun(id, frozen, owner) {
            const authorization = await service.requireAuthorization(id, frozen);
            if (authorization.userId !== owner) throw new Error('合成任务归属不一致');
          },
          async authorizeNode(id, _nodeId, frozen) {
            await service.requireAuthorization(id, frozen);
          },
          async beginSend(input) {
            sendClaims++;
            await service.beginSend(input);
          },
          async finishSend(input) {
            await service.finishSend(input);
          },
          async assertRetrySafe(input) {
            await service.assertRetrySafe(input);
          },
          async reconcileReceived(input) {
            await service.reconcileReceived(input);
          },
        };
        const instance = createRunWorker({
          connection: isolated.connection,
          queueName,
          stepDelayMs: 0,
          providerName: 'newapi',
          provider,
          execution,
          persistence: new SyntheticPersistence(client, 'synthetic-rejected-creation-key'),
          resolveDatabaseRunId: executionDatabaseRunId,
          resultArchiver: archive,
          onPersistenceError(error) {
            throw error;
          },
        });
        instance.worker.on('error', (error) => {
          workerErrors.push(error);
        });
        instance.worker.on('failed', (_job, error) => {
          failures.push(error);
        });
        return instance;
      }

      let first: TestWorker | undefined;
      let restarted: TestWorker | undefined;
      try {
        await prisma.user.create({
          data: { id: userId, displayName: 'synthetic creation rejection' },
        });
        await prisma.project.create({
          data: { id: projectId, ownerId: userId, name: 'synthetic creation rejection' },
        });
        await prisma.$transaction([
          prisma.run.create({
            data: {
              id: databaseRunId,
              userId,
              projectId,
              status: 'QUEUED',
              modelAlias,
              snapshot: snapshot as Prisma.InputJsonValue,
              attempt: 1,
            },
          }),
          prisma.executionAuthorization.create({
            data: {
              runId,
              databaseRunId,
              userId,
              projectId,
              snapshot: snapshot as Prisma.InputJsonValue,
              snapshotFingerprint: executionSnapshotFingerprint(snapshot),
            },
          }),
          prisma.runOutbox.create({
            data: { runId, queueName, payload: data as unknown as Prisma.InputJsonValue },
          }),
        ]);
        first = startWorker(prisma);
        await first.worker.waitUntilReady();
        await first.queue.add('run', data, {
          jobId: runId,
          attempts: 4,
          backoff: { type: 'fixed', delay: 25 },
        });
        const failed = await waitForFailure(first, runId);

        expect(failed.opts.attempts).toBe(4);
        expect(failed.attemptsMade).toBe(1);
        expect(failed.failedReason).toBe(rejectionMessage);
        expect(post).toHaveBeenCalledOnce();
        expect(sendClaims).toBe(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ name: 'UnrecoverableError', cause: { status: 400 } });
        const original = await assertPersistedRejection(prisma, runId);

        if (mode === 'restarted-database-replay') {
          await first.worker.close();
          await prisma.$disconnect();
          const outbox = await restartedPrisma.runOutbox.findUniqueOrThrow({ where: { runId } });
          const frozenPayload = runJobDataSchema.parse(outbox.payload);
          expect(frozenPayload.workflowState).toBeUndefined();
          // 仅恢复本测试冻结 outbox，刻意不携带队列节点回执，以验证真实 Prisma 回读。
          await failed.updateData(frozenPayload);
          restarted = startWorker(restartedPrisma);
          await restarted.worker.waitUntilReady();
        }
        await failed.retry();
        const replayed = await waitForFailure(restarted ?? first, runId);

        expect(post).toHaveBeenCalledOnce();
        expect(httpRequests).not.toHaveBeenCalled();
        const activePrisma = restarted ? restartedPrisma : prisma;
        const replayedRun = await activePrisma.run.findUniqueOrThrow({
          where: { id: databaseRunId },
        });
        expect(await activePrisma.runSendIntent.findMany({ where: { runId } })).toEqual(
          original.intents,
        );
        expect(
          await activePrisma.runRequestPrompt.findMany({ where: { runId: databaseRunId } }),
        ).toEqual(original.prompts);
        expect({
          queueError: replayed.failedReason,
          attemptsMade: replayed.attemptsMade,
          runError: replayedRun.error,
          providerCalls: provider.execute.mock.calls.length,
          sendClaims,
        }).toEqual({
          queueError: rejectionMessage,
          attemptsMade: 2,
          runError: { message: rejectionMessage },
          providerCalls: 1,
          sendClaims: 1,
        });
        expect(provider.execute).toHaveBeenCalledOnce();
        expect(sendClaims).toBe(1);
        expect(await assertPersistedRejection(activePrisma, runId)).toEqual(original);
        expect(failures).toHaveLength(2);
        expect(failures.every((error) => error.name === 'UnrecoverableError')).toBe(true);
        expect(workerErrors).toEqual([]);
        expect(archive).not.toHaveBeenCalled();
        expect(httpRequests).not.toHaveBeenCalled();
      } finally {
        try {
          await first?.worker.close();
          await restarted?.worker.close();
          const cleanupQueue = restarted?.queue ?? first?.queue;
          if (cleanupQueue) {
            if (
              cleanupQueue.name !== queueName ||
              !queueName.startsWith('rejected-creation-integration-')
            )
              throw new Error('拒绝清理不属于本 fixture 的队列');
            await cleanupQueue.obliterate({ force: true });
            expect(await cleanupQueue.getJob(runId)).toBeUndefined();
          }
          await restartedPrisma.$transaction([
            restartedPrisma.runSendIntent.deleteMany({ where: { runId } }),
            restartedPrisma.runOutbox.deleteMany({ where: { runId } }),
            restartedPrisma.executionAuthorization.deleteMany({ where: { runId } }),
            restartedPrisma.run.deleteMany({ where: { id: databaseRunId, userId, projectId } }),
            restartedPrisma.project.deleteMany({ where: { id: projectId, ownerId: userId } }),
            restartedPrisma.user.deleteMany({ where: { id: userId } }),
          ]);
        } finally {
          await Promise.all([
            first?.queue.close(),
            restarted?.queue.close(),
            prisma.$disconnect(),
            restartedPrisma.$disconnect(),
          ]);
          httpRequests.mockRestore();
        }
      }
    },
    30_000,
  );
});

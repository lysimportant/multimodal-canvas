/** 非音频结果跨真实 BullMQ Worker 恢复；只连接显式隔离的 PostgreSQL/Redis。 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import {
  createMockPromptOptimizationOutput,
  createPromptOptimizationCanvas,
  PROMPT_OPTIMIZATION_NODE_ID,
  PROMPT_SKILLS,
  type PromptDocument,
  type RunJobData,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import {
  executionDatabaseRunId,
  executionSnapshotFingerprint,
  PrismaExecutionService,
} from '@multimodal-canvas/execution';
import {
  NewApiVideoProvider,
  type ProviderExecution,
  type ProviderOutput,
} from '@multimodal-canvas/providers';
import {
  createProviderJobRecord,
  createRunWorker,
  type ResultAssetArchiver,
  type WorkerExecutionAuthorization,
  type WorkerProviderRequest,
} from './index';
import { parseStoredNodeTimings } from './node-timings';
import { WorkerPrismaRunPersistence } from './prisma-persistence';
import { ResultUrlUnavailableError } from './result-archiver';
import {
  createRedisResultStagingStore,
  createResultStagingRedisAdapter,
  type ResultStagingIdentity,
} from './result-staging';
import { withTestExecutionBindings } from './test-execution-fixtures';

/** 缺少任一显式地址就跳过，绝不回退到业务 DATABASE_URL/REDIS_URL。 */
const databaseUrl = process.env.RESULT_RECOVERY_TEST_DATABASE_URL;
const redisUrl = process.env.RESULT_RECOVERY_TEST_REDIS_URL;
/** 仅用于合成回执的加密，不可作为真实凭据。 */
const stagingSecret = 'synthetic-non-audio-recovery-key';
/** 视频归档及失效 URL 刷新、独立反推与独立提示词优化的隔离恢复场景。 */
type RecoveryKind = 'video' | 'video-expired' | 'reversePrompt' | 'promptOptimization';
/** 每次实例都持有独立的真实 Worker、Queue 和 Redis 连接。 */
type RunWorker = ReturnType<typeof createRunWorker>;

/** 在创建任何客户端前校验隔离门禁；不匹配时拒绝连接及清理。 */
function assertIsolatedServices(): void {
  const database = new URL(databaseUrl!);
  const redis = new URL(redisUrl!);
  if (
    database.protocol !== 'postgresql:' ||
    database.hostname !== '127.0.0.1' ||
    database.port !== '16390' ||
    database.pathname !== '/result_recovery_test' ||
    database.username !== 'recovery_test' ||
    redis.protocol !== 'redis:' ||
    redis.hostname !== '127.0.0.1' ||
    redis.port !== '16389' ||
    redis.username ||
    redis.password ||
    (redis.pathname !== '' && redis.pathname !== '/0') ||
    database.search ||
    database.hash ||
    redis.search ||
    redis.hash
  ) {
    throw new Error('非音频恢复验收仅允许独立本机 result_recovery_test:16390 与 Redis:16389');
  }
}

/** 保留真实 Prisma 生命周期写入，只替换实时凭据并注入一次收到响应后的回执故障。 */
class SyntheticPersistence extends WorkerPrismaRunPersistence {
  /** 首次 received 回执在写入前失败；错误处理和下一实例仍走真实数据库。 */
  failReceivedReceipt = false;

  /** 模拟响应已暂存但 received 回执尚未落库的中断，后续调用不再注入故障。 */
  override async upsertProviderJob(
    input: Parameters<WorkerPrismaRunPersistence['upsertProviderJob']>[0],
  ) {
    if (this.failReceivedReceipt && input.providerJob.payload?.deliveryState === 'received') {
      this.failReceivedReceipt = false;
      throw new Error('synthetic independent receipt interruption');
    }
    return super.upsertProviderJob(input);
  }

  /** 返回不可用合成凭据；Provider 完全注入，不读取真实账户或调用上游。 */
  override async getProviderCredentials() {
    return { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-not-a-real-key' };
  }
}

/** 只扫描当前随机队列命名空间的暂存键，不读取或清理任何业务队列。 */
async function stagingKeys(instance: RunWorker, queueName: string): Promise<string[]> {
  const client = await instance.queue.client;
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, found] = await client.scan(cursor, {
      MATCH: `${queueName}:result-staging:*`,
      COUNT: 100,
    });
    cursor = next;
    found.forEach((key) => keys.add(key));
  } while (cursor !== '0');
  return [...keys];
}

/** 等待指定合成任务终态；超时或 Worker 异常显式失败，避免只凭事件回调判成功。 */
async function waitForState(
  instance: RunWorker,
  runId: string,
  expected: 'failed' | 'completed',
): Promise<void> {
  await expect
    .poll(
      async () => {
        const job = await instance.queue.getJob(runId);
        const state = await job?.getState();
        if (expected === 'completed' && state === 'failed') {
          throw new Error(`合成任务恢复失败：${job?.failedReason}`);
        }
        return state;
      },
      { timeout: 10_000, interval: 50 },
    )
    .toBe(expected);
}

describe.skipIf(!databaseUrl || !redisUrl)('非音频结果跨真实 Worker 恢复', () => {
  it.each(['video', 'video-expired', 'reversePrompt', 'promptOptimization'] as const)(
    '%s：原响应只生成一次，重启恢复原身份与成功终态',
    async (kind: RecoveryKind) => {
      assertIsolatedServices();
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const restartedPrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      const userId = randomUUID();
      const projectId = randomUUID();
      const runId = `run_${randomUUID()}`;
      const databaseRunId = executionDatabaseRunId(runId);
      const queueName = `non-audio-recovery-${randomUUID()}`;
      const nodeId =
        kind === 'promptOptimization' ? PROMPT_OPTIMIZATION_NODE_ID : `synthetic-${kind}`;
      const modelAlias = `synthetic-${kind}-only`;
      const expired = kind === 'video-expired';
      const video = kind === 'video' || expired;
      const mediaType = video ? 'video' : 'text';
      const platformJobId = `synthetic-video-${randomUUID()}`;
      const providerRequestId = `synthetic-response-${randomUUID()}`;
      const requestProviderJobId = `provider_job_${runId}`;
      const requestIdentity = video ? 'POST /videos#1' : 'POST /chat/completions#1';
      const outputUrl = `https://synthetic.invalid/results/${platformJobId}.mp4?signature=synthetic-only`;
      const freshUrl = `https://cdn.synthetic.invalid/results/${platformJobId}.mp4?signature=synthetic-refreshed`;
      const input: PromptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: 'Recover the original synthetic prompt with ' },
          {
            type: 'mention',
            mentionId: 'synthetic-reference',
            assetId: 'synthetic-not-uploaded',
            assetVersion: 3,
            mediaType: 'image',
            label: '合成引用',
          },
          { type: 'text', text: ' and neutral lighting.' },
        ],
      };
      const reverseResult = {
        summary: 'synthetic reverse summary',
        prompt: 'Recover the original synthetic reverse prompt.',
      };
      const text =
        kind === 'reversePrompt'
          ? JSON.stringify(reverseResult)
          : createMockPromptOptimizationOutput(input);
      const skill = PROMPT_SKILLS[0]!;
      const snapshot: RunSnapshot = withTestExecutionBindings({
        projectId,
        canvasRevision: 1,
        targetNodeId: nodeId,
        modelAlias,
        credentialId: randomUUID(),
        credentialVersion: 1,
        parameters: {},
        submittedAt: '2026-09-24T00:00:00.000Z',
        nodes:
          kind === 'promptOptimization'
            ? createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' }).nodes
            : [
                {
                  id: nodeId,
                  type: mediaType,
                  position: { x: 0, y: 0 },
                  data: { label: '合成恢复任务', mediaType, mode: 'generate', modelAlias },
                },
              ],
        edges: [],
        inputs: [],
        ...(kind === 'reversePrompt'
          ? {
              reversePrompt: { assetId: 'synthetic-image', assetVersion: 1, automatic: false },
              promptMentions: [
                {
                  nodeId,
                  mentionId: 'synthetic-source',
                  assetId: 'synthetic-image',
                  assetVersion: 1,
                  mediaType: 'image' as const,
                  label: '合成来源',
                  blockOrder: 0,
                },
              ],
            }
          : {}),
        ...(kind === 'promptOptimization'
          ? {
              promptOptimization: {
                nodeId: 'synthetic-canvas-node',
                skillId: skill.id,
                skillVersion: skill.version,
                input,
              },
            }
          : {}),
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
      const originalIdentity = { runId, nodeId, attempt: 1 };
      const stagingIdentity: ResultStagingIdentity = {
        runId,
        userId,
        projectId,
        nodeId,
        snapshotFingerprint: executionSnapshotFingerprint(snapshot),
        requestProviderJobId,
      };
      const usage = { amount: '1.25', currency: 'USD' };
      const reportedUsage = { ...usage, runId: databaseRunId };
      const output: ProviderOutput = video
        ? {
            mediaType: 'video' as const,
            kind: 'url' as const,
            url: outputUrl,
            mimeType: 'video/mp4',
          }
        : {
            mediaType: 'text' as const,
            kind: 'text' as const,
            text,
            mimeType: 'text/plain',
            format: 'txt',
          };
      const asset = {
        assetId: `synthetic-recovered-${randomUUID()}`,
        version: 1,
        mimeType: 'video/mp4',
      };
      const expectedResult = video
        ? { asset }
        : kind === 'reversePrompt'
          ? { reversePrompt: reverseResult }
          : { promptOptimization: { promptDocument: input } };
      let generations = 0;
      let sendClaims = 0;
      let receiptWrites = 0;
      let reconciliations = 0;
      // 只读刷新走真实 Provider 的合同与 HTTP 组装，fetch 明确截获，禁止任何真实网络请求。
      const refreshFetch = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(`https://synthetic.invalid/v1/videos/${platformJobId}`);
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        return new Response(
          JSON.stringify({
            id: platformJobId,
            status: 'completed',
            video: { url: freshUrl },
            usage: { amount: '999', currency: 'USD' },
          }),
          {
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'synthetic-refresh-request',
            },
          },
        );
      });
      const execute = vi.fn(async (request: WorkerProviderRequest): Promise<ProviderExecution> => {
        if (request.resumeOnly) {
          expect(expired).toBe(true);
          expect(request.providerJob).toMatchObject({
            platformJobId,
            payload: { contract: 'newapi-video-v1', requestProviderJobId, reportedUsage },
          });
          expect(request.onRequestPrompt).toBeUndefined();
          expect(request.onProviderJob).toBeUndefined();
          expect(generations).toBe(1);
          expect(sendClaims).toBe(1);
          const refreshed = await new NewApiVideoProvider({
            baseUrl: 'https://synthetic.invalid/v1',
            apiKey: 'synthetic-not-a-real-key',
            videoContract: 'newapi-video-v1',
            fetchImpl: refreshFetch,
            pollIntervalMs: 0,
            maxPollAttempts: 1,
            timeoutMs: 1000,
          }).execute(request);
          // 刷新响应故意携带不同费用，Worker 必须保留原始生成回执而非覆盖计费身份。
          expect(refreshed.usage?.amount).toBe('999');
          return refreshed;
        }
        // 真实发送授权由该回调触发；不允许无回调的合成 Provider 绕过 beginSend。
        expect(request.onRequestPrompt).toBeTypeOf('function');
        await request.onRequestPrompt!({
          schemaVersion: 1,
          runId: request.runId!,
          nodeId,
          attempt: request.attempt!,
          requestIdentity,
          provider: 'newapi',
          modelAlias,
          mediaType,
          format: 'plain',
          parts: [{ order: 0, text: 'Generate one synthetic recovery response.' }],
          resources: [],
          sendStatus: 'pending',
          createdAt: '2026-09-24T00:00:00.000Z',
        });
        expect(sendClaims).toBe(1);
        generations++;
        return {
          result: {
            provider: 'newapi',
            targetNodeId: nodeId,
            mediaType,
            summary: 'synthetic',
            inputCount: 0,
          },
          providerJob: {
            provider: 'newapi',
            ...(video ? { platformJobId } : {}),
            payload: {
              requestId: providerRequestId,
              ...(video ? { contract: 'newapi-video-v1', phase: 'completed' } : {}),
            },
          },
          output,
          usage,
        };
      });
      const archiveInputs: Parameters<ResultAssetArchiver>[0][] = [];
      const resultArchiver = vi.fn<ResultAssetArchiver>(async (archive) => {
        if (!video) throw new Error('独立结果不允许调用媒体归档器');
        archiveInputs.push(archive);
        const refreshed = expired && archiveInputs.length === 3;
        expect(archive.output).toEqual(
          refreshed ? { ...output, url: freshUrl, format: 'mp4' } : output,
        );
        expect(archive.archiveInput).toMatchObject({
          contentUrl: refreshed ? freshUrl : outputUrl,
          mediaType: 'video',
        });
        expect(archive.providerJob).toMatchObject({
          platformJobId,
          payload: { contract: 'newapi-video-v1', requestProviderJobId },
        });
        if (archiveInputs.length === 1) throw new Error('synthetic video archive interruption');
        if (expired && archiveInputs.length === 2) throw new ResultUrlUnavailableError(403);
        return asset;
      });
      const firstPersistence = new SyntheticPersistence(prisma, stagingSecret);
      firstPersistence.failReceivedReceipt = !video;

      /** 新实例不复用进程内恢复状态；授权、发送和回执补记均使用真实 Prisma 服务。 */
      function optionsFor(
        client: PrismaClient,
        persistence: SyntheticPersistence,
      ): Parameters<typeof createRunWorker>[0] {
        const service = new PrismaExecutionService(client);
        const execution: WorkerExecutionAuthorization = {
          async authorizeRun(id, frozen, owner) {
            const authorized = await service.requireAuthorization(id, frozen);
            if (authorized.userId !== owner) throw new Error('合成请求归属不一致');
          },
          // 只替代实时上游权限复核；冻结授权仍必须从真实 DB 读取并验证。
          async authorizeNode(id, _node, frozen) {
            await service.requireAuthorization(id, frozen);
          },
          async beginSend(value) {
            sendClaims++;
            await service.beginSend(value);
          },
          async finishSend(value) {
            receiptWrites++;
            await service.finishSend(value);
          },
          async reconcileReceived(value) {
            reconciliations++;
            expect(value).toMatchObject({
              ...originalIdentity,
              requestIdentity: requestProviderJobId,
            });
            await service.reconcileReceived(value);
          },
          async assertRetrySafe(value) {
            await service.assertRetrySafe(value);
          },
        };
        return {
          connection: { host: '127.0.0.1', port: 16389 },
          queueName,
          stepDelayMs: 0,
          providerName: 'newapi',
          execution,
          persistence,
          resolveDatabaseRunId: executionDatabaseRunId,
          onPersistenceError(error) {
            throw error;
          },
          resultStagingKeyring: new CredentialEncryptionKeyring({ currentSecret: stagingSecret }),
          provider: { execute },
          resultArchiver,
        };
      }

      let first: RunWorker | undefined;
      let second: RunWorker | undefined;
      try {
        await prisma.user.create({
          data: { id: userId, displayName: 'synthetic non-audio recovery' },
        });
        await prisma.project.create({
          data: { id: projectId, ownerId: userId, name: 'synthetic non-audio recovery' },
        });
        // 不建立真实密钥、账户或上游授权，只插入本任务的冻结事实。
        await prisma.$transaction([
          prisma.run.create({
            data: {
              id: databaseRunId,
              userId,
              projectId,
              status: 'QUEUED',
              modelAlias,
              attempt: 1,
              snapshot: snapshot as Prisma.InputJsonValue,
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
        first = createRunWorker(optionsFor(prisma, firstPersistence));
        await first.worker.waitUntilReady();
        await first.queue.add('run', data, { jobId: runId, attempts: 1 });
        await waitForState(first, runId, 'failed');
        const failed = await first.queue.getJob(runId);
        expect(failed?.failedReason).toContain(
          video
            ? 'synthetic video archive interruption'
            : 'synthetic independent receipt interruption',
        );
        expect(execute).toHaveBeenCalledOnce();
        expect(generations).toBe(1);
        expect(refreshFetch).not.toHaveBeenCalled();
        expect(sendClaims).toBe(1);
        expect(receiptWrites).toBe(1);
        expect(resultArchiver).toHaveBeenCalledTimes(video ? 1 : 0);
        expect(firstPersistence.failReceivedReceipt).toBe(false);
        const failedRun = await prisma.run.findUniqueOrThrow({ where: { id: databaseRunId } });
        expect(failedRun.status).toBe('FAILED');
        expect(failedRun.error).toBeTruthy();
        const failedTiming = parseStoredNodeTimings(failedRun.nodeTimings)[nodeId]!;
        expect(failedTiming).toMatchObject({
          outcome: 'failed',
          startedAt: expect.any(String),
          requestStartedAt: expect.any(String),
        });
        const originalSend = await prisma.runSendIntent.findUniqueOrThrow({
          where: { runId_nodeId_attempt: originalIdentity },
        });
        expect(originalSend).toMatchObject({
          status: 'sent',
          requestIdentity: requestProviderJobId,
          ...(video ? { platformJobId } : {}),
        });
        const originalPrompts = await prisma.runRequestPrompt.findMany({
          where: { runId: databaseRunId },
        });
        expect(originalPrompts).toHaveLength(1);
        expect(originalPrompts[0]).toMatchObject({
          requestRunId: runId,
          nodeId,
          attempt: 1,
          requestIdentity,
        });
        const originalProviders = await prisma.providerJob.findMany({
          where: { runId: databaseRunId },
        });
        expect(originalProviders).toHaveLength(1);
        expect(originalProviders[0]?.payload).toMatchObject({
          deliveryState: 'received',
          requestProviderJobId,
          reportedUsage,
          usageStatus: 'external',
        });
        if (video) {
          expect(snapshot.executionBindings?.[nodeId]?.contract).toBe('newapi-video-v1');
          expect(originalProviders[0]).toMatchObject({
            platformJobId,
            payload: { contract: 'newapi-video-v1' },
          });
        }
        const keys = await stagingKeys(first, queueName);
        expect(keys).toHaveLength(1);
        const redis = await first.queue.client;
        const ciphertext = await redis.get(keys[0]!);
        expect(ciphertext).toBeTruthy();
        expect(ciphertext).not.toContain(video ? outputUrl : text);
        expect(ciphertext).not.toContain('original synthetic');
        const staging = createRedisResultStagingStore({
          namespace: queueName,
          keyring: new CredentialEncryptionKeyring({ currentSecret: stagingSecret }),
          client: createResultStagingRedisAdapter(first.queue.client),
        });
        const staged = await staging.load(stagingIdentity);
        expect(staged?.output).toEqual(output);
        expect(staged?.usage).toEqual(usage);
        expect(staged?.providerJob?.payload).toMatchObject({
          requestProviderJobId,
          resultStagingRunId: runId,
          resultStagingAttempt: 1,
        });
        // 关闭第一个 Worker 后创建新连接与暂存实例，禁止用同一 processor 重放代替重启。
        await first.worker.close();
        second = createRunWorker(
          optionsFor(restartedPrisma, new SyntheticPersistence(restartedPrisma, stagingSecret)),
        );
        expect(second.worker).not.toBe(first.worker);
        await second.worker.waitUntilReady();
        const pending = await second.queue.getJob(runId);
        expect(pending).toBeDefined();
        await pending!.retry();
        await waitForState(second, runId, 'completed');
        const recovered = await second.queue.getJob(runId);
        expect(recovered?.returnvalue).toMatchObject({
          status: 'succeeded',
          result: expectedResult,
        });
        expect(execute).toHaveBeenCalledTimes(expired ? 2 : 1);
        expect(generations).toBe(1);
        expect(sendClaims).toBe(1);
        expect(receiptWrites).toBe(1);
        expect(reconciliations).toBe(1);
        expect(resultArchiver).toHaveBeenCalledTimes(expired ? 3 : video ? 2 : 0);
        expect(refreshFetch).toHaveBeenCalledTimes(expired ? 1 : 0);
        if (expired) {
          expect(refreshFetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual(
            [[`https://synthetic.invalid/v1/videos/${platformJobId}`, 'GET']],
          );
          expect(execute.mock.calls[1]?.[0].resumeOnly).toBe(true);
          expect(archiveInputs.map((archive) => archive.archiveInput?.contentUrl)).toEqual([
            outputUrl,
            outputUrl,
            freshUrl,
          ]);
        }
        if (video) {
          expect(archiveInputs[0]?.archiveKey).toEqual(expect.any(String));
          for (const archive of archiveInputs)
            expect(archive.archiveKey).toBe(archiveInputs[0]!.archiveKey);
        }
        expect(recovered?.data.providerJob?.payload?.requestPromptRecords).toEqual(
          failed?.data.providerJob?.payload?.requestPromptRecords,
        );
        const recoveredRun = await restartedPrisma.run.findUniqueOrThrow({
          where: { id: databaseRunId },
        });
        expect(recoveredRun).toMatchObject({
          status: 'SUCCEEDED',
          error: null,
          attempt: 1,
          result: expectedResult,
        });
        expect(parseStoredNodeTimings(recoveredRun.nodeTimings)[nodeId]).toMatchObject({
          outcome: 'succeeded',
          startedAt: failedTiming.startedAt,
          requestStartedAt: failedTiming.requestStartedAt,
          finishedAt: expect.any(String),
        });
        const providers = await restartedPrisma.providerJob.findMany({
          where: { runId: databaseRunId },
        });
        expect(providers).toHaveLength(1);
        expect(providers[0]).toMatchObject({
          id: originalProviders[0]!.id,
          status: 'succeeded',
          payload: {
            deliveryState: 'archived',
            requestProviderJobId,
            requestId: providerRequestId,
            reportedUsage,
            usageStatus: 'external',
          },
        });
        if (video)
          expect(providers[0]).toMatchObject({
            platformJobId,
            payload: {
              contract: 'newapi-video-v1',
              firstArchiveError: 'synthetic video archive interruption',
            },
          });
        else {
          expect(recovered?.returnvalue.result?.asset).toBeUndefined();
          expect(recoveredRun.result).not.toHaveProperty('asset');
        }
        expect(recovered?.data.providerJob?.payload).toMatchObject({
          requestProviderJobId,
          reportedUsage,
          usageStatus: 'external',
        });
        expect(await restartedPrisma.runSendIntent.findMany({ where: { runId } })).toEqual([
          originalSend,
        ]);
        const prompts = await restartedPrisma.runRequestPrompt.findMany({
          where: { runId: databaseRunId },
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          id: originalPrompts[0]!.id,
          requestRunId: runId,
          nodeId,
          attempt: 1,
          requestIdentity,
          parts: originalPrompts[0]!.parts,
          ...(video
            ? { assetId: asset.assetId, assetVersion: 1 }
            : { assetId: null, assetVersion: null }),
        });
        expect(await restartedPrisma.usageLedger.count({ where: { runId: databaseRunId } })).toBe(
          0,
        );
        expect(await stagingKeys(second, queueName)).toEqual([]);
        await expect(
          new PrismaExecutionService(restartedPrisma).assertRetrySafe({
            runId,
            nodeId,
            snapshot,
            userId,
          }),
        ).rejects.toMatchObject({ code: 'send_requires_review' });
      } finally {
        await first?.worker.close();
        await second?.worker.close();
        const cleanup = second ?? first;
        if (cleanup) {
          const redis = await cleanup.queue.client;
          for (const key of await stagingKeys(cleanup, queueName)) await redis.del(key);
          await cleanup.queue.obliterate({ force: true });
        }
        await first?.queue.close();
        await second?.queue.close();
        await prisma.runSendIntent.deleteMany({ where: { runId } });
        await prisma.runOutbox.deleteMany({ where: { runId } });
        await prisma.executionAuthorization.deleteMany({ where: { runId } });
        await prisma.usageLedger.deleteMany({ where: { runId: databaseRunId } });
        await prisma.project.deleteMany({ where: { id: projectId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.$disconnect();
        await restartedPrisma.$disconnect();
      }
    },
    30_000,
  );
});

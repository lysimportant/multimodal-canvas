import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient, type Prisma } from '@prisma/client';
import { QueueEvents, type Queue, type Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaBillingService } from '@multimodal-canvas/billing';
import {
  calculateBillingQuote,
  type RunJobData,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { PrismaWorkerBilling } from './billing-execution';
import { createRunWorker, createProviderJobRecord, type WorkerProviderRequest } from './index';
import { WorkerPrismaRunPersistence, databaseRunId } from './prisma-persistence';
import { WorkerFileBlobStore, PrismaResultAssetArchiver } from './result-archiver';

/** 仅使用显式隔离 PostgreSQL 与 Redis DB 15，不从应用连接回退。 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const redisUrl = process.env.TEST_REDIS_URL?.trim();
if (databaseUrl || redisUrl) {
  if (!databaseUrl || !redisUrl)
    throw new Error('Worker 账务验收需同时配置 TEST_DATABASE_URL 与 TEST_REDIS_URL');
  const db = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true' ||
    !['127.0.0.1', 'localhost'].includes(db.hostname) ||
    !db.pathname.endsWith('_test') ||
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error('Worker 验收只允许已确认隔离的本机 _test 数据库与 Redis DB 15');
}

/** 所有记录保留在随机 schema，供跨进程运行与钱包流水核对。 */
describe.skipIf(!databaseUrl || !redisUrl)('Worker 实际 BullMQ 重试与人民币结算', () => {
  const namespace = `billing_worker_test_${randomUUID().replaceAll('-', '')}`;
  const workspace = fileURLToPath(new URL('../../../', import.meta.url));
  const archiveDirectory = fileURLToPath(
    new URL(`../../../.data/billing-worker-integration/${namespace}/`, import.meta.url),
  );
  let prisma: PrismaClient;
  const resources: Array<{ queue: Queue; worker: Worker; events: QueueEvents }> = [];
  const reports: unknown[] = [];

  beforeAll(async () => {
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set('schema', namespace);
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url)),
        'db',
        'push',
        '--schema',
        fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url)),
        '--skip-generate',
      ],
      {
        cwd: workspace,
        env: { ...process.env, DATABASE_URL: scoped.toString() },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: scoped.toString() } } });
    await prisma.$connect();
    await mkdir(archiveDirectory, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    for (const resource of resources) {
      await resource.worker.close();
      await resource.events.close();
      // 随机命名队列仅由本文件创建，保留数据库和产物，不清理共享 Redis。
      await resource.queue.obliterate();
      await resource.queue.close();
    }
    if (prisma) {
      await writeFile(
        `${archiveDirectory}/report.json`,
        JSON.stringify({ namespace, reports }, null, 2),
      );
      await prisma.$disconnect();
    }
    vi.restoreAllMocks();
  }, 30_000);

  /** 真实钱包冻结和 Run/outbox 共用事务；Provider 仅在内存返回合成文字。 */
  async function fixture(managed = false) {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
    const project = await prisma.project.create({
      data: { ownerId: user.id, name: 'Worker 隔离重试' },
    });
    const service = new PrismaBillingService(prisma);
    await service.adjust({
      userId: user.id,
      actorId: user.id,
      amountNanos: '1000',
      reason: '隔离测试额度',
      idempotencyKey: randomUUID(),
    });
    const binding = {
      platformModelId: randomUUID(),
      bindingId: randomUUID(),
      pricingVersionId: randomUUID(),
      contract: 'openai-chat-completions',
    };
    const snapshot: RunSnapshot = {
      projectId: project.id,
      canvasRevision: 1,
      targetNodeId: 'node',
      modelAlias: 'mock-text',
      ...(managed ? { credentialId: randomUUID(), credentialVersion: 1 } : {}),
      parameters: {},
      submittedAt: new Date().toISOString(),
      inputs: [],
      edges: [],
      nodes: [
        {
          id: 'node',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            mediaType: 'text',
            mode: 'generate',
            label: '验收文本',
            prompt: 'Synthetic output',
          },
        },
      ],
      billingBindings: { node: binding },
    };
    const calculation = managed
      ? {
          version: 2,
          currency: 'CNY',
          rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
          quantity: 1,
          capNanos: '120',
          estimate: {
            version: 1,
            model: 'mock-text',
            group: 'test-group',
            pricing_version: 'synthetic-price',
            estimated_quota: '60',
            quota_per_unit: '500000000',
            usd_to_cny: '1',
            expires_at: new Date(Date.now() + 300000).toISOString(),
            estimate_only: true,
          },
        }
      : calculateBillingQuote({
          rule: { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: '120' },
        });
    const quote = await service.createQuote({
      payerId: user.id,
      snapshot,
      items: [
        {
          nodeId: 'node',
          ...binding,
          maximumNanos: '120',
          pricingRule: calculation.rule,
          quoteInput: calculation,
        },
      ],
    });
    const runId = `run_${randomUUID()}`;
    const queueName = `worker-billing-test-${randomUUID()}`;
    const payload: RunJobData = {
      runId,
      snapshot,
      attempt: 1,
      provider: 'mock',
      providerJob: createProviderJobRecord(runId, 'mock'),
      cancelRequested: false,
      userId: user.id,
    };
    await service.commitSubmission(
      {
        payerId: user.id,
        quoteId: quote.id,
        runId,
        snapshot,
        payload: payload as unknown as Prisma.InputJsonValue,
        queueName,
      },
      async (tx) =>
        tx.run.create({
          data: {
            id: databaseRunId(runId),
            projectId: project.id,
            userId: user.id,
            status: 'QUEUED',
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
        }),
    );
    const persistence = new WorkerPrismaRunPersistence(prisma);
    const receiptFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        version: 1,
        request_id: 'synthetic-newapi-original',
        model: 'mock-text',
        group: 'actual-group',
        status: 'settled',
        quota: '30',
        quota_per_unit: '500000000',
        settled_at: new Date().toISOString(),
      }),
    );
    const billing = new PrismaWorkerBilling(
      service,
      managed
        ? {
            fetchImpl: receiptFetch,
            getProviderCredentials: async () => ({
              baseUrl: 'https://synthetic.invalid/v1',
              apiKey: 'synthetic-unused',
            }),
          }
        : {},
    );
    const archiver = new PrismaResultAssetArchiver(prisma, {
      blobStore: new WorkerFileBlobStore(archiveDirectory),
      keyPrefix: runId,
    });
    const execute = vi.fn(async (request: WorkerProviderRequest) => ({
      result: {
        provider: 'mock',
        targetNodeId: request.snapshot.targetNodeId,
        mediaType: 'text' as const,
        summary: 'synthetic delivery',
        inputCount: 0,
      },
      output: {
        kind: 'text' as const,
        mediaType: 'text' as const,
        mimeType: 'text/plain',
        text: 'Synthetic delivered result',
      },
      usage: { amount: '0.00001', currency: 'USD' },
      ...(managed
        ? {
            providerJob: {
              provider: 'mock',
              payload: { newApiRequestId: 'synthetic-newapi-original' },
            },
          }
        : {}),
    }));
    const redis = new URL(redisUrl!);
    const connection = { host: redis.hostname, port: Number(redis.port), db: 15 };
    /** 启动随机实际队列；重试由 BullMQ 调度，不手动调用 processor。 */
    const start = async (builtin = false) => {
      const created = createRunWorker({
        connection,
        queueName,
        providerName: 'mock',
        ...(builtin ? {} : { provider: { execute } }),
        persistence,
        billing,
        requireBilling: true,
        stepDelayMs: 0,
        resolveDatabaseRunId: databaseRunId,
        resultArchiver: archiver.archive.bind(archiver),
      });
      const events = new QueueEvents(queueName, { connection });
      resources.push({ ...created, events });
      await events.waitUntilReady();
      const job = await created.queue.add('run', payload, {
        jobId: runId,
        attempts: 3,
        backoff: { type: 'fixed', delay: 20 },
      });
      return { ...created, job, events };
    };
    return {
      runId,
      user,
      project,
      snapshot,
      payload,
      service,
      billing,
      persistence,
      archiver,
      execute,
      receiptFetch,
      start,
    };
  }

  it('托管回执延迟后由原队列恢复，真实钱包按最终金额结算且不重复生成', async () => {
    const f = await fixture(true);
    f.receiptFetch.mockResolvedValueOnce(
      Response.json({
        version: 1,
        request_id: 'synthetic-newapi-original',
        model: 'mock-text',
        group: 'actual-group',
        status: 'pending',
        quota: '0',
        quota_per_unit: '500000000',
      }),
    );
    const { job, events } = await f.start();
    const delivered = await job.waitUntilFinished(events, 20_000);
    expect(delivered.status).toBe('succeeded');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.receiptFetch).toHaveBeenCalledTimes(2);
    expect(
      f.receiptFetch.mock.calls.every((call) =>
        String(call[0]).endsWith('/receipts/synthetic-newapi-original'),
      ),
    ).toBe(true);
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '940',
      heldNanos: '0',
    });
    expect(
      await prisma.walletEntry.count({
        where: { wallet: { userId: f.user.id }, kind: 'settlement' },
      }),
    ).toBe(1);
    const charged = await prisma.chargeItem.findFirstOrThrow({
      where: { charge: { runId: f.runId } },
    });
    expect(charged.deliveryEvidence).toMatchObject({
      newApiReceipt: { status: 'settled', quota: '30' },
      conversion: { quotaPerUnit: '500000000', usdToCny: '1' },
    });
    expect(
      (
        await prisma.providerCost.findUniqueOrThrow({ where: { chargeItemId: charged.id } })
      ).amount?.toFixed(12),
    ).toBe('0.000000060000');
    reports.push({
      runId: f.runId,
      scenario: 'newapi-receipt-recovery',
      providerCalls: 1,
      receiptReads: 2,
    });
  }, 30_000);

  it.each(['cancel', 'archive'] as const)(
    '托管 %s 后只读原回执记成本，钱包保留未知且不重新生成',
    async (scenario) => {
      const f = await fixture(true);
      const original = f.execute.getMockImplementation()!;
      if (scenario === 'archive')
        vi.spyOn(f.archiver, 'archive').mockRejectedValue(
          new Error('synthetic managed archive outage'),
        );
      else
        f.execute.mockImplementation(async (request) => {
          const execution = await original(request);
          await prisma.runOutbox.update({
            where: { runId: f.runId },
            data: {
              payload: { ...f.payload, cancelRequested: true } as unknown as Prisma.InputJsonValue,
            },
          });
          return execution;
        });
      const { job, events } = await f.start();
      if (scenario === 'archive')
        await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow('禁止重新生成');
      else
        await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
          status: 'cancelled',
        });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.receiptFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(
        f.receiptFetch.mock.calls.every((call) =>
          String(call[0]).endsWith('/receipts/synthetic-newapi-original'),
        ),
      ).toBe(true);
      const item = await prisma.chargeItem.findFirstOrThrow({
        where: { charge: { runId: f.runId } },
        include: { providerCost: true },
      });
      expect(item.status).toBe('PENDING_VERIFICATION');
      expect(item.deliveryEvidence).toBeNull();
      expect(item.providerCost?.status).toBe('confirmed');
      expect(item.providerCost?.amount?.toFixed(12)).toBe('0.000000060000');
      expect(
        await prisma.walletEntry.count({ where: { runId: f.runId, kind: 'settlement' } }),
      ).toBe(0);
      expect(await f.service.getWallet(f.user.id)).toMatchObject({
        availableNanos: '880',
        heldNanos: '120',
      });
      reports.push({
        runId: f.runId,
        scenario: `newapi-received-${scenario}`,
        providerCalls: 1,
        receiptReads: f.receiptFetch.mock.calls.length,
      });
    },
    30_000,
  );

  it('内置 Mock 文字真实归档、落库及钱包结算', async () => {
    const f = await fixture();
    const { job, events } = await f.start(true);
    const result = await job.waitUntilFinished(events, 20_000);
    expect(result).toMatchObject({
      status: 'succeeded',
      result: { simulated: true, asset: { version: 1 } },
    });
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '880',
      heldNanos: '0',
    });
    const asset = await prisma.assetVersion.findFirst({
      where: { assetId: result.result.asset.assetId },
    });
    expect(asset?.sizeBytes).toBeGreaterThan(0);
    reports.push({ runId: f.runId, scenario: 'builtin-mock', assetId: asset?.assetId });
  }, 30_000);

  it.each(['cancel', 'archive', 'cost-recovery', 'usage-recovery'] as const)(
    '%s 保留未交付响应的明确成本，补账不重发或结算用户',
    async (scenario) => {
      const f = await fixture();
      const original = f.execute.getMockImplementation()!;
      if (scenario === 'archive')
        vi.spyOn(f.archiver, 'archive').mockRejectedValue(new Error('synthetic archive outage'));
      else
        f.execute.mockImplementation(async (request) => {
          const execution = await original(request);
          await prisma.runOutbox.update({
            where: { runId: f.runId },
            data: {
              payload: { ...f.payload, cancelRequested: true } as unknown as Prisma.InputJsonValue,
            },
          });
          return execution;
        });
      if (scenario === 'cost-recovery') {
        const recordCost = f.service.recordCost.bind(f.service);
        vi.spyOn(f.service, 'recordCost')
          .mockRejectedValueOnce(new Error('synthetic received cost outage'))
          .mockImplementation(recordCost);
      } else if (scenario === 'usage-recovery') {
        const recordUsage = f.persistence.recordUsage.bind(f.persistence);
        vi.spyOn(f.persistence, 'recordUsage')
          .mockRejectedValueOnce(new Error('synthetic received usage outage'))
          .mockImplementation(recordUsage);
      }
      const { job, events, queue } = await f.start();
      if (scenario === 'archive')
        await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow('禁止重新生成');
      else
        await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
          status: 'cancelled',
        });
      expect(f.execute).toHaveBeenCalledOnce();
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(
        scenario === 'archive' ? 3 : scenario === 'cancel' ? 1 : 2,
      );
      const item = await prisma.chargeItem.findFirstOrThrow({
        where: { charge: { runId: f.runId } },
        include: { providerCost: true },
      });
      expect(item.status).toBe('PENDING_VERIFICATION');
      expect(item.providerCost?.status).toBe('confirmed');
      expect(item.providerCost?.amount?.toFixed()).toBe('0.00001');
      expect(item.providerCost?.currency).toBe('USD');
      expect(item.deliveryEvidence).toBeNull();
      expect(
        await prisma.walletEntry.count({ where: { runId: f.runId, kind: 'settlement' } }),
      ).toBe(0);
      expect(await prisma.usageLedger.count({ where: { runId: databaseRunId(f.runId) } })).toBe(1);
      expect(await f.service.getWallet(f.user.id)).toMatchObject({
        availableNanos: '880',
        heldNanos: '120',
      });
      reports.push({ runId: f.runId, scenario: `received-${scenario}`, providerCalls: 1 });
    },
    30_000,
  );

  it('十二位小数成本原样落入 ProviderCost，旧 usage 精度不足不阻断交付', async () => {
    const f = await fixture();
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (request) => ({
      ...(await original(request)),
      usage: { amount: '0.000000000123', currency: 'USD' },
    }));
    const { job, events } = await f.start();
    await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
      status: 'succeeded',
    });
    const item = await prisma.chargeItem.findFirstOrThrow({
      where: { charge: { runId: f.runId } },
      include: { providerCost: true },
    });
    expect(item.status).toBe('SETTLED');
    expect(item.providerCost?.amount?.toFixed()).toBe('0.000000000123');
    expect(item.providerCost?.currency).toBe('USD');
    expect(await prisma.usageLedger.count({ where: { runId: databaseRunId(f.runId) } })).toBe(0);
    const persisted = await f.persistence.findProviderJobsByRunId(f.runId);
    expect(persisted[0]?.payload).toMatchObject({
      reportedUsage: { amount: '0.000000000123', currency: 'USD' },
      usageStatus: 'legacy_unrepresentable',
      usageReason: expect.stringContaining('Decimal(18,6)'),
    });
    expect(f.execute).toHaveBeenCalledOnce();
    reports.push({
      runId: f.runId,
      scenario: 'precise-cost-legacy-ledger-unrepresentable',
      providerCalls: 1,
    });
  }, 30_000);

  it.each(['settlement', 'cost', 'usage'] as const)(
    '%s 故障由 BullMQ 自动恢复一次，原 Provider 只调用一次',
    async (failure) => {
      const f = await fixture();
      if (failure === 'settlement') {
        const original = f.billing.deliver.bind(f.billing);
        vi.spyOn(f.billing, 'deliver')
          .mockRejectedValueOnce(new Error('synthetic settlement outage'))
          .mockImplementation(original);
      } else if (failure === 'cost') {
        const original = f.service.recordCost.bind(f.service);
        vi.spyOn(f.service, 'recordCost')
          .mockRejectedValueOnce(new Error('synthetic provider cost outage'))
          .mockImplementation(original);
      } else {
        const original = f.persistence.recordUsage.bind(f.persistence);
        vi.spyOn(f.persistence, 'recordUsage')
          .mockRejectedValueOnce(new Error('synthetic usage outage'))
          .mockImplementation(original);
      }
      const { job, events, queue } = await f.start();
      await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(f.execute).toHaveBeenCalledOnce();
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(2);
      expect(await f.service.getWallet(f.user.id)).toMatchObject({
        availableNanos: '880',
        heldNanos: '0',
      });
      expect(
        await prisma.walletEntry.count({ where: { runId: f.runId, kind: 'settlement' } }),
      ).toBe(1);
      reports.push({
        runId: f.runId,
        scenario: `${failure}-automatic-recovery`,
        providerCalls: f.execute.mock.calls.length,
      });
    },
    30_000,
  );

  it('三次账务失败保留冻结与交付证据，同 Run 人工重试只修账并关闭待核实', async () => {
    const f = await fixture();
    const original = f.billing.deliver.bind(f.billing);
    const delivery = vi
      .spyOn(f.billing, 'deliver')
      .mockRejectedValue(new Error('synthetic settlement outage'));
    const { job, events, queue } = await f.start();
    await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow(
      'synthetic settlement outage',
    );
    expect((await queue.getJob(job.id!))!.attemptsMade).toBe(3);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '880',
      heldNanos: '120',
    });
    const item = await prisma.chargeItem.findFirstOrThrow({
      where: { charge: { runId: f.runId } },
    });
    expect(item.status).toBe('PENDING_VERIFICATION');
    expect(item.deliveryEvidence).toMatchObject({ deliveryState: 'archived', nodeId: 'node' });
    expect(
      await prisma.reconciliationItem.findUnique({
        where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'worker_recovery' } },
      }),
    ).toMatchObject({ status: 'open' });
    delivery.mockImplementation(original);
    const failedJob = (await queue.getJob(job.id!))!;
    // 模拟队列恢复到最初 payload，归档身份只能从数据库找回。
    await failedJob.updateData(f.payload);
    await failedJob.retry('failed');
    await expect(failedJob.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await prisma.walletEntry.count({ where: { runId: f.runId, kind: 'settlement' } })).toBe(
      1,
    );
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '880',
      heldNanos: '0',
    });
    expect(
      await prisma.reconciliationItem.findUnique({
        where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'worker_recovery' } },
      }),
    ).toMatchObject({ status: 'resolved' });
    reports.push({
      runId: f.runId,
      scenario: 'exhausted-then-same-run-repair',
      recoverySource: 'persisted-provider-job',
      providerCalls: f.execute.mock.calls.length,
    });
  }, 30_000);

  it('归档后结算故障与持久取消交错时，先自动补账再取消且不重发', async () => {
    const f = await fixture();
    const original = f.billing.deliver.bind(f.billing);
    vi.spyOn(f.billing, 'deliver')
      .mockImplementationOnce(async () => {
        await prisma.runOutbox.update({
          where: { runId: f.runId },
          data: {
            payload: { ...f.payload, cancelRequested: true } as unknown as Prisma.InputJsonValue,
          },
        });
        throw new Error('synthetic settlement outage with cancellation');
      })
      .mockImplementation(original);
    const { job, events, queue } = await f.start();
    await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect((await queue.getJob(job.id!))!.attemptsMade).toBe(2);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '880',
      heldNanos: '0',
    });
    expect(await prisma.walletEntry.count({ where: { runId: f.runId, kind: 'settlement' } })).toBe(
      1,
    );
    reports.push({
      runId: f.runId,
      scenario: 'archived-accounting-with-durable-cancellation',
      providerCalls: f.execute.mock.calls.length,
    });
  }, 30_000);

  it('持久取消意图阻止迟到队列发请求且释放未发送冻结', async () => {
    const f = await fixture();
    await prisma.runOutbox.update({
      where: { runId: f.runId },
      data: {
        payload: { ...f.payload, cancelRequested: true } as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.run.update({
      where: { id: databaseRunId(f.runId) },
      data: { status: 'PROCESSING' },
    });
    const { job, events } = await f.start();
    await expect(job.waitUntilFinished(events, 20_000)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.service.getWallet(f.user.id)).toMatchObject({
      availableNanos: '1000',
      heldNanos: '0',
    });
    reports.push({ runId: f.runId, scenario: 'durable-cancel-before-delivery', providerCalls: 0 });
  }, 30_000);
});

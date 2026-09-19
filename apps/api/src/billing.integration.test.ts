import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { PrismaBillingService } from '@multimodal-canvas/billing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { AuthService } from './auth-service';
import { PrismaAuthStore } from './auth-store';
import { PrismaModelMarketplace } from './model-marketplace';
import { PrismaProjectStore } from './projects';
import { PrismaRunPersistence, databaseRunId } from './run-persistence';
import { BullMqRunService, redisConnectionFromUrl } from './runs';
import { PrismaAiSettingsStore } from './settings';

/** 未配置专用 TEST 连接时跳过；禁止读取 DATABASE_URL 或应用 Redis 作为后备。 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const redisUrl = process.env.TEST_REDIS_URL?.trim();
if (databaseUrl || redisUrl) {
  if (!databaseUrl || !redisUrl)
    throw new Error('账务集成验收必须同时提供 TEST_DATABASE_URL 与 TEST_REDIS_URL');
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  if (
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true' ||
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !database.pathname.endsWith('_test') ||
    !['127.0.0.1', 'localhost'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error('账务验收仅接受已确认隔离的本机 _test 数据库和 Redis DB 15');
  if (process.env.DATABASE_URL) {
    const application = new URL(process.env.DATABASE_URL);
    if (application.host === database.host && application.pathname === database.pathname)
      throw new Error('账务验收数据库不得与应用数据库相同');
  }
}

/** 独立 schema 防止 outbox 派发器读取其他验收留下的未投递项。 */
const integrationDescribe = databaseUrl && redisUrl ? describe : describe.skip;
integrationDescribe('人民币报价、钱包及 outbox（隔离 PostgreSQL + Redis）', () => {
  const namespace = `billing_api_test_${randomUUID().replaceAll('-', '')}`;
  const queueName = `billing-api-test-${randomUUID()}`;
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const prismaCli = fileURLToPath(
    new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
  );
  const prismaSchema = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
  const execFileAsync = promisify(execFile);
  let prisma: PrismaClient;
  let queue: Queue;
  let service: BullMqRunService;
  let billing: PrismaBillingService;
  let settings: PrismaAiSettingsStore;
  let marketplace: PrismaModelMarketplace;
  let projects: PrismaProjectStore;
  let authStore: PrismaAuthStore;
  let auth: AuthService;
  let app: ReturnType<typeof buildApp>;
  let adminId: string;
  let adminHeaders: { authorization: string };
  let credentialId: string;
  let credentialVersion: number;
  const createdProjects: string[] = [];
  const createdRuns: string[] = [];
  const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/models') && (!init?.method || init.method === 'GET'))
      return new Response(
        JSON.stringify({
          data: [{ id: 'candidate-only', name: '供应商候选名称', mediaTypes: ['text'] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    throw new Error('账务验收禁止真实 Provider 请求');
  });

  beforeAll(async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-billing-integration-secret');
    vi.stubEnv('API_AUTH_TOKEN', 'synthetic-billing-service-token');
    vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '');
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set('schema', namespace);
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
    authStore = new PrismaAuthStore(prisma);
    auth = new AuthService({ store: authStore, jwtSecret: process.env.API_JWT_SECRET! });
    const admin = await authStore.createUser({
      email: `${namespace}-admin@example.invalid`,
      passwordHash: 'synthetic-unused-password-hash',
      role: 'admin',
      status: 'active',
    });
    adminId = admin.id;
    adminHeaders = { authorization: `Bearer ${(await auth.issueToken(admin)).accessToken}` };
    settings = new PrismaAiSettingsStore(prisma, 'synthetic-billing-integration-encryption', {
      fetchImpl: providerFetch,
    });
    const connection = await settings.update({
      baseUrl: 'https://billing-fixture.invalid/v1',
      apiKey: 'synthetic-provider-key-only',
      activate: false,
    });
    credentialId = connection.createdCredentialId!;
    credentialVersion = (await settings.getCredentialReference(credentialId)).credentialVersion!;
    marketplace = new PrismaModelMarketplace(prisma, settings);
    billing = new PrismaBillingService(prisma);
    projects = new PrismaProjectStore(prisma);
    const persistence = new PrismaRunPersistence(prisma);
    const redis = redisConnectionFromUrl(redisUrl!);
    queue = new Queue(queueName, { connection: redis });
    service = new BullMqRunService({
      connection: redis,
      queueName,
      providerName: 'mock',
      billing,
      persistence,
    });
    app = buildApp({
      logger: false,
      authStore,
      authService: auth,
      settingsStore: settings,
      projectStore: projects,
      runService: service,
      runPersistence: persistence,
      billing,
      marketplace,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await service?.close();
    if (queue) {
      // 此随机队列只供本文件使用且没有 Worker；不执行 FLUSHDB 或清理其他队列。
      await queue.obliterate();
      await queue.close();
    }
    if (prisma) {
      const reportDirectory = fileURLToPath(
        new URL('../../../.data/billing-integration/', import.meta.url),
      );
      await mkdir(reportDirectory, { recursive: true });
      await writeFile(
        `${reportDirectory}/${namespace}.json`,
        JSON.stringify(
          {
            schema: namespace,
            queueName,
            adminId,
            createdProjects,
            createdRuns,
            recordedAt: new Date().toISOString(),
            note: '合成账务记录保留；随机队列已关闭并清理。未执行真实生成。',
          },
          null,
          2,
        ),
        'utf8',
      );
      await prisma.$disconnect();
    }
    vi.unstubAllEnvs();
  }, 30_000);

  /** 通过管理 API 建立可定价的手工模型；从不依赖上游 /models。 */
  async function createPublishedModel(name: string, price = '10000000') {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-marketplace/models',
      headers: adminHeaders,
      payload: {
        name,
        description: '保留的人工说明',
        mediaType: 'text',
        specifications: { contextWindow: 4096 },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = created.json().model.id as string;
    const bound = await app.inject({
      method: 'POST',
      url: `/v1/admin/model-marketplace/models/${modelId}/bindings`,
      headers: adminHeaders,
      payload: {
        credentialId,
        credentialVersion,
        upstreamModelId: 'manual-only-model（按次）',
        contract: 'openai-chat-completions',
        capabilities: { mediaTypes: ['text'], mentionMediaTypes: ['text'] },
        verificationEvidence: 'isolated synthetic contract',
        activate: true,
      },
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const priced = await app.inject({
      method: 'POST',
      url: '/v1/admin/pricing-versions',
      headers: adminHeaders,
      payload: {
        platformModelId: modelId,
        rule: { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: price },
        activate: true,
      },
    });
    expect(priced.statusCode, priced.body).toBe(201);
    const published = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/model-marketplace/models/${modelId}`,
      headers: adminHeaders,
      payload: { status: 'published' },
    });
    expect(published.statusCode, published.body).toBe(200);
    return {
      modelId,
      bindingId: bound.json().binding.id as string,
      pricingId: priced.json().pricing.id as string,
    };
  }

  /** 每个用例独立账户和项目，防止余额断言依赖其他用例执行顺序。 */
  async function fixture(name: string, withIdempotencyKey = true) {
    const user = await authStore.createUser({
      email: `${namespace}-${randomUUID()}@example.invalid`,
      passwordHash: 'synthetic-unused-password-hash',
      status: 'active',
    });
    const headers = { authorization: `Bearer ${(await auth.issueToken(user)).accessToken}` };
    const project = await projects.create({ name: `${namespace} ${name}` }, { ownerId: user.id });
    createdProjects.push(project.id);
    const model = await createPublishedModel(`${name}-${namespace}`);
    const targetId = `target-${randomUUID()}`;
    await projects.updateCanvas(
      project.id,
      {
        revision: 0,
        nodes: [
          {
            id: targetId,
            type: 'text',
            position: { x: 0, y: 0 },
            data: {
              label: 'billing-test',
              mediaType: 'text',
              mode: 'generate',
              platformModelId: model.modelId,
              prompt: 'Synthetic English request; never sent.',
            },
          },
        ],
        edges: [],
      },
      { ownerId: user.id },
    );
    const path = `/v1/nodes/${targetId}/runs`;
    const body = {
      projectId: project.id,
      platformModelId: model.modelId,
      ...(withIdempotencyKey ? { idempotencyKey: `click-${randomUUID()}` } : {}),
    };
    return { user, headers, project, targetId, path, body, ...model };
  }

  /** 管理员发放测试额度并验证返回的人民币整数，不绕开钱包路由。 */
  async function credit(userId: string, amountNanos = '1000000000') {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/wallets/${userId}/adjust`,
      headers: adminHeaders,
      payload: {
        amountNanos,
        reason: 'isolated synthetic credit',
        idempotencyKey: `${namespace}-${randomUUID()}`,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().wallet.currency).toBe('CNY');
  }

  /** 与网页相同的两段报价协议；只读阶段不得出现 Run 或队列消息。 */
  async function quote(ctx: Awaited<ReturnType<typeof fixture>>) {
    const response = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().quote as { id: string; capNanos: string; items: unknown[] };
  }

  it('人工模型→人民币报价→额度→Run/冻结/outbox，重复确认只产生一次财务动作', async () => {
    const ctx = await fixture('atomic');
    const quoted = await quote(ctx);
    expect(quoted.capNanos).toBe('10000000');
    expect(await prisma.run.count({ where: { projectId: ctx.project.id } })).toBe(0);
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(0);
    expect(providerFetch).not.toHaveBeenCalled();
    await credit(ctx.user.id);
    const first = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(first.statusCode, first.body).toBe(202);
    const runId = first.json().run.id as string;
    createdRuns.push(runId);
    const charge = await prisma.runCharge.findUniqueOrThrow({
      where: { runId },
      include: { items: true },
    });
    expect(charge.items).toHaveLength(1);
    expect(charge.items[0]).toMatchObject({
      bindingId: ctx.bindingId,
      pricingVersionId: ctx.pricingId,
      status: 'HELD',
      executionState: 'unsent',
    });
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: databaseRunId(runId) } })).status,
    ).toBe('QUEUED');
    expect(
      (await prisma.runOutbox.findUniqueOrThrow({ where: { runId } })).publishedAt,
    ).not.toBeNull();
    expect(await queue.getJob(runId)).toBeDefined();
    expect((await queue.getJob(runId))!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    });
    const again = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(again.json().run.id).toBe(runId);
    const secondQuote = await quote(ctx);
    const otherQuoteSameClick = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: secondQuote.id },
    });
    expect(otherQuoteSameClick.json().run.id).toBe(runId);
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(1);
    expect(
      await prisma.walletEntry.count({ where: { wallet: { userId: ctx.user.id }, kind: 'hold' } }),
    ).toBe(1);
    expect(await billing.getWallet(ctx.user.id)).toEqual({
      currency: 'CNY',
      availableNanos: '990000000',
      heldNanos: '10000000',
    });
  }, 20_000);

  it('参数变化、过期、其他付款人、缺价和旧入口均不能绕过报价创建收费任务', async () => {
    const ctx = await fixture('reject');
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    for (const payload of [
      ctx.body,
      { ...ctx.body, quoteId: quoted.id, parameters: { temperature: 0.2 } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: ctx.path,
        headers: ctx.headers,
        payload,
      });
      expect(response.statusCode).toBe(409);
    }
    await prisma.billingQuote.update({
      where: { id: quoted.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(expired.json().code).toBe('quote_expired');
    const another = await fixture('other-payer');
    const otherQuote = await quote(another);
    const foreign = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: otherQuote.id },
    });
    expect(foreign.statusCode).toBe(404);
    const paused = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/model-marketplace/models/${ctx.modelId}`,
      headers: adminHeaders,
      payload: { status: 'draft', activePricingVersionId: null },
    });
    expect(paused.statusCode).toBe(200);
    const publishMissingPrice = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/model-marketplace/models/${ctx.modelId}`,
      headers: adminHeaders,
      payload: { status: 'published' },
    });
    expect(publishMissingPrice.statusCode).toBe(409);
    const noPrice = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    expect(noPrice.statusCode).toBe(409);
    expect(await prisma.run.count({ where: { projectId: ctx.project.id } })).toBe(0);
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(0);
    expect(
      await prisma.walletEntry.count({ where: { wallet: { userId: ctx.user.id }, kind: 'hold' } }),
    ).toBe(0);
  }, 20_000);

  it('队列发布失败保留已受理的原子冻结，重启派发仍为同一个 Run', async () => {
    const ctx = await fixture('outbox');
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    const add = vi
      .spyOn(Queue.prototype, 'add')
      .mockRejectedValueOnce(new Error('synthetic queue publication failure'));
    const response = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    add.mockRestore();
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().run.id as string;
    createdRuns.push(runId);
    expect(await queue.getJob(runId)).toBeUndefined();
    const pending = await prisma.runOutbox.findUniqueOrThrow({ where: { runId } });
    expect(pending.publishedAt).toBeNull();
    expect(pending.lastError).toBe('queue_publish_failed');
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(1);
    const foreignQueueName = `billing-api-test-foreign-${randomUUID()}`;
    const foreignQueue = new Queue(foreignQueueName, {
      connection: redisConnectionFromUrl(redisUrl!),
    });
    const foreignService = new BullMqRunService({
      connection: redisConnectionFromUrl(redisUrl!),
      queueName: foreignQueueName,
      providerName: 'mock',
      billing,
      persistence: new PrismaRunPersistence(prisma),
    });
    try {
      await foreignService.dispatchOutbox();
      expect(await foreignQueue.getJob(runId)).toBeUndefined();
      expect(
        (await prisma.runOutbox.findUniqueOrThrow({ where: { runId } })).publishedAt,
      ).toBeNull();
    } finally {
      await foreignService.close();
      await foreignQueue.obliterate();
      await foreignQueue.close();
    }
    const restored = new BullMqRunService({
      connection: redisConnectionFromUrl(redisUrl!),
      queueName,
      providerName: 'mock',
      billing,
      persistence: new PrismaRunPersistence(prisma),
    });
    try {
      await restored.dispatchOutbox();
      await restored.dispatchOutbox();
    } finally {
      await restored.close();
    }
    expect(await queue.getJob(runId)).toBeDefined();
    expect(
      (await prisma.runOutbox.findUniqueOrThrow({ where: { runId } })).publishedAt,
    ).not.toBeNull();
    expect(
      await prisma.walletEntry.count({ where: { wallet: { userId: ctx.user.id }, kind: 'hold' } }),
    ).toBe(1);
  }, 20_000);

  it('投递读取旧负载后收到取消，实际 Redis 任务仍携带持久取消意图', async () => {
    const ctx = await fixture('cancel-race');
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    const failedAdd = vi.spyOn(Queue.prototype, 'add').mockRejectedValueOnce(new Error('offline'));
    const submitted = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    failedAdd.mockRestore();
    expect(submitted.statusCode).toBe(202);
    const runId = submitted.json().run.id as string;
    createdRuns.push(runId);
    const originalAdd = Queue.prototype.add;
    const interleaved = vi.spyOn(Queue.prototype, 'add').mockImplementationOnce(async function (
      this: Queue,
      ...args
    ) {
      // 已读取 queued 和旧 outbox，但任务尚未放入 Redis。
      await service.cancel(runId);
      return originalAdd.apply(this, args);
    });
    try {
      await service.dispatchOutbox();
    } finally {
      interleaved.mockRestore();
    }
    expect((await queue.getJob(runId))!.data.cancelRequested).toBe(true);
    const saved = await prisma.runOutbox.findUniqueOrThrow({ where: { runId } });
    expect(saved.payload).toMatchObject({ cancelRequested: true });
    expect(await billing.getWallet(ctx.user.id)).toMatchObject({ heldNanos: '10000000' });
  }, 20_000);

  it('并发提交争用一笔额度只冻结一次，拒绝项的 Run、收费项和 outbox 一并回滚', async () => {
    const ctx = await fixture('concurrent');
    await credit(ctx.user.id, '10000000');
    const second = { ...ctx, body: { ...ctx.body, idempotencyKey: `second-${randomUUID()}` } };
    const [firstQuote, secondQuote] = await Promise.all([quote(ctx), quote(second)]);
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: ctx.path,
        headers: ctx.headers,
        payload: { ...ctx.body, quoteId: firstQuote.id },
      }),
      app.inject({
        method: 'POST',
        url: ctx.path,
        headers: ctx.headers,
        payload: { ...second.body, quoteId: secondQuote.id },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 402]);
    const accepted = responses.find((response) => response.statusCode === 202)!;
    createdRuns.push(accepted.json().run.id);
    expect(responses.find((response) => response.statusCode === 402)!.json().code).toBe(
      'insufficient_balance',
    );
    expect(await prisma.run.count({ where: { projectId: ctx.project.id } })).toBe(1);
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(1);
    expect(
      await prisma.walletEntry.count({ where: { wallet: { userId: ctx.user.id }, kind: 'hold' } }),
    ).toBe(1);
    expect(
      await prisma.billingQuote.count({
        where: { payerId: ctx.user.id, consumedRunId: { not: null } },
      }),
    ).toBe(1);
    expect(await billing.getWallet(ctx.user.id)).toEqual({
      currency: 'CNY',
      availableNanos: '0',
      heldNanos: '10000000',
    });
  }, 20_000);

  it('已发送但结果未知的运行禁止付费重试，核实释放后新确认才创建第二笔执行', async () => {
    const ctx = await fixture('retry');
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    const submitted = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const runId = submitted.json().run.id as string;
    createdRuns.push(runId);
    const charge = await prisma.runCharge.findUniqueOrThrow({
      where: { runId },
      include: { items: true },
    });
    const item = charge.items[0]!;
    await prisma.chargeItem.update({ where: { id: item.id }, data: { executionState: 'sending' } });
    await billing.resolveItem(item.id, {
      status: 'PENDING_VERIFICATION',
      chargeNanos: '0',
      reason: 'synthetic unknown request',
    });
    await new PrismaRunPersistence(prisma).updateRun({
      runId,
      status: 'failed',
      error: 'synthetic unknown execution',
    });
    await (await queue.getJob(runId))!.remove();
    const retryPath = `/v1/runs/${runId}/retry`;
    const retryQuote = await app.inject({
      method: 'POST',
      url: retryPath,
      headers: ctx.headers,
      payload: { quoteOnly: true },
    });
    expect(retryQuote.statusCode, retryQuote.body).toBe(200);
    const blocked = await app.inject({
      method: 'POST',
      url: retryPath,
      headers: ctx.headers,
      payload: { quoteId: retryQuote.json().quote.id },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().code).toBe('retry_requires_review');
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(1);
    await billing.resolveItem(item.id, {
      status: 'RELEASED',
      chargeNanos: '0',
      reason: 'synthetic verified failure',
    });
    const allowed = await app.inject({
      method: 'POST',
      url: retryPath,
      headers: ctx.headers,
      payload: { quoteId: retryQuote.json().quote.id },
    });
    expect(allowed.statusCode, allowed.body).toBe(202);
    const newRunId = allowed.json().run.id as string;
    createdRuns.push(newRunId);
    expect(newRunId).not.toBe(runId);
    expect(allowed.json().run.attempt).toBe(2);
    expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(2);
    expect(await billing.getWallet(ctx.user.id)).toEqual({
      currency: 'CNY',
      availableNanos: '990000000',
      heldNanos: '10000000',
    });
  }, 20_000);

  it.each([true, false])(
    '数据库 UUID 别名不能绕过原收费项的待核实重试限制（幂等键 %s）',
    async (withIdempotencyKey) => {
      const ctx = await fixture('uuid-retry', withIdempotencyKey);
      await credit(ctx.user.id);
      const quoted = await quote(ctx);
      const submitted = await app.inject({
        method: 'POST',
        url: ctx.path,
        headers: ctx.headers,
        payload: { ...ctx.body, quoteId: quoted.id },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const runId = submitted.json().run.id as string;
      createdRuns.push(runId);
      const charge = await prisma.runCharge.findUniqueOrThrow({
        where: { runId },
        include: { items: true },
      });
      const item = charge.items[0]!;
      await prisma.chargeItem.update({
        where: { id: item.id },
        data: { executionState: 'sending' },
      });
      await billing.resolveItem(item.id, {
        status: 'PENDING_VERIFICATION',
        chargeNanos: '0',
        reason: '同步调用结果未知，无可恢复的供应商任务 ID',
      });
      await new PrismaRunPersistence(prisma).updateRun({
        runId,
        status: 'failed',
        error: 'synthetic unknown synchronous execution',
      });
      await (await queue.getJob(runId))!.remove();
      const path = `/v1/runs/${databaseRunId(runId)}/retry`;
      const requoted = await app.inject({
        method: 'POST',
        url: path,
        headers: ctx.headers,
        payload: { quoteOnly: true },
      });
      expect(requoted.statusCode, requoted.body).toBe(200);
      const retried = await app.inject({
        method: 'POST',
        url: path,
        headers: ctx.headers,
        payload: { quoteId: requoted.json().quote.id },
      });
      expect(retried.statusCode, retried.body).toBe(409);
      expect(retried.json().code).toBe('retry_requires_review');
      expect(await prisma.runCharge.count({ where: { payerId: ctx.user.id } })).toBe(1);
      expect(await billing.getWallet(ctx.user.id)).toEqual({
        currency: 'CNY',
        availableNanos: '990000000',
        heldNanos: '10000000',
      });
    },
    20_000,
  );

  it.each([true, false])(
    '数据库 UUID 别名读取同一账单并取消同一 outbox（幂等键 %s）',
    async (withIdempotencyKey) => {
      const ctx = await fixture('uuid-read-cancel', withIdempotencyKey);
      await credit(ctx.user.id);
      const quoted = await quote(ctx);
      const submitted = await app.inject({
        method: 'POST',
        url: ctx.path,
        headers: ctx.headers,
        payload: { ...ctx.body, quoteId: quoted.id },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const runId = submitted.json().run.id as string;
      createdRuns.push(runId);
      expect(runId).toEqual(
        withIdempotencyKey ? expect.stringMatching(/^run_idem_/) : `run_${quoted.id}`,
      );
      const alias = databaseRunId(runId);
      const externalCharge = await app.inject({
        url: `/v1/runs/${runId}/charge`,
        headers: ctx.headers,
      });
      const aliasCharge = await app.inject({
        url: `/v1/runs/${alias}/charge`,
        headers: ctx.headers,
      });
      expect(aliasCharge.statusCode, aliasCharge.body).toBe(200);
      expect(aliasCharge.json()).toEqual(externalCharge.json());
      const read = await app.inject({ url: `/v1/runs/${alias}`, headers: ctx.headers });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().run.id).toBe(runId);
      const cancelled = await app.inject({
        method: 'POST',
        url: `/v1/runs/${alias}/cancel`,
        headers: ctx.headers,
      });
      expect(cancelled.statusCode, cancelled.body).toBe(202);
      expect(cancelled.json().run.id).toBe(runId);
      expect((await queue.getJob(runId))!.data.cancelRequested).toBe(true);
      const outbox = await prisma.runOutbox.findUniqueOrThrow({ where: { runId } });
      expect(outbox.payload).toMatchObject({ runId, cancelRequested: true });
      await (await queue.getJob(runId))!.remove();
      const history = await app.inject({
        url: `/v1/projects/${ctx.project.id}/runs`,
        headers: ctx.headers,
      });
      expect(history.json().runs.map((run: { id: string }) => run.id)).toEqual([runId]);
      const restored = await app.inject({ url: `/v1/runs/${alias}`, headers: ctx.headers });
      expect(restored.statusCode, restored.body).toBe(200);
      expect(restored.json().run.id).toBe(runId);
      // 只删除此用例自己的合成运行行，验证账务不会随历史清理丢失。
      await prisma.run.delete({ where: { id: alias } });
      const preservedCharge = await app.inject({
        url: `/v1/runs/${runId}/charge`,
        headers: ctx.headers,
      });
      expect(preservedCharge.statusCode, preservedCharge.body).toBe(200);
      expect(preservedCharge.json()).toEqual(externalCharge.json());
    },
    20_000,
  );

  it('切换 API 保留商品与售价，已冻结运行仍引用旧绑定；同步不覆盖人工信息', async () => {
    const ctx = await fixture('switch-api');
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    const submitted = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const runId = submitted.json().run.id as string;
    createdRuns.push(runId);
    const second = await settings.update({
      baseUrl: 'https://replacement-fixture.invalid/v1',
      apiKey: 'synthetic-replacement-only',
      activate: false,
    });
    const replacement = second.createdCredentialId!;
    const ref = await settings.getCredentialReference(replacement);
    const rebound = await app.inject({
      method: 'POST',
      url: `/v1/admin/model-marketplace/models/${ctx.modelId}/bindings`,
      headers: adminHeaders,
      payload: {
        credentialId: replacement,
        credentialVersion: ref.credentialVersion,
        upstreamModelId: 'replacement-exact-id',
        contract: 'openai-chat-completions',
        capabilities: { mediaTypes: ['text'], mentionMediaTypes: ['text'] },
        verificationEvidence: 'isolated replacement verification',
        activate: true,
      },
    });
    expect(rebound.statusCode, rebound.body).toBe(201);
    const sync = await app.inject({
      method: 'POST',
      url: '/v1/admin/model-marketplace/sync',
      headers: adminHeaders,
      payload: { credentialId: replacement },
    });
    expect(sync.statusCode, sync.body).toBe(200);
    expect(providerFetch).toHaveBeenCalled();
    const model = await prisma.platformModel.findUniqueOrThrow({ where: { id: ctx.modelId } });
    expect(model).toMatchObject({
      name: `switch-api-${namespace}`,
      description: '保留的人工说明',
      status: 'published',
      activePricingVersionId: ctx.pricingId,
      activeBindingId: rebound.json().binding.id,
    });
    const snapshot = (await prisma.run.findUniqueOrThrow({ where: { id: databaseRunId(runId) } }))
      .snapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      credentialId,
      modelAlias: 'manual-only-model（按次）',
      billingBindings: {
        [ctx.targetId]: { platformModelId: ctx.modelId, bindingId: ctx.bindingId },
      },
    });
    const current = await quote({
      ...ctx,
      body: { ...ctx.body, idempotencyKey: `after-switch-${randomUUID()}` },
    });
    const currentSnapshot = (
      await prisma.billingQuote.findUniqueOrThrow({ where: { id: current.id } })
    ).snapshot;
    expect(currentSnapshot).toMatchObject({
      credentialId: replacement,
      modelAlias: 'replacement-exact-id',
    });
    expect(await prisma.modelBinding.count({ where: { platformModelId: ctx.modelId } })).toBe(2);
  }, 20_000);

  it('钱包管理只接受管理员会话，用户无法读取他人逐项账单', async () => {
    const ctx = await fixture('permissions');
    const adjustment = {
      amountNanos: '1000000000',
      reason: 'attempted override',
      idempotencyKey: randomUUID(),
    };
    for (const headers of [
      { authorization: 'Bearer synthetic-billing-service-token' },
      ctx.headers,
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/admin/wallets/${ctx.user.id}/adjust`,
        headers,
        payload: adjustment,
      });
      expect([401, 403]).toContain(response.statusCode);
    }
    await credit(ctx.user.id);
    const quoted = await quote(ctx);
    const submitted = await app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.id },
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const runId = submitted.json().run.id as string;
    createdRuns.push(runId);
    const own = await app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/charge`,
      headers: ctx.headers,
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(credentialId);
    expect(own.body).not.toContain('providerCost');
    const chargedItem = await prisma.chargeItem.findFirstOrThrow({
      where: { charge: { runId } },
    });
    await billing.recordCost(chargedItem.id, {
      amount: '0.000000000123',
      currency: 'USD',
      source: 'synthetic_reported',
    });
    await billing.recordCost(chargedItem.id, {
      amount: '0.000000000456',
      currency: 'USD',
      source: 'synthetic_conflict',
    });
    const reconciliation = await prisma.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: chargedItem.id, kind: 'provider_cost' } },
    });
    await billing.resolveReconciliation({
      id: reconciliation.id,
      actorId: adminId,
      action: 'confirm_cost',
      amount: '0.000000000456',
      currency: 'USD',
      reason: 'isolated original currency invoice verified',
    });
    const adminList = await app.inject({
      url: `/v1/admin/charge-items?runId=${runId}`,
      headers: adminHeaders,
    });
    expect(adminList.statusCode, adminList.body).toBe(200);
    expect(adminList.json().items).toHaveLength(1);
    const detail = await app.inject({
      url: `/v1/admin/charge-items/${chargedItem.id}`,
      headers: adminHeaders,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().item.providerCost).toMatchObject({
      status: 'adjudicated',
      amount: '0.000000000123',
      currency: 'USD',
      evidence: { decision: { amount: '0.000000000456', currency: 'USD' } },
    });
    expect(detail.json().history).toHaveLength(3);
    expect(
      detail
        .json()
        .history.some(
          (entry: { action: string }) => entry.action === 'billing.reconciliation_resolved',
        ),
    ).toBe(true);
    expect(detail.body).not.toContain(credentialId);
    expect(detail.json().item).not.toHaveProperty('quoteInput');
    for (const url of ['/v1/admin/charge-items', `/v1/admin/charge-items/${chargedItem.id}`]) {
      expect((await app.inject({ url, headers: ctx.headers })).statusCode).toBe(403);
    }
    const other = await fixture('foreign-bill');
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/charge`,
      headers: other.headers,
    });
    expect(denied.statusCode).toBe(404);
    const ownWallet = await app.inject({
      method: 'GET',
      url: '/v1/account/wallet',
      headers: other.headers,
    });
    expect(ownWallet.json().wallet).toEqual({
      currency: 'CNY',
      availableNanos: '0',
      heldNanos: '0',
    });
    const bypass = await app.inject({
      method: 'POST',
      url: other.path,
      headers: { authorization: 'Bearer synthetic-billing-service-token' },
      payload: { ...other.body, quoteOnly: true },
    });
    expect(bypass.statusCode).toBe(401);
    expect(await prisma.run.count({ where: { projectId: other.project.id } })).toBe(0);
  }, 20_000);
});

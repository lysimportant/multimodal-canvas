import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { describe, expect, it, afterAll } from 'vitest';
import { calculateBillingQuote, type RunSnapshot } from '@multimodal-canvas/domain';
import { PrismaBillingService, nanos } from './index';

/** 不依赖数据库的金额边界检查。 */
describe('nanos', () => {
  it('rejects floats, overflow and malformed monetary sources', () => {
    for (const value of ['0.1', '01', '1e5', '-1', '9'.repeat(39)])
      expect(() => nanos(value)).toThrow();
    expect(nanos('1')).toBe(1n);
    expect(nanos('-12', true)).toBe(-12n);
  });
});

/** 仅允许显式隔离、loopback 且以 _test 结尾的数据库，禁止读取默认 DATABASE_URL。 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const isolated = process.env.TEST_DATABASE_CONFIRMED_ISOLATED === 'true';
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !isolated ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.pathname.endsWith('_test')
  )
    throw new Error('账务集成测试只允许明确确认的本机隔离数据库');
}
const prisma = databaseUrl
  ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  : undefined;
afterAll(async () => {
  await prisma?.$disconnect();
});

/** 每项测试创建独立付款人和Run，保留记录供钱包流水核对，不清空共享数据。 */
describe.skipIf(!prisma)('PostgreSQL wallet transactions', () => {
  /** 生成不含外部地址、密钥或真实请求的可持久化夹具。 */
  async function fixture(balance = '100') {
    const db = prisma!;
    const user = await db.user.create({
      data: { email: `billing-${randomUUID()}@example.invalid` },
    });
    const project = await db.project.create({ data: { name: '隔离账务验收', ownerId: user.id } });
    const billing = new PrismaBillingService(db);
    await billing.adjust({
      userId: user.id,
      actorId: user.id,
      amountNanos: balance,
      reason: '内部测试额度',
      idempotencyKey: randomUUID(),
    });
    const snapshot: RunSnapshot = {
      projectId: project.id,
      canvasRevision: 0,
      targetNodeId: 'node',
      modelAlias: 'mock-text',
      parameters: {},
      submittedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'node',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: '测试', mediaType: 'text', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    };
    /** 可信服务端报价夹具，不允许客户端金额参与运行授权。 */
    const quote = async (amount = '60') => {
      const calculation = calculateBillingQuote({
        rule: { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: amount },
      });
      return billing.createQuote({
        payerId: user.id,
        snapshot,
        items: [
          {
            nodeId: 'node',
            platformModelId: randomUUID(),
            bindingId: randomUUID(),
            pricingVersionId: randomUUID(),
            maximumNanos: amount,
            pricingRule: calculation.rule,
            quoteInput: calculation,
          },
        ],
      });
    };
    /** 与运行行共享同一事务的提交夹具；可注入失败验证无部分冻结。 */
    const commit = async (quoteId: string, runId = randomUUID(), fail = false) => {
      return billing.commitSubmission(
        {
          payerId: user.id,
          quoteId,
          runId,
          snapshot,
          payload: { runId },
          queueName: 'isolated-wallet-tests',
        },
        async (tx) => {
          await tx.run.create({
            data: {
              id: runId,
              projectId: project.id,
              userId: user.id,
              snapshot: {},
              status: 'QUEUED',
            },
          });
          if (fail) throw new Error('模拟任务保存失败');
        },
      );
    };
    return { db, user, project, billing, snapshot, quote, commit };
  }

  it('数据库 UUID 保留历史未计费身份，缺失的运行也不会被猜测为新身份', async () => {
    const f = await fixture();
    const run = await f.db.run.create({
      data: {
        projectId: f.project.id,
        userId: f.user.id,
        snapshot: f.snapshot as Prisma.InputJsonValue,
        status: 'FAILED',
      },
    });
    expect(await f.billing.resolveRunId(run.id)).toBe(run.id);
    expect(await f.billing.getRunCharge(run.id, f.user.id)).toBeUndefined();
    const missingId = randomUUID();
    expect(await f.billing.resolveRunId(missingId)).toBe(missingId);
  });

  it.each([true, false])(
    '已计费快照缺少可靠映射时拒绝当作历史任务（付款人 %s）',
    async (hasPayer) => {
      const f = await fixture();
      f.snapshot.billingBindings = {
        node: {
          platformModelId: randomUUID(),
          bindingId: randomUUID(),
          pricingVersionId: randomUUID(),
          contract: 'openai-chat-completions',
        },
      };
      const run = await f.db.run.create({
        data: {
          projectId: f.project.id,
          userId: hasPayer ? f.user.id : null,
          snapshot: f.snapshot as Prisma.InputJsonValue,
          status: 'FAILED',
        },
      });
      await expect(f.billing.resolveRunId(run.id)).rejects.toMatchObject({
        code: 'run_identity_unavailable',
      });
      await expect(f.billing.getRunCharge(run.id, f.user.id)).rejects.toMatchObject({
        code: 'run_identity_unavailable',
      });
      expect(await f.billing.getWallet(f.user.id)).toMatchObject({
        availableNanos: '100',
        heldNanos: '0',
      });
    },
  );

  it('concurrent holds cannot overspend and balances match append-only entries', async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.quote(), f.quote()]);
    const results = await Promise.allSettled([f.commit(a.id), f.commit(b.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
    const entries = await f.billing.listEntries(f.user.id);
    expect(
      entries.reduce((sum, entry) => sum + BigInt(entry.availableDeltaNanos.toFixed(0)), 0n),
    ).toBe(40n);
    expect(entries.reduce((sum, entry) => sum + BigInt(entry.heldDeltaNanos.toFixed(0)), 0n)).toBe(
      60n,
    );
  });

  it('duplicate acceptance creates one run, hold, item and outbox', async () => {
    const f = await fixture();
    const quote = await f.quote();
    const runId = randomUUID();
    await Promise.all([f.commit(quote.id, runId), f.commit(quote.id, runId)]);
    expect(await f.db.runOutbox.count({ where: { runId } })).toBe(1);
    expect(await f.db.walletEntry.count({ where: { runId, kind: 'hold' } })).toBe(1);
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
    await expect(f.commit(quote.id)).rejects.toMatchObject({ code: 'quote_consumed' });
  });

  it('rolls back run, quote consumption, hold and outbox as a unit', async () => {
    const f = await fixture();
    const quote = await f.quote();
    const runId = randomUUID();
    await expect(f.commit(quote.id, runId, true)).rejects.toThrow('模拟任务保存失败');
    expect(await f.db.run.findUnique({ where: { id: runId } })).toBeNull();
    expect(await f.db.runOutbox.count({ where: { runId } })).toBe(0);
    expect(
      (await f.db.billingQuote.findUniqueOrThrow({ where: { id: quote.id } })).consumedRunId,
    ).toBeNull();
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
  });

  it('rejects expired quotes and changed payer or parameters without sending', async () => {
    const f = await fixture();
    const quote = await f.quote();
    await f.db.billingQuote.update({ where: { id: quote.id }, data: { expiresAt: new Date(0) } });
    await expect(f.commit(quote.id)).rejects.toMatchObject({ code: 'quote_expired' });
    const valid = await f.quote();
    f.snapshot.parameters = { n: 2 };
    await expect(f.commit(valid.id)).rejects.toMatchObject({ code: 'quote_changed' });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
  });

  it('settles once, releases excess and separates unknown provider costs', async () => {
    const f = await fixture();
    const quote = await f.quote();
    const charge = await f.commit(quote.id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.beginExecution(charge.runId, 'node', f.snapshot);
    const resolution = {
      status: 'SETTLED' as const,
      chargeNanos: '35',
      reason: '可靠用量与可交付结果',
      evidence: { assetId: randomUUID() },
    };
    await Promise.all([
      f.billing.resolveItem(item.id, resolution),
      f.billing.resolveItem(item.id, resolution),
    ]);
    await f.billing.recordCost(item.id);
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '65',
      heldNanos: '0',
    });
    expect(
      (await f.db.providerCost.findUniqueOrThrow({ where: { chargeItemId: item.id } })).status,
    ).toBe('pending_reconciliation');
    expect(
      await f.db.walletEntry.count({ where: { chargeItemId: item.id, kind: 'settlement' } }),
    ).toBe(1);
  });

  it('unknown execution blocks a repeated create and only known task identity can resume', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.billing.beginExecution(charge.runId, 'node', f.snapshot);
    await expect(f.billing.beginExecution(charge.runId, 'node', f.snapshot)).rejects.toMatchObject({
      code: 'execution_unknown',
    });
    await f.billing.recordProviderRequest(item.id, 'synthetic-task-1');
    await expect(
      f.billing.beginExecution(charge.runId, 'node', f.snapshot, 'other-task'),
    ).rejects.toMatchObject({ code: 'execution_unknown' });
    expect(
      (await f.billing.beginExecution(charge.runId, 'node', f.snapshot, 'synthetic-task-1')).id,
    ).toBe(item.id);
    await f.billing.resolveItem(item.id, {
      status: 'PENDING_VERIFICATION',
      chargeNanos: '0',
      reason: '等待上游任务核实',
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
  });

  it('late delivery cannot recharge released or refunded items', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.resolveItem(item.id, {
      status: 'RELEASED',
      chargeNanos: '0',
      reason: '管理员核实无需收费',
    });
    await f.billing.resolveItem(item.id, {
      status: 'SETTLED',
      chargeNanos: '60',
      reason: '迟到结果',
      evidence: { delivered: true },
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
    expect((await f.db.chargeItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'RELEASED',
    );
  });

  it.each(['archived-evidence', 'open-worker-recovery'] as const)(
    '管理员不能通过 execution 释放已交付待恢复项（%s）',
    async (recoveryState) => {
      const f = await fixture();
      const charge = await f.commit((await f.quote()).id);
      const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
      await f.billing.resolveItem(item.id, {
        status: 'PENDING_VERIFICATION',
        chargeNanos: '0',
        reason: '已交付但本地补账失败',
        ...(recoveryState === 'archived-evidence'
          ? { evidence: { deliveryState: 'archived', nodeId: 'node' } }
          : {}),
      });
      if (recoveryState === 'open-worker-recovery')
        await f.db.reconciliationItem.create({
          data: {
            chargeItemId: item.id,
            kind: 'worker_recovery',
            reason: '恢复原 Run 的本地账务',
            dueAt: new Date(Date.now() + 86_400_000),
          },
        });
      const execution = await f.db.reconciliationItem.findUniqueOrThrow({
        where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'execution' } },
      });
      await expect(
        f.billing.resolveReconciliation({
          id: execution.id,
          actorId: f.user.id,
          action: 'release',
          reason: '错误尝试直接释放已归档项',
        }),
      ).rejects.toMatchObject({ code: 'invalid_resolution' });
      expect(await f.billing.getWallet(f.user.id)).toMatchObject({
        availableNanos: '40',
        heldNanos: '60',
      });
      expect((await f.db.chargeItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
        'PENDING_VERIFICATION',
      );
      expect(
        (await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: execution.id } })).status,
      ).toBe('open');
      expect(
        await f.db.walletEntry.count({ where: { chargeItemId: item.id, kind: 'release' } }),
      ).toBe(0);
    },
  );

  it('仅缺计量的交付证据仍允许管理员按依据释放冻结', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.resolveItem(item.id, {
      status: 'PENDING_VERIFICATION',
      chargeNanos: '0',
      reason: '已交付但供应商缺少可信用量',
      evidence: { nodeId: 'node', assetId: randomUUID(), version: 1 },
    });
    const execution = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'execution' } },
    });
    await f.billing.resolveReconciliation({
      id: execution.id,
      actorId: f.user.id,
      action: 'release',
      reason: '核实后决定不向用户收费',
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
  });

  it('refunds are idempotent and cannot exceed settled consumption', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.resolveItem(item.id, {
      status: 'SETTLED',
      chargeNanos: '60',
      reason: '已交付',
    });
    const refund = {
      itemId: item.id,
      amountNanos: '60',
      actorId: f.user.id,
      reason: '测试退款',
      idempotencyKey: randomUUID(),
    };
    await Promise.all([f.billing.refund(refund), f.billing.refund(refund)]);
    await expect(
      f.billing.refund({ ...refund, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'refund_exceeds_charge' });
    await f.billing.resolveItem(item.id, {
      status: 'SETTLED',
      chargeNanos: '60',
      reason: '迟到重复回调',
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
  });

  it('a reused credit identity with another amount or user is rejected', async () => {
    const f = await fixture();
    const input = {
      userId: f.user.id,
      actorId: f.user.id,
      amountNanos: '2',
      reason: '测试',
      idempotencyKey: randomUUID(),
    };
    await Promise.all([f.billing.adjust(input), f.billing.adjust(input)]);
    await expect(f.billing.adjust({ ...input, amountNanos: '3' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '102',
      heldNanos: '0',
    });
  });

  it('confirmed provider amounts remain immutable when later facts conflict', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.recordCost(item.id, {
      amount: '0.12',
      currency: 'USD',
      source: 'provider_reported',
    });
    const disputed = await f.billing.recordCost(item.id, {
      amount: '0.20',
      currency: 'USD',
      source: 'provider_reported',
    });
    expect(disputed.status).toBe('disputed');
    expect(disputed.amount?.toString()).toBe('0.12');
    expect(disputed.currency).toBe('USD');
  });

  it('normalizes small numeric provider costs and refuses silent rounding or overflow', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    for (const amount of ['1e26', '1e-13', 'NaN', '0x01', '-0.1', '01', '1e10000']) {
      await expect(
        f.billing.recordCost(item.id, { amount, currency: 'USD', source: 'provider_reported' }),
      ).rejects.toMatchObject({ code: 'invalid_provider_cost' });
    }
    const recorded = await f.billing.recordCost(item.id, {
      amount: String(0.000000000123),
      currency: 'USD',
      source: 'provider_reported',
    });
    expect(recorded.amount?.toFixed()).toBe('0.000000000123');
    expect(recorded.evidence).toMatchObject({
      observations: [{ amount: '0.000000000123', currency: 'USD' }],
    });
    expect(
      await f.db.accountAudit.count({
        where: { targetId: item.id, action: 'billing.provider_cost_observed' },
      }),
    ).toBe(1);
  });

  it('new cost conflicts reopen resolved work with audit history, but adjudicated replay stays closed', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.recordCost(item.id);
    const pending = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'provider_cost' } },
    });
    await f.billing.resolveReconciliation({
      id: pending.id,
      actorId: f.user.id,
      action: 'confirm_cost',
      amount: '0.000000000123',
      currency: 'USD',
      reason: '首次成本账单确认',
    });
    await f.billing.recordCost(item.id, {
      amount: '0.000000000456',
      currency: 'USD',
      source: 'provider_reported',
    });
    const reopened = await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: pending.id } });
    expect(reopened).toMatchObject({
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
    });
    const reopenedAudit = await f.db.accountAudit.findFirstOrThrow({
      where: { targetId: pending.id, action: 'billing.reconciliation_reopened' },
    });
    expect(JSON.parse(reopenedAudit.summary)).toMatchObject({
      previousResolution: '首次成本账单确认',
      previousResolvedBy: f.user.id,
    });
    await f.billing.resolveReconciliation({
      id: pending.id,
      actorId: f.user.id,
      action: 'confirm_cost',
      amount: '0.000000000456',
      currency: 'USD',
      reason: '供应商更正金额，保留原事实',
    });
    const decided = await f.db.providerCost.findUniqueOrThrow({ where: { chargeItemId: item.id } });
    expect(decided.status).toBe('adjudicated');
    expect(decided.amount?.toFixed()).toBe('0.000000000123');
    expect(decided.source).toBe('admin_verified');
    expect(decided.evidence).toMatchObject({
      decision: { amount: '0.000000000456', currency: 'USD', actorId: f.user.id },
    });
    await f.billing.recordCost(item.id, {
      amount: '0.000000000456',
      currency: 'USD',
      source: 'provider_reported',
    });
    expect(
      (await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('resolved');
    await f.billing.recordCost(item.id, {
      amount: '0.000000000789',
      currency: 'USD',
      source: 'provider_reported',
    });
    expect(
      (await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('open');
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
  });

  it('concurrent administrative release records one financial action and one actor decision', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.resolveItem(item.id, {
      status: 'PENDING_VERIFICATION',
      chargeNanos: '0',
      reason: '等待执行核实',
    });
    const pending = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'execution' } },
    });
    const outcomes = await Promise.allSettled([
      f.billing.resolveReconciliation({
        id: pending.id,
        actorId: f.user.id,
        action: 'release',
        reason: '确认未交付 A',
      }),
      f.billing.resolveReconciliation({
        id: pending.id,
        actorId: f.user.id,
        action: 'release',
        reason: '确认未交付 B',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const entry = await f.db.walletEntry.findFirstOrThrow({
      where: { chargeItemId: item.id, kind: 'release' },
    });
    expect(entry.actorId).toBe(f.user.id);
    const resolved = await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: pending.id } });
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedBy: f.user.id,
      resolution: entry.reason,
    });
    expect(
      await f.db.accountAudit.count({
        where: { targetId: pending.id, action: 'billing.reconciliation_resolved' },
      }),
    ).toBe(1);
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
    await f.billing.resolveItem(item.id, {
      status: 'SETTLED',
      chargeNanos: '60',
      reason: '迟到交付',
      evidence: { delivered: true },
    });
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '100',
      heldNanos: '0',
    });
  });

  it('concurrent cost decisions preserve the winning amount and administrator audit together', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.recordCost(item.id);
    const pending = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'provider_cost' } },
    });
    const decisions = [
      { amount: '0.000000000123', currency: 'USD', reason: '独立账单 A' },
      { amount: '0.000000000456', currency: 'CNY', reason: '独立账单 B' },
    ];
    const outcomes = await Promise.allSettled(
      decisions.map((decision) =>
        f.billing.resolveReconciliation({
          ...decision,
          id: pending.id,
          actorId: f.user.id,
          action: 'confirm_cost',
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'already_resolved' },
    });
    const winner = decisions[outcomes.findIndex((outcome) => outcome.status === 'fulfilled')]!;
    const cost = await f.db.providerCost.findUniqueOrThrow({ where: { chargeItemId: item.id } });
    expect(cost.amount?.toFixed()).toBe(winner.amount);
    expect(cost.currency).toBe(winner.currency);
    expect(cost.evidence).toMatchObject({ decision: { ...winner, actorId: f.user.id } });
    const audits = await f.db.accountAudit.findMany({
      where: { targetId: pending.id, action: 'billing.reconciliation_resolved' },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.summary)).toMatchObject(winner);
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
  });

  it('failure closing reconciliation rolls back the release and its audit as one transaction', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.resolveItem(item.id, {
      status: 'PENDING_VERIFICATION',
      chargeNanos: '0',
      reason: '等待管理员',
    });
    const pending = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'execution' } },
    });
    const execute = f.db.$transaction.bind(f.db);
    // 单独代理故障客户端，避免修改 Prisma 共享代理的 $transaction 属性。
    const failingDatabase = new Proxy(f.db, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);
        return async (operation: unknown, options?: unknown) =>
          execute(
            async (tx) => {
              const proxy = new Proxy(tx, {
                get(transaction, key) {
                  if (key === 'reconciliationItem')
                    return new Proxy(transaction.reconciliationItem, {
                      get(delegate, method) {
                        if (method === 'update')
                          return async () => {
                            throw new Error('synthetic close failure');
                          };
                        return Reflect.get(delegate, method);
                      },
                    });
                  return Reflect.get(transaction, key);
                },
              });
              return (operation as (database: typeof tx) => Promise<unknown>)(proxy);
            },
            options as Parameters<typeof execute>[1],
          );
      },
    });
    const failingBilling = new PrismaBillingService(failingDatabase);
    await expect(
      failingBilling.resolveReconciliation({
        id: pending.id,
        actorId: f.user.id,
        action: 'release',
        reason: '事务回滚验证',
      }),
    ).rejects.toThrow('synthetic close failure');
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
    expect(
      await f.db.walletEntry.count({ where: { chargeItemId: item.id, kind: 'release' } }),
    ).toBe(0);
    expect(
      (await f.db.reconciliationItem.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('open');
    expect((await f.db.chargeItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'PENDING_VERIFICATION',
    );
  });

  it('a later explicit provider cost closes missing-cost reconciliation without changing user charges', async () => {
    const f = await fixture();
    const charge = await f.commit((await f.quote()).id);
    const item = await f.db.chargeItem.findFirstOrThrow({ where: { runChargeId: charge.id } });
    await f.billing.recordCost(item.id);
    await f.billing.recordCost(item.id, {
      amount: '0.025',
      currency: 'USD',
      source: 'provider_reported',
    });
    const resolved = await f.db.reconciliationItem.findUniqueOrThrow({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'provider_cost' } },
    });
    expect(resolved.status).toBe('resolved');
    expect(await f.billing.getWallet(f.user.id)).toMatchObject({
      availableNanos: '40',
      heldNanos: '60',
    });
  });
});

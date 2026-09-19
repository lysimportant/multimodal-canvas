import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  runSnapshotFingerprintMaterial,
  runSnapshotSchema,
  type RunSnapshot,
} from '@multimodal-canvas/domain';

/** 金额单位为十亿分之一元；数据库 Decimal 只承载整数，业务运算使用 BigInt。 */
export const CNY_NANOS = 1_000_000_000n;

/** 运行数据库主键的既有 UUID 合同，不能把外部 run_* 编号直接当作主键。 */
const databaseRunUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 将运行外部编号映射到既有数据库 UUID；已是 UUID 时保持不变，不创建或修改记录。 */
export function billingDatabaseRunId(runId: string): string {
  if (databaseRunUuid.test(runId)) return runId;
  const digest = createHash('sha256').update(`multimodal-canvas:run:${runId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** 带稳定代码和 HTTP 状态的账务拒绝；未知数据库异常保留原始异常链。 */
export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/** 报价子项只接受服务端解析出的不可变模型、绑定、价格和计量上限。 */
export type QuoteItemInput = {
  nodeId: string;
  platformModelId: string;
  bindingId: string;
  pricingVersionId: string;
  pricingRule: Prisma.InputJsonValue;
  quoteInput: Prisma.InputJsonValue;
  maximumNanos: string;
};

/** 已验收的交付结算结果；超过授权上限时必须先按上限截断并记录对账。 */
export type ChargeResolution = {
  status: 'SETTLED' | 'RELEASED' | 'PENDING_VERIFICATION';
  chargeNanos: string;
  reason: string;
  evidence?: Prisma.InputJsonValue;
  usage?: Prisma.InputJsonValue;
};

/** 公开钱包仅包含人民币余额，不返回供应商连接或成本。 */
export type WalletView = {
  currency: 'CNY';
  availableNanos: string;
  heldNanos: string;
};

/** 供应商原币种成本事实；金额不是 nanos，保留最多十二位小数。 */
type ProviderCostFact = { amount: string; currency: string; source: string };
/** 追加保存的成本来源，以及管理员对争议的裁决；首条金额字段仍然不变。 */
type ProviderCostEvidence = {
  observations: Array<ProviderCostFact & { recordedAt: string }>;
  decision?: {
    amount: string;
    currency: string;
    actorId: string;
    reason: string;
    decidedAt: string;
  };
};

/** 验证 Decimal(38,0) 可保存的整数；只允许显式调整传入负数。 */
export function nanos(value: string, signed = false): bigint {
  if (!(signed ? /^-?(0|[1-9]\d{0,37})$/ : /^(0|[1-9]\d{0,37})$/).test(value))
    throw new BillingError('invalid_amount', '金额必须为精度范围内的整数字符串', 400);
  return BigInt(value);
}

/** 指纹覆盖冻结图、模型、凭据、参数和版本；提交时间不构成新的付款身份。 */
export function billingSnapshotHash(snapshot: RunSnapshot): string {
  return createHash('sha256').update(runSnapshotFingerprintMaterial(snapshot)).digest('hex');
}

/**
 * PostgreSQL 是钱包与执行授权的唯一事实来源；API 和 Worker 共用此实现。
 * 每个事务先锁付款人钱包，再锁报价/收费项，所有财务动作只能追加流水。
 */
export class PrismaBillingService {
  constructor(public readonly prisma: PrismaClient) {}

  /**
   * 将已持久化的 UUID 别名还原为账务和队列共用的原始运行编号。
   * 有幂等键时精确重建；无键时只查该付款人同快照的已消费报价并核对数据库哈希。
   * @returns 外部编号或历史未计费 UUID；不依赖 Redis，不修改账务或发起 Provider 请求。
   * @throws 已计费快照缺少可靠映射、或出现多个映射时明确拒绝，不能误走历史豁免。
   */
  async resolveRunId(runId: string): Promise<string> {
    if (!databaseRunUuid.test(runId)) return runId;
    const row = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, projectId: true, userId: true, idempotencyKey: true, snapshot: true },
    });
    if (!row) return runId;
    if (row.idempotencyKey) {
      const digest = createHash('sha256')
        .update(`${row.projectId}\0${row.idempotencyKey}`)
        .digest('hex');
      const candidate = `run_idem_${digest}`;
      if (billingDatabaseRunId(candidate) === row.id) return candidate;
    }
    const snapshot = runSnapshotSchema.safeParse(row.snapshot);
    if (!snapshot.success || !Object.keys(snapshot.data.billingBindings ?? {}).length) return runId;
    if (row.userId) {
      const candidates = await this.prisma.billingQuote.findMany({
        where: {
          payerId: row.userId,
          requestHash: billingSnapshotHash(snapshot.data),
          consumedRunId: { not: null },
        },
        select: { consumedRunId: true },
      });
      const matches = [
        ...new Set(
          candidates.flatMap(({ consumedRunId }) =>
            consumedRunId && billingDatabaseRunId(consumedRunId) === row.id ? [consumedRunId] : [],
          ),
        ),
      ];
      if (matches.length === 1) return matches[0]!;
    }
    throw new BillingError('run_identity_unavailable', '运行账务身份无法确认，请核实原任务');
  }

  /** 序列化冲突只重试数据库事务；回调禁止网络请求、队列发布和 Provider 调用。 */
  private async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15_000,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))));
        if (attempt >= 4 || !retryable) throw error;
      }
    }
  }

  /** 首次读写建立零余额钱包并锁定；不从历史成本推导余额。 */
  private async lockWallet(tx: Prisma.TransactionClient, userId: string) {
    await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
    await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    return tx.wallet.findUniqueOrThrow({ where: { userId } });
  }

  /** 余额增量和流水原子写入；负余额、负冻结及溢出均拒绝。 */
  private async movement(
    tx: Prisma.TransactionClient,
    walletId: string,
    input: {
      key: string;
      kind: string;
      available: bigint;
      held: bigint;
      reason: string;
      actorId?: string;
      runId?: string;
      chargeItemId?: string;
      relatedEntryId?: string;
    },
  ) {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    const available = nanos(wallet.availableNanos.toFixed(0)) + input.available;
    const held = nanos(wallet.heldNanos.toFixed(0)) + input.held;
    if (available < 0n || held < 0n)
      throw new BillingError('insufficient_balance', '可用余额不足', 402);
    nanos(available.toString());
    nanos(held.toString());
    await tx.wallet.update({
      where: { id: walletId },
      data: {
        availableNanos: available.toString(),
        heldNanos: held.toString(),
        version: { increment: 1 },
      },
    });
    return tx.walletEntry.create({
      data: {
        walletId,
        kind: input.kind,
        idempotencyKey: input.key,
        availableDeltaNanos: input.available.toString(),
        heldDeltaNanos: input.held.toString(),
        availableAfterNanos: available.toString(),
        heldAfterNanos: held.toString(),
        reason: input.reason,
        actorId: input.actorId,
        runId: input.runId,
        chargeItemId: input.chargeItemId,
        relatedEntryId: input.relatedEntryId,
      },
    });
  }

  /** 查询自己的钱包；首次访问生成零余额账户，返回值不使用浮点金额。 */
  async getWallet(userId: string): Promise<WalletView> {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return {
      currency: 'CNY',
      availableNanos: wallet.availableNanos.toFixed(0),
      heldNanos: wallet.heldNanos.toFixed(0),
    };
  }

  /** 管理员发放/收回内部额度；同键异参拒绝，扣减不能动用冻结金额。 */
  async adjust(input: {
    userId: string;
    actorId: string;
    amountNanos: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const amount = nanos(input.amountNanos, true);
    if (!input.reason.trim() || !input.idempotencyKey.trim() || amount === 0n)
      throw new BillingError('invalid_adjustment', '调整需要非零金额、原因和幂等键', 400);
    return this.transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, input.userId);
      const key = `adjust:${input.idempotencyKey}`;
      const existing = await tx.walletEntry.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (
          existing.walletId !== wallet.id ||
          existing.actorId !== input.actorId ||
          existing.reason !== input.reason ||
          existing.availableDeltaNanos.toFixed(0) !== amount.toString()
        )
          throw new BillingError('idempotency_conflict', '幂等键已经用于另一笔额度调整');
        return existing;
      }
      return this.movement(tx, wallet.id, {
        key,
        kind: 'adjustment',
        available: amount,
        held: 0n,
        reason: input.reason,
        actorId: input.actorId,
      });
    });
  }

  /** 创建五分钟报价，不冻结也不排队；服务端调用方必须已验证执行计划及账户权限。 */
  async createQuote(input: { payerId: string; snapshot: RunSnapshot; items: QuoteItemInput[] }) {
    const expected = input.snapshot.nodes
      .filter((node) => node.data.mode !== 'source' && node.data.enabled !== false)
      .map((node) => node.id)
      .sort();
    const actual = input.items.map((item) => item.nodeId).sort();
    if (
      !actual.length ||
      new Set(actual).size !== actual.length ||
      JSON.stringify(expected) !== JSON.stringify(actual)
    )
      throw new BillingError('invalid_charge_plan', '报价必须覆盖所有实际执行节点', 400);
    const maximumNanos = input.items
      .reduce((sum, item) => sum + nanos(item.maximumNanos), 0n)
      .toString();
    nanos(maximumNanos);
    return this.prisma.billingQuote.create({
      data: {
        payerId: input.payerId,
        snapshot: input.snapshot as Prisma.InputJsonValue,
        requestHash: billingSnapshotHash(input.snapshot),
        items: input.items as Prisma.InputJsonValue,
        maximumNanos,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
  }

  /**
   * 同一事务提交 Run/输入、消费报价、冻结逐项余额和 outbox。persist 只能操作传入事务。
   * 报价过期、付款人或快照不匹配时完全回滚；重投必须恢复原 runId。
   */
  async commitSubmission(
    input: {
      payerId: string;
      quoteId: string;
      runId: string;
      snapshot: RunSnapshot;
      payload: Prisma.InputJsonValue;
      queueName: string;
    },
    persist: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    return this.transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, input.payerId);
      const quote = await tx.billingQuote.findUnique({ where: { id: input.quoteId } });
      const hash = billingSnapshotHash(input.snapshot);
      if (!quote || quote.payerId !== input.payerId)
        throw new BillingError('quote_not_found', '报价不存在', 404);
      if (quote.requestHash !== hash)
        throw new BillingError('quote_changed', '模型或参数已改变，请重新报价');
      const existingCharge = await tx.runCharge.findUnique({ where: { runId: input.runId } });
      if (existingCharge) {
        if (existingCharge.payerId !== input.payerId || existingCharge.requestHash !== hash)
          throw new BillingError('idempotency_conflict', '同一请求身份已经用于不同的运行或付款人');
        return existingCharge;
      }
      if (quote.consumedRunId) {
        if (quote.consumedRunId !== input.runId)
          throw new BillingError('quote_consumed', '报价已用于另一项任务');
        return tx.runCharge.findUniqueOrThrow({ where: { runId: input.runId } });
      }
      if (quote.expiresAt.getTime() <= Date.now())
        throw new BillingError('quote_expired', '报价已过期，请重新确认');
      const items = quote.items as unknown as QuoteItemInput[];
      const charge = await tx.runCharge.create({
        data: {
          runId: input.runId,
          payerId: input.payerId,
          quoteId: quote.id,
          requestHash: hash,
          maximumNanos: quote.maximumNanos,
        },
      });
      await persist(tx);
      for (const item of items) {
        const id = randomUUID();
        await tx.chargeItem.create({
          data: {
            id,
            runChargeId: charge.id,
            nodeId: item.nodeId,
            executionIdentity: `${input.runId}:${item.nodeId}`,
            platformModelId: item.platformModelId,
            bindingId: item.bindingId,
            pricingVersionId: item.pricingVersionId,
            pricingRule: item.pricingRule,
            quoteInput: item.quoteInput,
            maximumNanos: item.maximumNanos,
            providerCost: { create: {} },
          },
        });
        await this.movement(tx, wallet.id, {
          key: `hold:${id}`,
          kind: 'hold',
          available: -nanos(item.maximumNanos),
          held: nanos(item.maximumNanos),
          reason: '按已确认报价冻结',
          runId: input.runId,
          chargeItemId: id,
        });
      }
      await tx.billingQuote.update({
        where: { id: quote.id },
        data: { consumedRunId: input.runId },
      });
      await tx.runOutbox.create({
        data: { runId: input.runId, payload: input.payload, queueName: input.queueName },
      });
      return charge;
    });
  }

  /** 查询付款人自己的逐项账单，不暴露调用凭据、原始快照和供应商成本。 */
  async getRunCharge(runId: string, payerId: string) {
    runId = await this.resolveRunId(runId);
    const charge = await this.prisma.runCharge.findFirst({
      where: { runId, payerId },
      include: { items: true },
    });
    if (!charge) return undefined;
    return {
      runId,
      quoteId: charge.quoteId,
      currency: 'CNY',
      maximumNanos: charge.maximumNanos.toFixed(0),
      items: charge.items.map((item) => ({
        id: item.id,
        nodeId: item.nodeId,
        platformModelId: item.platformModelId,
        status: item.status,
        maximumNanos: item.maximumNanos.toFixed(0),
        settledNanos: item.settledNanos.toFixed(0),
        refundedNanos: item.refundedNanos.toFixed(0),
      })),
    };
  }

  /** 账单按账户固定过滤并限制页长；流水金额全部作为整数字符串返回。 */
  async listEntries(userId: string, page = 1) {
    return this.prisma.walletEntry.findMany({
      where: { wallet: { userId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 50,
      take: 50,
    });
  }

  /** Worker 在请求前验证冻结快照并记录发送意图；未知同步调用不能重新发送。 */
  async beginExecution(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    knownProviderRequestId?: string,
  ) {
    const charge = await this.prisma.runCharge.findUnique({ where: { runId } });
    if (!charge || charge.requestHash !== billingSnapshotHash(snapshot))
      throw new BillingError('execution_not_authorized', '任务没有与快照匹配的冻结授权');
    return this.transaction(async (tx) => {
      await this.lockWallet(tx, charge.payerId);
      const item = await tx.chargeItem.findUniqueOrThrow({
        where: { runChargeId_nodeId: { runChargeId: charge.id, nodeId } },
      });
      if (!['HELD', 'PENDING_VERIFICATION'].includes(item.status))
        throw new BillingError('charge_closed', '该收费项已经结算或释放');
      if (item.executionState !== 'unsent') {
        if (knownProviderRequestId && item.providerRequestId === knownProviderRequestId)
          return item;
        throw new BillingError('execution_unknown', '原调用结果待核实，禁止再次发起生成');
      }
      return tx.chargeItem.update({ where: { id: item.id }, data: { executionState: 'sending' } });
    });
  }

  /** 任务 ID 只能补齐或重复同值；不同 Provider 身份不能替换原付费调用。 */
  async recordProviderRequest(itemId: string, providerRequestId: string) {
    const updated = await this.prisma.chargeItem.updateMany({
      where: { id: itemId, OR: [{ providerRequestId: null }, { providerRequestId }] },
      data: { providerRequestId, executionState: 'sent' },
    });
    if (updated.count !== 1)
      throw new BillingError('provider_identity_conflict', '上游任务身份与原调用冲突');
  }

  /** 持久交付后按明确金额结算或释放；迟到事件只补证据，绝不再次冻结。 */
  async resolveItem(itemId: string, resolution: ChargeResolution) {
    const chargeNanos = nanos(resolution.chargeNanos);
    const first = await this.prisma.chargeItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { charge: true },
    });
    return this.transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, first.charge.payerId);
      const item = await tx.chargeItem.findUniqueOrThrow({ where: { id: itemId } });
      if (chargeNanos > nanos(item.maximumNanos.toFixed(0)))
        throw new BillingError('charge_exceeds_quote', '结算不能超过用户确认上限');
      if (['SETTLED', 'RELEASED', 'REFUNDED'].includes(item.status)) {
        if (
          item.status === 'SETTLED' &&
          resolution.status === 'SETTLED' &&
          item.settledNanos.toFixed(0) !== chargeNanos.toString()
        )
          await this.reconcile(
            tx,
            itemId,
            'settlement_conflict',
            '重复结算与已确认金额冲突，保留原消费',
          );
        if (resolution.evidence && !item.deliveryEvidence)
          await tx.chargeItem.update({
            where: { id: itemId },
            data: { deliveryEvidence: resolution.evidence },
          });
        return item;
      }
      if (resolution.status === 'PENDING_VERIFICATION') {
        await this.reconcile(tx, itemId, 'execution', resolution.reason);
      } else {
        if (resolution.status === 'RELEASED' && chargeNanos !== 0n)
          throw new BillingError('invalid_release', '释放操作不能扣费', 400);
        await this.movement(tx, wallet.id, {
          key: `resolve:${item.id}`,
          kind: resolution.status === 'SETTLED' ? 'settlement' : 'release',
          available: nanos(item.maximumNanos.toFixed(0)) - chargeNanos,
          held: -nanos(item.maximumNanos.toFixed(0)),
          reason: resolution.reason,
          runId: first.charge.runId,
          chargeItemId: item.id,
        });
        await tx.reconciliationItem.updateMany({
          where: { chargeItemId: itemId, kind: 'execution', status: 'open' },
          data: { status: 'resolved', resolution: resolution.reason, resolvedAt: new Date() },
        });
      }
      return tx.chargeItem.update({
        where: { id: itemId },
        data: {
          status: resolution.status,
          settledNanos:
            resolution.status === 'SETTLED' ? chargeNanos.toString() : item.settledNanos,
          ...(resolution.evidence
            ? { deliveryEvidence: resolution.evidence, executionState: 'delivered' }
            : {}),
          ...(resolution.usage ? { usage: resolution.usage } : {}),
        },
      });
    });
  }

  /** 已结算费用通过独立反向流水退款，重复键不重复入账，累计退款不超过结算。 */
  async refund(input: {
    itemId: string;
    amountNanos: string;
    actorId: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const amount = nanos(input.amountNanos);
    if (amount === 0n || !input.reason.trim())
      throw new BillingError('invalid_refund', '退款需要正金额及依据', 400);
    const first = await this.prisma.chargeItem.findUniqueOrThrow({
      where: { id: input.itemId },
      include: { charge: true },
    });
    return this.transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, first.charge.payerId);
      const key = `refund:${input.idempotencyKey}`;
      const existing = await tx.walletEntry.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (
          existing.chargeItemId !== input.itemId ||
          existing.availableDeltaNanos.toFixed(0) !== amount.toString() ||
          existing.actorId !== input.actorId ||
          existing.reason !== input.reason
        )
          throw new BillingError('idempotency_conflict', '幂等键已经用于另一笔退款');
        return existing;
      }
      const item = await tx.chargeItem.findUniqueOrThrow({ where: { id: input.itemId } });
      const refunded = nanos(item.refundedNanos.toFixed(0)) + amount;
      if (
        !['SETTLED', 'REFUNDED'].includes(item.status) ||
        refunded > nanos(item.settledNanos.toFixed(0))
      )
        throw new BillingError('refund_exceeds_charge', '退款超过已结算金额');
      const entry = await this.movement(tx, wallet.id, {
        key,
        kind: 'refund',
        available: amount,
        held: 0n,
        reason: input.reason,
        actorId: input.actorId,
        runId: first.charge.runId,
        chargeItemId: item.id,
      });
      await tx.chargeItem.update({
        where: { id: item.id },
        data: {
          refundedNanos: refunded.toString(),
          status: refunded === nanos(item.settledNanos.toFixed(0)) ? 'REFUNDED' : 'SETTLED',
        },
      });
      return entry;
    });
  }

  /** 保存独立成本事实；金额冲突进入对账，不覆盖首条确认事实。 */
  async recordCost(itemId: string, cost?: ProviderCostFact) {
    if (cost) validateProviderCost(cost);
    return this.transaction(async (tx) => {
      const item = await tx.chargeItem.findUniqueOrThrow({
        where: { id: itemId },
        include: { charge: true },
      });
      await this.lockWallet(tx, item.charge.payerId);
      const current = await tx.providerCost.findUniqueOrThrow({ where: { chargeItemId: itemId } });
      if (!cost) {
        if (['confirmed', 'disputed', 'adjudicated'].includes(current.status)) return current;
        await this.reconcile(tx, itemId, 'provider_cost', '上游没有提供明确成本');
        return tx.providerCost.update({
          where: { id: current.id },
          data: { status: 'pending_reconciliation' },
        });
      }
      const evidence = readCostEvidence(current.evidence);
      const normalized = { ...cost, amount: new Prisma.Decimal(cost.amount).toFixed() };
      const observed = evidence.observations.some(
        (fact) => fact.amount === normalized.amount && fact.currency === normalized.currency,
      );
      if (!observed) {
        evidence.observations.push({ ...normalized, recordedAt: new Date().toISOString() });
        await tx.accountAudit.create({
          data: {
            ownerId: item.charge.payerId,
            targetId: itemId,
            action: 'billing.provider_cost_observed',
            summary: JSON.stringify(normalized),
          },
        });
      }
      if (
        current.amount &&
        (!current.amount.equals(cost.amount) || current.currency !== cost.currency)
      ) {
        // 裁决后重放已记录事实不重新制造争议，只有新的冲突才需再次人工核实。
        if (current.status === 'adjudicated' && observed) return current;
        await this.reconcile(tx, itemId, 'provider_cost', '上游返回相互冲突的成本事实');
        return tx.providerCost.update({
          where: { id: current.id },
          data: { status: 'disputed', evidence: evidence as unknown as Prisma.InputJsonValue },
        });
      }
      if (current.status === 'disputed' || current.status === 'adjudicated') return current;
      const updated = await tx.providerCost.update({
        where: { id: current.id },
        data: {
          status: 'confirmed',
          ...(current.amount === null ? normalized : {}),
          evidence: evidence as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.reconciliationItem.updateMany({
        where: { chargeItemId: itemId, kind: 'provider_cost', status: 'open' },
        data: { status: 'resolved', resolution: '供应商补齐明确成本事实', resolvedAt: new Date() },
      });
      return updated;
    });
  }

  /**
   * 管理员裁决、钱包释放和事项关闭在同一钱包锁事务提交。
   * 成本裁决写独立证据并保留首条供应商事实；并发处理只允许一份决策成功。
   */
  async resolveReconciliation(input: {
    id: string;
    actorId: string;
    action: 'release' | 'confirm_cost';
    reason: string;
    amount?: string;
    currency?: string;
  }) {
    if (!input.reason.trim() || input.reason.length > 1000)
      throw new BillingError('invalid_resolution', '核实需要明确的处理依据', 400);
    if (input.action === 'confirm_cost') {
      if (!input.amount || !input.currency)
        throw new BillingError('invalid_resolution', '确认成本需要金额、币种和依据', 400);
      validateProviderCost({
        amount: input.amount,
        currency: input.currency,
        source: 'admin_verified',
      });
    }
    const first = await this.prisma.reconciliationItem.findUnique({ where: { id: input.id } });
    if (!first) throw new BillingError('not_found', '待核实事项不存在', 404);
    const firstItem = await this.prisma.chargeItem.findUniqueOrThrow({
      where: { id: first.chargeItemId },
      include: { charge: true },
    });
    return this.transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, firstItem.charge.payerId);
      const reconciliation = await tx.reconciliationItem.findUniqueOrThrow({
        where: { id: input.id },
      });
      if (reconciliation.status !== 'open')
        throw new BillingError('already_resolved', '事项已经处理，请刷新后查看结果');
      const item = await tx.chargeItem.findUniqueOrThrow({
        where: { id: reconciliation.chargeItemId },
      });
      const decidedAt = new Date();
      if (input.action === 'release') {
        if (
          reconciliation.kind !== 'execution' ||
          !['HELD', 'PENDING_VERIFICATION'].includes(item.status)
        )
          throw new BillingError('invalid_resolution', '当前事项或收费状态不允许释放冻结', 400);
        const evidence = item.deliveryEvidence;
        const archived =
          evidence !== null &&
          typeof evidence === 'object' &&
          !Array.isArray(evidence) &&
          evidence.deliveryState === 'archived';
        const recovery = await tx.reconciliationItem.findUnique({
          where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'worker_recovery' } },
          select: { status: true },
        });
        if (archived || recovery?.status === 'open')
          throw new BillingError(
            'invalid_resolution',
            '已交付任务必须恢复原账务，不能释放冻结',
            400,
          );
        await this.movement(tx, wallet.id, {
          key: `resolve:${item.id}`,
          kind: 'release',
          available: nanos(item.maximumNanos.toFixed(0)),
          held: -nanos(item.maximumNanos.toFixed(0)),
          reason: input.reason,
          actorId: input.actorId,
          runId: firstItem.charge.runId,
          chargeItemId: item.id,
        });
        await tx.chargeItem.update({ where: { id: item.id }, data: { status: 'RELEASED' } });
      } else {
        if (reconciliation.kind !== 'provider_cost')
          throw new BillingError('invalid_resolution', '此事项不能通过成本确认关闭', 400);
        const cost = await tx.providerCost.findUniqueOrThrow({ where: { chargeItemId: item.id } });
        const evidence = readCostEvidence(cost.evidence);
        evidence.decision = {
          amount: new Prisma.Decimal(input.amount!).toFixed(),
          currency: input.currency!,
          actorId: input.actorId,
          reason: input.reason,
          decidedAt: decidedAt.toISOString(),
        };
        await tx.providerCost.update({
          where: { id: cost.id },
          data: {
            status: cost.amount === null ? 'confirmed' : 'adjudicated',
            ...(cost.amount === null
              ? {
                  amount: evidence.decision.amount,
                  currency: input.currency,
                  source: 'admin_verified',
                }
              : {}),
            evidence: evidence as unknown as Prisma.InputJsonValue,
          },
        });
      }
      const resolved = await tx.reconciliationItem.update({
        where: { id: input.id },
        data: {
          status: 'resolved',
          resolution: input.reason,
          resolvedBy: input.actorId,
          resolvedAt: decidedAt,
        },
      });
      await tx.accountAudit.create({
        data: {
          actorId: input.actorId,
          ownerId: firstItem.charge.payerId,
          targetId: input.id,
          action: 'billing.reconciliation_resolved',
          summary: JSON.stringify({
            chargeItemId: item.id,
            action: input.action,
            reason: input.reason,
            ...(input.action === 'confirm_cost'
              ? { amount: new Prisma.Decimal(input.amount!).toFixed(), currency: input.currency }
              : {}),
          }),
        },
      });
      return resolved;
    });
  }

  /** 24小时未核实列为逾期待处理，不据此自动释放、补扣或重发。 */
  private async reconcile(
    tx: Prisma.TransactionClient,
    chargeItemId: string,
    kind: string,
    reason: string,
  ) {
    const existing = await tx.reconciliationItem.findUnique({
      where: { chargeItemId_kind: { chargeItemId, kind } },
    });
    if (existing?.status === 'resolved') {
      await tx.accountAudit.create({
        data: {
          targetId: existing.id,
          action: 'billing.reconciliation_reopened',
          summary: JSON.stringify({
            chargeItemId,
            kind,
            reason,
            previousResolution: existing.resolution,
            previousResolvedBy: existing.resolvedBy,
            previousResolvedAt: existing.resolvedAt?.toISOString(),
          }),
        },
      });
    }
    return tx.reconciliationItem.upsert({
      where: { chargeItemId_kind: { chargeItemId, kind } },
      create: { chargeItemId, kind, reason, dueAt: new Date(Date.now() + 24 * 60 * 60_000) },
      update: {
        reason,
        ...(existing?.status === 'resolved'
          ? {
              status: 'open',
              resolution: null,
              resolvedBy: null,
              resolvedAt: null,
              dueAt: new Date(Date.now() + 24 * 60 * 60_000),
            }
          : {}),
      },
    });
  }
}

/** 原币种金额遵循 Decimal(38,12)，接受供应商数值转成的指数文本但不允许精度舍入。 */
function validateProviderCost(cost: ProviderCostFact): void {
  if (
    cost.amount.length > 100 ||
    !/^(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(cost.amount) ||
    !/^[A-Z]{3}$/.test(cost.currency) ||
    !cost.source.trim() ||
    cost.source.length > 100
  )
    throw new BillingError('invalid_provider_cost', '上游成本金额、币种或来源无效', 400);
  const amount = new Prisma.Decimal(cost.amount);
  if (!amount.isFinite() || amount.decimalPlaces() > 12 || amount.greaterThanOrEqualTo('1e26'))
    throw new BillingError('invalid_provider_cost', '上游成本超出可保存的金额精度', 400);
}

/** 读取本模块的成本证据；保留已观察事实供裁决后的重复通知去重。 */
function readCostEvidence(value: Prisma.JsonValue | null): ProviderCostEvidence {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const observations = Array.isArray(record.observations) ? record.observations : [];
  return {
    observations: observations.filter(
      (item): item is ProviderCostEvidence['observations'][number] =>
        Boolean(
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof item.amount === 'string' &&
          typeof item.currency === 'string' &&
          typeof item.source === 'string' &&
          typeof item.recordedAt === 'string',
        ),
    ),
    ...(record.decision && typeof record.decision === 'object' && !Array.isArray(record.decision)
      ? { decision: record.decision as ProviderCostEvidence['decision'] }
      : {}),
  };
}

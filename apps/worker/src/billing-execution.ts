import {
  BillingError,
  PrismaBillingService,
  billingSnapshotHash,
} from '@multimodal-canvas/billing';
import {
  billingQuoteCalculationSchema,
  billingSecondsSchema,
  calculateBillingSettlement,
  runSnapshotSchema,
  type BillingQuoteCalculation,
  type BillingUsage,
  type ProviderJob,
  type RunResult,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { NewApiProviderError } from '@multimodal-canvas/providers';
import type { Prisma } from '@prisma/client';
import { databaseRunId } from './prisma-persistence';

/** Worker 的逐项账务边界；所有方法使用完整冻结快照，不能传入节点子快照。 */
export interface WorkerBilling {
  /** 核对持久授权；仅迁移前已经落库且快照一致的历史运行免追扣。 */
  authorizeRun(runId: string, snapshot: RunSnapshot): Promise<void>;
  /** 在调用 Provider 前原子记录发送意图；已有异步任务只能携原任务 ID 恢复。 */
  begin(runId: string, nodeId: string, snapshot: RunSnapshot, taskId?: string): Promise<void>;
  /** 保存真实上游任务 ID；不同身份不能替换原调用。 */
  recordRequest(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    taskId: string,
  ): Promise<void>;
  /** 记录已收到响应的供应商原币种成本；不依赖归档，也不结算或释放用户冻结。 */
  recordCost(runId: string, nodeId: string, snapshot: RunSnapshot, job: ProviderJob): Promise<void>;
  /** 归档证据持久化后结算用户，再独立记录成本；重复执行不重复扣款。 */
  deliver(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    result: RunResult,
    job: ProviderJob,
  ): Promise<void>;
  /** 释放未发送项；未知请求保持冻结，明确供应商失败才释放已发送项。 */
  interrupt(runId: string, snapshot: RunSnapshot, nodeId?: string, error?: unknown): Promise<void>;
  /** 自动账务恢复耗尽，保存已交付证据与独立恢复事项，不释放或重复扣款。 */
  deferDelivery(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    job: ProviderJob,
  ): Promise<void>;
}

/** 将已有钱包服务接入 Worker，用户结算与上游成本各自保留可恢复状态。 */
export class PrismaWorkerBilling implements WorkerBilling {
  constructor(private readonly billing: PrismaBillingService) {}

  /** 已归档结果的本地记账失败只进入运维恢复；理由不包含供应商错误正文或凭据。 */
  async deferDelivery(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    job: ProviderJob,
  ): Promise<void> {
    const item = await this.readItem(runId, nodeId, snapshot);
    if (!item) return;
    const evidence = {
      nodeId,
      providerJobId: job.id,
      deliveryState: 'archived',
      ...(job.payload?.result && typeof job.payload.result === 'object'
        ? { result: job.payload.result }
        : {}),
    } as Prisma.InputJsonValue;
    const reason =
      '结果已归档，Worker 自动账务恢复次数耗尽；需按原 Run 恢复，禁止重新调用或直接释放';
    if (['HELD', 'PENDING_VERIFICATION'].includes(item.status))
      await this.billing.resolveItem(item.id, {
        status: 'PENDING_VERIFICATION',
        chargeNanos: '0',
        reason,
        evidence,
      });
    await this.billing.prisma.reconciliationItem.upsert({
      where: { chargeItemId_kind: { chargeItemId: item.id, kind: 'worker_recovery' } },
      create: {
        chargeItemId: item.id,
        kind: 'worker_recovery',
        reason,
        dueAt: new Date(Date.now() + 86_400_000),
      },
      update: { status: 'open', reason, resolvedAt: null, resolution: null },
    });
  }

  /** 验证整份执行计划与报价相同；历史豁免依据数据库时间，不信任浏览器提交时间。 */
  private async readCharge(runId: string, snapshot: RunSnapshot) {
    const charge = await this.billing.prisma.runCharge.findUnique({
      where: { runId },
      include: { items: true },
    });
    if (charge) {
      if (charge.requestHash !== billingSnapshotHash(snapshot))
        throw new BillingError('execution_not_authorized', '任务快照与冻结授权不一致');
      for (const item of charge.items) {
        const binding = snapshot.billingBindings?.[item.nodeId];
        if (
          !binding ||
          binding.bindingId !== item.bindingId ||
          binding.platformModelId !== item.platformModelId ||
          binding.pricingVersionId !== item.pricingVersionId
        )
          throw new BillingError('binding_changed', '任务的冻结模型绑定或价格不一致');
      }
      return charge;
    }
    const [activation, run] = await Promise.all([
      this.billing.prisma.billingActivation.findUnique({ where: { id: 'singleton' } }),
      this.billing.prisma.run.findUnique({
        where: { id: databaseRunId(runId) },
        select: { createdAt: true, snapshot: true },
      }),
    ]);
    const stored = runSnapshotSchema.safeParse(run?.snapshot);
    if (
      activation &&
      run &&
      run.createdAt < activation.createdAt &&
      stored.success &&
      billingSnapshotHash(stored.data) === billingSnapshotHash(snapshot)
    )
      return undefined;
    throw new BillingError('execution_not_authorized', '新任务缺少冻结授权，禁止发起生成');
  }

  /** 查找特定节点的原收费项；缺项属于授权错误，不允许免费执行。 */
  private async readItem(runId: string, nodeId: string, snapshot: RunSnapshot) {
    const charge = await this.readCharge(runId, snapshot);
    if (!charge) return undefined;
    const item = charge.items.find((candidate) => candidate.nodeId === nodeId);
    if (!item) throw new BillingError('execution_not_authorized', '执行节点没有冻结收费项');
    return item;
  }

  /** 校验所有计划节点都有冻结授权；历史豁免运行不创建账务记录。 */
  async authorizeRun(runId: string, snapshot: RunSnapshot): Promise<void> {
    const charge = await this.readCharge(runId, snapshot);
    if (!charge) return;
    for (const node of snapshot.nodes.filter(
      (candidate) => candidate.data.mode !== 'source' && candidate.data.enabled !== false,
    )) {
      if (!charge.items.some((item) => item.nodeId === node.id))
        throw new BillingError('execution_not_authorized', '执行计划缺少逐项冻结授权');
    }
  }

  /** 只为首次请求写发送意图，或凭已持久任务 ID 恢复查询；未知同步请求拒绝重发。 */
  async begin(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    taskId?: string,
  ): Promise<void> {
    const item = await this.readItem(runId, nodeId, snapshot);
    if (!item) return;
    // ProviderJob 已保存而钱包补写失败时，只能补齐该持久任务 ID，再继续查询。
    if (taskId && !item.providerRequestId && item.executionState !== 'unsent')
      await this.billing.recordProviderRequest(item.id, taskId);
    await this.billing.beginExecution(runId, nodeId, snapshot, taskId);
  }

  /** 记录供应商创建成功后的真实任务 ID，金额与售价均不在此处改变。 */
  async recordRequest(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    taskId: string,
  ): Promise<void> {
    const item = await this.readItem(runId, nodeId, snapshot);
    if (item) await this.billing.recordProviderRequest(item.id, taskId);
  }

  /** 已知响应成本与是否交付无关；失败由原请求回执恢复，不重发供应商请求。 */
  async recordCost(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    job: ProviderJob,
  ): Promise<void> {
    const item = await this.readItem(runId, nodeId, snapshot);
    if (!item) return;
    const reported = record(job.payload?.reportedUsage);
    const amount = reported?.amount;
    const currency = reported?.currency;
    const cost =
      (typeof amount === 'string' || typeof amount === 'number') && typeof currency === 'string'
        ? { amount: String(amount), currency, source: 'provider_reported' }
        : undefined;
    await this.billing.recordCost(item.id, cost);
  }

  /** 按冻结报价结算已归档交付；成本故障独立抛出，恢复时只重复幂等账务写入。 */
  async deliver(
    runId: string,
    nodeId: string,
    snapshot: RunSnapshot,
    result: RunResult,
    job: ProviderJob,
  ): Promise<void> {
    const item = await this.readItem(runId, nodeId, snapshot);
    if (!item) return;
    const target = snapshot.nodes.find((node) => node.id === nodeId);
    if (
      !target ||
      result.targetNodeId !== nodeId ||
      result.mediaType !== target.data.mediaType ||
      !(
        result.asset?.version ||
        (snapshot.reversePrompt && result.reversePrompt) ||
        (snapshot.promptOptimization && result.promptOptimization)
      )
    )
      throw new BillingError('delivery_unverified', '交付结果缺少归档证据或与收费节点不一致');
    const evidence = {
      nodeId,
      ...(result.asset?.version
        ? { assetId: result.asset.assetId, version: result.asset.version }
        : {}),
      ...(result.reversePrompt ? { resultType: 'reverse_prompt' } : {}),
      ...(result.promptOptimization ? { resultType: 'prompt_optimization' } : {}),
      ...(job.platformJobId ? { providerTaskId: job.platformJobId } : {}),
    };
    const quote = billingQuoteCalculationSchema.parse(item.quoteInput);
    if (quote.capNanos !== item.maximumNanos.toFixed(0))
      throw new BillingError('quote_changed', '收费项的冻结上限与报价不一致');
    const usage = await this.meterUsage(quote, result, job);
    const settlement = calculateBillingSettlement({
      quote,
      delivery: 'delivered',
      ...(usage ? { usage } : {}),
    });
    await this.billing.resolveItem(item.id, {
      status: settlement.status === 'settled' ? 'SETTLED' : 'PENDING_VERIFICATION',
      chargeNanos: settlement.chargeNanos,
      reason:
        settlement.status === 'settled'
          ? settlement.capped
            ? '已交付，按用户确认上限封顶结算'
            : '按已交付结果和冻结售价结算'
          : `已交付，计量待核实：${settlement.status === 'pending_verification' ? settlement.reason : 'unknown'}`,
      evidence: { ...evidence, settlement } as Prisma.InputJsonValue,
      ...(usage ? { usage: usage as Prisma.InputJsonValue } : {}),
    });
    // 成本缺失只建立成本对账；即使下面写入失败，上面的用户结算已独立完成。
    await this.recordCost(runId, nodeId, snapshot, job);
    await this.billing.prisma.reconciliationItem.updateMany({
      where: { chargeItemId: item.id, kind: 'worker_recovery', status: 'open' },
      data: {
        status: 'resolved',
        resolution: '已按原 Run 归档证据恢复账务',
        resolvedAt: new Date(),
      },
    });
  }

  /** 只用可验证的输入或交付计量；报价时长、未知单位字段及上游金额均不作实际用量。 */
  private async meterUsage(
    quote: BillingQuoteCalculation,
    result: RunResult,
    job: ProviderJob,
  ): Promise<BillingUsage | undefined> {
    if (quote.rule.unit === 'per_call') return undefined;
    if (quote.rule.unit === 'per_image' && result.mediaType === 'image' && result.asset?.version)
      return { source: 'output_metadata', reliable: true, images: 1 };
    if (quote.rule.unit === 'per_character' && quote.characters !== undefined)
      return { source: 'input_characters', reliable: true, characters: quote.characters };
    const metadata = record(job.payload?.usage);
    if (quote.rule.unit === 'per_token') {
      const inputTokens = count(metadata?.prompt_tokens);
      const outputTokens = count(metadata?.completion_tokens);
      if (inputTokens !== undefined && outputTokens !== undefined)
        return { source: 'provider_usage', reliable: true, inputTokens, outputTokens };
    }
    if (
      quote.rule.unit === 'per_second' &&
      quote.rule.meteringSource === 'output_metadata' &&
      result.asset?.version
    ) {
      const version = await this.billing.prisma.assetVersion.findUnique({
        where: {
          assetId_version: { assetId: result.asset.assetId, version: result.asset.version },
        },
        select: { metadata: true },
      });
      const assetMetadata = record(version?.metadata);
      const duration = assetMetadata?.durationSeconds;
      const seconds = billingSecondsSchema.safeParse(String(duration));
      if (
        assetMetadata?.metadataStatus === 'ready' &&
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration > 0 &&
        seconds.success
      )
        return { source: 'output_metadata', reliable: true, durationsSeconds: [seconds.data] };
    }
    return undefined;
  }

  /** 本地终止只释放数据库确认未发送的项；已交付项与未知上游请求不据此退款。 */
  async interrupt(
    runId: string,
    snapshot: RunSnapshot,
    nodeId?: string,
    error?: unknown,
  ): Promise<void> {
    const charge = await this.readCharge(runId, snapshot);
    if (!charge) return;
    for (const item of charge.items) {
      if (!['HELD', 'PENDING_VERIFICATION'].includes(item.status)) continue;
      // 已交付但缺计量的项继续待核实，不能被后续节点失败或本地取消释放。
      if (item.deliveryEvidence) continue;
      const unsent = item.executionState === 'unsent';
      const rejected = item.nodeId === nodeId && isDefiniteBillingFailure(error);
      await this.billing.resolveItem(item.id, {
        status: unsent || rejected ? 'RELEASED' : 'PENDING_VERIFICATION',
        chargeNanos: '0',
        reason: unsent
          ? '该子调用尚未发送，释放冻结'
          : rejected
            ? '供应商明确拒绝或确认任务失败，释放冻结'
            : '请求已发送或结果不确定，等待核实',
      });
    }
  }
}

/** HTTP 明确拒绝或可信异步终态才代表失败；超时、取消和本地持久化错误均属未知。 */
export function isDefiniteBillingFailure(error: unknown): boolean {
  if (!(error instanceof NewApiProviderError)) return false;
  const providerStatus = record(error.providerPayload)?.providerStatus;
  if (
    typeof providerStatus === 'string' &&
    ['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(providerStatus.toLowerCase())
  )
    return true;
  // 已创建任务的 GET 404/权限变化不能证明生成失败，仍需核实原任务。
  if (error.platformJobId) return false;
  return (
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429, 499].includes(error.status)
  );
}

/** 金额和计量字段只接受对象，数组及空值不视为证据。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 供应商明确计量必须为非负安全整数，不能通过数值字符串或浮点估算推导。 */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

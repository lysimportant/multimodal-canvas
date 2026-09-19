import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BillingError, type PrismaBillingService } from '@multimodal-canvas/billing';
import { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from './auth-service';

/** 管理账务列表只读取收费身份与金额，不加载调用凭据、提示词或完整运行快照。 */
const chargeItemSummary = {
  id: true,
  nodeId: true,
  platformModelId: true,
  status: true,
  maximumNanos: true,
  settledNanos: true,
  refundedNanos: true,
  createdAt: true,
  charge: { select: { runId: true, payerId: true } },
  providerCost: { select: { status: true, amount: true, currency: true, source: true } },
} satisfies Prisma.ChargeItemSelect;

/** 所有账务接口使用真实可撤销会话，服务 Token 不能指定付款人或调整余额。 */
export function registerBillingRoutes(
  app: FastifyInstance,
  options: {
    billing?: PrismaBillingService;
    sessions: WeakMap<object, AuthenticatedSession>;
  },
): void {
  /** 钱包整数与原币种小数均输出完整十进制文本，避免 Decimal 默认 JSON 的指数表示。 */
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (
      !/^\/v1\/(?:account\/(?:wallet|billing)|admin\/(?:wallets|charge-items)|runs\/[^/]+\/charge)/.test(
        request.url,
      )
    )
      return payload;
    return monetaryJson(payload);
  });
  /** API 只映射已知业务错误，数据库不可用交由统一异常处理。 */
  const handler =
    (operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try {
        return await operation(request, reply);
      } catch (error) {
        if (error instanceof z.ZodError)
          return reply.code(400).send({ code: 'invalid_input', error: '输入字段不符合要求' });
        if (error instanceof BillingError)
          return reply.code(error.status).send({ code: error.code, error: error.message });
        throw error;
      }
    };
  /** 身份取自会话，不读取用户自报的钱包归属。 */
  const actor = (request: FastifyRequest, admin = false) => {
    const current = options.sessions.get(request);
    if (!current) throw new BillingError('session_required', '请先登录', 401);
    if (admin && current.user.role !== 'admin')
      throw new BillingError('admin_required', '仅管理员可以操作', 403);
    return current.user;
  };
  /** 未配置持久账务时明确提示不可用，不能静默落到内存收费。 */
  const service = () => {
    if (!options.billing)
      throw new BillingError('billing_unavailable', '请配置数据库与持久任务队列', 503);
    return options.billing;
  };
  app.get(
    '/v1/account/wallet',
    handler(async (request) => ({ wallet: await service().getWallet(actor(request).id) })),
  );
  app.get(
    '/v1/account/billing',
    handler(async (request) => {
      const user = actor(request);
      const { page } = z
        .object({ page: z.coerce.number().int().min(1).max(100_000).default(1) })
        .strict()
        .parse(request.query);
      return {
        currency: 'CNY',
        page,
        pageSize: 50,
        entries: await service().listEntries(user.id, page),
      };
    }),
  );
  app.get(
    '/v1/runs/:runId/charge',
    handler(async (request, reply) => {
      const user = actor(request);
      const { runId } = z.object({ runId: z.string().min(1).max(200) }).parse(request.params);
      const charge = await service().getRunCharge(runId, user.id);
      return charge
        ? { charge }
        : reply.code(404).send({ code: 'charge_not_found', error: '账单不存在' });
    }),
  );
  app.get(
    '/v1/admin/wallets/:userId',
    handler(async (request) => {
      actor(request, true);
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      return { wallet: await service().getWallet(userId) };
    }),
  );
  app.post(
    '/v1/admin/wallets/:userId/adjust',
    handler(async (request) => {
      const user = actor(request, true);
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          amountNanos: z.string().regex(/^-?(0|[1-9]\d{0,37})$/),
          reason: z.string().trim().min(1).max(1000),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
        .parse(request.body);
      return {
        entry: await service().adjust({ ...body, userId, actorId: user.id }),
        wallet: await service().getWallet(userId),
      };
    }),
  );
  app.get(
    '/v1/admin/charge-items',
    handler(async (request) => {
      actor(request, true);
      const { page, runId } = z
        .object({
          page: z.coerce.number().int().min(1).max(100_000).default(1),
          runId: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .parse(request.query);
      const items = await service().prisma.chargeItem.findMany({
        where: runId ? { charge: { runId } } : {},
        select: chargeItemSummary,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * 50,
        take: 51,
      });
      return { items: items.slice(0, 50), page, pageSize: 50, hasMore: items.length > 50 };
    }),
  );
  app.get(
    '/v1/admin/charge-items/:id',
    handler(async (request, reply) => {
      actor(request, true);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { historyPage } = z
        .object({ historyPage: z.coerce.number().int().min(1).max(100_000).default(1) })
        .strict()
        .parse(request.query);
      const detail = await service().prisma.$transaction(
        async (tx) => {
          const item = await tx.chargeItem.findUnique({
            where: { id },
            select: {
              ...chargeItemSummary,
              bindingId: true,
              pricingVersionId: true,
              executionState: true,
              providerRequestId: true,
              deliveryEvidence: true,
              usage: true,
              updatedAt: true,
              providerCost: {
                select: {
                  status: true,
                  amount: true,
                  currency: true,
                  source: true,
                  evidence: true,
                  updatedAt: true,
                },
              },
            },
          });
          if (!item) return null;
          const delivery = metadataRecord(item.deliveryEvidence);
          const usage = metadataRecord(item.usage);
          const costEvidence = metadataRecord(item.providerCost?.evidence);
          const reconciliation = await tx.reconciliationItem.findMany({
            where: { chargeItemId: id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          const history = await tx.accountAudit.findMany({
            where: {
              targetId: { in: [id, ...reconciliation.map((entry) => entry.id)] },
              action: { startsWith: 'billing.' },
            },
            select: { id: true, actorId: true, action: true, summary: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (historyPage - 1) * 50,
            take: 51,
          });
          return {
            item: {
              ...item,
              deliveryEvidence: delivery
                ? {
                    ...scalarFields(delivery, [
                      'nodeId',
                      'assetId',
                      'version',
                      'resultType',
                      'providerTaskId',
                      'providerJobId',
                      'deliveryState',
                    ]),
                    ...(delivery.settlement
                      ? {
                          settlement: scalarFields(delivery.settlement, [
                            'status',
                            'chargeNanos',
                            'uncappedChargeNanos',
                            'releaseNanos',
                            'reason',
                            'capped',
                          ]),
                        }
                      : {}),
                  }
                : null,
              usage: usage
                ? {
                    ...scalarFields(usage, [
                      'source',
                      'reliable',
                      'images',
                      'inputTokens',
                      'outputTokens',
                      'characters',
                    ]),
                    ...(Array.isArray(usage.durationsSeconds)
                      ? {
                          durationsSeconds: usage.durationsSeconds.filter(
                            (value) => typeof value === 'string',
                          ),
                        }
                      : {}),
                  }
                : null,
              providerCost: item.providerCost
                ? {
                    ...item.providerCost,
                    evidence: costEvidence
                      ? {
                          observations: Array.isArray(costEvidence.observations)
                            ? costEvidence.observations.map((fact) =>
                                scalarFields(fact, ['amount', 'currency', 'source', 'recordedAt']),
                              )
                            : [],
                          ...(costEvidence.decision
                            ? {
                                decision: scalarFields(costEvidence.decision, [
                                  'amount',
                                  'currency',
                                  'actorId',
                                  'reason',
                                  'decidedAt',
                                ]),
                              }
                            : {}),
                        }
                      : null,
                  }
                : null,
            },
            reconciliation,
            history: history
              .slice(0, 50)
              .map((entry) => ({ ...entry, summary: auditSummary(entry.summary) })),
            historyPage,
            historyPageSize: 50,
            hasMoreHistory: history.length > 50,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      return detail ?? reply.code(404).send({ code: 'charge_not_found', error: '收费项不存在' });
    }),
  );
  app.get(
    '/v1/admin/reconciliation',
    handler(async (request) => {
      actor(request, true);
      const { page } = z
        .object({ page: z.coerce.number().int().min(1).max(100_000).default(1) })
        .strict()
        .parse(request.query);
      const items = await service().prisma.reconciliationItem.findMany({
        where: { status: 'open' },
        orderBy: { dueAt: 'asc' },
        skip: (page - 1) * 50,
        take: 50,
      });
      return {
        items: items.map((item) => ({ ...item, overdue: item.dueAt.getTime() <= Date.now() })),
        page,
        pageSize: 50,
      };
    }),
  );
  app.post(
    '/v1/admin/reconciliation/:id/resolve',
    handler(async (request) => {
      const user = actor(request, true);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          action: z.enum(['release', 'confirm_cost']),
          reason: z.string().trim().min(1).max(1000),
          amount: z.string().optional(),
          currency: z.string().optional(),
        })
        .strict()
        .parse(request.body);
      return {
        item: await service().resolveReconciliation({ id, actorId: user.id, ...body }),
      };
    }),
  );
  app.post(
    '/v1/admin/charge-items/:id/refund',
    handler(async (request) => {
      const user = actor(request, true);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          amountNanos: z.string().regex(/^(0|[1-9]\d{0,37})$/),
          reason: z.string().trim().min(1).max(1000),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
        .parse(request.body);
      return { entry: await service().refund({ ...body, itemId: id, actorId: user.id }) };
    }),
  );
}

/** 证据投影只接受 JSON 对象，防止恢复快照正文及供应商附带字段进入核账界面。 */
function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 只保留明确的标量证据；对象和数组需要各自的嵌套白名单，不能直接透传。 */
function scalarFields(value: unknown, fields: string[]): Record<string, unknown> {
  const record = metadataRecord(value) ?? {};
  return Object.fromEntries(
    fields
      .filter(
        (key) =>
          Object.hasOwn(record, key) &&
          (record[key] === null || ['string', 'number', 'boolean'].includes(typeof record[key])),
      )
      .map((key) => [key, record[key]]),
  );
}

/** 历史仅回显账务事实与决策字段；无法解析的旧摘要不作为安全结构化证据回显。 */
function auditSummary(summary: string): string {
  try {
    return JSON.stringify(
      scalarFields(JSON.parse(summary), [
        'chargeItemId',
        'action',
        'kind',
        'reason',
        'amount',
        'currency',
        'source',
        'previousResolution',
        'previousResolvedBy',
        'previousResolvedAt',
      ]),
    );
  } catch {
    return JSON.stringify({ reason: '历史摘要不符合结构化账务合同，请从审计存档核实' });
  }
}

/** 递归转换账务响应的 Decimal 和 Date；仅 nanos 字段使用整数精度。 */
function monetaryJson(value: unknown, field = ''): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value))
    return field.endsWith('Nanos') ? value.toFixed(0) : value.toFixed();
  if (Array.isArray(value)) return value.map((item) => monetaryJson(item, field));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, monetaryJson(item, key)]),
    );
  return value;
}

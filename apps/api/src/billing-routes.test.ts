/** 账务路由保留会话边界、原子裁决入口与金额序列化精度。 */
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type { PrismaBillingService } from '@multimodal-canvas/billing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSession } from './auth-service';
import { registerBillingRoutes } from './billing-routes';

/** 测试仅使用合成身份与未联网的账务替身。 */
const actorId = '11111111-1111-4111-8111-111111111111';
/** 测试结束关闭所有本地 Fastify 实例。 */
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** 模拟 app 已验证的真实用户会话，Bearer 服务 token 不产生账户身份。 */
function fixture() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const sessions = new WeakMap<object, AuthenticatedSession>();
  app.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    if (role !== 'admin' && role !== 'user') return;
    sessions.set(request, {
      user: {
        id: actorId,
        role,
        email: 'synthetic@example.invalid',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      session: {
        id: actorId,
        userId: actorId,
        tokenHash: 'synthetic-only',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      },
      claims: { sub: actorId, role },
    });
  });
  const billing = {
    prisma: {
      chargeItem: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      reconciliationItem: { findMany: vi.fn(async () => [{ id: 'reconciliation-id' }]) },
      accountAudit: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(),
    },
    listEntries: vi.fn(async () => [
      {
        id: 'entry',
        availableDeltaNanos: new Prisma.Decimal('10000000000000000000000000000000000000'),
        heldDeltaNanos: new Prisma.Decimal('-1'),
        createdAt: new Date('2026-01-01'),
      },
    ]),
    resolveReconciliation: vi.fn(async () => ({ id: actorId, status: 'resolved' })),
    refund: vi.fn(async () => ({
      availableDeltaNanos: new Prisma.Decimal('1'),
      amount: new Prisma.Decimal('0.000000000123'),
    })),
  };
  billing.prisma.$transaction.mockImplementation(async (operation) => operation(billing.prisma));
  registerBillingRoutes(app, { billing: billing as unknown as PrismaBillingService, sessions });
  return { app, billing };
}

describe('billing routes', () => {
  it('成本详情仅管理员可读，按收费项关联历次裁决，保留原币种微额精度', async () => {
    const { app, billing } = fixture();
    const item = {
      id: actorId,
      charge: { runId: 'synthetic-run', payerId: actorId },
      deliveryEvidence: {
        nodeId: 'node-1',
        result: { text: 'private input must stay hidden' },
        settlement: { status: 'settled', chargeNanos: '1', secret: 'hidden' },
      },
      usage: { source: 'output_metadata', reliable: true, images: 1, raw: 'hidden' },
      maximumNanos: new Prisma.Decimal('1000000000000000000000000'),
      providerCost: {
        status: 'adjudicated',
        amount: new Prisma.Decimal('0.000000000123'),
        currency: 'USD',
        source: 'provider_reported',
        evidence: { decision: { amount: '0.000000000456', currency: 'USD' }, raw: 'hidden' },
      },
    };
    billing.prisma.chargeItem.findUnique.mockResolvedValue(item);
    for (const headers of [{}, { 'x-test-role': 'user' }]) {
      const denied = await app.inject({ url: `/v1/admin/charge-items/${actorId}`, headers });
      expect(denied.statusCode).toBe(headers['x-test-role'] ? 403 : 401);
    }
    expect(billing.prisma.$transaction).not.toHaveBeenCalled();
    const response = await app.inject({
      url: `/v1/admin/charge-items/${actorId}?historyPage=2`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().item).toMatchObject({
      maximumNanos: '1000000000000000000000000',
      providerCost: {
        amount: '0.000000000123',
        evidence: { observations: [], decision: { amount: '0.000000000456', currency: 'USD' } },
      },
    });
    expect(response.json().item.deliveryEvidence).toEqual({
      nodeId: 'node-1',
      settlement: { status: 'settled', chargeNanos: '1' },
    });
    expect(response.json().item.usage).toEqual({
      source: 'output_metadata',
      reliable: true,
      images: 1,
    });
    expect(response.body).not.toContain('hidden');
    expect(billing.prisma.accountAudit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetId: { in: [actorId, 'reconciliation-id'] },
          action: { startsWith: 'billing.' },
        },
        skip: 50,
        take: 51,
      }),
    );
    billing.prisma.chargeItem.findUnique.mockResolvedValue(null);
    expect(
      (
        await app.inject({
          url: `/v1/admin/charge-items/${actorId}`,
          headers: { 'x-test-role': 'admin' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('管理员收费列表按任务精确筛选并限制页长，非管理员不能查询', async () => {
    const { app, billing } = fixture();
    expect(
      (await app.inject({ url: '/v1/admin/charge-items', headers: { 'x-test-role': 'user' } }))
        .statusCode,
    ).toBe(403);
    const response = await app.inject({
      url: '/v1/admin/charge-items?page=2&runId=synthetic-run',
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(billing.prisma.chargeItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { charge: { runId: 'synthetic-run' } },
        skip: 50,
        take: 51,
      }),
    );
    expect(response.json()).toEqual({ items: [], page: 2, pageSize: 50, hasMore: false });
  });

  it('管理员裁决只调用一个原子账务入口，付款操作者来自真实会话', async () => {
    const { app, billing } = fixture();
    const body = {
      action: 'confirm_cost',
      amount: '0.000000000123',
      currency: 'USD',
      reason: '合成原币种账单确认',
    };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/reconciliation/${actorId}/resolve`,
      headers: { 'x-test-role': 'admin' },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(billing.resolveReconciliation).toHaveBeenCalledExactlyOnceWith({
      id: actorId,
      actorId,
      ...body,
    });
    for (const headers of [
      {},
      { authorization: 'Bearer synthetic-service-token' },
      { 'x-test-role': 'user' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/admin/reconciliation/${actorId}/resolve`,
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(headers['x-test-role'] ? 403 : 401);
    }
    expect(billing.resolveReconciliation).toHaveBeenCalledTimes(1);
  });

  it('钱包大整数与负微额输出完整十进制，不使用指数表示', async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/account/billing',
      headers: { 'x-test-role': 'user' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0]).toMatchObject({
      availableDeltaNanos: '10000000000000000000000000000000000000',
      heldDeltaNanos: '-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('只有 nanos 字段取整数文本，原币种 Decimal 小数不会被 hook 截断', async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/charge-items/${actorId}/refund`,
      headers: { 'x-test-role': 'admin' },
      payload: { amountNanos: '1', reason: '合成退款', idempotencyKey: 'synthetic-refund' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entry).toEqual({ availableDeltaNanos: '1', amount: '0.000000000123' });
  });
});

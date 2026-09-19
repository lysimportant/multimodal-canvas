import { describe, expect, it, vi } from 'vitest';
import {
  BillingError,
  billingSnapshotHash,
  type PrismaBillingService,
} from '@multimodal-canvas/billing';
import { calculateBillingQuote, type RunResult, type RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProviderError } from '@multimodal-canvas/providers';
import { Prisma } from '@prisma/client';
import { PrismaWorkerBilling, isDefiniteBillingFailure } from './billing-execution';

/** 最小冻结计划；测试只使用合成标识，不发起供应商请求。 */
const snapshot: RunSnapshot = {
  projectId: '123e4567-e89b-42d3-a456-426614174200',
  canvasRevision: 1,
  targetNodeId: 'node_image',
  modelAlias: 'exact-upstream-id',
  credentialId: '123e4567-e89b-42d3-a456-426614174205',
  credentialVersion: 1,
  parameters: {},
  submittedAt: '2026-09-19T00:00:00.000Z',
  edges: [],
  inputs: [],
  nodes: [
    {
      id: 'node_image',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { label: '图片', mediaType: 'image', mode: 'generate' },
    },
  ],
  billingBindings: {
    node_image: {
      platformModelId: '123e4567-e89b-42d3-a456-426614174201',
      bindingId: '123e4567-e89b-42d3-a456-426614174202',
      pricingVersionId: '123e4567-e89b-42d3-a456-426614174203',
      contract: 'openai-images',
    },
  },
};
/** 单张持久交付证据；图片计量只能由这份实际结果给出。 */
const result: RunResult = {
  provider: 'newapi',
  summary: '已归档',
  targetNodeId: 'node_image',
  mediaType: 'image',
  inputCount: 0,
  asset: { assetId: '123e4567-e89b-42d3-a456-426614174204', version: 1, mimeType: 'image/png' },
};
/** 明确的原逻辑请求身份与归档状态。 */
const providerJob = {
  id: 'provider_job_original',
  provider: 'newapi',
  status: 'succeeded' as const,
  progress: 100,
  createdAt: snapshot.submittedAt,
  updatedAt: snapshot.submittedAt,
  payload: { deliveryState: 'archived' },
};

/** 可变的账务桩模拟服务端状态与幂等终态，用于验证 Worker 适配器行为。 */
function fixture(
  rule: unknown = { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: '100000000' },
) {
  const quote = calculateBillingQuote({
    rule,
    durationSeconds: '5',
    inputTokens: 20,
    inputTokensVerified: true,
    maxOutputTokens: 100,
    characters: 3,
    charactersVerified: true,
  });
  const item = {
    id: 'item_1',
    nodeId: 'node_image',
    ...snapshot.billingBindings!.node_image!,
    quoteInput: quote,
    maximumNanos: new Prisma.Decimal(quote.capNanos),
    status: 'HELD',
    executionState: 'unsent',
    providerRequestId: null as string | null,
    deliveryEvidence: null as unknown,
  };
  const charge = { requestHash: billingSnapshotHash(snapshot), items: [item] };
  const prisma = {
    runCharge: { findUnique: vi.fn(async () => charge as typeof charge | null) },
    billingActivation: { findUnique: vi.fn(async () => ({ createdAt: new Date('2026-09-19') })) },
    run: { findUnique: vi.fn(async () => ({ createdAt: new Date('2026-09-18'), snapshot })) },
    assetVersion: {
      findUnique: vi.fn(async () => ({
        metadata: { metadataStatus: 'ready', durationSeconds: 2.5 },
      })),
    },
    reconciliationItem: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const events: string[] = [];
  const service = {
    prisma,
    beginExecution: vi.fn(
      async (_runId: string, _nodeId: string, fullSnapshot: RunSnapshot, taskId?: string) => {
        expect(fullSnapshot).toEqual(snapshot);
        if (item.executionState !== 'unsent' && taskId !== item.providerRequestId)
          throw new BillingError('execution_unknown', '禁止重发');
        item.executionState = taskId ? 'sent' : 'sending';
        return item;
      },
    ),
    recordProviderRequest: vi.fn(async (_id: string, taskId: string) => {
      item.providerRequestId = taskId;
      item.executionState = 'sent';
    }),
    resolveItem: vi.fn(async (_id: string, resolution: { status: string; evidence?: unknown }) => {
      events.push('settle');
      if (!['SETTLED', 'RELEASED', 'REFUNDED'].includes(item.status))
        item.status = resolution.status;
      if (resolution.evidence) item.deliveryEvidence = resolution.evidence;
      return item;
    }),
    recordCost: vi.fn(async () => {
      events.push('cost');
    }),
  };
  const billing = new PrismaWorkerBilling(service as unknown as PrismaBillingService);
  return { item, charge, prisma, service, billing, events };
}

describe('Worker wallet execution adapter', () => {
  it('托管模型按原请求回执结算，保留冻结换算并封顶，重放不再查询上游', async () => {
    const f = fixture();
    Object.assign(f.item, {
      quoteInput: managedQuote(),
      maximumNanos: new Prisma.Decimal('14600000'),
    });
    const request = {
      ...providerJob,
      payload: {
        deliveryState: 'archived',
        newApiRequestId: 'original-newapi-request',
        pollNewApiRequestId: 'must-not-query',
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(managedReceipt('2000')));
    const getProviderCredentials = vi.fn(async () => ({
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic',
    }));
    const billing = new PrismaWorkerBilling(f.service as unknown as PrismaBillingService, {
      fetchImpl,
      getProviderCredentials,
    });
    await billing.deliver('run_original', 'node_image', snapshot, result, request);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://synthetic.invalid/v1/canvas/receipts/original-newapi-request',
    );
    expect(f.service.resolveItem).toHaveBeenCalledWith(
      'item_1',
      expect.objectContaining({
        status: 'SETTLED',
        chargeNanos: '14600000',
        evidence: expect.objectContaining({
          settlement: expect.objectContaining({ capped: true, uncappedChargeNanos: '29200000' }),
          conversion: { quotaPerUnit: '500000', usdToCny: '7.3' },
        }),
      }),
    );
    expect(f.service.recordCost).toHaveBeenCalledWith('item_1', {
      amount: '0.004000000000',
      currency: 'USD',
      source: 'newapi_receipt',
    });
    await billing.deliver('run_original', 'node_image', snapshot, result, request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['settled', 'refunded'] as const)(
    '未交付托管项也记录 %s 原回执成本，不扣用户或释放冻结',
    async (status) => {
      const f = fixture();
      Object.assign(f.item, {
        quoteInput: managedQuote(),
        maximumNanos: new Prisma.Decimal('14600000'),
      });
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...managedReceipt(status === 'refunded' ? '0' : '1'),
          status,
          task_id: 'original-task',
          quota_per_unit: '3',
        }),
      );
      const getProviderCredentials = vi.fn(async () => ({
        baseUrl: 'https://synthetic.invalid/v1',
        apiKey: 'synthetic',
      }));
      const billing = new PrismaWorkerBilling(f.service as unknown as PrismaBillingService, {
        fetchImpl,
        getProviderCredentials,
      });
      await billing.recordCost('run_original', 'node_image', snapshot, {
        ...providerJob,
        platformJobId: 'original-task',
        payload: { deliveryState: 'received', newApiRequestId: 'original-newapi-request' },
      });
      expect(getProviderCredentials).toHaveBeenCalledWith({
        credentialId: snapshot.credentialId,
        credentialVersion: 1,
      });
      expect(f.service.recordCost).toHaveBeenCalledWith('item_1', {
        amount: status === 'refunded' ? '0.000000000000' : '0.333333333334',
        currency: 'USD',
        source: 'newapi_receipt',
      });
      expect(f.service.resolveItem).not.toHaveBeenCalled();
      expect(f.item.status).toBe('HELD');
    },
  );

  it.each(['pending', 'wrong_request', 'wrong_task', 'wrong_model', 'missing', 'network'])(
    '未交付托管成本 %s 保持未知，不接受其他请求的费用',
    async (kind) => {
      const f = fixture();
      Object.assign(f.item, {
        quoteInput: managedQuote(),
        maximumNanos: new Prisma.Decimal('14600000'),
      });
      const receipt = {
        ...managedReceipt(),
        task_id: 'original-task',
        ...(kind === 'pending' ? { status: 'pending', settled_at: undefined } : {}),
        ...(kind === 'wrong_request' ? { request_id: 'wrong-request' } : {}),
        ...(kind === 'wrong_task' ? { task_id: 'wrong-task' } : {}),
        ...(kind === 'wrong_model' ? { model: 'wrong-model' } : {}),
      };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
      if (kind === 'network')
        fetchImpl.mockRejectedValue(new Error('synthetic transport unavailable'));
      const billing = new PrismaWorkerBilling(f.service as unknown as PrismaBillingService, {
        fetchImpl,
        getProviderCredentials: async () => ({
          baseUrl: 'https://synthetic.invalid/v1',
          apiKey: 'synthetic',
        }),
      });
      await billing.recordCost('run_original', 'node_image', snapshot, {
        ...providerJob,
        platformJobId: 'original-task',
        payload: kind === 'missing' ? {} : { newApiRequestId: 'original-newapi-request' },
      });
      expect(f.service.recordCost).toHaveBeenCalledWith('item_1', undefined);
      expect(f.service.resolveItem).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1);
    },
  );

  it('已结算后的成本修复沿用保存回执，停止上游访问且不会采用新金额', async () => {
    const f = fixture();
    Object.assign(f.item, {
      quoteInput: managedQuote(),
      maximumNanos: new Prisma.Decimal('14600000'),
      status: 'SETTLED',
      deliveryEvidence: { newApiReceipt: managedReceipt('500') },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('must not query'));
    const billing = new PrismaWorkerBilling(f.service as unknown as PrismaBillingService, {
      fetchImpl,
    });
    await billing.recordCost('run_original', 'node_image', snapshot, {
      ...providerJob,
      payload: { newApiRequestId: 'original-newapi-request' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.service.recordCost).toHaveBeenCalledWith('item_1', {
      amount: '0.001000000000',
      currency: 'USD',
      source: 'newapi_receipt',
    });
    expect(f.service.resolveItem).not.toHaveBeenCalled();
  });

  it.each(['pending', 'wrong_request', 'wrong_task', 'wrong_model', 'wrong_unit', 'missing'])(
    '托管回执 %s 不能冒充最终账单',
    async (kind) => {
      const f = fixture();
      Object.assign(f.item, {
        quoteInput: managedQuote(),
        maximumNanos: new Prisma.Decimal('14600000'),
      });
      const receipt = {
        ...managedReceipt(),
        ...(kind === 'pending' ? { status: 'pending', settled_at: undefined } : {}),
        ...(kind === 'wrong_request' ? { request_id: 'foreign-request' } : {}),
        ...(kind === 'wrong_task' ? { task_id: 'foreign-task' } : {}),
        ...(kind === 'wrong_model' ? { model: 'foreign-model' } : {}),
        ...(kind === 'wrong_unit' ? { quota_per_unit: '1000000' } : {}),
      };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
      const billing = new PrismaWorkerBilling(f.service as unknown as PrismaBillingService, {
        fetchImpl,
        getProviderCredentials: async () => ({
          baseUrl: 'https://synthetic.invalid/v1',
          apiKey: 'synthetic',
        }),
      });
      await expect(
        billing.deliver('run_original', 'node_image', snapshot, result, {
          ...providerJob,
          ...(kind === 'wrong_task' ? { platformJobId: 'expected-task' } : {}),
          payload: kind === 'missing' ? {} : { newApiRequestId: 'original-newapi-request' },
        }),
      ).rejects.toMatchObject({ code: 'newapi_receipt_pending' });
      expect(f.item.status).toBe('PENDING_VERIFICATION');
      expect(f.item.deliveryEvidence).toMatchObject({ assetId: result.asset!.assetId });
      expect(f.service.recordCost).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1);
    },
  );
  it('records received cost without settling or releasing an undelivered item', async () => {
    const f = fixture();
    await f.billing.recordCost('run_original', 'node_image', snapshot, {
      ...providerJob,
      payload: {
        deliveryState: 'received',
        reportedUsage: { amount: '0.000000000123', currency: 'USD' },
      },
    });
    expect(f.service.recordCost).toHaveBeenCalledWith('item_1', {
      amount: '0.000000000123',
      currency: 'USD',
      source: 'provider_reported',
    });
    expect(f.service.resolveItem).not.toHaveBeenCalled();
    expect(f.item.status).toBe('HELD');
  });

  it.each(['HELD', 'SETTLED'])(
    'keeps %s delivery recovery separate from refunds and resolves it only after repair',
    async (status) => {
      const f = fixture();
      f.item.status = status;
      f.item.executionState = 'sending';
      const archived = { ...providerJob, payload: { ...providerJob.payload, result } };
      await f.billing.deferDelivery('run_original', 'node_image', snapshot, archived);
      expect(f.item.status).toBe(status === 'HELD' ? 'PENDING_VERIFICATION' : 'SETTLED');
      expect(f.service.resolveItem).toHaveBeenCalledTimes(status === 'HELD' ? 1 : 0);
      expect(f.prisma.reconciliationItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ kind: 'worker_recovery', chargeItemId: 'item_1' }),
        }),
      );
      await f.billing.deliver('run_original', 'node_image', snapshot, result, archived);
      expect(f.item.status).toBe('SETTLED');
      expect(f.prisma.reconciliationItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { chargeItemId: 'item_1', kind: 'worker_recovery', status: 'open' },
          data: expect.objectContaining({ status: 'resolved' }),
        }),
      );
    },
  );
  it('requires the full frozen snapshot and refuses a second synchronous send', async () => {
    const f = fixture();
    await f.billing.authorizeRun('run_original', snapshot);
    await f.billing.begin('run_original', 'node_image', snapshot);
    await expect(f.billing.begin('run_original', 'node_image', snapshot)).rejects.toThrow(
      '禁止重发',
    );
    await expect(
      f.billing.begin('run_original', 'node_image', {
        ...snapshot,
        parameters: { quality: 'changed' },
      }),
    ).rejects.toThrow('冻结授权不一致');
    expect(f.service.beginExecution).toHaveBeenCalledTimes(2);
  });

  it('repairs a persisted asynchronous task ID before resuming its original task', async () => {
    const f = fixture();
    f.item.executionState = 'sending';
    await f.billing.begin('run_original', 'node_image', snapshot, 'upstream-task');
    expect(f.service.recordProviderRequest).toHaveBeenCalledWith('item_1', 'upstream-task');
    expect(f.service.beginExecution).toHaveBeenCalledWith(
      'run_original',
      'node_image',
      snapshot,
      'upstream-task',
    );
  });

  it('exempts only a persisted pre-activation run with the exact original snapshot', async () => {
    const f = fixture();
    f.prisma.runCharge.findUnique.mockResolvedValue(null);
    await f.billing.authorizeRun('run_original', snapshot);
    await f.billing.begin('run_original', 'node_image', snapshot);
    expect(f.service.beginExecution).not.toHaveBeenCalled();
    f.prisma.run.findUnique.mockResolvedValue({ createdAt: new Date('2026-09-20'), snapshot });
    await expect(f.billing.authorizeRun('run_original', snapshot)).rejects.toThrow('缺少冻结授权');
    f.prisma.run.findUnique.mockResolvedValue({ createdAt: new Date('2026-09-18'), snapshot });
    await expect(
      f.billing.authorizeRun('run_original', { ...snapshot, modelAlias: 'changed' }),
    ).rejects.toThrow('缺少冻结授权');
  });

  it('settles fixed delivery independently when provider cost is unknown or temporarily unavailable', async () => {
    const f = fixture();
    f.service.recordCost.mockRejectedValueOnce(new Error('cost database unavailable'));
    await expect(
      f.billing.deliver('run_original', 'node_image', snapshot, result, providerJob),
    ).rejects.toThrow('cost database unavailable');
    expect(f.item.status).toBe('SETTLED');
    expect(f.events).toEqual(['settle']);
    await f.billing.deliver('run_original', 'node_image', snapshot, result, providerJob);
    expect(f.service.resolveItem).toHaveBeenCalledWith(
      'item_1',
      expect.objectContaining({ status: 'SETTLED', chargeNanos: '100000000' }),
    );
    expect(f.service.recordCost).toHaveBeenLastCalledWith('item_1', undefined);
    expect(f.service.beginExecution).not.toHaveBeenCalled();
  });

  it('counts only the single archived image and preserves explicitly reported cost currency', async () => {
    const f = fixture({
      unit: 'per_image',
      meteringSource: 'output_metadata',
      unitPriceNanos: '150000000',
      maxQuantity: 4,
    });
    await f.billing.deliver('run_original', 'node_image', snapshot, result, {
      ...providerJob,
      payload: { reportedUsage: { amount: '0.015', currency: 'USD' } },
    });
    expect(f.service.resolveItem).toHaveBeenCalledWith(
      'item_1',
      expect.objectContaining({
        status: 'SETTLED',
        chargeNanos: '150000000',
        usage: { source: 'output_metadata', reliable: true, images: 1 },
      }),
    );
    expect(f.service.recordCost).toHaveBeenCalledWith('item_1', {
      amount: '0.015',
      currency: 'USD',
      source: 'provider_reported',
    });
  });

  it('keeps missing token usage pending and later settles explicit counters', async () => {
    const f = fixture({
      unit: 'per_token',
      meteringSource: 'provider_usage',
      inputPriceNanos: '1000000000',
      outputPriceNanos: '2000000000',
      maxInputTokens: 100,
      maxOutputTokens: 100,
    });
    await f.billing.deliver('run_original', 'node_image', snapshot, result, providerJob);
    expect(f.item.status).toBe('PENDING_VERIFICATION');
    await f.billing.deliver('run_original', 'node_image', snapshot, result, {
      ...providerJob,
      payload: { usage: { prompt_tokens: 20, completion_tokens: 30 } },
    });
    expect(f.service.resolveItem).toHaveBeenLastCalledWith(
      'item_1',
      expect.objectContaining({ status: 'SETTLED', chargeNanos: '80000' }),
    );
  });

  it('uses probed output duration and rejects guessed provider duration', async () => {
    const f = fixture({
      unit: 'per_second',
      meteringSource: 'output_metadata',
      unitPriceNanos: '1000000000',
      maxDurationSeconds: '10',
      durationRounding: 'exact',
    });
    await f.billing.deliver('run_original', 'node_image', snapshot, result, providerJob);
    expect(f.service.resolveItem).toHaveBeenLastCalledWith(
      'item_1',
      expect.objectContaining({ status: 'SETTLED', chargeNanos: '2500000000' }),
    );
    const unknown = fixture({
      unit: 'per_second',
      meteringSource: 'provider_usage',
      unitPriceNanos: '1000000000',
      maxDurationSeconds: '10',
      durationRounding: 'exact',
    });
    await unknown.billing.deliver('run_original', 'node_image', snapshot, result, {
      ...providerJob,
      payload: { usage: { duration: 5 } },
    });
    expect(unknown.item.status).toBe('PENDING_VERIFICATION');
  });

  it('releases only unsent work, keeps sent cancellation pending and never releases delivered usage', async () => {
    const f = fixture();
    await f.billing.interrupt('run_original', snapshot);
    expect(f.item.status).toBe('RELEASED');
    f.item.status = 'HELD';
    f.item.executionState = 'sending';
    await f.billing.interrupt(
      'run_original',
      snapshot,
      'node_image',
      new Error('cancelled locally'),
    );
    expect(f.item.status).toBe('PENDING_VERIFICATION');
    f.item.deliveryEvidence = { assetId: result.asset!.assetId };
    const calls = f.service.resolveItem.mock.calls.length;
    await f.billing.interrupt('run_original', snapshot);
    expect(f.service.resolveItem).toHaveBeenCalledTimes(calls);
  });

  it('releases a sent request only after a definite provider rejection', async () => {
    const f = fixture();
    f.item.executionState = 'sending';
    await f.billing.interrupt(
      'run_original',
      snapshot,
      'node_image',
      new NewApiProviderError('invalid request', { status: 400 }),
    );
    expect(f.item.status).toBe('RELEASED');
    for (const status of [408, 425, 429, 499, 500])
      expect(isDefiniteBillingFailure(new NewApiProviderError('unknown', { status }))).toBe(false);
    expect(isDefiniteBillingFailure(Object.assign(new Error('local error'), { status: 400 }))).toBe(
      false,
    );
    expect(
      isDefiniteBillingFailure(
        new NewApiProviderError('task lookup failed', {
          status: 404,
          platformJobId: 'existing-task',
        }),
      ),
    ).toBe(false);
  });
});

/** 合成预估冻结的是人民币预算及换算，不是 New API 固定单价。 */
function managedQuote() {
  return {
    version: 2,
    currency: 'CNY',
    rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
    quantity: 1,
    capNanos: '14600000',
    estimate: {
      version: 1,
      model: 'exact-upstream-id',
      group: 'estimate-group',
      pricing_version: 'estimate-version',
      estimated_quota: '1000',
      quota_per_unit: '500000',
      usd_to_cny: '7.3',
      expires_at: '2026-09-19T00:05:00.000Z',
      estimate_only: true,
    },
  };
}

/** 账单可来自执行时最终分组，必须属于原模型、请求和配额单位。 */
function managedReceipt(quota = '500') {
  return {
    version: 1,
    request_id: 'original-newapi-request',
    model: 'exact-upstream-id',
    group: 'actual-group',
    status: 'settled',
    quota,
    quota_per_unit: '500000',
    settled_at: '2026-09-19T00:01:00.000Z',
  };
}

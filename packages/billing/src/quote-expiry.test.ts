import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { PrismaBillingService, type QuoteItemInput } from './index.js';

/** 到期边界只依赖持久化前校验；不启动数据库或生成任务。 */
function fixture() {
  const create = vi.fn(async ({ data }: { data: { expiresAt: Date } }) => data);
  const billing = new PrismaBillingService({ billingQuote: { create } } as unknown as PrismaClient);
  const snapshot: RunSnapshot = {
    projectId: 'project',
    canvasRevision: 0,
    targetNodeId: 'node',
    modelAlias: 'exact-model',
    parameters: {},
    submittedAt: new Date().toISOString(),
    inputs: [],
    edges: [],
    nodes: [
      {
        id: 'node',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: 'test', mediaType: 'text', mode: 'generate' },
      },
    ],
  };
  const items: QuoteItemInput[] = [
    {
      nodeId: 'node',
      platformModelId: 'model',
      bindingId: 'binding',
      pricingVersionId: 'price',
      pricingRule: {},
      quoteInput: {},
      maximumNanos: '1',
    },
  ];
  return { create, billing, input: { payerId: 'payer', snapshot, items } };
}

describe('报价持久化到期边界', () => {
  it('上游估算更早过期时保存该截止时间', async () => {
    const { billing, input } = fixture();
    const expiresAt = new Date(Date.now() + 30_000);
    expect((await billing.createQuote({ ...input, expiresAt })).expiresAt).toEqual(expiresAt);
  });

  it('晚于五分钟的上游估算不能延长本地报价有效期', async () => {
    const { billing, input } = fixture();
    const started = Date.now();
    const result = await billing.createQuote({ ...input, expiresAt: new Date(started + 600_000) });
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(started + 300_000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it.each([new Date(0), new Date(NaN)])(
    '拒绝已过期或无效上游截止时间且不保存报价 %s',
    async (expiresAt) => {
      const { billing, input, create } = fixture();
      await expect(billing.createQuote({ ...input, expiresAt })).rejects.toMatchObject({
        code: 'quote_expired',
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
});

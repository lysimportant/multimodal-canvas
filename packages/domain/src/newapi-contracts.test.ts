import { describe, expect, it } from 'vitest';

import {
  newApiCatalogModelSchema,
  newApiCatalogSchema,
  newApiReceiptSchema,
  newApiRequestIdSchema,
  type NewApiReceipt,
} from './newapi-contracts.js';

/** 构造不含密钥和地址的合成回执。 */
function receipt(overrides: Partial<NewApiReceipt> = {}): NewApiReceipt {
  return {
    version: 1,
    request_id: 'request:with-safe.ID_1',
    task_id: 'task-1',
    model: 'exact-model（按次）',
    group: 'actual-group',
    pricing_version: 'actual-v2',
    status: 'settled',
    quota: '1',
    quota_per_unit: '500000',
    settled_at: '2026-09-19T11:59:02.123456789Z',
    ...overrides,
  };
}

describe('New API 中性合同', () => {
  it.each(['request-1', 'request:with-safe.ID_1', 'A_b.c:d-9'])(
    '接受可持久化的请求 ID %s',
    (requestId) => {
      expect(newApiRequestIdSchema.safeParse(requestId).success).toBe(true);
    },
  );

  it.each(['.', '..', 'request/segment', 'request with space', 'r'.repeat(65), '中文'])(
    '拒绝不能作为单一路径段的请求 ID %s',
    (requestId) => {
      expect(newApiRequestIdSchema.safeParse(requestId).success).toBe(false);
    },
  );

  it('可执行模型按 512 UTF-8 字节校验，超长不可用条目仍可解释原因', () => {
    const valid = '中'.repeat(170) + 'ab';
    const invalid = '中'.repeat(171);
    const entry = { id: valid, available: true, pricing_version: 'catalog-v1' };
    expect(newApiCatalogModelSchema.safeParse(entry).success).toBe(true);
    expect(newApiCatalogModelSchema.safeParse({ ...entry, id: invalid }).success).toBe(false);
    expect(
      newApiCatalogModelSchema.safeParse({
        ...entry,
        id: invalid,
        available: false,
        unavailable_reason: '上游标识超过执行限制',
        pricing_version: '',
      }).success,
    ).toBe(true);
  });

  it('目录保留上游换算与价格修订原文，并拒绝重复模型身份或 Canvas 本地售价', () => {
    const model = {
      id: 'exact-model',
      media_type: 'image' as const,
      contract: 'openai-images',
      available: true,
      pricing_version: 'catalog-v2',
    };
    const catalog = {
      version: 1 as const,
      currency: 'CNY' as const,
      quota_per_unit: '500000',
      usd_to_cny: '7.1',
      models: [model],
    };
    expect(newApiCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(newApiCatalogSchema.safeParse({ ...catalog, models: [model, model] }).success).toBe(
      false,
    );
    expect(
      newApiCatalogSchema.safeParse({
        ...catalog,
        models: [{ ...model, canvas_price: '1.00' }],
      }).success,
    ).toBe(false);
  });

  it('最终回执必须有记账时间，退款后的净 quota 必须为零', () => {
    expect(newApiReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(newApiReceiptSchema.safeParse(receipt({ settled_at: undefined })).success).toBe(false);
    expect(
      newApiReceiptSchema.safeParse(receipt({ status: 'pending', settled_at: undefined })).success,
    ).toBe(true);
    expect(newApiReceiptSchema.safeParse(receipt({ status: 'pending' })).success).toBe(false);
    expect(newApiReceiptSchema.safeParse(receipt({ status: 'refunded', quota: '1' })).success).toBe(
      false,
    );
    expect(newApiReceiptSchema.safeParse(receipt({ status: 'refunded', quota: '0' })).success).toBe(
      true,
    );
  });

  it('回执模型和任务身份执行字节边界，不接受未知字段', () => {
    expect(newApiReceiptSchema.safeParse(receipt({ model: '中'.repeat(171) })).success).toBe(false);
    expect(newApiReceiptSchema.safeParse(receipt({ task_id: '中'.repeat(64) })).success).toBe(
      false,
    );
    expect(newApiReceiptSchema.safeParse({ ...receipt(), api_key: 'forbidden' }).success).toBe(
      false,
    );
  });
});

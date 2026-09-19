import { describe, expect, it } from 'vitest';

import {
  MAX_BILLING_NANOS,
  billingNanosSchema,
  billingParametersSchema,
  billingPriceRuleSchema,
  billingQuoteSchema,
  calculateBillingQuote,
  calculateBillingSettlement,
  calculateNewApiSettlement,
  ceilBillingDivision,
  countBillingCharacters,
  formatCnyNanos,
  marketplaceModelSchema,
  marketplacePriceRuleSchema,
  newApiCatalogModelSchema,
  newApiEstimateSchema,
  newApiQuoteCalculationSchema,
  newApiQuotaToCnyNanos,
  newApiReceiptSchema,
  parseBillingNanos,
  parseCnyNanos,
  serializeBillingNanos,
  type BillingPriceRule,
  type BillingQuoteCalculation,
  type NewApiQuoteCalculation,
  type NewApiReceipt,
} from './billing.js';

/** 合成托管报价把当前预扣折算为人民币 0.0000142 元预算，不锁定上游分组。 */
function managedQuote(): NewApiQuoteCalculation {
  return newApiQuoteCalculationSchema.parse({
    version: 2,
    currency: 'CNY',
    rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
    quantity: 1,
    capNanos: '14200',
    estimate: {
      version: 1,
      model: 'exact-model（按次）',
      group: 'estimated-group',
      pricing_version: 'estimate-v1',
      estimated_quota: '1',
      quota_per_unit: '500000',
      usd_to_cny: '7.1',
      expires_at: '2026-09-19T12:00:00Z',
      estimate_only: true,
    },
  });
}

/** 最终回执允许执行时实际分组和价格变化；模型、请求及换算单位保持可核实。 */
function managedReceipt(overrides: Partial<NewApiReceipt> = {}): NewApiReceipt {
  return {
    version: 1,
    request_id: 'request-1',
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

describe('New API 人民币预算与回执', () => {
  it('模型身份按 512 UTF-8 字节校验，超长目录条目只能保留为不可用', () => {
    const valid = '中'.repeat(170) + 'ab';
    const invalid = '中'.repeat(171);
    const entry = { id: valid, available: true, pricing_version: 'v1' };
    expect(newApiCatalogModelSchema.safeParse(entry).success).toBe(true);
    expect(newApiCatalogModelSchema.safeParse({ ...entry, id: invalid }).success).toBe(false);
    expect(
      newApiCatalogModelSchema.safeParse({ ...entry, id: invalid, available: false }).success,
    ).toBe(true);
    for (const [model, accepted] of [
      [valid, true],
      [invalid, false],
    ] as const) {
      expect(newApiEstimateSchema.safeParse({ ...managedQuote().estimate, model }).success).toBe(
        accepted,
      );
      expect(newApiReceiptSchema.safeParse(managedReceipt({ model })).success).toBe(accepted);
    }
  });
  it.each([
    ['1', '500000', '7.1', '14200'],
    ['1', '3', '0.000000001', '1'],
    ['3', '0.3', '0.000000001', '10'],
    ['9007199254740993', '1', '1', '9007199254740993000000000'],
    ['0', '500000', '7', '0'],
  ])('精确换算 quota=%s 每美元=%s 汇率=%s', (quota, quotaPerUnit, usdToCny, expected) => {
    expect(newApiQuotaToCnyNanos({ quota, quotaPerUnit, usdToCny })).toBe(expected);
  });

  it.each(['0', '-1', 'NaN', '1e5', ' 7', '7.', '01', 7])(
    '拒绝缺省或不规范换算配置 %s',
    (invalid) => {
      expect(() =>
        newApiQuotaToCnyNanos({ quota: '1', quotaPerUnit: invalid as string, usdToCny: '7' }),
      ).toThrow();
      expect(() =>
        newApiQuotaToCnyNanos({ quota: '1', quotaPerUnit: '500000', usdToCny: invalid as string }),
      ).toThrow();
    },
  );

  it('人工规则校验不接受托管价格，广场接受两种规则且不接受托管附加单价', () => {
    const rule = managedQuote().rule;
    expect(billingPriceRuleSchema.safeParse(rule).success).toBe(false);
    expect(marketplacePriceRuleSchema.safeParse(rule).success).toBe(true);
    expect(marketplacePriceRuleSchema.safeParse(imageRule).success).toBe(true);
    expect(marketplacePriceRuleSchema.safeParse({ ...rule, unitPriceNanos: '1' }).success).toBe(
      false,
    );
  });

  it('预算必须等于冻结估算的精确人民币换算，超精度预算也拒绝', () => {
    const quote = managedQuote();
    expect(newApiQuoteCalculationSchema.safeParse({ ...quote, capNanos: '14201' }).success).toBe(
      false,
    );
    expect(
      newApiQuoteCalculationSchema.safeParse({
        ...quote,
        estimate: { ...quote.estimate, usd_to_cny: '8' },
      }).success,
    ).toBe(false);
    expect(() =>
      newApiQuotaToCnyNanos({ quota: '9'.repeat(38), quotaPerUnit: '1', usdToCny: '1' }),
    ).toThrow();
  });

  it('以实际回执结算并接受上游执行价格和分组变化，超预算差额不向用户补扣', () => {
    expect(
      calculateNewApiSettlement({
        quote: managedQuote(),
        receipt: managedReceipt({ quota: '2' }),
        delivery: 'delivered',
      }),
    ).toEqual({
      status: 'settled',
      chargeNanos: '14200',
      releaseNanos: '0',
      capped: true,
      uncappedChargeNanos: '28400',
    });
    const quote = managedQuote();
    quote.estimate.estimated_quota = '2';
    quote.capNanos = '28400';
    expect(
      calculateNewApiSettlement({
        quote,
        receipt: managedReceipt({ quota_per_unit: '500000.0' }),
        delivery: 'delivered',
      }),
    ).toEqual({
      status: 'settled',
      chargeNanos: '14200',
      releaseNanos: '14200',
      capped: false,
      uncappedChargeNanos: '14200',
    });
  });

  it('未知交付、缺失或 pending 回执都保留冻结，pending 零值不能免费结算', () => {
    const quote = managedQuote();
    expect(calculateNewApiSettlement({ quote, delivery: 'unknown' })).toMatchObject({
      status: 'pending_verification',
      reason: 'delivery_unknown',
    });
    expect(calculateNewApiSettlement({ quote, delivery: 'delivered' })).toMatchObject({
      status: 'pending_verification',
      reason: 'receipt_missing',
    });
    expect(
      calculateNewApiSettlement({
        quote,
        delivery: 'delivered',
        receipt: managedReceipt({ status: 'pending', quota: '0', settled_at: undefined }),
      }),
    ).toMatchObject({
      status: 'pending_verification',
      reason: 'receipt_pending',
      releaseNanos: '0',
    });
    expect(calculateNewApiSettlement({ quote, delivery: 'failed' })).toEqual({
      status: 'released',
      chargeNanos: '0',
      releaseNanos: '14200',
    });
  });

  it('最终上游成本超出钱包精度时仍按可表示的授权预算封顶，保留完整差额证据', () => {
    const quote = managedQuote();
    quote.estimate.quota_per_unit = '1';
    quote.estimate.usd_to_cny = '1';
    quote.capNanos = '1000000000';
    const settled = calculateNewApiSettlement({
      quote,
      delivery: 'delivered',
      receipt: managedReceipt({ quota: '9'.repeat(38), quota_per_unit: '1' }),
    });
    expect(settled).toMatchObject({
      status: 'settled',
      chargeNanos: '1000000000',
      releaseNanos: '0',
      capped: true,
      uncappedChargeNanos: `${'9'.repeat(38)}000000000`,
    });
  });

  it('回执模型或 quota 单位改变时不能沿用旧预算换算', () => {
    expect(
      calculateNewApiSettlement({
        quote: managedQuote(),
        delivery: 'delivered',
        receipt: managedReceipt({ model: 'other-model' }),
      }),
    ).toMatchObject({ reason: 'receipt_model_mismatch' });
    expect(
      calculateNewApiSettlement({
        quote: managedQuote(),
        delivery: 'delivered',
        receipt: managedReceipt({ quota_per_unit: '600000' }),
      }),
    ).toMatchObject({ reason: 'receipt_quota_unit_mismatch' });
  });

  it('最终回执必须有记账时间，已退款回执必须净 quota 为零', () => {
    expect(newApiReceiptSchema.safeParse(managedReceipt({ settled_at: undefined })).success).toBe(
      false,
    );
    expect(
      newApiReceiptSchema.safeParse(managedReceipt({ status: 'refunded', quota: '1' })).success,
    ).toBe(false);
    expect(
      calculateNewApiSettlement({
        quote: managedQuote(),
        delivery: 'delivered',
        receipt: managedReceipt({ status: 'refunded', quota: '0' }),
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '0', releaseNanos: '14200' });
  });
});

/** 人工发布的按图片交付计费规则；四张以内每张人民币 0.25 元。 */
const imageRule = {
  unit: 'per_image',
  meteringSource: 'output_metadata',
  unitPriceNanos: '250000000',
  maxQuantity: 4,
} as const;

/** 输入输出均为百万 Token 单价，报价必须带可信输入计量。 */
const tokenRule = {
  unit: 'per_token',
  meteringSource: 'provider_usage',
  inputPriceNanos: '1000000000',
  outputPriceNanos: '2000000000',
  maxInputTokens: 100_000,
  maxOutputTokens: 4096,
} as const;

/** 按输出时长计费，单次可交付两个媒体结果，单结果最多十秒。 */
const secondsRule = {
  unit: 'per_second',
  meteringSource: 'output_metadata',
  unitPriceNanos: '100000000',
  maxQuantity: 2,
  maxDurationSeconds: '10',
  durationRounding: 'exact',
} as const;

describe('人民币高精度金额', () => {
  it.each([
    ['0', '0'],
    ['1', '1000000000'],
    ['0.000000001', '1'],
    ['12.345678901', '12345678901'],
    ['12.500000000', '12500000000'],
    ['9007199254740993', '9007199254740993000000000'],
  ])('精确解析人民币文本 %s', (yuan, nanos) => {
    expect(parseCnyNanos(yuan)).toBe(nanos);
    expect(parseCnyNanos(formatCnyNanos(nanos))).toBe(nanos);
  });

  it('显示不丢失微额，也不产生浮点数误差', () => {
    expect(formatCnyNanos('1')).toBe('0.000000001');
    expect(formatCnyNanos('12500000000')).toBe('12.5');
    expect(formatCnyNanos('9007199254740993000000001')).toBe('9007199254740993.000000001');
    expect(serializeBillingNanos(MAX_BILLING_NANOS)).toBe('9'.repeat(38));
  });

  it.each(['-1', '01', '1e9', '+1', ' 1', '1.0', '', '9'.repeat(39), 10, 0.1, NaN])(
    '拒绝非规范 nanos 来源 %s',
    (value) => {
      expect(billingNanosSchema.safeParse(value).success).toBe(false);
      expect(() => parseBillingNanos(value as string)).toThrow();
    },
  );

  it.each(['-1', '01', '1e9', '0.0000000001', '1.', ' 1', '.5', '9'.repeat(30), 0.1])(
    '人民币文本不能隐式舍入或接收 number：%s',
    (value) => {
      expect(() => parseCnyNanos(value as string)).toThrow();
    },
  );

  it('阻止内部负数和 Decimal 精度溢出', () => {
    expect(() => serializeBillingNanos(-1n)).toThrow();
    expect(() => serializeBillingNanos(MAX_BILLING_NANOS + 1n)).toThrow();
    expect(() => serializeBillingNanos(1 as unknown as bigint)).toThrow();
    expect(() => ceilBillingDivision(-1n, 1n)).toThrow();
    expect(() => ceilBillingDivision(1n, 0n)).toThrow();
    expect(ceilBillingDivision(0n, 2n)).toBe(0n);
    expect(ceilBillingDivision(1n, 2n)).toBe(1n);
    expect(ceilBillingDivision(4n, 2n)).toBe(2n);
  });
});

describe('不可变价格规则和规格', () => {
  it('支持显式零价，不把缺失价格当作免费', () => {
    expect(calculateBillingQuote({ rule: { ...imageRule, unitPriceNanos: '0' } }).capNanos).toBe(
      '0',
    );
    const { unitPriceNanos: _ignored, ...missingPrice } = imageRule;
    expect(billingPriceRuleSchema.safeParse(missingPrice).success).toBe(false);
  });

  it.each([
    { ...imageRule, unitPriceNanos: 0.25 },
    { ...imageRule, meteringSource: 'provider_usage' },
    { ...tokenRule, meteringSource: 'fixed' },
    { ...secondsRule, meteringSource: 'input_characters' },
    { ...imageRule, minQuantity: 5, maxQuantity: 4 },
    { ...tokenRule, maxQuantity: 2 },
    { ...secondsRule, maxDurationSeconds: '0' },
    { ...secondsRule, maxDurationSeconds: 'unknown' },
    { ...secondsRule, durationRounding: undefined },
  ])('拒绝混合计量来源、缺失合同或越界规则 %j', (rule) => {
    expect(billingPriceRuleSchema.safeParse(rule).success).toBe(false);
  });

  it('缺少或超出报价数量均拒绝，不能裁剪成其它数量', () => {
    for (const quantity of [0, -1, 1.5, 5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => calculateBillingQuote({ rule: imageRule, quantity })).toThrow();
    }
  });

  it('相同规格维度精确匹配，额外 Provider 参数不改变价格', () => {
    const rule = {
      ...imageRule,
      variants: [
        { parameters: { size: '1024x1024', quality: 'standard' }, unitPriceNanos: '250000000' },
        { parameters: { size: '1024x1024', quality: 'high' }, unitPriceNanos: '400000000' },
      ],
    };
    const quote = calculateBillingQuote({
      rule,
      parameters: { size: '1024x1024', quality: 'high', seed: 123 },
      quantity: 3,
    });
    expect(quote.capNanos).toBe('1200000000');
    expect(() => calculateBillingQuote({ rule, parameters: { size: '1024x1024' } })).toThrow(
      '没有已发布价格',
    );
    expect(() =>
      calculateBillingQuote({ rule, parameters: { size: '2048x2048', quality: 'high' } }),
    ).toThrow('没有已发布价格');
  });

  it('重复规格及相互覆盖的规则在发布前被拒绝', () => {
    for (const variants of [
      [
        { parameters: { size: '1024' }, unitPriceNanos: '1' },
        { parameters: { size: '1024' }, unitPriceNanos: '2' },
      ],
      [
        { parameters: { size: '1024' }, unitPriceNanos: '1' },
        { parameters: { size: '1024', quality: 'high' }, unitPriceNanos: '2' },
      ],
    ]) {
      expect(billingPriceRuleSchema.safeParse({ ...imageRule, variants }).success).toBe(false);
    }
  });

  it('价格参数不接受无限嵌套、非有限数字或原型属性', () => {
    expect(billingParametersSchema.safeParse({ size: { width: 1024 } }).success).toBe(false);
    expect(billingParametersSchema.safeParse({ size: Infinity }).success).toBe(false);
    expect(
      billingParametersSchema.safeParse(JSON.parse('{"constructor":"polluted"}')).success,
    ).toBe(false);
    expect(
      billingParametersSchema.safeParse(
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, true])),
      ).success,
    ).toBe(false);
  });

  it('金额乘积超出数据库精度时拒绝报价', () => {
    expect(() =>
      calculateBillingQuote({
        rule: { ...imageRule, unitPriceNanos: '9'.repeat(38) },
        quantity: 2,
      }),
    ).toThrow('Decimal');
  });

  it('报价深拷贝规则和规格，不受调用方后续修改影响', () => {
    const rule = { ...imageRule };
    const parameters = { quality: 'high' };
    const quote = calculateBillingQuote({ rule, parameters });
    rule.unitPriceNanos = '0' as typeof rule.unitPriceNanos;
    parameters.quality = 'low';
    expect((quote.rule as Extract<BillingPriceRule, { unit: 'per_image' }>).unitPriceNanos).toBe(
      '250000000',
    );
    expect(quote.parameters.quality).toBe('high');
  });
});

describe('Token 报价与收费', () => {
  it('按可信输入量和强制最大输出计算上限，结算后释放剩余额度', () => {
    const quote = calculateBillingQuote({
      rule: tokenRule,
      inputTokens: 1000,
      inputTokensVerified: true,
      maxOutputTokens: 2000,
    });
    expect(quote.capNanos).toBe('5000000');
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: { source: 'provider_usage', reliable: true, inputTokens: 1000, outputTokens: 500 },
      }),
    ).toEqual({
      status: 'settled',
      chargeNanos: '2000000',
      releaseNanos: '3000000',
      capped: false,
      uncappedChargeNanos: '2000000',
    });
  });

  it('禁止未验证输入与超出模型合同的上限进入付费队列', () => {
    expect(() => calculateBillingQuote({ rule: tokenRule, inputTokens: 100 })).toThrow('可信');
    expect(() => calculateBillingQuote({ rule: tokenRule, inputTokensVerified: true })).toThrow(
      '可信',
    );
    expect(() =>
      calculateBillingQuote({ rule: tokenRule, inputTokens: 100001, inputTokensVerified: true }),
    ).toThrow();
    expect(() =>
      calculateBillingQuote({
        rule: tokenRule,
        inputTokens: 100,
        inputTokensVerified: true,
        maxOutputTokens: 4097,
      }),
    ).toThrow();
  });

  it('输入输出微额先求和，再统一舍入为一个 nanos', () => {
    const quote = calculateBillingQuote({
      rule: { ...tokenRule, inputPriceNanos: '1', outputPriceNanos: '1' },
      inputTokens: 1,
      inputTokensVerified: true,
      maxOutputTokens: 1,
    });
    expect(quote.capNanos).toBe('1');
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'provider_usage',
          reliable: true,
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '1', capped: false });
  });

  it('完全不受 Provider 成本是否返回影响，只使用可靠 Token 计量', () => {
    const quote = calculateBillingQuote({
      rule: tokenRule,
      inputTokens: 10,
      inputTokensVerified: true,
    });
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'provider_usage',
          reliable: true,
          inputTokens: 10,
          outputTokens: 20,
        },
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '50000' });
  });
});

describe('图片、时长与字符计费', () => {
  it('按实际交付张数结算，不为未交付图片扣费', () => {
    const quote = calculateBillingQuote({ rule: imageRule, quantity: 4 });
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'output_metadata',
          reliable: true,
          images: 2,
        },
      }),
    ).toEqual({
      status: 'settled',
      chargeNanos: '500000000',
      releaseNanos: '500000000',
      capped: false,
      uncappedChargeNanos: '500000000',
    });
  });

  it('精确秒价保留小数并在合计后向上取整一次', () => {
    const quote = calculateBillingQuote({
      rule: { ...secondsRule, unitPriceNanos: '1' },
      durationSeconds: '0.5',
      quantity: 2,
    });
    expect(quote.capNanos).toBe('1');
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'output_metadata',
          reliable: true,
          durationsSeconds: ['0.2', '0.2'],
        },
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '1', capped: false });
  });

  it('按整秒价格分别上取整每个交付产物，不用总时长掩盖规则', () => {
    const quote = calculateBillingQuote({
      rule: { ...secondsRule, durationRounding: 'ceil_second' },
      durationSeconds: '1.01',
      quantity: 2,
    });
    expect(quote.capNanos).toBe('400000000');
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'output_metadata',
          reliable: true,
          durationsSeconds: ['0.1', '0.1'],
        },
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '200000000', releaseNanos: '200000000' });
  });

  it.each([undefined, '0', '10.000000001', '0.0000000001', 5])(
    '非法时长 %s 不能生成报价',
    (durationSeconds) => {
      expect(() =>
        calculateBillingQuote({ rule: secondsRule, durationSeconds: durationSeconds as string }),
      ).toThrow();
    },
  );

  it('按 Unicode 码点统计文字，字符来源未经验证时拒绝报价', () => {
    const rule = {
      unit: 'per_character',
      meteringSource: 'input_characters',
      unitPriceNanos: '1000',
      maxCharacters: 10,
    };
    expect(countBillingCharacters('你好😀a')).toBe(4);
    expect(countBillingCharacters('e\u0301')).toBe(2);
    expect(() => calculateBillingQuote({ rule, characters: 4 })).toThrow('可信');
    const quote = calculateBillingQuote({ rule, characters: 4, charactersVerified: true });
    expect(quote.capNanos).toBe('4000');
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'input_characters',
          reliable: true,
          characters: 4,
        },
      }),
    ).toMatchObject({ status: 'settled', chargeNanos: '4000' });
  });
});

describe('结算与报价上限', () => {
  it('固定单次价在确认交付后不依赖 Provider usage', () => {
    const quote = calculateBillingQuote({
      rule: { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: '500000000' },
    });
    expect(calculateBillingSettlement({ quote, delivery: 'delivered' })).toEqual({
      status: 'settled',
      chargeNanos: '500000000',
      releaseNanos: '0',
      capped: false,
      uncappedChargeNanos: '500000000',
    });
  });

  it('已知费用超过确认额度时封顶，并保留超限事实供对账', () => {
    const quote = calculateBillingQuote({ rule: imageRule });
    expect(
      calculateBillingSettlement({
        quote,
        delivery: 'delivered',
        usage: {
          source: 'output_metadata',
          reliable: true,
          images: 2,
        },
      }),
    ).toEqual({
      status: 'settled',
      chargeNanos: '250000000',
      releaseNanos: '0',
      capped: true,
      uncappedChargeNanos: '500000000',
    });
  });

  it('明确失败释放余额，执行结果未知保留冻结且不收费', () => {
    const quote = calculateBillingQuote({ rule: imageRule });
    expect(calculateBillingSettlement({ quote, delivery: 'failed' })).toEqual({
      status: 'released',
      chargeNanos: '0',
      releaseNanos: '250000000',
    });
    expect(calculateBillingSettlement({ quote, delivery: 'unknown' })).toEqual({
      status: 'pending_verification',
      chargeNanos: '0',
      releaseNanos: '0',
      reason: 'delivery_unknown',
    });
  });

  it('缺失、不可信或来源不匹配的用量只能待核实，不能按报价扣费', () => {
    const quote = calculateBillingQuote({ rule: imageRule });
    for (const [usage, reason] of [
      [undefined, 'usage_missing'],
      [{ source: 'output_metadata', reliable: false, images: 1 }, 'usage_unreliable'],
      [{ source: 'provider_usage', reliable: true, images: 1 }, 'usage_source_mismatch'],
      [{ source: 'output_metadata', reliable: true }, 'usage_missing'],
    ] as const) {
      expect(calculateBillingSettlement({ quote, delivery: 'delivered', usage })).toEqual({
        status: 'pending_verification',
        chargeNanos: '0',
        releaseNanos: '0',
        reason,
      });
    }
  });

  it('不能利用被改动的冻结金额或价格制造负余额', () => {
    const quote = calculateBillingQuote({ rule: imageRule });
    const tampered: BillingQuoteCalculation = { ...quote, capNanos: '1' };
    expect(() => calculateBillingSettlement({ quote: tampered, delivery: 'failed' })).toThrow(
      '不一致',
    );
  });

  it('多个用量与数量下始终满足消费加释放等于冻结，消费不超过上限', () => {
    for (const quantity of [1, 2, 3, 4]) {
      const quote = calculateBillingQuote({ rule: imageRule, quantity });
      for (const images of [0, 1, 2, 4, 5, 100]) {
        const settlement = calculateBillingSettlement({
          quote,
          delivery: 'delivered',
          usage: {
            source: 'output_metadata',
            reliable: true,
            images,
          },
        });
        expect(settlement.status).toBe('settled');
        expect(
          parseBillingNanos(settlement.chargeNanos) + parseBillingNanos(settlement.releaseNanos),
        ).toBe(parseBillingNanos(quote.capNanos));
        expect(parseBillingNanos(settlement.chargeNanos)).toBeLessThanOrEqual(
          parseBillingNanos(quote.capNanos),
        );
      }
    }
  });
});

describe('公开账务 DTO', () => {
  it('普通模型对象不接受直接携带凭据、上游成本或管理地址', () => {
    const model = {
      id: 'model-1',
      name: '图片模型',
      description: '',
      mediaType: 'image',
      specifications: {},
      availability: 'available',
      capabilities: {},
      limitations: {},
      pricing: null,
    };
    expect(marketplaceModelSchema.safeParse(model).success).toBe(true);
    for (const internal of [
      { credentialId: 'private' },
      { providerCost: '1' },
      { managementUrl: 'https://example.test' },
    ]) {
      expect(marketplaceModelSchema.safeParse({ ...model, ...internal }).success).toBe(false);
    }
  });

  it('报价总额必须等于去重后的逐项金额', () => {
    const item = {
      id: 'item-1',
      nodeId: 'node-1',
      platformModelId: 'model-1',
      modelName: '图片模型',
      pricingVersionId: 'price-1',
      unit: 'per_image',
      capNanos: '100',
    };
    const quote = {
      id: 'quote-1',
      currency: 'CNY',
      capNanos: '100',
      expiresAt: '2026-09-19T12:00:00Z',
      items: [item],
    };
    expect(billingQuoteSchema.safeParse(quote).success).toBe(true);
    expect(billingQuoteSchema.safeParse({ ...quote, capNanos: '99' }).success).toBe(false);
    expect(billingQuoteSchema.safeParse({ ...quote, capNanos: 'unknown' }).success).toBe(false);
    expect(
      billingQuoteSchema.safeParse({ ...quote, items: [{ ...item, capNanos: 'unknown' }] }).success,
    ).toBe(false);
    expect(
      billingQuoteSchema.safeParse({ ...quote, capNanos: '200', items: [item, item] }).success,
    ).toBe(false);
  });
});

import { z } from 'zod';

/** 人民币账务最小单位；1 CNY = 1,000,000,000 nanos，不按分舍入每次消费。 */
export const CNY_NANOS_PER_YUAN = 1_000_000_000n;

/** 与数据库 Decimal(38, 0) 一致的非负账务范围。 */
export const MAX_BILLING_NANOS = 10n ** 38n - 1n;

/** HTTP 和 JSON 中的金额只能是最多 38 位、无前导零的十进制非负整数字符串。 */
export const billingNanosSchema = z.string().regex(/^(0|[1-9]\d{0,37})$/);

/** 首期钱包只使用人民币；Provider 成本的原币种不经过此 schema。 */
export const billingCurrencySchema = z.literal('CNY');

/** 读取 nanos 字符串，不接受浮点金额、指数形式、负数或超过数据库精度的值。 */
export function parseBillingNanos(value: string): bigint {
  return BigInt(billingNanosSchema.parse(value));
}

/** 将内部整数转成 HTTP 金额；负数或超出 Decimal(38, 0) 时抛出 RangeError。 */
export function serializeBillingNanos(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_BILLING_NANOS) {
    throw new RangeError('金额必须是 Decimal(38, 0) 范围内的非负整数');
  }
  return value.toString();
}

/**
 * 精确读取人民币元文本，最多保留九位小数，不接受 number 或隐式舍入。
 * @param value 例如 "0.000000001" 或 "12.50"，不含货币符号和分组符号。
 * @returns 可用于 HTTP 和数据库的 nanos 字符串。
 */
export function parseCnyNanos(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,28})(\.\d{1,9})?$/.test(value)) {
    throw new RangeError('人民币金额必须是最多九位小数的非负十进制文本');
  }
  const [whole, fraction = ''] = value.split('.');
  return serializeBillingNanos(
    BigInt(whole!) * CNY_NANOS_PER_YUAN + BigInt(fraction.padEnd(9, '0')),
  );
}

/**
 * 将 nanos 精确显示为人民币元，省略尾随零但不丢失微额消费。
 * @param value HTTP 金额字符串，不接受 JavaScript number。
 * @returns 例如 "12.5"、"0.000000001"；无货币符号。
 */
export function formatCnyNanos(value: string): string {
  const amount = parseBillingNanos(value);
  const whole = amount / CNY_NANOS_PER_YUAN;
  const fraction = (amount % CNY_NANOS_PER_YUAN).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** 对非负整数的除法向上取整；仅用于整个收费项的最终 nanos 舍入。 */
export function ceilBillingDivision(numerator: bigint, denominator: bigint): bigint {
  if (
    typeof numerator !== 'bigint' ||
    typeof denominator !== 'bigint' ||
    numerator < 0n ||
    denominator <= 0n
  ) {
    throw new RangeError('向上取整要求非负整数分子和正整数分母');
  }
  return (numerator + denominator - 1n) / denominator;
}

/** 价格规格只允许短标识键和标量值；不接受嵌套对象或原型属性。 */
export const billingParametersSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .refine((key) => !['__proto__', 'prototype', 'constructor'].includes(key)),
    z.union([z.string().max(256), z.number().finite(), z.boolean()]),
  )
  .refine((parameters) => Object.keys(parameters).length <= 32, '规格维度不能超过 32 项');

/** 报价所固定的规格标量；Provider 参数兼容性仍需由调用合同验证。 */
export type BillingParameters = z.infer<typeof billingParametersSchema>;

/** 秒数最多精确到纳秒；限制整数部分长度，避免无限大计算或隐式浮点舍入。 */
export const billingSecondsSchema = z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,9})?$/);

/** 用量计数只允许安全非负整数；其值表示数量，不表示金额。 */
const usageCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** 数量上限适用于一个真实子调用的交付数量；多个子调用必须分别生成收费项。 */
const quantityFields = {
  minQuantity: z.number().int().min(1).max(10_000).default(1),
  maxQuantity: z.number().int().min(1).max(10_000).default(1),
};

/** 单价规格覆盖值；存在 variants 时不匹配任何规格会拒绝报价。 */
const unitVariantSchema = z
  .object({
    parameters: billingParametersSchema.refine((value) => Object.keys(value).length > 0),
    unitPriceNanos: billingNanosSchema,
  })
  .strict();

/** 输入与输出 Token 单价均以一百万 Token 为单位，不能解释为单 Token 价格。 */
const tokenVariantSchema = z
  .object({
    parameters: billingParametersSchema.refine((value) => Object.keys(value).length > 0),
    inputPriceNanos: billingNanosSchema,
    outputPriceNanos: billingNanosSchema,
  })
  .strict();

/** 已发布的价格规则；来源与收费单位固定配对，禁止结算时临时切换收费依据。 */
export const billingPriceRuleSchema = z
  .discriminatedUnion('unit', [
    z
      .object({
        unit: z.literal('per_call'),
        meteringSource: z.literal('fixed'),
        unitPriceNanos: billingNanosSchema,
        ...quantityFields,
        variants: z.array(unitVariantSchema).min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        unit: z.literal('per_image'),
        meteringSource: z.literal('output_metadata'),
        unitPriceNanos: billingNanosSchema,
        ...quantityFields,
        variants: z.array(unitVariantSchema).min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        unit: z.literal('per_second'),
        meteringSource: z.enum(['provider_usage', 'output_metadata']),
        unitPriceNanos: billingNanosSchema,
        ...quantityFields,
        maxDurationSeconds: billingSecondsSchema,
        durationRounding: z.enum(['exact', 'ceil_second']),
        variants: z.array(unitVariantSchema).min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        unit: z.literal('per_token'),
        meteringSource: z.literal('provider_usage'),
        inputPriceNanos: billingNanosSchema,
        outputPriceNanos: billingNanosSchema,
        maxInputTokens: usageCountSchema,
        maxOutputTokens: usageCountSchema,
        ...quantityFields,
        variants: z.array(tokenVariantSchema).min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        unit: z.literal('per_character'),
        meteringSource: z.literal('input_characters'),
        unitPriceNanos: billingNanosSchema,
        maxCharacters: usageCountSchema,
        ...quantityFields,
        variants: z.array(unitVariantSchema).min(1).max(100).optional(),
      })
      .strict(),
  ])
  .superRefine((rule, context) => {
    if (rule.minQuantity > rule.maxQuantity) {
      context.addIssue({
        code: 'custom',
        path: ['maxQuantity'],
        message: '最大数量不能小于最小数量',
      });
    }
    if (
      (rule.unit === 'per_call' || rule.unit === 'per_token' || rule.unit === 'per_character') &&
      (rule.minQuantity !== 1 || rule.maxQuantity !== 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['maxQuantity'],
        message: '按次、Token 或字符计费必须每个子调用单独报价，数量为 1',
      });
    }
    if (
      rule.unit === 'per_second' &&
      billingSecondsSchema.safeParse(rule.maxDurationSeconds).success &&
      secondsToNanos(rule.maxDurationSeconds) === 0n
    ) {
      context.addIssue({
        code: 'custom',
        path: ['maxDurationSeconds'],
        message: '最长时长必须大于零',
      });
    }
    const variants = rule.variants ?? [];
    const dimensionKeys = variants[0] ? Object.keys(variants[0].parameters).sort() : [];
    const identities = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      const keys = Object.keys(variant.parameters).sort();
      if (JSON.stringify(keys) !== JSON.stringify(dimensionKeys)) {
        context.addIssue({
          code: 'custom',
          path: ['variants', index, 'parameters'],
          message: '所有规格价格必须使用相同的维度，不能重叠或缺省匹配',
        });
      }
      const identity = JSON.stringify(keys.map((key) => [key, variant.parameters[key]]));
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['variants', index, 'parameters'],
          message: '同一规格只能配置一个价格',
        });
      }
      identities.add(identity);
    }
  });

/** 已通过运行时验证的完整价格规则，包含默认数量边界。 */
export type BillingPriceRule = z.infer<typeof billingPriceRuleSchema>;

/** 托管模型只按同一 New API 请求的最终回执计费，不在 Canvas 复制上游价格表达式。 */
export const newApiManagedPriceRuleSchema = z
  .object({ unit: z.literal('upstream_cost'), meteringSource: z.literal('newapi_receipt') })
  .strict();

/** 模型广场可同时发布既有人工售价与 New API 托管计费规则。 */
export const marketplacePriceRuleSchema = z.union([
  billingPriceRuleSchema,
  newApiManagedPriceRuleSchema,
]);

/** 平台商品的已发布计费规则；人工规则仍使用 BillingPriceRule 单独校验。 */
export type MarketplacePriceRule = z.infer<typeof marketplacePriceRuleSchema>;

/** 上游换算配置保留十进制文本，最多 38 位整数和 18 位小数，不接受指数或浮点数。 */
const newApiDecimalSchema = z.string().regex(/^(0|[1-9]\d{0,37})(\.\d{1,18})?$/);

/** 每美元 quota 与美元兑人民币汇率必须明确且大于零，禁止缺省或自动补价。 */
const newApiPositiveDecimalSchema = newApiDecimalSchema.refine((value) => /[1-9]/.test(value));

/** 模型及账单身份按原文匹配，不接受控制字符或首尾空白。 */
const newApiIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

/** 可执行模型身份与 New API 回执一致限定 512 UTF-8 字节，不把字符数当字节数。 */
const newApiModelIdSchema = newApiIdentitySchema.refine(
  (value) => new TextEncoder().encode(value).byteLength <= 512,
);

/** New API 请求关联 ID 限 ASCII 64 字符，拒绝会被 URL 归一化的独立点路径。 */
export const newApiRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .refine((value) => value !== '.' && value !== '..');

/** 异步任务 ID 保留上游原文，但不能超过持久化的 191 字节范围或包含控制字符。 */
const newApiTaskIdSchema = newApiIdentitySchema.refine(
  (value) => new TextEncoder().encode(value).byteLength <= 191,
);

/** 已鉴权目录只承诺当前 Key 可见的模型和显式能力；缺失合同不能推断为可调用。 */
export const newApiCatalogModelSchema = z
  .object({
    id: newApiIdentitySchema,
    name: z.string().max(1024).optional(),
    description: z.string().max(8192).optional(),
    media_type: z.enum(['text', 'image', 'video', 'audio']).optional(),
    contract: newApiIdentitySchema.optional(),
    capabilities: z.record(z.unknown()).optional(),
    limitations: z.record(z.unknown()).optional(),
    input_media_types: z
      .array(z.enum(['text', 'image', 'video', 'audio']))
      .max(4)
      .optional(),
    available: z.boolean(),
    unavailable_reason: z.string().max(2048).optional(),
    pricing_version: newApiIdentitySchema,
  })
  .strict()
  .refine((model) => !model.available || newApiModelIdSchema.safeParse(model.id).success, {
    path: ['id'],
    message: '可用模型 ID 不能超过 512 UTF-8 字节',
  });

/** New API 按已保存 Key 返回的只读目录，汇率只用于人民币预算转换。 */
export const newApiCatalogSchema = z
  .object({
    version: z.literal(1),
    currency: billingCurrencySchema,
    quota_per_unit: newApiPositiveDecimalSchema,
    usd_to_cny: newApiPositiveDecimalSchema,
    models: z.array(newApiCatalogModelSchema).max(20_000),
  })
  .strict()
  .refine(
    (catalog) => new Set(catalog.models.map((model) => model.id)).size === catalog.models.length,
    {
      message: '鉴权目录不能包含重复模型身份',
      path: ['models'],
    },
  );

/** 预估只表示当前上游预扣预算，不保证执行价格、路由组或最终成本不变化。 */
export const newApiEstimateSchema = z
  .object({
    version: z.literal(1),
    model: newApiModelIdSchema,
    group: newApiIdentitySchema,
    pricing_version: newApiIdentitySchema,
    estimated_quota: billingNanosSchema,
    quota_per_unit: newApiPositiveDecimalSchema,
    usd_to_cny: newApiPositiveDecimalSchema,
    expires_at: z.string().datetime({ offset: true }),
    estimate_only: z.literal(true),
  })
  .strict();

/** 最终回执由原 Key 查询原请求获得；pending 的零 quota 不能作为免费结算证据。 */
export const newApiReceiptSchema = z
  .object({
    version: z.literal(1),
    request_id: newApiRequestIdSchema,
    task_id: newApiTaskIdSchema.optional(),
    model: newApiModelIdSchema,
    group: newApiIdentitySchema,
    status: z.enum(['pending', 'settled', 'refunded']),
    quota: billingNanosSchema,
    quota_per_unit: newApiPositiveDecimalSchema,
    pricing_version: newApiIdentitySchema.optional(),
    settled_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status !== 'pending' && !receipt.settled_at)
      context.addIssue({ code: 'custom', path: ['settled_at'], message: '最终回执缺少记账时间' });
    if (receipt.status === 'refunded' && receipt.quota !== '0')
      context.addIssue({
        code: 'custom',
        path: ['quota'],
        message: '已退款回执的净 quota 必须为零',
      });
  });

/** 保留上游原始字段的已验证估算；不得拿 estimated_quota 当最终账单。 */
export type NewApiEstimate = z.infer<typeof newApiEstimateSchema>;

/** 经过鉴权传输和格式验证的账单；调用方仍须核对原请求及异步任务身份。 */
export type NewApiReceipt = z.infer<typeof newApiReceiptSchema>;

/**
 * 按冻结的每美元 quota 与汇率把 quota 精确换成人民币 nanos，最终只向上取整一次。
 * @throws 非规范金额、非正换算配置或结果超出 Decimal(38, 0) 时拒绝换算。
 */
export function newApiQuotaToCnyNanos(input: {
  quota: string;
  quotaPerUnit: string;
  usdToCny: string;
}): string {
  return serializeBillingNanos(newApiQuotaToCnyAmount(input));
}

/** 中间结果允许超过钱包存储范围，最终结算仍按可表示的用户预算封顶。 */
function newApiQuotaToCnyAmount(input: {
  quota: string;
  quotaPerUnit: string;
  usdToCny: string;
}): bigint {
  const quota = parseBillingNanos(input.quota);
  const perUnit = decimalFraction(newApiPositiveDecimalSchema.parse(input.quotaPerUnit));
  const rate = decimalFraction(newApiPositiveDecimalSchema.parse(input.usdToCny));
  return ceilBillingDivision(
    quota * perUnit.denominator * rate.numerator * CNY_NANOS_PER_YUAN,
    perUnit.numerator * rate.denominator,
  );
}

/** 托管报价固定换算配置和用户预算，执行时的上游价格允许变化但不能向用户超扣。 */
export const newApiQuoteCalculationSchema = z
  .object({
    version: z.literal(2),
    currency: billingCurrencySchema,
    rule: newApiManagedPriceRuleSchema,
    quantity: z.literal(1),
    capNanos: billingNanosSchema,
    estimate: newApiEstimateSchema,
  })
  .strict()
  .superRefine((quote, context) => {
    try {
      if (
        quote.capNanos ===
        newApiQuotaToCnyNanos({
          quota: quote.estimate.estimated_quota,
          quotaPerUnit: quote.estimate.quota_per_unit,
          usdToCny: quote.estimate.usd_to_cny,
        })
      )
        return;
    } catch {
      // 无法表示的预算同样拒绝保存；不能由上游非法数据生成零价报价。
    }
    context.addIssue({ code: 'custom', path: ['capNanos'], message: '冻结预算与预估换算不一致' });
  });

/** 可持久化的 New API 人民币预算授权；v1 人工报价格式保持不变。 */
export type NewApiQuoteCalculation = z.infer<typeof newApiQuoteCalculationSchema>;

/**
 * 生成单项报价所需的服务端计量输入。
 * inputTokensVerified/charactersVerified 必须由可信服务端计量器给出，不能信任浏览器自报。
 */
export type BillingQuoteInput = {
  rule: unknown;
  parameters?: BillingParameters;
  quantity?: number;
  inputTokens?: number;
  inputTokensVerified?: boolean;
  maxOutputTokens?: number;
  durationSeconds?: string;
  characters?: number;
  charactersVerified?: boolean;
};

/** 持久化在报价/收费项中的规则与计量上限；结算只能读取这份快照。 */
export const billingQuoteCalculationSchema = z
  .object({
    version: z.literal(1),
    currency: billingCurrencySchema,
    rule: billingPriceRuleSchema,
    parameters: billingParametersSchema,
    quantity: z.number().int().min(1).max(10_000),
    capNanos: billingNanosSchema,
    inputTokens: usageCountSchema.optional(),
    maxOutputTokens: usageCountSchema.optional(),
    durationSeconds: billingSecondsSchema.optional(),
    characters: usageCountSchema.optional(),
  })
  .strict();

/** 报价计算结果；不含付款人、有效期或报价身份，这些字段由服务端持久化层提供。 */
export type BillingQuoteCalculation = z.infer<typeof billingQuoteCalculationSchema>;

/**
 * 按已发布规则计算允许冻结的最高额度；金额只使用 BigInt。
 * @throws ZodError 或 RangeError 规则、数量、规格或计量上限不可验证时拒绝报价。
 * @returns 包含不可变价格规则的报价快照；零价也需要显式发布价格规则。
 */
export function calculateBillingQuote(input: BillingQuoteInput): BillingQuoteCalculation {
  const rule = billingPriceRuleSchema.parse(input.rule);
  const parameters = billingParametersSchema.parse(input.parameters ?? {});
  const quantity = z
    .number()
    .int()
    .min(rule.minQuantity)
    .max(rule.maxQuantity)
    .parse(input.quantity ?? 1);
  const quote: BillingQuoteCalculation = {
    version: 1,
    currency: 'CNY',
    rule,
    parameters,
    quantity,
    capNanos: '0',
  };
  const prices = resolvePrices(rule, parameters);
  let cap: bigint;
  if (rule.unit === 'per_token') {
    if (input.inputTokensVerified !== true || input.inputTokens === undefined) {
      throw new RangeError('Token 报价缺少可信服务端输入计量，不能使用估算或浏览器自报值');
    }
    quote.inputTokens = usageCountSchema.max(rule.maxInputTokens).parse(input.inputTokens);
    quote.maxOutputTokens = usageCountSchema
      .max(rule.maxOutputTokens)
      .parse(input.maxOutputTokens ?? rule.maxOutputTokens);
    cap = tokenCharge(prices, quote.inputTokens, quote.maxOutputTokens);
  } else if (rule.unit === 'per_second') {
    quote.durationSeconds = billingSecondsSchema.parse(input.durationSeconds);
    const duration = secondsToNanos(quote.durationSeconds);
    if (duration === 0n || duration > secondsToNanos(rule.maxDurationSeconds)) {
      throw new RangeError('请求时长必须大于零且不超过价格规则允许的时长');
    }
    cap = durationCharge(
      prices,
      rule.durationRounding,
      Array<string>(quantity).fill(quote.durationSeconds),
    );
  } else if (rule.unit === 'per_character') {
    if (input.charactersVerified !== true || input.characters === undefined) {
      throw new RangeError('字符计费缺少可信服务端字符统计');
    }
    quote.characters = usageCountSchema.max(rule.maxCharacters).parse(input.characters);
    cap = prices.unitPriceNanos * BigInt(quote.characters);
  } else {
    cap = prices.unitPriceNanos * BigInt(quantity);
  }
  quote.capNanos = serializeBillingNanos(cap);
  return quote;
}

/** 仅供可信计量适配器使用；source 必须与报价合同一致，reliable 不能由用户自报。 */
export const billingUsageSchema = z
  .object({
    source: z.enum(['fixed', 'provider_usage', 'output_metadata', 'input_characters']),
    reliable: z.boolean(),
    inputTokens: usageCountSchema.optional(),
    outputTokens: usageCountSchema.optional(),
    images: usageCountSchema.optional(),
    durationsSeconds: z.array(billingSecondsSchema).min(1).max(10_000).optional(),
    characters: usageCountSchema.optional(),
  })
  .strict();

/** 结算所需的真实用量；Provider 金额不是此类型，不能代替用户计量。 */
export type BillingUsage = z.infer<typeof billingUsageSchema>;

/** 未知结果保留冻结；已知失败释放；已交付且计量可靠时才允许扣费。 */
export type BillingSettlement =
  | {
      status: 'pending_verification';
      chargeNanos: '0';
      releaseNanos: '0';
      reason:
        | 'delivery_unknown'
        | 'usage_missing'
        | 'usage_unreliable'
        | 'usage_source_mismatch'
        | 'receipt_missing'
        | 'receipt_pending'
        | 'receipt_model_mismatch'
        | 'receipt_quota_unit_mismatch';
    }
  | { status: 'released'; chargeNanos: '0'; releaseNanos: string }
  | {
      status: 'settled';
      chargeNanos: string;
      releaseNanos: string;
      capped: boolean;
      /** 未裁切的确定消费；超限时供管理员对账，不允许据此向用户补扣。 */
      uncappedChargeNanos: string;
    };

/**
 * 对一项已经冻结的快照计算结算金额，不修改钱包或执行 Provider 调用。
 * @param input delivery 表示归档后的可交付结果；failed 只能用于确定无法交付或未发送的项。
 * @returns 未知执行或用量返回待核实；已知费用超出上限时封顶并显式返回 capped。
 * @throws 冻结快照不一致或提供的计量格式非法；调用方必须记录错误并保留待核实状态。
 */
export function calculateBillingSettlement(input: {
  quote: BillingQuoteCalculation;
  delivery: 'delivered' | 'failed' | 'unknown';
  usage?: BillingUsage;
}): BillingSettlement {
  const quote = billingQuoteCalculationSchema.parse(input.quote);
  const verified = calculateBillingQuote({
    ...quote,
    inputTokensVerified: true,
    charactersVerified: true,
  });
  if (verified.capNanos !== quote.capNanos) {
    throw new RangeError('冻结报价的规则与金额不一致');
  }
  const cap = parseBillingNanos(quote.capNanos);
  if (input.delivery === 'failed') {
    return { status: 'released', chargeNanos: '0', releaseNanos: quote.capNanos };
  }
  if (input.delivery !== 'delivered') {
    return pendingSettlement('delivery_unknown');
  }
  const prices = resolvePrices(quote.rule, quote.parameters);
  let amount: bigint;
  if (quote.rule.unit === 'per_call') {
    amount = prices.unitPriceNanos;
  } else {
    if (!input.usage) return pendingSettlement('usage_missing');
    const usage = billingUsageSchema.parse(input.usage);
    if (!usage.reliable) return pendingSettlement('usage_unreliable');
    if (usage.source !== quote.rule.meteringSource)
      return pendingSettlement('usage_source_mismatch');
    if (quote.rule.unit === 'per_token') {
      if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
        return pendingSettlement('usage_missing');
      }
      amount = tokenCharge(prices, usage.inputTokens, usage.outputTokens);
    } else if (quote.rule.unit === 'per_second') {
      if (!usage.durationsSeconds) return pendingSettlement('usage_missing');
      amount = durationCharge(prices, quote.rule.durationRounding, usage.durationsSeconds);
    } else if (quote.rule.unit === 'per_character') {
      if (usage.characters === undefined) return pendingSettlement('usage_missing');
      amount = prices.unitPriceNanos * BigInt(usage.characters);
    } else {
      if (usage.images === undefined) return pendingSettlement('usage_missing');
      amount = prices.unitPriceNanos * BigInt(usage.images);
    }
  }
  const charge = amount > cap ? cap : amount;
  return {
    status: 'settled',
    chargeNanos: serializeBillingNanos(charge),
    releaseNanos: serializeBillingNanos(cap - charge),
    capped: amount > cap,
    uncappedChargeNanos: amount.toString(),
  };
}

/**
 * 以最终上游净 quota 结算人民币预算；高于预算的差额由平台承担，不向用户补扣。
 * @param input 回执必须已由原冻结 Key 查询，且调用方已核对 request_id 和 task_id。
 * @returns 缺少最终回执、模型或换算单位不符时保留冻结；失败释放，已交付按预算封顶。
 * @throws 冻结预算或回执格式损坏时拒绝计算，调用方必须记录错误并保留待核实状态。
 */
export function calculateNewApiSettlement(input: {
  quote: NewApiQuoteCalculation;
  receipt?: NewApiReceipt;
  delivery: 'delivered' | 'failed' | 'unknown';
}): BillingSettlement {
  const quote = newApiQuoteCalculationSchema.parse(input.quote);
  if (input.delivery === 'failed')
    return { status: 'released', chargeNanos: '0', releaseNanos: quote.capNanos };
  if (input.delivery !== 'delivered') return pendingSettlement('delivery_unknown');
  if (!input.receipt) return pendingSettlement('receipt_missing');
  const receipt = newApiReceiptSchema.parse(input.receipt);
  if (receipt.model !== quote.estimate.model) return pendingSettlement('receipt_model_mismatch');
  const quotedUnit = decimalFraction(quote.estimate.quota_per_unit);
  const receiptUnit = decimalFraction(receipt.quota_per_unit);
  if (
    quotedUnit.numerator * receiptUnit.denominator !==
    receiptUnit.numerator * quotedUnit.denominator
  )
    return pendingSettlement('receipt_quota_unit_mismatch');
  if (receipt.status === 'pending') return pendingSettlement('receipt_pending');
  const amount = newApiQuotaToCnyAmount({
    quota: receipt.quota,
    quotaPerUnit: quote.estimate.quota_per_unit,
    usdToCny: quote.estimate.usd_to_cny,
  });
  const cap = parseBillingNanos(quote.capNanos);
  const charge = amount > cap ? cap : amount;
  return {
    status: 'settled',
    chargeNanos: serializeBillingNanos(charge),
    releaseNanos: serializeBillingNanos(cap - charge),
    capped: amount > cap,
    uncappedChargeNanos: amount.toString(),
  };
}

/** 按 Unicode 码点统计输入字符；表情代理对算一个字符，组合符按各码点计数。 */
export function countBillingCharacters(input: string): number {
  if (typeof input !== 'string') throw new TypeError('字符计费输入必须是文本');
  return Array.from(input).length;
}

/** 模型售价的公开版本信息；生效后不可原位修改规则。 */
export const marketplacePricingSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    currency: billingCurrencySchema,
    rule: marketplacePriceRuleSchema,
    effectiveAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** 普通用户可见的模型字段；调用绑定、凭据、Provider 成本和管理地址不得放入此对象。 */
export const marketplaceModelSchema = z
  .object({
    id: z.string().min(1),
    /** 展示精确上游 ID 仅用于旧模型选择兼容，不表示新的计费身份。 */
    modelAlias: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string(),
    mediaType: z.enum(['text', 'image', 'video', 'audio']),
    specifications: z.record(z.unknown()),
    availability: z.enum(['available', 'unavailable', 'needs_review']),
    availabilityReason: z.string().optional(),
    capabilities: z.record(z.unknown()),
    limitations: z.record(z.unknown()),
    pricing: marketplacePricingSchema.nullable(),
  })
  .strict();

/** 不带内部调用连接的模型广场 DTO。动态规格和能力必须由服务端白名单构造。 */
export type MarketplaceModel = z.infer<typeof marketplaceModelSchema>;

/** 普通用户可以阅读的价格版本 DTO。 */
export type MarketplacePricing = z.infer<typeof marketplacePricingSchema>;

/** 用户确认的单条收费明细；真实 upstreamModelId 和 credentialId 只保存在服务端。 */
export const billingQuoteItemSchema = z
  .object({
    id: z.string().min(1),
    quantity: z.number().int().positive().default(1),
    nodeId: z.string().min(1),
    platformModelId: z.string().min(1),
    modelName: z.string().min(1),
    pricingVersionId: z.string().min(1),
    unit: z.enum([
      'per_call',
      'per_image',
      'per_second',
      'per_token',
      'per_character',
      'upstream_cost',
    ]),
    capNanos: billingNanosSchema,
  })
  .strict();

/** 报价 HTTP 响应；服务端将 ID 绑定付款人、参数、执行计划、价格与调用绑定版本。 */
export const billingQuoteSchema = z
  .object({
    id: z.string().min(1),
    currency: billingCurrencySchema,
    capNanos: billingNanosSchema,
    expiresAt: z.string().datetime({ offset: true }),
    items: z.array(billingQuoteItemSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((quote, context) => {
    if (
      !billingNanosSchema.safeParse(quote.capNanos).success ||
      quote.items.some((item) => !billingNanosSchema.safeParse(item.capNanos).success)
    ) {
      return;
    }
    const total = quote.items.reduce((sum, item) => sum + parseBillingNanos(item.capNanos), 0n);
    if (total !== parseBillingNanos(quote.capNanos)) {
      context.addIssue({
        code: 'custom',
        path: ['capNanos'],
        message: '报价总额必须等于收费项总额',
      });
    }
    if (new Set(quote.items.map((item) => item.id)).size !== quote.items.length) {
      context.addIssue({ code: 'custom', path: ['items'], message: '报价收费项身份不能重复' });
    }
  });

/** 可以展示并等待用户接受的服务端报价；客户端金额不能覆盖服务端记录。 */
export type BillingQuote = z.infer<typeof billingQuoteSchema>;

/** 钱包只向本人返回可用与冻结金额，所有金额统一使用 nanos 十进制字符串。 */
export const billingWalletSchema = z
  .object({
    currency: billingCurrencySchema,
    availableNanos: billingNanosSchema,
    heldNanos: billingNanosSchema,
  })
  .strict();

/** 个人钱包 DTO，不含 Provider 成本或可由客户端指定的付款人字段。 */
export type BillingWallet = z.infer<typeof billingWalletSchema>;

/** 转换十进制秒为纳秒整数，避免通过 number 处理时长单价。 */
function secondsToNanos(value: string): bigint {
  const [whole, fraction = ''] = billingSecondsSchema.parse(value).split('.');
  return BigInt(whole!) * CNY_NANOS_PER_YUAN + BigInt(fraction.padEnd(9, '0'));
}

/** 将已校验的十进制拆成整数分数，保留全部小数位且不经过浮点运算。 */
function decimalFraction(value: string): { numerator: bigint; denominator: bigint } {
  const [whole, fraction = ''] = value.split('.');
  return { numerator: BigInt(`${whole}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
}

/** 已匹配具体规格后的整数单价；未使用的计费方式字段固定为零。 */
type ResolvedPrices = {
  unitPriceNanos: bigint;
  inputPriceNanos: bigint;
  outputPriceNanos: bigint;
};

/** 精确匹配规则声明的所有定价维度；其它 Provider 参数不参与价格选择。 */
function resolvePrices(rule: BillingPriceRule, parameters: BillingParameters): ResolvedPrices {
  const variant = rule.variants?.find((candidate) =>
    Object.entries(candidate.parameters).every(([key, value]) => parameters[key] === value),
  );
  if (rule.variants && !variant) throw new RangeError('所选规格没有已发布价格');
  const selected = variant ?? rule;
  if ('inputPriceNanos' in selected) {
    return {
      unitPriceNanos: 0n,
      inputPriceNanos: parseBillingNanos(selected.inputPriceNanos),
      outputPriceNanos: parseBillingNanos(selected.outputPriceNanos),
    };
  }
  return {
    unitPriceNanos: parseBillingNanos(selected.unitPriceNanos),
    inputPriceNanos: 0n,
    outputPriceNanos: 0n,
  };
}

/** 输入输出先合计分子，再按一百万 Token 的价格统一向上取整到一个 nanos。 */
function tokenCharge(prices: ResolvedPrices, inputTokens: number, outputTokens: number): bigint {
  return ceilBillingDivision(
    prices.inputPriceNanos * BigInt(inputTokens) + prices.outputPriceNanos * BigInt(outputTokens),
    1_000_000n,
  );
}

/** 按合同对各产物时长取整后汇总，最后只进行一次 nanos 级金额舍入。 */
function durationCharge(
  prices: ResolvedPrices,
  rounding: 'exact' | 'ceil_second',
  durations: string[],
): bigint {
  const total = durations.reduce((sum, duration) => {
    const nanos = secondsToNanos(duration);
    return (
      sum +
      (rounding === 'ceil_second'
        ? ceilBillingDivision(nanos, CNY_NANOS_PER_YUAN) * CNY_NANOS_PER_YUAN
        : nanos)
    );
  }, 0n);
  return ceilBillingDivision(prices.unitPriceNanos * total, CNY_NANOS_PER_YUAN);
}

/** 待核实既不消费也不释放；钱包层保留该项原有冻结。 */
function pendingSettlement(
  reason: Extract<BillingSettlement, { status: 'pending_verification' }>['reason'],
): BillingSettlement {
  return { status: 'pending_verification', chargeNanos: '0', releaseNanos: '0', reason };
}

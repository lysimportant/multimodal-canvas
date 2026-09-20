/** OpenAPI 3.1 JSON Schema 片段；动态组合保持普通对象，不依赖运行时数据库类型。 */
type Schema = Record<string, unknown>;

/** 普通账户和管理员均需要真实可撤销会话，服务 Token 不代表付款人。 */
const sessionDescription =
  '需要已验证且未撤销的账户会话；服务 Token、匿名模式和未验证的 JWT 角色均不可使用。';
/** 平台价格与钱包金额的最小单位为 10^-9 CNY，绝不能转为浮点数或指数形式。 */
const nanosSchema = {
  type: 'string',
  pattern: '^(0|[1-9]\\d{0,37})$',
  description: '人民币十亿分之一元的非负整数字符串；1000000000 表示 1 元。',
};
/** 流水增量与人工额度调整允许负整数，但余额和冻结金额不能为负。 */
const signedNanosSchema = {
  ...nanosSchema,
  pattern: '^-?(0|[1-9]\\d{0,37})$',
  description: '人民币十亿分之一元的有符号整数字符串；不能使用小数或科学计数法。',
};
/** UUID 只代表稳定记录身份，不携带连接地址或密钥。 */
const uuid = { type: 'string', format: 'uuid' };
/** 持久化时刻均以 ISO 8601 字符串返回。 */
const dateTime = { type: 'string', format: 'date-time' };
/** 展示用媒体类型使用小写，保持与画布合同一致。 */
const mediaType = { type: 'string', enum: ['text', 'image', 'audio', 'video'] };
/** 老客户端缺省读取 models，New API 公开目录与鉴权联动须显式选择，各来源互不覆盖。 */
const sourceType = {
  type: 'string',
  enum: ['models', 'newapi_pricing', 'newapi_managed'],
  default: 'models',
};
/** 公布的计费单位不等于所有适配器目前都能完成可信计量。 */
const units = [
  'per_call',
  'per_image',
  'per_second',
  'per_token',
  'per_character',
  'upstream_cost',
];
/** 每个子调用的可交付数量边界，不表示工作流节点数或批次数。 */
const quantity = { type: 'integer', minimum: 1, maximum: 10_000, default: 1 };
/** Token 和字符计数必须为安全整数；只描述规则上限，不接受浏览器自报用量。 */
const usageCount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
/** 服务端价格规则可使用纳秒级秒数；当前生成报价仅支持明确的正整数请求秒数。 */
const seconds = { type: 'string', pattern: '^(0|[1-9]\\d{0,8})(\\.\\d{1,9})?$' };
/** 规格与能力 JSON 不允许认证字段、内部地址或路径，服务端另有白名单与长度校验。 */
const metadata = {
  type: 'object',
  additionalProperties: true,
  description:
    '模型规格或已验证能力的结构化声明，不能包含认证资料、内部地址或路径；单字段 JSON 不超过 32768 字符。',
};

/** 创建明确字段白名单的 JSON 对象。 */
function object(
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}
/** 引用主文档组件，防止金额与隐私边界在各响应中漂移。 */
function ref(name: string): Schema {
  return { $ref: `#/components/schemas/${name}` };
}
/** 可空数据库字段显式使用 null，不能与缺省字段混淆。 */
function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] };
}
/** 返回字段包裹，与实际路由的 model、pricing、wallet 等响应一致。 */
function envelope(key: string, schema: Schema): Schema {
  return object({ [key]: schema });
}
/** 标准 JSON 内容定义同时供请求和响应使用。 */
function json(schema: Schema) {
  return { 'application/json': { schema } };
}
/** 正常与业务错误均输出 JSON；具体缓存响应头由实际入口控制。 */
function response(description: string, schema: Schema) {
  return {
    description,
    content: json(schema),
  };
}
/** 请求体必需且只接受 JSON；字段是否必填由具体 schema 决定。 */
function body(schema: Schema) {
  return { required: true, content: json(schema) };
}
/** 路径记录 ID 默认为 UUID；runId 使用稳定的外部运行字符串。 */
function pathId(name: string, schema: Schema = uuid) {
  return { name, in: 'path', required: true, schema };
}
/** 查询参数的 required 缺省为 false，避免分页字段被标为必填。 */
function query(name: string, schema: Schema, required = false) {
  return { name, in: 'query', required, schema };
}
/** 平台商品与版本列表共用页长上限，默认 30 项。 */
const pagination = [
  query('page', { type: 'integer', minimum: 1, maximum: 100_000, default: 1 }),
  query('pageSize', { type: 'integer', minimum: 1, maximum: 100, default: 30 }),
];
/** 钱包和待核实列表固定每页 50 项，不接收 pageSize。 */
const ledgerPagination = [pagination[0]!];
/** 分页结果保留 total；仅钱包和待核实接口按实际实现省略 total。 */
function page(items: Schema): Schema {
  return object({
    items: { type: 'array', items },
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    total: { type: 'integer', minimum: 0 },
  });
}

/** 价格规格变体必须使用相同维度集合，精确匹配一个规格；不允许回退到其他价格。 */
const variantsParameters = {
  type: 'object',
  minProperties: 1,
  maxProperties: 32,
  propertyNames: {
    pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$',
    not: { enum: ['__proto__', 'prototype', 'constructor'] },
  },
  additionalProperties: {
    oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }],
  },
};
/** 固定、图片、秒和字符规则的单价规格；金额单位仍为 nanos。 */
const unitVariants = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: object({ parameters: variantsParameters, unitPriceNanos: ref('BillingNanos') }),
};
/** Token 单价以一百万 Token 为单位，输入和输出价格分开保存。 */
const tokenVariants = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: object({
    parameters: variantsParameters,
    inputPriceNanos: {
      ...ref('BillingNanos'),
      description: '每一百万输入 Token 的人民币 nanos 单价。',
    },
    outputPriceNanos: {
      ...ref('BillingNanos'),
      description: '每一百万输出 Token 的人民币 nanos 单价。',
    },
  }),
};
/** 按次、Token、字符必须分别对应真实子调用，数量边界只能为 1。 */
const singleQuantity = { type: 'integer', const: 1, default: 1 };
/** 每个价格分支的公共字段；variants 可选，但一旦提供就必须精确匹配。 */
function unitRule(
  unit: string,
  source: string | string[],
  extra: Record<string, unknown> = {},
  required: string[] = [],
) {
  return object(
    {
      unit: { type: 'string', const: unit },
      meteringSource:
        typeof source === 'string'
          ? { type: 'string', const: source }
          : { type: 'string', enum: source },
      unitPriceNanos: ref('BillingNanos'),
      minQuantity: ['per_call', 'per_character'].includes(unit) ? singleQuantity : quantity,
      maxQuantity: ['per_call', 'per_character'].includes(unit) ? singleQuantity : quantity,
      variants: unitVariants,
      ...extra,
    },
    ['unit', 'meteringSource', 'unitPriceNanos', ...required],
  );
}
/** 价格创建与公开售价使用同一规则合同，所有版本只能追加，不能原地更新。 */
const priceRule = {
  oneOf: [
    unitRule('per_call', 'fixed'),
    unitRule('per_image', 'output_metadata'),
    unitRule(
      'per_second',
      ['provider_usage', 'output_metadata'],
      {
        maxDurationSeconds: seconds,
        durationRounding: { type: 'string', enum: ['exact', 'ceil_second'] },
      },
      ['maxDurationSeconds', 'durationRounding'],
    ),
    object(
      {
        unit: { type: 'string', const: 'per_token' },
        meteringSource: { type: 'string', const: 'provider_usage' },
        inputPriceNanos: {
          ...ref('BillingNanos'),
          description: '每一百万输入 Token 的人民币 nanos 单价。',
        },
        outputPriceNanos: {
          ...ref('BillingNanos'),
          description: '每一百万输出 Token 的人民币 nanos 单价。',
        },
        maxInputTokens: usageCount,
        maxOutputTokens: usageCount,
        minQuantity: singleQuantity,
        maxQuantity: singleQuantity,
        variants: tokenVariants,
      },
      [
        'unit',
        'meteringSource',
        'inputPriceNanos',
        'outputPriceNanos',
        'maxInputTokens',
        'maxOutputTokens',
      ],
    ),
    unitRule('per_character', 'input_characters', { maxCharacters: usageCount }, ['maxCharacters']),
    object({
      unit: { type: 'string', const: 'upstream_cost' },
      meteringSource: { type: 'string', const: 'newapi_receipt' },
    }),
  ],
  discriminator: { propertyName: 'unit' },
  description:
    '币种固定 CNY。upstream_cost 无单价字段，每次由 New API 预估人民币预算，交付后以原请求最终回执和冻结换算结算，用户扣费不超过确认预算。其余规则为手工定价，minQuantity 不得超过 maxQuantity；显式零价允许，缺价禁止执行。手工 Token 缺可信输入计量时返回 metering_unavailable；字符只支持完整冻结语音文本，按秒需明确时长。',
};

/** 普通用户可见的价格不包含上游成本、供应商币种、操作者或连接标识。 */
const publicPricing = object({
  id: uuid,
  revision: { type: 'integer', minimum: 1 },
  currency: { type: 'string', const: 'CNY' },
  rule: ref('BillingPriceRule'),
  effectiveAt: dateTime,
});
/** 公开商品保留稳定平台 ID；精确上游 modelAlias 仅作兼容展示，不构成商品主键。 */
const publicModelProperties = {
  connection: {
    ...object({ id: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 } }),
    description:
      '可选的公开来源身份与主机/安全 Key 尾号。不能用作调用凭据；不含原始凭据 ID、指纹、完整 Key 或地址路径。',
  },
  id: uuid,
  name: { type: 'string' },
  description: { type: 'string' },
  mediaType,
  specifications: metadata,
  modelAlias: {
    type: 'string',
    description: '当前绑定的精确上游模型 ID，可能随 API 切换而变化；保存选择应使用平台 id。',
  },
  capabilities: metadata,
  limitations: metadata,
  pricing: nullable(ref('MarketplacePricing')),
  availability: { type: 'string', enum: ['available', 'unavailable', 'needs_review'] },
  availabilityReason: { type: 'string' },
};
/** 名称和说明可手工维护；只导入候选时允许省略名称。 */
const writableModel = {
  name: { type: 'string', minLength: 1, maxLength: 160 },
  description: { type: 'string', maxLength: 4000, default: '' },
  specifications: metadata,
  sortOrder: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000, default: 0 },
};
/** 创建绑定时管理员提供精确版本与人工验证依据，接口不会自动发起生成验证。 */
const writableBinding = {
  credentialId: uuid,
  credentialVersion: { type: 'integer', minimum: 1 },
  upstreamModelId: {
    type: 'string',
    minLength: 1,
    maxLength: 512,
    description: '精确模型 ID，不允许首尾空白，不改变大小写或括号内容。',
  },
  contract: {
    type: 'string',
    enum: [
      'openai-chat-completions',
      'openai-images',
      'newapi-video-v1',
      'newapi-unified-v1',
      'legacy-v1',
      'openai-audio',
    ],
  },
  capabilities: { ...metadata, minProperties: 1 },
  limitations: metadata,
  verificationEvidence: { type: 'string', minLength: 1, maxLength: 4000 },
  verifiedAt: dateTime,
};
/** 钱包与逐项账单只暴露用户金额及平台身份，不返回内部快照、连接或 Provider 成本。 */
const publicChargeItem = object({
  id: uuid,
  nodeId: { type: 'string' },
  platformModelId: uuid,
  status: {
    type: 'string',
    enum: ['HELD', 'PENDING_VERIFICATION', 'SETTLED', 'RELEASED', 'REFUNDED'],
  },
  maximumNanos: ref('BillingNanos'),
  settledNanos: ref('BillingNanos'),
  refundedNanos: ref('BillingNanos'),
});
/** 管理员成本保持供应商原币种；固定小数字符串与人民币 nanos 是两类独立金额。 */
const providerCostProperties = {
  status: {
    type: 'string',
    enum: ['unknown', 'pending_reconciliation', 'confirmed', 'disputed', 'adjudicated'],
    description:
      'adjudicated 表示已记录管理员裁决，原始 amount/currency 不覆盖；有效裁决在详情 evidence.decision 中，历次处理在 history 中。',
  },
  amount: nullable(ref('ProviderCostAmount')),
  currency: nullable({ type: 'string', pattern: '^[A-Z]{3}$' }),
  source: nullable({ type: 'string' }),
};
/** 管理列表与收费详情共用身份白名单，列表不包含证据正文或绑定版本。 */
const adminChargeItemProperties = {
  ...(publicChargeItem.properties as Record<string, unknown>),
  createdAt: dateTime,
  charge: object({ runId: { type: 'string' }, payerId: uuid }),
  providerCost: nullable(ref('ProviderCostSummary')),
};

/** 所有账务与模型组件；公开 DTO 和管理 DTO 分开定义，防止误导客户端获取私有字段。 */
export const billingOpenApiSchemas = {
  BillingNanos: nanosSchema,
  SignedBillingNanos: signedNanosSchema,
  BillingPriceRule: priceRule,
  BillingError: object(
    {
      code: {
        type: 'string',
        description:
          '稳定业务码，例如 quote_required、quote_changed、quote_expired、insufficient_balance、retry_requires_review。',
      },
      error: { type: 'string' },
      issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    ['error'],
  ),
  BillingQuote: object({
    id: uuid,
    currency: { type: 'string', const: 'CNY' },
    capNanos: ref('BillingNanos'),
    expiresAt: dateTime,
    items: {
      type: 'array',
      minItems: 1,
      items: object({
        id: {
          type: 'string',
          description: '报价项展示身份，格式为 quoteId:nodeId；不等于结算 chargeItemId。',
        },
        nodeId: { type: 'string' },
        platformModelId: uuid,
        modelName: { type: 'string' },
        pricingVersionId: uuid,
        capNanos: ref('BillingNanos'),
        unit: { type: 'string', enum: units },
        quantity: { type: 'integer', const: 1 },
      }),
    },
  }),
  Wallet: object({
    currency: { type: 'string', const: 'CNY' },
    availableNanos: ref('BillingNanos'),
    heldNanos: ref('BillingNanos'),
  }),
  WalletEntry: object({
    id: uuid,
    walletId: uuid,
    kind: { type: 'string', enum: ['adjustment', 'hold', 'settlement', 'release', 'refund'] },
    availableDeltaNanos: ref('SignedBillingNanos'),
    heldDeltaNanos: ref('SignedBillingNanos'),
    availableAfterNanos: ref('BillingNanos'),
    heldAfterNanos: ref('BillingNanos'),
    idempotencyKey: { type: 'string' },
    runId: nullable({ type: 'string' }),
    chargeItemId: nullable(uuid),
    relatedEntryId: nullable(uuid),
    actorId: nullable(uuid),
    reason: { type: 'string' },
    createdAt: dateTime,
  }),
  RunCharge: object({
    runId: { type: 'string' },
    quoteId: uuid,
    currency: { type: 'string', const: 'CNY' },
    maximumNanos: ref('BillingNanos'),
    items: { type: 'array', items: publicChargeItem },
  }),
  ProviderCostAmount: {
    type: 'string',
    pattern: '^(0|[1-9]\\d{0,25})(\\.\\d{1,12})?$',
    description:
      '供应商原币种的非负金额，最多 26 位整数和 12 位小数；JSON 返回完整十进制文本，不是人民币 nanos，不自动换汇。',
  },
  ProviderCostSummary: object(providerCostProperties),
  ProviderCostEvidence: object(
    {
      observations: {
        type: 'array',
        items: object(
          {
            amount: ref('ProviderCostAmount'),
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            source: { type: 'string' },
            recordedAt: dateTime,
          },
          [],
        ),
      },
      decision: {
        ...object(
          {
            amount: ref('ProviderCostAmount'),
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            actorId: uuid,
            reason: { type: 'string' },
            decidedAt: dateTime,
          },
          [],
        ),
        description: '当前独立裁决；只投影已记录字段，旧记录缺失值不补造。',
      },
    },
    ['observations'],
  ),
  ProviderCostDetail: object({
    ...providerCostProperties,
    evidence: nullable(ref('ProviderCostEvidence')),
    updatedAt: dateTime,
  }),
  AdminChargeItemSummary: object(adminChargeItemProperties),
  AdminChargeItemDetail: object({
    ...adminChargeItemProperties,
    bindingId: uuid,
    pricingVersionId: uuid,
    executionState: { type: 'string', enum: ['unsent', 'sending', 'sent', 'delivered'] },
    providerRequestId: nullable({ type: 'string' }),
    deliveryEvidence: nullable(ref('BillingDeliveryEvidence')),
    usage: nullable({
      ...object(
        {
          source: {
            type: 'string',
            enum: ['fixed', 'provider_usage', 'output_metadata', 'input_characters'],
          },
          reliable: { type: 'boolean' },
          inputTokens: usageCount,
          outputTokens: usageCount,
          images: usageCount,
          durationsSeconds: { type: 'array', minItems: 1, maxItems: 10_000, items: seconds },
          characters: usageCount,
        },
        [],
      ),
      description: '可信计量来源及数量；只投影已记录字段，不透传上游原始正文或把成本金额当作用量。',
    }),
    providerCost: nullable(ref('ProviderCostDetail')),
    updatedAt: dateTime,
  }),
  BillingDeliveryEvidence: {
    ...object(
      {
        nodeId: { type: 'string' },
        assetId: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        resultType: { type: 'string', enum: ['reverse_prompt', 'prompt_optimization'] },
        providerTaskId: { type: 'string' },
        providerJobId: { type: 'string' },
        deliveryState: { type: 'string', const: 'archived' },
        conversion: object({
          quotaPerUnit: { type: 'string' },
          usdToCny: { type: 'string' },
        }),
        newApiReceipt: object(
          {
            version: { type: 'integer', const: 1 },
            request_id: { type: 'string' },
            task_id: { type: 'string' },
            model: { type: 'string' },
            group: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'settled', 'refunded'] },
            quota: ref('BillingNanos'),
            quota_per_unit: { type: 'string' },
            pricing_version: { type: 'string' },
            settled_at: dateTime,
          },
          [],
        ),
        settlement: object(
          {
            status: { type: 'string', enum: ['settled', 'released', 'pending_verification'] },
            chargeNanos: ref('BillingNanos'),
            uncappedChargeNanos: {
              type: 'string',
              pattern: '^(0|[1-9]\\d*)$',
              description: '未封顶的计量金额，仅作核实依据，不允许据此补扣。',
            },
            releaseNanos: ref('BillingNanos'),
            reason: { type: 'string' },
            capped: { type: 'boolean' },
          },
          [],
        ),
      },
      [],
    ),
    description:
      '只读取归档身份、结算摘要及 New API 原请求回执和冻结换算的白名单字段，不含 result 正文、提示词、请求快照、Key 或供应商附加字段；不发起新调用。',
  },
  BillingAuditRecord: object({
    id: uuid,
    actorId: nullable(uuid),
    action: { type: 'string', pattern: '^billing\\.' },
    summary: {
      type: 'string',
      description:
        'JSON 字符串，只保留 chargeItemId、action、kind、reason、amount、currency、source、previousResolution、previousResolvedBy 和 previousResolvedAt 等账务事实；无法解析的旧摘要返回固定核实说明，原审计记录不改写。',
    },
    createdAt: dateTime,
  }),
  MarketplacePricing: publicPricing,
  MarketplaceModel: {
    ...object(
      publicModelProperties,
      Object.keys(publicModelProperties).filter(
        (key) => !['modelAlias', 'availabilityReason', 'connection'].includes(key),
      ),
    ),
    description:
      '公开商品需要登录；不含 credentialId、绑定内部版本、Key、管理 URL 或供应商成本。下架不会删除模型身份及历史记录。',
  },
  MarketplaceAdminModel: object(
    {
      ...publicModelProperties,
      status: { type: 'string', enum: ['draft', 'published', 'paused'] },
      sortOrder: { type: 'integer' },
      activeBindingId: nullable(uuid),
      activePricingVersionId: nullable(uuid),
      sourceSyncId: nullable(uuid),
      sourceModelId: nullable({ type: 'string' }),
      createdAt: dateTime,
      updatedAt: dateTime,
    },
    [
      ...Object.keys(publicModelProperties).filter(
        (key) => !['modelAlias', 'availabilityReason', 'connection'].includes(key),
      ),
      'status',
      'sortOrder',
      'activeBindingId',
      'activePricingVersionId',
      'sourceSyncId',
      'sourceModelId',
      'createdAt',
      'updatedAt',
    ],
  ),
  MarketplaceBinding: {
    ...object({
      id: uuid,
      platformModelId: uuid,
      revision: { type: 'integer', minimum: 1 },
      ...writableBinding,
      createdBy: uuid,
      createdAt: dateTime,
    }),
    description: '仅管理员可见的不可变调用绑定，包含凭据记录 ID 和版本，但不返回 Key。',
  },
  MarketplacePricingVersion: object({
    ...(publicPricing.properties as Record<string, unknown>),
    platformModelId: uuid,
    createdBy: uuid,
    createdAt: dateTime,
  }),
  NewApiPricingReference: object(
    {
      source: { type: 'string', const: 'newapi_pricing' },
      quotaType: { type: 'integer', enum: [0, 1] },
      modelPrice: object({
        amount: { type: 'string', maxLength: 100 },
        currency: { type: 'string', const: 'USD' },
        unit: { type: 'string', const: 'per_call' },
      }),
      ratios: {
        type: 'array',
        maxItems: 7,
        items: object({ name: { type: 'string' }, value: { type: 'string', maxLength: 100 } }),
      },
      groups: {
        type: 'array',
        maxItems: 256,
        items: object(
          {
            name: { type: 'string', maxLength: 160 },
            ratio: { type: 'string', maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
          },
          ['name'],
        ),
      },
      billingMode: { type: 'string', maxLength: 80 },
      expression: {
        type: 'string',
        maxLength: 8000,
        description: '有界纯文本，只供管理员查阅，绝不执行或转为平台定价。',
      },
      pricingVersion: {
        type: 'string',
        maxLength: 160,
        description: '上游原始文本，不作为 ETag 或内容变化判断依据。',
      },
      incomplete: {
        type: 'boolean',
        const: true,
        description: '存在未解析的插件计费，须到上游核实；不展示旧 model_price。',
      },
    },
    ['source', 'ratios', 'groups'],
  ),
  ModelCatalogSync: object({
    id: uuid,
    credentialId: uuid,
    sourceType,
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    candidates: {
      type: 'array',
      items: object(
        {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string', maxLength: 4000 },
          vendorName: { type: 'string', maxLength: 160 },
          tags: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 80 } },
          endpointTypes: {
            type: 'array',
            maxItems: 256,
            items: { type: 'string', maxLength: 80 },
            description: '上游端点类型原文，仅来源参考，不代表媒体能力或可执行合同。',
          },
          pricingReference: ref('NewApiPricingReference'),
          managed: object(
            {
              available: { type: 'boolean' },
              contract: { type: 'string' },
              pricingVersion: { type: 'string' },
              reason: { type: 'string' },
            },
            ['available', 'pricingVersion'],
          ),
          mediaTypes: { type: 'array', items: mediaType },
          capabilities: metadata,
          limitations: metadata,
          providerDeclaredPrice: {
            type: 'object',
            additionalProperties: true,
            description: '只供管理员参考的上游原币种价格，不作为平台售价或钱包扣费依据。',
          },
          refreshedAt: dateTime,
          verification: { type: 'string', const: 'unverified' },
        },
        ['id', 'name', 'mediaTypes', 'capabilities', 'limitations', 'refreshedAt', 'verification'],
      ),
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: '本次目录缺失的旧 ID；不会删除平台商品。',
    },
    errorCode: nullable({ type: 'string' }),
    createdBy: uuid,
    createdAt: dateTime,
  }),
  ReconciliationItem: object(
    {
      id: uuid,
      chargeItemId: uuid,
      kind: {
        type: 'string',
        enum: ['execution', 'provider_cost', 'worker_recovery', 'settlement_conflict'],
      },
      reason: { type: 'string' },
      status: { type: 'string', enum: ['open', 'resolved'] },
      dueAt: dateTime,
      resolution: nullable({ type: 'string' }),
      resolvedBy: nullable(uuid),
      resolvedAt: nullable(dateTime),
      createdAt: dateTime,
      updatedAt: dateTime,
      overdue: {
        type: 'boolean',
        description: '仅待核实列表额外返回；逾期不会自动退款、补扣或重发。',
      },
    },
    [
      'id',
      'chargeItemId',
      'kind',
      'reason',
      'status',
      'dueAt',
      'resolution',
      'resolvedBy',
      'resolvedAt',
      'createdAt',
      'updatedAt',
    ],
  ),
};

/** 所有可能创建真实子调用的入口共用确认字段；quoteOnly 与 quoteId 不可同时提供。 */
export const billingSubmissionProperties = {
  quoteOnly: {
    type: 'boolean',
    description:
      'true 只执行权限、模型、参数和资产冻结检查，返回五分钟报价，不冻结余额、不排队。已受理的幂等任务可能直接返回 202 恢复响应。',
  },
  quoteId: {
    type: 'string',
    format: 'uuid',
    description:
      '用户明确接受的服务端报价身份；提交原参数。过期、模型/价格/绑定/参数改变时需重新报价并确认。',
  },
};
/** 顶层或画布保存的 platformModelId 优先于旧名称和连接提示。 */
export const platformModelSelectionProperty = {
  type: 'string',
  format: 'uuid',
  description:
    '平台模型稳定身份；切换 API 不改变此 ID。旧 modelAlias/credentialId 只在唯一已发布商品匹配时兼容。',
};
/** 正式计费启用后的提交语义，批量生成对每个实际调用单独报价与确认。 */
export const billingSubmissionDescription =
  '启用平台计费时必须使用真实账户会话。先提交 quoteOnly=true 获取五分钟人民币报价，再用相同输入和 quoteId 确认；余额冻结、Run 与 outbox 同事务落库。报价覆盖工作流全部实际生成节点，来源节点不收费。单次调用仅支持一个结果，批量通过多个独立调用处理。缺少报价返回 quote_required；过期或输入、模型绑定、售价变化必须重新确认，不自动续价。';
/** 所有生成入口共用 200 报价响应，202 始终是已受理运行而非待付款报价。 */
export const billingQuoteResponse = response(
  '仅返回本次用户可确认的报价，不冻结余额、不排队',
  envelope('quote', ref('BillingQuote')),
);
/** 财务拒绝保留对应状态，不能折叠为通用 503。 */
export const billingSubmissionErrors = {
  '401': response('需要真实且有效的账户会话', ref('BillingError')),
  '402': response(
    '可用余额不足，或底层运行服务缺少必需报价；本次冻结与 Run 均不提交',
    ref('BillingError'),
  ),
  '409': response(
    '报价缺失、过期、模型/参数变化、幂等冲突或原调用待核实；禁止自动重新发送',
    ref('BillingError'),
  ),
  '503': response('账务、模型目录或持久任务服务未配置或暂不可用', ref('BillingError')),
};

/**
 * 生成模型广场与账务全部已实现路由。管理员接口只返回已验证会话拥有的管理信息。
 * @returns 展开到主文档 paths 的片段；不含支付通道或尚未实现的删除/调价更新接口。
 */
export function billingOpenApiPaths() {
  /** 权限描述仅说明真实实现，不把任意 Bearer Token 当成账户会话。 */
  const operation = (summary: string, admin = false, description = '') => ({
    tags: [admin ? 'billing-admin' : 'billing'],
    summary,
    security: [{ bearerAuth: [] }],
    description: `${sessionDescription}${admin ? '仅管理员可操作，普通用户返回 403。' : ''}${description}`,
  });
  /** 模型和账务错误都包含稳定 code 与中文说明。 */
  const errors = {
    '400': response('字段、金额、数量、规则或验证依据无效', ref('BillingError')),
    '401': billingSubmissionErrors['401'],
    '403': response('仅管理员可操作', ref('BillingError')),
    '404': response('对象不存在或无权访问', ref('BillingError')),
    '409': billingSubmissionErrors['409'],
    '503': billingSubmissionErrors['503'],
  };
  /** 调账和退款均必须带业务幂等键及可审计原因。 */
  const adjustmentFields = {
    amountNanos: ref('SignedBillingNanos'),
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
  };
  /** 公开目录不可按草稿状态查询；管理目录可以筛选发布状态。 */
  const modelFilters = [
    ...pagination,
    query('query', { type: 'string', maxLength: 160 }),
    query('mediaType', mediaType),
  ];
  return {
    '/v1/model-marketplace': {
      get: {
        ...operation(
          '读取已发布平台模型',
          false,
          '公开 DTO 不包含凭据、绑定内部信息或上游成本；手工模型不依赖 /v1/models。',
        ),
        parameters: modelFilters,
        responses: {
          '200': response('已发布商品与当前售价、可用状态', page(ref('MarketplaceModel'))),
          ...errors,
        },
      },
    },
    '/v1/admin/model-marketplace/models': {
      get: {
        ...operation('管理员列出平台模型', true),
        parameters: [
          ...modelFilters,
          query('status', { type: 'string', enum: ['draft', 'published', 'paused'] }),
        ],
        responses: {
          '200': response('草稿、已发布或暂停的商品', page(ref('MarketplaceAdminModel'))),
          ...errors,
        },
      },
      post: {
        ...operation(
          '管理员创建手工模型或联动 New API 模型',
          true,
          '必须提供 name 或 source。手工创建和公开目录导入需要 mediaType，初始为草稿。managed=true 只接受 newapi_managed 成功来源，重新校验 Key 权限和调用合同后建立稳定商品、绑定及跟随价格策略并发布；重复导入保留人工字段、已有手工价格和暂停状态，无需提供单价或媒体类型。',
        ),
        requestBody: body({
          ...object(
            {
              ...writableModel,
              mediaType,
              managed: { type: 'boolean' },
              source: object({
                syncId: uuid,
                upstreamModelId: { type: 'string', minLength: 1, maxLength: 512 },
              }),
            },
            [],
          ),
          anyOf: [{ required: ['name'] }, { required: ['source'] }],
          allOf: [
            {
              if: { properties: { managed: { const: true } }, required: ['managed'] },
              then: { required: ['source'] },
              else: { required: ['mediaType'] },
            },
          ],
        }),
        responses: {
          '201': response(
            '独立平台模型；托管新导入可发布，人工创建初始为 draft',
            envelope('model', ref('MarketplaceAdminModel')),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/model-marketplace/models/{id}': {
      parameters: [pathId('id')],
      delete: {
        ...operation(
          '管理员删除模型',
          true,
          '逻辑删除后退出管理列表、广场和新任务选择；历史绑定、价格、账单及已受理任务保留。重复删除返回 204，未知 ID 返回 404。托管同步不会恢复已删除的同身份模型。',
        ),
        responses: { '204': { description: '已删除，无响应体' }, ...errors },
      },
      get: {
        ...operation('管理员读取一个平台模型', true),
        responses: {
          '200': response(
            '模型详情及当前版本指针',
            envelope('model', ref('MarketplaceAdminModel')),
          ),
          ...errors,
        },
      },
      patch: {
        ...operation(
          '管理员更新人工字段、启用版本或发布状态',
          true,
          '修改售价或调用合同必须先创建新版本，再更新活动版本。上架必须有已验证可用绑定和已生效 CNY 售价；不删除历史商品、绑定或价格。',
        ),
        requestBody: body({
          ...object(
            {
              ...writableModel,
              status: { type: 'string', enum: ['draft', 'published', 'paused'] },
              activeBindingId: nullable(uuid),
              activePricingVersionId: nullable(uuid),
            },
            [],
          ),
          minProperties: 1,
        }),
        responses: {
          '200': response('已更新的管理视图', envelope('model', ref('MarketplaceAdminModel'))),
          ...errors,
        },
      },
    },
    '/v1/admin/model-marketplace/models/{id}/bindings': {
      parameters: [pathId('id')],
      get: {
        ...operation('管理员读取调用绑定版本历史', true),
        parameters: pagination,
        responses: {
          '200': response(
            '按 revision 倒序返回不可变绑定，包含凭据身份但没有 Key',
            page(ref('MarketplaceBinding')),
          ),
          ...errors,
        },
      },
      post: {
        ...operation(
          '管理员新增已验证的调用绑定',
          true,
          'verifiedAt 不得在未来；不填则使用服务端时间。activate=true 在验证后切换新调用；已冻结任务继续引用原绑定与原凭据版本。',
        ),
        requestBody: body(
          object({ ...writableBinding, activate: { type: 'boolean', default: false } }, [
            'credentialId',
            'credentialVersion',
            'upstreamModelId',
            'contract',
            'capabilities',
            'verificationEvidence',
          ]),
        ),
        responses: {
          '201': response(
            '已创建新的不可变绑定版本',
            envelope('binding', ref('MarketplaceBinding')),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/pricing-versions': {
      get: {
        ...operation('管理员读取商品售价版本', true),
        parameters: [...pagination, query('platformModelId', uuid, true)],
        responses: {
          '200': response('按 revision 倒序返回价格', page(ref('MarketplacePricingVersion'))),
          ...errors,
        },
      },
      post: {
        ...operation(
          '管理员新增人民币售价版本',
          true,
          '不支持覆盖历史价格。upstream_cost 仅保存跟随策略，校验已绑定模型的 New API Key 权限，不要求单价。未来版本可保存，activate=true 必须已经生效；手工零价需明确配置。',
        ),
        requestBody: body(
          object(
            {
              platformModelId: uuid,
              currency: { type: 'string', const: 'CNY', default: 'CNY' },
              rule: ref('BillingPriceRule'),
              effectiveAt: dateTime,
              activate: { type: 'boolean', default: false },
            },
            ['platformModelId', 'rule'],
          ),
        ),
        responses: {
          '201': response(
            '已创建新的不可变价格版本',
            envelope('pricing', ref('MarketplacePricingVersion')),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/model-marketplace/sync': {
      get: {
        ...operation('管理员读取连接最近的候选同步结果', true),
        parameters: [query('credentialId', uuid, true), query('sourceType', sourceType)],
        responses: {
          '200': response(
            '最近同步；从未同步时 sync 为 null',
            envelope('sync', nullable(ref('ModelCatalogSync'))),
          ),
          ...errors,
        },
      },
      post: {
        ...operation(
          '管理员同步上游候选目录',
          true,
          'newapi_managed 使用实际 Key 查询 /v1/canvas/catalog，提供可联动合同和价格来源；需升级 New API 并开启 CANVAS_BRIDGE_ENABLED。来源 models 为已选连接的模型目录；newapi_pricing 从保存地址匿名 GET 固定 /api/pricing，不使用 Key、不会解密或发送 Authorization。公开定价不等于当前 Key 可调用目录，媒体类型和能力待管理员核实。供应商价格仅作原币种参考，倍率不换算、表达式不执行；表达式或插件计费时不展示旧固定 model_price。来源互相隔离，旧数组快照归属 models；成功空目录及失败也保留来源。不会覆盖人工名称、描述、绑定、价格、默认模型或发布状态；同步失败返回 200 且 sync.status=failed，保留同来源上次候选。',
        ),
        requestBody: body(object({ credentialId: uuid, sourceType }, ['credentialId'])),
        responses: {
          '200': response(
            '同步结果与缺失候选；成功或失败均保存来源快照',
            envelope('sync', ref('ModelCatalogSync')),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/model-marketplace/connections/sync': {
      post: {
        ...operation(
          '将保存连接的可用托管模型同步到画布',
          true,
          '省略 credentialId 时依次处理全部保存连接。沿用 New API 价格；保留人工价格、暂停、删除及人工改绑，不切换活动 Key。每条连接返回已发布数量和业务阻塞原因；数据库故障返回错误，已成功导入的商品保留，可重复同步。',
        ),
        requestBody: { required: false, content: json(object({ credentialId: uuid }, [])) },
        responses: {
          '200': response(
            '各连接的同步结果',
            object({
              connections: {
                type: 'array',
                items: object({
                  id: uuid,
                  published: { type: 'integer', minimum: 0 },
                  retained: { type: 'integer', minimum: 0 },
                  issues: {
                    type: 'array',
                    items: object({ modelId: { type: 'string' }, message: { type: 'string' } }, [
                      'message',
                    ]),
                  },
                }),
              },
            }),
          ),
          ...errors,
        },
      },
    },
    '/v1/account/wallet': {
      get: {
        ...operation(
          '读取当前账户人民币钱包',
          false,
          '首次访问建立零余额钱包，不从历史 Provider 成本倒推余额。',
        ),
        responses: {
          '200': response('当前可用与冻结余额', envelope('wallet', ref('Wallet'))),
          ...errors,
        },
      },
    },
    '/v1/account/billing': {
      get: {
        ...operation('分页读取自己的追加账务流水'),
        parameters: ledgerPagination,
        responses: {
          '200': response(
            '按创建时间倒序的个人流水，不包含他人记录',
            object({
              currency: { type: 'string', const: 'CNY' },
              page: { type: 'integer', minimum: 1 },
              pageSize: { type: 'integer', const: 50 },
              entries: { type: 'array', items: ref('WalletEntry') },
            }),
          ),
          ...errors,
        },
      },
    },
    '/v1/runs/{runId}/charge': {
      get: {
        ...operation(
          '读取当前付款人的运行逐项账单',
          false,
          '历史无账务运行、其他用户账单均返回 404。上游成本独立核对，不出现在该响应。',
        ),
        parameters: [pathId('runId', { type: 'string', minLength: 1, maxLength: 200 })],
        responses: {
          '200': response('冻结上限、逐项结算及退款金额', envelope('charge', ref('RunCharge'))),
          ...errors,
        },
      },
    },
    '/v1/admin/wallets/{userId}': {
      get: {
        ...operation('管理员读取用户钱包', true),
        parameters: [pathId('userId')],
        responses: {
          '200': response('指定用户的人民币余额', envelope('wallet', ref('Wallet'))),
          ...errors,
        },
      },
    },
    '/v1/admin/wallets/{userId}/adjust': {
      post: {
        ...operation(
          '管理员发放或收回内部额度',
          true,
          'amountNanos 必须非零；负值只扣可用余额，不能动用冻结金额。同幂等键异参返回 409，绝不覆盖原流水。这不是第三方支付充值。',
        ),
        parameters: [pathId('userId')],
        requestBody: body(object(adjustmentFields)),
        responses: {
          '200': response(
            '调整流水和更新后的钱包',
            object({ entry: ref('WalletEntry'), wallet: ref('Wallet') }),
          ),
          ...errors,
          '402': billingSubmissionErrors['402'],
        },
      },
    },
    '/v1/admin/charge-items': {
      get: {
        ...operation(
          '管理员查询收费项和供应商成本',
          true,
          'runId 按完整任务编号精确筛选。按 createdAt、id 倒序，固定每页 50 条，以多读取一条判断 hasMore；不返回 total，也不接受 pageSize。查询不改变用户账单、成本或余额。',
        ),
        parameters: [
          ...ledgerPagination,
          query('runId', { type: 'string', minLength: 1, maxLength: 200 }),
        ],
        responses: {
          '200': response(
            '收费项与原币种成本摘要',
            object({
              items: { type: 'array', maxItems: 50, items: ref('AdminChargeItemSummary') },
              page: { type: 'integer', minimum: 1, maximum: 100_000 },
              pageSize: { type: 'integer', const: 50 },
              hasMore: { type: 'boolean' },
            }),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/charge-items/{id}': {
      get: {
        ...operation(
          '管理员读取收费项证据和历次处理',
          true,
          '在 RepeatableRead 事务中读取收费项、全部状态的待核实事项和 billing.* 审计。事项按 createdAt、id 升序，审计按 createdAt、id 倒序；historyPage 固定每页 50 条，以多读取一条判断 hasMoreHistory。原始成本与人工裁决分开返回，查询不换汇、不补扣、不重发调用。',
        ),
        parameters: [
          pathId('id'),
          query('historyPage', { type: 'integer', minimum: 1, maximum: 100_000, default: 1 }),
        ],
        responses: {
          '200': response(
            '收费明细、成本事实、待核实事项和分页审计',
            object({
              item: ref('AdminChargeItemDetail'),
              reconciliation: { type: 'array', items: ref('ReconciliationItem') },
              history: { type: 'array', maxItems: 50, items: ref('BillingAuditRecord') },
              historyPage: { type: 'integer', minimum: 1, maximum: 100_000 },
              historyPageSize: { type: 'integer', const: 50 },
              hasMoreHistory: { type: 'boolean' },
            }),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/charge-items/{id}/refund': {
      post: {
        ...operation(
          '管理员退回已结算收费项',
          true,
          '金额必须大于零且累计退款不超过结算。幂等退款追加反向流水，不能修改原结算。迟到结果不会自动重新扣款。',
        ),
        parameters: [pathId('id')],
        requestBody: body(object({ ...adjustmentFields, amountNanos: ref('BillingNanos') })),
        responses: {
          '200': response('已追加的退款流水', envelope('entry', ref('WalletEntry'))),
          ...errors,
        },
      },
    },
    '/v1/admin/reconciliation': {
      get: {
        ...operation(
          '管理员读取执行或成本待核实项',
          true,
          '只列出 status=open，按 dueAt 排序。执行未知不重发；成本未知独立核对，不阻断已知用户用量结算。',
        ),
        parameters: ledgerPagination,
        responses: {
          '200': response(
            '待核实事项与逾期标记',
            object({
              items: { type: 'array', items: ref('ReconciliationItem') },
              page: { type: 'integer', minimum: 1 },
              pageSize: { type: 'integer', const: 50 },
            }),
          ),
          ...errors,
        },
      },
    },
    '/v1/admin/reconciliation/{id}/resolve': {
      post: {
        ...operation(
          '管理员处理待核实事项',
          true,
          'release 仅处理 execution，释放原冻结；已经归档且等待账务恢复或存在未关闭 worker_recovery 的收费项拒绝释放。confirm_cost 仅确认 provider_cost 的供应商原币种，不自动换汇或向用户补扣。已有成本事实保留，独立裁决使成本状态变为 adjudicated；没有原事实时记为 confirmed。已处理返回 409。worker_recovery 需恢复原 Run；settlement_conflict 需核对原流水并纠错，两者不能通过这两个动作关闭。',
        ),
        parameters: [pathId('id')],
        requestBody: body(
          object(
            {
              action: { type: 'string', enum: ['release', 'confirm_cost'] },
              reason: { type: 'string', minLength: 1, maxLength: 1000 },
              amount: {
                type: 'string',
                maxLength: 100,
                pattern: '^(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?$',
                description:
                  'confirm_cost 必填；供应商原币种金额，不是 CNY nanos。可接受指数文本，规范化后必须小于 10^26 且至多 12 位小数，超出精度拒绝而不舍入。',
              },
              currency: {
                type: 'string',
                pattern: '^[A-Z]{3}$',
                description: 'confirm_cost 必填，供应商明确报告的原币种。',
              },
            },
            ['action', 'reason'],
          ),
        ),
        responses: {
          '200': response('已处理事项', envelope('item', ref('ReconciliationItem'))),
          ...errors,
        },
      },
    },
    '/v1/billing/quotes': {
      post: {
        ...operation(
          '按受限生成入口创建报价',
          false,
          `${billingSubmissionDescription}内部复用完整提交权限和冻结检查，不是任意 URL 代理。包装会强制 quoteOnly=true 并移除 body.quoteId。`,
        ),
        requestBody: body(
          object({
            path: {
              type: 'string',
              maxLength: 1024,
              pattern:
                '^/v1/(?:nodes/[^/?#]+/runs|assets/[^/?#]+/versions/\\d+/reverse-prompts|projects/[^/?#]+/prompt-optimizations|runs/[^/?#]+/retry)$',
              description:
                '原提交路径，只允许普通生成、反推、优化和重试；不得包含查询串或外部地址。',
            },
            body: {
              type: 'object',
              additionalProperties: true,
              description:
                '对应原路径的请求体，保留同一个幂等键；具体字段与权限仍由原提交接口验证。',
            },
          }),
        ),
        responses: {
          '200': billingQuoteResponse,
          '202': response('原反推或优化任务已经受理，直接恢复响应；不再确认或重新提交', {
            oneOf: [
              envelope('analysis', ref('ReversePromptAnalysis')),
              envelope('optimization', ref('PromptOptimization')),
            ],
          }),
          ...errors,
          '402': billingSubmissionErrors['402'],
          '429': response('项目活动运行配额或请求频率已满', ref('BillingError')),
        },
      },
    },
  };
}

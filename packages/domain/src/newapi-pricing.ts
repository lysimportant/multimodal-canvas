import { z } from 'zod';

/** New API 原广场的价格字段；保留大小写、显式零价与完整表达式。 */
const amount = z.number().finite().nonnegative();
/** 插件字段说明可由上游提供多语言文本。 */
const localizedText = z.union([z.string().max(8192), z.record(z.string().max(8192))]);
/** 任务用量规格仅描述计费事实，不在 Canvas 中执行扣费。 */
export const newApiUsageSchema = z.record(
  z.object({
    type: z.enum(['number', 'boolean']).optional(),
    unit: z.enum(['second', 'count', 'token', 'credit']).optional(),
    unitLabel: localizedText.optional(),
    enum: z.array(z.string().max(512)).max(512).optional(),
    enumLabels: z.record(localizedText).optional(),
    description: localizedText.optional(),
  }),
);
/** 插件价格明细沿用 New API 表达式和用量 schema，不推断供应商费用。 */
const pluginPrice = z.object({
  plugin_key: z.string().min(1).max(512),
  plugin_name: z.string().max(1024),
  icon: z.string().max(1024).optional(),
  billing_expr: z.string().max(65536),
  billing_mode: z.enum(['ratio', 'tiered_expr']).optional(),
  billing_usage_schema: newApiUsageSchema,
  billing_usage_examples: z
    .array(
      z.object({ label: z.string().max(1024), facts: z.record(z.union([z.string(), z.number()])) }),
    )
    .max(512)
    .optional(),
});
/** 原广场公开模型；未知后台字段被丢弃，不能混入凭据或渠道配置。 */
export const newApiPriceModelSchema = z.object({
  id: z.number().int().default(0),
  model_name: z.string().min(1).max(512),
  description: z.string().max(8192).optional(),
  icon: z.string().max(1024).optional(),
  vendor_id: z.number().int().optional(),
  vendor_name: z.string().max(1024).optional(),
  quota_type: z.union([z.literal(0), z.literal(1)]),
  model_ratio: amount,
  completion_ratio: amount,
  model_price: amount.optional(),
  cache_ratio: amount.nullable().optional(),
  create_cache_ratio: amount.nullable().optional(),
  image_ratio: amount.nullable().optional(),
  audio_ratio: amount.nullable().optional(),
  audio_completion_ratio: amount.nullable().optional(),
  enable_groups: z.array(z.string().max(512)).max(1024),
  group_ratio: z.record(amount).optional(),
  tags: z.string().max(8192).optional(),
  supported_endpoint_types: z.array(z.string().max(512)).max(128).optional(),
  billing_mode: z.string().max(64).optional(),
  billing_expr: z.string().max(65536).optional(),
  billing_usage_schema: newApiUsageSchema.optional(),
  billing_usage_examples: pluginPrice.shape.billing_usage_examples,
  billing_plugin_variants: z.array(pluginPrice).max(128).optional(),
  pricing_version: z.string().max(512).optional(),
});
/** 可直接供原广场显示算法使用的价格数据。 */
export type NewApiPriceModel = z.infer<typeof newApiPriceModelSchema>;
/** 上游完整模型价格配置；仅允许已存在的 New API 管理字段。 */
export const newApiPriceConfigSchema = z
  .object({
    ModelPrice: amount.optional(),
    ModelRatio: amount.optional(),
    CompletionRatio: amount.optional(),
    CacheRatio: amount.optional(),
    CreateCacheRatio: amount.optional(),
    ImageRatio: amount.optional(),
    AudioRatio: amount.optional(),
    AudioCompletionRatio: amount.optional(),
    'billing_setting.billing_mode': z.enum(['ratio', 'tiered_expr']).optional(),
    'billing_setting.billing_expr': z.string().max(65536).optional(),
    'billing_setting.plugin_billing_expr': z.record(z.string().max(65536)).optional(),
  })
  .strict();
/** 编辑草稿只保留原上游配置；不含 Canvas 的第二套计费单位。 */
export type NewApiPriceConfig = z.infer<typeof newApiPriceConfigSchema>;
/** 广场快照的汇率来自 New API 状态接口，缺失时仅展示美元原价。 */
export const newApiSquareSnapshotSchema = z.object({
  models: z.array(newApiPriceModelSchema).max(20000),
  usdToCny: z.number().finite().positive().nullable(),
  displayCurrency: z.enum(['USD', 'CNY']).default('USD'),
  fetchedAt: z.string().datetime(),
});

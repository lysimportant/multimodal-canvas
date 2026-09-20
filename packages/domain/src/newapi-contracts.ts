import { z } from 'zod';

/** New API 标识按原文匹配，不接受控制字符、首尾空白或无界内容。 */
const newApiIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));

/** 可执行模型 ID 最多 512 UTF-8 字节，不能用字符数代替上游字节限制。 */
const newApiModelIdSchema = newApiIdentitySchema.refine(
  (value) => new TextEncoder().encode(value).byteLength <= 512,
);

/** 上游 quota 来自非负 int64，保持十进制文本且不经过 JavaScript number。 */
const newApiQuotaSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

/** 非零换算元数据保留上游十进制文本，不接受指数、负数或隐式缺省。 */
const newApiPositiveDecimalSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value));

/** 目录的价格修订字段始终存在；不可用模型允许用空串表示没有可执行修订。 */
const newApiCatalogPricingVersionSchema = z
  .string()
  .max(512)
  .refine(
    (value) => value === '' || (value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)),
  );

/** New API 请求关联 ID 限 ASCII 64 字符，拒绝会被 URL 归一化的独立点路径。 */
export const newApiRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .refine((value) => value !== '.' && value !== '..');

/** 异步任务 ID 保留上游原文，但不能超过持久化的 191 字节范围。 */
const newApiTaskIdSchema = newApiIdentitySchema.refine(
  (value) => new TextEncoder().encode(value).byteLength <= 191,
);

/** 已鉴权目录中的模型；缺失合同或媒体类型时不能推断为可执行。 */
export const newApiCatalogModelSchema = z
  .object({
    id: newApiIdentitySchema,
    name: z.string().max(1024).optional(),
    description: z.string().max(8192).optional(),
    media_type: z.enum(['text', 'image', 'audio', 'video']).optional(),
    contract: newApiIdentitySchema.optional(),
    capabilities: z.record(z.unknown()).optional(),
    limitations: z.record(z.unknown()).optional(),
    input_media_types: z
      .array(z.enum(['text', 'image', 'audio', 'video']))
      .max(4)
      .optional(),
    available: z.boolean(),
    unavailable_reason: z.string().max(2048).optional(),
    pricing_version: newApiCatalogPricingVersionSchema,
  })
  .strict()
  .refine((model) => !model.available || newApiModelIdSchema.safeParse(model.id).success, {
    path: ['id'],
    message: '可用模型 ID 不能超过 512 UTF-8 字节',
  });

/**
 * 本人分组 Key 的只读模型目录。
 * 换算和价格修订仅按上游原文保留以核对回执，Canvas 不据此复算售价或结算。
 */
export const newApiCatalogSchema = z
  .object({
    version: z.literal(1),
    currency: z.literal('CNY'),
    quota_per_unit: newApiPositiveDecimalSchema,
    usd_to_cny: newApiPositiveDecimalSchema,
    models: z.array(newApiCatalogModelSchema).max(20_000),
  })
  .strict()
  .refine(
    (catalog) => new Set(catalog.models.map((model) => model.id)).size === catalog.models.length,
    { path: ['models'], message: '鉴权目录不能包含重复模型身份' },
  );

/** 原请求回执；只校验上游事实，不执行 Canvas 本地金额换算或结算。 */
export const newApiReceiptSchema = z
  .object({
    version: z.literal(1),
    request_id: newApiRequestIdSchema,
    task_id: newApiTaskIdSchema.optional(),
    model: newApiModelIdSchema,
    group: newApiIdentitySchema,
    status: z.enum(['pending', 'settled', 'refunded']),
    quota: newApiQuotaSchema,
    quota_per_unit: newApiPositiveDecimalSchema,
    pricing_version: newApiIdentitySchema.optional(),
    settled_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status !== 'pending' && !receipt.settled_at)
      context.addIssue({ code: 'custom', path: ['settled_at'], message: '最终回执缺少记账时间' });
    if (receipt.status === 'pending' && receipt.settled_at)
      context.addIssue({
        code: 'custom',
        path: ['settled_at'],
        message: '待结算回执不能有记账时间',
      });
    if (receipt.status === 'refunded' && receipt.quota !== '0')
      context.addIssue({
        code: 'custom',
        path: ['quota'],
        message: '已退款回执的净 quota 必须为零',
      });
  });

/** 经过格式验证的本人分组模型目录。 */
export type NewApiCatalog = z.infer<typeof newApiCatalogSchema>;
/** 目录中的单个模型合同。 */
export type NewApiCatalogModel = z.infer<typeof newApiCatalogModelSchema>;
/** 经过格式验证的原请求回执；调用方仍须核对请求和任务身份。 */
export type NewApiReceipt = z.infer<typeof newApiReceiptSchema>;

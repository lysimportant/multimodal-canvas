import { z } from 'zod';

/** 未设置时整个生成队列最多同时执行 20 个 Run；不改变单 Run 的 DAG 顺序。 */
export const DEFAULT_GENERATION_CONCURRENCY = 20;

/** 生成并发接受可精确表示的正整数；20 是默认值，不是上限。 */
export const generationConcurrencySchema = z.number().int().positive().safe();

/** 管理员修改的是同一部署生成队列的全局上限，不接受项目或用户作用域覆盖。 */
export const updateGenerationConcurrencySchema = z
  .object({
    concurrency: generationConcurrencySchema,
  })
  .strict();

/** 队列配置的公开响应；只展示并发及作用域，不泄露 Redis 地址或队列凭据。 */
export const generationConcurrencySettingsSchema = updateGenerationConcurrencySchema.extend({
  scope: z.literal('queue'),
});

/** 已持久化的部署级 Run 并发配置。 */
export type GenerationConcurrencySettings = z.infer<typeof generationConcurrencySettingsSchema>;

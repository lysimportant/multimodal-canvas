import type { Queue } from 'bullmq';
import {
  generationConcurrencySchema,
  generationConcurrencySettingsSchema,
  type GenerationConcurrencySettings,
} from '@multimodal-canvas/domain';

/** 生成队列的管理存储；写入影响所有 Worker，Redis 故障必须传给调用方。 */
export type GenerationConcurrencyStore = {
  /** 读取已保存的上限；首次未初始化或配置丢失时返回 null，不假称默认值已保存。 */
  get(): Promise<GenerationConcurrencySettings | null>;
  /** 保存正安全整数，不取消或重新提交任何已经受理的 Run。 */
  update(concurrency: number): Promise<GenerationConcurrencySettings>;
};

/**
 * 复用 BullMQ 的 Redis 元数据保存全局并发，无需数据库迁移或另一份配置。
 * @param queue 实际生成队列；测试可注入同合同替身。
 * @returns 队列配置存储；Redis 失败或配置损坏时拒绝，不伪装保存成功。
 */
export function createGenerationConcurrencyStore(
  queue: Pick<Queue, 'getGlobalConcurrency' | 'setGlobalConcurrency'>,
): GenerationConcurrencyStore {
  return {
    async get() {
      const concurrency = await queue.getGlobalConcurrency();
      if (concurrency === null) return null;
      return generationConcurrencySettingsSchema.parse({
        concurrency,
        scope: 'queue',
      });
    },
    async update(value) {
      const concurrency = generationConcurrencySchema.parse(value);
      await queue.setGlobalConcurrency(concurrency);
      return { concurrency, scope: 'queue' };
    },
  };
}

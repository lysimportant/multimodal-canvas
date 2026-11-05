import type { FastifyInstance } from 'fastify';
import type { AssetStore } from './assets';

/** 存储水位检查与到期清理的间隔。 */
const SWEEP_INTERVAL_MS = 60_000;
/** 孤儿对象回收要列举整个前缀，代价高，因此按小时级间隔单独执行。 */
const ORPHAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 启动时补扫停机期间的到期项、存储水位与孤儿对象，之后按时执行；同进程不重叠，关闭时等待当前轮结束。
 * 顺序固定为「先按水位打淘汰倒计时，再删除已到期资源」，使同一轮里的到期资源尽快释放空间。
 */
export function registerAssetExpiration(app: FastifyInstance, store: AssetStore): void {
  if (!store.expireGeneratedAssets && !store.evictUnderStoragePressure && !store.pruneOrphanAssets)
    return;
  let timer: ReturnType<typeof setInterval> | undefined;
  let orphanTimer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let orphanRunning: Promise<void> | undefined;
  const evict = async () => {
    if (!store.evictUnderStoragePressure) return;
    try {
      const result = await store.evictUnderStoragePressure();
      if (result.evicted)
        app.log.info(
          { code: 'asset_eviction_marked', evicted: result.evicted, bytes: result.bytes },
          '存储占用超过阈值，已为最早的生成资源标记 72 小时淘汰倒计时',
        );
    } catch {
      app.log.error({ code: 'asset_eviction_failed' }, '存储水位检查失败，将自动重试');
    }
  };
  const expire = async () => {
    if (!store.expireGeneratedAssets) return;
    try {
      const result = await store.expireGeneratedAssets();
      if (result.failed)
        app.log.warn(
          { code: 'asset_expiration_retry', failed: result.failed },
          '部分到期资源清理失败，将自动重试',
        );
    } catch {
      app.log.error({ code: 'asset_expiration_failed' }, '到期资源清理失败，将自动重试');
    }
  };
  const prune = async () => {
    if (!store.pruneOrphanAssets) return;
    try {
      const result = await store.pruneOrphanAssets();
      if (result.evicted)
        app.log.info(
          { code: 'asset_orphan_pruned', pruned: result.evicted, bytes: result.bytes },
          '已删除对象存储中没有资源行指向的孤儿对象',
        );
    } catch {
      app.log.error({ code: 'asset_orphan_prune_failed' }, '孤儿对象回收失败，将自动重试');
    }
  };
  const sweep = () => {
    if (running) return running;
    running = evict()
      .then(expire)
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const orphanSweep = () => {
    if (orphanRunning) return orphanRunning;
    orphanRunning = prune().finally(() => {
      orphanRunning = undefined;
    });
    return orphanRunning;
  };
  app.addHook('onReady', async () => {
    await sweep();
    timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
    // 孤儿回收排在到期清理之后，避免和正在写入的新对象抢同一批键。
    void orphanSweep();
    orphanTimer = setInterval(() => void orphanSweep(), ORPHAN_INTERVAL_MS);
    orphanTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    if (orphanTimer) clearInterval(orphanTimer);
    await running;
    await orphanRunning;
  });
}

import type { FastifyInstance } from 'fastify';
import type { AssetStore } from './assets';

/** 启动时补扫停机期间的到期项，之后每分钟清理；同进程不重叠，关闭时等待清理结束。 */
export function registerAssetExpiration(app: FastifyInstance, store: AssetStore): void {
  if (!store.expireGeneratedAssets) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const sweep = () => {
    if (running) return running;
    running = store.expireGeneratedAssets!()
      .then((result) => {
        if (result.failed)
          app.log.warn(
            { code: 'asset_expiration_retry', failed: result.failed },
            '部分到期资源清理失败，将自动重试',
          );
      })
      .catch(() => {
        app.log.error({ code: 'asset_expiration_failed' }, '到期资源清理失败，将自动重试');
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  app.addHook('onReady', async () => {
    await sweep();
    timer = setInterval(() => void sweep(), 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await running;
  });
}

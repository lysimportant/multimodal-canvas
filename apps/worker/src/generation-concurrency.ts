import type { Queue, Worker } from 'bullmq';
import { generationConcurrencySchema } from '@multimodal-canvas/domain';

/** 配置读取最多等待两秒；超时暂停领取，并保留同一在途读取，避免断网时积压命令。 */
const CONFIG_READ_TIMEOUT_MS = 2_000;

/** 同步器只管理领取上限，不取消任务或修改 Provider、Run 状态。 */
export type WorkerConcurrencyOptions = {
  queue: Pick<Queue, 'client' | 'getGlobalConcurrency' | 'toKey'>;
  worker: Pick<Worker, 'concurrency' | 'on' | 'off' | 'pause' | 'resume' | 'isPaused'>;
  /** 仅首次缺少队列配置时使用；重启不能覆盖管理员保存的值。 */
  initialConcurrency: number;
  /** 读取失败时报告错误并暂停领取，恢复合法配置后自动继续。 */
  onError: (error: unknown) => void;
};

/** 关闭同步器停止配置读取，不取消正在运行的任务；在途读取最多等待两秒。 */
export type WorkerConcurrencySync = { close(): Promise<void> };

/**
 * 将已校验的队列全局上限同步到有界本地 Worker；故障时暂停新领取，保留在途任务。
 * @param options 实际队列、尚未 run 的 Worker、首次默认值及失败回调。
 * @returns 首次配置成功后的关闭句柄；调用方随后才能启动 Worker。
 * @throws 首次初始化、读取或校验失败时拒绝启动；不会按无上限运行。
 * @remarks 本地满载时增加 concurrency 要等下一次调度，不保证立即扩容。
 */
export async function startWorkerConcurrencySync(
  options: WorkerConcurrencyOptions,
): Promise<WorkerConcurrencySync> {
  const initialConcurrency = generationConcurrencySchema.parse(options.initialConcurrency);
  const { queue, worker } = options;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let reading: Promise<number> | undefined;
  let reportedFailure = false;
  let pausedBySync = false;

  /** 只在启动时原子初始化；运行中配置消失必须暂停，不能重播环境默认值。 */
  const readConfiguration = async (initialize: boolean) => {
    if (initialize) {
      const client = await queue.client;
      if (stopped) throw new Error('生成并发同步器已关闭');
      // BullMQ 的公开 setGlobalConcurrency 没有 if-absent 选项。仅此处使用
      // meta.concurrency 的 HSETNX，避免启动与管理员 PATCH 交错时覆盖已保存值。
      client.defineCommand('canvasInitializeGenerationConcurrency', {
        numberOfKeys: 1,
        lua: "return redis.call('HSETNX', KEYS[1], 'concurrency', ARGV[1])",
      });
      await client.runCommand('canvasInitializeGenerationConcurrency', [
        queue.toKey('meta'),
        initialConcurrency,
      ]);
    }
    const concurrency = await queue.getGlobalConcurrency();
    if (concurrency === null) throw new Error('生成并发配置已丢失，暂停领取并等待管理员重新保存');
    return generationConcurrencySchema.parse(concurrency);
  };

  /** 超时读取只丢弃结果，不重复排队；恢复连接后下一轮重新读取当前配置。 */
  const synchronize = async (initialize: boolean) => {
    if (stopped || reading) return;
    const current = readConfiguration(initialize);
    reading = current;
    const clearReading = () => {
      if (reading === current) reading = undefined;
    };
    void current.then(clearReading, clearReading);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const concurrency = await Promise.race([
        current,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error('读取生成并发配置超时，已停止领取新任务')),
            CONFIG_READ_TIMEOUT_MS,
          );
        }),
      ]);
      if (stopped) return;
      // Redis 元数据丢失或断连时，本地仍有最后一次合法的有限上限。
      // 公开 setter 在满载时不会唤醒调度，因此不承诺一秒内增加执行数量。
      worker.concurrency = concurrency;
      if (pausedBySync) {
        pausedBySync = false;
        worker.resume();
      }
      reportedFailure = false;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  };

  /** 本地暂停不等待在途任务，也不发送取消信号；只恢复由本同步器发起的暂停。 */
  const suspendAfterFailure = async (error: unknown) => {
    if (stopped) return;
    if (!worker.isPaused()) {
      await worker.pause(true);
      pausedBySync = true;
    }
    if (!reportedFailure) options.onError(error);
    reportedFailure = true;
  };

  /** 每个同步器至多一个读取在途，避免 Redis 故障时定时器重复积压请求。 */
  const sync = (initialize = false) => {
    if (!pending) {
      const attempt = synchronize(initialize);
      pending = (initialize ? attempt : attempt.catch(suspendAfterFailure)).finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };

  /** 停止轮询并等待有期限的读取；关闭后的迟到结果不能修改或恢复 Worker。 */
  const close = async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    worker.off('closing', onClosing);
    await pending?.catch(() => undefined);
  };

  /** Worker 的常规关闭回收配置定时器，不干预任务终态。 */
  const onClosing = () => {
    void close();
  };
  worker.on('closing', onClosing);
  try {
    await sync(true);
  } catch (error) {
    await close();
    throw error;
  }
  if (!stopped) {
    timer = setInterval(() => {
      if (pending || reading) return;
      void sync().catch(options.onError);
    }, 1_000);
    timer.unref();
  }
  return { close };
}

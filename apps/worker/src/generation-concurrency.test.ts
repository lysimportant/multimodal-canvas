import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startWorkerConcurrencySync,
  type WorkerConcurrencyOptions,
  type WorkerConcurrencySync,
} from './generation-concurrency';

/** 只模拟配置和公开 Worker 控制方法，不创建 Run 或 Provider 请求。 */
function fixture(saved: number | null = null) {
  let concurrency = saved;
  let paused = false;
  const client = {
    defineCommand: vi.fn(),
    runCommand: vi.fn(async (_name: string, args: unknown[]) => {
      concurrency ??= Number(args[1]);
      return 1;
    }),
  };
  const emitter = Object.assign(new EventEmitter(), {
    concurrency: 20,
    pause: vi.fn(async (_doNotWaitActive: boolean) => {
      paused = true;
    }),
    resume: vi.fn(() => {
      paused = false;
    }),
    isPaused: () => paused,
  });
  const queue = {
    client: Promise.resolve(client),
    getGlobalConcurrency: vi.fn(async () => concurrency),
    toKey: (key: string) => 'bull:synthetic-concurrency:' + key,
  };
  const onError = vi.fn();
  const options = {
    queue,
    worker: emitter,
    initialConcurrency: 20,
    onError,
  } as unknown as WorkerConcurrencyOptions;
  return {
    options,
    queue,
    client,
    emitter,
    onError,
    set: (value: number | null) => {
      concurrency = value;
    },
  };
}
const controllers: WorkerConcurrencySync[] = [];
/** 记录已启动同步器，断言失败后同样清理定时器。 */
async function start(options: WorkerConcurrencyOptions) {
  const controller = await startWorkerConcurrencySync(options);
  controllers.push(controller);
  return controller;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  vi.useRealTimers();
});

describe('Worker 有界动态全局并发同步', () => {
  it('首次全局和本地上限均为 20，只原子初始化一次，不操作私有 marker', async () => {
    const f = fixture();
    await start(f.options);
    expect(await f.queue.getGlobalConcurrency()).toBe(20);
    expect(f.emitter.concurrency).toBe(20);
    expect(f.client.runCommand).toHaveBeenCalledExactlyOnceWith(
      'canvasInitializeGenerationConcurrency',
      ['bull:synthetic-concurrency:meta', 20],
    );
    expect(f.client.defineCommand).toHaveBeenCalledTimes(1);
  });

  it('优先使用 Redis 已保存值，重建 Worker 不回退环境默认值', async () => {
    const f = fixture(32);
    const first = await start(f.options);
    expect(f.emitter.concurrency).toBe(32);
    await first.close();
    f.emitter.concurrency = 4;
    await start({ ...f.options, initialConcurrency: 4 });
    expect(f.emitter.concurrency).toBe(32);
    expect(await f.queue.getGlobalConcurrency()).toBe(32);
  });

  it('同步增大和减小本地上限，不以额外领取槽换取即时扩容', async () => {
    const f = fixture(1);
    await start(f.options);
    f.set(40);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(40);
    f.set(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.client.runCommand).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('首次读取失败时拒绝启动，不遗留定时器或监听器', async () => {
    const f = fixture();
    f.queue.getGlobalConcurrency.mockRejectedValue(new Error('synthetic redis unavailable'));
    await expect(startWorkerConcurrencySync(f.options)).rejects.toThrow(
      'synthetic redis unavailable',
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(f.emitter.listenerCount('closing')).toBe(0);
    expect(f.emitter.concurrency).toBe(20);
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝损坏的持久化值 %s',
    async (value) => {
      const f = fixture(value);
      await expect(startWorkerConcurrencySync(f.options)).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('运行中配置丢失时保留本地边界并暂停，不重播初始 20', async () => {
    const f = fixture(2);
    await start(f.options);
    f.set(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.emitter.concurrency).toBe(2);
    expect(f.emitter.pause).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.emitter.isPaused()).toBe(true);
    expect(await f.queue.getGlobalConcurrency()).toBeNull();
    expect(f.client.runCommand).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    f.set(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(3);
    expect(f.emitter.resume).toHaveBeenCalledTimes(1);
  });

  it('暂时断连暂停新领取但保留在途任务；恢复后应用最新值，不重复刷屏', async () => {
    const f = fixture(20);
    await start(f.options);
    f.queue.getGlobalConcurrency.mockRejectedValue(new Error('synthetic disconnect'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect(f.emitter.concurrency).toBe(20);
    expect(f.emitter.pause).toHaveBeenCalledExactlyOnceWith(true);
    f.queue.getGlobalConcurrency.mockResolvedValue(32);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(32);
    expect(f.emitter.isPaused()).toBe(false);
  });

  it('不会恢复其它调用方已经暂停的 Worker', async () => {
    const f = fixture(2);
    await f.emitter.pause(true);
    await start(f.options);
    f.set(null);
    await vi.advanceTimersByTimeAsync(1000);
    f.set(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(3);
    expect(f.emitter.isPaused()).toBe(true);
    expect(f.emitter.resume).not.toHaveBeenCalled();
  });

  it('读取挂起两秒后暂停，断网期间不积压命令，迟到结果不能直接恢复领取', async () => {
    const f = fixture(2);
    await start(f.options);
    let resolve!: (value: number) => void;
    f.queue.getGlobalConcurrency.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.queue.getGlobalConcurrency).toHaveBeenCalledTimes(2);
    expect(f.emitter.isPaused()).toBe(true);
    expect(f.emitter.concurrency).toBe(2);
    expect(f.onError).toHaveBeenCalledTimes(1);
    resolve(99);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.emitter.concurrency).toBe(2);
    expect(f.emitter.isPaused()).toBe(true);
    f.set(32);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.emitter.concurrency).toBe(32);
    expect(f.emitter.isPaused()).toBe(false);
  });

  it('初始 Redis 读取挂起时也会拒绝启动，而不是无限等待或无上限运行', async () => {
    const f = fixture();
    f.queue.getGlobalConcurrency.mockReturnValue(new Promise(() => {}));
    const startup = expect(startWorkerConcurrencySync(f.options)).rejects.toThrow(
      '读取生成并发配置超时',
    );
    await vi.advanceTimersByTimeAsync(2000);
    await startup;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.emitter.listenerCount('closing')).toBe(0);
    expect(f.emitter.concurrency).toBe(20);
  });

  it('慢读取不会被下一次定时器并行重复发起，关闭后不再更改 Worker', async () => {
    const f = fixture(20);
    const controller = await start(f.options);
    let resolve!: (value: number) => void;
    f.queue.getGlobalConcurrency.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.queue.getGlobalConcurrency).toHaveBeenCalledTimes(2);
    const closing = controller.close();
    resolve(32);
    await closing;
    expect(f.emitter.concurrency).toBe(20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Worker 正常关闭会释放定时器，不再读取 Redis', async () => {
    const f = fixture();
    await start(f.options);
    f.emitter.emit('closing');
    const calls = f.queue.getGlobalConcurrency.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.queue.getGlobalConcurrency).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});

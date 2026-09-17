import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('服务端参考时钟', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('按往返延迟校准，系统时钟变化不使运行中耗时跳变', async () => {
    const clock = await import('./server-clock');
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(1_400);
    expect(clock.synchronizeServerClock('2026-09-17T10:00:00.000Z', 1_000)).toBe(true);
    expect(clock.serverClockNow()).toBe(Date.parse('2026-09-17T10:00:00.200Z'));
    vi.mocked(Date.now).mockReturnValue(-5_000_000);
    monotonic.mockReturnValue(2_400);
    expect(clock.serverClockNow()).toBe(Date.parse('2026-09-17T10:00:01.200Z'));
  });

  it('缺失或损坏的服务端时间不会污染已有校时；旧请求迟到不覆盖新样本', async () => {
    const clock = await import('./server-clock');
    vi.spyOn(performance, 'now').mockReturnValue(2_400);
    clock.synchronizeServerClock('2026-09-17T10:00:00.000Z', 2_000);
    const baseline = clock.serverClockNow();
    expect(clock.synchronizeServerClock(null, 2_100)).toBe(false);
    expect(clock.synchronizeServerClock('not-a-time', 2_100)).toBe(false);
    expect(clock.synchronizeServerClock('2026-09-17T09:59:00.000Z', 1_000)).toBe(false);
    expect(clock.synchronizeServerClock('2026-09-17T10:00:00.000Z', 3_000)).toBe(false);
    expect(clock.serverClockNow()).toBe(baseline);
  });

  it('首次有效 API 响应前保留浏览器时间作为明确降级', async () => {
    const clock = await import('./server-clock');
    vi.spyOn(Date, 'now').mockReturnValue(42_000);
    expect(clock.serverClockNow()).toBe(42_000);
  });
});

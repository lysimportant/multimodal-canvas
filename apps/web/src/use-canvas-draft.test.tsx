import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_DRAFT_DELAY_MS, useCanvasDraft } from './use-canvas-draft';

describe('画布草稿合并落盘', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('连续 60 个拖动帧只序列化并写入最终坐标一次', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const serialize = vi.fn((x: number) => JSON.stringify({ x }));
    const error = vi.fn();
    const hook = renderHook(({ x }) => useCanvasDraft('canvas:a', () => serialize(x), error), {
      initialProps: { x: 0 },
    });
    for (let x = 1; x <= 60; x += 1) {
      hook.rerender({ x });
      act(() => vi.advanceTimersByTime(16));
    }
    expect(serialize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CANVAS_DRAFT_DELAY_MS));
    expect(save).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledExactlyOnceWith(60);
    expect(localStorage.getItem('canvas:a')).toBe('{"x":60}');
    hook.unmount();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('持续编辑超过两秒仍保留周期恢复点，结束后保存最终快照', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const hook = renderHook(({ x }) => useCanvasDraft('a', () => String(x), vi.fn()), {
      initialProps: { x: 0 },
    });
    for (let x = 1; x <= 240; x += 1) {
      hook.rerender({ x });
      act(() => vi.advanceTimersByTime(16));
    }
    expect(save).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(CANVAS_DRAFT_DELAY_MS));
    expect(save).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('a')).toBe('240');
    hook.unmount();
  });

  it('切换项目先保存旧项目，卸载立即保存新项目', () => {
    const error = vi.fn();
    const hook = renderHook(({ key, value }) => useCanvasDraft(key, () => value, error), {
      initialProps: { key: 'a', value: 'old' },
    });
    hook.rerender({ key: 'a', value: 'last-old' });
    hook.rerender({ key: 'b', value: 'new' });
    expect(localStorage.getItem('a')).toBe('last-old');
    expect(localStorage.getItem('b')).toBeNull();
    hook.unmount();
    expect(localStorage.getItem('b')).toBe('new');
    act(() => vi.runAllTimers());
    expect(error).not.toHaveBeenCalled();
  });

  it('pagehide 保存最近一次编辑，不等待定时器', () => {
    const serialize = vi.fn(() => 'latest');
    const hook = renderHook(() => useCanvasDraft('a', serialize, vi.fn()));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(localStorage.getItem('a')).toBe('latest');
    hook.unmount();
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('页面进入后台立即保存，尚未恢复时不覆盖旧草稿', () => {
    localStorage.setItem('a', 'existing');
    const hook = renderHook(
      ({ key }: { key: string | null }) => useCanvasDraft(key, () => 'new', vi.fn()),
      { initialProps: { key: null as string | null } },
    );
    act(() => vi.runAllTimers());
    expect(localStorage.getItem('a')).toBe('existing');
    hook.rerender({ key: 'a' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(localStorage.getItem('a')).toBe('new');
    hook.unmount();
  });

  it('存储失败显式回报错误，下一次编辑仍可保存', () => {
    const error = vi.fn();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });
    const hook = renderHook(({ value }) => useCanvasDraft('a', () => value, error), {
      initialProps: { value: 'first' },
    });
    act(() => vi.runAllTimers());
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota' }));
    hook.rerender({ value: 'second' });
    act(() => vi.runAllTimers());
    expect(storage).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('a')).toBe('second');
    hook.unmount();
  });
});

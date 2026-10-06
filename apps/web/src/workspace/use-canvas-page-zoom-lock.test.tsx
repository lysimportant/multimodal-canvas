import '@testing-library/jest-dom/vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasPageZoomLock } from './use-canvas-page-zoom-lock';

/** 每例使用独立 viewport，不访问真实浏览器配置。 */
beforeEach(() => {
  const viewport = document.createElement('meta');
  viewport.name = 'viewport';
  viewport.content = 'width=device-width, initial-scale=1.0';
  document.head.append(viewport);
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('meta[name="viewport"]').forEach((element) => element.remove());
  document.documentElement.classList.remove('is-canvas-page');
  vi.restoreAllMocks();
});

/** jsdom 没有完整 Touch 构造器，只提供监听器实际读取的触点列表。 */
function touchEvent(type: string, count: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({})) });
  return event;
}

describe('画布页面缩放隔离', () => {
  it('严格模式挂载锁定 viewport，重渲染不重绑，卸载恢复原值', () => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
    const add = vi.spyOn(document, 'addEventListener');
    const { rerender, unmount } = renderHook(useCanvasPageZoomLock, { wrapper: StrictMode });
    expect(viewport.content).toContain('user-scalable=no');
    expect(viewport.content).toContain('maximum-scale=1');
    expect(document.documentElement).toHaveClass('is-canvas-page');
    const calls = add.mock.calls.length;
    rerender();
    expect(add).toHaveBeenCalledTimes(calls);
    expect(add).toHaveBeenCalledWith('wheel', expect.any(Function), {
      capture: true,
      passive: false,
    });
    unmount();
    expect(viewport.content).toBe('width=device-width, initial-scale=1.0');
    expect(document.documentElement).not.toHaveClass('is-canvas-page');
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    const wheel = new WheelEvent('wheel', { ctrlKey: true, cancelable: true });
    document.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('Ctrl 滚轮阻止页面默认缩放，仍传递到画布处理器', () => {
    renderHook(useCanvasPageZoomLock);
    const child = document.createElement('div');
    document.body.append(child);
    const handleWheel = vi.fn((event: Event) => event.stopPropagation());
    child.addEventListener('wheel', handleWheel);
    const event = new WheelEvent('wheel', { ctrlKey: true, bubbles: true, cancelable: true });
    child.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handleWheel).toHaveBeenCalledOnce();
    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    child.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
    child.remove();
  });

  it.each(['touchstart', 'touchmove'])('%s 只取消多指默认缩放，单指仍能滚动', (type) => {
    const { unmount } = renderHook(useCanvasPageZoomLock);
    const single = touchEvent(type, 1);
    document.dispatchEvent(single);
    expect(single.defaultPrevented).toBe(false);
    const multiple = touchEvent(type, 2);
    document.dispatchEvent(multiple);
    expect(multiple.defaultPrevented).toBe(true);
    unmount();
    const restored = touchEvent(type, 2);
    document.dispatchEvent(restored);
    expect(restored.defaultPrevented).toBe(false);
  });

  it.each(['gesturestart', 'gesturechange'])('取消 Safari %s 并在离开画布时清理', (type) => {
    const { unmount } = renderHook(useCanvasPageZoomLock);
    const event = new Event(type, { cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    unmount();
    const restored = new Event(type, { cancelable: true });
    document.dispatchEvent(restored);
    expect(restored.defaultPrevented).toBe(false);
  });

  it('只取消页面缩放快捷键，不吞掉复制、撤销或正常输入', () => {
    renderHook(useCanvasPageZoomLock);
    for (const key of ['+', '=', '-', '_', '0']) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const event = new KeyboardEvent('keydown', { key, [modifier]: true, cancelable: true });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
    }
    for (const options of [
      { key: '+', ctrlKey: false },
      { key: 'c', ctrlKey: true },
      { key: 'z', metaKey: true },
      { key: '=', ctrlKey: true, altKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...options, cancelable: true });
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('缺少 viewport 时临时创建，卸载后不留标签', () => {
    document.querySelector('meta[name="viewport"]')!.remove();
    const { unmount } = renderHook(useCanvasPageZoomLock);
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    unmount();
    expect(document.querySelector('meta[name="viewport"]')).toBeNull();
  });
});

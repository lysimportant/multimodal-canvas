import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHomeMotion } from './HomeMotion';

/** 可切换系统媒体偏好的事件源，避免依赖 jsdom 未实现的 matchMedia。 */
class MediaQuery extends EventTarget {
  matches: boolean;
  constructor(matches: boolean) {
    super();
    this.matches = matches;
  }
  /** 模拟系统偏好在页面存续期间变化。 */
  change(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

/** 最小首页装饰宿主，用于验证浏览器资源的申请和释放。 */
function MotionFixture({ enabled = true }: { enabled?: boolean }) {
  const ref = useHomeMotion(enabled);
  return (
    <div ref={ref} data-testid="motion-root">
      <span className="mc-home-pointer" />
      <section className="mc-home-hero">
        <div data-testid="stage" />
        <p>可选择正文</p>
        <button type="button">入口</button>
      </section>
    </div>
  );
}

/** 发出带真实设备类型的指针事件。 */
function move(element: Element, pointerType = 'mouse') {
  const event = new Event('pointermove', { bubbles: true });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    clientX: { value: 125 },
    clientY: { value: 180 },
  });
  fireEvent(element, event);
}

describe('首页动态效果生命周期', () => {
  let reduced: MediaQuery;
  let fine: MediaQuery;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    reduced = new MediaQuery(false);
    fine = new MediaQuery(true);
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => (query.includes('reduced') ? reduced : fine)),
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('coalesces pointer work into one frame and removes it on text, touch and window blur', () => {
    const { getByTestId, getByText } = render(<MotionFixture />);
    const root = getByTestId('motion-root');
    move(getByTestId('stage'));
    move(getByTestId('stage'));
    expect(frames.size).toBe(1);
    act(() => {
      frames.values().next().value?.(0);
      frames.clear();
    });
    expect(root).toHaveAttribute('data-home-pointer', 'visible');
    expect(root.querySelector('.mc-home-pointer')).toHaveStyle(
      'transform: translate3d(125px, 180px, 0)',
    );
    move(getByText('可选择正文'));
    expect(root).not.toHaveAttribute('data-home-pointer');
    move(getByTestId('stage'), 'touch');
    expect(frames.size).toBe(0);
    move(getByTestId('stage'));
    fireEvent.blur(window);
    expect(frames.size).toBe(0);
  });

  it('responds immediately to system preferences, background state and explicit disabling', () => {
    const { getByTestId, rerender } = render(<MotionFixture />);
    const root = getByTestId('motion-root');
    expect(root).toHaveAttribute('data-home-motion', 'active');
    act(() => reduced.change(true));
    expect(root).toHaveAttribute('data-home-motion', 'static');
    act(() => reduced.change(false));
    expect(root).toHaveAttribute('data-home-motion', 'active');
    act(() => fine.change(false));
    move(getByTestId('stage'));
    expect(frames.size).toBe(0);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(root).toHaveAttribute('data-home-motion', 'static');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(root).toHaveAttribute('data-home-motion', 'active');
    rerender(<MotionFixture enabled={false} />);
    expect(root).toHaveAttribute('data-home-motion', 'static');
  });

  it('cancels a pending frame and detaches the media-query listeners on unmount', () => {
    const removeReduced = vi.spyOn(reduced, 'removeEventListener');
    const removeFine = vi.spyOn(fine, 'removeEventListener');
    const { getByTestId, unmount } = render(<MotionFixture />);
    move(getByTestId('stage'));
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(removeReduced).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removeFine).toHaveBeenCalledWith('change', expect.any(Function));
    act(() => reduced.change(true));
    expect(frames.size).toBe(0);
  });

  it('uses the static fallback on a resource-constrained device', () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    const { getByTestId } = render(<MotionFixture />);
    expect(getByTestId('motion-root')).toHaveAttribute('data-home-motion', 'degraded');
    move(getByTestId('stage'));
    expect(frames.size).toBe(0);
  });
});

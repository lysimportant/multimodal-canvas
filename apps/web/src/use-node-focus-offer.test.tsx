import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { UiProvider } from '@multimodal-canvas/ui';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNodeFocusOffer } from './use-node-focus-offer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 同时推进组件库的自动关闭与退出动画。 */
async function advanceTime(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

function wrapper({ children }: { children: ReactNode }) {
  return <UiProvider>{children}</UiProvider>;
}

describe('useNodeFocusOffer', () => {
  it('节点生成完成时提示是否聚焦，点击聚焦后才移动视口', async () => {
    const onFocus = vi.fn();
    const { result } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '仙子图'));
    expect(screen.getByText('「仙子图」已生成完成，是否聚焦到该节点？')).toBeInTheDocument();
    expect(onFocus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /聚\s*焦/ }));
    expect(onFocus).toHaveBeenCalledWith('node-a');
    await advanceTime(1000);
    expect(screen.queryByText(/已生成完成/)).not.toBeInTheDocument();
  });

  it('8 秒内没有操作时提示自动消失且不移动视口', async () => {
    const onFocus = vi.fn();
    const { result } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '图片'));
    await advanceTime(7500);
    expect(screen.getByText(/已生成完成/)).toBeInTheDocument();

    await advanceTime(2000);
    expect(screen.queryByText(/已生成完成/)).not.toBeInTheDocument();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('点击忽略只关闭提示，不移动视口', async () => {
    const onFocus = vi.fn();
    const { result } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '视频'));
    fireEvent.click(screen.getByRole('button', { name: /忽\s*略/ }));
    await advanceTime(1000);
    expect(screen.queryByText(/已生成完成/)).not.toBeInTheDocument();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('同一节点重复完成只保留一条提示', () => {
    const onFocus = vi.fn();
    const { result } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '图片'));
    act(() => result.current('node-a', '图片'));
    expect(screen.getAllByText(/已生成完成/)).toHaveLength(1);
  });

  it('不同节点各自保留一条提示', () => {
    const onFocus = vi.fn();
    const { result } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '图片一'));
    act(() => result.current('node-b', '图片二'));
    expect(screen.getByText(/图片一/)).toBeInTheDocument();
    expect(screen.getByText(/图片二/)).toBeInTheDocument();
  });

  it('卸载时清理自己的提示', async () => {
    const onFocus = vi.fn();
    const { result, unmount } = renderHook(() => useNodeFocusOffer(onFocus), { wrapper });

    act(() => result.current('node-a', '图片'));
    unmount();
    await advanceTime(1000);
    expect(screen.queryByText(/已生成完成/)).not.toBeInTheDocument();
  });
});

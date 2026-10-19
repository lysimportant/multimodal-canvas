import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { UiProvider } from '@multimodal-canvas/ui';
import { ConfigProvider } from 'antd';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppNotice } from './use-app-notice';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 同时推进组件库的自动关闭与退出动画。 */
async function advanceTime(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

describe('useAppNotice', () => {
  it('使用上下文中的 Ant Design message 展示成功和错误，错误保留手动关闭入口', async () => {
    const { result } = renderHook(useAppNotice, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ConfigProvider prefixCls="themed">
          <UiProvider>{children}</UiProvider>
        </ConfigProvider>
      ),
    });
    act(() => result.current({ kind: 'success', message: '画布已保存' }));
    const saved = screen.getByText('画布已保存');
    expect(saved.closest('.themed-message-notice-success')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('画布已保存');

    act(() => result.current({ kind: 'error', message: '保存失败，请重试' }));
    expect(screen.queryByText('画布已保存')).not.toBeInTheDocument();
    expect(
      screen.getByText('保存失败，请重试').closest('.themed-message-notice-error'),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败，请重试');
    await advanceTime(4000);
    expect(screen.getByText('保存失败，请重试')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    await advanceTime(1000);
    expect(screen.queryByText('保存失败，请重试')).not.toBeInTheDocument();
  });

  it('重复同一个成功提示只更新一条消息，并从最近一次操作重新计时', async () => {
    const { result } = renderHook(useAppNotice, { wrapper: UiProvider });
    const notice = { kind: 'success' as const, message: '资源已加入' };
    act(() => result.current(notice));
    await advanceTime(2500);
    act(() => result.current(notice));
    expect(screen.getAllByText('资源已加入')).toHaveLength(1);
    await advanceTime(1000);
    expect(screen.getByText('资源已加入')).toBeInTheDocument();
    await advanceTime(3200);
    expect(screen.queryByText('资源已加入')).not.toBeInTheDocument();
  });

  it('保留函数更新与置空契约，旧成功提示到期不会关闭后续错误', async () => {
    const { result } = renderHook(useAppNotice, { wrapper: UiProvider });
    act(() => result.current({ kind: 'success', message: '完成' }));
    await advanceTime(2500);
    act(() =>
      result.current((current) => ({ kind: 'error', message: `${current?.message}后连接中断` })),
    );
    await advanceTime(4000);
    expect(screen.getByText('完成后连接中断')).toBeInTheDocument();
    act(() => result.current(null));
    await advanceTime(1000);
    expect(screen.queryByText('完成后连接中断')).not.toBeInTheDocument();
  });

  it('卸载只清理自己的提示，保留同一应用上下文中其他来源的提示', async () => {
    const setters = new Map<string, ReturnType<typeof useAppNotice>>();
    function Source({ id }: { id: string }) {
      const setNotice = useAppNotice();
      useEffect(() => {
        setters.set(id, setNotice);
      }, [id, setNotice]);
      return null;
    }
    function Harness({ first = true }: { first?: boolean }) {
      return (
        <UiProvider>
          {first && <Source id="first" />}
          <Source id="second" />
        </UiProvider>
      );
    }
    const view = render(<Harness />);
    act(() => {
      setters.get('first')!({ kind: 'error', message: '画布错误' });
      setters.get('second')!({ kind: 'error', message: '设置错误' });
    });
    expect(screen.getByText('画布错误')).toBeInTheDocument();
    expect(screen.getByText('设置错误')).toBeInTheDocument();
    view.rerender(<Harness first={false} />);
    await advanceTime(1000);
    expect(screen.queryByText('画布错误')).not.toBeInTheDocument();
    expect(screen.getByText('设置错误')).toBeInTheDocument();
  });
});

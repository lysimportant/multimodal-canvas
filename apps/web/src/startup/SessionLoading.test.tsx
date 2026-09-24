import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionLoading } from './SessionLoading';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('会话恢复等待页', () => {
  it('立即显示中文状态和真实 Ant Design Spin，不提供绕过认证的操作', () => {
    const { container } = render(<SessionLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('正在恢复登录状态');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByText('正在校验会话，请稍候。')).toBeVisible();
    expect(container.querySelector('.ant-spin-spinning')).toBeInTheDocument();
    expect(container.querySelector('.ant-spin')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('满 10 秒才解释较久等待，不虚构进度或要求重复发起认证', () => {
    render(<SessionLoading />);
    act(() => vi.advanceTimersByTime(9_999));
    expect(screen.getByText('正在校验会话，请稍候。')).toBeVisible();
    expect(screen.queryByText(/登录状态恢复耗时较长/)).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toHaveTextContent('正在恢复登录状态');
    expect(screen.getByRole('status')).toHaveTextContent(
      '登录状态恢复耗时较长，仍在等待服务器响应。请检查网络连接，暂时无需刷新。',
    );
    expect(screen.queryByText('正在校验会话，请稍候。')).not.toBeInTheDocument();
  });

  it('快速完成并卸载时清理尚未触发的提示计时器', () => {
    const { unmount } = render(<SessionLoading />);
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(180_000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('较久等待后卸载也不留下计时器', () => {
    const { unmount } = render(<SessionLoading />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('StrictMode 重建 effect 只保留一个提示计时器', () => {
    const { unmount } = render(
      <StrictMode>
        <SessionLoading />
      </StrictMode>,
    );
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('status')).toHaveTextContent('登录状态恢复耗时较长');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('重新挂载时从普通等待说明重新计时', () => {
    const first = render(<SessionLoading />);
    act(() => vi.advanceTimersByTime(10_000));
    first.unmount();
    render(<SessionLoading />);
    expect(screen.getByText('正在校验会话，请稍候。')).toBeVisible();
    act(() => vi.advanceTimersByTime(9_999));
    expect(screen.queryByText(/登录状态恢复耗时较长/)).not.toBeInTheDocument();
  });
});

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startNewApiLogin } from './auth-client';
import { AuthenticationPage } from './authentication/AuthenticationPage';

vi.mock('./auth-client', async (original) => ({
  ...(await original<typeof import('./auth-client')>()),
  startNewApiLogin: vi.fn(),
}));

beforeEach(() => {
  window.history.replaceState(null, '', '/auth/login?next=%2Fworkspace%3Fcreate%3D1');
  vi.mocked(startNewApiLogin).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('New API 登录离场状态', () => {
  it('点击后立即进入不可重复提交的离场状态，不创建旧认证遮罩', () => {
    const view = render(<AuthenticationPage authUser={null} />);
    fireEvent.click(screen.getByRole('button', { name: '使用 New API 登录' }));
    expect(view.container.querySelector('.auth-entry-page')).toHaveClass('is-leaving');
    expect(screen.getByRole('button', { name: '正在前往 New API' })).toBeDisabled();
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(startNewApiLogin).toHaveBeenCalledWith(expect.any(String), '/workspace?create=1');
  });

  it('减少动态效果不改变唯一登录动作和站内续接目标', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<AuthenticationPage authUser={null} />);
    fireEvent.click(screen.getByRole('button', { name: '使用 New API 登录' }));
    expect(startNewApiLogin).toHaveBeenCalledTimes(1);
    expect(startNewApiLogin).toHaveBeenLastCalledWith(expect.any(String), '/workspace?create=1');
  });
});

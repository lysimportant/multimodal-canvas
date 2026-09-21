import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startNewApiLogin, type AuthUser } from '../auth-client';
import { PUBLIC_API_CATALOG_URL } from '../workspace/contracts';
import { AuthenticationPage } from './AuthenticationPage';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  startNewApiLogin: vi.fn(),
}));

const user: AuthUser = {
  id: 'newapi-user',
  displayName: 'New API 用户',
  role: 'user',
  createdAt: '2026-09-21T00:00:00.000Z',
};

/** 挂载 New API 唯一登录页。 */
function renderPage() {
  return render(<AuthenticationPage authUser={null} />);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/auth/login');
  vi.mocked(startNewApiLogin).mockReset();
});

afterEach(() => cleanup());

describe('New API 认证页', () => {
  it('只显示唯一外部登录入口', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '使用 New API 登录' })).toBeVisible();
    expect(screen.getByRole('button', { name: '使用 New API 登录' })).toBeEnabled();
    expect(screen.queryByLabelText('邮箱')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
    expect(screen.queryByText(/注册|找回密码|邮箱验证/)).not.toBeInTheDocument();
  });

  it('保留安全站内 next 并只发起一次整页 New API 登录', () => {
    window.history.replaceState(null, '', '/auth/login?next=%2Fprojects%2Fproject-a');
    renderPage();
    const action = screen.getByRole('button', { name: '使用 New API 登录' });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(startNewApiLogin).toHaveBeenCalledTimes(1);
    expect(startNewApiLogin).toHaveBeenCalledWith(expect.any(String), '/projects/project-a');
    expect(screen.getByRole('button', { name: '正在前往 New API' })).toBeDisabled();
  });

  it('拒绝外站 next，授权失败只显示固定错误且不回显查询内容', () => {
    window.history.replaceState(
      null,
      '',
      '/auth/login?next=https%3A%2F%2Fevil.example%2Fx&error=secret-detail',
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '使用 New API 登录' }));
    expect(startNewApiLogin).toHaveBeenCalledWith(expect.any(String), '/workspace');
    expect(screen.getByRole('alert')).toHaveTextContent('登录未完成');
    expect(screen.queryByText('secret-detail')).not.toBeInTheDocument();
  });

  it('已有 Cookie 会话直接进入续接页，用户没有邮箱也可继续', () => {
    window.history.replaceState(null, '', '/auth/login?next=%2Fsettings');
    render(<AuthenticationPage authUser={user} />);
    fireEvent.click(screen.getByRole('button', { name: '继续进入工作台' }));
    expect(window.location.pathname).toBe('/settings');
    expect(startNewApiLogin).not.toHaveBeenCalled();
  });

  it('New API 外链使用独立标签页且不携带浏览器会话', () => {
    renderPage();
    const link = screen.getByRole('link', { name: '打开 New API' });
    expect(link).toHaveAttribute('href', PUBLIC_API_CATALOG_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('取消登录后提供可恢复提示，不要求再次授权', () => {
    window.history.replaceState(null, '', '/auth/login?error=login_cancelled&next=%2Fsettings');
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('已取消登录');
    expect(screen.queryByText(/重新授权/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '使用 New API 登录' }));
    expect(startNewApiLogin).toHaveBeenCalledWith(expect.any(String), '/settings');
  });
});

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './AccountMenu';
import type { AuthUser } from '../auth-client';

/** 合成账户仅用于验证菜单权限和显式注销行为。 */
const user: AuthUser = {
  id: 'account-menu-user',
  email: 'menu@example.test',
  displayName: '测试用户',
  role: 'user',
  createdAt: '2026-01-01T00:00:00Z',
};
afterEach(cleanup);

describe('账户菜单', () => {
  it('头像和关闭只改变菜单状态，只有独立退出命令调用注销', async () => {
    const actor = userEvent.setup();
    const logout = vi.fn();
    render(<AccountMenu user={user} onRequestLogin={vi.fn()} onLogout={logout} />);
    const trigger = screen.getByRole('button', { name: '账户菜单' });
    await actor.click(trigger);
    expect(screen.getByRole('menu', { name: '账户操作' })).toBeVisible();
    expect(logout).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: '管理后台' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(logout).not.toHaveBeenCalled();
    await actor.click(trigger);
    await actor.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('管理员才显示后台入口，个人资料导航不注销', async () => {
    const actor = userEvent.setup();
    const logout = vi.fn();
    render(
      <AccountMenu user={{ ...user, role: 'admin' }} onRequestLogin={vi.fn()} onLogout={logout} />,
    );
    await actor.click(screen.getByRole('button', { name: '账户菜单' }));
    expect(screen.getByRole('menuitem', { name: '管理后台' })).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('menuitem', { name: '个人信息' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('menuitem', { name: '个人信息' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(logout).not.toHaveBeenCalled();
  });

  it('鼠标悬停用户图标时显示菜单，离开账户区域后关闭', async () => {
    const actor = userEvent.setup();
    render(<AccountMenu user={user} onRequestLogin={vi.fn()} onLogout={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '账户菜单' });
    const container = trigger.parentElement!;

    await actor.hover(trigger);
    expect(screen.getByRole('menu', { name: '账户操作' })).toBeVisible();
    await actor.unhover(container);
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    expect(screen.queryByRole('menu', { name: '账户操作' })).not.toBeInTheDocument();
  });

  it('匿名入口只请求登录，键盘聚焦可操作菜单项目', async () => {
    const actor = userEvent.setup();
    const login = vi.fn();
    const view = render(<AccountMenu user={null} onRequestLogin={login} onLogout={vi.fn()} />);
    await actor.click(screen.getByRole('button', { name: '登录账户' }));
    expect(login).toHaveBeenCalledTimes(1);
    view.rerender(<AccountMenu user={user} onRequestLogin={login} onLogout={vi.fn()} />);
    await actor.click(screen.getByRole('button', { name: '账户菜单' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: '个人信息' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: '退出登录' })).toHaveFocus();
  });
});

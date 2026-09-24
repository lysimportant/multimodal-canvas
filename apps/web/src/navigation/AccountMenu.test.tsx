import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByRole('menu', { name: '账户操作' })).toBeVisible());
    expect(logout).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: '管理后台' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27 });
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '账户操作' })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(logout).not.toHaveBeenCalled();
    await actor.click(trigger);
    await actor.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('管理员才显示后台入口，资源导航不注销', async () => {
    const actor = userEvent.setup();
    const logout = vi.fn();
    render(
      <AccountMenu user={{ ...user, role: 'admin' }} onRequestLogin={vi.fn()} onLogout={logout} />,
    );
    await actor.click(screen.getByRole('button', { name: '账户菜单' }));
    expect(screen.getByRole('link', { name: '管理后台' })).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('link', { name: '我的资源' })).toHaveAttribute('target', '_blank');
    expect(logout).not.toHaveBeenCalled();
  });

  it('鼠标悬停用户图标时显示菜单，离开账户区域后关闭', async () => {
    const actor = userEvent.setup();
    render(<AccountMenu user={user} onRequestLogin={vi.fn()} onLogout={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '账户菜单' });

    await actor.hover(trigger);
    await waitFor(() => expect(screen.getByRole('menu', { name: '账户操作' })).toBeVisible());
    await actor.unhover(trigger);
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '账户操作' })).not.toBeInTheDocument(),
    );
  });

  it('账户菜单新标签携带来源项目，普通点击仍走保存回调，修饰键保持浏览器行为', () => {
    window.history.replaceState(null, '', '/projects/project-a');
    const navigate = vi.fn((_href, event) => event.preventDefault());
    render(
      <AccountMenu
        user={user}
        onRequestLogin={vi.fn()}
        onLogout={vi.fn()}
        projectId="project-a"
        onNavigate={navigate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '账户菜单' }));
    const resources = within(screen.getByRole('menuitem', { name: '我的资源' })).getByRole('link');
    expect(resources).toHaveAttribute('href', '/resources?returnProjectId=project-a');
    expect(resources).toHaveAttribute('target', '_blank');
    fireEvent.click(resources);
    expect(navigate).toHaveBeenCalledWith(
      '/resources?returnProjectId=project-a',
      expect.anything(),
    );
    expect(window.location.pathname).toBe('/projects/project-a');
    navigate.mockClear();
    resources.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(resources, { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('匿名入口只请求登录，键盘聚焦可操作菜单项目', async () => {
    // jsdom 没有布局；仅为本测试提供可见尺寸，让库自己的焦点循环生效。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 100, 32),
    );
    const actor = userEvent.setup();
    const login = vi.fn();
    const view = render(<AccountMenu user={null} onRequestLogin={login} onLogout={vi.fn()} />);
    await actor.click(screen.getByRole('button', { name: '登录账户' }));
    expect(login).toHaveBeenCalledTimes(1);
    view.rerender(<AccountMenu user={user} onRequestLogin={login} onLogout={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '账户菜单' });
    trigger.focus();
    await actor.keyboard('{Enter}');
    const resources = await screen.findByRole('menuitem', { name: '我的资源' });
    await waitFor(() => expect(resources).toHaveFocus());
    fireEvent.keyDown(resources, { key: 'ArrowDown', keyCode: 40 });
    await waitFor(() => expect(screen.getByRole('link', { name: '我的任务' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'End', keyCode: 35 });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '退出登录' })).toHaveFocus());
  });

  it('键盘激活资源菜单仍经过保存回调，不绕过新标签路由约定', async () => {
    // jsdom 没有布局；仅为本测试提供可见尺寸，让库自己的焦点循环生效。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 100, 32),
    );
    const actor = userEvent.setup();
    const navigate = vi.fn((_href, event) => event.preventDefault());
    const logout = vi.fn();
    render(
      <AccountMenu
        user={user}
        onRequestLogin={vi.fn()}
        onLogout={logout}
        projectId="project-a"
        onNavigate={navigate}
      />,
    );
    screen.getByRole('button', { name: '账户菜单' }).focus();
    await actor.keyboard('{Enter}');
    const resources = await screen.findByRole('menuitem', { name: '我的资源' });
    await waitFor(() => expect(resources).toHaveFocus());
    fireEvent.keyDown(resources, { key: 'Enter', keyCode: 13 });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      '/resources?returnProjectId=project-a',
      expect.anything(),
    );
    expect(logout).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '账户操作' })).not.toBeInTheDocument(),
    );
  });
});

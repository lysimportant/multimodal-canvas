import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileWorkspacePanel, useMobileWorkspace } from './MobileWorkspacePanel';

afterEach(cleanup);

describe('手机画布浮层', () => {
  it('桌面直接保留原子元素，不改变布局父级', () => {
    const { container } = render(
      <MobileWorkspacePanel
        mobile={false}
        open={false}
        title="全部资源"
        id="resources"
        kind="resources"
        onClose={vi.fn()}
      >
        <aside>资源</aside>
      </MobileWorkspacePanel>,
    );
    expect(container.firstElementChild?.tagName).toBe('ASIDE');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('手机关闭时保留上传入口，但不展示对话框', () => {
    render(
      <MobileWorkspacePanel
        mobile
        open={false}
        title="全部资源"
        id="resources"
        kind="resources"
        onClose={vi.fn()}
      >
        <input aria-label="上传资源" type="file" />
      </MobileWorkspacePanel>,
    );
    expect(screen.getByLabelText('上传资源')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('未打开菜单时不挂载嵌套工具，防止子浮层脱离菜单显示', () => {
    render(
      <MobileWorkspacePanel
        mobile
        open={false}
        title="画布菜单"
        id="menu"
        kind="menu"
        onClose={vi.fn()}
      >
        <button type="button">外观</button>
      </MobileWorkspacePanel>,
    );
    expect(screen.queryByText('外观')).not.toBeInTheDocument();
  });

  it('提供有名称的手机对话框与关闭按钮', () => {
    const onClose = vi.fn();
    render(
      <MobileWorkspacePanel mobile open title="画布菜单" id="menu" kind="menu" onClose={onClose}>
        <button type="button">撤销</button>
      </MobileWorkspacePanel>,
    );
    expect(screen.getByRole('dialog', { name: '画布菜单' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '关闭画布菜单' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('响应断点切换并清理监听，不写持久化布局', () => {
    const listeners = new Set<() => void>();
    const query = {
      matches: true,
      addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: () => void) =>
        listeners.delete(listener),
      ),
    };
    vi.spyOn(window, 'matchMedia').mockReturnValue(query as unknown as MediaQueryList);
    const { result, unmount } = renderHook(useMobileWorkspace);
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 600px)');
    act(() => {
      query.matches = false;
      listeners.forEach((listener) => listener());
    });
    expect(result.current).toBe(false);
    unmount();
    expect(listeners.size).toBe(0);
  });
});

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import { parseAppRoute } from '../routing';
import { AppNavigation } from './AppNavigation';

describe('AppNavigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspace');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('removes the desktop primary navigation and marks the active drawer page', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/projects/project-1')} projectId="project-1" />);

    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开主菜单' }));
    const drawerNavigation = screen.getByRole('navigation', { name: '菜单导航' });
    expect(drawerNavigation.querySelector('a[aria-current="page"]')).toHaveTextContent('工作台');
    expect(drawerNavigation.querySelector('a[href^="/settings"]')).toHaveAttribute(
      'href',
      '/settings?project=project-1',
    );
  });

  it('includes and highlights the contact page in the drawer', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/contact')} />);

    await user.click(screen.getByRole('button', { name: '打开主菜单' }));
    const drawerNavigation = screen.getByRole('navigation', { name: '菜单导航' });
    const contactLink = drawerNavigation.querySelector('a[href="/contact"]');

    expect(contactLink).toHaveTextContent('联系我们');
    expect(contactLink).toHaveAttribute('aria-current', 'page');

    await user.click(contactLink!);
    expect(window.location.pathname).toBe('/contact');
    expect(screen.queryByRole('dialog', { name: 'Multimodal Canvas' })).not.toBeInTheDocument();
  });

  it('supports Escape, focus restoration, body locking, and Tab wrapping', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/workspace')} />);
    const trigger = screen.getByRole('button', { name: '打开主菜单' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Multimodal Canvas' });
    await waitFor(() => expect(screen.getByRole('link', { name: /工作台/ })).toHaveFocus());
    expect(document.body.style.overflow).toBe('hidden');

    const close = screen.getByRole('button', { name: '关闭主菜单' });
    const links = Array.from(dialog.querySelectorAll<HTMLElement>('a[href]'));
    const last = links.at(-1)!;
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Multimodal Canvas' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('ignores an IME Escape event while the drawer is open', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/workspace')} />);
    await user.click(screen.getByRole('button', { name: '打开主菜单' }));

    fireEvent.keyDown(document, { key: 'Escape', keyCode: 229, isComposing: true });
    expect(screen.getByRole('dialog', { name: 'Multimodal Canvas' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Multimodal Canvas' })).not.toBeInTheDocument();
  });

  it('navigates from the drawer, closes it, and exposes an integration callback', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<AppNavigation route={parseAppRoute('/workspace')} onNavigate={onNavigate} />);

    await user.click(screen.getByRole('button', { name: '打开主菜单' }));
    await user.click(screen.getByRole('navigation', { name: '菜单导航' }).querySelector('a')!);

    expect(onNavigate).toHaveBeenCalledWith('/', expect.anything());
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows contact and external destinations in the header', () => {
    render(<AppNavigation route={parseAppRoute('/contact')} />);

    expect(screen.getByRole('link', { name: '联系我们' })).toHaveAttribute('href', '/contact');
    expect(screen.getByRole('link', { name: '联系我们' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'API获取' })).toHaveAttribute(
      'href',
      'https://api.lolicon.beer',
    );
    expect(screen.getByRole('link', { name: 'API获取' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'API获取' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getByRole('link', { name: '主站' })).toHaveAttribute(
      'href',
      'https://lolicon.beer',
    );
    expect(screen.getByRole('link', { name: '主站' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: '主站' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('makes the header transparent after the page scrolls', () => {
    render(<AppNavigation route={parseAppRoute('/')} />);
    const header = document.querySelector('.mc-app-navigation');

    expect(header).not.toHaveClass('is-scrolled');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 80 });
    fireEvent.scroll(window);
    expect(header).toHaveClass('is-scrolled');
  });

  it('opens all existing themes on hover and supports keyboard selection', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/')} />);
    const trigger = screen.getByRole('button', { name: '切换主题，当前护眼' });
    const container = trigger.parentElement!;

    fireEvent.mouseEnter(container);
    expect(screen.getByRole('menu', { name: '界面主题' })).toBeVisible();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);
    fireEvent.mouseLeave(container);
    expect(screen.queryByRole('menu', { name: '界面主题' })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole('menu', { name: '界面主题' })).toBeVisible();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '界面主题' })).not.toBeInTheDocument();

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: '护眼' })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: '护眼' }), {
      key: 'ArrowDown',
    });
    expect(screen.getByRole('menuitemradio', { name: '明亮' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: '明亮' }), { key: 'End' });
    expect(screen.getByRole('menuitemradio', { name: '高对比' })).toHaveFocus();

    await user.click(screen.getByRole('menuitemradio', { name: '高对比' }));
    expect(useWorkspacePreferences.getState().canvasTheme).toBe('contrast');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '切换主题，当前高对比' })).toHaveFocus(),
    );
  });
});

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
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('marks the active page in desktop and drawer navigation', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/projects/project-1')} projectId="project-1" />);

    const primaryNavigation = screen.getByRole('navigation', { name: '主导航' });
    expect(primaryNavigation.querySelector('a[aria-current="page"]')).toHaveTextContent('工作台');

    await user.click(screen.getByRole('button', { name: '打开主菜单' }));
    const drawerNavigation = screen.getByRole('navigation', { name: '菜单导航' });
    expect(drawerNavigation.querySelector('a[aria-current="page"]')).toHaveTextContent('工作台');
    expect(drawerNavigation.querySelector('a[href^="/settings"]')).toHaveAttribute(
      'href',
      '/settings?project=project-1',
    );
  });

  it('supports Escape, focus restoration, body locking, and Tab wrapping', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/workspace')} />);
    const trigger = screen.getByRole('button', { name: '打开主菜单' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Multimodal Canvas' });
    await waitFor(() => expect(screen.getAllByRole('link', { name: /工作台/ })[1]).toHaveFocus());
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

  it('toggles between the existing light and dark theme states', async () => {
    const user = userEvent.setup();
    render(<AppNavigation route={parseAppRoute('/')} />);

    await user.click(screen.getByRole('button', { name: '切换到深色主题' }));
    expect(useWorkspacePreferences.getState().canvasTheme).toBe('dark');
    await user.click(screen.getByRole('button', { name: '切换到浅色主题' }));
    expect(useWorkspacePreferences.getState().canvasTheme).toBe('light');
  });
});

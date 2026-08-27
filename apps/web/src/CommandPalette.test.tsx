import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, type CommandPaletteCommand } from './CommandPalette';

function makeCommands(overrides: Partial<CommandPaletteCommand>[] = []): CommandPaletteCommand[] {
  const defaults: CommandPaletteCommand[] = [
    {
      id: 'new-project',
      label: '新建项目',
      category: '项目',
      shortcut: 'N',
      onSelect: vi.fn(),
    },
    {
      id: 'open-settings',
      label: '打开设置',
      category: '应用',
      description: '管理连接和模型',
      onSelect: vi.fn(),
    },
    {
      id: 'disabled-command',
      label: '不可用命令',
      disabled: true,
      onSelect: vi.fn(),
    },
    {
      id: 'export-result',
      label: '导出结果',
      onSelect: vi.fn(),
    },
  ];
  return defaults.map((command, index) => ({ ...command, ...overrides[index] }));
}

describe('CommandPalette', () => {
  afterEach(() => cleanup());

  it('focuses search, filters commands, and renders command metadata', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette open commands={makeCommands()} onClose={onClose} />);

    const input = screen.getByRole('searchbox', { name: '搜索命令…' });
    expect(input).toHaveFocus();
    expect(screen.getByRole('option', { name: /新建项目/ })).toBeInTheDocument();
    expect(screen.getByText('管理连接和模型')).toBeInTheDocument();
    expect(screen.getByText('N')).toBeInTheDocument();

    await user.type(input, '设置');
    expect(screen.getByRole('option', { name: /打开设置/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /新建项目/ })).not.toBeInTheDocument();
  });

  it('navigates enabled commands with arrows, Home/End, and selects with Enter', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const commands = makeCommands();
    render(<CommandPalette open commands={commands} onClose={onClose} />);

    const input = screen.getByRole('searchbox');
    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);

    await user.keyboard('{End}');
    expect(input).toHaveAttribute('aria-activedescendant', options[3].id);
    await user.keyboard('{Home}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[3].id);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(commands[3].onSelect).toHaveBeenCalledWith(commands[3]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not navigate, select, or close for IME and legacy 229 keyboard events', () => {
    const onClose = vi.fn();
    const commands = makeCommands();
    render(<CommandPalette open commands={commands} onClose={onClose} />);

    const input = screen.getByRole('searchbox');
    const initialActiveDescendant = input.getAttribute('aria-activedescendant');

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(input).toHaveAttribute('aria-activedescendant', initialActiveDescendant);
    expect(commands[0].onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the active command visible while navigating a long list', async () => {
    const user = userEvent.setup();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const commands = Array.from({ length: 10 }, (_, index) => ({
        id: `command-${index}`,
        label: `命令 ${index + 1}`,
        onSelect: vi.fn(),
      }));
      render(<CommandPalette open commands={commands} onClose={vi.fn()} />);

      await user.keyboard('{End}');

      const options = screen.getAllByRole('option');
      expect(screen.getByRole('searchbox')).toHaveAttribute(
        'aria-activedescendant',
        options.at(-1)?.id,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalDescriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('closes on Escape or backdrop click and restores focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = '打开命令面板';
    document.body.append(opener);
    opener.focus();
    const view = render(<CommandPalette open commands={makeCommands()} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<CommandPalette open={false} commands={makeCommands()} onClose={onClose} />);
    expect(opener).toHaveFocus();

    view.rerender(<CommandPalette open commands={makeCommands()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('command-palette'));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<CommandPalette open={false} commands={makeCommands()} onClose={onClose} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps the palette open and reports a safe error when a command fails', async () => {
    const user = userEvent.setup();
    const failingCommand: CommandPaletteCommand = {
      id: 'fail',
      label: '失败命令',
      onSelect: vi.fn().mockRejectedValue(new Error('secret token leaked')),
    };
    render(<CommandPalette open commands={[failingCommand]} onClose={vi.fn()} />);

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('命令执行失败');
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret token');
  });

  it('traps Tab focus inside the palette controls on narrow layouts', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open commands={makeCommands()} onClose={vi.fn()} />);

    const input = screen.getByRole('searchbox');
    const closeButton = screen.getByRole('button', { name: '关闭命令面板' });
    expect(input).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();

    await user.type(input, '设置');
    const clearButton = screen.getByRole('button', { name: '清空搜索' });
    await user.tab();
    expect(clearButton).toHaveFocus();
    await user.tab();
    expect(closeButton).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();

    await user.tab({ shift: true });
    expect(closeButton).toHaveFocus();
  });

  it('supports a ref override and restore callback', () => {
    const restoreTarget = document.createElement('button');
    restoreTarget.type = 'button';
    document.body.append(restoreTarget);
    const restoreFocusRef = { current: restoreTarget };
    const onRestoreFocus = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <CommandPalette
        open
        commands={makeCommands()}
        onClose={onClose}
        restoreFocusRef={restoreFocusRef}
        onRestoreFocus={onRestoreFocus}
      />,
    );

    view.rerender(
      <CommandPalette
        open={false}
        commands={makeCommands()}
        onClose={onClose}
        restoreFocusRef={restoreFocusRef}
        onRestoreFocus={onRestoreFocus}
      />,
    );
    expect(restoreTarget).toHaveFocus();
    expect(onRestoreFocus).toHaveBeenCalledWith(restoreTarget);
    restoreTarget.remove();
  });

  it('shows an empty state for a query with no matches', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open commands={makeCommands()} onClose={vi.fn()} />);
    const input = screen.getByRole('searchbox');
    await user.type(input, '不存在');
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的命令');
    expect(within(screen.getByRole('listbox')).queryAllByRole('option')).toHaveLength(0);
  });
});

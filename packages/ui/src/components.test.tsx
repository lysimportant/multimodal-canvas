import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './dialog';
import { Input } from './input';

afterEach(cleanup);

describe('shared UI primitives', () => {
  it('forwards button and input semantics while merging consumer classes', () => {
    render(
      <label>
        名称
        <Input aria-label="名称" className="settings-input" />
        <Button className="button-primary">保存</Button>
      </label>,
    );

    expect(screen.getByRole('textbox', { name: '名称' })).toHaveClass('settings-input');
    expect(screen.getByRole('button', { name: '保存' })).toHaveClass('button-primary');
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('type', 'button');
  });

  it('mounts a modal overlay, locks scrolling, traps focus, and restores the trigger', async () => {
    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog modal open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>打开设置</Button>
          </DialogTrigger>
          <DialogContent
            contained
            aria-modal="true"
            overlayClassName="settings-backdrop"
            className="settings-panel"
          >
            <DialogTitle>AI 连接</DialogTitle>
            <DialogClose asChild>
              <Button>关闭</Button>
            </DialogClose>
            <Button>末尾操作</Button>
          </DialogContent>
        </Dialog>
      );
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: '打开设置' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toHaveClass('settings-backdrop');
    expect(overlay).toHaveClass('fixed', 'inset-0', 'z-50');
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content');
    expect(dialog).toHaveClass(
      'settings-panel',
      'z-[51]',
      'h-dvh',
      'max-h-dvh',
      'max-w-[410px]',
      'overflow-x-hidden',
      'overflow-y-auto',
    );
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(document.body).toHaveAttribute('data-scroll-locked'));
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus());

    fireEvent.keyDown(document.activeElement ?? document, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(screen.getByRole('button', { name: '末尾操作' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(document.body).not.toHaveAttribute('data-scroll-locked'));
  });

  it('closes through the shared close primitive', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent overlayClassName="settings-backdrop" className="settings-panel">
          <DialogTitle>AI 连接</DialogTitle>
          <DialogClose asChild>
            <Button>关闭</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

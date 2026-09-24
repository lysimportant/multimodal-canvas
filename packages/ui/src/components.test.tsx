import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { Input } from './input';
import { Textarea } from './textarea';

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
            <DialogTitle id="custom-dialog-title">AI 连接</DialogTitle>
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
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    const overlay = document.querySelector('.ant-modal-mask');
    expect(overlay).toHaveClass('settings-backdrop');
    expect(dialog).toHaveClass('ant-modal', 'ui-dialog-contained', 'settings-panel');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() =>
      expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(
        true,
      ),
    );
    // Modal 的 focus trap 依赖实际布局，浏览器专项验证 Tab 循环；此处验证键盘关闭与恢复。
    fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 27 });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });

  it('closes through the shared close primitive', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          overlayClassName="settings-backdrop"
          className="settings-panel"
          style={{ width: 420, display: 'inline-flex', padding: 0 }}
        >
          <DialogTitle>AI 连接</DialogTitle>
          <DialogClose asChild>
            <Button>关闭</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'AI 连接' })).toHaveStyle({
      width: '420px',
      display: 'inline-flex',
      padding: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('preserves DOM refs, selection and IME events through library inputs', () => {
    const inputRef = createRef<HTMLInputElement>();
    const textareaRef = createRef<HTMLTextAreaElement>();
    const onComposition = vi.fn();
    const onChange = vi.fn();
    render(
      <>
        <Input ref={inputRef} aria-label="名称输入" defaultValue="名称" size={12} />
        <Textarea
          ref={textareaRef}
          aria-label="提示词"
          defaultValue="测试提示"
          rows={3}
          onCompositionStart={onComposition}
          onCompositionEnd={onComposition}
          onChange={onChange}
        />
      </>,
    );
    expect(inputRef.current).toBe(screen.getByRole('textbox', { name: '名称输入' }));
    expect(inputRef.current).toHaveClass('ant-input');
    expect(inputRef.current).toHaveAttribute('size', '12');
    const textarea = screen.getByRole('textbox', { name: '提示词' });
    expect(textareaRef.current).toBe(textarea);
    expect(textarea).toHaveClass('ant-input');
    expect(textarea).toHaveAttribute('rows', '3');
    textareaRef.current!.setSelectionRange(1, 3);
    expect(textareaRef.current!.selectionStart).toBe(1);
    expect(textareaRef.current!.selectionEnd).toBe(3);
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: '测试中文' } });
    fireEvent.compositionEnd(textarea, { data: '中文' });
    expect(onComposition).toHaveBeenCalledTimes(2);
    // TextArea 在输入变化和组合提交时各发布一次值，业务 IME 层负责提交去重。
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall?.[0].target.value).toBe('测试中文');
    expect(textarea).toHaveValue('测试中文');
  });

  it('keeps submit and disabled semantics on the library button', () => {
    const onSubmit = vi.fn((event) => event.preventDefault());
    const onDisabledClick = vi.fn();
    const buttonRef = createRef<HTMLButtonElement>();
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" ref={buttonRef}>
          提交表单
        </Button>
        <Button disabled onClick={onDisabledClick}>
          不可点击
        </Button>
      </form>,
    );
    const submit = screen.getByRole('button', { name: '提交表单' });
    expect(buttonRef.current).toBe(submit);
    expect(submit).toHaveClass('ant-btn');
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '不可点击' }));
    expect(onDisabledClick).not.toHaveBeenCalled();
  });

  it('names concurrent dialogs from their own visible headings and returns the real panel', () => {
    const panelRef = createRef<HTMLDivElement>();
    render(
      <>
        <Dialog open>
          <DialogContent ref={panelRef} aria-labelledby="first-title">
            <DialogTitle id="first-title">第一层</DialogTitle>
          </DialogContent>
        </Dialog>
        <Dialog open>
          <DialogContent role="alertdialog">
            <DialogTitle>确认操作</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
    expect(panelRef.current).toBe(screen.getByRole('dialog', { name: '第一层' }));
    expect(screen.getByRole('alertdialog', { name: '确认操作' })).toHaveClass('ant-modal');
  });

  it.each([undefined, 'custom-dialog-description'])(
    'associates the visible description using its actual ID (%s)',
    (descriptionId) => {
      render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription id={descriptionId}>
              将删除指定记录，此操作不可撤销。
            </DialogDescription>
          </DialogContent>
        </Dialog>,
      );
      const panel = screen.getByRole('dialog', { name: '确认删除' });
      const description = screen.getByText('将删除指定记录，此操作不可撤销。');
      expect(description.id).not.toBe('');
      if (descriptionId) expect(description.id).toBe(descriptionId);
      expect(panel).toHaveAttribute('aria-describedby', description.id);
      expect(panel).toHaveAccessibleDescription('将删除指定记录，此操作不可撤销。');
    },
  );

  it('does not leave a dangling description reference when the description is absent or removed', () => {
    /** 保持同一面板实例，检查可选说明的挂载和移除。 */
    function OptionalDescriptionDialog({ showDescription }: { showDescription: boolean }) {
      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>可选说明</DialogTitle>
            {showDescription && <DialogDescription>当前操作的说明</DialogDescription>}
          </DialogContent>
        </Dialog>
      );
    }
    const { rerender } = render(<OptionalDescriptionDialog showDescription={false} />);
    const panel = screen.getByRole('dialog', { name: '可选说明' });
    expect(panel).not.toHaveAttribute('aria-describedby');
    expect(panel).not.toHaveAccessibleDescription();

    rerender(<OptionalDescriptionDialog showDescription />);
    expect(screen.getByRole('dialog', { name: '可选说明' })).toBe(panel);
    expect(panel).toHaveAttribute('aria-describedby', screen.getByText('当前操作的说明').id);
    expect(panel).toHaveAccessibleDescription('当前操作的说明');

    rerender(<OptionalDescriptionDialog showDescription={false} />);
    expect(panel).not.toHaveAttribute('aria-describedby');
    expect(panel).not.toHaveAccessibleDescription();
  });

  it('prioritizes explicit description ARIA and allows undefined to disable automatic association', () => {
    /** 显式外部描述和显式 undefined 都由调用方决定，不回退到内部说明。 */
    function ExplicitDescriptionDialog({ mode }: { mode: 'auto' | 'external' | 'disabled' }) {
      const descriptionProps =
        mode === 'auto'
          ? {}
          : { 'aria-describedby': mode === 'external' ? 'external-description' : undefined };
      return (
        <>
          <p id="external-description">外部描述优先</p>
          <Dialog open>
            <DialogContent {...descriptionProps}>
              <DialogTitle>显式描述</DialogTitle>
              <DialogDescription>自动描述不能覆盖显式设置</DialogDescription>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<ExplicitDescriptionDialog mode="auto" />);
    const panel = screen.getByRole('dialog', { name: '显式描述' });
    const internalDescription = screen.getByText('自动描述不能覆盖显式设置');
    expect(panel).toHaveAttribute('aria-describedby', internalDescription.id);
    expect(panel).toHaveAccessibleDescription('自动描述不能覆盖显式设置');

    rerender(<ExplicitDescriptionDialog mode="external" />);
    expect(panel).toHaveAttribute('aria-describedby', 'external-description');
    expect(panel).toHaveAccessibleDescription('外部描述优先');

    rerender(<ExplicitDescriptionDialog mode="disabled" />);
    expect(panel).not.toHaveAttribute('aria-describedby');
    expect(panel).not.toHaveAccessibleDescription();
  });

  it('honors business cancellation guards on mask clicks', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent onPointerDownOutside={(event) => event.preventDefault()}>
          <DialogTitle>保存中</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const mask = document.querySelector('.ant-modal-wrap')!;
    fireEvent.mouseDown(mask);
    fireEvent.click(mask);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '保存中' })).toBeInTheDocument();
  });

  it.each([
    { conditional: false, preventDefault: false },
    { conditional: false, preventDefault: true },
    { conditional: true, preventDefault: false },
    { conditional: true, preventDefault: true },
  ])(
    'honors close autofocus under StrictMode (conditional=$conditional, preventDefault=$preventDefault)',
    async ({ conditional, preventDefault }) => {
      const businessTarget = createRef<HTMLButtonElement>();
      const onOpenAutoFocus = vi.fn();
      const onCloseAutoFocus = vi.fn((event: Event) => {
        if (preventDefault) {
          event.preventDefault();
          businessTarget.current?.focus();
        }
      });
      /** 分别覆盖常驻受控关闭和直接卸载，不把 StrictMode 伪卸载当成业务关闭。 */
      function CloseFocusDialog() {
        const [open, setOpen] = useState(false);
        const dialog = (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
              <DialogTitle>回焦兼容</DialogTitle>
              <DialogClose>关闭回焦窗口</DialogClose>
            </DialogContent>
          </Dialog>
        );
        return (
          <>
            <Button onClick={() => setOpen(true)}>打开回焦窗口</Button>
            <Button ref={businessTarget}>业务回焦目标</Button>
            {conditional ? open && dialog : dialog}
          </>
        );
      }
      render(
        <StrictMode>
          <CloseFocusDialog />
        </StrictMode>,
      );
      const trigger = screen.getByRole('button', { name: '打开回焦窗口' });
      trigger.focus();
      fireEvent.click(trigger);
      const close = await screen.findByRole('button', { name: '关闭回焦窗口' });
      await waitFor(() => expect(onOpenAutoFocus).toHaveBeenCalledTimes(1));
      expect(onCloseAutoFocus).not.toHaveBeenCalled();
      close.focus();
      expect(close).toHaveFocus();
      const restoreTrigger = vi.spyOn(trigger, 'focus');
      fireEvent.click(close);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1));
      expect(onCloseAutoFocus.mock.calls[0][0].defaultPrevented).toBe(preventDefault);
      if (preventDefault) {
        await waitFor(() => expect(businessTarget.current).toHaveFocus());
        expect(restoreTrigger).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(trigger).toHaveFocus());
        expect(restoreTrigger).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('restores focus when a consumer unmounts the open dialog directly', async () => {
    function ConditionalDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>条件挂载</Button>
          {open && (
            <Dialog open onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>临时预览</DialogTitle>
                <DialogClose>关闭预览</DialogClose>
              </DialogContent>
            </Dialog>
          )}
        </>
      );
    }
    render(<ConditionalDialog />);
    const trigger = screen.getByRole('button', { name: '条件挂载' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

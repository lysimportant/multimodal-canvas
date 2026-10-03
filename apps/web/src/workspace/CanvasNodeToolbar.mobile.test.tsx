import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';

/** 仅隔离断点，保留真实 Popover 和控件回调；断点监听由工作区测试覆盖。 */
const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('./MobileWorkspacePanel', () => ({ useMobileWorkspace: () => viewport.mobile }));
afterEach(cleanup);
beforeEach(() => {
  viewport.mobile = true;
});

describe('手机底部胶囊', () => {
  it('默认只显示四个媒体入口和向上箭头，媒体类型顺序与回调不变', async () => {
    const add = vi.fn();
    render(
      <CanvasNodeToolbar onAddGenerateNode={add} onRequestUpload={vi.fn()} onFitView={vi.fn()} />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: '更多画布工具' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    for (const [type, label] of [
      ['text', '文字'],
      ['image', '图片'],
      ['audio', '音频'],
      ['video', '视频'],
    ]) {
      await userEvent.click(screen.getByRole('button', { name: `新建${label}生成节点` }));
      expect(add).toHaveBeenLastCalledWith(type);
    }
    expect(screen.queryByRole('button', { name: '上传资产' })).not.toBeInTheDocument();
  });

  it('向上展开保留其余按钮与禁用状态，普通动作只执行一次并收起', async () => {
    const upload = vi.fn();
    const undo = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <CanvasNodeToolbar
          onAddGenerateNode={vi.fn()}
          onRequestUpload={upload}
          onUndoCanvas={undo}
          canUndo={false}
          onFitView={vi.fn()}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: '更多画布工具' }));
    const panel = screen.getByRole('dialog', { name: '更多画布工具' });
    expect(within(panel).getByRole('button', { name: '画布撤销' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: '画布撤销' }));
    expect(undo).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole('button', { name: '上传资产' }));
    expect(upload).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '更多画布工具' })).not.toBeInTheDocument(),
    );
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('Escape 关闭并返回箭头焦点，也可以再次点击箭头关闭', async () => {
    render(<CanvasNodeToolbar onAddGenerateNode={vi.fn()} onFitView={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '更多画布工具' });
    await userEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: '更多画布工具' });
    await waitFor(() => expect(panel).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('切回桌面恢复原按钮且不显示箭头，重新进入手机默认收起', async () => {
    const props = { onAddGenerateNode: vi.fn(), onRequestUpload: vi.fn(), onFitView: vi.fn() };
    const { rerender } = render(<CanvasNodeToolbar {...props} />);
    await userEvent.click(screen.getByRole('button', { name: '更多画布工具' }));
    viewport.mobile = false;
    rerender(<CanvasNodeToolbar {...props} />);
    expect(screen.queryByRole('button', { name: '更多画布工具' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传资产' })).toBeVisible();
    expect(screen.getByRole('button', { name: '自动适配缩放' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: '更多画布工具' })).not.toBeInTheDocument();
    viewport.mobile = true;
    rerender(<CanvasNodeToolbar {...props} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByRole('button', { name: '更多画布工具' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

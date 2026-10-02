import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';

afterEach(cleanup);

describe('胶囊区整理按钮', () => {
  it('放在节点组内且点击不穿透画布', () => {
    const arrange = vi.fn();
    const click = vi.fn();
    const pointer = vi.fn();
    render(
      <div onClick={click} onPointerDown={pointer}>
        <CanvasNodeToolbar onAddGenerateNode={vi.fn()} onArrangeNodes={arrange} canArrangeNodes />
      </div>,
    );
    const button = within(screen.getByRole('group', { name: '节点组' })).getByRole('button', {
      name: '整理画布节点',
    });
    expect(button).toHaveAttribute('title', expect.stringContaining('每行最多 10 个'));
    expect(button).toHaveAttribute('title', expect.stringContaining('相连节点按层级排列'));
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(arrange).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
  });

  it('不可整理时禁用按钮且不触发操作', () => {
    const arrange = vi.fn();
    render(
      <CanvasNodeToolbar
        onAddGenerateNode={vi.fn()}
        onArrangeNodes={arrange}
        canArrangeNodes={false}
      />,
    );
    const button = screen.getByRole('button', { name: '整理画布节点' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(arrange).not.toHaveBeenCalled();
  });

  it('未提供入口时不显示无效按钮', () => {
    render(<CanvasNodeToolbar onAddGenerateNode={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '整理画布节点' })).not.toBeInTheDocument();
  });
});

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@multimodal-canvas/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClearCanvasMenu, type ClearActionCounts } from './ClearCanvasMenu';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 默认候选数量：画布有内容、也有可清理的空节点。 */
function counts(overrides: Partial<ClearActionCounts> = {}): ClearActionCounts {
  return { nodes: 4, edges: 3, groups: 1, emptyNodes: 2, emptyNodeEdges: 1, ...overrides };
}

describe('ClearCanvasMenu', () => {
  it('hover 后展开两个动作，触发器本身不删除任何内容', async () => {
    const onClearCanvas = vi.fn();
    const onClearEmptyNodes = vi.fn();
    render(
      <ClearCanvasMenu
        counts={counts()}
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={onClearEmptyNodes}
      />,
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('menu', { name: '清空操作' })).toBeInTheDocument();
    expect(onClearCanvas).not.toHaveBeenCalled();
    expect(onClearEmptyNodes).not.toHaveBeenCalled();
  });

  it('点击触发器只展开，重复点击不关闭也不删除', async () => {
    const onClearCanvas = vi.fn();
    render(
      <ClearCanvasMenu
        counts={counts()}
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: '清空' });
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onClearCanvas).not.toHaveBeenCalled();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('键盘聚焦与回车展开，方向键在菜单项之间移动', async () => {
    render(
      <ClearCanvasMenu counts={counts()} onClearCanvas={vi.fn()} onClearEmptyNodes={vi.fn()} />,
    );
    const trigger = screen.getByRole('button', { name: '清空' });
    trigger.focus();
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /清空画布/ })).toHaveFocus());
    // jsdom 没有布局盒，菜单库以 offsetParent 判断候选项是否可见。
    for (const item of screen.getAllByRole('menuitem')) {
      Object.defineProperty(item, 'offsetParent', { configurable: true, value: document.body });
    }
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', keyCode: 40, which: 40 });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /清空空节点/ })).toHaveFocus());
  });

  it('Esc 关闭菜单', async () => {
    render(
      <ClearCanvasMenu counts={counts()} onClearCanvas={vi.fn()} onClearEmptyNodes={vi.fn()} />,
    );
    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('外部点击关闭菜单', async () => {
    render(
      <div>
        <ClearCanvasMenu counts={counts()} onClearCanvas={vi.fn()} onClearEmptyNodes={vi.fn()} />
        <Button type="button">外部按钮</Button>
      </div>,
    );
    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '外部按钮' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('从触发器移入菜单时保持展开，离开完整交互区域后才关闭', async () => {
    render(
      <ClearCanvasMenu counts={counts()} onClearCanvas={vi.fn()} onClearEmptyNodes={vi.fn()} />,
    );
    const trigger = screen.getByRole('button', { name: '清空' });

    await userEvent.hover(trigger);
    const card = screen.getByRole('menu');
    // 离开触发器但指针进入菜单：不在关闭延迟内收起。
    await userEvent.unhover(trigger);
    await userEvent.hover(card);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // 离开完整交互区域后按延迟关闭。
    await userEvent.unhover(card);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('两个动作显示本次候选数量', async () => {
    render(
      <ClearCanvasMenu
        counts={counts({ nodes: 4, edges: 3, groups: 1, emptyNodes: 2, emptyNodeEdges: 1 })}
        onClearCanvas={vi.fn()}
        onClearEmptyNodes={vi.fn()}
      />,
    );
    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('menuitem', { name: /清空画布/ })).toHaveTextContent(
      '4 节点 · 3 连线 · 1 组',
    );
    expect(screen.getByRole('menuitem', { name: /清空空节点/ })).toHaveTextContent(
      '2 节点 · 1 连线',
    );
  });

  it('没有可清理内容时禁用对应动作且不弹出空确认框', async () => {
    const onClearCanvas = vi.fn();
    const onClearEmptyNodes = vi.fn();
    render(
      <ClearCanvasMenu
        counts={{ nodes: 0, edges: 0, groups: 0, emptyNodes: 0, emptyNodeEdges: 0 }}
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={onClearEmptyNodes}
      />,
    );
    const trigger = screen.getByRole('button', { name: '清空' });
    expect(trigger).toBeDisabled();

    // 有节点但没有空节点时，只禁用“清空空节点”。
    cleanup();
    onClearCanvas.mockClear();
    render(
      <ClearCanvasMenu
        counts={{ nodes: 2, edges: 1, groups: 0, emptyNodes: 0, emptyNodeEdges: 0 }}
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={onClearEmptyNodes}
      />,
    );
    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByRole('menuitem', { name: /清空画布/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /清空空节点/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitem', { name: /清空空节点/ }));
    expect(onClearEmptyNodes).not.toHaveBeenCalled();
    expect(onClearCanvas).not.toHaveBeenCalled();
  });

  it('选择动作后先关闭菜单再交回调用方处理确认', async () => {
    const order: string[] = [];
    render(
      <ClearCanvasMenu
        counts={counts()}
        onClearCanvas={() => order.push('clear-canvas')}
        onClearEmptyNodes={() => order.push('clear-empty')}
      />,
    );
    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /清空空节点/ }));
    expect(order).toEqual(['clear-empty']);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.hover(screen.getByRole('button', { name: '清空' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /清空画布/ }));
    expect(order).toEqual(['clear-empty', 'clear-canvas']);
  });
});

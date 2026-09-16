import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasGroup } from '@multimodal-canvas/domain';

import { CanvasGroupLayer } from './CanvasGroupLayer';

afterEach(cleanup);

/**
 * 在 window 上派发指针事件。
 *
 * jsdom 没有可构造的 `PointerEvent`，而组件把 move/up 监听在 window 上，
 * 因此用通用事件加属性注入来覆盖真实监听路径。
 */
function pointerEvent(type: string, clientX = 0, clientY = 0, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY, pointerId, pointerType: 'mouse', isPrimary: true });
  return event;
}

/** 派发到 window，覆盖组件的 window 级监听。 */
function dispatchWindowPointer(type: string, clientX = 0, clientY = 0) {
  window.dispatchEvent(pointerEvent(type, clientX, clientY));
}

/** 派发到元素，覆盖 `onPointerDown` 处理器。 */
function dispatchPointer(target: Element, clientX: number, clientY: number, pointerId = 1) {
  target.dispatchEvent(pointerEvent('pointerdown', clientX, clientY, pointerId));
}

/** 构造组，坐标与尺寸单位为画布像素。 */
function group(overrides: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    id: 'g1',
    name: '场景 A',
    position: { x: 100, y: 50 },
    width: 640,
    height: 420,
    nodeIds: ['a', 'b'],
    ...overrides,
  };
}

describe('CanvasGroupLayer', () => {
  it('按视口缩放换算组的外框位置与尺寸，不读取 DOM 测量值', () => {
    const { container } = render(
      <CanvasGroupLayer groups={[group()]} viewport={{ x: 10, y: 20, zoom: 0.5 }} />,
    );
    const element = container.querySelector<HTMLElement>('.canvas-group');
    expect(element).toHaveStyle({
      transform: 'translate(60px, 45px)',
      width: '320px',
      height: '210px',
    });
  });

  it('没有任何组时不渲染区域层', () => {
    const { container } = render(
      <CanvasGroupLayer groups={[]} viewport={{ x: 0, y: 0, zoom: 1 }} />,
    );
    expect(container.querySelector('.canvas-group-layer')).toBeNull();
  });

  it('标题条显示组名与成员数量', () => {
    render(<CanvasGroupLayer groups={[group()]} viewport={{ x: 0, y: 0, zoom: 1 }} />);
    const name = screen.getByRole('button', { name: /场景 A/ });
    expect(name).toHaveTextContent('场景 A');
    expect(name).toHaveTextContent('2');
  });

  it('双击标题条进入重命名，回车提交新名称', async () => {
    const onRenameGroup = vi.fn();
    render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onRenameGroup={onRenameGroup}
      />,
    );
    await userEvent.dblClick(screen.getByRole('button', { name: /场景 A/ }));
    const input = screen.getByLabelText('组名称');
    await userEvent.clear(input);
    await userEvent.type(input, '新场景{Enter}');
    expect(onRenameGroup).toHaveBeenCalledWith('g1', '新场景');
  });

  it('空白名称不提交重命名', async () => {
    const onRenameGroup = vi.fn();
    render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onRenameGroup={onRenameGroup}
      />,
    );
    await userEvent.dblClick(screen.getByRole('button', { name: /场景 A/ }));
    await userEvent.clear(screen.getByLabelText('组名称'));
    await userEvent.keyboard('{Enter}');
    expect(onRenameGroup).not.toHaveBeenCalled();
  });

  it('选中后才显示解散与缩放手柄，解散不删除成员', async () => {
    const onDissolveGroup = vi.fn();
    const { container, rerender } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onDissolveGroup={onDissolveGroup}
      />,
    );
    expect(container.querySelectorAll('.canvas-group-handle')).toHaveLength(0);

    rerender(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        selectedGroupId="g1"
        onDissolveGroup={onDissolveGroup}
      />,
    );
    expect(container.querySelectorAll('.canvas-group-handle')).toHaveLength(4);
    screen.getByLabelText('解散组 场景 A').click();
    expect(onDissolveGroup).toHaveBeenCalledWith('g1');
  });

  it('拖拽标题条按画布像素给出位移，缩放视口下位移同样按比例换算', async () => {
    const onTranslateGroup = vi.fn();
    const onGroupInteractionStart = vi.fn();
    const { container } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 0.5 }}
        onTranslateGroup={onTranslateGroup}
        onGroupInteractionStart={onGroupInteractionStart}
      />,
    );
    const header = container.querySelector<HTMLElement>('.canvas-group-header')!;
    dispatchPointer(header, 0, 0);
    dispatchWindowPointer('pointermove', 40, 20);
    expect(onGroupInteractionStart).toHaveBeenCalledTimes(1);
    expect(onTranslateGroup).toHaveBeenCalledWith('g1', { x: 80, y: 40 });
    dispatchWindowPointer('pointermove', 70, 45);
    expect(onTranslateGroup).toHaveBeenLastCalledWith('g1', { x: 60, y: 50 });

    dispatchWindowPointer('pointerup');
    onTranslateGroup.mockClear();
    dispatchWindowPointer('pointermove', 80, 60);
    expect(onTranslateGroup).not.toHaveBeenCalled();
  });

  it('拖拽右下角只改变尺寸，不移动原点', () => {
    const onResizeGroup = vi.fn();
    const { container } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        selectedGroupId="g1"
        onResizeGroup={onResizeGroup}
      />,
    );
    const se = container.querySelector<HTMLElement>('.canvas-group-handle-se')!;
    dispatchPointer(se, 100, 100);
    dispatchWindowPointer('pointermove', 150, 130);
    expect(onResizeGroup).toHaveBeenLastCalledWith('g1', { width: 690, height: 450 });
  });

  it('拖拽左上角同时移动原点并保持右下角不动', () => {
    const onResizeGroup = vi.fn();
    const { container } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        selectedGroupId="g1"
        onResizeGroup={onResizeGroup}
      />,
    );
    const nw = container.querySelector<HTMLElement>('.canvas-group-handle-nw')!;
    dispatchPointer(nw, 0, 0, 2);
    dispatchWindowPointer('pointermove', -20, -10);
    // 左上角外扩：原点跟随位移，右下角保持在 (740, 470)。
    expect(onResizeGroup).toHaveBeenLastCalledWith('g1', {
      width: 660,
      height: 430,
      position: { x: 80, y: 40 },
    });
  });

  it('CSS 保证区域层不接收指针事件、手柄与标题条可交互', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.canvas-group-layer \{[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.canvas-group-header \{[^}]*pointer-events: auto;/);
    expect(css).toMatch(/\.canvas-group-handle \{[^}]*pointer-events: auto;/);
    expect(css).toMatch(/\.canvas-group-hint \{[^}]*pointer-events: none;/);
    const groupLevel = Number(css.match(/\.canvas-group-layer \{[^}]*z-index: (\d+);/)?.[1]);
    const nodeLevel = Number(
      css.match(/\.canvas-area \.react-flow__viewport \{[^}]*z-index: (\d+);/)?.[1],
    );
    expect(groupLevel).toBeLessThan(nodeLevel);
  });
});

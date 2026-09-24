import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasGroup } from '@multimodal-canvas/domain';

import { CanvasGroupLayer } from './CanvasGroupLayer';
import type { AssetFlowNode } from '../canvas-utils';

afterEach(cleanup);

/**
 * 在 window 上派发指针事件。
 *
 * jsdom 没有可构造的 `PointerEvent`，而组件把 move/up 监听在 window 上，
 * 因此用通用事件加属性注入来覆盖真实监听路径。
 */
function pointerEvent(type: string, clientX = 0, clientY = 0, pointerId = 1, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX,
    clientY,
    pointerId,
    button,
    pointerType: 'mouse',
    isPrimary: true,
  });
  return event;
}

/** 派发到 window，覆盖组件的 window 级监听。 */
function dispatchWindowPointer(type: string, clientX = 0, clientY = 0, pointerId = 1) {
  fireEvent(window, pointerEvent(type, clientX, clientY, pointerId));
}

/** 派发到元素，覆盖 `onPointerDown` 处理器。 */
function dispatchPointer(target: Element, clientX: number, clientY: number, pointerId = 1) {
  fireEvent(target, pointerEvent('pointerdown', clientX, clientY, pointerId));
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

  it('Popover 挂在组外，成员和视口更新不写入显式组尺寸', () => {
    const onResizeGroup = vi.fn();
    const onTranslateGroup = vi.fn();
    const props = {
      groups: [group()],
      selectedGroupId: 'g1',
      onResizeGroup,
      onTranslateGroup,
    };
    const { container, rerender } = render(
      <CanvasGroupLayer {...props} viewport={{ x: 0, y: 0, zoom: 1 }} />,
    );
    const card = screen.getByRole('region', { name: '场景 A分组信息' });
    expect(card.closest('.ant-popover')).toBeInTheDocument();
    expect(container).not.toContainElement(card);
    rerender(
      <CanvasGroupLayer
        {...props}
        nodes={[{ id: 'a', data: { mediaType: 'image' } }] as AssetFlowNode[]}
        viewport={{ x: 10, y: 20, zoom: 0.5 }}
      />,
    );
    expect(container.querySelector('.canvas-group')).toHaveStyle({
      transform: 'translate(60px, 45px)',
      width: '320px',
      height: '210px',
    });
    expect(within(card).getByText('图片').parentElement).toHaveTextContent('图片1');
    expect(onResizeGroup).not.toHaveBeenCalled();
    expect(onTranslateGroup).not.toHaveBeenCalled();
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

  it('选中后显示悬浮操作与缩放手柄，解散不删除成员', async () => {
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
    expect(screen.getByRole('region', { name: '场景 A分组信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^场景 A/ })).toHaveAttribute('aria-pressed', 'true');
    screen.getByLabelText('解散组 场景 A').click();
    expect(onDissolveGroup).toHaveBeenCalledWith('g1');
  });

  it('组内空白区域可选中并拖动，超过阈值后才捕获指针', () => {
    const onTranslateGroup = vi.fn();
    const onSelectGroup = vi.fn();
    const { container } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 0.5 }}
        onTranslateGroup={onTranslateGroup}
        onSelectGroup={onSelectGroup}
      />,
    );
    const area = container.querySelector<HTMLElement>('.canvas-group')!;
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(area, {
      setPointerCapture,
      hasPointerCapture: () => true,
      releasePointerCapture,
    });
    dispatchPointer(area, 120, 140, 2);
    expect(onSelectGroup).toHaveBeenCalledWith('g1');
    expect(setPointerCapture).not.toHaveBeenCalled();
    dispatchWindowPointer('pointermove', 150, 160, 2);
    expect(setPointerCapture).toHaveBeenCalledWith(2);
    expect(onTranslateGroup).toHaveBeenCalledWith('g1', { x: 60, y: 40 });
    dispatchWindowPointer('pointerup', 150, 160, 2);
    expect(releasePointerCapture).toHaveBeenCalledWith(2);
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
    dispatchWindowPointer('pointermove', -20, -10, 2);
    // 左上角外扩：原点跟随位移，右下角保持在 (740, 470)。
    expect(onResizeGroup).toHaveBeenLastCalledWith('g1', {
      width: 660,
      height: 430,
      position: { x: 80, y: 40 },
    });
  });

  it('直接从组名拖动，按缩放比例移动；单击与轻微抖动不产生历史', async () => {
    const onTranslateGroup = vi.fn();
    const onSelectGroup = vi.fn();
    const onGroupInteractionStart = vi.fn();
    render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 20, y: 30, zoom: 0.5 }}
        onTranslateGroup={onTranslateGroup}
        onSelectGroup={onSelectGroup}
        onGroupInteractionStart={onGroupInteractionStart}
      />,
    );
    const title = screen.getByRole('button', { name: /场景 A/ });
    await userEvent.click(title);
    expect(onSelectGroup).toHaveBeenCalledWith('g1');
    expect(onGroupInteractionStart).not.toHaveBeenCalled();
    dispatchPointer(title, 100, 100);
    dispatchWindowPointer('pointermove', 101, 101);
    expect(onGroupInteractionStart).not.toHaveBeenCalled();
    dispatchWindowPointer('pointermove', 140, 120);
    expect(onGroupInteractionStart).toHaveBeenCalledTimes(1);
    expect(onTranslateGroup).toHaveBeenLastCalledWith('g1', { x: 80, y: 40 });
    dispatchWindowPointer('pointercancel');
    dispatchWindowPointer('pointermove', 200, 200);
    expect(onTranslateGroup).toHaveBeenCalledTimes(1);
  });

  it('忽略右键与其他指针的移动，重命名输入不触发整组拖动', async () => {
    const onTranslateGroup = vi.fn();
    const { container } = render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onTranslateGroup={onTranslateGroup}
        onRenameGroup={vi.fn()}
      />,
    );
    const title = screen.getByRole('button', { name: /场景 A/ });
    fireEvent(title, pointerEvent('pointerdown', 10, 10, 1, 2));
    dispatchWindowPointer('pointermove', 40, 30);
    expect(onTranslateGroup).not.toHaveBeenCalled();
    dispatchPointer(title, 10, 10, 2);
    dispatchWindowPointer('pointermove', 40, 30, 1);
    dispatchWindowPointer('pointerup', 40, 30, 1);
    expect(onTranslateGroup).not.toHaveBeenCalled();
    dispatchWindowPointer('pointermove', 40, 30, 2);
    expect(onTranslateGroup).toHaveBeenCalledWith('g1', { x: 30, y: 20 });
    dispatchWindowPointer('pointerup', 40, 30, 2);
    await userEvent.dblClick(title);
    onTranslateGroup.mockClear();
    dispatchPointer(container.querySelector('input')!, 10, 10);
    dispatchWindowPointer('pointermove', 40, 30);
    expect(onTranslateGroup).not.toHaveBeenCalled();
  });

  it('悬浮卡片统计当前组的节点类型，并允许重命名与解散', async () => {
    const user = userEvent.setup();
    const onRenameGroup = vi.fn();
    const onDissolveGroup = vi.fn();
    const nodes = [
      { id: 'a', data: { mediaType: 'text' } },
      { id: 'b', data: { mediaType: 'image' } },
      { id: 'c', data: { mediaType: 'image' } },
      { id: 'outside', data: { mediaType: 'video' } },
    ] as AssetFlowNode[];
    render(
      <CanvasGroupLayer
        groups={[group({ nodeIds: ['a', 'b', 'c'] })]}
        nodes={nodes}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onRenameGroup={onRenameGroup}
        onDissolveGroup={onDissolveGroup}
      />,
    );
    const title = screen.getByRole('button', { name: /场景 A/ });
    await user.hover(title);
    const card = screen.getByRole('region', { name: '场景 A分组信息' });
    expect(card).toHaveTextContent('3 个节点');
    expect(within(card).getByText('文字').parentElement).toHaveTextContent('文字1');
    expect(within(card).getByText('图片').parentElement).toHaveTextContent('图片2');
    expect(within(card).getByText('视频').parentElement).toHaveTextContent('视频0');
    expect(within(card).getByText('音频').parentElement).toHaveTextContent('音频0');
    await user.click(within(card).getByRole('button', { name: '重命名组 场景 A' }));
    const input = screen.getByRole('textbox', { name: '组名称' });
    await user.clear(input);
    await user.type(input, '分镜组{Enter}');
    expect(onRenameGroup).toHaveBeenCalledWith('g1', '分镜组');
    await user.hover(screen.getByRole('button', { name: /场景 A/ }));
    await user.click(screen.getByRole('button', { name: '解散组 场景 A' }));
    expect(onDissolveGroup).toHaveBeenCalledWith('g1');
    expect(screen.queryByRole('region', { name: '场景 A分组信息' })).not.toBeInTheDocument();
  });

  it('悬浮栏的拖动手柄移动整组，操作按钮不触发拖动', async () => {
    const onTranslateGroup = vi.fn();
    render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        selectedGroupId="g1"
        onTranslateGroup={onTranslateGroup}
        onRenameGroup={vi.fn()}
      />,
    );
    dispatchPointer(screen.getByRole('button', { name: '拖动组 场景 A' }), 10, 10);
    dispatchWindowPointer('pointermove', 50, 40);
    expect(onTranslateGroup).toHaveBeenCalledWith('g1', { x: 40, y: 30 });
    dispatchWindowPointer('pointerup', 50, 40);
    onTranslateGroup.mockClear();
    dispatchPointer(screen.getByRole('button', { name: '重命名组 场景 A' }), 10, 10);
    dispatchWindowPointer('pointermove', 50, 40);
    expect(onTranslateGroup).not.toHaveBeenCalled();
  });

  it('键盘聚焦组名时显示空组信息，Escape 关闭卡片', async () => {
    const user = userEvent.setup();
    render(
      <CanvasGroupLayer groups={[group({ nodeIds: [] })]} viewport={{ x: 0, y: 0, zoom: 1 }} />,
    );
    await user.tab();
    expect(screen.getByRole('region', { name: '场景 A分组信息' })).toHaveTextContent('暂无成员');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '场景 A分组信息' })).not.toBeInTheDocument();
  });

  it('窗口失去焦点后终止拖动，重新进入窗口不会继续移动组', () => {
    const onTranslateGroup = vi.fn();
    render(
      <CanvasGroupLayer
        groups={[group()]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onTranslateGroup={onTranslateGroup}
      />,
    );
    dispatchPointer(screen.getByRole('button', { name: /场景 A/ }), 0, 0);
    dispatchWindowPointer('pointermove', 30, 20);
    fireEvent(window, new Event('blur'));
    dispatchWindowPointer('pointermove', 60, 40);
    expect(onTranslateGroup).toHaveBeenCalledTimes(1);
  });

  it('CSS 保证组内空白区域可交互，组仍位于节点与连线下方', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.canvas-group-layer \{[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.canvas-group-header \{[^}]*pointer-events: auto;/);
    expect(css).toMatch(/\.canvas-group-handle \{[^}]*pointer-events: auto;/);
    const groupCss = readFileSync(
      resolve(process.cwd(), 'src/workspace/canvas-group-hover-card.css'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(groupCss).toMatch(/\.canvas-group-layer \.canvas-group \{[^}]*pointer-events: auto;/);
    expect(groupCss).toMatch(/\.canvas-group-layer \.canvas-group \{[^}]*touch-action: none;/);
    const groupLevel = Number(css.match(/\.canvas-group-layer \{[^}]*z-index: (\d+);/)?.[1]);
    const nodeLevel = Number(
      css.match(/\.canvas-area \.react-flow__viewport \{[^}]*z-index: (\d+);/)?.[1],
    );
    expect(groupLevel).toBeLessThan(nodeLevel);
  });
});

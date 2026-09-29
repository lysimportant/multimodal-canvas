import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import { getConnectionDropNodePosition } from '../connection-utils';
import { CanvasContextMenu } from './CanvasContextMenu';

/** 使用实际画布命令契约，未设置的回调保持缺省。 */
function props(
  overrides: Partial<ComponentProps<typeof CanvasContextMenu>> = {},
): ComponentProps<typeof CanvasContextMenu> {
  return {
    target: {
      kind: 'canvas',
      clientPosition: { x: 40, y: 80 },
      flowPosition: { x: 200, y: 100 },
      returnFocusTo: null,
    },
    busy: false,
    canDeleteNode: true,
    onRunNode: vi.fn(),
    onCenterNode: vi.fn(),
    onNodeEnabledChange: vi.fn(),
    onDeleteNode: vi.fn(),
    onAddGenerateNode: vi.fn(),
    onAddConnectedGenerateNode: vi.fn(),
    onRequestUpload: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

/** 有提示词与可编辑图片的测试节点。 */
function node(data: Partial<AssetFlowNode['data']> = {}): AssetFlowNode {
  return {
    id: 'image-1',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: '产品图',
      mediaType: 'image',
      mode: 'generate',
      prompt: '白色背景',
      assetId: 'asset-1',
      contentUrl: '/assets/1',
      ...data,
    },
  };
}

/** 补齐 jsdom 的布局属性，让真实 Menu 识别可聚焦的可见项。 */
function exposeMenuItems() {
  for (const item of screen.getAllByRole('menuitem')) {
    Object.defineProperty(item, 'offsetParent', { configurable: true, value: document.body });
  }
}

afterEach(cleanup);

describe('CanvasContextMenu', () => {
  it('整行悬停显示功能简述，移开后关闭且不触发动作', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<CanvasContextMenu {...inputs} />);
    exposeMenuItems();
    const first = screen.getByRole('menuitem', { name: '创建文字生成节点' });
    await waitFor(() => expect(first).toHaveFocus());
    act(() => first.blur());
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    const item = screen.getByRole('menuitem', { name: '上传资源' });
    await user.hover(item);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('选择本地文件并加入项目资源');
    expect(item).toHaveAccessibleDescription('选择本地文件并加入项目资源');
    expect(item).not.toHaveAttribute('title');
    expect(tooltip.closest('.canvas-context-dropdown')).toBeNull();
    await user.unhover(item);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(inputs.onRequestUpload).not.toHaveBeenCalled();
    expect(inputs.onClose).not.toHaveBeenCalled();
  });

  it('方向键聚焦时显示对应简述，Enter 仍调用原创建动作', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<CanvasContextMenu {...inputs} />);
    exposeMenuItems();
    const first = screen.getByRole('menuitem', { name: '创建文字生成节点' });
    await waitFor(() => expect(first).toHaveFocus());
    await waitFor(() => expect(first).toHaveAccessibleDescription('在此处添加文字生成节点'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('在此处添加文字生成节点');

    await user.hover(first);
    fireEvent.keyDown(first, { key: 'ArrowDown', keyCode: 40, which: 40 });
    const next = screen.getByRole('menuitem', { name: '创建图片生成节点' });
    await waitFor(() => expect(next).toHaveFocus());
    await waitFor(() => expect(next).toHaveAccessibleDescription('在此处添加图片生成节点'));
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('在此处添加图片生成节点'),
    );
    expect(first).not.toHaveAttribute('aria-describedby');
    expect(next.querySelector('[tabindex], button, a')).toBeNull();

    fireEvent.keyDown(next, { key: 'Enter', keyCode: 13, which: 13 });
    expect(inputs.onAddGenerateNode).toHaveBeenCalledExactlyOnceWith('image', { x: 200, y: 100 });
    expect(inputs.onClose).toHaveBeenCalledExactlyOnceWith('action');
  });

  it('鼠标离开仍保留键盘焦点说明，失焦后才关闭', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<CanvasContextMenu {...inputs} />);
    exposeMenuItems();
    const item = screen.getByRole('menuitem', { name: '创建文字生成节点' });
    await waitFor(() => expect(item).toHaveFocus());
    await user.hover(item);
    await user.unhover(item);
    expect(item).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('在此处添加文字生成节点');
    act(() => item.blur());
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(item).not.toHaveAttribute('aria-describedby');
    expect(inputs.onAddGenerateNode).not.toHaveBeenCalled();
  });

  it('禁用项可悬停阅读说明，但不能被点击或 Enter 激活', async () => {
    const user = userEvent.setup();
    const inputs = props({ onUndoCanvas: vi.fn(), canUndo: false });
    render(<CanvasContextMenu {...inputs} />);
    const item = screen.getByRole('menuitem', { name: '撤销' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).not.toHaveAttribute('tabindex');
    await user.hover(item);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '撤销上一步画布操作（当前不可用）',
    );
    expect(item).toHaveAccessibleDescription('撤销上一步画布操作（当前不可用）');
    await user.click(item);
    fireEvent.keyDown(item, { key: 'Enter', keyCode: 13, which: 13 });
    fireEvent.keyDown(item, { key: ' ', keyCode: 32, which: 32 });
    expect(inputs.onUndoCanvas).not.toHaveBeenCalled();
    expect(inputs.onClose).not.toHaveBeenCalled();
  });

  it('键盘跳过禁用项，提示词说明不改变菜单的焦点顺序', async () => {
    const asset = node({ runStatus: 'running' });
    const inputs = props({
      target: { kind: 'node', node: asset, clientPosition: { x: 40, y: 80 }, returnFocusTo: null },
      onOpenRequestPrompt: vi.fn(),
      onEditImage: vi.fn(),
    });
    render(<CanvasContextMenu {...inputs} />);
    exposeMenuItems();
    const prompt = screen.getByRole('menuitem', { name: '提示词' });
    await waitFor(() => expect(prompt).toHaveFocus());
    await waitFor(() => expect(prompt).toHaveAccessibleDescription('查看提示词记录与资源分析'));
    fireEvent.keyDown(prompt, { key: 'ArrowDown', keyCode: 40, which: 40 });
    const center = screen.getByRole('menuitem', { name: '定位并居中节点' });
    await waitFor(() => expect(center).toHaveFocus());
    expect(screen.getByRole('menuitem', { name: '修改图片' })).not.toHaveAttribute('tabindex');
    expect(inputs.onRunNode).not.toHaveBeenCalled();
    expect(inputs.onEditImage).not.toHaveBeenCalled();
  });

  it('创建命令保留画布坐标，点击只调用对应动作并以 action 关闭', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<CanvasContextMenu {...inputs} />);
    const menu = await screen.findByRole('menu', { name: '画布操作' });
    expect(menu).toHaveClass('ant-dropdown-menu');
    await user.click(screen.getByRole('menuitem', { name: '创建视频生成节点' }));
    expect(inputs.onAddGenerateNode).toHaveBeenCalledExactlyOnceWith('video', { x: 200, y: 100 });
    expect(inputs.onClose).toHaveBeenCalledExactlyOnceWith('action');
    expect(inputs.onRequestUpload).not.toHaveBeenCalled();
  });

  it('保留历史、清理候选的禁用条件，不调用未接入的可选命令', async () => {
    const user = userEvent.setup();
    const inputs = props({
      onUndoCanvas: vi.fn(),
      onRedoCanvas: vi.fn(),
      onClearCanvas: vi.fn(),
      onClearEmptyNodes: vi.fn(),
      canUndo: false,
      canRedo: true,
      canClearCanvas: false,
      clearCounts: { nodes: 0, edges: 0, groups: 0, emptyNodes: 0, emptyNodeEdges: 0 },
    });
    render(<CanvasContextMenu {...inputs} />);
    for (const name of ['撤销', '清理空节点', '清空画布']) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      await user.click(item);
    }
    expect(inputs.onUndoCanvas).not.toHaveBeenCalled();
    expect(inputs.onClearCanvas).not.toHaveBeenCalled();
    expect(inputs.onClearEmptyNodes).not.toHaveBeenCalled();
    expect(inputs.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: '搜索' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '重做' }));
    expect(inputs.onRedoCanvas).toHaveBeenCalledOnce();
  });

  it.each(['queued', 'preparing', 'running', 'processing', 'cancel_requested'] as const)(
    '%s 节点不能重复运行，但仍能查看提示词记录',
    async (runStatus) => {
      const user = userEvent.setup();
      const asset = node({ runStatus });
      const inputs = props({
        target: {
          kind: 'node',
          node: asset,
          clientPosition: { x: 40, y: 80 },
          returnFocusTo: null,
        },
        onOpenRequestPrompt: vi.fn(),
        onEditImage: vi.fn(),
        canDeleteNode: false,
      });
      render(<CanvasContextMenu {...inputs} />);
      expect(screen.getByRole('menu', { name: '产品图节点操作' })).toBeInTheDocument();
      for (const name of ['开始生成', '生成到新节点', '修改图片', '删除节点']) {
        const item = screen.getByRole('menuitem', { name });
        expect(item).toHaveAttribute('aria-disabled', 'true');
        await user.click(item);
        fireEvent.keyDown(item, { key: 'Enter', keyCode: 13, which: 13 });
      }
      expect(inputs.onRunNode).not.toHaveBeenCalled();
      expect(inputs.onEditImage).not.toHaveBeenCalled();
      expect(inputs.onDeleteNode).not.toHaveBeenCalled();
      await user.click(screen.getByRole('menuitem', { name: '提示词' }));
      expect(inputs.onOpenRequestPrompt).toHaveBeenCalledWith(asset.id);
      expect(inputs.onClose).toHaveBeenCalledExactlyOnceWith('action');
    },
  );

  it('生成到新节点、启停及图片编辑仍按原契约返回参数', async () => {
    const user = userEvent.setup();
    const asset = node();
    const inputs = props({
      target: { kind: 'node', node: asset, clientPosition: { x: 40, y: 80 }, returnFocusTo: null },
      onEditImage: vi.fn(),
    });
    render(<CanvasContextMenu {...inputs} />);
    await user.click(screen.getByRole('menuitem', { name: '生成到新节点' }));
    expect(inputs.onRunNode).toHaveBeenCalledWith(asset, 'newNode');
    await user.click(screen.getByRole('menuitem', { name: '停用节点' }));
    expect(inputs.onNodeEnabledChange).toHaveBeenCalledWith(asset.id, false);
    await user.click(screen.getByRole('menuitem', { name: '修改图片' }));
    expect(inputs.onEditImage).toHaveBeenCalledWith(asset.id);
  });

  it.each(['source', 'target'] as const)(
    '悬空 %s 连线保留分组、说明、角色、模式及创建偏移',
    async (handleType) => {
      const user = userEvent.setup();
      const sourceNode = node();
      const flowPosition = { x: 500, y: 300 };
      const inputs = props({
        target: {
          kind: 'connection-drop',
          sourceNode,
          handleType,
          handleId: handleType === 'source' ? 'output:image' : 'input:firstFrame',
          flowPosition,
          clientPosition: { x: 70, y: 90 },
          returnFocusTo: null,
          groups: [
            {
              mediaType: 'video',
              label: '视频节点',
              options: [
                {
                  id: 'video-first',
                  mediaType: 'video',
                  role: 'firstFrame',
                  label: '首帧生视频',
                  description: '把图片作为起始画面',
                  videoMode: 'first_frame',
                },
              ],
            },
          ],
        },
      });
      render(<CanvasContextMenu {...inputs} />);
      expect(screen.getByText('视频节点')).toBeInTheDocument();
      const item = screen.getByRole('menuitem', { name: '首帧生视频' });
      expect(item).toHaveTextContent('把图片作为起始画面');
      await user.hover(item);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('把图片作为起始画面');
      expect(item).toHaveAccessibleDescription('把图片作为起始画面');
      await user.click(item);
      expect(inputs.onAddConnectedGenerateNode).toHaveBeenCalledWith({
        mediaType: 'video',
        position: getConnectionDropNodePosition(flowPosition, 'video', handleType),
        existingNodeId: sourceNode.id,
        handleType,
        handleId: handleType === 'source' ? 'output:image' : 'input:firstFrame',
        role: 'firstFrame',
        label: '首帧生视频',
        videoMode: 'first_frame',
      });
      expect(inputs.onClose).toHaveBeenCalledExactlyOnceWith('action');
    },
  );

  it('Escape 和外部点击使用不同关闭原因，不触发业务动作', async () => {
    const user = userEvent.setup();
    const inputs = props();
    const view = render(<CanvasContextMenu {...inputs} />);
    exposeMenuItems();
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: '创建文字生成节点' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(inputs.onClose).toHaveBeenCalledWith('escape');
    expect(inputs.onAddGenerateNode).not.toHaveBeenCalled();
    view.unmount();
    inputs.onClose = vi.fn();
    render(<CanvasContextMenu {...inputs} />);
    await user.click(document.body);
    expect(inputs.onClose).toHaveBeenCalledExactlyOnceWith('outside');
    expect(inputs.onRequestUpload).not.toHaveBeenCalled();
  });
});

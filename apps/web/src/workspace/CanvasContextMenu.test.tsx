import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

afterEach(cleanup);

describe('CanvasContextMenu', () => {
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
    // jsdom 没有布局盒；补齐菜单库判断可见性所需的布局属性。
    for (const item of screen.getAllByRole('menuitem')) {
      Object.defineProperty(item, 'offsetParent', { configurable: true, value: document.body });
    }
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

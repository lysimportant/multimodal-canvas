import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetFlowNode } from '../canvas-utils';
import {
  AssetNode,
  CanvasSelectionModeContext,
  NodeContentContext,
  NodeDeleteContext,
  NodeEnabledContext,
  NodeImageEditContext,
  NodeLabelChangeContext,
  NodePromptContext,
  NodeSelectionContext,
  NodeVideoRecreationContext,
} from './AssetNode';

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('./MobileWorkspacePanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./MobileWorkspacePanel')>()),
  useMobileWorkspace: () => viewport.mobile,
}));
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ transform: [0, 0, 0.5], width: 390, height: 844 }),
  useNodeConnections: () => [],
  useUpdateNodeInternals: () => () => {},
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));
vi.mock('./AssetPreview', () => ({ AssetPreview: () => <div>资源预览</div> }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  viewport.mobile = true;
  vi.stubEnv('NODE_ENV', 'development');
});

/** 所有写入都是测试回调；使用合成资产，不加载真实媒体或请求服务。 */
function fixture(overrides: Partial<AssetFlowNode['data']> = {}) {
  const props = {
    id: 'mobile-node',
    data: { label: '手机图片', mediaType: 'image', mode: 'generate', ...overrides },
    selected: false,
  } as NodeProps<AssetFlowNode>;
  const actions = {
    select: vi.fn(),
    rename: vi.fn(),
    enabled: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn().mockResolvedValue(undefined),
    saveText: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn(),
    edit: vi.fn(),
    recreate: vi.fn(),
  };
  const tree = (selectionMode = false) => (
    <CanvasSelectionModeContext.Provider value={selectionMode}>
      <NodeSelectionContext.Provider value={actions.select}>
        <NodeLabelChangeContext.Provider value={actions.rename}>
          <NodeEnabledContext.Provider value={actions.enabled}>
            <NodeDeleteContext.Provider value={actions.delete}>
              <NodeContentContext.Provider value={actions}>
                <NodePromptContext.Provider value={actions.prompt}>
                  <NodeImageEditContext.Provider value={actions.edit}>
                    <NodeVideoRecreationContext.Provider value={actions.recreate}>
                      <AssetNode {...props} />
                    </NodeVideoRecreationContext.Provider>
                  </NodeImageEditContext.Provider>
                </NodePromptContext.Provider>
              </NodeContentContext.Provider>
            </NodeDeleteContext.Provider>
          </NodeEnabledContext.Provider>
        </NodeLabelChangeContext.Provider>
      </NodeSelectionContext.Provider>
    </CanvasSelectionModeContext.Provider>
  );
  const view = render(tree());
  return { ...view, actions, tree };
}

describe('手机节点操作面板', () => {
  it('手机抽屉可打开销毁时间并提示 72 小时保留期', async () => {
    fixture({
      resultAsset: {
        assetId: 'retained-mobile',
        version: 1,
        metadata: {
          expiresAt: '2099-10-26T00:00:00Z',
          generatedAt: '2099-10-23T00:00:00Z',
        },
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    await userEvent.click(screen.getByRole('button', { name: '查看销毁时间：手机图片' }));
    const expiry = await screen.findByRole('group', { name: '资源销毁时间' });
    await waitFor(() => expect(within(expiry).getByText(/生成资源仅保留 72 小时/)).toBeVisible());
    expect(screen.getByRole('dialog', { name: '节点操作：手机图片' })).toBeVisible();
  });
  it('默认只保留一个 Antd 入口，悬停和选中不展开按钮条', async () => {
    const view = fixture();
    const node = view.container.querySelector<HTMLElement>('.flow-asset-node')!;
    const trigger = screen.getByRole('button', { name: '节点操作：手机图片' });
    expect(trigger).toHaveClass('ant-btn');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.style.getPropertyValue('--flow-node-inverse-zoom')).toBe('2');
    expect(within(node).getAllByRole('button')).toHaveLength(1);
    fireEvent.mouseEnter(node);
    expect(node.querySelector('.flow-node-header')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: '节点操作：手机图片' });
    expect(within(panel).getByRole('button', { name: '重命名节点：手机图片' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: '查看节点信息' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: '查看生成提示词：手机图片' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: '停用节点' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: '上传到节点：手机图片' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: '下载图片' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: '删除节点：手机图片' })).toBeEnabled();
    expect(within(panel).queryByRole('button', { name: '拖动移动节点' })).not.toBeInTheDocument();
    expect(within(panel).getByText('关闭面板后，按住卡片即可移动节点')).toBeVisible();
    expect(view.actions.select).not.toHaveBeenCalled();
  });

  it('键盘打开、Escape 和关闭按钮均可返回入口焦点', async () => {
    fixture();
    const trigger = screen.getByRole('button', { name: '节点操作：手机图片' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('dialog', { name: '节点操作：手机图片' });
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '重命名节点：手机图片' })).toHaveFocus(),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: '关闭节点操作：手机图片' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('保留禁用状态，并且切换状态、上传与删除只执行一次', async () => {
    const view = fixture({ runStatus: 'running' });
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    const panel = screen.getByRole('dialog', { name: '节点操作：手机图片' });
    const upload = within(panel).getByRole('button', { name: '上传到节点：手机图片' });
    expect(upload).toBeDisabled();
    await userEvent.click(upload);
    expect(view.actions.upload).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole('button', { name: '停用节点' }));
    expect(view.actions.enabled).toHaveBeenCalledExactlyOnceWith('mobile-node', false);
    await userEvent.click(within(panel).getByRole('button', { name: '删除节点：手机图片' }));
    expect(view.actions.delete).toHaveBeenCalledExactlyOnceWith('mobile-node');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '节点操作：手机图片' })).not.toBeInTheDocument(),
    );
  });

  it('已有图片的修改和分享可用，进入编辑前关闭抽屉', async () => {
    const view = fixture({
      runStatus: 'succeeded',
      resultAsset: {
        assetId: 'synthetic-image',
        version: 1,
        contentUrl: '/v1/assets/synthetic-image/versions/1/content',
        mimeType: 'image/png',
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    const panel = screen.getByRole('dialog', { name: '节点操作：手机图片' });
    expect(within(panel).getByRole('button', { name: '下载图片' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: /分享/ })).toBeEnabled();
    await userEvent.click(within(panel).getByRole('button', { name: '修改图片：手机图片' }));
    expect(view.actions.edit).toHaveBeenCalledExactlyOnceWith('mobile-node');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '节点操作：手机图片' })).not.toBeInTheDocument(),
    );
  });

  it('节点信息与重命名仍可打开并保存，面板事件不触发画布选择', async () => {
    const view = fixture();
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '节点信息' })).toBeVisible());
    await userEvent.click(screen.getByRole('button', { name: '关闭节点信息' }));
    await userEvent.click(screen.getByRole('button', { name: '重命名节点：手机图片' }));
    const input = screen.getByRole('textbox', { name: '编辑节点名称' });
    await userEvent.clear(input);
    await userEvent.type(input, '新的名称');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(view.actions.rename).toHaveBeenCalledExactlyOnceWith('mobile-node', '新的名称');
    expect(view.actions.select).not.toHaveBeenCalled();
  });

  it('桌面恢复原悬浮栏，返回手机以及进入框选均保持收起', async () => {
    const view = fixture();
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    viewport.mobile = false;
    view.rerender(view.tree());
    expect(screen.queryByRole('button', { name: '节点操作：手机图片' })).not.toBeInTheDocument();
    expect(
      view.container.querySelector('.flow-node-header.flow-node-floating-controls'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: '拖动移动节点' })).toBeInTheDocument();
    viewport.mobile = true;
    view.rerender(view.tree());
    expect(screen.getByRole('button', { name: '节点操作：手机图片' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: '节点操作：手机图片' }));
    view.rerender(view.tree(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '节点操作：手机图片' })).not.toBeInTheDocument();
    view.rerender(view.tree());
    expect(screen.getByRole('button', { name: '节点操作：手机图片' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

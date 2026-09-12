import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async () => {
  return {
    Handle: () => null,
    NodeResizer: ({
      isVisible,
      onResizeStart,
    }: {
      isVisible?: boolean;
      onResizeStart?: () => void;
    }) =>
      isVisible ? (
        <button type="button" onClick={onResizeStart}>
          开始调整尺寸
        </button>
      ) : null,
    Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  };
});

import type { NodeProps } from '@xyflow/react';
import type { AssetFlowNode } from '../canvas-utils';
import {
  AssetNode,
  NodeDeleteContext,
  NodeEnabledContext,
  NodeLabelChangeContext,
  NodeResizeStartContext,
  NodeRetryContext,
} from './AssetNode';

function makeNode(overrides: Partial<AssetFlowNode['data']> = {}): AssetFlowNode {
  return {
    id: 'node_1',
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      label: '文案生成',
      mediaType: 'text',
      mode: 'generate',
      enabled: true,
      ...overrides,
    },
  } as AssetFlowNode;
}

function renderNode(
  node: AssetFlowNode,
  onRetry?: (nodeId: string) => void | Promise<void>,
  onEnabled?: (nodeId: string, enabled: boolean) => void,
  onResizeStart?: (nodeId: string) => void,
  selected = false,
  onLabelChange?: (nodeId: string, label: string) => void,
  onDelete?: (nodeId: string) => void,
) {
  const props = {
    id: node.id,
    data: node.data,
    selected,
  } as NodeProps<AssetFlowNode>;
  return render(
    <NodeResizeStartContext.Provider value={onResizeStart ?? null}>
      <NodeLabelChangeContext.Provider value={onLabelChange ?? null}>
        <NodeEnabledContext.Provider value={onEnabled ?? null}>
          <NodeRetryContext.Provider value={onRetry ?? null}>
            <NodeDeleteContext.Provider value={onDelete ?? null}>
              <AssetNode {...props} />
            </NodeDeleteContext.Provider>
          </NodeRetryContext.Provider>
        </NodeEnabledContext.Provider>
      </NodeLabelChangeContext.Provider>
    </NodeResizeStartContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssetNode result presentation', () => {
  it('通过顶部名称按钮打开重命名对话框，Escape 取消草稿', async () => {
    const onLabelChange = vi.fn();
    const user = userEvent.setup();
    renderNode(makeNode(), undefined, undefined, undefined, false, onLabelChange);

    screen.getByRole('button', { name: '重命名节点：文案生成' }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: '重命名节点' });
    const input = screen.getByRole('textbox', { name: '编辑节点名称' });
    expect(dialog).toContainElement(input);
    await user.clear(input);
    await user.type(input, '尚未保存的名称');
    await user.keyboard('{Escape}');

    expect(onLabelChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重命名节点：文案生成' })).toBeInTheDocument();
  });

  it.each(['generate', 'transform'] as const)(
    '将 %s 节点名称和删除操作集中在唯一顶部栏',
    async (mode) => {
      const onDelete = vi.fn();
      const user = userEvent.setup();
      const { container } = renderNode(
        makeNode({ mode }),
        undefined,
        vi.fn(),
        undefined,
        false,
        vi.fn(),
        onDelete,
      );

      const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
      expect(toolbar).toHaveClass('flow-node-floating-controls');
      expect(toolbar).toContainElement(
        screen.getByRole('button', { name: '重命名节点：文案生成' }),
      );
      expect(toolbar.querySelector('.flow-node-label')).not.toBeNull();
      expect(toolbar.querySelector('.flow-node-actions')).not.toBeNull();
      expect(toolbar).toContainElement(screen.getByRole('button', { name: '拖动移动节点' }));
      expect(toolbar).toContainElement(screen.getByRole('button', { name: '查看节点信息' }));
      expect(toolbar).toContainElement(screen.getByRole('button', { name: '停用节点' }));
      expect(screen.getByRole('button', { name: '拖动移动节点' })).toHaveAttribute(
        'title',
        '拖动移动节点',
      );
      expect(screen.getByRole('button', { name: '查看节点信息' })).toHaveAttribute(
        'title',
        '查看节点信息',
      );
      expect(screen.getByRole('button', { name: '停用节点' })).toHaveAttribute('title', '停用节点');
      expect(screen.getByRole('button', { name: '删除节点：文案生成' })).toHaveAttribute(
        'title',
        '删除节点',
      );
      expect(container.querySelector('.flow-node-placeholder')).not.toContainElement(toolbar);
      expect(screen.getAllByRole('button', { name: '删除节点：文案生成' })).toHaveLength(1);
      expect(screen.getByRole('button', { name: '停用节点' }).querySelector('svg')).toHaveAttribute(
        'width',
        '18',
      );
      expect(
        screen.getByRole('button', { name: '删除节点：文案生成' }).querySelector('svg'),
      ).toHaveAttribute('width', '18');
      await user.click(screen.getByRole('button', { name: '删除节点：文案生成' }));
      expect(onDelete).toHaveBeenCalledExactlyOnceWith('node_1');
    },
  );

  it('点击节点名称后在对话框中保存新名称', async () => {
    const onLabelChange = vi.fn();
    const user = userEvent.setup();
    renderNode(makeNode(), undefined, undefined, undefined, false, onLabelChange);

    await user.click(screen.getByRole('button', { name: '重命名节点：文案生成' }));
    const input = await screen.findByRole('textbox', { name: '编辑节点名称' });
    await user.clear(input);
    await user.type(input, '新的节点名称');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onLabelChange).toHaveBeenCalledWith('node_1', '新的节点名称');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('信息按钮打开介绍对话框', async () => {
    const user = userEvent.setup();
    renderNode(makeNode({ stale: true }), undefined, vi.fn(), undefined, false, vi.fn(), vi.fn());

    await user.click(screen.getByRole('button', { name: '查看节点信息' }));
    const dialog = await screen.findByRole('dialog', { name: '节点信息' });
    expect(dialog).toHaveTextContent('生成文字节点，根据提示词和上游输入生成文字。');
    expect(dialog).toHaveTextContent('文案生成');
    expect(dialog).toHaveTextContent('上游已变更，节点待更新');
    await user.click(screen.getByRole('button', { name: '关闭节点信息' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('exposes a visible enable toggle and reports the next state', async () => {
    const onEnabled = vi.fn();
    const user = userEvent.setup();
    renderNode(makeNode(), undefined, onEnabled);

    const toggle = screen.getByRole('button', { name: '停用节点' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    expect(onEnabled).toHaveBeenCalledWith('node_1', false);
  });

  it('labels an already disabled node as ready to enable', () => {
    renderNode(makeNode({ enabled: false }), undefined, vi.fn());

    expect(screen.getByRole('button', { name: '启用节点' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('renders a real text result inside a succeeded node', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('真实生成文案\n第二行', { status: 200 })),
    );
    renderNode(
      makeNode({
        runStatus: 'succeeded',
        runProgress: 100,
        resultAsset: {
          assetId: 'asset_text',
          contentUrl: 'https://assets.example/result.txt',
          mimeType: 'text/plain',
          sizeBytes: 30,
        },
      }),
    );

    const content = await screen.findByText((_, element) => element?.tagName === 'PRE');
    expect(content.textContent).toBe('真实生成文案\n第二行');
    await waitFor(() => expect(screen.getByLabelText('运行成功')).toBeInTheDocument());
  });

  it('shows progress instead of a success placeholder while a run is active', () => {
    renderNode(makeNode({ runStatus: 'processing', runProgress: 48 }));

    expect(screen.getByRole('status')).toHaveTextContent('处理中');
    expect(screen.getByLabelText('运行进度 48%')).toHaveTextContent('48%');
    expect(screen.queryByLabelText('运行成功')).not.toBeInTheDocument();
  });

  it('shows the generation error and invokes the optional retry callback', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderNode(makeNode({ runStatus: 'failed', runError: '上游模型拒绝了请求' }), onRetry);

    expect(screen.getByRole('alert')).toHaveTextContent('上游模型拒绝了请求');
    expect(screen.getByLabelText('运行失败')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试生成' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith('node_1'));
  });

  it('does not mask a succeeded run whose artifact URL is missing', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderNode(
      makeNode({
        runStatus: 'succeeded',
        resultAsset: { assetId: 'remote_missing', mimeType: 'text/plain' },
      }),
      onRetry,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('产物不存在或已失效');
    expect(screen.getByLabelText('产物不可用')).toBeInTheDocument();
    expect(screen.queryByLabelText('运行成功')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试生成' }));
    expect(onRetry).toHaveBeenCalledWith('node_1');
  });

  it('reconstructs the protected version URL when public run data omits contentUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('已回显的结果', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderNode(
      makeNode({
        runStatus: 'succeeded',
        resultAsset: {
          assetId: 'asset_archived',
          version: 2,
          mimeType: 'text/plain',
        },
      }),
    );

    expect(await screen.findByText((_, element) => element?.tagName === 'PRE')).toHaveTextContent(
      '已回显的结果',
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/v1/assets/asset_archived/versions/2/content',
    );
  });

  it('replaces the success indicator when a media artifact fails to load', async () => {
    const { container } = renderNode(
      makeNode({
        mediaType: 'image',
        runStatus: 'succeeded',
        resultAsset: {
          assetId: 'asset_image',
          contentUrl: 'https://assets.example/missing.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
        },
      }),
    );

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(await screen.findByRole('alert')).toHaveTextContent('图片加载失败');
    await waitFor(() => expect(screen.getByLabelText('产物加载失败')).toBeInTheDocument());
    expect(screen.queryByLabelText('运行成功')).not.toBeInTheDocument();
  });

  it('keeps media result previews inside the user-controlled node size', () => {
    const { container } = renderNode(
      makeNode({
        mediaType: 'image',
        runStatus: 'succeeded',
        resultAsset: {
          assetId: 'asset_image',
          contentUrl: 'https://assets.example/result.png',
          mimeType: 'image/png',
        },
      }),
      undefined,
      undefined,
      undefined,
      true,
    );

    const preview = container.querySelector('.flow-node-preview');
    expect(preview).not.toHaveClass('is-initial-size-limited');

    expect(preview).not.toHaveClass('is-initial-size-limited');
  });

  it('does not change preview sizing when a new result arrives', () => {
    const first = makeNode({
      mediaType: 'image',
      runStatus: 'succeeded',
      resultAsset: {
        assetId: 'asset_image_1',
        contentUrl: 'https://assets.example/result-1.png',
        mimeType: 'image/png',
      },
    });
    const view = renderNode(first, undefined, undefined, undefined, true);
    const preview = view.container.querySelector('.flow-node-preview');
    expect(preview).not.toHaveClass('is-initial-size-limited');

    expect(preview).not.toHaveClass('is-initial-size-limited');

    const next = makeNode({
      mediaType: 'image',
      runStatus: 'succeeded',
      resultAsset: {
        assetId: 'asset_image_2',
        contentUrl: 'https://assets.example/result-2.png',
        mimeType: 'image/png',
      },
    });
    const nextProps = {
      id: next.id,
      data: next.data,
      selected: true,
    } as NodeProps<AssetFlowNode>;
    view.rerender(
      <NodeRetryContext.Provider value={null}>
        <AssetNode {...nextProps} />
      </NodeRetryContext.Provider>,
    );
    expect(view.container.querySelector('.flow-node-preview')).not.toHaveClass(
      'is-initial-size-limited',
    );
  });

  it('keeps the ungenerated state distinct from missing source content', () => {
    const { rerender } = renderNode(makeNode());
    expect(screen.getByText('尚未生成')).toBeInTheDocument();

    const sourceNode = makeNode({ mode: 'source' });
    const props = {
      id: sourceNode.id,
      data: sourceNode.data,
      selected: false,
    } as NodeProps<AssetFlowNode>;
    rerender(
      <NodeRetryContext.Provider value={null}>
        <AssetNode {...props} />
      </NodeRetryContext.Provider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('产物不存在或已失效');
  });
});

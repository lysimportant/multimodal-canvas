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
  NodeEnabledContext,
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
) {
  const props = {
    id: node.id,
    data: node.data,
    selected,
  } as NodeProps<AssetFlowNode>;
  return render(
    <NodeResizeStartContext.Provider value={onResizeStart ?? null}>
      <NodeEnabledContext.Provider value={onEnabled ?? null}>
        <NodeRetryContext.Provider value={onRetry ?? null}>
          <AssetNode {...props} />
        </NodeRetryContext.Provider>
      </NodeEnabledContext.Provider>
    </NodeResizeStartContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssetNode result presentation', () => {
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
        resultAsset: { assetId: 'asset_missing', mimeType: 'text/plain' },
      }),
      onRetry,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('产物不存在或已失效');
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

  it('limits an initial media result to 800 by 600 until resizing begins', () => {
    const onResizeStart = vi.fn();
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
      onResizeStart,
      true,
    );

    const preview = container.querySelector('.flow-node-preview');
    expect(preview).toHaveClass('is-initial-size-limited');

    fireEvent.click(screen.getByRole('button', { name: '开始调整尺寸' }));

    expect(onResizeStart).toHaveBeenCalledWith('node_1');
    expect(preview).not.toHaveClass('is-initial-size-limited');
  });

  it('applies the initial preview limit again when a new result arrives', () => {
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
    expect(preview).toHaveClass('is-initial-size-limited');

    fireEvent.click(screen.getByRole('button', { name: '开始调整尺寸' }));
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
    expect(view.container.querySelector('.flow-node-preview')).toHaveClass(
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

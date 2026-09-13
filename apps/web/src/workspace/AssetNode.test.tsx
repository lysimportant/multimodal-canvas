import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 用于验证悬浮栏在不同缩放级别下提供反向缩放值。 */
const viewportMock = vi.hoisted(() => ({ zoom: 1 }));

vi.mock('@xyflow/react', async () => {
  return {
    useViewport: () => ({ x: 0, y: 0, zoom: viewportMock.zoom }),
    useEdges: () => [],
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

vi.mock('./node-asset-download', () => ({ fetchNodeAssetDownload: vi.fn() }));
vi.mock('../export-utils', () => ({ downloadProjectExport: vi.fn() }));

import type { NodeProps } from '@xyflow/react';
import type { AssetFlowNode } from '../canvas-utils';
import { downloadProjectExport } from '../export-utils';
import { fetchNodeAssetDownload } from './node-asset-download';
import {
  AssetNode,
  NodeDeleteContext,
  NodeEnabledContext,
  NodeLabelChangeContext,
  NodeQuickEditorIdContext,
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
  vi.clearAllMocks();
  viewportMock.zoom = 1;
});

describe('AssetNode result presentation', () => {
  it.each([0.25, 0.5, 1, 2])('文本悬浮卡片抵消 %s 倍画布缩放', (zoom) => {
    viewportMock.zoom = zoom;
    renderNode(makeNode());
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(toolbar.style.getPropertyValue('--flow-node-zoom')).toBe(String(zoom));
    expect(toolbar.style.getPropertyValue('--flow-node-inverse-zoom')).toBe(String(1 / zoom));
  });

  it('悬浮栏一开始就同时显示图标和功能简述', () => {
    renderNode(makeNode(), undefined, vi.fn(), undefined, false, vi.fn(), vi.fn());
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(toolbar).not.toHaveClass('is-spacious');
    expect(screen.getByRole('button', { name: '重命名节点：文案生成' })).toHaveTextContent(
      '重命名',
    );
    expect(screen.getByRole('button', { name: '拖动移动节点' })).toHaveTextContent('移动');
    expect(screen.getByRole('button', { name: '查看节点信息' })).toHaveTextContent('信息');
  });

  it.each(['image', 'video'] as const)('没有内容的 %s 节点禁用下载按钮', (mediaType) => {
    renderNode(makeNode({ mediaType }));
    const button = screen.getByRole('button', {
      name: mediaType === 'image' ? '下载图片' : '下载视频',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', '暂无可下载内容');
  });

  it.each(['text', 'audio'] as const)('%s 节点不增加下载按钮', (mediaType) => {
    renderNode(makeNode({ mediaType }));
    expect(screen.queryByRole('button', { name: /^下载/ })).not.toBeInTheDocument();
  });

  it('视频回显后节点预览不拦截拖拽', () => {
    const { container } = renderNode(
      makeNode({
        mediaType: 'video',
        mimeType: 'video/mp4',
        assetId: 'video',
        contentUrl: 'https://assets.example/video.mp4',
      }),
    );
    expect(container.querySelector('.artifact-preview-video-shell')).not.toHaveClass('nodrag');
    expect(container.querySelector('video')).not.toHaveAttribute('controls');
  });

  it('图片节点输入编辑器打开前点击不预览，打开后再次点击才预览', async () => {
    const node = makeNode({
      mediaType: 'image',
      mode: 'generate',
      assetId: 'image',
      mimeType: 'image/png',
      contentUrl: 'https://assets.example/image.png',
    });
    const view = renderNode(node);
    await userEvent.click(screen.getByRole('img'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(
      <NodeQuickEditorIdContext.Provider value={node.id}>
        <AssetNode
          {...({ id: node.id, data: node.data, selected: true } as NodeProps<AssetFlowNode>)}
        />
      </NodeQuickEditorIdContext.Provider>,
    );
    await userEvent.click(screen.getByRole('img'));
    expect(await screen.findByRole('dialog', { name: '文案生成' })).toBeInTheDocument();
  });

  it.each([null, 'another-node'])(
    '多选中的图片不能通过选中状态绕过编辑器：%s',
    async (editorId) => {
      const node = makeNode({
        mediaType: 'image',
        assetId: 'image',
        mimeType: 'image/png',
        contentUrl: 'https://assets.example/image.png',
      });
      render(
        <NodeQuickEditorIdContext.Provider value={editorId}>
          <AssetNode
            {...({ id: node.id, data: node.data, selected: true } as NodeProps<AssetFlowNode>)}
          />
        </NodeQuickEditorIdContext.Provider>,
      );
      await userEvent.click(screen.getByRole('img'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('来源图片首击打开输入编辑器，再次点击才预览', async () => {
    const node = {
      ...makeNode({
        mediaType: 'image',
        mode: 'source',
        assetId: 'image',
        mimeType: 'image/png',
        contentUrl: 'https://assets.example/image.png',
      }),
      id: 'source-image',
    };
    const view = renderNode(node);
    await userEvent.click(screen.getByRole('img'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(
      <NodeQuickEditorIdContext.Provider value={node.id}>
        <AssetNode
          {...({ id: node.id, data: node.data, selected: true } as NodeProps<AssetFlowNode>)}
        />
      </NodeQuickEditorIdContext.Provider>,
    );
    await userEvent.click(screen.getByRole('img'));
    expect(await screen.findByRole('dialog', { name: '文案生成' })).toBeInTheDocument();
  });

  it('来源视频仍保持直接点击预览', async () => {
    renderNode(
      makeNode({
        mediaType: 'video',
        mode: 'source',
        assetId: 'video',
        mimeType: 'video/mp4',
        contentUrl: 'https://assets.example/video.mp4',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: '预览视频：文案生成' }));
    expect(await screen.findByRole('dialog', { name: '文案生成' })).toBeInTheDocument();
  });

  it.each([
    {
      label: '来源图片',
      data: {
        mode: 'source' as const,
        mediaType: 'image' as const,
        assetId: 'source-image',
        contentUrl: '/v1/assets/source-image/content',
      },
      assetId: 'source-image',
      url: '/v1/assets/source-image/content',
      buttonName: '下载图片',
    },
    {
      label: '指定结果版本',
      data: {
        mediaType: 'video' as const,
        resultAsset: { assetId: 'result-video', version: 3, mimeType: 'video/mp4' },
      },
      assetId: 'result-video',
      url: '/v1/assets/result-video/versions/3/content',
      buttonName: '下载视频',
    },
    {
      label: '手动替换内容',
      data: {
        mediaType: 'image' as const,
        manualOutput: true,
        assetId: 'manual-image',
        contentUrl: '/v1/assets/manual-image/content',
        resultAsset: { assetId: 'old-image', version: 1 },
      },
      assetId: 'manual-image',
      url: '/v1/assets/manual-image/content',
      buttonName: '下载图片',
    },
  ])('下载 $label 与当前回显使用相同资产地址', async ({ data, assetId, url, buttonName }) => {
    const download = { blob: new Blob(['media']), filename: '下载.png' };
    vi.mocked(fetchNodeAssetDownload).mockResolvedValueOnce(download);
    renderNode(makeNode(data));

    await userEvent.click(screen.getByRole('button', { name: buttonName }));
    await waitFor(() => expect(downloadProjectExport).toHaveBeenCalledWith(download));
    expect(fetchNodeAssetDownload).toHaveBeenCalledWith(
      expect.objectContaining({ id: assetId, contentUrl: url }),
      expect.any(AbortSignal),
    );
  });

  it('下载失败显示错误并允许重试', async () => {
    vi.mocked(fetchNodeAssetDownload).mockRejectedValueOnce(new Error('下载失败（403），请重试'));
    renderNode(
      makeNode({
        mediaType: 'image',
        assetId: 'image',
        contentUrl: 'https://assets.example/image.png',
      }),
    );
    const button = screen.getByRole('button', { name: '下载图片' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('下载失败（403），请重试');
    expect(button).toBeEnabled();
    expect(downloadProjectExport).not.toHaveBeenCalled();

    vi.mocked(fetchNodeAssetDownload).mockResolvedValueOnce({
      blob: new Blob(['media']),
      filename: 'image.png',
    });
    await userEvent.click(button);
    await waitFor(() => expect(downloadProjectExport).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('下载期间防止重复请求，切换结果取消旧下载', async () => {
    let resolveDownload!: (value: { blob: Blob; filename: string }) => void;
    vi.mocked(fetchNodeAssetDownload).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const node = makeNode({
      mediaType: 'video',
      assetId: 'video',
      contentUrl: 'https://assets.example/old.mp4',
    });
    const view = renderNode(node);
    const button = screen.getByRole('button', { name: '下载视频' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在准备下载');
    await userEvent.click(button);
    expect(fetchNodeAssetDownload).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(fetchNodeAssetDownload).mock.calls[0][1];

    view.rerender(
      <AssetNode
        {...({
          id: node.id,
          data: { ...node.data, contentUrl: 'https://assets.example/new.mp4' },
          selected: true,
        } as NodeProps<AssetFlowNode>)}
      />,
    );
    expect(signal?.aborted).toBe(true);
    resolveDownload({ blob: new Blob(['old']), filename: 'old.mp4' });
    await waitFor(() => expect(screen.getByRole('button', { name: '下载视频' })).toBeEnabled());
    expect(downloadProjectExport).not.toHaveBeenCalled();
  });

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

  it('将生成节点名称和删除操作集中在唯一顶部栏', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    const { container } = renderNode(
      makeNode({ mode: 'generate' }),
      undefined,
      vi.fn(),
      undefined,
      false,
      vi.fn(),
      onDelete,
    );

    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(toolbar).toHaveClass('flow-node-floating-controls');
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '重命名节点：文案生成' }));
    expect(toolbar.querySelector('.flow-node-label')).toBeNull();
    expect(toolbar.querySelector('.flow-node-actions')).toBeNull();
    expect(
      screen.getByRole('button', { name: '重命名节点：文案生成' }).querySelector('svg'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: '重命名节点：文案生成' })).toHaveTextContent(
      '重命名',
    );
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '拖动移动节点' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '查看节点信息' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '停用节点' }));
    expect(screen.getByRole('button', { name: '拖动移动节点' })).toHaveTextContent('移动');
    expect(screen.getByRole('button', { name: '查看节点信息' })).toHaveTextContent('信息');
    expect(screen.getByRole('button', { name: '停用节点' })).toHaveTextContent('停用');
    expect(screen.getByRole('button', { name: '删除节点：文案生成' })).toHaveTextContent('删除');
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
  });

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

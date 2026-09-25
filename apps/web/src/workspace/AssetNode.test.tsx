import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 用于验证悬浮栏在不同缩放级别下提供反向缩放值。 */
const viewportMock = vi.hoisted(() => ({ zoom: 1 }));
const updateNodeInternalsMock = vi.hoisted(() => vi.fn());

vi.mock('@xyflow/react', async () => {
  return {
    useViewport: () => ({ x: 0, y: 0, zoom: viewportMock.zoom }),
    useEdges: () => [],
    useUpdateNodeInternals: () => updateNodeInternalsMock,
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
  NodePromptContext,
  NodeQuickEditorIdContext,
  NodeResizeStartContext,
  NodeRetryContext,
  NodeSelectionContext,
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
  it('旧结果与新执行分别显示计时，手动版本不继承旧生成耗时', async () => {
    const base = makeNode({
      assetId: 'asset-1',
      contentUrl: '/v1/assets/asset-1/versions/1/content',
      runStatus: 'running',
      nodeTiming: { nodeId: 'node_1', startedAt: new Date(Date.now() - 2_000).toISOString() },
      resultTiming: {
        nodeId: 'node_1',
        startedAt: '2026-09-16T10:00:00.000Z',
        finishedAt: '2026-09-16T10:00:12.400Z',
        outcome: 'succeeded',
      },
    });
    const view = renderNode(base);
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(within(toolbar).getByText('12秒')).toBeInTheDocument();
    expect(within(toolbar).getByText('耗时')).toBeInTheDocument();
    expect(within(toolbar).queryByText('结果耗时')).not.toBeInTheDocument();
    expect(within(toolbar).getByText('当前执行')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    const info = within(screen.getByRole('dialog', { name: '节点信息' }));
    expect(info.getByText('耗时')).toBeInTheDocument();
    expect(info.getByText('12秒')).toBeInTheDocument();
    expect(info.getByText('当前执行')).toBeInTheDocument();
    view.rerender(
      <AssetNode
        {...({
          id: base.id,
          data: { ...base.data, manualOutput: true },
          selected: false,
        } as NodeProps<AssetFlowNode>)}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    expect(screen.queryByText('12秒')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('dialog', { name: '节点信息' })).getByText('未记录'),
    ).toBeInTheDocument();
  });

  it('新生成失败仍展示旧结果，同时在信息面板保留失败原因和旧结果耗时', async () => {
    const { container } = renderNode(
      makeNode({
        mediaType: 'image',
        runStatus: 'failed',
        runError: '供应商超时，未重发请求',
        resultAsset: {
          assetId: 'old-image',
          version: 1,
          contentUrl: 'https://example.test/old.png',
          mimeType: 'image/png',
        },
        resultTiming: {
          nodeId: 'node_1',
          startedAt: '2026-09-17T00:00:00.000Z',
          finishedAt: '2026-09-17T00:00:12.400Z',
          outcome: 'succeeded',
        },
      }),
    );
    expect(container.querySelector('.flow-node-preview img')).toHaveAttribute(
      'src',
      'https://example.test/old.png',
    );
    expect(screen.getByLabelText('运行失败')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    expect(screen.getByRole('alert')).toHaveTextContent('供应商超时，未重发请求');
    expect(
      within(screen.getByRole('dialog', { name: '节点信息' })).getByText('12秒'),
    ).toBeInTheDocument();
  });

  it('未展示的运行节点不订阅执行时钟，悬浮后开始并在离开后释放', () => {
    const interval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { container } = renderNode(
      makeNode({
        runStatus: 'running',
        nodeTiming: { nodeId: 'node_1', startedAt: new Date().toISOString() },
      }),
    );
    expect(interval).not.toHaveBeenCalled();
    fireEvent.mouseEnter(container.querySelector('.flow-asset-node')!);
    expect(interval).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(container.querySelector('.flow-asset-node')!);
    expect(clearInterval).toHaveBeenCalledTimes(1);
    interval.mockRestore();
    clearInterval.mockRestore();
  });

  it('悬浮卡片直接打开提示词，不打开输入编辑器，信息面板仍保留同一入口', async () => {
    const openPrompt = vi.fn();
    const selectNode = vi.fn();
    const node = makeNode();
    render(
      <NodePromptContext.Provider value={openPrompt}>
        <NodeSelectionContext.Provider value={selectNode}>
          <AssetNode {...({ id: node.id, data: node.data } as NodeProps<AssetFlowNode>)} />
        </NodeSelectionContext.Provider>
      </NodePromptContext.Provider>,
    );
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    await userEvent.click(
      within(toolbar).getByRole('button', { name: '查看生成提示词：文案生成' }),
    );
    expect(openPrompt).toHaveBeenLastCalledWith(node.id);
    expect(selectNode).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(toolbar).getByLabelText('节点生成耗时')).toHaveTextContent('未记录');

    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: '节点信息' })).getByRole('button', {
        name: '查看生成提示词：文案生成',
      }),
    );
    expect(openPrompt).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(`#node-prompt-trigger-${node.id}`)).toHaveLength(1);
  });

  it.each([0.25, 0.5, 1, 2])('文本悬浮卡片抵消 %s 倍画布缩放', (zoom) => {
    viewportMock.zoom = zoom;
    renderNode(makeNode());
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(toolbar.style.getPropertyValue('--flow-node-zoom')).toBe(String(zoom));
    expect(toolbar.style.getPropertyValue('--flow-node-inverse-zoom')).toBe(String(1 / zoom));
  });

  it('悬浮栏超出画布左上角时只平移操作栏，不写入节点尺寸', () => {
    const node = makeNode();
    const view = render(
      <div className="react-flow">
        <div className="react-flow__node">
          <AssetNode {...({ id: node.id, data: node.data } as NodeProps<AssetFlowNode>)} />
        </div>
      </div>,
    );
    const canvas = view.container.querySelector('.react-flow')!;
    const asset = view.container.querySelector<HTMLElement>('.flow-asset-node')!;
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 260,
      top: 50,
      right: 1366,
      bottom: 900,
      width: 1106,
      height: 850,
    } as DOMRect);
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue({
      left: 140,
      top: 30,
      right: 940,
      bottom: 76,
      width: 800,
      height: 46,
    } as DOMRect);
    fireEvent.mouseEnter(asset);
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('128px');
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('28px');
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-max-width')).toBe('1090px');
    expect(asset.style.width).toBe('');
    expect(asset.style.height).toBe('');
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

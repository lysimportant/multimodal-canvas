import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { CanvasPerformanceContext } from './canvas-render-detail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 模拟视口外部存储，真实触发订阅更新而不是依赖父组件重新渲染。 */
const viewportMock = vi.hoisted(() => ({
  x: 0,
  y: 0,
  zoom: 1,
  listeners: new Set<() => void>(),
  /** 注册视口变更监听，返回卸载清理函数。 */
  subscribe(listener: () => void) {
    viewportMock.listeners.add(listener);
    return () => {
      viewportMock.listeners.delete(listener);
    };
  },
}));
const updateNodeInternalsMock = vi.hoisted(() => vi.fn());
const nodeConnectionsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('@xyflow/react', async () => {
  const { useRef, useSyncExternalStore } = await import('react');
  /** 按 selector 与 equalityFn 缓存快照，复现 React Flow 的订阅语义。 */
  function useStoreMock<T>(
    selector: (state: { transform: [number, number, number]; width: number; height: number }) => T,
    equalityFn: (previous: T, next: T) => boolean = Object.is,
  ): T {
    const selected = useRef({
      value: selector({
        transform: [viewportMock.x, viewportMock.y, viewportMock.zoom],
        width: 1280,
        height: 720,
      }),
    });
    const getSnapshot = () => {
      const value = selector({
        transform: [viewportMock.x, viewportMock.y, viewportMock.zoom],
        width: 1280,
        height: 720,
      });
      if (!equalityFn(selected.current.value, value)) selected.current.value = value;
      return selected.current.value;
    };
    return useSyncExternalStore(viewportMock.subscribe, getSnapshot, getSnapshot);
  }
  return {
    useStore: useStoreMock,
    useViewport: () => {
      const [x, y, zoom] = useStoreMock(
        (state) => state.transform,
        (previous, next) => previous.every((value, index) => value === next[index]),
      );
      return { x, y, zoom };
    },
    useEdges: () => [],
    useNodeConnections: nodeConnectionsMock,
    useUpdateNodeInternals: () => updateNodeInternalsMock,
    Handle: ({
      id,
      type,
      position,
      className,
    }: {
      id: string;
      type: string;
      position: string;
      className?: string;
    }) => (
      <span
        className={'react-flow__handle ' + (className ?? '')}
        data-handleid={id}
        data-handletype={type}
        data-handlepos={position}
      />
    ),
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
import * as thumbnails from './image-thumbnail-cache';
import {
  AssetNode,
  CanvasSelectionModeContext,
  NodeContentContext,
  NodeImageEditContext,
  NodeDeleteContext,
  NodeEnabledContext,
  NodeLabelChangeContext,
  NodePromptContext,
  NodeQuickEditorIdContext,
  NodeResizeStartContext,
  NodeRetryContext,
  NodeSelectionContext,
  type NodeContentHandlers,
  type NodeImageEditHandler,
  type NodePromptHandler,
} from './AssetNode';
import {
  createNodeRunControlStore,
  NodeRunControlStoreContext,
  NodeStopContext,
} from './node-run-control';

/** 更新测试视口并广播一次变更；调用返回前完成由订阅触发的 React 更新。 */
function updateViewport(patch: Partial<Pick<typeof viewportMock, 'x' | 'y' | 'zoom'>>) {
  act(() => {
    Object.assign(viewportMock, patch);
    viewportMock.listeners.forEach((listener) => listener());
  });
}

/** 模拟浏览器返回的已平移边界；输入为未避让的屏幕坐标，不执行真实布局。 */
function toolbarRect(toolbar: HTMLElement, left: number, top: number, width = 800, height = 46) {
  const shiftX =
    Number.parseFloat(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')) || 0;
  const shiftY =
    Number.parseFloat(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')) || 0;
  return new DOMRect(left + shiftX, top + shiftY, width, height);
}

/** 记录观察器生命周期；notify 显式模拟尺寸通知，不把 jsdom 当作布局引擎。 */
function mockToolbarResizeObserver() {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let notify = () => {};
  const create = vi.fn(function (callback: ResizeObserverCallback) {
    const observer = { observe, disconnect, unobserve: vi.fn() };
    notify = () => callback([], observer);
    return observer;
  });
  vi.stubGlobal('ResizeObserver', create);
  return { create, observe, disconnect, notify: () => act(notify) };
}

/** 构造节点数据；未覆盖的字段保持现有文字生成节点契约。 */
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

/** 挂载真实节点控件与按需提供的动作，网络能力由测试回调替代。 */
function renderNode(
  node: AssetFlowNode,
  onRetry?: (nodeId: string) => void | Promise<void>,
  onEnabled?: (nodeId: string, enabled: boolean) => void,
  onResizeStart?: (nodeId: string) => void,
  selected = false,
  onLabelChange?: (nodeId: string, label: string) => void,
  onDelete?: (nodeId: string) => void,
  actions: {
    content?: NodeContentHandlers;
    editImage?: NodeImageEditHandler;
    openPrompt?: NodePromptHandler;
  } = {},
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
              <NodeContentContext.Provider value={actions.content ?? null}>
                <NodeImageEditContext.Provider value={actions.editImage ?? null}>
                  <NodePromptContext.Provider value={actions.openPrompt ?? null}>
                    <AssetNode {...props} />
                  </NodePromptContext.Provider>
                </NodeImageEditContext.Provider>
              </NodeContentContext.Provider>
            </NodeDeleteContext.Provider>
          </NodeRetryContext.Provider>
        </NodeEnabledContext.Provider>
      </NodeLabelChangeContext.Provider>
    </NodeResizeStartContext.Provider>,
  );
}

/** 节点测试隔离网络，像素来自缩略图响应的原文件尺寸头。 */
function mockThumbnail(width: number, height: number) {
  vi.spyOn(thumbnails, 'acquireImageThumbnail').mockReturnValue({
    promise: Promise.resolve({
      url: 'blob:node-thumbnail',
      originalWidth: width,
      originalHeight: height,
    }),
    release: vi.fn(),
  });
}

beforeEach(() => {
  /** rc-util 测试环境固定 Portal ID；恢复唯一 ID，避免 Tooltip 卸载清掉 Modal 的 Escape 注册。 */
  vi.stubEnv('NODE_ENV', 'development');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  viewportMock.x = 0;
  viewportMock.y = 0;
  viewportMock.zoom = 1;
});

describe('AssetNode result presentation', () => {
  it('复刻节点未选中且未悬浮时保留独立标识与下一步提示，普通视频不显示', () => {
    const node = makeNode({
      mediaType: 'video',
      label: '短视频复刻',
      videoMode: 'omni_reference',
      videoRecreation: {
        version: 1,
        source: { assetId: 'clip', assetVersion: 2, name: '原视频' },
        bindings: [],
      },
    });
    const view = renderNode(node);
    const badge = view.container.querySelector('.flow-node-recreation-badge');
    expect(badge).toHaveTextContent('短视频复刻');
    expect(badge?.querySelector('.lucide-clapperboard')).not.toBeNull();
    expect(badge?.closest('.flow-node-floating-controls')).toBeNull();
    expect(view.container.querySelector('.flow-asset-node')).not.toHaveClass('is-selected');
    expect(screen.getByText('点击节点，按流程开始复刻')).toBeVisible();
    view.unmount();
    const ordinary = renderNode(makeNode({ mediaType: 'video' }));
    expect(ordinary.container.querySelector('.flow-node-recreation-badge')).toBeNull();
    expect(screen.queryByText('点击节点，按流程开始复刻')).not.toBeInTheDocument();
  });

  it('复刻节点已有结果仍显示专属标识，不把空态引导盖在视频上', () => {
    const view = renderNode(
      makeNode({
        mediaType: 'video',
        label: '短视频复刻',
        manualOutput: true,
        assetId: 'result',
        contentUrl: '/demo/video.mp4',
        mimeType: 'video/mp4',
        videoRecreation: {
          version: 1,
          source: { assetId: 'clip', assetVersion: 2, name: '原视频' },
          bindings: [],
        },
      }),
    );
    expect(view.container.querySelector('.flow-node-recreation-badge')).toHaveTextContent(
      '短视频复刻',
    );
    expect(view.container.querySelector('video')).not.toBeNull();
    expect(screen.queryByText('点击节点，按流程开始复刻')).not.toBeInTheDocument();
  });

  it('大画布缩放摘要保留场记板标识，不依赖悬浮操作栏挂载', () => {
    viewportMock.zoom = 0.2;
    const node = makeNode({
      mediaType: 'video',
      label: '短视频复刻',
      videoRecreation: {
        version: 1,
        source: { assetId: 'clip', assetVersion: 2, name: '原视频' },
        bindings: [],
      },
    });
    const view = render(
      <CanvasPerformanceContext.Provider value={true}>
        <AssetNode
          {...({
            id: node.id,
            data: node.data,
            selected: false,
            positionAbsoluteX: 100,
            positionAbsoluteY: 100,
            width: 400,
            height: 266,
          } as NodeProps<AssetFlowNode>)}
        />
      </CanvasPerformanceContext.Provider>,
    );
    expect(view.container.querySelector('.flow-asset-node')).toHaveAttribute(
      'data-render-detail',
      'compact',
    );
    expect(view.container.querySelector('.flow-node-floating-controls')).toBeNull();
    expect(view.container.querySelector('.flow-node-recreation-badge')).toHaveTextContent(
      '短视频复刻',
    );
    expect(view.container.querySelector('.flow-node-summary .lucide-clapperboard')).not.toBeNull();
  });

  it('悬浮按钮整项 hover 显示简述，仍直接位于操作栏且不继承描边按钮', async () => {
    const user = userEvent.setup();
    renderNode(
      makeNode({
        label: '产品图',
        mediaType: 'image',
        assetId: 'asset-1',
        contentUrl: '/assets/1',
      }),
      undefined,
      vi.fn(),
      undefined,
      false,
      vi.fn(),
      vi.fn(),
      {
        content: { upload: vi.fn(), saveText: vi.fn() },
        editImage: vi.fn(),
        openPrompt: vi.fn(),
      },
    );
    const toolbar = screen.getByRole('group', { name: '节点操作：产品图' });
    for (const [name, hint] of [
      ['重命名节点：产品图', '修改节点名称，不影响已有内容'],
      ['拖动移动节点', '按住拖动，调整节点在画布中的位置'],
      ['查看节点信息', '查看节点类型、运行状态与资源信息'],
      ['查看生成提示词：产品图', '查看本次生成实际发送的提示词'],
      ['停用节点', '停用后不参与生成，保留已有内容'],
      ['上传到节点：产品图', '上传本地文件并替换当前节点内容'],
      ['修改图片：产品图', '引用当前图片创建编辑节点，不覆盖原图'],
      ['下载图片', '下载当前回显的图片文件'],
      ['删除节点：产品图', '删除当前节点及关联连线'],
    ]) {
      const button = within(toolbar).getByRole('button', { name });
      expect(button.parentElement).toBe(toolbar);
      expect(button).toHaveClass('ant-btn-variant-text');
      expect(button).not.toHaveAttribute('title');
      await user.hover(button);
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent(hint!);
      expect(button).toHaveAccessibleDescription(hint);
      expect(toolbar).not.toContainElement(tooltip);
      await user.unhover(button);
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }
  });

  it('悬浮按钮键盘 focus 显示简述，不触发动作；耗时保持只读', async () => {
    const user = userEvent.setup();
    const onLabelChange = vi.fn();
    renderNode(makeNode(), undefined, undefined, undefined, false, onLabelChange);
    await user.tab();
    const rename = screen.getByRole('button', { name: '重命名节点：文案生成' });
    expect(rename).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('修改节点名称，不影响已有内容');
    await user.tab();
    const move = screen.getByRole('button', { name: '拖动移动节点' });
    expect(move).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('按住拖动，调整节点在画布中的位置'),
    );
    expect(onLabelChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const duration = screen.getByLabelText('节点生成耗时');
    expect(duration.tagName).toBe('SPAN');
    expect(duration).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('button', { name: '节点生成耗时' })).not.toBeInTheDocument();
    act(() => duration.focus());
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('查看节点本次生成的耗时'),
    );
    expect(duration).toHaveAccessibleDescription('查看节点本次生成的耗时');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(duration).toHaveFocus();
  });

  it('拖动手柄保持直接按钮与指针冒泡，普通操作仍阻止节点拖动', () => {
    const { container } = renderNode(makeNode());
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    const move = within(toolbar).getByRole('button', { name: '拖动移动节点' });
    expect(move.parentElement).toBe(toolbar);
    expect(move).toHaveClass('flow-node-drag-handle');
    expect(move.closest('.nodrag, .nopan')).toBeNull();
    const pointerDown = vi.fn();
    const mouseDown = vi.fn();
    const parent = container.parentElement!;
    parent.addEventListener('pointerdown', pointerDown);
    parent.addEventListener('mousedown', mouseDown);
    try {
      expect(fireEvent.pointerDown(move, { button: 0, pointerId: 1, pointerType: 'mouse' })).toBe(
        true,
      );
      expect(fireEvent.mouseDown(move, { button: 0 })).toBe(true);
      expect(pointerDown).toHaveBeenCalledOnce();
      expect(mouseDown).toHaveBeenCalledOnce();
      fireEvent.pointerDown(screen.getByRole('button', { name: '查看节点信息' }));
      expect(pointerDown).toHaveBeenCalledOnce();
    } finally {
      parent.removeEventListener('pointerdown', pointerDown);
      parent.removeEventListener('mousedown', mouseDown);
    }
  });

  it('运行中上传与修改图片保持原生禁用，可悬停读原因但不执行动作', async () => {
    const user = userEvent.setup();
    const upload = vi.fn();
    const editImage = vi.fn();
    renderNode(
      makeNode({
        mediaType: 'image',
        assetId: 'asset-1',
        contentUrl: '/assets/1',
        runStatus: 'running',
      }),
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      { content: { upload, saveText: vi.fn() }, editImage },
    );
    for (const [name, hint] of [
      ['上传到节点：文案生成', '节点正在运行或保存，请稍后再上传'],
      ['修改图片：文案生成', '节点正在运行或保存，请稍后再修改图片'],
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      await user.hover(button);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(hint!);
      await user.click(button);
      fireEvent.keyDown(button, { key: 'Enter', keyCode: 13, which: 13 });
      await user.unhover(button);
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    }
    expect(upload).not.toHaveBeenCalled();
    expect(editImage).not.toHaveBeenCalled();
  });

  it('旧结果与新执行分别显示计时，手动版本不继承旧生成耗时', async () => {
    const base = makeNode({
      createdAt: '2026-09-15T09:30:00.000Z',
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
    expect(
      info.getByText('节点创建时间').nextElementSibling?.querySelector('time'),
    ).toHaveAttribute('datetime', '2026-09-15T09:30:00.000Z');
    expect(
      info.getByText('结果回显时间').nextElementSibling?.querySelector('time'),
    ).toHaveAttribute('datetime', '2026-09-16T10:00:12.400Z');
    expect(info.getByText('结果回显时间').nextElementSibling).toHaveTextContent('服务端完成');
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
    const manualInfo = within(screen.getByRole('dialog', { name: '节点信息' }));
    expect(manualInfo.getByText('耗时', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      '未记录',
    );
    expect(manualInfo.getByText('结果回显时间').nextElementSibling).toHaveTextContent('未记录');
    expect(
      manualInfo.getByText('节点创建时间').nextElementSibling?.querySelector('time'),
    ).toHaveAttribute('datetime', '2026-09-15T09:30:00.000Z');
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
    fireEvent.mouseEnter(document.querySelector('.flow-asset-node')!);
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

  it('工具栏连续移动 60 次只保留一个观察器，每次先读边界再写改变的偏移', () => {
    const observer = mockToolbarResizeObserver();
    const node = makeNode();
    let x = 140;
    const scene = (selected: boolean) => (
      <div className="react-flow">
        <div className="react-flow__node" style={{ width: 210, height: 160 }}>
          <AssetNode
            {...({
              id: node.id,
              data: node.data,
              selected,
              positionAbsoluteX: x,
              positionAbsoluteY: 30,
            } as NodeProps<AssetFlowNode>)}
          />
        </div>
      </div>
    );
    const view = render(scene(false));
    const canvas = view.container.querySelector('.react-flow')!;
    const wrapper = view.container.querySelector<HTMLElement>('.react-flow__node')!;
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    const events: string[] = [];
    vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => {
      events.push('canvas');
      return new DOMRect(260, 50, 1106, 850);
    });
    const measure = vi.spyOn(toolbar, 'getBoundingClientRect').mockImplementation(() => {
      events.push('toolbar');
      return toolbarRect(toolbar, x, 30);
    });
    const setProperty = toolbar.style.setProperty.bind(toolbar.style);
    const write = vi
      .spyOn(toolbar.style, 'setProperty')
      .mockImplementation((name, value, priority) => {
        events.push('write:' + name + ':' + value);
        setProperty(name, value, priority);
      });
    view.rerender(scene(true));
    observer.notify();
    measure.mockClear();
    write.mockClear();
    events.length = 0;

    for (let frame = 1; frame <= 60; frame++) {
      x = 140 + frame;
      view.rerender(scene(true));
      expect(events.splice(0)).toEqual([
        'canvas',
        'toolbar',
        'write:--flow-node-toolbar-shift-x:' + (128 - frame) + 'px',
      ]);
    }
    expect(measure).toHaveBeenCalledTimes(60);
    expect(write).toHaveBeenCalledTimes(60);
    expect(observer.create).toHaveBeenCalledTimes(1);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('28px');

    view.rerender(scene(true));
    expect(measure).toHaveBeenCalledTimes(60);
    observer.notify();
    fireEvent.transitionEnd(wrapper);
    expect(measure).toHaveBeenCalledTimes(62);
    expect(write).toHaveBeenCalledTimes(60);
    expect(wrapper.style.width).toBe('210px');
    expect(wrapper.style.height).toBe('160px');

    view.rerender(scene(false));
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    const hiddenMeasureCount = measure.mock.calls.length;
    fireEvent.transitionEnd(wrapper);
    expect(measure).toHaveBeenCalledTimes(hiddenMeasureCount);
    view.rerender(scene(true));
    expect(observer.create).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(60);
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(2);
  });

  it('工具栏扣除已有屏幕偏移后可从四边回到内部，重复尺寸通知不累加避让', () => {
    const observer = mockToolbarResizeObserver();
    const node = makeNode();
    let left = 140;
    let top = 30;
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
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(260, 50, 1106, 850));
    vi.spyOn(toolbar, 'getBoundingClientRect').mockImplementation(() =>
      toolbarRect(toolbar, left, top),
    );
    fireEvent.mouseEnter(asset);
    const write = vi.spyOn(toolbar.style, 'setProperty');
    for (const [nextLeft, nextTop, shiftX, shiftY] of [
      [140, 30, 128, 28],
      [1300, 980, -742, -134],
      [300, 80, 0, 0],
      [140.25, 30.5, 127.75, 27.5],
    ]) {
      left = nextLeft;
      top = nextTop;
      observer.notify();
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe(shiftX + 'px');
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe(shiftY + 'px');
      write.mockClear();
      observer.notify();
      expect(write).not.toHaveBeenCalled();
    }
    expect(asset.style.width).toBe('');
    expect(asset.style.height).toBe('');
  });

  it('画布限宽变化先应用新宽度，再按工具栏换行后的高度约束边界', () => {
    const observer = mockToolbarResizeObserver();
    const node = makeNode();
    let canvasWidth = 1106;
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
    vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(260, 50, canvasWidth, 850),
    );
    vi.spyOn(toolbar, 'getBoundingClientRect').mockImplementation(() => {
      const width = Math.min(
        800,
        Number.parseFloat(toolbar.style.getPropertyValue('--flow-node-toolbar-max-width')),
      );
      const height = width < 800 ? 92 : 46;
      return toolbarRect(toolbar, 140, 76 - height, width, height);
    });
    fireEvent.mouseEnter(asset);
    const write = vi.spyOn(toolbar.style, 'setProperty');
    canvasWidth = 600;
    observer.notify();
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-max-width')).toBe('584px');
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('74px');
    expect(write.mock.calls.map(([name]) => name)).toEqual([
      '--flow-node-toolbar-max-width',
      '--flow-node-toolbar-shift-y',
    ]);
    write.mockClear();
    observer.notify();
    expect(write).not.toHaveBeenCalled();
    canvasWidth = 1106;
    observer.notify();
    expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('28px');
    expect(observer.create).toHaveBeenCalledTimes(1);
  });

  it('41 个隐藏悬浮栏节点不因平移或缩放重渲染，显示时读取当前倍率', () => {
    const onRender = vi.fn();
    const view = render(
      <>
        {Array.from({ length: 41 }, (_, index) => {
          const node = makeNode({ label: '节点 ' + index });
          const id = 'node-' + index;
          return (
            <Profiler key={id} id={id} onRender={onRender}>
              <AssetNode
                {...({ id, data: node.data, selected: false } as NodeProps<AssetFlowNode>)}
              />
            </Profiler>
          );
        })}
      </>,
    );
    onRender.mockClear();
    updateViewport({ x: 120, y: -40 });
    expect(onRender).not.toHaveBeenCalled();
    updateViewport({ zoom: 0.5 });
    expect(onRender).not.toHaveBeenCalled();
    const nodes = view.container.querySelectorAll<HTMLElement>('.flow-asset-node');
    fireEvent.mouseEnter(nodes[0]);
    const toolbar = nodes[0].querySelector<HTMLElement>('.flow-node-floating-controls');
    expect(toolbar?.style.getPropertyValue('--flow-node-inverse-zoom')).toBe('2');
    onRender.mockClear();
    updateViewport({ zoom: 0.25 });
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(toolbar?.style.getPropertyValue('--flow-node-inverse-zoom')).toBe('4');
  });

  it.each(['hovered', 'focusWithin', 'selected'] as const)(
    '%s 可见悬浮栏随视口平移重新约束，隐藏后停止平移订阅',
    (visibility) => {
      const node = makeNode();
      /** 只切换选中状态，不重建节点或更改尺寸。 */
      const scene = (selected: boolean) => (
        <div className="react-flow">
          <div className="react-flow__node">
            <AssetNode
              {...({ id: node.id, data: node.data, selected } as NodeProps<AssetFlowNode>)}
            />
          </div>
        </div>
      );
      const view = render(scene(false));
      const canvas = view.container.querySelector('.react-flow')!;
      const asset = view.container.querySelector<HTMLElement>('.flow-asset-node')!;
      const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
      const button = within(toolbar).getByRole('button', { name: '查看节点信息' });
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        left: 260,
        top: 50,
        right: 1366,
        bottom: 900,
        width: 1106,
        height: 850,
      } as DOMRect);
      const measure = vi
        .spyOn(toolbar, 'getBoundingClientRect')
        .mockImplementation(() =>
          toolbarRect(
            toolbar,
            300 * viewportMock.zoom + viewportMock.x,
            80 * viewportMock.zoom + viewportMock.y,
          ),
        );
      if (visibility === 'hovered') fireEvent.mouseEnter(asset);
      else if (visibility === 'focusWithin') fireEvent.focus(button);
      else view.rerender(scene(true));
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('0px');
      updateViewport({ x: -180, y: -50 });
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('148px');
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('28px');
      updateViewport({ x: 1000, y: 900 });
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('-742px');
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('-134px');
      updateViewport({ x: 0, y: 0, zoom: 0.5 });
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('118px');
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('18px');
      updateViewport({ zoom: 2 });
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-x')).toBe('-42px');
      expect(toolbar.style.getPropertyValue('--flow-node-toolbar-shift-y')).toBe('0px');
      expect(asset.style.width).toBe('');
      expect(asset.style.height).toBe('');
      if (visibility === 'hovered') fireEvent.mouseLeave(asset);
      else if (visibility === 'focusWithin')
        fireEvent.blur(button, { relatedTarget: document.body });
      else view.rerender(scene(false));
      const count = measure.mock.calls.length;
      updateViewport({ x: 1100, y: 1000 });
      expect(measure).toHaveBeenCalledTimes(count);
    },
  );

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

  it.each(['image', 'video'] as const)('没有内容的 %s 节点禁用下载按钮', async (mediaType) => {
    const user = userEvent.setup();
    renderNode(makeNode({ mediaType }));
    const button = screen.getByRole('button', {
      name: mediaType === 'image' ? '下载图片' : '下载视频',
    });
    expect(button).toBeDisabled();
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('暂无可下载内容');
    expect(button).toHaveAccessibleDescription('暂无可下载内容');
    await user.click(button);
    expect(fetchNodeAssetDownload).not.toHaveBeenCalled();
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
    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button.parentElement).toBe(toolbar);
      expect(button).not.toHaveAttribute('title');
    }
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

  it('图片显示实际像素，低于所选尺寸时提示但仍下载原文件', async () => {
    mockThumbnail(1672, 941);
    const download = { blob: new Blob(['original']), filename: '原图.png' };
    vi.mocked(fetchNodeAssetDownload).mockResolvedValueOnce(download);
    renderNode(
      makeNode({
        mediaType: 'image',
        modelAlias: 'gpt-image-2.5-sunburst',
        parameters: { resolution: '4k', aspectRatio: '16:9' },
        resultAsset: { assetId: 'result-image', version: 1, mimeType: 'image/png' },
        runStatus: 'succeeded',
      }),
    );
    const image = await screen.findByRole('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 640 },
      naturalHeight: { value: 360 },
    });
    fireEvent.load(image);
    expect(screen.queryByText(/未达到所选/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    const dialog = await screen.findByRole('dialog', { name: '节点信息' });
    expect(dialog).toHaveTextContent('实际像素1672×941');
    expect(dialog).toHaveTextContent('当前设置3840×2160');
    expect(dialog).toHaveTextContent('像素提示实际 1672×941，未达到所选 3840×2160');
    await userEvent.click(screen.getByRole('button', { name: '关闭节点信息' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: '下载图片' }));
    await waitFor(() => expect(downloadProjectExport).toHaveBeenCalledWith(download));
  });

  it.each([
    { label: '已达到尺寸', width: 3840, height: 2160, stale: false, manualOutput: false },
    { label: '修改参数后的旧结果', width: 1672, height: 941, stale: true, manualOutput: false },
    { label: '手动替换的图片', width: 1672, height: 941, stale: false, manualOutput: true },
  ])('$label 不误报生成尺寸不足', async ({ width, height, stale, manualOutput }) => {
    mockThumbnail(width, height);
    renderNode(
      makeNode({
        mediaType: 'image',
        parameters: { resolution: '4k', aspectRatio: '16:9' },
        assetId: 'manual-image',
        mimeType: 'image/png',
        contentUrl: '/v1/assets/manual-image/content',
        resultAsset: { assetId: 'result-image', version: 1, mimeType: 'image/png' },
        runStatus: 'succeeded',
        stale,
        manualOutput,
      }),
    );
    const image = await screen.findByRole('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 640 },
      naturalHeight: { value: 360 },
    });
    fireEvent.load(image);
    expect(screen.queryByText(/未达到所选/)).not.toBeInTheDocument();
    expect(screen.queryByText(/当前原图/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    const dialog = await screen.findByRole('dialog', { name: '节点信息' });
    expect(dialog).toHaveTextContent(`实际像素${width}×${height}`);
    expect(dialog).toHaveTextContent('当前设置3840×2160');
    expect(dialog).toHaveTextContent('原始文件（不缩放）');
    expect(within(dialog).queryByText(/未达到所选|当前原图/)).not.toBeInTheDocument();
  });

  it('信息按钮打开介绍对话框', async () => {
    const user = userEvent.setup();
    renderNode(makeNode({ stale: true }), undefined, vi.fn(), undefined, false, vi.fn(), vi.fn());

    await user.click(screen.getByRole('button', { name: '查看节点信息' }));
    const dialog = await screen.findByRole('dialog', { name: '节点信息' });
    expect(dialog).toHaveTextContent('生成文字节点，根据提示词和上游输入生成文字。');
    expect(dialog).toHaveTextContent('文案生成');
    expect(dialog).toHaveTextContent('上游已变更，节点待更新');
    expect(within(dialog).getByText('节点创建时间').nextElementSibling).toHaveTextContent('未记录');
    expect(within(dialog).getByText('结果回显时间').nextElementSibling).toHaveTextContent('未记录');
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

  it('运行占位的停止按钮只调用当前节点处理器，并在停止意图提交后禁用', async () => {
    const node = makeNode({ runStatus: 'processing', runProgress: 48 });
    const onStop = vi.fn();
    const runControlStore = createNodeRunControlStore();
    runControlStore.set(node.id, { stoppable: true, stopRequested: false });
    render(
      <NodeRunControlStoreContext.Provider value={runControlStore}>
        <NodeStopContext.Provider value={onStop}>
          <AssetNode
            {...({ id: node.id, data: node.data, selected: false } as NodeProps<AssetFlowNode>)}
          />
        </NodeStopContext.Provider>
      </NodeRunControlStoreContext.Provider>,
    );

    const stop = screen.getByRole('button', { name: '停止' });
    expect(stop).toBeEnabled();
    expect(stop).toHaveAttribute(
      'title',
      '停止本地后续提交并取消已知运行；不保证远端任务终止或退款',
    );
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledExactlyOnceWith(node.id);

    act(() => runControlStore.set(node.id, { stoppable: true, stopRequested: true }));
    expect(screen.getByRole('button', { name: '停止中' })).toBeDisabled();
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

describe('画布选区模式', () => {
  it.each([
    [false, 'selected'],
    [false, 'hovered'],
    [false, 'focusWithin'],
    [true, 'selected'],
    [true, 'hovered'],
    [true, 'focusWithin'],
  ] as const)('大画布=%s，%s 不激活隐藏悬浮栏，退出后恢复视口响应', (largeCanvas, visibility) => {
    const observer = mockToolbarResizeObserver();
    const onRender = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const node = makeNode();
    const scene = (selectionMode: boolean) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <CanvasPerformanceContext.Provider value={largeCanvas}>
          <div className="react-flow">
            <div className="react-flow__node" style={{ width: 220, height: 160 }}>
              <Profiler id="selection-node" onRender={onRender}>
                <AssetNode
                  {...({
                    id: node.id,
                    data: node.data,
                    selected: visibility === 'selected',
                  } as NodeProps<AssetFlowNode>)}
                />
              </Profiler>
            </div>
          </div>
        </CanvasPerformanceContext.Provider>
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(true));
    const shell = view.container.querySelector<HTMLElement>('.flow-asset-node')!;
    const wrapper = view.container.querySelector<HTMLElement>('.react-flow__node')!;
    if (visibility === 'hovered') {
      onRender.mockClear();
      fireEvent.mouseEnter(shell);
      fireEvent.mouseLeave(shell);
      fireEvent.mouseEnter(shell);
      expect(onRender).not.toHaveBeenCalled();
    }
    if (visibility === 'focusWithin') fireEvent.focus(shell);
    const initialReads = measure.mock.calls.length;
    measure.mockClear();
    onRender.mockClear();
    updateViewport({ x: 120, y: -40, zoom: 0.5 });
    updateViewport({ x: 140, y: -60, zoom: 0.6 });
    expect(initialReads).toBe(0);
    expect(shell).toHaveAttribute('data-selection-mode', 'true');
    expect(screen.queryByRole('group', { name: '节点操作：文案生成' })).not.toBeInTheDocument();
    expect(observer.create).not.toHaveBeenCalled();
    fireEvent.transitionEnd(wrapper);
    expect(onRender).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();

    view.rerender(scene(false));
    if (visibility === 'hovered') {
      expect(observer.create).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      fireEvent.mouseEnter(shell);
    }
    const toolbar = screen.getByRole('group', { name: '节点操作：文案生成' });
    expect(observer.create).toHaveBeenCalledTimes(1);
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(measure).toHaveBeenCalled();
    expect(toolbar.style.getPropertyValue('--flow-node-zoom')).toBe('0.6');
    measure.mockClear();
    onRender.mockClear();
    updateViewport({ x: 160, zoom: 0.25 });
    expect(onRender).toHaveBeenCalled();
    expect(measure).toHaveBeenCalled();
    expect(toolbar.style.getPropertyValue('--flow-node-inverse-zoom')).toBe('4');

    view.rerender(scene(true));
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(toolbar).not.toBeInTheDocument();
    if (visibility === 'hovered') fireEvent.mouseLeave(shell);
    measure.mockClear();
    onRender.mockClear();
    // 已排队的尺寸通知和过渡事件也不能继续测量已卸载的操作栏。
    observer.notify();
    fireEvent.transitionEnd(wrapper);
    updateViewport({ x: 180, zoom: 0.3 });
    expect(onRender).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(wrapper).toHaveStyle({ width: '220px', height: '160px' });
    expect(updateNodeInternalsMock).not.toHaveBeenCalled();
    if (visibility === 'hovered') {
      view.rerender(scene(false));
      expect(observer.create).toHaveBeenCalledTimes(1);
    }
  });

  it('进入选区模式关闭已打开的 Tooltip，退出后可再次悬浮', async () => {
    const user = userEvent.setup();
    const node = makeNode();
    const scene = (selectionMode: boolean) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <AssetNode
          {...({ id: node.id, data: node.data, selected: true } as NodeProps<AssetFlowNode>)}
        />
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(false));
    await user.hover(screen.getByRole('button', { name: '查看节点信息' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '查看节点类型、运行状态与资源信息',
    );
    view.rerender(scene(true));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    view.rerender(scene(false));
    await user.hover(screen.getByRole('button', { name: '查看节点信息' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '查看节点类型、运行状态与资源信息',
    );
  });

  it.each([
    ['offscreen', 2400, 1],
    ['compact', 100, 0.3],
  ] as const)(
    '选区经过 %s 节点不强制挂载预览，离开选区后恢复单节点悬浮',
    async (detail, x, zoom) => {
      mockThumbnail(640, 480);
      viewportMock.zoom = zoom;
      const node = makeNode({
        mediaType: 'image',
        assetId: 'source-image',
        mimeType: 'image/png',
        contentUrl: '/v1/assets/source-image/versions/1/content',
      });
      const scene = (selectionMode: boolean, selected: boolean) => (
        <CanvasSelectionModeContext.Provider value={selectionMode}>
          <CanvasPerformanceContext.Provider value={true}>
            <AssetNode
              {...({
                id: node.id,
                data: node.data,
                selected,
                positionAbsoluteX: x,
                positionAbsoluteY: 100,
                width: 220,
                height: 160,
              } as NodeProps<AssetFlowNode>)}
            />
          </CanvasPerformanceContext.Provider>
        </CanvasSelectionModeContext.Provider>
      );
      const view = render(scene(true, false));
      const shell = view.container.querySelector('.flow-asset-node')!;
      const handles = Array.from(shell.querySelectorAll('.react-flow__handle'));
      expect(handles.length).toBeGreaterThan(0);
      view.rerender(scene(true, true));
      fireEvent.mouseEnter(shell);
      expect(shell).toHaveAttribute('data-render-detail', detail);
      expect(shell.querySelector('img')).toBeNull();
      expect(thumbnails.acquireImageThumbnail).not.toHaveBeenCalled();
      view.rerender(scene(true, false));
      expect(shell).toHaveAttribute('data-render-detail', detail);
      expect(Array.from(shell.querySelectorAll('.react-flow__handle'))).toEqual(handles);
      expect(updateNodeInternalsMock).not.toHaveBeenCalled();
      view.rerender(scene(false, false));
      expect(shell).toHaveAttribute('data-render-detail', detail);
      expect(thumbnails.acquireImageThumbnail).not.toHaveBeenCalled();
      fireEvent.mouseEnter(shell);
      await waitFor(() =>
        expect(shell.querySelector('img')).toHaveAttribute('src', 'blob:node-thumbnail'),
      );
      expect(thumbnails.acquireImageThumbnail).toHaveBeenCalledTimes(1);
      expect(shell).toHaveAttribute('data-render-detail', 'full');
      expect(screen.getByRole('button', { name: '查看节点信息' })).toBeInTheDocument();
    },
  );

  it('选区切换保留视口内同一张图片、端口与用户尺寸，不重复加载缩略图', async () => {
    mockThumbnail(640, 480);
    const node = makeNode({
      mediaType: 'image',
      assetId: 'source-image',
      mimeType: 'image/png',
      contentUrl: '/v1/assets/source-image/versions/1/content',
    });
    const scene = (selectionMode: boolean) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <CanvasPerformanceContext.Provider value={true}>
          <div className="react-flow__node" style={{ width: 320, height: 240 }}>
            <AssetNode
              {...({
                id: node.id,
                data: node.data,
                selected: true,
                positionAbsoluteX: 100,
                positionAbsoluteY: 100,
                width: 320,
                height: 240,
              } as NodeProps<AssetFlowNode>)}
            />
          </div>
        </CanvasPerformanceContext.Provider>
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(false));
    const shell = view.container.querySelector('.flow-asset-node')!;
    const wrapper = view.container.querySelector('.react-flow__node')!;
    await waitFor(() =>
      expect(shell.querySelector('img')).toHaveAttribute('src', 'blob:node-thumbnail'),
    );
    const image = shell.querySelector('img');
    const handles = Array.from(shell.querySelectorAll('.react-flow__handle'));
    const ports = handles.map((handle) => handle.outerHTML);
    expect(handles.length).toBeGreaterThan(0);
    for (const mode of [true, false, true]) {
      view.rerender(scene(mode));
      expect(view.container.querySelector('.flow-asset-node')).toBe(shell);
      expect(shell).toHaveAttribute('data-render-detail', 'full');
      expect(shell.querySelector('img')).toBe(image);
      expect(Array.from(shell.querySelectorAll('.react-flow__handle'))).toEqual(handles);
      expect(handles.map((handle) => handle.outerHTML)).toEqual(ports);
      expect(wrapper).toHaveStyle({ width: '320px', height: '240px' });
    }
    expect(thumbnails.acquireImageThumbnail).toHaveBeenCalledTimes(1);
    expect(updateNodeInternalsMock).not.toHaveBeenCalled();
  });

  it('选区模式和平移保留文字编辑草稿，不触发保存或重新读取正文', async () => {
    const fetchText = vi.fn().mockResolvedValue(new Response('原始正文', { status: 200 }));
    vi.stubGlobal('fetch', fetchText);
    const content = { upload: vi.fn(), saveText: vi.fn().mockResolvedValue(undefined) };
    const node = makeNode({
      assetId: 'source-text',
      mimeType: 'text/plain',
      contentUrl: 'https://example.test/text.txt',
    });
    const scene = (selectionMode: boolean) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <CanvasPerformanceContext.Provider value={true}>
          <NodeContentContext.Provider value={content}>
            <AssetNode
              {...({
                id: node.id,
                data: node.data,
                selected: true,
                width: 220,
                height: 160,
              } as NodeProps<AssetFlowNode>)}
            />
          </NodeContentContext.Provider>
        </CanvasPerformanceContext.Provider>
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(false));
    fireEvent.doubleClick(await screen.findByText('原始正文'));
    const editor = screen.getByRole('textbox', { name: '编辑文字结果' });
    fireEvent.change(editor, { target: { value: '尚未提交的草稿' } });
    view.rerender(scene(true));
    updateViewport({ x: -2400, zoom: 0.3 });
    expect(screen.getByRole('textbox', { name: '编辑文字结果' })).toBe(editor);
    expect(editor).toHaveValue('尚未提交的草稿');
    expect(view.container.querySelector('.flow-asset-node')).toHaveAttribute(
      'data-render-detail',
      'full',
    );
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(content.saveText).not.toHaveBeenCalled();
    view.rerender(scene(false));
    expect(editor).toHaveValue('尚未提交的草稿');
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('选区模式保留已打开的重命名草稿和信息面板，信息面板继续显示执行计时', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const onLabelChange = vi.fn();
    const node = makeNode({
      runStatus: 'running',
      nodeTiming: { nodeId: 'node_1', startedAt: new Date().toISOString() },
    });
    const scene = (selectionMode: boolean) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <NodeLabelChangeContext.Provider value={onLabelChange}>
          <AssetNode
            {...({ id: node.id, data: node.data, selected: true } as NodeProps<AssetFlowNode>)}
          />
        </NodeLabelChangeContext.Provider>
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(false));
    await userEvent.click(screen.getByRole('button', { name: '重命名节点：文案生成' }));
    const labelInput = screen.getByRole('textbox', { name: '编辑节点名称' });
    fireEvent.change(labelInput, { target: { value: '未提交的新名称' } });
    view.rerender(scene(true));
    expect(screen.getByRole('textbox', { name: '编辑节点名称' })).toBe(labelInput);
    expect(labelInput).toHaveValue('未提交的新名称');
    expect(onLabelChange).not.toHaveBeenCalled();
    view.rerender(scene(false));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await userEvent.click(screen.getByRole('button', { name: '查看节点信息' }));
    const info = screen.getByRole('dialog', { name: '节点信息' });
    interval.mockClear();
    clearInterval.mockClear();
    view.rerender(scene(true));
    expect(screen.getByRole('dialog', { name: '节点信息' })).toBe(info);
    expect(within(info).getByText('运行', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      '运行中',
    );
    expect(interval).not.toHaveBeenCalled();
    expect(clearInterval).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('暂停隐藏悬浮卡片的计时，但运行进度继续更新且退出后恢复计时', () => {
    const interval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const node = makeNode({
      runStatus: 'running',
      nodeTiming: { nodeId: 'node_1', startedAt: new Date().toISOString() },
    });
    const scene = (selectionMode: boolean, runProgress: number) => (
      <CanvasSelectionModeContext.Provider value={selectionMode}>
        <AssetNode
          {...({
            id: node.id,
            data: { ...node.data, runProgress },
            selected: true,
          } as NodeProps<AssetFlowNode>)}
        />
      </CanvasSelectionModeContext.Provider>
    );
    const view = render(scene(false, 12));
    expect(interval).toHaveBeenCalledTimes(1);
    view.rerender(scene(true, 48));
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('运行进度 48%')).toHaveTextContent('48%');
    view.rerender(scene(false, 60));
    expect(interval).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('运行进度 60%')).toHaveTextContent('60%');
  });
});

describe('大画布按需显示', () => {
  it('图片节点不订阅全图连线；视频仅订阅自身入边', () => {
    renderNode(makeNode({ mediaType: 'image' }));
    expect(nodeConnectionsMock).not.toHaveBeenCalled();
    renderNode(makeNode({ mediaType: 'video' }));
    expect(nodeConnectionsMock).toHaveBeenCalledWith({ id: makeNode().id, handleType: 'target' });
  });

  it('视口外只留摘要和外壳；选中与移入视口恢复，尺寸不由内容改变', () => {
    const node = makeNode();
    const scene = (selected: boolean) => (
      <CanvasPerformanceContext.Provider value={true}>
        <AssetNode
          {...({
            id: node.id,
            data: node.data,
            selected,
            positionAbsoluteX: 2200,
            positionAbsoluteY: 100,
            width: 220,
            height: 160,
          } as NodeProps<AssetFlowNode>)}
        />
      </CanvasPerformanceContext.Provider>
    );
    const view = render(scene(false));
    const shell = view.container.querySelector('.flow-asset-node')!;
    expect(shell).toHaveAttribute('data-render-detail', 'offscreen');
    expect(view.container.querySelector('.flow-node-floating-controls')).toBeNull();
    view.rerender(scene(true));
    expect(shell).toHaveAttribute('data-render-detail', 'full');
    expect(screen.getByRole('button', { name: '查看节点信息' })).toBeVisible();
    view.rerender(scene(false));
    updateViewport({ x: -1700 });
    expect(shell).toHaveAttribute('data-render-detail', 'full');
    expect(shell).not.toHaveStyle({ width: '220px' });
    expect(view.container.querySelector('.flow-node-floating-controls')).toBeNull();
  });

  it('远景使用摘要，悬停恢复完整操作，隐藏控件不订阅每一级缩放', () => {
    const node = makeNode();
    const onRender = vi.fn();
    const view = render(
      <CanvasPerformanceContext.Provider value={true}>
        <Profiler id="large-node" onRender={onRender}>
          <AssetNode
            {...({
              id: node.id,
              data: node.data,
              positionAbsoluteX: 100,
              positionAbsoluteY: 100,
              width: 220,
              height: 160,
            } as NodeProps<AssetFlowNode>)}
          />
        </Profiler>
      </CanvasPerformanceContext.Provider>,
    );
    const shell = view.container.querySelector('.flow-asset-node')!;
    updateViewport({ zoom: 0.3 });
    expect(shell).toHaveAttribute('data-render-detail', 'compact');
    onRender.mockClear();
    updateViewport({ zoom: 0.31 });
    expect(onRender).not.toHaveBeenCalled();
    fireEvent.mouseEnter(shell);
    expect(shell).toHaveAttribute('data-render-detail', 'full');
    expect(screen.getByRole('button', { name: '查看节点信息' })).toBeVisible();
    fireEvent.mouseLeave(shell);
    expect(shell).toHaveAttribute('data-render-detail', 'compact');
  });
});

it('首次挂载沿用共享端口测量，只有语义端口布局改变才强制重测', () => {
  const node = makeNode({ mediaType: 'video' });
  const scene = (data: AssetFlowNode['data']) => (
    <AssetNode {...({ id: node.id, data } as NodeProps<AssetFlowNode>)} />
  );
  const view = render(scene(node.data));
  expect(updateNodeInternalsMock).not.toHaveBeenCalled();
  view.rerender(scene({ ...node.data, prompt: '仅提示词变化' }));
  expect(updateNodeInternalsMock).not.toHaveBeenCalled();
  view.rerender(scene({ ...node.data, videoMode: 'first_last_frame' }));
  expect(updateNodeInternalsMock).toHaveBeenCalledExactlyOnceWith(node.id);
});

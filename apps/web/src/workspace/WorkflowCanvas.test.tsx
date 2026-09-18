import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';

const reactFlowMock = vi.hoisted(() => ({
  getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 180, height: 120 })),
  getZoom: vi.fn(() => 1),
  setCenter: vi.fn(),
  fitView: vi.fn(() => Promise.resolve(true)),
  onConnectStart: undefined as
    ((event: MouseEvent, params: Record<string, unknown>) => void) | undefined,
  onConnectEnd: undefined as
    | ((event: MouseEvent, state: { toHandle?: unknown; toNode?: { id?: string } | null }) => void)
    | undefined,
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  function ReactFlow({
    nodes,
    nodeTypes,
    onNodeClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onNodeContextMenu,
    onPaneClick,
    onPaneContextMenu,
    onConnectStart,
    onConnectEnd,
    defaultEdgeOptions,
    edgeTypes,
    minZoom,
    fitViewOptions,
    children,
  }: {
    nodes: AssetFlowNode[];
    nodeTypes?: Record<string, React.ElementType>;
    edgeTypes?: Record<string, React.ElementType>;
    defaultEdgeOptions?: { animated?: boolean; type?: string; style?: Record<string, unknown> };
    onNodeClick?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeMouseEnter?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeMouseLeave?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeContextMenu?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onPaneClick?: () => void;
    onPaneContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    onConnectStart?: (event: MouseEvent, params: Record<string, unknown>) => void;
    onConnectEnd?: (
      event: MouseEvent,
      state: { toHandle?: unknown; toNode?: { id?: string } | null },
    ) => void;
    minZoom?: number;
    fitViewOptions?: { minZoom?: number };
    children?: React.ReactNode;
  }) {
    reactFlowMock.onConnectStart = onConnectStart;
    reactFlowMock.onConnectEnd = onConnectEnd;
    return (
      <div
        data-testid="react-flow"
        data-default-edge-animated={String(Boolean(defaultEdgeOptions?.animated))}
        data-default-edge-type={defaultEdgeOptions?.type ?? ''}
        data-edge-types={Object.keys(edgeTypes ?? {}).join(',')}
        data-default-edge-style={JSON.stringify(defaultEdgeOptions?.style ?? null)}
        data-fit-view-min-zoom={String(minZoom)}
        data-fit-view-options={JSON.stringify(fitViewOptions ?? null)}
      >
        <div
          data-testid="canvas-pane"
          className="react-flow__pane"
          tabIndex={0}
          onClick={onPaneClick}
          onContextMenu={onPaneContextMenu}
        />
        {nodes.map((node) => {
          const NodeComponent = node.type ? nodeTypes?.[node.type] : undefined;
          return (
            <div
              key={node.id}
              data-testid={`canvas-node-${node.id}`}
              data-id={node.id}
              className="react-flow__node"
              tabIndex={0}
              onClick={(event) => onNodeClick?.(event, node)}
              onMouseEnter={(event) => onNodeMouseEnter?.(event, node)}
              onMouseLeave={(event) => onNodeMouseLeave?.(event, node)}
              onContextMenu={(event) => onNodeContextMenu?.(event, node)}
            >
              {NodeComponent ? (
                <NodeComponent id={node.id} data={node.data} selected={node.selected} />
              ) : (
                node.data.label
              )}
            </div>
          );
        })}
        {children}
      </div>
    );
  }

  return {
    Background: () => null,
    BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
    Controls: () => null,
    Handle: () => null,
    NodeResizer: () => null,
    NodeToolbar: ({ children }: { children?: React.ReactNode }) => (
      <div className="react-flow__node-toolbar">{children}</div>
    ),
    Position: { Top: 'top', Bottom: 'bottom' },
    ReactFlow,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useEdges: () => [],
    useUpdateNodeInternals: () => React.useCallback(() => {}, []),
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
        x: x - 100,
        y: y - 50,
      }),
      getNodesBounds: reactFlowMock.getNodesBounds,
      getZoom: reactFlowMock.getZoom,
      setCenter: reactFlowMock.setCenter,
      fitView: reactFlowMock.fitView,
    }),
  };
});

import { WorkflowCanvas, type WorkflowCanvasProps } from './WorkflowCanvas';

const generateNode = {
  id: 'node-generate',
  type: 'image',
  position: { x: 0, y: 0 },
  selected: true,
  data: {
    label: '图片生成节点',
    mediaType: 'image',
    mode: 'generate',
    enabled: true,
    prompt: '',
  },
} as AssetFlowNode;

const sourceNode = {
  id: 'node-source',
  type: 'image',
  position: { x: 40, y: 60 },
  data: {
    label: '图片来源节点',
    mediaType: 'image',
    mode: 'source',
    enabled: true,
  },
} as AssetFlowNode;

/** 创建供 jsdom 布局断言使用的矩形。 */
function createMockRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function createProps(overrides: Partial<WorkflowCanvasProps> = {}): WorkflowCanvasProps {
  return {
    nodes: [],
    edges: [],
    selectedNode: null,
    models: [],
    busy: false,
    background: 'dots',
    onNodesChange: vi.fn(),
    onEdgesChange: vi.fn(),
    onConnect: vi.fn(),
    onNodeDragStart: vi.fn(),
    onCanvasDrop: vi.fn(),
    onNodeSelect: vi.fn(),
    onClearNodeSelection: vi.fn(),
    onResizeNode: vi.fn(),
    onNodeEnabledChange: vi.fn(),
    onRetryNode: vi.fn(),
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onInferenceStrengthChange: vi.fn(),
    onRunNode: vi.fn(),
    onDeleteNode: vi.fn(),
    onAddGenerateNode: vi.fn(),
    onAddConnectedGenerateNode: vi.fn(),
    onCanvasCenterChange: vi.fn(),
    onRequestUpload: vi.fn(),
    onOpenProjectHub: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  reactFlowMock.getNodesBounds.mockClear();
  reactFlowMock.getZoom.mockClear();
  reactFlowMock.setCenter.mockClear();
  reactFlowMock.fitView.mockClear();
  reactFlowMock.onConnectStart = undefined;
  reactFlowMock.onConnectEnd = undefined;
  vi.restoreAllMocks();
});

describe('WorkflowCanvas context menu', () => {
  it.each(['textarea', 'select'] as const)(
    'keeps the native context menu for a %s inside a node',
    (tagName) => {
      const props = createProps({ nodes: [generateNode] });
      render(<WorkflowCanvas {...props} />);
      const node = screen.getByTestId(`canvas-node-${generateNode.id}`);
      const interactiveControl = document.createElement(tagName);
      node.append(interactiveControl);
      const contextEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 140,
        clientY: 120,
      });

      interactiveControl.dispatchEvent(contextEvent);

      expect(contextEvent.defaultPrevented).toBe(false);
      expect(props.onNodeSelect).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    },
  );

  it('opens at the click and creates nodes at the converted flow position', async () => {
    const user = userEvent.setup();
    const props = createProps();
    render(<WorkflowCanvas {...props} />);
    const pane = screen.getByTestId('canvas-pane');
    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 210,
    });

    pane.dispatchEvent(contextEvent);

    expect(contextEvent.defaultPrevented).toBe(true);
    const menu = await screen.findByRole('menu', { name: '画布操作' });
    expect(menu).toHaveStyle({ left: '320px', top: '210px' });
    await user.click(screen.getByRole('menuitem', { name: '创建图片生成节点' }));
    expect(props.onAddGenerateNode).toHaveBeenCalledWith('image', { x: 220, y: 160 });
    expect(screen.queryByRole('menu', { name: '画布操作' })).not.toBeInTheDocument();

    fireEvent.contextMenu(pane, { clientX: 260, clientY: 180 });
    expect(screen.queryByRole('menuitem', { name: '创建视频转换节点' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '创建视频生成节点' }));
    expect(props.onAddGenerateNode).toHaveBeenCalledWith('video', { x: 160, y: 130 });

    fireEvent.contextMenu(pane, { clientX: 260, clientY: 180 });
    await user.click(screen.getByRole('menuitem', { name: '上传资源' }));
    expect(props.onRequestUpload).toHaveBeenCalledTimes(1);
  });

  it('selects a right-clicked node and exposes run, enable and delete actions', async () => {
    const user = userEvent.setup();
    const props = createProps({ nodes: [sourceNode, generateNode] });
    render(<WorkflowCanvas {...props} />);
    const source = screen.getByTestId(`canvas-node-${sourceNode.id}`);

    fireEvent.contextMenu(source, { clientX: 140, clientY: 120 });

    expect(props.onNodeSelect).toHaveBeenCalledWith(sourceNode);
    expect(screen.getByRole('menuitem', { name: '开始生成' })).toBeEnabled();
    await user.click(screen.getByRole('menuitem', { name: '开始生成' }));
    expect(props.onRunNode).toHaveBeenCalledWith(sourceNode);
    fireEvent.contextMenu(source, { clientX: 140, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: '停用节点' }));
    expect(props.onNodeEnabledChange).toHaveBeenCalledWith(sourceNode.id, false);

    const generate = screen.getByTestId(`canvas-node-${generateNode.id}`);
    fireEvent.contextMenu(generate, { clientX: 160, clientY: 130 });
    await user.click(screen.getByRole('menuitem', { name: '开始生成' }));
    expect(props.onRunNode).toHaveBeenCalledWith(generateNode);

    fireEvent.contextMenu(generate, { clientX: 160, clientY: 130 });
    await user.click(screen.getByRole('menuitem', { name: '删除节点' }));
    expect(props.onDeleteNode).toHaveBeenCalledWith(generateNode.id);
  });

  it('uses the selected node bounds and current zoom to center it in the viewport', async () => {
    const user = userEvent.setup();
    reactFlowMock.getNodesBounds.mockReturnValue({ x: 240, y: 160, width: 320, height: 180 });
    reactFlowMock.getZoom.mockReturnValue(0.75);
    const props = createProps({ nodes: [generateNode], selectedNode: generateNode });
    render(<WorkflowCanvas {...props} />);

    fireEvent.contextMenu(screen.getByTestId(`canvas-node-${generateNode.id}`), {
      clientX: 140,
      clientY: 120,
    });
    await user.click(screen.getByRole('menuitem', { name: '定位并居中节点' }));

    expect(reactFlowMock.getNodesBounds).toHaveBeenCalledWith([generateNode.id]);
    expect(reactFlowMock.getZoom).toHaveBeenCalledTimes(1);
    expect(reactFlowMock.setCenter).toHaveBeenCalledWith(400, 250, {
      zoom: 0.75,
      duration: 220,
    });
  });

  it('supports keyboard navigation, Escape focus restoration and outside dismissal', async () => {
    const user = userEvent.setup();
    const props = createProps();
    render(
      <>
        <button type="button">画布外部</button>
        <WorkflowCanvas {...props} />
      </>,
    );
    const pane = screen.getByTestId('canvas-pane');
    pane.focus();
    fireEvent.contextMenu(pane, { clientX: 180, clientY: 140 });

    const textItem = await screen.findByRole('menuitem', { name: '创建文字生成节点' });
    expect(textItem).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '创建图片生成节点' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: '自动适配缩放' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: '画布操作' })).not.toBeInTheDocument();
    await waitFor(() => expect(pane).toHaveFocus());

    fireEvent.contextMenu(pane, { clientX: 180, clientY: 140 });
    await user.click(screen.getByRole('button', { name: '画布外部' }));
    expect(screen.queryByRole('menu', { name: '画布操作' })).not.toBeInTheDocument();
  });

  it('hands the selected-node toolbar delete action back to the app', async () => {
    const user = userEvent.setup();
    const props = createProps({ nodes: [generateNode], selectedNode: generateNode });
    render(<WorkflowCanvas {...props} />);

    await user.click(screen.getByRole('button', { name: '删除节点：图片生成节点' }));

    expect(props.onDeleteNode).toHaveBeenCalledWith(generateNode.id);
  });

  it('将新节点生成、提示词和图片编辑交回现有画布操作', async () => {
    const user = userEvent.setup();
    const node = {
      ...generateNode,
      data: {
        ...generateNode.data,
        prompt: '编辑原图',
        assetId: 'image-1',
        contentUrl: '/image.png',
      },
    };
    const props = createProps({
      nodes: [node],
      onOpenRequestPrompt: vi.fn(),
      onEditImage: vi.fn(),
      onCreateGroup: vi.fn(),
    });
    render(<WorkflowCanvas {...props} />);
    const target = screen.getByTestId(`canvas-node-${node.id}`);
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('menuitem', { name: '生成到新节点' }));
    expect(props.onRunNode).toHaveBeenCalledWith(node, 'newNode');
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('menuitem', { name: '提示词' }));
    expect(props.onOpenRequestPrompt).toHaveBeenCalledWith(node.id);
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('menuitem', { name: '修改图片' }));
    expect(props.onEditImage).toHaveBeenCalledWith(node.id);
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('menuitem', { name: '为选中节点创建分组' }));
    expect(props.onCreateGroup).toHaveBeenCalledTimes(1);
  });

  it('运行中的节点禁用生成与图片编辑，仍可查看提示词', () => {
    const node = {
      ...generateNode,
      data: {
        ...generateNode.data,
        prompt: '编辑原图',
        resultAsset: { assetId: 'image-1' },
        runStatus: 'running',
      },
    } as AssetFlowNode;
    const props = createProps({
      nodes: [node],
      onOpenRequestPrompt: vi.fn(),
      onEditImage: vi.fn(),
    });
    render(<WorkflowCanvas {...props} />);
    fireEvent.contextMenu(screen.getByTestId(`canvas-node-${node.id}`));
    expect(screen.getByRole('menuitem', { name: '开始生成' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '生成到新节点' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '修改图片' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '提示词' })).toBeEnabled();
  });

  it('画布菜单包含分组、历史、视图和清理操作，遵循现有可用状态', async () => {
    const user = userEvent.setup();
    const props = createProps({
      onCreateGroup: vi.fn(),
      onUndoCanvas: vi.fn(),
      onRedoCanvas: vi.fn(),
      onOpenSearch: vi.fn(),
      onClearCanvas: vi.fn(),
      onClearEmptyNodes: vi.fn(),
      canUndo: true,
      canRedo: false,
      canClearCanvas: true,
      clearCounts: { nodes: 2, edges: 0, groups: 1, emptyNodes: 1, emptyNodeEdges: 0 },
    });
    render(<WorkflowCanvas {...props} />);
    const pane = screen.getByTestId('canvas-pane');
    fireEvent.contextMenu(pane);
    expect(screen.getByRole('menuitem', { name: '重做' })).toBeDisabled();
    for (const [name, callback] of [
      ['新建分组', props.onCreateGroup],
      ['撤销', props.onUndoCanvas],
      ['搜索', props.onOpenSearch],
      ['清理空节点', props.onClearEmptyNodes],
      ['清空画布', props.onClearCanvas],
    ] as const) {
      fireEvent.contextMenu(pane);
      await user.click(screen.getByRole('menuitem', { name }));
      expect(callback).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu', { name: '画布操作' })).not.toBeInTheDocument();
    }
  });

  it('较长菜单在视口边缘打开时仍完整位于可见区域', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('canvas-context-menu')
        ? createMockRect(0, 0, 280, 600)
        : createMockRect(0, 0, 0, 0);
    });
    render(<WorkflowCanvas {...createProps()} />);
    fireEvent.contextMenu(screen.getByTestId('canvas-pane'), {
      clientX: window.innerWidth,
      clientY: window.innerHeight,
    });
    expect(screen.getByRole('menu', { name: '画布操作' })).toHaveStyle({
      left: `${window.innerWidth - 288}px`,
      top: `${window.innerHeight - 608}px`,
    });
    vi.stubGlobal('innerWidth', 900);
    vi.stubGlobal('innerHeight', 700);
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('menu', { name: '画布操作' })).toHaveStyle({
      left: '612px',
      top: '92px',
    });
    vi.unstubAllGlobals();
  });

  it('shows the quick editor after clicking a node and scopes edits to the selected node', async () => {
    const user = userEvent.setup();
    const otherNode = {
      ...generateNode,
      id: 'node-other-generate',
      selected: true,
      data: { ...generateNode.data, label: '另一个图片生成节点', prompt: '旧提示词' },
    } as AssetFlowNode;
    const props = createProps({
      nodes: [generateNode, otherNode],
      selectedNode: otherNode,
      onPromptChange: vi.fn(),
      onParametersChange: vi.fn(),
      onModelChange: vi.fn(),
      onInferenceStrengthChange: vi.fn(),
    });
    const { rerender } = render(<WorkflowCanvas {...props} />);

    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    fireEvent.mouseEnter(canvasNode);

    expect(props.onNodeSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '图片生成节点生成设置' })).not.toBeInTheDocument();

    await user.click(canvasNode);
    expect(props.onNodeSelect).toHaveBeenCalledWith(generateNode);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);
    expect(await screen.findByRole('region', { name: '图片生成节点生成设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeInTheDocument();

    const prompt = screen.getByRole('textbox', { name: '提示词' });
    await user.clear(prompt);
    await user.type(prompt, '悬停编辑');
    expect(props.onPromptChange).toHaveBeenLastCalledWith('悬停编辑', generateNode.id);

    fireEvent.mouseLeave(canvasNode);
  });

  it.each([false, true])(
    '全选图片的预览依据实际编辑器，其他编辑器打开：%s',
    async (otherEditorOpen) => {
      const imageNode: AssetFlowNode = {
        ...generateNode,
        selected: true,
        data: {
          ...generateNode.data,
          assetId: 'selected-image',
          contentUrl: 'https://assets.example/selected.png',
          mimeType: 'image/png',
        },
      };
      const otherNode: AssetFlowNode = {
        ...generateNode,
        id: 'another-selected-node',
        data: { ...generateNode.data, label: '另一个图片节点' },
      };
      const props = createProps({
        nodes: [imageNode, otherNode],
        selectedNode: otherEditorOpen ? otherNode : null,
      });
      const view = render(<WorkflowCanvas {...props} />);
      const image = screen.getByRole('img', { name: imageNode.data.label });
      await userEvent.click(image);
      expect(props.onNodeSelect).toHaveBeenCalledWith(imageNode);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      view.rerender(<WorkflowCanvas {...props} selectedNode={imageNode} />);
      expect(screen.getByRole('region', { name: '图片生成节点生成设置' })).toBeInTheDocument();
      await userEvent.click(image);
      expect(screen.getByRole('dialog', { name: imageNode.data.label })).toBeInTheDocument();
    },
  );

  it('根据节点四周空间布局编辑器，不能向上挤进节点或超出画布', async () => {
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    let nodeRect = createMockRect(380, 620, 180, 80);

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(80, 90, 720, 620));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockImplementation(() => nodeRect);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

    const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
    const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay');

    expect(overlay).not.toBeNull();
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'above'));
    expect(overlay).toHaveStyle({ visibility: 'visible', width: '570px', left: '185px' });
    expect(overlay?.closest('.react-flow__node')).toBeNull();
    expect(
      Number.parseInt(overlay?.style.top ?? '', 10) +
        Number.parseInt(overlay?.style.getPropertyValue('--quick-editor-max-height') ?? '', 10),
    ).toBeLessThanOrEqual(620 - 64);

    nodeRect = createMockRect(380, 150, 180, 80);
    canvasNode.style.transform = 'translate(1px)';
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'below'));
    expect(overlay).toHaveStyle({ width: '570px', left: '185px' });
    expect(Number.parseInt(overlay?.style.top ?? '', 10)).toBeGreaterThan(230);

    nodeRect = createMockRect(600, 350, 180, 80);
    canvasNode.style.transform = 'translate(2px)';
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'left'));
    const overlayLeft = Number.parseInt(overlay?.style.left ?? '', 10);
    const overlayWidth = Number.parseInt(overlay?.style.width ?? '', 10);
    expect(overlayWidth).toBe(496);
    expect(overlayLeft).toBeGreaterThanOrEqual(88);
    expect(overlayLeft + overlayWidth).toBeLessThanOrEqual(792);
    expect(overlayLeft + overlayWidth).toBeLessThanOrEqual(nodeRect.left - 16);

    nodeRect = createMockRect(180, 350, 180, 80);
    canvasNode.style.transform = 'translate(3px)';
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'right'));
    expect(overlay).toHaveStyle({ left: '376px', width: '416px' });
    expect(Number.parseInt(overlay?.style.left ?? '', 10)).toBeGreaterThanOrEqual(
      nodeRect.right + 16,
    );
  });

  it.each([
    { name: '窄画布', viewportWidth: 1024, canvasLeft: 120, canvasWidth: 480, width: 464 },
    { name: '窄视口', viewportWidth: 560, canvasLeft: 0, canvasWidth: 900, width: 544 },
  ])(
    '在$name内收缩 570px 编辑器并保留边距，空间恢复后重新加宽',
    async ({ viewportWidth, canvasLeft, canvasWidth, width }) => {
      const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(viewportWidth);
      vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewportWidth);
      const props = createProps({ nodes: [generateNode], selectedNode: null });
      const { rerender } = render(<WorkflowCanvas {...props} />);
      const canvas = screen.getByRole('region', { name: '工作流画布' });
      const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
      const bounds = vi
        .spyOn(canvas, 'getBoundingClientRect')
        .mockReturnValue(createMockRect(canvasLeft, 90, canvasWidth, 620));
      vi.spyOn(canvasNode, 'getBoundingClientRect').mockReturnValue(
        createMockRect(200, 150, 180, 80),
      );
      rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

      const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
      const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay');
      expect(overlay).toHaveAttribute('data-placement', 'below');
      expect(overlay).toHaveStyle({ visibility: 'visible', width: `${width}px` });
      const left = Number.parseInt(overlay?.style.left ?? '', 10);
      expect(left).toBeGreaterThanOrEqual(canvasLeft + 8);
      expect(left + width).toBeLessThanOrEqual(
        Math.min(viewportWidth, canvasLeft + canvasWidth) - 8,
      );
      expect(Number.parseInt(overlay?.style.top ?? '', 10)).toBeGreaterThanOrEqual(230 + 16);

      innerWidth.mockReturnValue(1024);
      bounds.mockReturnValue(createMockRect(0, 90, 900, 620));
      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(overlay).toHaveStyle({ width: '570px' }));
    },
  );

  it('uses the appearance-driven default edge without forcing animation', () => {
    render(<WorkflowCanvas {...createProps()} />);

    const flow = screen.getByTestId('react-flow');
    expect(flow).toHaveAttribute('data-edge-types', 'default');
    expect(flow).toHaveAttribute('data-default-edge-type', 'default');
    expect(flow).toHaveAttribute('data-default-edge-animated', 'false');
    expect(flow).toHaveAttribute('data-default-edge-style', 'null');
  });

  it('把连接线路径形态与动态特效分别标记在画布区域上', () => {
    const props = createProps({ edgePathStyle: 'smoothstep', edgeEffect: 'cruiser' });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });

    expect(canvas).toHaveAttribute('data-edge-path-style', 'smoothstep');
    expect(canvas).toHaveAttribute('data-edge-effect', 'cruiser');

    rerender(<WorkflowCanvas {...props} edgePathStyle="straight" />);

    // 只改路径形态不能重置特效。
    expect(canvas).toHaveAttribute('data-edge-path-style', 'straight');
    expect(canvas).toHaveAttribute('data-edge-effect', 'cruiser');
  });

  it('prevents browser page zoom for Ctrl+wheel events on the canvas', () => {
    render(<WorkflowCanvas {...createProps()} />);

    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const child = document.createElement('div');
    child.addEventListener('wheel', (event) => event.stopPropagation());
    canvas.append(child);
    const preventDefault = vi.spyOn(Event.prototype, 'preventDefault');
    fireEvent.wheel(child, { ctrlKey: true, deltaY: -120 });
    expect(preventDefault).toHaveBeenCalled();
    preventDefault.mockRestore();
  });

  it('allows Fit View to zoom out far enough for large persisted canvases', () => {
    render(<WorkflowCanvas {...createProps()} />);

    const flow = screen.getByTestId('react-flow');
    expect(flow).toHaveAttribute('data-fit-view-min-zoom', '0.25');
    expect(JSON.parse(flow.getAttribute('data-fit-view-options') ?? 'null')).toMatchObject({
      minZoom: 0.25,
    });
  });

  it('provides a bottom toolbar action that fits the viewport around all nodes', async () => {
    const user = userEvent.setup();
    render(<WorkflowCanvas {...createProps({ nodes: [generateNode] })} />);

    await user.click(screen.getByRole('button', { name: '自动适配缩放' }));

    expect(reactFlowMock.fitView).toHaveBeenCalledWith({
      padding: 0.3,
      maxZoom: 1.1,
      minZoom: 0.25,
      duration: 220,
    });
  });
});

describe('WorkflowCanvas connection drop create', () => {
  function dropConnectionOnPane(
    node: AssetFlowNode,
    client = { x: 320, y: 210 },
    handleType: 'source' | 'target' = 'source',
    handleId?: string,
  ) {
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      writable: true,
      value: () => [],
    });
    const event = new MouseEvent('mouseup', {
      bubbles: true,
      clientX: client.x,
      clientY: client.y,
    });
    reactFlowMock.onConnectStart?.(event, {
      nodeId: node.id,
      handleId: handleId ?? `output:${node.data.mediaType}`,
      handleType,
    });
    reactFlowMock.onConnectEnd?.(event, { toHandle: null, toNode: null });
  }

  it('opens a create menu at the drop point when a line is released on empty canvas', async () => {
    const user = userEvent.setup();
    const props = createProps({ nodes: [generateNode] });
    render(<WorkflowCanvas {...props} />);

    dropConnectionOnPane(generateNode);
    fireEvent.click(screen.getByTestId('canvas-pane'));

    const menu = await screen.findByRole('menu', { name: '选择要创建的节点' });
    expect(menu).toHaveStyle({ left: '320px', top: '210px' });
    expect(screen.getByRole('menuitem', { name: '图生图' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '视频首帧' })).toBeInTheDocument();
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(props.onClearNodeSelection).not.toHaveBeenCalled();

    await user.click(screen.getByRole('menuitem', { name: '图生图' }));
    expect(props.onAddConnectedGenerateNode).toHaveBeenCalledWith({
      mediaType: 'image',
      position: { x: 220, y: 27 },
      existingNodeId: generateNode.id,
      handleType: 'source',
      handleId: 'output:image',
      role: 'content',
      label: '图生图',
    });
    expect(screen.queryByRole('menu', { name: '选择要创建的节点' })).not.toBeInTheDocument();
  });

  it('creates a video node as first frame from an image output drop', async () => {
    const user = userEvent.setup();
    const props = createProps({ nodes: [generateNode] });
    render(<WorkflowCanvas {...props} />);

    dropConnectionOnPane(generateNode, { x: 260, y: 180 });
    await user.click(await screen.findByRole('menuitem', { name: '视频首帧' }));

    expect(props.onAddConnectedGenerateNode).toHaveBeenCalledWith({
      mediaType: 'video',
      position: { x: 160, y: -3 },
      existingNodeId: generateNode.id,
      handleType: 'source',
      handleId: 'output:image',
      role: 'firstFrame',
      label: '视频首帧',
      videoMode: 'first_frame',
    });
  });

  it('still connects when the line is released on another node body', () => {
    const props = createProps({ nodes: [generateNode, sourceNode] });
    render(<WorkflowCanvas {...props} />);
    const target = screen.getByTestId(`canvas-node-${sourceNode.id}`);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      writable: true,
      value: () => [target],
    });

    const event = new MouseEvent('mouseup', { bubbles: true, clientX: 140, clientY: 120 });
    reactFlowMock.onConnectStart?.(event, {
      nodeId: generateNode.id,
      handleId: 'output:image',
      handleType: 'source',
    });
    reactFlowMock.onConnectEnd?.(event, { toHandle: null, toNode: null });

    expect(props.onConnect).toHaveBeenCalledWith({
      source: generateNode.id,
      sourceHandle: 'output:image',
      target: sourceNode.id,
      targetHandle: null,
    });
    expect(screen.queryByRole('menu', { name: '选择要创建的节点' })).not.toBeInTheDocument();
  });
});

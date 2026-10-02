import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { memo, useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import { NodeDeleteContext, NodePromptContext, NodeSelectionContext } from './AssetNode';
import { GenerationBatchViewContext } from './generation-batch-view';

/** 记录参数编辑器真正进入渲染的次数，几何拖动不应重新构造整套表单。 */
const quickEditorRender = vi.hoisted(() => vi.fn());
vi.mock('./NodeQuickEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./NodeQuickEditor')>();
  return {
    ...actual,
    NodeQuickEditor: (props: import('./NodeQuickEditor').NodeQuickEditorProps) => {
      quickEditorRender(props);
      return <actual.NodeQuickEditor {...props} />;
    },
  };
});

const reactFlowMock = vi.hoisted(() => ({
  getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 180, height: 120 })),
  getZoom: vi.fn(() => 1),
  screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x - 100, y: y - 50 }),
  viewportZoom: 1,
  nodeProbe: undefined as React.ElementType | undefined,
  edges: [] as WorkflowCanvasProps['edges'],
  storeProps: {} as Record<string, unknown>,
  onNodesChange: undefined as WorkflowCanvasProps['onNodesChange'] | undefined,
  setCenter: vi.fn(),
  fitView: vi.fn(() => Promise.resolve(true)),
  onMoveStart: undefined as (() => void) | undefined,
  onMoveEnd: undefined as (() => void) | undefined,
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
    edges,
    onNodesChange,
    onConnect,
    onNodeDrag,
    onNodeDragStop,
    nodeTypes,
    onNodeClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onNodeContextMenu,
    onPaneClick,
    onMoveStart,
    onMoveEnd,
    onPaneContextMenu,
    onSelectionContextMenu,
    selectionOnDrag,
    panOnDrag,
    multiSelectionKeyCode,
    onConnectStart,
    onConnectEnd,
    defaultEdgeOptions,
    edgeTypes,
    minZoom,
    fitViewOptions,
    deleteKeyCode,
    children,
  }: {
    nodes: AssetFlowNode[];
    edges: WorkflowCanvasProps['edges'];
    onNodesChange?: WorkflowCanvasProps['onNodesChange'];
    onConnect?: WorkflowCanvasProps['onConnect'];
    onNodeDrag?: WorkflowCanvasProps['onNodeDrag'];
    onNodeDragStop?: WorkflowCanvasProps['onNodeDragStop'];
    nodeTypes?: Record<string, React.ElementType>;
    edgeTypes?: Record<string, React.ElementType>;
    defaultEdgeOptions?: { animated?: boolean; type?: string; style?: Record<string, unknown> };
    onNodeClick?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeMouseEnter?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeMouseLeave?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeContextMenu?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onPaneClick?: () => void;
    onMoveStart?: () => void;
    onMoveEnd?: () => void;
    onPaneContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    onSelectionContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    selectionOnDrag?: boolean;
    panOnDrag?: boolean | number[];
    multiSelectionKeyCode?: string[];
    onConnectStart?: (event: MouseEvent, params: Record<string, unknown>) => void;
    onConnectEnd?: (
      event: MouseEvent,
      state: { toHandle?: unknown; toNode?: { id?: string } | null },
    ) => void;
    minZoom?: number;
    fitViewOptions?: { minZoom?: number };
    deleteKeyCode?: string | null;
    children?: React.ReactNode;
  }) {
    reactFlowMock.storeProps = {
      onNodesChange,
      onConnect,
      onConnectEnd,
      onNodeDrag,
      onNodeDragStop,
      onConnectStart,
      defaultEdgeOptions,
      fitViewOptions,
      selectionOnDrag,
      panOnDrag,
      multiSelectionKeyCode,
    };
    reactFlowMock.edges = edges;
    reactFlowMock.onMoveStart = onMoveStart;
    reactFlowMock.onMoveEnd = onMoveEnd;
    reactFlowMock.onNodesChange = onNodesChange;
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
        data-library-delete-key={String(deleteKeyCode)}
      >
        <div
          data-testid="canvas-pane"
          className="react-flow__pane"
          tabIndex={0}
          onClick={onPaneClick}
          onContextMenu={onPaneContextMenu}
        />
        <div data-testid="canvas-selection" onContextMenu={onSelectionContextMenu} />
        {nodes.map((node) => {
          const NodeComponent =
            reactFlowMock.nodeProbe ?? (node.type ? nodeTypes?.[node.type] : undefined);
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
                <NodeComponent
                  id={node.id}
                  data={node.data}
                  selected={node.selected}
                  {...(reactFlowMock.nodeProbe ? { node, onNodeClick, onNodeContextMenu } : {})}
                />
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
    useViewport: () => ({ x: 0, y: 0, zoom: reactFlowMock.viewportZoom }),
    useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, reactFlowMock.viewportZoom] }),
    useEdges: () => [],
    useNodeConnections: () => [],
    useUpdateNodeInternals: () => React.useCallback(() => {}, []),
    useReactFlow: () => ({
      screenToFlowPosition: reactFlowMock.screenToFlowPosition,
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

/** 校验真实 Dropdown 的屏幕锚点；jsdom 不负责推断浮层最终布局坐标。 */
function expectContextMenuAnchor(menu: HTMLElement, position: { x: number; y: number }) {
  expect(menu.closest('.canvas-context-dropdown')).toHaveClass('ant-dropdown');
  const anchor = document.querySelector('body > .ant-dropdown-trigger[aria-hidden="true"]');
  expect(anchor).toHaveStyle({
    position: 'fixed',
    left: `${Math.min(position.x, window.innerWidth - 1)}px`,
    top: `${Math.min(position.y, window.innerHeight - 1)}px`,
    width: '1px',
    height: '1px',
  });
}

function createProps(overrides: Partial<WorkflowCanvasProps> = {}): WorkflowCanvasProps {
  return {
    nodes: [],
    edges: [],
    selectedNode: null,
    models: [],
    busyNodeIds: new Set(),
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
  reactFlowMock.getZoom.mockClear().mockReturnValue(1);
  reactFlowMock.viewportZoom = 1;
  reactFlowMock.nodeProbe = undefined;
  reactFlowMock.edges = [];
  reactFlowMock.onNodesChange = undefined;
  reactFlowMock.setCenter.mockClear();
  reactFlowMock.fitView.mockClear();
  reactFlowMock.onConnectStart = undefined;
  reactFlowMock.onConnectEnd = undefined;
  vi.restoreAllMocks();
});

describe('WorkflowCanvas context menu', () => {
  it('视口缩放或平移只暂停装饰层，结束后恢复且不改变节点或连线', () => {
    const props = createProps({ nodes: [generateNode] });
    const view = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const beforeEdges = reactFlowMock.edges;
    act(() => reactFlowMock.onMoveStart?.());
    expect(canvas).toHaveClass('is-viewport-moving');
    view.rerender(<WorkflowCanvas {...props} selectedGroupId="group-1" />);
    expect(canvas).toHaveClass('is-viewport-moving');
    act(() => reactFlowMock.onMoveEnd?.());
    expect(canvas).not.toHaveClass('is-viewport-moving');
    expect(reactFlowMock.edges).toBe(beforeEdges);
    expect(props.onNodesChange).not.toHaveBeenCalled();
    act(() => reactFlowMock.onMoveStart?.());
    fireEvent(window, new Event('blur'));
    expect(canvas).not.toHaveClass('is-viewport-moving');
  });
  it('禁用 React Flow 默认删除键，由 App 统一检查菜单边界和撤销历史', () => {
    render(<WorkflowCanvas {...createProps()} />);
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-library-delete-key', 'null');
  });
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
    expectContextMenuAnchor(menu, { x: 320, y: 210 });
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
    expect(screen.getByRole('menuitem', { name: '开始生成' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
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
    // Menu 按 offsetParent 判断可见性；只补布局输入，不手动设置焦点。
    for (const item of screen.getAllByRole('menuitem')) {
      Object.defineProperty(item, 'offsetParent', { configurable: true, value: document.body });
    }
    await waitFor(() => expect(textItem).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', keyCode: 40, which: 40 });
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: '创建图片生成节点' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'End', keyCode: 35, which: 35 });
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: '自动适配缩放' })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
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

  it('A 的本地锁不禁用 B 的快捷编辑器或右键生成，同节点两个入口保持一致', async () => {
    const a: AssetFlowNode = {
      ...generateNode,
      id: 'a',
      data: {
        ...generateNode.data,
        label: '节点 A',
        prompt: '编辑原图',
        modelAlias: 'image-model',
        credentialId: 'credential',
        resultAsset: {
          assetId: 'image-a',
          contentUrl: 'https://assets.example/image.png',
          mimeType: 'image/png',
        },
      },
    };
    const b: AssetFlowNode = { ...a, id: 'b', data: { ...a.data, label: '节点 B' } };
    const props = createProps({
      nodes: [a, b],
      selectedNode: b,
      busyNodeIds: new Set(['a']),
      models: [
        {
          id: 'image-model',
          name: '图片模型',
          mediaTypes: ['image'],
          credentialId: 'credential',
          group: '测试分组',
        },
      ],
    });
    const view = render(<WorkflowCanvas {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRunNode).toHaveBeenLastCalledWith(b, 'sameNode');
    fireEvent.contextMenu(screen.getByTestId('canvas-node-b'));
    for (const name of ['开始生成', '生成到新节点']) {
      expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true');
    }
    await userEvent.click(screen.getByRole('menuitem', { name: '开始生成' }));
    expect(props.onRunNode).toHaveBeenLastCalledWith(b);
    view.rerender(<WorkflowCanvas {...props} selectedNode={a} />);
    expect(screen.getByRole('button', { name: '生成中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
    fireEvent.contextMenu(screen.getByTestId('canvas-node-a'));
    for (const name of ['开始生成', '生成到新节点']) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    }
    expect(props.onRunNode).toHaveBeenCalledTimes(2);
  });

  it.each(['queued', 'preparing', 'running', 'processing', 'cancel_requested'] as const)(
    '恢复 %s 时同步禁用快捷编辑器和已经打开的右键菜单，终态恢复可用',
    (status) => {
      const node: AssetFlowNode = {
        ...generateNode,
        data: {
          ...generateNode.data,
          prompt: '编辑原图',
          modelAlias: 'image-model',
          credentialId: 'credential',
          resultAsset: {
            assetId: 'image-a',
            contentUrl: 'https://assets.example/image.png',
            mimeType: 'image/png',
          },
        },
      };
      const props = createProps({
        nodes: [node],
        selectedNode: node,
        models: [
          {
            id: 'image-model',
            name: '图片模型',
            mediaTypes: ['image'],
            credentialId: 'credential',
            group: '测试分组',
          },
        ],
      });
      const view = render(<WorkflowCanvas {...props} />);
      fireEvent.contextMenu(screen.getByTestId('canvas-node-' + node.id));
      const active = { ...node, data: { ...node.data, runStatus: status } };
      view.rerender(<WorkflowCanvas {...props} nodes={[active]} selectedNode={active} />);
      expect(screen.getByRole('button', { name: '生成中' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
      expect(screen.getByRole('menuitem', { name: '开始生成' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: '生成到新节点' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      const completed = { ...node, data: { ...node.data, runStatus: 'succeeded' as const } };
      view.rerender(<WorkflowCanvas {...props} nodes={[completed]} selectedNode={completed} />);
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      expect(screen.getByRole('menuitem', { name: '开始生成' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    },
  );

  it('连线资源命名带上实际编辑节点 ID，不调用提示词或视频模式回调', async () => {
    const source: AssetFlowNode = {
      ...sourceNode,
      data: {
        ...sourceNode.data,
        assetId: 'connected-image',
        contentUrl: 'https://assets.example/image.png',
        mimeType: 'image/png',
      },
    };
    const target: AssetFlowNode = {
      ...generateNode,
      data: { ...generateNode.data, prompt: '保持原提示词' },
    };
    const props = createProps({
      nodes: [source, target],
      selectedNode: target,
      edges: [
        { id: 'connected', source: source.id, target: target.id, targetHandle: 'input:content' },
      ],
      onConnectedResourceRename: vi.fn(),
      onPromptDocumentChange: vi.fn(),
      onVideoModeChange: vi.fn(),
    });
    render(<WorkflowCanvas {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '预览并命名 图片来源节点' }));
    const dialog = screen.getByRole('dialog', { name: '资源预览' });
    const name = within(dialog).getByRole('textbox', { name: '资源名称' });
    await user.clear(name);
    await user.type(name, '主角');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(props.onConnectedResourceRename).toHaveBeenCalledExactlyOnceWith(
      'connected-image',
      '主角',
      target.id,
    );
    expect(props.onPromptDocumentChange).not.toHaveBeenCalled();
    expect(props.onVideoModeChange).not.toHaveBeenCalled();
    expect(source.data.label).toBe('图片来源节点');
  });

  it('运行中的节点禁用生成与图片编辑，仍可查看提示词', async () => {
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
    for (const name of ['开始生成', '生成到新节点', '修改图片']) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(item);
    }
    expect(props.onRunNode).not.toHaveBeenCalled();
    expect(props.onEditImage).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: '提示词' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitem', { name: '提示词' }));
    expect(props.onOpenRequestPrompt).toHaveBeenCalledWith(node.id);
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
    expect(screen.getByRole('menuitem', { name: '重做' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: '重做' }));
    expect(props.onRedoCanvas).not.toHaveBeenCalled();
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

  it('窗口缩放时锚点约束到视口，新节点仍使用冻结右键坐标', async () => {
    const user = userEvent.setup();
    const props = createProps();
    const clickPosition = { x: window.innerWidth, y: window.innerHeight };
    render(<WorkflowCanvas {...props} />);
    fireEvent.contextMenu(screen.getByTestId('canvas-pane'), {
      clientX: clickPosition.x,
      clientY: clickPosition.y,
    });
    const menu = await screen.findByRole('menu', { name: '画布操作' });
    expect(menu.closest('.canvas-context-dropdown')).toHaveClass('ant-dropdown');
    expectContextMenuAnchor(menu, clickPosition);
    try {
      vi.stubGlobal('innerWidth', 900);
      vi.stubGlobal('innerHeight', 700);
      fireEvent(window, new Event('resize'));
      // 屏幕锚点跟随视口约束，库浮层的真实避让在 Playwright 中测量。
      expectContextMenuAnchor(menu, clickPosition);
      await user.click(screen.getByRole('menuitem', { name: '创建图片生成节点' }));
      expect(props.onAddGenerateNode).toHaveBeenCalledWith('image', {
        x: clickPosition.x - 100,
        y: clickPosition.y - 50,
      });
    } finally {
      vi.unstubAllGlobals();
    }
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
      expect(await screen.findByRole('dialog', { name: imageNode.data.label })).toBeInTheDocument();
    },
  );

  it('只在节点上下布局双倍宽编辑器，不能向上挤进节点或超出画布', async () => {
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
    expect(overlay).toHaveStyle({ visibility: 'visible', width: '360px', left: '290px' });
    expect(overlay?.closest('.react-flow__node')).toBeNull();
    expect(
      Number.parseInt(overlay?.style.top ?? '', 10) +
        Number.parseInt(overlay?.style.getPropertyValue('--quick-editor-max-height') ?? '', 10),
    ).toBeLessThanOrEqual(620 - 64);

    nodeRect = createMockRect(380, 150, 180, 80);
    canvasNode.style.transform = 'translate(1px)';
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'below'));
    expect(overlay).toHaveStyle({ width: '360px', left: '290px' });
    expect(Number.parseInt(overlay?.style.top ?? '', 10)).toBeGreaterThan(230);

    nodeRect = createMockRect(600, 350, 180, 80);
    canvasNode.style.transform = 'translate(2px)';
    await waitFor(() => {
      expect(overlay).toHaveAttribute('data-placement', 'below');
      expect(overlay).toHaveStyle({ width: '360px', left: '432px' });
    });
    expect(Number.parseInt(overlay?.style.top ?? '', 10)).toBeGreaterThanOrEqual(90);
    expect(
      Number.parseInt(overlay?.style.top ?? '', 10) +
        Number.parseInt(overlay?.style.getPropertyValue('--quick-editor-max-height') ?? '', 10),
    ).toBeLessThanOrEqual(90 + 620);

    nodeRect = createMockRect(600, 570, 180, 80);
    canvasNode.style.transform = 'translate(3px)';
    await waitFor(() => {
      expect(overlay).toHaveAttribute('data-placement', 'above');
      expect(overlay).toHaveStyle({ left: '432px', width: '360px' });
    });
    expect(Number.parseInt(overlay?.style.top ?? '', 10)).toBeLessThanOrEqual(nodeRect.top - 64);
  });

  it('按真实面板高度连续拖动：触边前不换向，超过节点四分之三才换向且不缩成细条', async () => {
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    // scrollHeight 取整为 219，布局预留 1px 后允许 220px 内容，不能使用固定 400px 来提前换边。
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('node-quick-editor') ? 219 : 0;
    });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    let nodeRect = createMockRect(380, 150, 180, 80);

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(80, 90, 720, 620));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockImplementation(() => nodeRect);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

    const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
    const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay')!;
    await waitFor(() => expect(overlay).toHaveAttribute('data-placement', 'below'));
    const path = [
      150, 190, 220, 260, 300, 340, 380, 385, 386, 387, 400, 380, 386, 445, 446, 447, 446, 445, 447,
    ];
    for (const [frame, top] of path.entries()) {
      await act(async () => {
        nodeRect = createMockRect(380, top, 180, 80);
        canvasNode.style.transform = 'translate(' + frame + 'px)';
      });
      const switched = frame >= path.indexOf(447);
      expect(overlay).toHaveAttribute('data-placement', switched ? 'above' : 'below');
      expect(overlay).toHaveStyle({ visibility: 'visible', width: '360px', left: '290px' });
      const maxHeight = Number.parseFloat(
        overlay.style.getPropertyValue('--quick-editor-max-height'),
      );
      const overlayTop = Number.parseFloat(overlay.style.top);
      expect(maxHeight).toBe(220);
      expect(overlayTop).toBe(switched ? top - 64 - 220 : Math.min(top + 80 + 16, 482));
      expect(overlayTop).toBeGreaterThanOrEqual(98);
      expect(overlayTop + maxHeight).toBeLessThanOrEqual(702);
    }
    expect(props.onResizeNode).not.toHaveBeenCalled();
    expect(props.onNodesChange).not.toHaveBeenCalled();
  });

  it('内容增高后重新测量自然高度，不保留过小初始高度制造常态滚动条', async () => {
    let contentHeight = 199;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('node-quick-editor') ? contentHeight : 0;
    });
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(80, 90, 720, 620));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockReturnValue(
      createMockRect(380, 150, 180, 80),
    );
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);
    const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
    const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay')!;
    expect(overlay.style.getPropertyValue('--quick-editor-max-height')).toBe('200px');
    await act(async () => {
      contentHeight = 449;
      // DOM 子树变化模拟参数/资源内容增加，必须唤醒自然高度测量而非依赖外框变大。
      editor.append(document.createElement('span'));
    });
    expect(overlay).toHaveAttribute('data-placement', 'below');
    expect(overlay.style.getPropertyValue('--quick-editor-max-height')).toBe('450px');
    expect(overlay).toHaveStyle({ top: '246px', width: '360px' });
  });

  it.each([
    { name: '窄画布', viewportWidth: 1024, canvasLeft: 120, canvasWidth: 480, width: 464 },
    { name: '窄视口', viewportWidth: 560, canvasLeft: 0, canvasWidth: 900, width: 544 },
  ])(
    '在$name内约束双倍宽编辑器，空间恢复后还原节点两倍宽度',
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
        createMockRect(200, 150, 570, 80),
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

      innerWidth.mockReturnValue(1600);
      bounds.mockReturnValue(createMockRect(0, 90, 1600, 620));
      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(overlay).toHaveStyle({ width: '1140px' }));
    },
  );

  it.each([0.25, 0.5, 1, 1.5])(
    '输入面板跟随画布倍率 %s 缩放，屏幕宽度保持节点两倍且定位有界',
    async (zoom) => {
      reactFlowMock.viewportZoom = zoom;
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
      const props = createProps({ nodes: [generateNode], selectedNode: null });
      const { rerender } = render(<WorkflowCanvas {...props} />);
      const canvas = screen.getByRole('region', { name: '工作流画布' });
      const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(0, 80, 1600, 920));
      const nodeRect = createMockRect(500, 200, 400 * zoom, 266 * zoom);
      vi.spyOn(canvasNode, 'getBoundingClientRect').mockReturnValue(nodeRect);
      rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

      const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
      const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay')!;
      expect(overlay).toHaveStyle({
        visibility: 'visible',
        width: '800px',
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
      });
      const left = Number.parseFloat(overlay.style.left);
      const top = Number.parseFloat(overlay.style.top);
      const height = Number.parseFloat(overlay.style.getPropertyValue('--quick-editor-max-height'));
      const screenWidth = Number.parseFloat(overlay.style.width) * zoom;
      expect(screenWidth).toBe(nodeRect.width * 2);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + screenWidth).toBeLessThanOrEqual(1592);
      expect(top).toBeGreaterThanOrEqual(nodeRect.bottom + 16 * zoom);
      expect(top + height * zoom).toBeLessThanOrEqual(992);
      expect(overlay.closest('.react-flow__node')).toBeNull();
      expect(props.onResizeNode).not.toHaveBeenCalled();
    },
  );

  it('画布缩放及手动缩放节点后保持双倍宽度，提示词内容不改变节点外框', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    let nodeRect = createMockRect(400, 160, 400, 266);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(0, 80, 1600, 920));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockImplementation(() => nodeRect);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);
    const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
    const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay')!;
    expect(overlay).toHaveStyle({ width: '800px', transform: 'scale(1)' });

    reactFlowMock.viewportZoom = 0.5;
    nodeRect = createMockRect(400, 160, 200, 133);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);
    await waitFor(() => expect(overlay).toHaveStyle({ width: '800px', transform: 'scale(0.5)' }));
    expect(Number.parseFloat(overlay.style.width) * 0.5).toBe(nodeRect.width * 2);

    nodeRect = createMockRect(400, 160, 120, 133);
    canvasNode.style.width = '240px';
    await waitFor(() => expect(overlay).toHaveStyle({ width: '480px', transform: 'scale(0.5)' }));
    expect(Number.parseFloat(overlay.style.width) * 0.5).toBe(nodeRect.width * 2);

    nodeRect = createMockRect(400, 160, 320, 133);
    canvasNode.style.width = '640px';
    await waitFor(() => expect(overlay).toHaveStyle({ width: '1280px', transform: 'scale(0.5)' }));
    expect(Number.parseFloat(overlay.style.width) * 0.5).toBe(nodeRect.width * 2);

    const editedNode: AssetFlowNode = {
      ...generateNode,
      data: { ...generateNode.data, prompt: '不会撑大节点的长提示词'.repeat(100) },
    };
    rerender(<WorkflowCanvas {...props} nodes={[editedNode]} selectedNode={editedNode} />);
    fireEvent.scroll(window);
    expect(overlay).toHaveStyle({ width: '1280px', transform: 'scale(0.5)' });
    expect(overlay.closest('.react-flow__node')).toBeNull();
    expect(canvasNode).toHaveStyle({ width: '640px' });
    expect(props.onNodesChange).not.toHaveBeenCalled();
    expect(props.onResizeNode).not.toHaveBeenCalled();
    expect(generateNode).not.toHaveProperty('width');
  });

  it.each(['鼠标', '键盘'])('放大后通过%s聚焦不移位，也不锁定滚动和后续测量', async (method) => {
    reactFlowMock.viewportZoom = 1.5;
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('node-quick-editor') ? 269 : 0;
    });
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId('canvas-node-' + generateNode.id);
    let nodeRect = createMockRect(500, 200, 300, 180);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(0, 80, 1600, 920));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockImplementation(() => nodeRect);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

    const editor = await screen.findByRole('region', { name: '图片生成节点生成设置' });
    const overlay = editor.closest<HTMLDivElement>('.quick-editor-overlay')!;
    const textarea = within(editor).getByLabelText<HTMLTextAreaElement>('提示词');
    const before = {
      left: overlay.style.left,
      top: overlay.style.top,
      width: overlay.style.width,
      transform: overlay.style.transform,
      placement: overlay.dataset.placement,
    };
    editor.scrollTop = 17;

    await act(async () => {
      // 原生点击必须能放置光标和开始拖选，不能用 preventDefault 消除表面上的跳动。
      if (method === '鼠标') expect(fireEvent.pointerDown(textarea)).toBe(true);
      textarea.focus();
      fireEvent.scroll(window);
      fireEvent.resize(window);
    });

    expect(overlay).toHaveStyle({
      left: before.left,
      top: before.top,
      width: before.width,
      transform: before.transform,
    });
    expect(overlay.dataset.placement).toBe(before.placement);
    expect(document.activeElement).toBe(textarea);
    expect(editor.scrollTop).toBe(17);
    expect(editor.style.overflowY).toBe('');

    editor.scrollTop = 42;
    fireEvent.scroll(editor);
    expect(editor.scrollTop).toBe(42);
    expect(document.activeElement).toBe(textarea);

    nodeRect = createMockRect(500, 240, 300, 180);
    canvasNode.style.transform = 'translateY(40px)';
    await waitFor(() =>
      expect(overlay).toHaveStyle({ top: Number.parseFloat(before.top) + 40 + 'px' }),
    );
    expect(document.activeElement).toBe(textarea);
  });

  it.each([0.5, 1, 1.5])('倍率 %s 下上下空间不足时隐藏，空间恢复后还原双倍宽度', async (zoom) => {
    reactFlowMock.viewportZoom = zoom;
    const props = createProps({ nodes: [generateNode], selectedNode: null });
    const { rerender } = render(<WorkflowCanvas {...props} />);
    const canvas = screen.getByRole('region', { name: '工作流画布' });
    const canvasNode = screen.getByTestId(`canvas-node-${generateNode.id}`);
    let nodeRect = createMockRect(110, 0, 520, 710);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(createMockRect(80, 90, 720, 620));
    vi.spyOn(canvasNode, 'getBoundingClientRect').mockImplementation(() => nodeRect);
    rerender(<WorkflowCanvas {...props} selectedNode={generateNode} />);

    await waitFor(() => expect(document.querySelector('.quick-editor-overlay')).not.toBeNull());
    const overlay = document.querySelector<HTMLDivElement>('.quick-editor-overlay')!;
    expect(overlay).toHaveAttribute('data-placement', 'below');
    expect(overlay).toHaveStyle({ visibility: 'hidden' });

    nodeRect = createMockRect(70, 80, 740, 640);
    canvasNode.style.transform = 'translate(1px)';
    await waitFor(() => expect(overlay).toHaveStyle({ visibility: 'hidden' }));

    nodeRect = createMockRect(380, 150, 180 * zoom, 80 * zoom);
    canvasNode.style.transform = 'translate(2px)';
    await waitFor(() =>
      expect(overlay).toHaveStyle({
        visibility: 'visible',
        width: '360px',
        transform: `scale(${zoom})`,
      }),
    );
    expect(overlay).toHaveAttribute('data-placement', 'below');
    expect(Number.parseFloat(overlay.style.width) * zoom).toBe(nodeRect.width * 2);
    expect(Number.parseFloat(overlay.style.top)).toBeGreaterThanOrEqual(
      nodeRect.bottom + 16 * zoom,
    );
    expect(overlay.closest('.react-flow__node')).toBeNull();
    expect(props.onNodesChange).not.toHaveBeenCalled();
    expect(props.onResizeNode).not.toHaveBeenCalled();
  });

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
    expectContextMenuAnchor(menu, { x: 320, y: 210 });
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

/** 节点探针保留真实 Context 订阅，隔离媒体解码和 jsdom 布局耗时。 */
const DragRenderProbe = memo(function DragRenderProbe({ node }: { node: AssetFlowNode }) {
  const select = useContext(NodeSelectionContext);
  const batch = useContext(GenerationBatchViewContext);
  const remove = useContext(NodeDeleteContext);
  const prompt = useContext(NodePromptContext);
  dragNodeRender(node.id);
  return (
    <>
      <button
        onClick={() => select?.(node.data)}
        data-batch-count={batch.views.get(node.id)?.count}
        data-batch-expanded={String(batch.views.get(node.id)?.expanded)}
        data-batch-hidden={String(batch.views.get(node.id)?.hidden)}
        data-x={node.position.x}
        data-y={node.position.y}
      >
        {node.data.label}
      </button>
      {remove && <button onClick={() => remove(node.id)}>{'删除 ' + node.data.label}</button>}
      {prompt && <button onClick={() => prompt(node.id)}>{'提示词 ' + node.data.label}</button>}
    </>
  );
});

/** 每次节点内容提交的计数器；测试不触发项目保存或真实生成。 */
const dragNodeRender = vi.fn();

describe('WorkflowCanvas 拖动性能', () => {
  it('位置帧不更换 store 配置和事件引用，稳定入口仍读取最新节点变化回调', () => {
    reactFlowMock.nodeProbe = DragRenderProbe;
    const props = createProps({
      nodes: [generateNode],
      onNodeDrag: vi.fn(),
      onNodeDragStop: vi.fn(),
    });
    const view = render(<WorkflowCanvas {...props} />);
    const initial = reactFlowMock.storeProps;
    for (let frame = 1; frame <= 20; frame++) {
      view.rerender(
        <WorkflowCanvas
          {...props}
          nodes={[
            {
              ...generateNode,
              position: { x: frame * 10, y: 20 },
              dragging: true,
            },
          ]}
        />,
      );
      for (const key of Object.keys(initial))
        expect(reactFlowMock.storeProps[key], key).toBe(initial[key]);
    }
    const replacement = vi.fn();
    view.rerender(<WorkflowCanvas {...props} onNodesChange={replacement} />);
    expect(reactFlowMock.onNodesChange).toBe(initial.onNodesChange);
    const changes = [
      { id: generateNode.id, type: 'position' as const, position: { x: 50, y: 70 } },
    ];
    act(() => reactFlowMock.onNodesChange!(changes));
    expect(replacement).toHaveBeenCalledWith(changes);
    expect(props.onNodesChange).not.toHaveBeenCalled();
  });
  it('参数表单仍响应内容、上游资源、连线、目录和忙碌状态，并使用替换后的回调', () => {
    reactFlowMock.nodeProbe = DragRenderProbe;
    const node = { ...generateNode, data: { ...generateNode.data, prompt: 'Draw a boat.' } };
    let props = createProps({ nodes: [node, sourceNode], selectedNode: node });
    const view = render(<WorkflowCanvas {...props} />);
    const currentEditor = () =>
      quickEditorRender.mock.lastCall![0] as import('./NodeQuickEditor').NodeQuickEditorProps;
    quickEditorRender.mockClear();
    props = { ...props, busyNodeIds: new Set() };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(quickEditorRender).not.toHaveBeenCalled();
    const changed = { ...node, data: { ...node.data, prompt: 'Draw a red boat.' } };
    props = { ...props, nodes: [changed, sourceNode], selectedNode: changed };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(currentEditor().node.data.prompt).toBe('Draw a red boat.');
    const input = {
      ...sourceNode,
      data: {
        ...sourceNode.data,
        label: '新来源',
        assetId: 'upstream',
        contentUrl: '/v1/assets/upstream/content',
      },
    };
    props = {
      ...props,
      nodes: [changed, input],
      edges: [
        {
          id: 'edge',
          source: input.id,
          target: changed.id,
          sourceHandle: 'output:image',
          targetHandle: 'input:reference',
        },
      ],
    };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(currentEditor().connectedAssets?.[0]?.name).toBe('新来源');
    expect(currentEditor().hasConnectedInput).toBe(true);
    props = { ...props, busyNodeIds: new Set([changed.id]) };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(currentEditor().busy).toBe(true);
    const replacement = vi.fn();
    props = {
      ...props,
      busyNodeIds: new Set(),
      onPromptChange: replacement,
      assets: [
        {
          id: 'catalog',
          contentUrl: '/v1/assets/catalog/content',
          name: '目录资源',
          mediaType: 'text',
          mimeType: 'text/plain',
          status: 'ready',
          sizeBytes: 1,
          tags: [],
        },
      ],
    };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(currentEditor().busy).toBe(false);
    expect(currentEditor().assets?.[0]?.name).toBe('目录资源');
    currentEditor().onPromptChange?.('更新');
    expect(replacement).toHaveBeenLastCalledWith('更新', changed.id);
    props = { ...props, nodes: [input], selectedNode: null };
    view.rerender(<WorkflowCanvas {...props} />);
    expect(document.querySelector('.quick-editor-overlay')).not.toBeInTheDocument();
  });

  it('参数编辑器在 30 次位置更新中不重渲染，运行时仍读取最新坐标', () => {
    reactFlowMock.nodeProbe = DragRenderProbe;
    let node = { ...generateNode, data: { ...generateNode.data, prompt: 'Draw a boat.' } };
    const props = createProps({ nodes: [node, sourceNode], selectedNode: node });
    const view = render(<WorkflowCanvas {...props} />);
    quickEditorRender.mockClear();
    for (let step = 1; step <= 30; step++) {
      node = { ...node, position: { x: step * 5, y: step * 3 }, dragging: true };
      view.rerender(<WorkflowCanvas {...props} nodes={[node, sourceNode]} selectedNode={node} />);
    }
    expect(quickEditorRender).toHaveBeenCalledTimes(0);
    fireEvent.click(screen.getByRole('button', { name: /^生成$/ }));
    expect(props.onRunNode).toHaveBeenLastCalledWith(node, 'sameNode');
  });

  it('48 节点连续 12 次位置更新的节点渲染计数，并使用最新选择回调和坐标', () => {
    reactFlowMock.nodeProbe = DragRenderProbe;
    let nodes = Array.from({ length: 48 }, (_, index) => ({
      ...sourceNode,
      id: 'drag-' + index,
      position: { x: index * 100, y: 0 },
      data: { ...sourceNode.data, label: '拖动节点 ' + index },
    }));
    const props = createProps({ nodes });
    const selected = vi.fn();
    const deleted = vi.fn();
    const prompted = vi.fn();
    const view = render(<WorkflowCanvas {...props} onOpenRequestPrompt={() => {}} />);
    dragNodeRender.mockClear();
    for (let step = 1; step <= 12; step++) {
      nodes = nodes.map((node, index) =>
        index === 0 ? { ...node, position: { x: step * 10, y: step * 5 }, dragging: true } : node,
      );
      view.rerender(
        <WorkflowCanvas
          {...props}
          nodes={nodes}
          onNodeSelect={(node) => selected(step, node)}
          onDeleteNode={(id) => deleted(step, id)}
          onOpenRequestPrompt={(id) => prompted(step, id)}
        />,
      );
    }
    expect(dragNodeRender).toHaveBeenCalledTimes(12);
    expect(dragNodeRender.mock.calls.filter(([id]) => id !== 'drag-0')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '拖动节点 0' }));
    expect(selected).toHaveBeenCalledWith(12, nodes[0]);
    fireEvent.click(screen.getByRole('button', { name: '删除 拖动节点 0' }));
    fireEvent.click(screen.getByRole('button', { name: '提示词 拖动节点 0' }));
    expect(deleted).toHaveBeenCalledWith(12, 'drag-0');
    expect(prompted).toHaveBeenCalledWith(12, 'drag-0');
    expect(props.onDeleteNode).not.toHaveBeenCalled();
    view.rerender(
      <WorkflowCanvas
        {...props}
        nodes={nodes}
        onDeleteNode={undefined}
        onOpenRequestPrompt={undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: '删除 拖动节点 0' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提示词 拖动节点 0' })).not.toBeInTheDocument();
    expect(props.onNodeSelect).not.toHaveBeenCalled();
    expect(props.onNodesChange).not.toHaveBeenCalled();
  });

  it('批次拖动保留最新真实坐标，展开和成员移除仍发布显示状态', () => {
    reactFlowMock.nodeProbe = DragRenderProbe;
    let nodes: AssetFlowNode[] = [0, 1].map((index) => ({
      ...sourceNode,
      id: 'batch-' + index,
      position: { x: 100 + index * 300, y: 100 },
      data: {
        ...sourceNode.data,
        label: '批次节点 ' + index,
        generationBatch: { id: 'batch', rootNodeId: 'batch-0', index },
      },
    }));
    nodes.push({ ...sourceNode, id: 'unrelated' });
    const props = createProps({ nodes });
    const view = render(<WorkflowCanvas {...props} />);
    dragNodeRender.mockClear();
    nodes = nodes.map((node, index) =>
      index < 2 ? { ...node, position: { x: node.position.x + 20, y: 110 }, dragging: true } : node,
    );
    view.rerender(<WorkflowCanvas {...props} nodes={nodes} />);
    expect(dragNodeRender.mock.calls.filter(([id]) => id === 'unrelated')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '批次节点 1' })).toHaveAttribute('data-x', '130');
    reactFlowMock.onNodesChange?.([
      { id: 'batch-0', type: 'position', position: { x: 150, y: 140 }, dragging: false },
      { id: 'batch-1', type: 'select', selected: true },
    ]);
    expect(props.onNodesChange).toHaveBeenLastCalledWith([
      { id: 'batch-0', type: 'position', position: { x: 150, y: 140 }, dragging: false },
      { id: 'batch-1', type: 'position', position: { x: 450, y: 140 }, dragging: false },
    ]);
    nodes = nodes.map((node, index) =>
      index === 0 ? { ...node, data: { ...node.data, generationBatchExpanded: true } } : node,
    );
    view.rerender(<WorkflowCanvas {...props} nodes={nodes} />);
    expect(screen.getByRole('button', { name: '批次节点 1' })).toHaveAttribute(
      'data-batch-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: '批次节点 1' })).toHaveAttribute(
      'data-batch-hidden',
      'false',
    );
    expect(screen.getByRole('button', { name: '批次节点 1' })).toHaveAttribute('data-x', '420');
    const independentMove = [
      { id: 'batch-1', type: 'position' as const, position: { x: 500, y: 200 } },
    ];
    reactFlowMock.onNodesChange?.(independentMove);
    expect(props.onNodesChange).toHaveBeenLastCalledWith(independentMove);
    view.rerender(
      <WorkflowCanvas {...props} nodes={nodes.filter((node) => node.id !== 'batch-1')} />,
    );
    expect(screen.getByRole('button', { name: '批次节点 0' })).not.toHaveAttribute(
      'data-batch-count',
    );
  });
});

describe('WorkflowCanvas 拖动时暂隐连线', () => {
  it('持续拖动复用隐藏边，松手恢复原边，不发布删除或新增事件', () => {
    const nodes = [sourceNode, { ...sourceNode, id: 'target' }, { ...sourceNode, id: 'other' }];
    const edge = { id: 'drag-edge', source: sourceNode.id, target: 'target' };
    const unrelated = { id: 'other-edge', source: 'target', target: 'other' };
    const props = createProps({ nodes, edges: [edge, unrelated] });
    const view = render(<WorkflowCanvas {...props} />);
    expect(reactFlowMock.edges[0]).toBe(edge);
    view.rerender(
      <WorkflowCanvas
        {...props}
        nodes={nodes.map((node, index) => (index === 0 ? { ...node, dragging: true } : node))}
      />,
    );
    expect(screen.getByRole('region', { name: '工作流画布' })).toHaveClass('is-node-dragging');
    const hiddenEdges = reactFlowMock.edges;
    const hidden = hiddenEdges[0];
    expect(hidden).toEqual({ ...edge, hidden: true });
    expect(reactFlowMock.edges[1]).toBe(unrelated);
    for (let step = 1; step <= 20; step++) {
      view.rerender(
        <WorkflowCanvas
          {...props}
          nodes={nodes.map((node, index) =>
            index === 0 ? { ...node, dragging: true, position: { x: step * 10, y: 0 } } : node,
          )}
        />,
      );
      expect(reactFlowMock.edges).toBe(hiddenEdges);
      expect(reactFlowMock.edges[0]).toBe(hidden);
    }
    view.rerender(
      <WorkflowCanvas {...props} nodes={nodes.map((node) => ({ ...node, dragging: false }))} />,
    );
    expect(reactFlowMock.edges[0]).toBe(edge);
    expect(reactFlowMock.edges[1]).toBe(unrelated);
    expect(screen.getByRole('region', { name: '工作流画布' })).not.toHaveClass('is-node-dragging');
    expect(props.onNodesChange).not.toHaveBeenCalled();
    expect(props.onEdgesChange).not.toHaveBeenCalled();
    expect(props.onConnect).not.toHaveBeenCalled();
  });

  it('多选拖动与中途连线更新读取最新数据，结束不恢复已删除边', () => {
    const nodes = [sourceNode, { ...sourceNode, id: 'second' }, { ...sourceNode, id: 'target' }];
    const edges = [
      { id: 'first', source: sourceNode.id, target: 'target' },
      { id: 'second', source: 'second', target: 'target' },
    ];
    const props = createProps({ nodes, edges });
    const view = render(
      <WorkflowCanvas
        {...props}
        nodes={nodes.map((node) => ({ ...node, dragging: node.id !== 'target' }))}
      />,
    );
    expect(reactFlowMock.edges.every((edge) => edge.hidden)).toBe(true);
    const latestEdges = [{ ...edges[1]!, selected: true }];
    view.rerender(
      <WorkflowCanvas
        {...props}
        edges={latestEdges}
        nodes={nodes.map((node) => ({ ...node, dragging: node.id === 'second' }))}
      />,
    );
    expect(reactFlowMock.edges).toEqual([{ ...latestEdges[0], hidden: true }]);
    view.rerender(<WorkflowCanvas {...props} edges={latestEdges} />);
    expect(reactFlowMock.edges).toEqual(latestEdges);
    expect(reactFlowMock.edges[0]).toBe(latestEdges[0]);
    expect(props.onEdgesChange).not.toHaveBeenCalled();
  });

  it('批次收起时的隐藏状态不会被松手恢复覆盖', () => {
    const nodes = [0, 1].map((index) => ({
      ...sourceNode,
      id: 'batch-' + index,
      data: { ...sourceNode.data, generationBatch: { id: 'batch', rootNodeId: 'batch-0', index } },
    }));
    nodes.push({ ...sourceNode, id: 'target' } as (typeof nodes)[number]);
    const edges = [
      { id: 'root-edge', source: 'batch-0', target: 'target' },
      { id: 'child-edge', source: 'batch-1', target: 'target' },
    ];
    const props = createProps({ nodes, edges });
    const view = render(
      <WorkflowCanvas
        {...props}
        nodes={nodes.map((node) => ({ ...node, dragging: node.id !== 'target' }))}
      />,
    );
    expect(reactFlowMock.edges.every((edge) => edge.hidden)).toBe(true);
    view.rerender(<WorkflowCanvas {...props} />);
    expect(reactFlowMock.edges[0]).toBe(edges[0]);
    expect(reactFlowMock.edges[1]).toEqual({ ...edges[1], hidden: true });
    expect(edges.some((edge) => 'hidden' in edge)).toBe(false);
  });
});

/** 覆盖真实节点捕获回调与画布冒泡回调，不改编辑器和工具栏测试。 */
describe('WorkflowCanvas 选区资源入口', () => {
  it('左键框选，保留中键/空格平移与跨平台修饰键多选', () => {
    render(<WorkflowCanvas {...createProps()} />);
    expect(reactFlowMock.storeProps).toMatchObject({
      selectionOnDrag: true,
      panOnDrag: [1],
      multiSelectionKeyCode: ['Control', 'Meta', 'Shift'],
    });
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey'])('%s 点击节点本体不触发独占选择', (modifier) => {
    const props = createProps({ nodes: [sourceNode, generateNode] });
    render(<WorkflowCanvas {...props} />);
    const body = screen
      .getByTestId('canvas-node-' + sourceNode.id)
      .querySelector('.flow-asset-node')!;
    fireEvent.click(body, { [modifier]: true });
    expect(props.onNodeSelect).not.toHaveBeenCalled();
  });

  it.each(['canvas-selection', 'canvas-pane', 'canvas-node-node-source'])(
    '从 %s 右键新建保留多选，并使用菜单的画布坐标',
    async (entry) => {
      const nodes = [sourceNode, generateNode].map((node) => ({ ...node, selected: true }));
      const props = createProps({ nodes, onAddSelectionGenerateNode: vi.fn() });
      render(<WorkflowCanvas {...props} />);
      fireEvent.contextMenu(screen.getByTestId(entry), { clientX: 720, clientY: 410 });
      expect(await screen.findByRole('menu', { name: '引用选中节点新建' })).toBeInTheDocument();
      expect(screen.getByText('引用选中的 2 个节点新建（保留选区）')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: '引用选区新建图片节点' }));
      expect(props.onAddSelectionGenerateNode).toHaveBeenCalledWith('image', { x: 620, y: 360 });
      expect(props.onNodeSelect).not.toHaveBeenCalled();
      expect(props.onClearNodeSelection).not.toHaveBeenCalled();
      expect(props.onRunNode).not.toHaveBeenCalled();
      expect(props.onAddGenerateNode).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu', { name: '引用选中节点新建' })).not.toBeInTheDocument();
    },
  );

  it('点击已有多选成员不塌缩选区，右键其他节点仍按原单节点合同选择', async () => {
    const nodes = [
      { ...sourceNode, selected: true },
      { ...generateNode, selected: true },
      { ...sourceNode, id: 'other' },
    ];
    const props = createProps({ nodes, onAddSelectionGenerateNode: vi.fn() });
    render(<WorkflowCanvas {...props} />);
    fireEvent.click(
      screen.getByTestId('canvas-node-' + sourceNode.id).querySelector('.flow-asset-node')!,
    );
    expect(props.onNodeSelect).toHaveBeenCalledWith(nodes[0]);
    fireEvent.contextMenu(screen.getByTestId('canvas-node-other'));
    expect(
      await screen.findByRole('menu', { name: sourceNode.data.label + '节点操作' }),
    ).toBeInTheDocument();
    expect(props.onNodeSelect).toHaveBeenCalledWith(nodes[2]);
  });

  it('菜单按实时可见选区计数，收起批次隐藏成员不计入，清空后禁止旧菜单创建', async () => {
    const nodes = [sourceNode, generateNode].map((node, index) => ({
      ...node,
      selected: true,
      data: { ...node.data, generationBatch: { id: 'batch', rootNodeId: sourceNode.id, index } },
    }));
    const props = createProps({ nodes, onAddSelectionGenerateNode: vi.fn() });
    const view = render(<WorkflowCanvas {...props} />);
    fireEvent.contextMenu(screen.getByTestId('canvas-pane'));
    expect(await screen.findByText('引用选中的 1 个节点新建（保留选区）')).toBeInTheDocument();
    view.rerender(
      <WorkflowCanvas {...props} nodes={nodes.map((node) => ({ ...node, selected: false }))} />,
    );
    const create = screen.getByRole('menuitem', { name: '引用选区新建图片节点' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(create);
    expect(props.onAddSelectionGenerateNode).not.toHaveBeenCalled();
  });
});

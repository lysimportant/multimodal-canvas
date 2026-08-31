import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';

const reactFlowMock = vi.hoisted(() => ({
  getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 180, height: 120 })),
  getZoom: vi.fn(() => 1),
  setCenter: vi.fn(),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  function ReactFlow({
    nodes,
    onNodeClick,
    onNodeContextMenu,
    onPaneClick,
    onPaneContextMenu,
    defaultEdgeOptions,
    minZoom,
    fitViewOptions,
    children,
  }: {
    nodes: AssetFlowNode[];
    defaultEdgeOptions?: { animated?: boolean; style?: Record<string, unknown> };
    onNodeClick?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onNodeContextMenu?: (event: React.MouseEvent, node: AssetFlowNode) => void;
    onPaneClick?: () => void;
    onPaneContextMenu?: React.MouseEventHandler<HTMLDivElement>;
    minZoom?: number;
    fitViewOptions?: { minZoom?: number };
    children?: React.ReactNode;
  }) {
    return (
      <div
        data-testid="react-flow"
        data-default-edge-animated={String(Boolean(defaultEdgeOptions?.animated))}
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
        {nodes.map((node) => (
          <div
            key={node.id}
            data-testid={`canvas-node-${node.id}`}
            className="react-flow__node"
            tabIndex={0}
            onClick={(event) => onNodeClick?.(event, node)}
            onContextMenu={(event) => onNodeContextMenu?.(event, node)}
          >
            {node.data.label}
          </div>
        ))}
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
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
        x: x - 100,
        y: y - 50,
      }),
      getNodesBounds: reactFlowMock.getNodesBounds,
      getZoom: reactFlowMock.getZoom,
      setCenter: reactFlowMock.setCenter,
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
    onAddTransformNode: vi.fn(),
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
    await user.click(screen.getByRole('menuitem', { name: '创建视频转换节点' }));
    expect(props.onAddTransformNode).toHaveBeenCalledWith('video', { x: 160, y: 130 });

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
    expect(screen.getByRole('menuitem', { name: '开始生成' })).toBeDisabled();
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
    expect(screen.getByRole('menuitem', { name: '上传资源' })).toHaveFocus();
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

  it('keeps edge animation enabled while leaving selected styling to CSS', () => {
    render(<WorkflowCanvas {...createProps()} />);

    const flow = screen.getByTestId('react-flow');
    expect(flow).toHaveAttribute('data-default-edge-animated', 'true');
    expect(flow).toHaveAttribute('data-default-edge-style', 'null');
  });

  it('allows Fit View to zoom out far enough for large persisted canvases', () => {
    render(<WorkflowCanvas {...createProps()} />);

    const flow = screen.getByTestId('react-flow');
    expect(flow).toHaveAttribute('data-fit-view-min-zoom', '0.25');
    expect(JSON.parse(flow.getAttribute('data-fit-view-options') ?? 'null')).toMatchObject({
      minZoom: 0.25,
    });
  });
});

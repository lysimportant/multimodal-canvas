import {
  Background,
  BackgroundVariant,
  Controls,
  NodeToolbar,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type OnConnectStartParams,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { FileText, LayoutGrid, Trash2, Upload } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';

import type { MediaType } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  NodeResizeContext,
  NodeResizeStartContext,
  NodeEnabledContext,
  NodeRetryContext,
  NodeSelectionContext,
  nodeTypes,
  type NodeEnabledHandler,
  type NodeResizeHandler,
} from './AssetNode';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';
import {
  CanvasContextMenu,
  type CanvasContextMenuCloseReason,
  type CanvasContextMenuTarget,
} from './CanvasContextMenu';
import {
  NodeQuickEditor,
  type InferenceStrength,
  type NodeQuickEditorProps,
} from './NodeQuickEditor';
import { getCenteredCanvasNodePosition } from './canvas-position';
import {
  ASSET_DRAG_TYPE,
  type CanvasBackground,
  type ModelEntry,
  type ModelSelection,
} from './contracts';

type CanvasContextMouseEvent = MouseEvent | ReactMouseEvent<Element>;

const NATIVE_CONTEXT_MENU_SELECTOR = [
  'textarea',
  'input',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  'a',
  'button',
  'audio',
  'video',
].join(',');

// Large persisted canvases must be able to fit below React Flow's default 0.5 zoom.
const FIT_VIEW_MIN_ZOOM = 0.25;

function shouldKeepNativeContextMenu(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(NATIVE_CONTEXT_MENU_SELECTOR));
}

/** 快速编辑器在桌面画布中的最大宽度，单位为像素。 */
const QUICK_EDITOR_MAX_WIDTH = 360;
/** 编辑器停靠节点侧面时保持可用控件布局的最小宽度，单位为像素。 */
const QUICK_EDITOR_MIN_SIDE_WIDTH = 280;
/** 快速编辑器与可见画布边界之间的最小距离，单位为像素。 */
const QUICK_EDITOR_VIEWPORT_MARGIN = 8;
/** 快速编辑器与选中节点之间的视觉间距，单位为像素。 */
const QUICK_EDITOR_NODE_GAP = 16;

/** 快速编辑器相对于视口的测量结果。 */
type QuickEditorLayout = {
  /** 浮层左边缘的视口坐标，单位为像素。 */
  left: number;
  /** 浮层上边缘的视口坐标，单位为像素。 */
  top: number;
  /** 浮层宽度，单位为像素。 */
  width: number;
  /** 浮层相对于选中节点的展开方向。 */
  placement: 'above' | 'below' | 'left' | 'right';
  /** 是否已取得可用于显示的首个布局结果。 */
  ready: boolean;
};

export type WorkflowCanvasProps = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  selectedNode: AssetFlowNode | null;
  models: ModelEntry[];
  busy: boolean;
  background: CanvasBackground;
  onNodesChange: OnNodesChange<AssetFlowNode>;
  onEdgesChange: OnEdgesChange<FlowEdge>;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  onCanvasDrop: (
    files: File[],
    assetId: string | undefined,
    position: { x: number; y: number },
  ) => void;
  onNodeSelect: (node: AssetFlowNode) => void;
  onClearNodeSelection: () => void;
  onResizeNode: NodeResizeHandler;
  onResizeStart?: (nodeId: string) => void;
  onNodeEnabledChange: NodeEnabledHandler;
  onRetryNode: (nodeId: string) => void | Promise<void>;
  onPromptChange: (value: string, nodeId?: string) => void;
  onParametersChange?: (value: Record<string, unknown>, nodeId?: string) => void;
  onModelChange: (value: ModelSelection, nodeId?: string) => void;
  onInferenceStrengthChange: (value: InferenceStrength, nodeId?: string) => void;
  onRunNode: (node: AssetFlowNode) => void;
  /** App owns graph history and persistence, so deletion is handed back to it. */
  onDeleteNode?: (nodeId: string) => void;
  onAddGenerateNode: (mediaType: MediaType, position?: { x: number; y: number }) => void;
  onAddTransformNode: (mediaType: MediaType, position?: { x: number; y: number }) => void;
  onCanvasCenterChange: (position: { x: number; y: number }) => void;
  onRequestUpload: () => void;
  onOpenProjectHub: () => void;
};

export function WorkflowCanvas({
  nodes,
  edges,
  selectedNode,
  models,
  busy,
  background,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDragStart,
  onCanvasDrop,
  onNodeSelect,
  onClearNodeSelection,
  onResizeNode,
  onResizeStart,
  onNodeEnabledChange,
  onRetryNode,
  onPromptChange,
  onParametersChange,
  onModelChange,
  onInferenceStrengthChange,
  onRunNode,
  onDeleteNode,
  onAddGenerateNode,
  onAddTransformNode,
  onCanvasCenterChange,
  onRequestUpload,
  onOpenProjectHub,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition, getNodesBounds, getZoom, setCenter } = useReactFlow();
  const canvasAreaRef = useRef<HTMLElement>(null);
  const connectionStartRef = useRef<OnConnectStartParams | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuTarget | null>(null);
  const quickEditorNode = selectedNode && selectedNode.data.mode !== 'source' ? selectedNode : null;

  const getCanvasNodePosition = useCallback(() => {
    const canvasArea = canvasAreaRef.current;
    if (!canvasArea) return undefined;
    const bounds = canvasArea.getBoundingClientRect();
    return getCenteredCanvasNodePosition(bounds, screenToFlowPosition);
  }, [screenToFlowPosition]);

  const reportCanvasCenter = useCallback(() => {
    const position = getCanvasNodePosition();
    if (position) onCanvasCenterChange(position);
  }, [getCanvasNodePosition, onCanvasCenterChange]);

  const handleCenterNode = useCallback(
    (node: AssetFlowNode) => {
      const bounds = getNodesBounds([node.id]);
      if (
        !Number.isFinite(bounds.x) ||
        !Number.isFinite(bounds.y) ||
        !Number.isFinite(bounds.width) ||
        !Number.isFinite(bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        return;
      }

      const zoom = getZoom();
      if (!Number.isFinite(zoom) || zoom <= 0) return;

      void setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
        zoom,
        duration: 220,
      });
    },
    [getNodesBounds, getZoom, setCenter],
  );

  useEffect(() => {
    reportCanvasCenter();
  }, [reportCanvasCenter]);

  const handleAddGenerateNode = useCallback(
    (mediaType: MediaType) => onAddGenerateNode(mediaType, getCanvasNodePosition()),
    [getCanvasNodePosition, onAddGenerateNode],
  );

  const handleAddTransformNode = useCallback(
    (mediaType: MediaType) => onAddTransformNode(mediaType, getCanvasNodePosition()),
    [getCanvasNodePosition, onAddTransformNode],
  );

  const selectNodeByData = useCallback(
    (data: AssetFlowNode['data']) => {
      const node =
        nodes.find((candidate) => candidate.data === data) ??
        nodes.find(
          (candidate) =>
            candidate.data.label === data.label &&
            candidate.data.mediaType === data.mediaType &&
            candidate.data.mode === data.mode,
        );
      if (node) onNodeSelect(node);
    },
    [nodes, onNodeSelect],
  );

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE) || undefined;
      onCanvasDrop(Array.from(event.dataTransfer.files), assetId, position);
    },
    [onCanvasDrop, screenToFlowPosition],
  );

  const getReturnFocusTarget = useCallback((event: CanvasContextMouseEvent) => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      return activeElement;
    }
    return event.currentTarget instanceof HTMLElement ? event.currentTarget : canvasAreaRef.current;
  }, []);

  const handlePaneContextMenu = useCallback(
    (event: CanvasContextMouseEvent) => {
      if (shouldKeepNativeContextMenu(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        kind: 'canvas',
        clientPosition: { x: event.clientX, y: event.clientY },
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        returnFocusTo: getReturnFocusTarget(event),
      });
    },
    [getReturnFocusTarget, screenToFlowPosition],
  );

  const handleNodeContextMenu = useCallback(
    (event: CanvasContextMouseEvent, node: AssetFlowNode) => {
      if (shouldKeepNativeContextMenu(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onNodeSelect(node);
      setContextMenu({
        kind: 'node',
        clientPosition: { x: event.clientX, y: event.clientY },
        node,
        returnFocusTo: getReturnFocusTarget(event),
      });
    },
    [getReturnFocusTarget, onNodeSelect],
  );

  const handleContextMenuClose = useCallback(
    (reason: CanvasContextMenuCloseReason) => {
      const returnFocusTo = contextMenu?.returnFocusTo;
      setContextMenu(null);
      if (reason === 'outside') return;
      window.setTimeout(() => {
        const focusTarget = returnFocusTo?.isConnected ? returnFocusTo : canvasAreaRef.current;
        focusTarget?.focus({ preventScroll: true });
      }, 0);
    },
    [contextMenu],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: { toHandle?: unknown }) => {
      const start = connectionStartRef.current;
      connectionStartRef.current = null;
      if (!start?.nodeId || state.toHandle) return;

      const point =
        'changedTouches' in event
          ? event.changedTouches.item(0)
          : { clientX: event.clientX, clientY: event.clientY };
      if (!point) return;
      const nodeElement = document
        .elementsFromPoint(point.clientX, point.clientY)
        .map((element) => element.closest<HTMLElement>('.react-flow__node[data-id]'))
        .find(Boolean);
      const targetNodeId = nodeElement?.dataset.id;
      if (!targetNodeId || targetNodeId === start.nodeId) return;

      const connection: Connection =
        start.handleType === 'target'
          ? {
              source: targetNodeId,
              sourceHandle: null,
              target: start.nodeId,
              targetHandle: start.handleId,
            }
          : {
              source: start.nodeId,
              sourceHandle: start.handleId,
              target: targetNodeId,
              targetHandle: null,
            };
      onConnect(connection);
    },
    [onConnect],
  );

  return (
    <section
      ref={canvasAreaRef}
      className={`canvas-area${quickEditorNode ? ' has-quick-editor' : ''}`}
      aria-label="工作流画布"
      tabIndex={-1}
      onContextMenu={(event) => {
        if (!shouldKeepNativeContextMenu(event.target)) event.preventDefault();
      }}
    >
      <CanvasNodeToolbar
        onAddGenerateNode={handleAddGenerateNode}
        onAddTransformNode={handleAddTransformNode}
      />
      <NodeSelectionContext.Provider value={selectNodeByData}>
        <NodeResizeContext.Provider value={onResizeNode}>
          <NodeResizeStartContext.Provider value={onResizeStart ?? null}>
            <NodeEnabledContext.Provider value={onNodeEnabledChange}>
              <NodeRetryContext.Provider value={onRetryNode}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onConnectStart={(_event, params) => {
                    connectionStartRef.current = params;
                  }}
                  onConnectEnd={handleConnectEnd}
                  onNodeDragStart={onNodeDragStart}
                  onMove={reportCanvasCenter}
                  onDrop={handleDrop}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }}
                  onNodeClick={(_, node) => onNodeSelect(node as AssetFlowNode)}
                  onNodeContextMenu={(event, node) =>
                    handleNodeContextMenu(event, node as AssetFlowNode)
                  }
                  onPaneContextMenu={handlePaneContextMenu}
                  onPaneClick={() => {
                    setContextMenu(null);
                    onClearNodeSelection();
                  }}
                  fitView
                  minZoom={FIT_VIEW_MIN_ZOOM}
                  fitViewOptions={{ padding: 0.3, maxZoom: 1.1, minZoom: FIT_VIEW_MIN_ZOOM }}
                  connectionLineStyle={{ stroke: '#18794e', strokeWidth: 2 }}
                  defaultEdgeOptions={{
                    animated: true,
                  }}
                  proOptions={{ hideAttribution: true }}
                >
                  {background !== 'blank' && (
                    <Background
                      color="#cbd5d0"
                      gap={background === 'lines' ? 28 : 24}
                      size={background === 'cross' ? 7 : 1.2}
                      variant={
                        background === 'lines'
                          ? BackgroundVariant.Lines
                          : background === 'cross'
                            ? BackgroundVariant.Cross
                            : BackgroundVariant.Dots
                      }
                    />
                  )}
                  {selectedNode && onDeleteNode && (
                    <NodeToolbar
                      nodeId={selectedNode.id}
                      isVisible
                      position={Position.Top}
                      offset={14}
                      align="end"
                      className="node-delete-toolbar"
                    >
                      <button
                        type="button"
                        className="node-delete-button nodrag nopan nowheel"
                        aria-label={`删除节点：${selectedNode.data.label}`}
                        title="删除节点"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteNode(selectedNode.id);
                        }}
                      >
                        <Trash2 size={16} strokeWidth={2.2} aria-hidden="true" />
                      </button>
                    </NodeToolbar>
                  )}
                  <Controls showInteractive={false} position="bottom-right" />
                </ReactFlow>
              </NodeRetryContext.Provider>
            </NodeEnabledContext.Provider>
          </NodeResizeStartContext.Provider>
        </NodeResizeContext.Provider>
      </NodeSelectionContext.Provider>
      {quickEditorNode && (
        <QuickEditorOverlay
          key={quickEditorNode.id}
          node={quickEditorNode}
          models={models}
          busy={busy}
          canvasAreaRef={canvasAreaRef}
          onPromptChange={(value) => onPromptChange(value, quickEditorNode.id)}
          onParametersChange={
            onParametersChange
              ? (value) => onParametersChange(value, quickEditorNode.id)
              : undefined
          }
          onModelChange={(value) => onModelChange(value, quickEditorNode.id)}
          onInferenceStrengthChange={(value) =>
            onInferenceStrengthChange(value, quickEditorNode.id)
          }
          onRun={() => onRunNode(quickEditorNode)}
        />
      )}
      {nodes.length === 0 && (
        <div className="canvas-welcome">
          <span className="canvas-kicker">工作流画布</span>
          <h2>从一个节点开始</h2>
          <p>上传资源、创建提示词节点，或从工作台打开另一张画布。</p>
          <div className="canvas-welcome-actions">
            <button type="button" className="button button-primary" onClick={onRequestUpload}>
              <Upload size={15} aria-hidden="true" />
              上传资源
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => handleAddGenerateNode('text')}
            >
              <FileText size={15} aria-hidden="true" />
              新建文字节点
            </button>
            <button type="button" className="button button-secondary" onClick={onOpenProjectHub}>
              <LayoutGrid size={15} aria-hidden="true" />
              打开工作台
            </button>
          </div>
        </div>
      )}
      {contextMenu && (
        <CanvasContextMenu
          target={contextMenu}
          busy={busy}
          canDeleteNode={Boolean(onDeleteNode)}
          onRunNode={onRunNode}
          onCenterNode={handleCenterNode}
          onNodeEnabledChange={onNodeEnabledChange}
          onDeleteNode={(nodeId) => onDeleteNode?.(nodeId)}
          onAddGenerateNode={onAddGenerateNode}
          onAddTransformNode={onAddTransformNode}
          onRequestUpload={onRequestUpload}
          onClose={handleContextMenuClose}
        />
      )}
    </section>
  );
}

/** 快速编辑器 portal 所需的节点与画布引用。 */
type QuickEditorOverlayProps = Omit<NodeQuickEditorProps, 'node'> & {
  /** 当前选中的生成或转换节点。 */
  node: AssetFlowNode;
  /** 用于约束浮层可见范围的画布容器引用。 */
  canvasAreaRef: RefObject<HTMLElement | null>;
};

/**
 * 将快速编辑器渲染到画布外层，并根据节点和画布的视口矩形定位。
 * React Flow 的节点容器使用 `overflow: hidden`，因此编辑器不能继续嵌套在
 * `NodeToolbar` 中；优先沿上下方向布局，空间不足时停靠节点侧面以避开缩放控制点。
 */
function QuickEditorOverlay({ node, canvasAreaRef, ...editorProps }: QuickEditorOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  /** portal 宿主在客户端挂载后确定，服务端渲染阶段保持为空。 */
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  /** 当前编辑器视口坐标；完成首次测量前保持隐藏。 */
  const [layout, setLayout] = useState<QuickEditorLayout>({
    left: QUICK_EDITOR_VIEWPORT_MARGIN,
    top: QUICK_EDITOR_VIEWPORT_MARGIN,
    width: QUICK_EDITOR_MAX_WIDTH,
    placement: 'below',
    ready: false,
  });

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const host = canvasAreaRef.current?.closest<HTMLElement>('.app-shell') ?? document.body;
    setPortalHost((current) => (current === host ? current : host));
  }, [canvasAreaRef]);

  const measure = useCallback(() => {
    const canvas = canvasAreaRef.current;
    const overlay = overlayRef.current;
    const nodeElement = findReactFlowNodeElement(node.id);
    if (!canvas || !overlay || !nodeElement) {
      setLayout((current) => (current.ready ? { ...current, ready: false } : current));
      return;
    }

    const viewportWidth = Math.max(
      window.innerWidth || 0,
      document.documentElement.clientWidth || 0,
      QUICK_EDITOR_MAX_WIDTH + QUICK_EDITOR_VIEWPORT_MARGIN * 2,
    );
    const viewportHeight = Math.max(
      window.innerHeight || 0,
      document.documentElement.clientHeight || 0,
      480,
    );
    const canvasRect = canvas.getBoundingClientRect();
    const hasCanvasBounds = canvasRect.width > 0 && canvasRect.height > 0;
    const canvasLeft = hasCanvasBounds
      ? Math.max(QUICK_EDITOR_VIEWPORT_MARGIN, canvasRect.left + QUICK_EDITOR_VIEWPORT_MARGIN)
      : QUICK_EDITOR_VIEWPORT_MARGIN;
    const canvasRight = hasCanvasBounds
      ? Math.min(
          viewportWidth - QUICK_EDITOR_VIEWPORT_MARGIN,
          canvasRect.right - QUICK_EDITOR_VIEWPORT_MARGIN,
        )
      : viewportWidth - QUICK_EDITOR_VIEWPORT_MARGIN;
    const canvasTop = hasCanvasBounds
      ? Math.max(QUICK_EDITOR_VIEWPORT_MARGIN, canvasRect.top + QUICK_EDITOR_VIEWPORT_MARGIN)
      : QUICK_EDITOR_VIEWPORT_MARGIN;
    const canvasBottom = hasCanvasBounds
      ? Math.min(
          viewportHeight - QUICK_EDITOR_VIEWPORT_MARGIN,
          canvasRect.bottom - QUICK_EDITOR_VIEWPORT_MARGIN,
        )
      : viewportHeight - QUICK_EDITOR_VIEWPORT_MARGIN;
    const boundedRight = Math.max(canvasLeft, canvasRight);
    const boundedBottom = Math.max(canvasTop, canvasBottom);
    let width = Math.min(QUICK_EDITOR_MAX_WIDTH, Math.max(1, boundedRight - canvasLeft));
    const overlayRect = overlay.getBoundingClientRect();
    const editorHeight = overlayRect.height > 0 ? overlayRect.height : 420;
    const nodeRect = nodeElement.getBoundingClientRect();
    const hasNodeBounds = nodeRect.width > 0 && nodeRect.height > 0;
    const nodeCenter = hasNodeBounds
      ? nodeRect.left + nodeRect.width / 2
      : (canvasLeft + boundedRight) / 2;
    const getCenteredLeft = (editorWidth: number) =>
      clampQuickEditorValue(
        nodeCenter - editorWidth / 2,
        canvasLeft,
        Math.max(canvasLeft, boundedRight - editorWidth),
      );

    let left = getCenteredLeft(width);

    let top = canvasTop;
    let placement: QuickEditorLayout['placement'] = 'below';
    if (hasNodeBounds) {
      const belowTop = nodeRect.bottom + QUICK_EDITOR_NODE_GAP;
      const aboveTop = nodeRect.top - editorHeight - QUICK_EDITOR_NODE_GAP;
      const fitsBelow = belowTop + editorHeight <= boundedBottom;
      const fitsAbove = aboveTop >= canvasTop;
      const maxTop = Math.max(canvasTop, boundedBottom - editorHeight);
      if (fitsBelow) {
        top = belowTop;
      } else if (fitsAbove) {
        top = clampQuickEditorValue(aboveTop, canvasTop, maxTop);
        placement = 'above';
      } else {
        const leftAvailable = nodeRect.left - QUICK_EDITOR_NODE_GAP - canvasLeft;
        const rightAvailable = boundedRight - nodeRect.right - QUICK_EDITOR_NODE_GAP;
        const preferLeft = leftAvailable >= rightAvailable;
        const sideAvailable = Math.max(preferLeft ? leftAvailable : rightAvailable, 0);

        if (sideAvailable >= QUICK_EDITOR_MIN_SIDE_WIDTH) {
          width = Math.min(QUICK_EDITOR_MAX_WIDTH, sideAvailable);
          left = preferLeft
            ? nodeRect.left - QUICK_EDITOR_NODE_GAP - width
            : nodeRect.right + QUICK_EDITOR_NODE_GAP;
          top = clampQuickEditorValue(
            nodeRect.top + nodeRect.height / 2 - editorHeight / 2,
            canvasTop,
            maxTop,
          );
          placement = preferLeft ? 'left' : 'right';
        } else {
          const hasMoreSpaceAbove = nodeRect.top - canvasTop > boundedBottom - nodeRect.bottom;
          if (hasMoreSpaceAbove) {
            top = clampQuickEditorValue(aboveTop, canvasTop, maxTop);
            placement = 'above';
          } else {
            top = clampQuickEditorValue(belowTop, canvasTop, maxTop);
          }
        }
      }
    }

    const nextLayout: QuickEditorLayout = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      placement,
      ready: true,
    };
    setLayout((current) =>
      current.left === nextLayout.left &&
      current.top === nextLayout.top &&
      current.width === nextLayout.width &&
      current.placement === nextLayout.placement &&
      current.ready === nextLayout.ready
        ? current
        : nextLayout,
    );
  }, [canvasAreaRef, node.id]);

  useLayoutEffect(() => {
    if (!portalHost) return;
    let disposed = false;
    const update = () => {
      if (!disposed) measure();
    };

    update();
    const initialMeasure = window.setTimeout(update, 0);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    const canvas = canvasAreaRef.current;
    const nodeElement = findReactFlowNodeElement(node.id);
    const overlay = overlayRef.current;
    if (canvas) resizeObserver?.observe(canvas);
    if (nodeElement) resizeObserver?.observe(nodeElement);
    if (overlay) resizeObserver?.observe(overlay);

    const mutationObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    if (mutationObserver && nodeElement) {
      mutationObserver.observe(nodeElement, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }
    const viewportElement = canvas?.querySelector<HTMLElement>('.react-flow__viewport');
    if (viewportElement) {
      mutationObserver?.observe(viewportElement, {
        attributes: true,
        attributeFilter: ['style'],
      });
    }

    return () => {
      disposed = true;
      window.clearTimeout(initialMeasure);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [canvasAreaRef, measure, node.id, portalHost]);

  if (!portalHost) return null;

  const style: CSSProperties = {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    visibility: layout.ready ? 'visible' : 'hidden',
    width: `${layout.width}px`,
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="quick-editor-overlay"
      data-node-id={node.id}
      data-placement={layout.placement}
      style={style}
    >
      <NodeQuickEditor node={node} {...editorProps} />
    </div>,
    portalHost,
  );
}

/**
 * 查找 React Flow 为节点生成的视口元素，兼容测试替身使用的 data-node-id。
 * @param nodeId 需要定位的画布节点 ID。
 * @returns 匹配的节点元素；尚未挂载时返回 null。
 */
function findReactFlowNodeElement(nodeId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const elements = document.querySelectorAll<HTMLElement>('.react-flow__node');
  for (const element of elements) {
    if (element.dataset.id === nodeId || element.dataset.nodeId === nodeId) return element;
  }
  return null;
}

/**
 * 将编辑器坐标限制在画布可见边界内。
 * @param value 待约束的坐标值。
 * @param minimum 可见范围下限。
 * @param maximum 可见范围上限。
 * @returns 位于闭区间内的有限数值；非有限输入回退到下限。
 */
function clampQuickEditorValue(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

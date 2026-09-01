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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
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
import { NodeQuickEditor, type InferenceStrength } from './NodeQuickEditor';
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
  onOptimizePrompt?: (nodeId?: string) => void | Promise<void>;
  optimizingPrompt?: boolean;
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
  onOptimizePrompt,
  optimizingPrompt,
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
      className="canvas-area"
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
                  {selectedNode && selectedNode.data.mode !== 'source' && (
                    <NodeToolbar
                      nodeId={selectedNode.id}
                      isVisible
                      position={Position.Bottom}
                      offset={24}
                      align="center"
                      className="node-quick-toolbar"
                    >
                      <NodeQuickEditor
                        node={selectedNode}
                        models={models}
                        busy={busy}
                        onPromptChange={(value) => onPromptChange(value, selectedNode.id)}
                        onParametersChange={
                          onParametersChange
                            ? (value) => onParametersChange(value, selectedNode.id)
                            : undefined
                        }
                        onOptimizePrompt={
                          onOptimizePrompt ? () => onOptimizePrompt(selectedNode.id) : undefined
                        }
                        optimizingPrompt={optimizingPrompt}
                        onModelChange={(value) => onModelChange(value, selectedNode.id)}
                        onInferenceStrengthChange={(value) =>
                          onInferenceStrengthChange(value, selectedNode.id)
                        }
                        onRun={() => onRunNode(selectedNode)}
                      />
                    </NodeToolbar>
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

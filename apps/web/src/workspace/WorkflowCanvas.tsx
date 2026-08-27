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
import { FileText, LayoutGrid, Upload } from 'lucide-react';
import { useCallback, useRef, type DragEvent } from 'react';

import type { MediaType } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  NodeResizeContext,
  NodeSelectionContext,
  nodeTypes,
  type NodeResizeHandler,
} from './AssetNode';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';
import { NodeQuickEditor, type InferenceStrength } from './NodeQuickEditor';
import { ASSET_DRAG_TYPE, type CanvasBackground, type ModelEntry } from './contracts';

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
  onPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onInferenceStrengthChange: (value: InferenceStrength) => void;
  onRunNode: (node: AssetFlowNode) => void;
  onAddGenerateNode: (mediaType: MediaType) => void;
  onAddTransformNode: (mediaType: MediaType) => void;
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
  onPromptChange,
  onModelChange,
  onInferenceStrengthChange,
  onRunNode,
  onAddGenerateNode,
  onAddTransformNode,
  onRequestUpload,
  onOpenProjectHub,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const connectionStartRef = useRef<OnConnectStartParams | null>(null);

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
    <section className="canvas-area" aria-label="工作流画布">
      <CanvasNodeToolbar
        onAddGenerateNode={onAddGenerateNode}
        onAddTransformNode={onAddTransformNode}
      />
      <NodeSelectionContext.Provider value={selectNodeByData}>
        <NodeResizeContext.Provider value={onResizeNode}>
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
            onDrop={handleDrop}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onNodeClick={(_, node) => onNodeSelect(node as AssetFlowNode)}
            onPaneClick={onClearNodeSelection}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
            connectionLineStyle={{ stroke: '#18794e', strokeWidth: 2 }}
            defaultEdgeOptions={{ animated: true, style: { stroke: '#8aa597', strokeWidth: 2 } }}
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
                  onPromptChange={onPromptChange}
                  onModelChange={onModelChange}
                  onInferenceStrengthChange={onInferenceStrengthChange}
                  onRun={() => onRunNode(selectedNode)}
                />
              </NodeToolbar>
            )}
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
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
              onClick={() => onAddGenerateNode('text')}
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
    </section>
  );
}

import { Button } from '@multimodal-canvas/ui';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  useViewport,
  type Connection,
  type ConnectionLineComponentProps,
  type FinalConnectionState,
  type OnConnectStartParams,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { FileText, LayoutGrid, Upload } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import type {
  Asset,
  CanvasGroup,
  MediaType,
  PortRole,
  PromptDocument,
  VideoCompletionAction,
  VideoMode,
} from '@multimodal-canvas/domain';
import { portRoles } from '@multimodal-canvas/domain';
import type { CanvasTheme } from '../state/workspace-preferences';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { getNewNodeDimensions } from '../canvas-utils';
import { collectConnectedPromptAssets } from './connected-prompt-assets';
import { isActiveRunStatus } from './empty-node-rules';
import { resolveImageEditSourcePreview } from './image-edit-source-preview';
import {
  GenerationBatchViewContext,
  projectGenerationBatches,
  reconcileGenerationBatchChanges,
} from './generation-batch-view';
import type { NodeRunTarget } from './fork-generate-node';
import type { ClearActionCounts } from './ClearCanvasMenu';
import { CanvasGroupLayer } from './CanvasGroupLayer';
import {
  NodeResizeContext,
  NodeDeleteContext,
  NodeContentContext,
  NodePromptContext,
  type NodeContentHandlers,
  NodeResizeStartContext,
  NodeEnabledContext,
  NodeImageEditContext,
  NodeLabelChangeContext,
  NodeRetryContext,
  NodeSelectionContext,
  NodeQuickEditorIdContext,
  nodeTypes,
  type NodeEnabledHandler,
  type NodeResizeHandler,
} from './AssetNode';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';
import {
  CanvasEdgeAppearanceProvider,
  canvasEdgeAppearanceDefaults,
  type CanvasEdgeAppearance,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';
import { FlowingCanvasEdge, FlowingConnectionLine } from './FlowingCanvasEdge';
import {
  CanvasContextMenu,
  type CanvasContextMenuCloseReason,
  type CanvasContextMenuTarget,
} from './CanvasContextMenu';
import { VideoInputRolePicker, type VideoInputRolePickerTarget } from './VideoInputRolePicker';
import {
  NodeQuickEditor,
  type InferenceStrength,
  type NodeQuickEditorProps,
} from './NodeQuickEditor';
import { getCenteredCanvasNodePosition } from './canvas-position';
import {
  getConnectionDropCreateGroups,
  needsVideoImageRoleChoice,
  type ConnectedGenerateNodeRequest,
} from '../connection-utils';
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
/** 画布连线使用带路径形态与特效的默认边，几何与叠加层都由偏好驱动。 */
const canvasEdgeTypes = { default: FlowingCanvasEdge };

function shouldKeepNativeContextMenu(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(NATIVE_CONTEXT_MENU_SELECTOR));
}

/** 节点尚未取得尺寸时的输入面板回退宽度，单位为画布像素。 */
const QUICK_EDITOR_FALLBACK_WIDTH = 570;
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
  /** 缩放前的浮层宽度，单位为画布像素。 */
  width: number;
  /** 缩放前的最大可用高度，单位为画布像素；超长编辑器内部滚动。 */
  maxHeight: number;
  /** 与 React Flow 视口一致的缩放比例，不改写节点持久化尺寸。 */
  scale: number;
  /** 浮层相对于选中节点的展开方向。 */
  placement: 'below' | 'above' | 'left' | 'right';
  /** 是否已取得可用于显示的首个布局结果。 */
  ready: boolean;
};

export type WorkflowCanvasProps = {
  /** 当前项目用于创建独立 Skill 优化任务。 */
  projectId?: string;
  /** 由用户级目录提供的内置与自定义技能。 */
  promptSkills?: NodeQuickEditorProps['promptSkills'];
  /** 技能工作台可从画布工具栏或节点编辑器打开。 */
  onOpenSkillWorkbench?: () => void;
  /** 技能目录不可用的错误。 */
  skillLibraryError?: string;
  /** 首次目录读取中，不允许清空或替换已有选择。 */
  skillLibraryLoading?: boolean;
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  selectedNode: AssetFlowNode | null;
  /** 当前项目中可访问的资源，供所有节点的提及编辑器共用。 */
  assets?: readonly Asset[];
  models: ModelEntry[];
  /** 运行或内容保存中的节点身份，不影响其它节点的生成入口。 */
  busyNodeIds?: ReadonlySet<string>;
  background: CanvasBackground;
  onNodesChange: OnNodesChange<AssetFlowNode>;
  /** 批量结果首节点的展开状态，由 App 负责历史记录和持久化。 */
  onBatchExpandedChange?: (rootNodeId: string, expanded: boolean) => void;
  onEdgesChange: OnEdgesChange<FlowEdge>;
  onConnect: (connection: Connection) => void;
  onNodeDragStart: () => void;
  /** 拖拽中的节点，用于预高亮落点组。 */
  onNodeDrag?: (event: unknown, node: AssetFlowNode) => void;
  /** 松手后决定节点入组或解除归属。 */
  onNodeDragStop?: (event: unknown, node: AssetFlowNode) => void;
  onCanvasDrop: (
    files: File[],
    assetId: string | undefined,
    position: { x: number; y: number },
  ) => void;
  onNodeSelect: (node: AssetFlowNode) => void;
  onClearNodeSelection: () => void;
  onResizeNode: NodeResizeHandler;
  /** 双击节点名称后的保存回调。 */
  onNodeLabelChange?: (nodeId: string, label: string) => void;
  onResizeStart?: (nodeId: string) => void;
  onNodeEnabledChange: NodeEnabledHandler;
  onRetryNode: (nodeId: string) => void | Promise<void>;
  onPromptChange?: (value: string, nodeId?: string) => void;
  onPromptDocumentChange?: (document: PromptDocument, nodeId?: string) => void;
  /** 仅保存目标节点的连线资源别名，不修改源资源名称或提示词。 */
  onConnectedResourceRename?: (assetId: string, name: string, nodeId?: string) => void;
  /** 保存目标节点的技能选择，不触发生成。 */
  onPromptSkillChange?: (skillId: string | undefined, nodeId?: string) => void;
  /** 提示词资源条点击上传后，把文件收成项目资源并回写提及。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  onParametersChange?: (value: Record<string, unknown>, nodeId?: string) => void;
  /** 每次生成的独立结果数量，不进入供应商 parameters。 */
  onGenerationCountChange?: (value: number, nodeId?: string) => void;
  onCompletionActionChange?: (value: VideoCompletionAction, nodeId?: string) => void;
  onCompletionTargetNodeIdChange?: (value: string | undefined, nodeId?: string) => void;
  onVideoModeChange?: (value: VideoMode, nodeId?: string) => void;
  onModelChange: (value: ModelSelection, nodeId?: string) => void;
  onInferenceStrengthChange: (value: InferenceStrength, nodeId?: string) => void;
  onRunNode: (node: AssetFlowNode, target?: NodeRunTarget) => void;
  /** App owns graph history and persistence, so deletion is handed back to it. */
  onDeleteNode?: (nodeId: string) => void;
  /** 当前节点上传和文本编辑的持久化接口。 */
  nodeContentHandlers?: NodeContentHandlers;
  onAddGenerateNode: (mediaType: MediaType, position?: { x: number; y: number }) => void;
  /**
   * 图片节点“修改图片”：新建独立编辑节点并显式连上来源图。
   * @param sourceNodeId 被修改图片的来源节点 ID。
   */
  onEditImage?: (sourceNodeId: string) => void;
  /** 从悬空连线创建生成节点并立刻连到拖线起点。 */
  onAddConnectedGenerateNode: (request: ConnectedGenerateNodeRequest) => void;
  /** 打开节点的只读「生成提示词」入口，展示真正发送的请求文本。 */
  onOpenRequestPrompt?: (nodeId: string) => void;
  onCanvasCenterChange: (position: { x: number; y: number }) => void;
  onRequestUpload: () => void;
  /** 清空画布并由 App 负责确认、历史记录与脏状态。 */
  onClearCanvas?: () => void;
  /** 只清理空节点并由 App 负责确认、历史记录与脏状态。 */
  onClearEmptyNodes?: () => void;
  /** 两个清空动作的候选数量。 */
  clearCounts?: ClearActionCounts;
  /** 画布布局区域；不进入运行 DAG。 */
  groups?: readonly CanvasGroup[];
  /** 当前选中的组。 */
  selectedGroupId?: string | null;
  /** 拖拽节点时预高亮的落点组。 */
  dropTargetGroupId?: string | null;
  onSelectGroup?: (groupId: string | undefined) => void;
  /** 按当前选区或视口中心创建组。 */
  onCreateGroup?: () => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  /** 解散组：只移除区域，保留成员与连线。 */
  onDissolveGroup?: (groupId: string) => void;
  onTranslateGroup?: (groupId: string, delta: { x: number; y: number }) => void;
  onResizeGroup?: (
    groupId: string,
    size: { width: number; height: number; position?: { x: number; y: number } },
  ) => void;
  /** 整组移动或缩放前记录一次历史。 */
  onGroupInteractionStart?: () => void;
  /** 撤销最近一次画布变更。 */
  onUndoCanvas?: () => void;
  /** 重做最近一次撤销的画布变更。 */
  onRedoCanvas?: () => void;
  /** 打开搜索/命令面板。 */
  onOpenSearch?: () => void;
  /** 当前界面主题。 */
  canvasTheme?: CanvasTheme;
  /** 从底部胶囊切换主题。 */
  onThemeChange?: (theme: CanvasTheme) => void;
  /** 从底部胶囊切换画布背景。 */
  onBackgroundChange?: (background: CanvasBackground) => void;
  /** 当前连接线路径形态。 */
  edgePathStyle?: CanvasEdgePathStyle;
  /** 从底部外观面板切换连接线路径形态。 */
  onEdgePathStyleChange?: (pathStyle: CanvasEdgePathStyle) => void;
  /** 当前连接线动态特效。 */
  edgeEffect?: CanvasEdgeEffect;
  /** 从底部外观面板切换连接线动态特效。 */
  onEdgeEffectChange?: (effect: CanvasEdgeEffect) => void;
  /** 底部工具栏清空按钮是否可用。 */
  canClearCanvas?: boolean;
  /** 底部工具栏撤销按钮是否可用。 */
  canUndo?: boolean;
  /** 底部工具栏重做按钮是否可用。 */
  canRedo?: boolean;
  onOpenProjectHub: () => void;
};

export function WorkflowCanvas({
  projectId,
  promptSkills,
  onOpenSkillWorkbench,
  skillLibraryError,
  skillLibraryLoading,
  nodes,
  edges,
  selectedNode,
  assets = [],
  models,
  busyNodeIds,
  background,
  onNodesChange,
  onBatchExpandedChange,
  onEdgesChange,
  onConnect,
  onNodeDragStart,
  onNodeDrag,
  onNodeDragStop,
  onCanvasDrop,
  onNodeSelect,
  onClearNodeSelection,
  onResizeNode,
  onNodeLabelChange,
  onResizeStart,
  onNodeEnabledChange,
  onRetryNode,
  onPromptChange,
  onPromptDocumentChange,
  onConnectedResourceRename,
  onPromptSkillChange,
  onUploadResource,
  onParametersChange,
  onGenerationCountChange,
  onCompletionActionChange,
  onCompletionTargetNodeIdChange,
  onVideoModeChange,
  onModelChange,
  onInferenceStrengthChange,
  onRunNode,
  onDeleteNode,
  nodeContentHandlers,
  onAddGenerateNode,
  onEditImage,
  onAddConnectedGenerateNode,
  onCanvasCenterChange,
  onOpenRequestPrompt,
  onRequestUpload,
  onClearCanvas,
  onClearEmptyNodes,
  clearCounts,
  groups = [],
  selectedGroupId,
  dropTargetGroupId,
  onSelectGroup,
  onCreateGroup,
  onRenameGroup,
  onDissolveGroup,
  onTranslateGroup,
  onResizeGroup,
  onGroupInteractionStart,
  onUndoCanvas,
  onRedoCanvas,
  onOpenSearch,
  canvasTheme,
  onThemeChange,
  onBackgroundChange,
  edgePathStyle = canvasEdgeAppearanceDefaults.pathStyle,
  onEdgePathStyleChange,
  edgeEffect = canvasEdgeAppearanceDefaults.effect,
  onEdgeEffectChange,
  canClearCanvas,
  canUndo,
  canRedo,
  onOpenProjectHub,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition, getNodesBounds, getZoom, setCenter, fitView } = useReactFlow();
  /** 组区域层按视口换算位置与尺寸，缩放画布时与成员保持对齐。 */
  const viewport = useViewport();
  const canvasAreaRef = useRef<HTMLElement>(null);
  const connectionStartRef = useRef<OnConnectStartParams | null>(null);
  /** 吞掉拖线松手后紧随而来的 pane click，避免菜单刚弹出就被关掉。 */
  const suppressPaneClickRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuTarget | null>(null);
  const [videoImageRolePicker, setVideoImageRolePicker] =
    useState<VideoInputRolePickerTarget | null>(null);
  /** 批量折叠只投影显示坐标，不修改真实节点与连线。 */
  const batchProjection = useMemo(() => projectGenerationBatches(nodes, edges), [nodes, edges]);
  const batchContext = useMemo(
    () => ({ views: batchProjection.views, onExpandedChange: onBatchExpandedChange }),
    [batchProjection.views, onBatchExpandedChange],
  );
  /** 收起后的后方卡牌不能继续显示输入编辑器。 */
  const quickEditorNode =
    selectedNode && !batchProjection.views.get(selectedNode.id)?.hidden ? selectedNode : null;
  /** 菜单打开后仍读取实时节点，避免恢复/SSE 更新被右键快照遮住。 */
  const currentContextMenu =
    contextMenu?.kind === 'node'
      ? {
          ...contextMenu,
          node: nodes.find((node) => node.id === contextMenu.node.id) ?? contextMenu.node,
        }
      : contextMenu;
  /** 所有节点入口共用本地锁及服务端活动状态。 */
  const isNodeBusy = (node: AssetFlowNode) =>
    Boolean(busyNodeIds?.has(node.id)) || isActiveRunStatus(node.data.runStatus);
  /** React Flow 只接收显示坐标；历史记录和保存始终接收真实坐标。 */
  const handleNodesChange = useCallback<OnNodesChange<AssetFlowNode>>(
    (changes) =>
      onNodesChange(reconcileGenerationBatchChanges(changes, nodes, batchProjection.views)),
    [batchProjection.views, nodes, onNodesChange],
  );
  /** 连接线外观；路径形态与特效互相独立，选择任一都不会重置另一个。 */
  const edgeAppearance = useMemo<CanvasEdgeAppearance>(
    () => ({ pathStyle: edgePathStyle, effect: edgeEffect }),
    [edgePathStyle, edgeEffect],
  );
  /** xyflow 的连接线组件无法读取自定义 Context，这里把当前外观注入预览组件。 */
  const connectionLineComponent = useMemo(
    () =>
      function CanvasConnectionLine(props: ConnectionLineComponentProps) {
        return <FlowingConnectionLine {...props} pathStyle={edgePathStyle} effect={edgeEffect} />;
      },
    [edgePathStyle, edgeEffect],
  );

  const getCanvasNodePosition = useCallback(
    (mediaType?: MediaType) => {
      const canvasArea = canvasAreaRef.current;
      if (!canvasArea) return undefined;
      const bounds = canvasArea.getBoundingClientRect();
      return getCenteredCanvasNodePosition(
        bounds,
        screenToFlowPosition,
        mediaType ? getNewNodeDimensions(mediaType) : undefined,
      );
    },
    [screenToFlowPosition],
  );

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
    (mediaType: MediaType) => onAddGenerateNode(mediaType, getCanvasNodePosition(mediaType)),
    [getCanvasNodePosition, onAddGenerateNode],
  );

  /** 将视口缩放到能完整看到当前画布节点的范围。 */
  const handleFitView = useCallback(() => {
    if (typeof fitView !== 'function') return;
    void fitView({
      padding: 0.3,
      maxZoom: 1.1,
      minZoom: FIT_VIEW_MIN_ZOOM,
      duration: 220,
    });
  }, [fitView]);

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

  /** 阻止浏览器将画布上的 Ctrl+滚轮解释为页面缩放，让 React Flow 接管缩放。 */
  const handleCanvasWheelCapture = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    if (event.ctrlKey) event.preventDefault();
  }, []);

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
        // 菜单操作打开 Dialog 后，保留新浮层的焦点，避免覆盖其初始聚焦。
        if (
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
        ) {
          return;
        }
        const focusTarget = returnFocusTo?.isConnected ? returnFocusTo : canvasAreaRef.current;
        focusTarget?.focus({ preventScroll: true });
      }, 0);
    },
    [contextMenu],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const start = connectionStartRef.current;
      connectionStartRef.current = null;
      if (!start?.nodeId || state.toHandle) return;
      // Escape 取消连线时 React Flow 仍会触发 onConnectEnd，不能弹出创建菜单。
      if ('key' in event) return;

      const point =
        'changedTouches' in event
          ? event.changedTouches.item(0)
          : { clientX: event.clientX, clientY: event.clientY };
      if (!point) return;
      const hitElements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(point.clientX, point.clientY)
          : [];
      const nodeElement = hitElements
        .map((element) => element.closest<HTMLElement>('.react-flow__node[data-id]'))
        .find(Boolean);
      const targetNodeId =
        (typeof state.toNode?.id === 'string' ? state.toNode.id : undefined) ??
        nodeElement?.dataset.id;

      if (targetNodeId && targetNodeId !== start.nodeId) {
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
        if (needsVideoImageRoleChoice(connection, nodes)) {
          setVideoImageRolePicker({
            connection,
            clientPosition: { x: point.clientX, y: point.clientY },
          });
          return;
        }
        onConnect(connection);
        return;
      }

      if (targetNodeId === start.nodeId) return;

      const sourceNode = nodes.find((node) => node.id === start.nodeId);
      if (!sourceNode) return;
      const handleType = start.handleType === 'target' ? 'target' : 'source';
      const groups = getConnectionDropCreateGroups({
        node: sourceNode,
        handleType,
        handleId: start.handleId ?? null,
      });
      if (groups.length === 0) return;

      suppressPaneClickRef.current = true;
      window.setTimeout(() => {
        suppressPaneClickRef.current = false;
      }, 0);
      setVideoImageRolePicker(null);
      setContextMenu({
        kind: 'connection-drop',
        clientPosition: { x: point.clientX, y: point.clientY },
        flowPosition: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        sourceNode,
        handleType,
        handleId: start.handleId ?? null,
        groups,
        returnFocusTo: canvasAreaRef.current,
      });
    },
    [nodes, onConnect, screenToFlowPosition],
  );

  const handleFlowConnect = useCallback(
    (connection: Connection) => {
      if (needsVideoImageRoleChoice(connection, nodes)) {
        const nodeElement = document.querySelector(
          `.react-flow__node[data-id="${CSS.escape(connection.target ?? '')}"]`,
        );
        const rect = nodeElement?.getBoundingClientRect();
        setVideoImageRolePicker({
          connection,
          clientPosition: rect ? { x: rect.left, y: rect.top + rect.height / 2 } : { x: 24, y: 24 },
        });
        return;
      }
      onConnect(connection);
    },
    [nodes, onConnect],
  );

  const handleVideoImageRoleSelect = useCallback(
    (role: PortRole) => {
      if (!videoImageRolePicker) return;
      onConnect({
        ...videoImageRolePicker.connection,
        targetHandle: `input:${role}`,
      });
      setVideoImageRolePicker(null);
    },
    [onConnect, videoImageRolePicker],
  );

  return (
    <section
      ref={canvasAreaRef}
      className={`canvas-area${quickEditorNode ? ' has-quick-editor' : ''}`}
      data-edge-path-style={edgePathStyle}
      data-edge-effect={edgeEffect}
      aria-label="工作流画布"
      tabIndex={-1}
      // 在捕获阶段拦截 Ctrl+滚轮，避免事件先冒泡到页面触发浏览器缩放；
      // 不阻止继续传播，React Flow 仍可在其内部处理画布缩放。
      onWheelCapture={handleCanvasWheelCapture}
      onContextMenu={(event) => {
        if (!shouldKeepNativeContextMenu(event.target)) event.preventDefault();
      }}
    >
      <CanvasNodeToolbar
        onOpenSkillWorkbench={onOpenSkillWorkbench}
        onAddGenerateNode={handleAddGenerateNode}
        onFitView={handleFitView}
        onRequestUpload={onRequestUpload}
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={onClearEmptyNodes}
        clearCounts={clearCounts}
        onCreateGroup={onCreateGroup}
        onUndoCanvas={onUndoCanvas}
        onRedoCanvas={onRedoCanvas}
        onOpenSearch={onOpenSearch}
        canvasTheme={canvasTheme}
        onThemeChange={onThemeChange}
        canvasBackground={background}
        onBackgroundChange={onBackgroundChange}
        canvasEdgePathStyle={edgePathStyle}
        onEdgePathStyleChange={onEdgePathStyleChange}
        canvasEdgeEffect={edgeEffect}
        onEdgeEffectChange={onEdgeEffectChange}
        canClearCanvas={canClearCanvas ?? (nodes.length > 0 || edges.length > 0)}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <NodeSelectionContext.Provider value={selectNodeByData}>
        <NodeResizeContext.Provider value={onResizeNode}>
          <NodeResizeStartContext.Provider value={onResizeStart ?? null}>
            <NodeLabelChangeContext.Provider value={onNodeLabelChange ?? null}>
              <NodeEnabledContext.Provider value={onNodeEnabledChange}>
                <NodeRetryContext.Provider value={onRetryNode}>
                  <NodeDeleteContext.Provider value={onDeleteNode ?? null}>
                    <NodeContentContext.Provider value={nodeContentHandlers ?? null}>
                      <NodeImageEditContext.Provider value={onEditImage ?? null}>
                        <NodePromptContext.Provider value={onOpenRequestPrompt ?? null}>
                          <NodeQuickEditorIdContext.Provider value={quickEditorNode?.id ?? null}>
                            <GenerationBatchViewContext.Provider value={batchContext}>
                              <CanvasEdgeAppearanceProvider appearance={edgeAppearance}>
                                {/* 组空白区域可选中、拖动，端口、连线与节点仍在组上层交互。 */}
                                <CanvasGroupLayer
                                  groups={groups}
                                  nodes={nodes}
                                  viewport={viewport}
                                  {...(dropTargetGroupId ? { dropTargetGroupId } : {})}
                                  {...(selectedGroupId ? { selectedGroupId } : {})}
                                  {...(onSelectGroup
                                    ? { onSelectGroup: (id) => onSelectGroup(id) }
                                    : {})}
                                  {...(onRenameGroup ? { onRenameGroup } : {})}
                                  {...(onDissolveGroup ? { onDissolveGroup } : {})}
                                  {...(onTranslateGroup ? { onTranslateGroup } : {})}
                                  {...(onResizeGroup ? { onResizeGroup } : {})}
                                  {...(onGroupInteractionStart ? { onGroupInteractionStart } : {})}
                                />
                                <ReactFlow
                                  nodes={batchProjection.nodes}
                                  edges={batchProjection.edges}
                                  nodeTypes={nodeTypes}
                                  edgeTypes={canvasEdgeTypes}
                                  connectionLineComponent={connectionLineComponent}
                                  onNodesChange={handleNodesChange}
                                  onEdgesChange={onEdgesChange}
                                  // 删除统一走 App 的控件边界、历史记录及保存，避免库默认 Backspace 穿透菜单。
                                  deleteKeyCode={null}
                                  onConnect={handleFlowConnect}
                                  onConnectStart={(_event, params) => {
                                    connectionStartRef.current = params;
                                  }}
                                  onConnectEnd={handleConnectEnd}
                                  onNodeDragStart={onNodeDragStart}
                                  onNodeDrag={
                                    onNodeDrag
                                      ? (event, node) => onNodeDrag(event, node as AssetFlowNode)
                                      : undefined
                                  }
                                  onNodeDragStop={
                                    onNodeDragStop
                                      ? (event, node) =>
                                          onNodeDragStop(event, node as AssetFlowNode)
                                      : undefined
                                  }
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
                                    if (suppressPaneClickRef.current) {
                                      suppressPaneClickRef.current = false;
                                      return;
                                    }
                                    setContextMenu(null);
                                    onClearNodeSelection();
                                  }}
                                  fitView
                                  minZoom={FIT_VIEW_MIN_ZOOM}
                                  fitViewOptions={{
                                    padding: 0.3,
                                    maxZoom: 1.1,
                                    minZoom: FIT_VIEW_MIN_ZOOM,
                                  }}
                                  connectionLineStyle={{ stroke: '#18794e', strokeWidth: 2 }}
                                  defaultEdgeOptions={{
                                    type: 'default',
                                    animated: false,
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
                                  <Controls showInteractive={false} position="bottom-right" />
                                </ReactFlow>
                              </CanvasEdgeAppearanceProvider>
                            </GenerationBatchViewContext.Provider>
                          </NodeQuickEditorIdContext.Provider>
                        </NodePromptContext.Provider>
                      </NodeImageEditContext.Provider>
                    </NodeContentContext.Provider>
                  </NodeDeleteContext.Provider>
                </NodeRetryContext.Provider>
              </NodeEnabledContext.Provider>
            </NodeLabelChangeContext.Provider>
          </NodeResizeStartContext.Provider>
        </NodeResizeContext.Provider>
      </NodeSelectionContext.Provider>
      {quickEditorNode && (
        <QuickEditorOverlay
          key={quickEditorNode.id}
          projectId={projectId}
          promptSkills={promptSkills}
          onOpenSkillWorkbench={onOpenSkillWorkbench}
          skillLibraryError={skillLibraryError}
          skillLibraryLoading={skillLibraryLoading}
          node={quickEditorNode}
          models={models}
          busy={isNodeBusy(quickEditorNode)}
          canvasAreaRef={canvasAreaRef}
          viewportZoom={viewport.zoom}
          assets={assets}
          connectedAssets={collectConnectedPromptAssets(quickEditorNode.id, nodes, edges, assets)}
          onConnectedResourceRename={
            onConnectedResourceRename
              ? (assetId, name) => onConnectedResourceRename(assetId, name, quickEditorNode.id)
              : undefined
          }
          onPromptChange={
            onPromptChange ? (value) => onPromptChange(value, quickEditorNode.id) : undefined
          }
          onPromptDocumentChange={
            onPromptDocumentChange
              ? (document) => onPromptDocumentChange(document, quickEditorNode.id)
              : undefined
          }
          onUploadResource={onUploadResource}
          onPromptSkillChange={
            onPromptSkillChange ? (id) => onPromptSkillChange(id, quickEditorNode.id) : undefined
          }
          onParametersChange={
            onParametersChange
              ? (value) => onParametersChange(value, quickEditorNode.id)
              : undefined
          }
          onGenerationCountChange={
            onGenerationCountChange
              ? (value) => onGenerationCountChange(value, quickEditorNode.id)
              : undefined
          }
          onCompletionActionChange={
            onCompletionActionChange
              ? (value) => onCompletionActionChange(value, quickEditorNode.id)
              : undefined
          }
          onCompletionTargetNodeIdChange={
            onCompletionTargetNodeIdChange
              ? (value) => onCompletionTargetNodeIdChange(value, quickEditorNode.id)
              : undefined
          }
          onVideoModeChange={
            onVideoModeChange ? (value) => onVideoModeChange(value, quickEditorNode.id) : undefined
          }
          connectedInputRoles={edges.flatMap((edge) => {
            if (edge.target !== quickEditorNode.id || !edge.targetHandle?.startsWith('input:')) {
              return [];
            }
            const role = edge.targetHandle.slice('input:'.length);
            return portRoles.includes(role as PortRole) ? [role as PortRole] : [];
          })}
          imageEditSource={resolveImageEditSourcePreview(quickEditorNode, nodes, assets)}
          onFocusImageEditSource={(sourceNodeId) => {
            const source = nodes.find((candidate) => candidate.id === sourceNodeId);
            if (source) handleCenterNode(source);
          }}
          emptyImageNodes={nodes
            .filter(
              (item) =>
                item.id !== quickEditorNode.id &&
                item.data.mediaType === 'image' &&
                !item.data.assetId &&
                !item.data.contentUrl &&
                !item.data.resultAsset,
            )
            .map((item) => ({ id: item.id, label: item.data.label }))}
          onModelChange={(value) => onModelChange(value, quickEditorNode.id)}
          onInferenceStrengthChange={(value) =>
            onInferenceStrengthChange(value, quickEditorNode.id)
          }
          hasConnectedInput={edges.some((edge) => edge.target === quickEditorNode.id)}
          onRun={() => onRunNode(quickEditorNode, 'sameNode')}
          onRunNewNode={() => onRunNode(quickEditorNode, 'newNode')}
        />
      )}
      {nodes.length === 0 && (
        <div className="canvas-welcome">
          <span className="canvas-kicker">工作流画布</span>
          <h2>从一个节点开始</h2>
          <p>上传资源、创建提示词节点，或从工作台打开另一张画布。</p>
          <div className="canvas-welcome-actions">
            <Button type="button" className="button button-primary" onClick={onRequestUpload}>
              <Upload size={15} aria-hidden="true" />
              上传资源
            </Button>
            <Button
              type="button"
              className="button button-secondary"
              onClick={() => handleAddGenerateNode('text')}
            >
              <FileText size={15} aria-hidden="true" />
              新建文字节点
            </Button>
            <Button type="button" className="button button-secondary" onClick={onOpenProjectHub}>
              <LayoutGrid size={15} aria-hidden="true" />
              打开工作台
            </Button>
          </div>
        </div>
      )}
      {videoImageRolePicker && (
        <VideoInputRolePicker
          target={videoImageRolePicker}
          videoMode={
            nodes.find((node) => node.id === videoImageRolePicker.connection.target)?.data.videoMode
          }
          onSelect={handleVideoImageRoleSelect}
          onClose={() => setVideoImageRolePicker(null)}
        />
      )}
      {currentContextMenu && (
        <CanvasContextMenu
          target={currentContextMenu}
          busy={currentContextMenu.kind === 'node' && isNodeBusy(currentContextMenu.node)}
          canDeleteNode={Boolean(onDeleteNode)}
          onRunNode={onRunNode}
          onCenterNode={handleCenterNode}
          onNodeEnabledChange={onNodeEnabledChange}
          onDeleteNode={(nodeId) => onDeleteNode?.(nodeId)}
          onAddGenerateNode={onAddGenerateNode}
          onAddConnectedGenerateNode={onAddConnectedGenerateNode}
          onRequestUpload={onRequestUpload}
          onOpenRequestPrompt={onOpenRequestPrompt}
          onEditImage={onEditImage}
          onCreateGroup={onCreateGroup}
          onUndoCanvas={onUndoCanvas}
          onRedoCanvas={onRedoCanvas}
          onClearCanvas={onClearCanvas}
          onClearEmptyNodes={onClearEmptyNodes}
          clearCounts={clearCounts}
          canClearCanvas={
            canClearCanvas ?? (nodes.length > 0 || edges.length > 0 || groups.length > 0)
          }
          canUndo={canUndo}
          canRedo={canRedo}
          onFitView={handleFitView}
          onOpenSearch={onOpenSearch}
          onClose={handleContextMenuClose}
        />
      )}
    </section>
  );
}

/** 快速编辑器 portal 所需的节点与画布引用。 */
type QuickEditorOverlayProps = Omit<NodeQuickEditorProps, 'node'> & {
  /** 当前选中的生成节点。 */
  node: AssetFlowNode;
  /** 用于约束浮层可见范围的画布容器引用。 */
  canvasAreaRef: RefObject<HTMLElement | null>;
  /** 画布当前缩放比例；用于将独立 portal 与节点保持同倍率。 */
  viewportZoom: number;
};

/**
 * 在画布外层渲染输入面板，按节点实测宽度和视口倍率同步缩放。
 * portal 避免被节点的 overflow 裁剪；碰撞检测使用屏幕像素，最终尺寸换回画布像素，
 * 使输入内容不影响节点外框，且缩放后仍避开节点、工具栏和画布边界。
 */
function QuickEditorOverlay({
  node,
  canvasAreaRef,
  viewportZoom,
  ...editorProps
}: QuickEditorOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  /** portal 宿主在客户端挂载后确定，服务端渲染阶段保持为空。 */
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  /** 当前编辑器视口坐标；完成首次测量前保持隐藏。 */
  const [layout, setLayout] = useState<QuickEditorLayout>({
    left: QUICK_EDITOR_VIEWPORT_MARGIN,
    top: QUICK_EDITOR_VIEWPORT_MARGIN,
    width: QUICK_EDITOR_FALLBACK_WIDTH,
    maxHeight: 420,
    scale: 1,
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
    if (
      !canvas ||
      !overlay ||
      !nodeElement ||
      !Number.isFinite(viewportZoom) ||
      viewportZoom <= 0
    ) {
      setLayout((current) => (current.ready ? { ...current, ready: false } : current));
      return;
    }

    const viewportWidth =
      Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0) ||
      QUICK_EDITOR_FALLBACK_WIDTH + QUICK_EDITOR_VIEWPORT_MARGIN * 2;
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
    const topbarBottom =
      canvas.closest('.app-shell')?.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
    const canvasTop = Math.max(
      topbarBottom + QUICK_EDITOR_VIEWPORT_MARGIN,
      hasCanvasBounds
        ? canvasRect.top + QUICK_EDITOR_VIEWPORT_MARGIN
        : QUICK_EDITOR_VIEWPORT_MARGIN,
    );
    const canvasBottom = hasCanvasBounds
      ? Math.min(
          viewportHeight - QUICK_EDITOR_VIEWPORT_MARGIN,
          canvasRect.bottom - QUICK_EDITOR_VIEWPORT_MARGIN,
        )
      : viewportHeight - QUICK_EDITOR_VIEWPORT_MARGIN;
    const boundedRight = Math.max(canvasLeft, canvasRight);
    const boundedBottom = Math.max(canvasTop, canvasBottom);
    let maxHeight = Math.max(1, boundedBottom - canvasTop);
    const nodeRect = nodeElement.getBoundingClientRect();
    const hasNodeBounds = nodeRect.width > 0 && nodeRect.height > 0;
    let width = Math.min(
      hasNodeBounds ? nodeRect.width : QUICK_EDITOR_FALLBACK_WIDTH * viewportZoom,
      Math.max(1, boundedRight - canvasLeft),
    );
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
      // 候选区域只取节点外侧，不以编辑器当前高度回推位置，避免增高或滚动时跳动。
      const nodeGap = QUICK_EDITOR_NODE_GAP * viewportZoom;
      const belowTop = Math.max(canvasTop, nodeRect.bottom + nodeGap);
      const aboveBottom = Math.min(boundedBottom, nodeRect.top - 64);
      const rightLeft = Math.max(canvasLeft, nodeRect.right + nodeGap);
      const leftRight = Math.min(boundedRight, nodeRect.left - nodeGap);
      const below = {
        placement: 'below' as const,
        left,
        top: belowTop,
        width,
        maxHeight: boundedBottom - belowTop,
      };
      // 上方为节点工具栏额外预留空间；侧面保留端口与缩放手柄间距。
      const above = {
        placement: 'above' as const,
        left,
        top: canvasTop,
        width,
        maxHeight: aboveBottom - canvasTop,
      };
      const right = {
        placement: 'right' as const,
        left: rightLeft,
        top: canvasTop,
        width: Math.min(width, boundedRight - rightLeft),
        maxHeight,
      };
      const sideWidth = Math.min(width, leftRight - canvasLeft);
      const leftSide = {
        placement: 'left' as const,
        left: leftRight - sideWidth,
        top: canvasTop,
        width: sideWidth,
        maxHeight,
      };
      const candidates = [below, above, right, leftSide].filter(
        (area) => area.width > 0 && area.maxHeight > 0,
      );
      const usable = candidates.filter((area) => area.width >= Math.min(360 * viewportZoom, width));
      const chosen =
        usable.find((area) => area.maxHeight >= 400 * viewportZoom) ??
        usable.sort((a, b) => b.maxHeight - a.maxHeight)[0] ??
        candidates.sort((a, b) => b.width * b.maxHeight - a.width * a.maxHeight)[0];
      if (chosen) {
        ({ left, top, width, maxHeight, placement } = chosen);
      } else {
        // 节点完全占满视口时没有不遮挡的浮层区域，缩放或平移后会重新测量。
        setLayout((current) => (current.ready ? { ...current, ready: false } : current));
        return;
      }
    }

    const nextLayout: QuickEditorLayout = {
      left,
      top,
      width: width / viewportZoom,
      maxHeight: Math.floor(maxHeight / viewportZoom),
      scale: viewportZoom,
      placement,
      ready: true,
    };
    setLayout((current) =>
      current.left === nextLayout.left &&
      current.top === nextLayout.top &&
      current.width === nextLayout.width &&
      current.maxHeight === nextLayout.maxHeight &&
      current.scale === nextLayout.scale &&
      current.placement === nextLayout.placement &&
      current.ready === nextLayout.ready
        ? current
        : nextLayout,
    );
  }, [canvasAreaRef, node.id, viewportZoom]);

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

  const style: CSSProperties & { '--quick-editor-max-height': string } = {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    visibility: layout.ready ? 'visible' : 'hidden',
    width: `${layout.width}px`,
    transform: `scale(${layout.scale})`,
    transformOrigin: 'top left',
    '--quick-editor-max-height': `${layout.maxHeight}px`,
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

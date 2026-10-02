import './canvas-drag-performance.css';
import { Button } from '@multimodal-canvas/ui';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  useViewport,
  useStore,
  type Connection,
  type ConnectionLineComponentProps,
  type FinalConnectionState,
  type OnConnectStart,
  type OnConnectStartParams,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { FileText, LayoutGrid, Upload } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type ReactNode,
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
  createGenerationBatchProjector,
  reconcileGenerationBatchChanges,
} from './generation-batch-view';
import { projectDraggingEdges, reuseNodeContentSnapshot } from './canvas-drag-performance';
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
import { CanvasPerformanceContext, LARGE_CANVAS_NODE_COUNT } from './canvas-render-detail';
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
import { getCenteredCanvasNodePosition, getToolbarCanvasNodePosition } from './canvas-position';
import { getQuickEditorLayout, type QuickEditorPlacementState } from './quick-editor-layout';
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

/** 缺省目录保持引用稳定，空画布拖动时不会使参数表单失去缓存。 */
const EMPTY_ASSETS: readonly Asset[] = [];

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
/** 静态配置不随拖动重建，避免 React Flow 对每个新引用分别广播全图 store。 */
const FLOW_FIT_VIEW_OPTIONS = { padding: 0.3, maxZoom: 1.1, minZoom: FIT_VIEW_MIN_ZOOM };
/** 新连线保留既有默认路径与静止外观。 */
const FLOW_DEFAULT_EDGE_OPTIONS = { type: 'default', animated: false };
/** 未完成连接的预览样式不依赖节点位置。 */
const FLOW_CONNECTION_LINE_STYLE = { stroke: '#18794e', strokeWidth: 2 };
/** 归属展示选项固定，不在位置帧中创建新对象。 */
const FLOW_PRO_OPTIONS = { hideAttribution: true };
/** 画布连线使用带路径形态与特效的默认边，几何与叠加层都由偏好驱动。 */
const canvasEdgeTypes = { default: FlowingCanvasEdge };

function shouldKeepNativeContextMenu(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(NATIVE_CONTEXT_MENU_SELECTOR));
}

/** 节点尚未取得尺寸时的输入面板回退宽度，单位为画布像素。 */
const QUICK_EDITOR_FALLBACK_WIDTH = 570;
/** 快速编辑器与可见画布边界之间的最小距离，单位为像素。 */
const QUICK_EDITOR_VIEWPORT_MARGIN = 8;
/** 编辑器内容尚未完成测量时的回退高度，单位为画布像素。 */
const QUICK_EDITOR_FALLBACK_HEIGHT = 400;

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
  /** 浮层相对于选中节点的展开方向；快速编辑器只在节点上下展开。 */
  placement: 'below' | 'above';
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
  assets = EMPTY_ASSETS,
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
  const canvasAreaRef = useRef<HTMLElement>(null);
  const connectionStartRef = useRef<OnConnectStartParams | null>(null);
  /** 吞掉拖线松手后紧随而来的 pane click，避免菜单刚弹出就被关掉。 */
  const suppressPaneClickRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuTarget | null>(null);
  const [videoImageRolePicker, setVideoImageRolePicker] =
    useState<VideoInputRolePickerTarget | null>(null);
  /** 只按拖动成员缓存，避免每一帧都重建隐藏边对象并触发节点的连线订阅。 */
  const draggingNodeIdsKey = JSON.stringify(
    nodes.filter((node) => node.dragging).map((node) => node.id),
  );
  const dragDisplayEdges = useMemo(
    () => projectDraggingEdges(edges, JSON.parse(draggingNodeIdsKey) as string[]),
    [edges, draggingNodeIdsKey],
  );
  /** 拖动和批量折叠都只投影显示状态，不修改真实节点与连线。 */
  const projectBatches = useMemo(() => createGenerationBatchProjector(), []);
  const batchProjection = useMemo(
    () => projectBatches(nodes, dragDisplayEdges),
    [nodes, dragDisplayEdges, projectBatches],
  );
  /** 事件读取最近提交的节点和回调，位置变化不向所有节点广播选择上下文。 */
  const nodeActionsRef = useRef({
    nodes,
    onNodeSelect,
    onDeleteNode,
    onOpenRequestPrompt,
    onNodesChange,
    onConnect,
    batchViews: batchProjection.views,
  });
  useLayoutEffect(() => {
    nodeActionsRef.current = {
      nodes,
      onNodeSelect,
      onDeleteNode,
      onOpenRequestPrompt,
      onNodesChange,
      onConnect,
      batchViews: batchProjection.views,
    };
  }, [
    nodes,
    onNodeSelect,
    onDeleteNode,
    onOpenRequestPrompt,
    onNodesChange,
    onConnect,
    batchProjection.views,
  ]);
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
  const handleNodesChange = useCallback<OnNodesChange<AssetFlowNode>>((changes) => {
    const current = nodeActionsRef.current;
    current.onNodesChange(
      reconcileGenerationBatchChanges(changes, current.nodes, current.batchViews),
    );
  }, []);
  /** 连线起点只写 ref，拖动节点无需重新注册连接事件。 */
  const handleConnectStart = useCallback<OnConnectStart>((_event, params) => {
    connectionStartRef.current = params;
  }, []);
  /** 拖线后的首个背景点击不清空新菜单，普通点击仍清除节点选择。 */
  const handlePaneClick = useCallback(() => {
    if (suppressPaneClickRef.current) {
      suppressPaneClickRef.current = false;
      return;
    }
    setContextMenu(null);
    onClearNodeSelection();
  }, [onClearNodeSelection]);
  /** 资源拖入画布保持复制语义，不随节点位置重新绑定。 */
  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
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
    (mediaType: MediaType) => {
      const bounds = canvasAreaRef.current?.getBoundingClientRect();
      onAddGenerateNode(
        mediaType,
        bounds
          ? getToolbarCanvasNodePosition(
              bounds,
              screenToFlowPosition,
              getNewNodeDimensions(mediaType),
            )
          : undefined,
      );
    },
    [onAddGenerateNode, screenToFlowPosition],
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

  /** 通过最新数据定位节点；兼容控件持有的历史数据对象，不冻结拖动后的坐标。 */
  const selectNodeByData = useCallback((data: AssetFlowNode['data']) => {
    const { nodes: currentNodes, onNodeSelect: select } = nodeActionsRef.current;
    const node =
      currentNodes.find((candidate) => candidate.data === data) ??
      currentNodes.find(
        (candidate) =>
          candidate.data.label === data.label &&
          candidate.data.mediaType === data.mediaType &&
          candidate.data.mode === data.mode,
      );
    if (node) select(node);
  }, []);

  /** 保持 React Flow 节点包装器的点击回调引用稳定，选择仍交给当前 App 回调。 */
  const handleNodeClick = useCallback((_event: ReactMouseEvent, node: AssetFlowNode) => {
    nodeActionsRef.current.onNodeSelect(node);
  }, []);

  /** App 的内联动作保持最新语义，但不因坐标刷新而广播整个节点树。 */
  const handleDeleteNode = useCallback((nodeId: string) => {
    nodeActionsRef.current.onDeleteNode?.(nodeId);
  }, []);
  /** 提示词入口沿用当前回调；未提供入口时 Context 仍为 null。 */
  const handleOpenRequestPrompt = useCallback((nodeId: string) => {
    nodeActionsRef.current.onOpenRequestPrompt?.(nodeId);
  }, []);

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
      nodeActionsRef.current.onNodeSelect(node);
      setContextMenu({
        kind: 'node',
        clientPosition: { x: event.clientX, y: event.clientY },
        node,
        returnFocusTo: getReturnFocusTarget(event),
      });
    },
    [getReturnFocusTarget],
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
      const { nodes, onConnect } = nodeActionsRef.current;
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
    [screenToFlowPosition],
  );

  const handleFlowConnect = useCallback((connection: Connection) => {
    const { nodes, onConnect } = nodeActionsRef.current;
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
  }, []);

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

  /** 位置变化只移动 portal 外壳，引用、参数和目录不变时复用完整表单。 */
  const previousEditorNodes = useRef<readonly AssetFlowNode[]>([]);
  const editorNodes = reuseNodeContentSnapshot(previousEditorNodes.current, nodes);
  useLayoutEffect(() => {
    previousEditorNodes.current = editorNodes;
  }, [editorNodes]);
  const editorNode = quickEditorNode
    ? (editorNodes.find((candidate) => candidate.id === quickEditorNode.id) ?? quickEditorNode)
    : null;
  const editorBusy = editorNode ? isNodeBusy(editorNode) : false;
  const quickEditor = useMemo(() => {
    if (!editorNode) return null;
    return (
      <MemoizedNodeQuickEditor
        key={editorNode.id}
        projectId={projectId}
        promptSkills={promptSkills}
        onOpenSkillWorkbench={onOpenSkillWorkbench}
        skillLibraryError={skillLibraryError}
        skillLibraryLoading={skillLibraryLoading}
        node={editorNode}
        models={models}
        busy={editorBusy}
        assets={assets}
        connectedAssets={collectConnectedPromptAssets(editorNode.id, editorNodes, edges, assets)}
        onConnectedResourceRename={
          onConnectedResourceRename
            ? (assetId, name) => onConnectedResourceRename(assetId, name, editorNode.id)
            : undefined
        }
        onPromptChange={
          onPromptChange ? (value) => onPromptChange(value, editorNode.id) : undefined
        }
        onPromptDocumentChange={
          onPromptDocumentChange
            ? (document) => onPromptDocumentChange(document, editorNode.id)
            : undefined
        }
        onUploadResource={onUploadResource}
        onPromptSkillChange={
          onPromptSkillChange ? (id) => onPromptSkillChange(id, editorNode.id) : undefined
        }
        onParametersChange={
          onParametersChange ? (value) => onParametersChange(value, editorNode.id) : undefined
        }
        onGenerationCountChange={
          onGenerationCountChange
            ? (value) => onGenerationCountChange(value, editorNode.id)
            : undefined
        }
        onCompletionActionChange={
          onCompletionActionChange
            ? (value) => onCompletionActionChange(value, editorNode.id)
            : undefined
        }
        onCompletionTargetNodeIdChange={
          onCompletionTargetNodeIdChange
            ? (value) => onCompletionTargetNodeIdChange(value, editorNode.id)
            : undefined
        }
        onVideoModeChange={
          onVideoModeChange ? (value) => onVideoModeChange(value, editorNode.id) : undefined
        }
        connectedInputRoles={edges.flatMap((edge) => {
          if (edge.target !== editorNode.id || !edge.targetHandle?.startsWith('input:')) {
            return [];
          }
          const role = edge.targetHandle.slice('input:'.length);
          return portRoles.includes(role as PortRole) ? [role as PortRole] : [];
        })}
        imageEditSource={resolveImageEditSourcePreview(editorNode, editorNodes, assets)}
        onFocusImageEditSource={(sourceNodeId) => {
          const source = nodeActionsRef.current.nodes.find(
            (candidate) => candidate.id === sourceNodeId,
          );
          if (source) handleCenterNode(source);
        }}
        emptyImageNodes={editorNodes
          .filter(
            (item) =>
              item.id !== editorNode.id &&
              item.data.mediaType === 'image' &&
              !item.data.assetId &&
              !item.data.contentUrl &&
              !item.data.resultAsset,
          )
          .map((item) => ({ id: item.id, label: item.data.label }))}
        onModelChange={(value) => onModelChange(value, editorNode.id)}
        onInferenceStrengthChange={(value) => onInferenceStrengthChange(value, editorNode.id)}
        hasConnectedInput={edges.some((edge) => edge.target === editorNode.id)}
        onRun={() => {
          const current = nodeActionsRef.current.nodes.find(
            (candidate) => candidate.id === editorNode.id,
          );
          if (current) onRunNode(current, 'sameNode');
        }}
        onRunNewNode={() => {
          const current = nodeActionsRef.current.nodes.find(
            (candidate) => candidate.id === editorNode.id,
          );
          if (current) onRunNode(current, 'newNode');
        }}
      />
    );
  }, [
    editorNode,
    editorNodes,
    editorBusy,
    edges,
    assets,
    models,
    projectId,
    promptSkills,
    onOpenSkillWorkbench,
    skillLibraryError,
    skillLibraryLoading,
    onConnectedResourceRename,
    onPromptChange,
    onPromptDocumentChange,
    onUploadResource,
    onPromptSkillChange,
    onParametersChange,
    onGenerationCountChange,
    onCompletionActionChange,
    onCompletionTargetNodeIdChange,
    onVideoModeChange,
    onModelChange,
    onInferenceStrengthChange,
    onRunNode,
    handleCenterNode,
  ]);

  return (
    <section
      ref={canvasAreaRef}
      className={`canvas-area${quickEditorNode ? ' has-quick-editor' : ''}${draggingNodeIdsKey !== '[]' ? ' is-node-dragging' : ''}`}
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
                  <NodeDeleteContext.Provider value={onDeleteNode ? handleDeleteNode : null}>
                    <NodeContentContext.Provider value={nodeContentHandlers ?? null}>
                      <NodeImageEditContext.Provider value={onEditImage ?? null}>
                        <NodePromptContext.Provider
                          value={onOpenRequestPrompt ? handleOpenRequestPrompt : null}
                        >
                          <NodeQuickEditorIdContext.Provider value={quickEditorNode?.id ?? null}>
                            <CanvasPerformanceContext.Provider
                              value={nodes.length >= LARGE_CANVAS_NODE_COUNT}
                            >
                              <GenerationBatchViewContext.Provider value={batchContext}>
                                <CanvasEdgeAppearanceProvider appearance={edgeAppearance}>
                                  {/* 组空白区域可选中、拖动，端口、连线与节点仍在组上层交互。 */}
                                  <ViewportGroupLayer
                                    groups={groups}
                                    nodes={nodes}
                                    {...(dropTargetGroupId ? { dropTargetGroupId } : {})}
                                    {...(selectedGroupId ? { selectedGroupId } : {})}
                                    {...(onSelectGroup
                                      ? { onSelectGroup: (id) => onSelectGroup(id) }
                                      : {})}
                                    {...(onRenameGroup ? { onRenameGroup } : {})}
                                    {...(onDissolveGroup ? { onDissolveGroup } : {})}
                                    {...(onTranslateGroup ? { onTranslateGroup } : {})}
                                    {...(onResizeGroup ? { onResizeGroup } : {})}
                                    {...(onGroupInteractionStart
                                      ? { onGroupInteractionStart }
                                      : {})}
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
                                    onConnectStart={handleConnectStart}
                                    onConnectEnd={handleConnectEnd}
                                    onNodeDragStart={onNodeDragStart}
                                    onNodeDrag={onNodeDrag}
                                    onNodeDragStop={onNodeDragStop}
                                    onMove={reportCanvasCenter}
                                    onDrop={handleDrop}
                                    onDragOver={handleDragOver}
                                    onNodeClick={handleNodeClick}
                                    onNodeContextMenu={handleNodeContextMenu}
                                    onPaneContextMenu={handlePaneContextMenu}
                                    onPaneClick={handlePaneClick}
                                    fitView
                                    minZoom={FIT_VIEW_MIN_ZOOM}
                                    fitViewOptions={FLOW_FIT_VIEW_OPTIONS}
                                    connectionLineStyle={FLOW_CONNECTION_LINE_STYLE}
                                    defaultEdgeOptions={FLOW_DEFAULT_EDGE_OPTIONS}
                                    proOptions={FLOW_PRO_OPTIONS}
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
                            </CanvasPerformanceContext.Provider>
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
          nodeId={quickEditorNode.id}
          canvasAreaRef={canvasAreaRef}
        >
          {quickEditor}
        </QuickEditorOverlay>
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

/** 视口坐标仅向组区域层广播，平移不重渲染画布全部节点和菜单。 */
function ViewportGroupLayer(props: Omit<ComponentProps<typeof CanvasGroupLayer>, 'viewport'>) {
  const viewport = useViewport();
  return <CanvasGroupLayer {...props} viewport={viewport} />;
}

/** 浮层跟随视口移动时复用输入控件，只在节点内容或参数变化时重渲染。 */
const MemoizedNodeQuickEditor = memo(NodeQuickEditor);

/** 快速编辑器 portal 所需的节点与画布引用。 */
type QuickEditorOverlayProps = {
  /** 当前编辑节点身份，几何从实时 DOM 读取，不与表单内容绑定。 */
  nodeId: string;
  /** 已按内容依赖缓存的参数表单。 */
  children: ReactNode;
  /** 用于约束浮层可见范围的画布容器引用。 */
  canvasAreaRef: RefObject<HTMLElement | null>;
};

/**
 * 在画布外层渲染输入面板，空间足够时宽度为节点的两倍，并随视口倍率同步缩放。
 * portal 避免被节点的 overflow 裁剪；碰撞检测使用屏幕像素，最终尺寸换回画布像素，
 * 使输入内容不影响节点外框；贴边等待换向时允许暂时重叠节点，但始终留在可见画布内。
 */
function QuickEditorOverlay({ nodeId, canvasAreaRef, children }: QuickEditorOverlayProps) {
  // 平移位置由视口 DOM 观察器更新；不让平移重渲染整个编辑器。
  const viewportZoom = useStore((state) => state.transform[2]);
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
  /** 记录实际触边位置与可用面板尺寸，仅在节点外侧布局中使用。 */
  const placementRef = useRef<QuickEditorPlacementState | null>(null);

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const host = canvasAreaRef.current?.closest<HTMLElement>('.app-shell') ?? document.body;
    setPortalHost((current) => (current === host ? current : host));
  }, [canvasAreaRef]);

  const measure = useCallback(() => {
    const canvas = canvasAreaRef.current;
    const overlay = overlayRef.current;
    const nodeElement = findReactFlowNodeElement(nodeId);
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
      hasNodeBounds ? nodeRect.width * 2 : QUICK_EDITOR_FALLBACK_WIDTH * viewportZoom,
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
      const editor = overlay.firstElementChild as HTMLElement | null;
      // scrollHeight 包含被 max-height 隐藏的内容；额外 1px 避免 CSSOM 取整制造无谓滚动条。
      const contentHeight =
        editor && editor.scrollHeight > 0
          ? editor.scrollHeight + editor.offsetHeight - editor.clientHeight + 1
          : 0;
      const resolved = getQuickEditorLayout({
        node: nodeRect,
        bounds: {
          left: canvasLeft,
          right: boundedRight,
          top: canvasTop,
          bottom: boundedBottom,
        },
        zoom: viewportZoom,
        editorHeight: (contentHeight || QUICK_EDITOR_FALLBACK_HEIGHT) * viewportZoom,
        previous: placementRef.current,
      });
      placementRef.current = resolved?.state ?? null;
      if (!resolved) {
        setLayout((current) => (current.ready ? { ...current, ready: false } : current));
        return;
      }
      ({ left, top, width, maxHeight, placement } = resolved);
    }

    const nextLayout: QuickEditorLayout = {
      left,
      top,
      width: width / viewportZoom,
      maxHeight: maxHeight / viewportZoom,
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
  }, [canvasAreaRef, nodeId, viewportZoom]);

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
    const nodeElement = findReactFlowNodeElement(nodeId);
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
    if (mutationObserver && overlay?.firstElementChild) {
      mutationObserver.observe(overlay.firstElementChild, {
        childList: true,
        characterData: true,
        subtree: true,
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
  }, [canvasAreaRef, measure, nodeId, portalHost]);

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
      data-node-id={nodeId}
      data-placement={layout.placement}
      style={style}
    >
      {children}
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

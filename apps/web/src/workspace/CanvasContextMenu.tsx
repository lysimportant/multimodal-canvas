import {
  CopyPlus,
  Eraser,
  FileText,
  Group,
  LocateFixed,
  Maximize2,
  Play,
  Power,
  Redo2,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { isImageEditSourceNode, mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import {
  getConnectionDropNodePosition,
  type ConnectedGenerateNodeRequest,
  type ConnectionDropCreateGroup,
  type ConnectionDropCreateOption,
} from '../connection-utils';
import { mediaIcons, mediaLabels } from './contracts';
import { nodeHasPrompt, type NodeRunTarget } from './fork-generate-node';
import type { ClearActionCounts } from './ClearCanvasMenu';

import './canvas-context-menu.css';

/** 右键菜单的来源上下文；坐标与返回焦点共同冻结到本次打开时。 */
export type CanvasContextMenuTarget =
  | {
      kind: 'canvas';
      clientPosition: { x: number; y: number };
      flowPosition: { x: number; y: number };
      returnFocusTo: HTMLElement | null;
    }
  | {
      kind: 'node';
      clientPosition: { x: number; y: number };
      node: AssetFlowNode;
      returnFocusTo: HTMLElement | null;
    }
  | {
      kind: 'connection-drop';
      clientPosition: { x: number; y: number };
      flowPosition: { x: number; y: number };
      sourceNode: AssetFlowNode;
      handleType: 'source' | 'target';
      handleId: string | null;
      groups: ConnectionDropCreateGroup[];
      returnFocusTo: HTMLElement | null;
    };

/** 区分操作、键盘取消和外部点击，供画布决定是否恢复焦点。 */
export type CanvasContextMenuCloseReason = 'action' | 'escape' | 'outside';

type CanvasContextMenuProps = {
  target: CanvasContextMenuTarget;
  busy: boolean;
  canDeleteNode: boolean;
  onRunNode: (node: AssetFlowNode, target?: NodeRunTarget) => void;
  onCenterNode: (node: AssetFlowNode) => void;
  onNodeEnabledChange: (nodeId: string, enabled: boolean) => void;
  onDeleteNode: (nodeId: string) => void;
  onAddGenerateNode: (mediaType: MediaType, position: { x: number; y: number }) => void;
  /** 悬空连线松手后创建节点并立刻连上。 */
  onAddConnectedGenerateNode: (request: ConnectedGenerateNodeRequest) => void;
  onRequestUpload: () => void;
  /** 打开当前节点的提示词记录与资源分析。 */
  onOpenRequestPrompt?: (nodeId: string) => void;
  /** 复用当前图片作为编辑来源并生成到新节点。 */
  onEditImage?: (nodeId: string) => void;
  /** 按已有选区或视口中心创建组。 */
  onCreateGroup?: () => void;
  onUndoCanvas?: () => void;
  onRedoCanvas?: () => void;
  onClearCanvas?: () => void;
  onClearEmptyNodes?: () => void;
  onFitView?: () => void;
  onOpenSearch?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canClearCanvas?: boolean;
  clearCounts?: ClearActionCounts;
  onClose: (reason: CanvasContextMenuCloseReason) => void;
};

/** 固定菜单与浏览器边缘之间的最小间距，单位为像素。 */
const VIEWPORT_PADDING = 8;

/** 按当前节点或画布上下文提供纵向菜单，操作复用画布的历史与确认逻辑。 */
export function CanvasContextMenu({
  target,
  busy,
  canDeleteNode,
  onRunNode,
  onCenterNode,
  onNodeEnabledChange,
  onDeleteNode,
  onAddGenerateNode,
  onAddConnectedGenerateNode,
  onRequestUpload,
  onOpenRequestPrompt,
  onEditImage,
  onCreateGroup,
  onUndoCanvas,
  onRedoCanvas,
  onClearCanvas,
  onClearEmptyNodes,
  onFitView,
  onOpenSearch,
  canUndo = true,
  canRedo = true,
  canClearCanvas = false,
  clearCounts,
  onClose,
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(target.clientPosition);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const bounds = menu.getBoundingClientRect();
      const maxLeft = Math.max(
        VIEWPORT_PADDING,
        window.innerWidth - bounds.width - VIEWPORT_PADDING,
      );
      const maxTop = Math.max(
        VIEWPORT_PADDING,
        window.innerHeight - bounds.height - VIEWPORT_PADDING,
      );
      setPosition({
        x: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.x, maxLeft)),
        y: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.y, maxTop)),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [target]);

  useLayoutEffect(() => {
    getEnabledMenuItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose('outside');
    };
    const handleWindowBlur = () => onClose('outside');
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [onClose]);

  const runAction = useCallback(
    (action: () => void) => {
      action();
      onClose('action');
    },
    [onClose],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose('escape');
      return;
    }
    if (event.key === 'Tab') {
      onClose('outside');
      return;
    }
    const items = getEnabledMenuItems(menuRef.current);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const content =
    target.kind === 'node' ? (
      <NodeMenuContent
        node={target.node}
        busy={busy}
        canDeleteNode={canDeleteNode}
        onRun={() => runAction(() => onRunNode(target.node))}
        onRunNewNode={() => runAction(() => onRunNode(target.node, 'newNode'))}
        onOpenRequestPrompt={
          onOpenRequestPrompt
            ? () => runAction(() => onOpenRequestPrompt(target.node.id))
            : undefined
        }
        onEditImage={onEditImage ? () => runAction(() => onEditImage(target.node.id)) : undefined}
        onCreateGroup={onCreateGroup ? () => runAction(onCreateGroup) : undefined}
        onCenter={() => runAction(() => onCenterNode(target.node))}
        onToggleEnabled={() =>
          runAction(() => onNodeEnabledChange(target.node.id, target.node.data.enabled === false))
        }
        onDelete={() => runAction(() => onDeleteNode(target.node.id))}
      />
    ) : target.kind === 'connection-drop' ? (
      <ConnectionDropMenuContent
        target={target}
        onSelect={(option) =>
          runAction(() =>
            onAddConnectedGenerateNode({
              mediaType: option.mediaType,
              position: getConnectionDropNodePosition(
                target.flowPosition,
                option.mediaType,
                target.handleType,
              ),
              existingNodeId: target.sourceNode.id,
              handleType: target.handleType,
              handleId: target.handleId,
              role: option.role,
              label: option.label,
              videoMode: option.videoMode,
            }),
          )
        }
      />
    ) : (
      <CanvasMenuContent
        onAddGenerateNode={(mediaType) =>
          runAction(() => onAddGenerateNode(mediaType, target.flowPosition))
        }
        onRequestUpload={() => runAction(onRequestUpload)}
        onCreateGroup={onCreateGroup ? () => runAction(onCreateGroup) : undefined}
        onUndoCanvas={onUndoCanvas ? () => runAction(onUndoCanvas) : undefined}
        onRedoCanvas={onRedoCanvas ? () => runAction(onRedoCanvas) : undefined}
        onClearCanvas={onClearCanvas ? () => runAction(onClearCanvas) : undefined}
        onClearEmptyNodes={onClearEmptyNodes ? () => runAction(onClearEmptyNodes) : undefined}
        onFitView={onFitView ? () => runAction(onFitView) : undefined}
        onOpenSearch={onOpenSearch ? () => runAction(onOpenSearch) : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        canClearCanvas={canClearCanvas}
        clearCounts={clearCounts}
      />
    );

  const ariaLabel =
    target.kind === 'node'
      ? `${target.node.data.label}节点操作`
      : target.kind === 'connection-drop'
        ? '选择要创建的节点'
        : '画布操作';

  return createPortal(
    <div
      ref={menuRef}
      className={`canvas-context-menu${target.kind === 'connection-drop' ? ' is-connection-drop' : ''}`}
      role="menu"
      aria-label={ariaLabel}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      {content}
    </div>,
    document.body,
  );
}

/** 节点菜单沿用当前运行状态；查看记录不受生成中的状态限制。 */
function NodeMenuContent({
  node,
  busy,
  canDeleteNode,
  onRun,
  onRunNewNode,
  onOpenRequestPrompt,
  onEditImage,
  onCreateGroup,
  onCenter,
  onToggleEnabled,
  onDelete,
}: {
  node: AssetFlowNode;
  busy: boolean;
  canDeleteNode: boolean;
  onRun: () => void;
  onRunNewNode: () => void;
  onOpenRequestPrompt?: () => void;
  onEditImage?: () => void;
  onCreateGroup?: () => void;
  onCenter: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const enabled = node.data.enabled !== false;
  const running = ['queued', 'preparing', 'running', 'processing', 'cancel_requested'].includes(
    node.data.runStatus ?? '',
  );
  return (
    <>
      <div className="canvas-context-menu-heading" title={node.data.label}>
        {node.data.label}
      </div>
      <div className="canvas-context-menu-group" role="group" aria-label="节点操作">
        <MenuItem
          icon={Play}
          label="开始生成"
          disabled={!enabled || busy || running}
          onClick={onRun}
        />
        <MenuItem
          icon={CopyPlus}
          label="生成到新节点"
          disabled={!enabled || busy || running}
          onClick={onRunNewNode}
        />
        {onOpenRequestPrompt ? (
          <MenuItem icon={FileText} label="提示词" onClick={onOpenRequestPrompt} />
        ) : null}
        {onEditImage && isImageEditSourceNode(node) ? (
          <MenuItem
            icon={WandSparkles}
            label="修改图片"
            disabled={busy || running || !nodeHasPrompt(node.data)}
            onClick={onEditImage}
          />
        ) : null}
      </div>
      <div className="canvas-context-menu-group" role="group" aria-label="节点布局">
        <MenuItem icon={LocateFixed} label="定位并居中节点" onClick={onCenter} />
        {onCreateGroup ? (
          <MenuItem icon={Group} label="为选中节点创建分组" onClick={onCreateGroup} />
        ) : null}
        <MenuItem
          icon={Power}
          label={enabled ? '停用节点' : '启用节点'}
          onClick={onToggleEnabled}
        />
      </div>
      <div className="canvas-context-menu-group" role="group" aria-label="危险操作">
        <MenuItem
          icon={Trash2}
          label="删除节点"
          disabled={!canDeleteNode}
          danger
          onClick={onDelete}
        />
      </div>
    </>
  );
}

/** 画布菜单仅展示已经接入的操作，并按历史与候选数量禁用不可执行项。 */
function CanvasMenuContent({
  onAddGenerateNode,
  onRequestUpload,
  onCreateGroup,
  onUndoCanvas,
  onRedoCanvas,
  onClearCanvas,
  onClearEmptyNodes,
  onFitView,
  onOpenSearch,
  canUndo,
  canRedo,
  canClearCanvas,
  clearCounts,
}: {
  onAddGenerateNode: (mediaType: MediaType) => void;
  onRequestUpload: () => void;
} & Pick<
  CanvasContextMenuProps,
  | 'onCreateGroup'
  | 'onUndoCanvas'
  | 'onRedoCanvas'
  | 'onClearCanvas'
  | 'onClearEmptyNodes'
  | 'onFitView'
  | 'onOpenSearch'
  | 'canUndo'
  | 'canRedo'
  | 'canClearCanvas'
  | 'clearCounts'
>) {
  return (
    <>
      <MenuGroup label="创建生成节点" actionIcon={Sparkles} onSelect={onAddGenerateNode} />
      <div className="canvas-context-menu-group" role="group" aria-label="资源">
        <MenuItem icon={Upload} label="上传资源" onClick={onRequestUpload} />
        {onCreateGroup ? <MenuItem icon={Group} label="新建分组" onClick={onCreateGroup} /> : null}
      </div>
      {onUndoCanvas || onRedoCanvas ? (
        <div className="canvas-context-menu-group" role="group" aria-label="画布历史">
          {onUndoCanvas ? (
            <MenuItem icon={Undo2} label="撤销" disabled={!canUndo} onClick={onUndoCanvas} />
          ) : null}
          {onRedoCanvas ? (
            <MenuItem icon={Redo2} label="重做" disabled={!canRedo} onClick={onRedoCanvas} />
          ) : null}
        </div>
      ) : null}
      {onFitView || onOpenSearch ? (
        <div className="canvas-context-menu-group" role="group" aria-label="画布视图">
          {onFitView ? (
            <MenuItem icon={Maximize2} label="自动适配缩放" onClick={onFitView} />
          ) : null}
          {onOpenSearch ? <MenuItem icon={Search} label="搜索" onClick={onOpenSearch} /> : null}
        </div>
      ) : null}
      {onClearCanvas || onClearEmptyNodes ? (
        <div className="canvas-context-menu-group" role="group" aria-label="清理画布">
          {onClearEmptyNodes ? (
            <MenuItem
              icon={Eraser}
              label="清理空节点"
              disabled={!clearCounts?.emptyNodes}
              onClick={onClearEmptyNodes}
            />
          ) : null}
          {onClearCanvas ? (
            <MenuItem
              icon={Trash2}
              label="清空画布"
              disabled={!canClearCanvas}
              danger
              onClick={onClearCanvas}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * 悬空连线松手后的创建菜单，按目标媒体类型分组。
 * @param target 松手处的连线上下文。
 * @param onSelect 选中某个创建选项后的回调。
 */
function ConnectionDropMenuContent({
  target,
  onSelect,
}: {
  target: Extract<CanvasContextMenuTarget, { kind: 'connection-drop' }>;
  onSelect: (option: ConnectionDropCreateOption) => void;
}) {
  const heading =
    target.handleType === 'target'
      ? `为「${target.sourceNode.data.label}」创建输入`
      : `从「${target.sourceNode.data.label}」创建`;

  return (
    <>
      <div className="canvas-context-menu-heading" title={heading}>
        {heading}
      </div>
      {target.groups.map((group) => {
        const Icon = mediaIcons[group.mediaType];
        return (
          <div
            key={group.mediaType}
            className="canvas-context-menu-group"
            role="group"
            aria-label={group.label}
          >
            <div className="canvas-context-menu-label">
              <Icon size={12} aria-hidden="true" />
              {group.label}
            </div>
            {group.options.map((option) => (
              <MenuItem
                key={option.id}
                icon={mediaIcons[option.mediaType]}
                label={option.label}
                description={option.description}
                onClick={() => onSelect(option)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** 四类媒体按单列呈现，保持键盘导航顺序与视觉顺序一致。 */
function MenuGroup({
  label,
  actionIcon: ActionIcon,
  onSelect,
}: {
  label: string;
  actionIcon: LucideIcon;
  onSelect: (mediaType: MediaType) => void;
}) {
  return (
    <div className="canvas-context-menu-group" role="group" aria-label={label}>
      <div className="canvas-context-menu-label">
        <ActionIcon size={12} aria-hidden="true" />
        {label}
      </div>
      <div className="canvas-context-menu-list">
        {mediaTypes.map((mediaType) => {
          const Icon = mediaIcons[mediaType];
          return (
            <MenuItem
              key={mediaType}
              icon={Icon}
              label={`创建${mediaLabels[mediaType]}生成节点`}
              onClick={() => onSelect(mediaType)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** 单个菜单命令，禁用状态不进入方向键焦点序列。 */
function MenuItem({
  icon: Icon,
  label,
  description,
  disabled = false,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canvas-context-menu-item${danger ? ' is-danger' : ''}`}
      role="menuitem"
      aria-label={label}
      title={disabled ? `${label}当前不可用` : (description ?? label)}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span className={description ? 'canvas-context-menu-item-copy' : undefined}>
        <span>{label}</span>
        {description ? (
          <small className="canvas-context-menu-item-desc">{description}</small>
        ) : null}
      </span>
    </button>
  );
}

/** 获取当前可聚焦菜单项；尚未挂载时返回空列表。 */
function getEnabledMenuItems(menu: HTMLDivElement | null) {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

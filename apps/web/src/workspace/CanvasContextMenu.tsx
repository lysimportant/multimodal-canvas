import { LocateFixed, Play, Power, Sparkles, Trash2, Upload, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import {
  getConnectionDropNodePosition,
  type ConnectedGenerateNodeRequest,
  type ConnectionDropCreateGroup,
  type ConnectionDropCreateOption,
} from '../connection-utils';
import { mediaIcons, mediaLabels } from './contracts';

import './canvas-context-menu.css';

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

export type CanvasContextMenuCloseReason = 'action' | 'escape' | 'outside';

type CanvasContextMenuProps = {
  target: CanvasContextMenuTarget;
  busy: boolean;
  canDeleteNode: boolean;
  onRunNode: (node: AssetFlowNode) => void;
  onCenterNode: (node: AssetFlowNode) => void;
  onNodeEnabledChange: (nodeId: string, enabled: boolean) => void;
  onDeleteNode: (nodeId: string) => void;
  onAddGenerateNode: (mediaType: MediaType, position: { x: number; y: number }) => void;
  /** 悬空连线松手后创建节点并立刻连上。 */
  onAddConnectedGenerateNode: (request: ConnectedGenerateNodeRequest) => void;
  onRequestUpload: () => void;
  onClose: (reason: CanvasContextMenuCloseReason) => void;
};

const VIEWPORT_PADDING = 8;

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
  onClose,
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(target.clientPosition);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - bounds.width - VIEWPORT_PADDING);
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - bounds.height - VIEWPORT_PADDING,
    );
    setPosition({
      x: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.x, maxLeft)),
      y: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.y, maxTop)),
    });
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
    items[nextIndex]?.focus({ preventScroll: true });
  };

  const content =
    target.kind === 'node' ? (
      <NodeMenuContent
        node={target.node}
        busy={busy}
        canDeleteNode={canDeleteNode}
        onRun={() => runAction(() => onRunNode(target.node))}
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

function NodeMenuContent({
  node,
  busy,
  canDeleteNode,
  onRun,
  onCenter,
  onToggleEnabled,
  onDelete,
}: {
  node: AssetFlowNode;
  busy: boolean;
  canDeleteNode: boolean;
  onRun: () => void;
  onCenter: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const enabled = node.data.enabled !== false;
  return (
    <>
      <div className="canvas-context-menu-heading" title={node.data.label}>
        {node.data.label}
      </div>
      <div className="canvas-context-menu-group" role="group" aria-label="节点操作">
        <MenuItem icon={LocateFixed} label="定位并居中节点" onClick={onCenter} />
        <MenuItem
          icon={Play}
          label="开始生成"
          disabled={node.data.mode === 'source' || !enabled || busy}
          onClick={onRun}
        />
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

function CanvasMenuContent({
  onAddGenerateNode,
  onRequestUpload,
}: {
  onAddGenerateNode: (mediaType: MediaType) => void;
  onRequestUpload: () => void;
}) {
  return (
    <>
      <MenuGroup label="创建生成节点" actionIcon={Sparkles} onSelect={onAddGenerateNode} />
      <div className="canvas-context-menu-group" role="group" aria-label="资源">
        <MenuItem icon={Upload} label="上传资源" onClick={onRequestUpload} />
      </div>
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
      <div className="canvas-context-menu-grid">
        {mediaTypes.map((mediaType) => {
          const Icon = mediaIcons[mediaType];
          return (
            <MenuItem
              key={mediaType}
              icon={Icon}
              label={`创建${mediaLabels[mediaType]}生成节点`}
              compactLabel={mediaLabels[mediaType]}
              onClick={() => onSelect(mediaType)}
            />
          );
        })}
      </div>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  compactLabel,
  description,
  disabled = false,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  compactLabel?: ReactNode;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canvas-context-menu-item${compactLabel ? ' is-compact' : ''}${danger ? ' is-danger' : ''}`}
      role="menuitem"
      aria-label={label}
      title={disabled ? `${label}当前不可用` : (description ?? label)}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span className={description ? 'canvas-context-menu-item-copy' : undefined}>
        <span>{compactLabel ?? label}</span>
        {description ? (
          <small className="canvas-context-menu-item-desc">{description}</small>
        ) : null}
      </span>
    </button>
  );
}

function getEnabledMenuItems(menu: HTMLDivElement | null) {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

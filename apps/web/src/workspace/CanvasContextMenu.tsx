import {
  LocateFixed,
  Play,
  Power,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
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
  onAddTransformNode: (mediaType: MediaType, position: { x: number; y: number }) => void;
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
  onAddTransformNode,
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
    ) : (
      <CanvasMenuContent
        onAddGenerateNode={(mediaType) =>
          runAction(() => onAddGenerateNode(mediaType, target.flowPosition))
        }
        onAddTransformNode={(mediaType) =>
          runAction(() => onAddTransformNode(mediaType, target.flowPosition))
        }
        onRequestUpload={() => runAction(onRequestUpload)}
      />
    );

  return createPortal(
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={target.kind === 'node' ? `${target.node.data.label}节点操作` : '画布操作'}
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
  onAddTransformNode,
  onRequestUpload,
}: {
  onAddGenerateNode: (mediaType: MediaType) => void;
  onAddTransformNode: (mediaType: MediaType) => void;
  onRequestUpload: () => void;
}) {
  return (
    <>
      <MenuGroup label="创建生成节点" actionIcon={Sparkles} onSelect={onAddGenerateNode} />
      <MenuGroup label="创建转换节点" actionIcon={Wand2} onSelect={onAddTransformNode} />
      <div className="canvas-context-menu-group" role="group" aria-label="资源">
        <MenuItem icon={Upload} label="上传资源" onClick={onRequestUpload} />
      </div>
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
  const modeLabel = label === '创建生成节点' ? '生成' : '转换';
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
              label={`创建${mediaLabels[mediaType]}${modeLabel}节点`}
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
  disabled = false,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  compactLabel?: ReactNode;
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
      title={disabled ? `${label}当前不可用` : label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" />
      <span>{compactLabel ?? label}</span>
    </button>
  );
}

function getEnabledMenuItems(menu: HTMLDivElement | null) {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

import { Eraser, Trash2 } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/** 清空动作的候选数量；数量为 0 时对应动作禁用。 */
export type ClearActionCounts = {
  /** 清空画布会移除的节点数。 */
  nodes: number;
  /** 清空画布会移除的连线数。 */
  edges: number;
  /** 清空画布会移除的组数。 */
  groups: number;
  /** 清空空节点会移除的候选节点数。 */
  emptyNodes: number;
  /** 清空空节点会移除的连线数（两端节点同时删除的边）。 */
  emptyNodeEdges: number;
};

type ClearCanvasMenuProps = {
  counts: ClearActionCounts;
  /** 清空画布；调用方负责确认、历史记录与保存。 */
  onClearCanvas: () => void;
  /** 只清空空节点；调用方负责确认、历史记录与保存。 */
  onClearEmptyNodes: () => void;
};

/** 离开触发区与菜单后延迟关闭，避免从按钮移入菜单时闪退。 */
const CLOSE_DELAY_MS = 160;

function hasCanvasContent(counts: ClearActionCounts): boolean {
  return counts.nodes > 0 || counts.edges > 0 || counts.groups > 0;
}

/**
 * 清空入口：橡皮擦按钮 hover、聚焦或点击后展开两个清空动作。
 *
 * 点击触发器本身只展开菜单，不直接删除任何内容；两个动作各自显示本次候选
 * 数量，没有可清理内容时禁用，因此不会弹出空确认框。
 */
export function ClearCanvasMenu({
  counts,
  onClearCanvas,
  onClearEmptyNodes,
}: ClearCanvasMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number>(0);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const canClearCanvas = hasCanvasContent(counts);
  const canClearEmptyNodes = counts.emptyNodes > 0;

  const clearCloseTimer = () => {
    window.clearTimeout(closeTimerRef.current);
  };

  const openMenu = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const closeNow = () => {
    clearCloseTimer();
    setOpen(false);
  };

  useEffect(() => () => clearCloseTimer(), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeNow();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeNow();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stopCanvasEvent = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const focusMenuItem = (key: 'ArrowDown' | 'ArrowUp') => {
    const items = rootRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    if (!items || items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = Array.from(items).findIndex((item) => item === active);
    const nextIndex =
      key === 'ArrowDown'
        ? index < 0
          ? 0
          : (index + 1) % items.length
        : index <= 0
          ? items.length - 1
          : index - 1;
    items[nextIndex]?.focus();
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
      // 菜单在本次渲染后出现，用微任务等待再聚焦第一项。
      window.setTimeout(() => focusMenuItem('ArrowDown'), 0);
    }
  };

  return (
    <div
      className="canvas-clear-menu"
      ref={rootRef}
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
      onFocus={openMenu}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        closeNow();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeNow();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          openMenu();
          focusMenuItem(event.key);
        }
      }}
    >
      <button
        type="button"
        className="canvas-node-tool canvas-node-action-tool canvas-node-action-destructive"
        aria-label="清空"
        title={canClearCanvas || canClearEmptyNodes ? '清空' : '画布为空'}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          // 触发器只负责展开，删除动作必须在菜单里明确选择；重复点击不关闭，
          // 关闭交给 Esc、外部点击或离开完整交互区域。
          openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
        disabled={!canClearCanvas && !canClearEmptyNodes}
      >
        <Eraser size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="canvas-clear-menu-card"
          id={menuId}
          role="menu"
          aria-label="清空操作"
          onPointerDown={stopCanvasEvent}
        >
          <button
            type="button"
            role="menuitem"
            className="canvas-clear-menu-item canvas-clear-menu-item-destructive"
            disabled={!canClearCanvas}
            title={canClearCanvas ? `移除 ${counts.nodes} 个节点` : '画布为空'}
            onClick={(event) => {
              event.stopPropagation();
              closeNow();
              onClearCanvas();
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            <span>清空画布</span>
            <small>
              {counts.nodes} 节点 · {counts.edges} 连线 · {counts.groups} 组
            </small>
          </button>
          <button
            type="button"
            role="menuitem"
            className="canvas-clear-menu-item"
            disabled={!canClearEmptyNodes}
            title={
              canClearEmptyNodes ? `仅移除内容为空的 ${counts.emptyNodes} 个节点` : '没有空节点'
            }
            onClick={(event) => {
              event.stopPropagation();
              closeNow();
              onClearEmptyNodes();
            }}
          >
            <Eraser size={14} aria-hidden="true" />
            <span>清空空节点</span>
            <small>
              {counts.emptyNodes} 节点
              {counts.emptyNodeEdges > 0 ? ` · ${counts.emptyNodeEdges} 连线` : ''}
            </small>
          </button>
        </div>
      ) : null}
    </div>
  );
}

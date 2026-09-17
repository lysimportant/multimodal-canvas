import { mediaTypes, type CanvasGroup } from '@multimodal-canvas/domain';
import { GripVertical, Group, Type, Ungroup } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { AssetFlowNode } from '../canvas-utils';
import { mediaIcons, mediaLabels } from './contracts';

import './canvas-group-hover-card.css';

/**
 * 组区域在画布视口中的渲染位置。
 *
 * React Flow 的 `viewport` 由调用方订阅；这里只做坐标换算，不读取 DOM 测量值，
 * 因此缩放画布时组与成员始终保持对齐。
 */
export type CanvasGroupViewport = { x: number; y: number; zoom: number };

/** 组展示数据与画布持有的布局操作。 */
type CanvasGroupLayerProps = {
  groups: readonly CanvasGroup[];
  /** 画布节点用于统计组成员的媒体类型，不改变成员归属。 */
  nodes?: readonly AssetFlowNode[];
  viewport: CanvasGroupViewport;
  /** 当前正在拖拽节点时预高亮的组。 */
  dropTargetGroupId?: string;
  /** 当前选中的组，用于保持悬浮卡片并显示调整手柄。 */
  selectedGroupId?: string;
  onSelectGroup?: (groupId: string | undefined) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onDissolveGroup?: (groupId: string) => void;
  /** 组拖动相对上一指针事件的位移，单位为画布像素。 */
  onTranslateGroup?: (groupId: string, delta: { x: number; y: number }) => void;
  /** 组外框尺寸变化，单位为画布像素；左上角/右上角拖动同时给出新的原点。 */
  onResizeGroup?: (
    groupId: string,
    size: { width: number; height: number; position?: { x: number; y: number } },
  ) => void;
  /** 开始整组移动或缩放前记录一次历史。 */
  onGroupInteractionStart?: () => void;
};

/** 单次指针交互的起点及外框快照，移动增量会在每次事件后更新。 */
type DragState = {
  kind: 'move' | 'resize';
  groupId: string;
  startClientX: number;
  startClientY: number;
  originWidth: number;
  originHeight: number;
  /** 缩放时被拖动的是哪一个角。 */
  corner?: 'se' | 'sw' | 'ne' | 'nw';
  originX: number;
  originY: number;
  /** 发起拖动的指针，避免第二根手指改变当前交互。 */
  pointerId: number;
  /** 越过位移阈值后才记录历史，单击选择不产生空撤销步骤。 */
  started: boolean;
  /** 保持拖动期间的指针归属，移出组范围后仍能继续移动。 */
  captureTarget: HTMLElement;
};

/**
 * 画布布局区域层。
 *
 * 组是画布布局，不是第五种媒体节点，不参与连线或运行。
 * 空白区域与标题均可选中、拖动；节点和连线保持在组上层并优先接收指针事件。
 */
export function CanvasGroupLayer({
  groups,
  nodes = [],
  viewport,
  dropTargetGroupId,
  selectedGroupId,
  onSelectGroup,
  onRenameGroup,
  onDissolveGroup,
  onTranslateGroup,
  onResizeGroup,
  onGroupInteractionStart,
}: CanvasGroupLayerProps) {
  const dragRef = useRef<DragState | undefined>(undefined);
  const groupElementsRef = useRef(new Map<string, HTMLDivElement>());
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [draftName, setDraftName] = useState('');
  const [hoveredGroup, setHoveredGroup] = useState<{ groupId: string; anchor: HTMLElement }>();
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** 允许指针从标题移动到悬浮卡片，短暂跨越间隙时不关闭。 */
  const keepHoverCardOpen = () => {
    if (hoverCloseTimer.current !== undefined) clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
  };
  /** 指针与焦点均离开后延迟关闭，便于点击卡片中的组操作。 */
  const closeHoverCardLater = () => {
    keepHoverCardOpen();
    hoverCloseTimer.current = setTimeout(() => {
      const anchor = selectedGroupId ? groupElementsRef.current.get(selectedGroupId) : undefined;
      setHoveredGroup(
        selectedGroupId && anchor && editingGroupId !== selectedGroupId
          ? { groupId: selectedGroupId, anchor }
          : undefined,
      );
    }, 120);
  };

  useLayoutEffect(() => {
    keepHoverCardOpen();
    const anchor = selectedGroupId ? groupElementsRef.current.get(selectedGroupId) : undefined;
    setHoveredGroup(
      selectedGroupId && anchor && editingGroupId !== selectedGroupId
        ? { groupId: selectedGroupId, anchor }
        : undefined,
    );
  }, [editingGroupId, selectedGroupId]);

  useEffect(
    () => () => {
      if (hoverCloseTimer.current !== undefined) clearTimeout(hoverCloseTimer.current);
    },
    [],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 3)
          return;
        drag.started = true;
        drag.captureTarget.setPointerCapture?.(drag.pointerId);
        onGroupInteractionStart?.();
      }
      const deltaX = (event.clientX - drag.startClientX) / viewport.zoom;
      const deltaY = (event.clientY - drag.startClientY) / viewport.zoom;
      if (drag.kind === 'move') {
        drag.startClientX = event.clientX;
        drag.startClientY = event.clientY;
        onTranslateGroup?.(drag.groupId, { x: deltaX, y: deltaY });
        return;
      }
      // 缩放只改变组外框：拖动左边界或上边界时原点跟随，右/下边界只改变尺寸。
      const widthDelta = drag.corner === 'sw' || drag.corner === 'nw' ? -deltaX : deltaX;
      const heightDelta = drag.corner === 'ne' || drag.corner === 'nw' ? -deltaY : deltaY;
      const movesLeft = drag.corner === 'nw' || drag.corner === 'sw';
      const movesTop = drag.corner === 'nw' || drag.corner === 'ne';
      onResizeGroup?.(drag.groupId, {
        width: drag.originWidth + widthDelta,
        height: drag.originHeight + heightDelta,
        ...(movesLeft || movesTop
          ? {
              position: {
                x: movesLeft ? drag.originX + deltaX : drag.originX,
                y: movesTop ? drag.originY + deltaY : drag.originY,
              },
            }
          : {}),
      });
    };
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag?.pointerId !== event.pointerId) return;
      if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
      dragRef.current = undefined;
    };
    const onBlur = () => {
      const drag = dragRef.current;
      if (drag?.captureTarget.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
      dragRef.current = undefined;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [onGroupInteractionStart, onResizeGroup, onTranslateGroup, viewport.zoom]);

  if (groups.length === 0) return null;

  /** 左键按下仅选中并记录起点，实际移动越过阈值后才写入历史。 */
  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    group: CanvasGroup,
    kind: DragState['kind'],
    corner?: DragState['corner'],
  ) => {
    if (event.button !== 0 || (dragRef.current && dragRef.current.pointerId !== event.pointerId))
      return;
    event.stopPropagation();
    if (kind === 'resize') event.preventDefault();
    onSelectGroup?.(group.id);
    dragRef.current = {
      kind,
      groupId: group.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originWidth: group.width,
      originHeight: group.height,
      originX: group.position.x,
      originY: group.position.y,
      pointerId: event.pointerId,
      started: false,
      captureTarget: event.currentTarget,
      ...(corner ? { corner } : {}),
    };
  };

  /** 打开重命名输入框时收起悬浮卡片，保持输入焦点。 */
  const startRename = (group: CanvasGroup) => {
    keepHoverCardOpen();
    setHoveredGroup(undefined);
    onSelectGroup?.(group.id);
    setDraftName(group.name);
    setEditingGroupId(group.id);
  };

  /** 提交有效且变更后的组名，空名称只退出编辑。 */
  const commitRename = (group: CanvasGroup) => {
    const next = draftName.trim();
    setEditingGroupId(undefined);
    if (!next || next === group.name) return;
    onRenameGroup?.(group.id, next);
  };

  return (
    <div className="canvas-group-layer" aria-hidden={groups.length === 0}>
      {groups.map((group) => {
        const selected = selectedGroupId === group.id;
        const isDropTarget = dropTargetGroupId === group.id;
        return (
          <div
            key={group.id}
            ref={(element) => {
              if (element) groupElementsRef.current.set(group.id, element);
              else groupElementsRef.current.delete(group.id);
            }}
            className={`canvas-group${selected ? ' is-selected' : ''}${
              isDropTarget ? ' is-drop-target' : ''
            }`}
            data-group-id={group.id}
            style={{
              transform: `translate(${viewport.x + group.position.x * viewport.zoom}px, ${
                viewport.y + group.position.y * viewport.zoom
              }px)`,
              width: group.width * viewport.zoom,
              height: group.height * viewport.zoom,
            }}
            onPointerDown={(event) => startDrag(event, group, 'move')}
            onPointerEnter={(event) => {
              keepHoverCardOpen();
              if (!dragRef.current && editingGroupId !== group.id) {
                setHoveredGroup({ groupId: group.id, anchor: event.currentTarget });
              }
            }}
            onPointerLeave={closeHoverCardLater}
            onFocus={(event) => {
              keepHoverCardOpen();
              if (editingGroupId !== group.id) {
                setHoveredGroup({ groupId: group.id, anchor: event.currentTarget });
              }
            }}
            onBlur={closeHoverCardLater}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setHoveredGroup(undefined);
            }}
          >
            <div
              className="canvas-group-header"
              style={{ width: group.width, transform: `scale(${viewport.zoom})` }}
            >
              {editingGroupId === group.id ? (
                <input
                  className="canvas-group-name-input"
                  aria-label="组名称"
                  value={draftName}
                  autoFocus
                  onChange={(event) => setDraftName(event.target.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onBlur={() => commitRename(group)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(group);
                    if (event.key === 'Escape') setEditingGroupId(undefined);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="canvas-group-name"
                  title="拖动组，双击重命名"
                  aria-pressed={selected}
                  onClick={() => onSelectGroup?.(group.id)}
                  onDoubleClick={() => startRename(group)}
                >
                  <Group size={12} aria-hidden="true" />
                  <span>{group.name}</span>
                  <small>{group.nodeIds.length}</small>
                </button>
              )}
            </div>
            {selected ? (
              <>
                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <span
                    key={corner}
                    className={`canvas-group-handle canvas-group-handle-${corner}`}
                    role="presentation"
                    data-corner={corner}
                    onPointerDown={(event) => startDrag(event, group, 'resize', corner)}
                  />
                ))}
              </>
            ) : null}
          </div>
        );
      })}
      {hoveredGroup && groups.some((group) => group.id === hoveredGroup.groupId) ? (
        <CanvasGroupHoverCard
          group={groups.find((group) => group.id === hoveredGroup.groupId)!}
          nodes={nodes}
          anchor={hoveredGroup.anchor}
          viewport={viewport}
          onEnter={keepHoverCardOpen}
          onLeave={closeHoverCardLater}
          onClose={() => setHoveredGroup(undefined)}
          onDrag={(event, group) => startDrag(event, group, 'move')}
          onRename={onRenameGroup ? startRename : undefined}
          onDissolve={
            onDissolveGroup
              ? (groupId) => {
                  setHoveredGroup(undefined);
                  onDissolveGroup(groupId);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

/**
 * 组的悬浮信息与常用操作；使用 portal，避免被媒体节点层或组边界裁切。
 * @param group 当前组；成员类型以 nodes 中仍存在的节点为准。
 * @param anchor 组元素，用于视口内定位；不会改变画布或节点尺寸。
 */
function CanvasGroupHoverCard({
  group,
  nodes,
  anchor,
  viewport,
  onEnter,
  onLeave,
  onClose,
  onDrag,
  onRename,
  onDissolve,
}: {
  group: CanvasGroup;
  nodes: readonly AssetFlowNode[];
  anchor: HTMLElement;
  viewport: CanvasGroupViewport;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onDrag: (event: ReactPointerEvent<HTMLElement>, group: CanvasGroup) => void;
  onRename?: (group: CanvasGroup) => void;
  onDissolve?: (groupId: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const members = nodes.filter((node) => group.nodeIds.includes(node.id));

  useLayoutEffect(() => {
    const updatePosition = () => {
      const bounds = anchor.getBoundingClientRect();
      const card = cardRef.current?.getBoundingClientRect();
      if (!card) return;
      const preferredTop = bounds.top - card.height - 6;
      setPosition({
        left: Math.max(
          8,
          Math.min(
            bounds.left + bounds.width / 2 - card.width / 2,
            window.innerWidth - card.width - 8,
          ),
        ),
        top: Math.max(
          8,
          Math.min(
            preferredTop >= 8 ? preferredTop : bounds.bottom + 6,
            window.innerHeight - card.height - 8,
          ),
        ),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor, group, nodes, viewport]);

  return createPortal(
    <div
      ref={cardRef}
      className="canvas-group-hover-card"
      role="region"
      aria-label={`${group.name}分组信息`}
      style={position}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        anchor.querySelector<HTMLButtonElement>('.canvas-group-name')?.focus();
        onClose();
      }}
    >
      <button
        type="button"
        className="canvas-group-hover-drag"
        aria-label={`拖动组 ${group.name}`}
        title="拖动整组"
        onPointerDown={(event) => onDrag(event, group)}
      >
        <GripVertical size={18} aria-hidden="true" />
      </button>
      <div className="canvas-group-hover-heading">
        <Group size={15} aria-hidden="true" />
        <strong>{group.name}</strong>
        <span>{group.nodeIds.length} 个节点</span>
      </div>
      <div className="canvas-group-hover-members">
        {mediaTypes.map((mediaType) => {
          const count = members.filter((node) => node.data.mediaType === mediaType).length;
          const Icon = mediaIcons[mediaType];
          return (
            <span key={mediaType}>
              <Icon size={14} aria-hidden="true" />
              {mediaLabels[mediaType]}
              <b>{count}</b>
            </span>
          );
        })}
        {group.nodeIds.length === 0 ? <span>暂无成员</span> : null}
      </div>
      {onRename || onDissolve ? (
        <div className="canvas-group-hover-actions">
          {onRename ? (
            <button
              type="button"
              aria-label={`重命名组 ${group.name}`}
              title="重命名"
              onClick={() => onRename(group)}
            >
              <Type size={14} aria-hidden="true" />
              <span>重命名</span>
            </button>
          ) : null}
          {onDissolve ? (
            <button
              type="button"
              aria-label={`解散组 ${group.name}`}
              title="解散组（保留成员）"
              onClick={() => onDissolve(group.id)}
            >
              <Ungroup size={14} aria-hidden="true" />
              <span>解散</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

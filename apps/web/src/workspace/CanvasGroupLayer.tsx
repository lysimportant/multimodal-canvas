import { Button, Input } from '@multimodal-canvas/ui';
import { Popover } from 'antd';
import { mediaTypes, type CanvasGroup } from '@multimodal-canvas/domain';
import { GripVertical, Group, Type, Ungroup } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ComponentRef,
} from 'react';

import { flushSync } from 'react-dom';

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
  /** 组拖动相对上一帧提交的位移，单位为画布像素。 */
  onTranslateGroup?: (groupId: string, delta: { x: number; y: number }) => void;
  /** 组外框尺寸变化，单位为画布像素；左上角/右上角拖动同时给出新的原点。 */
  onResizeGroup?: (
    groupId: string,
    size: { width: number; height: number; position?: { x: number; y: number } },
  ) => void;
  /** 开始整组移动或缩放前记录一次历史。 */
  onGroupInteractionStart?: (groupId: string, kind: 'move' | 'resize') => void;
  /** 松手、取消或窗口失焦后结束整组交互，恢复成员的正常显示。 */
  onGroupInteractionEnd?: () => void;
};

/** 单次指针交互的起点及外框快照，移动增量会在每次帧提交后更新。 */
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
 * 背景在节点下方接收空白拖动；标题、边框和手柄在节点上方，正文不拦截节点与端口。
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
  onGroupInteractionEnd,
}: CanvasGroupLayerProps) {
  const dragRef = useRef<DragState | undefined>(undefined);
  /** 保持监听器稳定；缩放和回调更新不取消已经排队的尾帧。 */
  const interactionRef = useRef({
    onGroupInteractionStart,
    onGroupInteractionEnd,
    onTranslateGroup,
    onResizeGroup,
    zoom: viewport.zoom,
  });
  useLayoutEffect(() => {
    interactionRef.current = {
      onGroupInteractionStart,
      onGroupInteractionEnd,
      onTranslateGroup,
      onResizeGroup,
      zoom: viewport.zoom,
    };
  }, [
    onGroupInteractionStart,
    onGroupInteractionEnd,
    onTranslateGroup,
    onResizeGroup,
    viewport.zoom,
  ]);
  const groupElementsRef = useRef(new Map<string, HTMLDivElement>());
  const popoverRef = useRef<ComponentRef<typeof Popover>>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [interacting, setInteracting] = useState(false);
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
    let frame: number | undefined;
    let pending: { clientX: number; clientY: number; zoom: number } | undefined;
    /** 每帧只提交最后的指针位置；同步提交组与 React Flow 成员，避免前后帧错位。 */
    const flushMove = (synchronous = true) => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      const event = pending;
      pending = undefined;
      const drag = dragRef.current;
      if (!event || !drag) return;
      const deltaX = (event.clientX - drag.startClientX) / event.zoom;
      const deltaY = (event.clientY - drag.startClientY) / event.zoom;
      const apply = () => {
        if (drag.kind === 'move') {
          drag.startClientX = event.clientX;
          drag.startClientY = event.clientY;
          if (deltaX || deltaY)
            interactionRef.current.onTranslateGroup?.(drag.groupId, { x: deltaX, y: deltaY });
          return;
        }
        const movesLeft = drag.corner === 'nw' || drag.corner === 'sw';
        const movesTop = drag.corner === 'nw' || drag.corner === 'ne';
        interactionRef.current.onResizeGroup?.(drag.groupId, {
          width: drag.originWidth + (movesLeft ? -deltaX : deltaX),
          height: drag.originHeight + (movesTop ? -deltaY : deltaY),
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
      // 卸载清理发生在 React 提交期，不在该阶段嵌套 flushSync。
      if (synchronous) flushSync(apply);
      else apply();
    };
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) < 3)
          return;
        drag.started = true;
        // 悬浮卡片会在拖动中隐藏，捕获指针交给不会卸载的组外框。
        drag.captureTarget.setPointerCapture?.(drag.pointerId);
        keepHoverCardOpen();
        setInteracting(true);
        interactionRef.current.onGroupInteractionStart?.(drag.groupId, drag.kind);
      }
      pending = {
        clientX: event.clientX,
        clientY: event.clientY,
        zoom: interactionRef.current.zoom,
      };
      if (frame === undefined) frame = requestAnimationFrame(() => flushMove());
    };
    /** 先补交最后一次位移，再释放指针和成员拖动态，不丢失松手前的移动。 */
    const finish = (synchronous = true) => {
      const drag = dragRef.current;
      if (!drag) return;
      flushMove(synchronous);
      dragRef.current = undefined;
      if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
      if (drag.started) {
        if (synchronous) setInteracting(false);
        interactionRef.current.onGroupInteractionEnd?.();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) finish();
    };
    const onBlur = () => finish();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      finish(false);
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useLayoutEffect(() => {
    // 视口平移只改变位置，不触发 ResizeObserver；静止时才重新对齐浮层。
    if (!interacting) popoverRef.current?.forceAlign();
  }, [viewport, groups, hoveredGroup, interacting]);

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
      captureTarget: groupElementsRef.current.get(group.id) ?? event.currentTarget,
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
          <Popover
            key={group.id}
            ref={hoveredGroup?.groupId === group.id ? popoverRef : undefined}
            open={hoveredGroup?.groupId === group.id}
            trigger={[]}
            placement="top"
            zIndex={74}
            arrow={false}
            destroyOnHidden
            fresh
            classNames={{ root: `canvas-group-popover${interacting ? ' is-interacting' : ''}` }}
            styles={{ container: { padding: 0 } }}
            content={
              hoveredGroup?.groupId === group.id ? (
                <CanvasGroupHoverCard
                  group={group}
                  nodes={nodes}
                  anchor={hoveredGroup.anchor}
                  onEnter={keepHoverCardOpen}
                  onLeave={closeHoverCardLater}
                  onClose={() => setHoveredGroup(undefined)}
                  onDrag={(event, target) => startDrag(event, target, 'move')}
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
              ) : null
            }
          >
            <div
              ref={(element) => {
                if (element) groupElementsRef.current.set(group.id, element);
                else groupElementsRef.current.delete(group.id);
              }}
              className={`canvas-group${selected ? ' is-selected' : ''}${
                isDropTarget ? ' is-drop-target' : ''
              }`}
              data-group-id={group.id}
              style={{
                left: viewport.x + group.position.x * viewport.zoom,
                top: viewport.y + group.position.y * viewport.zoom,
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
                  <Input
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
                  <Button
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
                  </Button>
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
          </Popover>
        );
      })}
    </div>
  );
}

/**
 * 分组 Popover 内的成员统计和操作；浮层定位由 Ant Design 负责。
 * @param group 当前组；成员类型以 nodes 中仍存在的节点为准。
 * @param anchor 组元素，用于 Escape 关闭后归还键盘焦点，不改变画布或节点尺寸。
 */
function CanvasGroupHoverCard({
  group,
  nodes,
  anchor,
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
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onDrag: (event: ReactPointerEvent<HTMLElement>, group: CanvasGroup) => void;
  onRename?: (group: CanvasGroup) => void;
  onDissolve?: (groupId: string) => void;
}) {
  const members = nodes.filter((node) => group.nodeIds.includes(node.id));

  return (
    <div
      className="canvas-group-hover-card"
      role="region"
      aria-label={`${group.name}分组信息`}
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
      <Button
        type="button"
        className="canvas-group-hover-drag"
        aria-label={`拖动组 ${group.name}`}
        title="拖动整组"
        onPointerDown={(event) => onDrag(event, group)}
      >
        <GripVertical size={18} aria-hidden="true" />
      </Button>
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
            <Button
              type="button"
              aria-label={`重命名组 ${group.name}`}
              title="重命名"
              onClick={() => onRename(group)}
            >
              <Type size={14} aria-hidden="true" />
              <span>重命名</span>
            </Button>
          ) : null}
          {onDissolve ? (
            <Button
              type="button"
              aria-label={`解散组 ${group.name}`}
              title="解散组（保留成员）"
              onClick={() => onDissolve(group.id)}
            >
              <Ungroup size={14} aria-hidden="true" />
              <span>解散</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

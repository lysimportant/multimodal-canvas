import type { CanvasGroup } from '@multimodal-canvas/domain';
import { Type, Trash2, Ungroup } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * 组区域在画布视口中的渲染位置。
 *
 * React Flow 的 `viewport` 由调用方订阅；这里只做坐标换算，不读取 DOM 测量值，
 * 因此缩放画布时组与成员始终保持对齐。
 */
export type CanvasGroupViewport = { x: number; y: number; zoom: number };

type CanvasGroupLayerProps = {
  groups: readonly CanvasGroup[];
  viewport: CanvasGroupViewport;
  /** 当前正在拖拽节点时预高亮的组。 */
  dropTargetGroupId?: string;
  /** 当前选中的组，用于显示操作按钮。 */
  selectedGroupId?: string;
  onSelectGroup?: (groupId: string | undefined) => void;
  onRenameGroup?: (groupId: string, name: string) => void;
  onDissolveGroup?: (groupId: string) => void;
  /** 组标题条相对上一指针事件的位移，单位为画布像素。 */
  onTranslateGroup?: (groupId: string, delta: { x: number; y: number }) => void;
  /** 组外框尺寸变化，单位为画布像素；左上角/右上角拖动同时给出新的原点。 */
  onResizeGroup?: (
    groupId: string,
    size: { width: number; height: number; position?: { x: number; y: number } },
  ) => void;
  /** 开始整组移动或缩放前记录一次历史。 */
  onGroupInteractionStart?: () => void;
};

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
};

/**
 * 画布布局区域层。
 *
 * 组是画布布局，不是第五种媒体节点：这里只渲染区域、标题条与调整手柄，
 * 不提供输入输出端口，也不参与连线或运行。整层使用 `pointer-events: none`，
 * 只有标题条与手柄接收指针事件，避免遮挡端口与连线。
 */
export function CanvasGroupLayer({
  groups,
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
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
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
    const onUp = () => {
      dragRef.current = undefined;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [onResizeGroup, onTranslateGroup, viewport.zoom]);

  if (groups.length === 0) return null;

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    group: CanvasGroup,
    kind: DragState['kind'],
    corner?: DragState['corner'],
  ) => {
    event.stopPropagation();
    event.preventDefault();
    onGroupInteractionStart?.();
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
      ...(corner ? { corner } : {}),
    };
  };

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
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelectGroup?.(group.id);
            }}
          >
            <div
              className="canvas-group-header"
              onPointerDown={(event) => startDrag(event, group, 'move')}
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
                  title="双击重命名"
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={() => {
                    setDraftName(group.name);
                    setEditingGroupId(group.id);
                  }}
                >
                  <Type size={12} aria-hidden="true" />
                  <span>{group.name}</span>
                  <small>{group.nodeIds.length}</small>
                </button>
              )}
              {selected ? (
                <span className="canvas-group-actions">
                  <button
                    type="button"
                    className="canvas-group-action"
                    aria-label={`重命名组 ${group.name}`}
                    title="重命名"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      setDraftName(group.name);
                      setEditingGroupId(group.id);
                    }}
                  >
                    <Type size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="canvas-group-action canvas-group-action-destructive"
                    aria-label={`解散组 ${group.name}`}
                    title="解散组（保留成员）"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onDissolveGroup?.(group.id)}
                  >
                    <Ungroup size={12} aria-hidden="true" />
                  </button>
                </span>
              ) : null}
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
                <span className="canvas-group-hint" aria-hidden="true">
                  <Trash2 size={10} /> 解散保留成员
                </span>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

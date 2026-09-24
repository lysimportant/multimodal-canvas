import { Dropdown } from 'antd';
import { Button } from '@multimodal-canvas/ui';
import { Eraser, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

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
  /** 两端节点同时删除时移除的边数。 */
  emptyNodeEdges: number;
};

/** 候选数量与清空回调；确认、历史记录和保存仍由调用方处理。 */
type ClearCanvasMenuProps = {
  counts: ClearActionCounts;
  onClearCanvas: () => void;
  onClearEmptyNodes: () => void;
};

/** 悬停、聚焦或点击只打开真实 Dropdown，不直接清空画布。 */
export function ClearCanvasMenu({
  counts,
  onClearCanvas,
  onClearEmptyNodes,
}: ClearCanvasMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const canClearCanvas = counts.nodes > 0 || counts.edges > 0 || counts.groups > 0;
  const canClearEmptyNodes = counts.emptyNodes > 0;

  return (
    <div className="canvas-clear-menu">
      <Dropdown
        open={open}
        onOpenChange={setOpen}
        trigger={['hover', 'click']}
        mouseEnterDelay={0}
        mouseLeaveDelay={0.16}
        placement="topRight"
        autoFocus
        styles={{ root: { pointerEvents: 'auto' } }}
        disabled={!canClearCanvas && !canClearEmptyNodes}
        destroyOnHidden
        getPopupContainer={(trigger) =>
          trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
        }
        menu={{
          id: menuId,
          'aria-label': '清空操作',
          selectable: false,
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            setOpen(false);
            if (key === 'canvas' && canClearCanvas) onClearCanvas();
            if (key === 'empty' && canClearEmptyNodes) onClearEmptyNodes();
          },
          items: [
            {
              key: 'canvas',
              icon: <Trash2 size={14} aria-hidden="true" />,
              danger: true,
              disabled: !canClearCanvas,
              title: canClearCanvas ? `移除 ${counts.nodes} 个节点` : '画布为空',
              label: (
                <span>
                  清空画布
                  <small style={{ display: 'block' }}>
                    {counts.nodes} 节点 · {counts.edges} 连线 · {counts.groups} 组
                  </small>
                </span>
              ),
            },
            {
              key: 'empty',
              icon: <Eraser size={14} aria-hidden="true" />,
              disabled: !canClearEmptyNodes,
              title: canClearEmptyNodes
                ? `仅移除内容为空的 ${counts.emptyNodes} 个节点`
                : '没有空节点',
              label: (
                <span>
                  清空空节点
                  <small style={{ display: 'block' }}>
                    {counts.emptyNodes} 节点
                    {counts.emptyNodeEdges > 0 ? ` · ${counts.emptyNodeEdges} 连线` : ''}
                  </small>
                </span>
              ),
            },
          ],
        }}
      >
        <Button
          type="button"
          variant="ghost"
          className="canvas-node-tool canvas-node-action-tool canvas-node-action-destructive"
          aria-label="清空"
          title={canClearCanvas || canClearEmptyNodes ? '清空' : '画布为空'}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          disabled={!canClearCanvas && !canClearEmptyNodes}
          onPointerDown={(event) => event.stopPropagation()}
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <Eraser size={16} aria-hidden="true" />
        </Button>
      </Dropdown>
    </div>
  );
}

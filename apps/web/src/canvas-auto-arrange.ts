import {
  CANVAS_GROUP_MAX_SIZE,
  CANVAS_GROUP_MIN_SIZE,
  type CanvasGroup,
} from '@multimodal-canvas/domain';

import {
  CANVAS_GROUP_PADDING,
  DEFAULT_FLOW_NODE_HEIGHT,
  DEFAULT_FLOW_NODE_WIDTH,
  type AssetFlowNode,
} from './canvas-utils';

/** 每个区块每行最多 30 个节点；组框超宽时允许减少列数。 */
const MAX_COLUMNS = 30;
/** 相邻列之间的净间距，单位为画布像素。 */
const COLUMN_GAP = 60;
/** 相邻行或区块之间的净间距，单位为画布像素。 */
const ROW_GAP = 80;

/** 按持久尺寸、测量尺寸、默认值取有限正数；单位为画布像素，不修改节点。 */
function nodeDimension(
  persisted: number | undefined,
  measured: number | undefined,
  fallback: number,
): number {
  for (const value of [persisted, measured]) {
    if (value !== undefined && Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

/** 计算非空区块的列/行偏移与包围尺寸；列数为 1–30，单位为画布像素，无副作用。 */
function measureGrid(nodes: readonly AssetFlowNode[], columns: number) {
  const columnWidths = Array<number>(columns).fill(0);
  const rowHeights = Array<number>(Math.ceil(nodes.length / columns)).fill(0);
  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(
      columnWidths[column],
      nodeDimension(node.width, node.measured?.width, DEFAULT_FLOW_NODE_WIDTH),
    );
    rowHeights[row] = Math.max(
      rowHeights[row],
      nodeDimension(node.height, node.measured?.height, DEFAULT_FLOW_NODE_HEIGHT),
    );
  });
  let width = 0;
  const columnOffsets = columnWidths.map((value, index) => {
    const offset = width;
    width += value + (index < columns - 1 ? COLUMN_GAP : 0);
    return offset;
  });
  let height = 0;
  const rowOffsets = rowHeights.map((value, index) => {
    const offset = height;
    height += value + (index < rowHeights.length - 1 ? ROW_GAP : 0);
    return offset;
  });
  return { columnOffsets, rowOffsets, width, height };
}

/**
 * 按原节点顺序整理绝对坐标，未分组节点在上，各组按原组顺序独立纵向排列。
 * @param nodes 已规范化、ID 唯一的节点；坐标与尺寸为画布像素，尺寸不会被改写。
 * @param groups 已规范化的互斥分组；保留身份、成员顺序及空组尺寸，不修复归属。
 * @returns 仅替换位置或组框发生变化的对象；未变化数组及业务字段复用引用，无副作用。
 * @throws RangeError 在最多 30 列的网格中仍无法将组成员与内边距容纳于合法组框时抛出。
 */
export function arrangeCanvasNodes(
  nodes: AssetFlowNode[],
  groups: CanvasGroup[],
): { nodes: AssetFlowNode[]; groups: CanvasGroup[] } {
  if (nodes.length === 0 && groups.length === 0) return { nodes, groups };

  const blocks: { group?: CanvasGroup; nodes: AssetFlowNode[] }[] = [{ nodes: [] }];
  const memberships = new Map<string, number>();
  let startX = Number.POSITIVE_INFINITY;
  let startY = Number.POSITIVE_INFINITY;
  groups.forEach((group, index) => {
    blocks.push({ group, nodes: [] });
    group.nodeIds.forEach((id) => memberships.set(id, index + 1));
    startX = Math.min(startX, group.position.x);
    startY = Math.min(startY, group.position.y);
  });
  for (const node of nodes) {
    blocks[memberships.get(node.id) ?? 0].nodes.push(node);
    startX = Math.min(startX, node.position.x);
    startY = Math.min(startY, node.position.y);
  }

  const positions = new Map<string, AssetFlowNode['position']>();
  const nextGroups: CanvasGroup[] = [];
  let nextY = startY;
  for (const { group, nodes: members } of blocks) {
    if (members.length === 0 && !group) continue;
    let width = group?.width ?? 0;
    let height = group?.height ?? 0;
    if (members.length > 0) {
      const padding = group ? CANVAS_GROUP_PADDING : 0;
      let columns = Math.min(MAX_COLUMNS, members.length);
      let grid = measureGrid(members, columns);
      while (
        group &&
        (grid.width + padding * 2 > CANVAS_GROUP_MAX_SIZE ||
          grid.height + padding * 2 > CANVAS_GROUP_MAX_SIZE)
      ) {
        columns -= 1;
        if (columns === 0) {
          throw new RangeError(
            `分组“${group.name}”无法在最多 ${MAX_COLUMNS} 列及 ${CANVAS_GROUP_MAX_SIZE} 像素边长内整理，请减少成员或缩小节点。`,
          );
        }
        grid = measureGrid(members, columns);
      }
      members.forEach((node, index) => {
        positions.set(node.id, {
          x: startX + padding + grid.columnOffsets[index % columns],
          y: nextY + padding + grid.rowOffsets[Math.floor(index / columns)],
        });
      });
      width = Math.max(group ? CANVAS_GROUP_MIN_SIZE : 0, grid.width + padding * 2);
      height = Math.max(group ? CANVAS_GROUP_MIN_SIZE : 0, grid.height + padding * 2);
    }
    if (group) {
      const position =
        group.position.x === startX && group.position.y === nextY
          ? group.position
          : { x: startX, y: nextY };
      nextGroups.push(
        position === group.position && width === group.width && height === group.height
          ? group
          : { ...group, position, width, height },
      );
    }
    nextY += height + ROW_GAP;
  }

  const nextNodes = nodes.map((node) => {
    const position = positions.get(node.id)!;
    return position.x === node.position.x && position.y === node.position.y
      ? node
      : { ...node, position };
  });
  return {
    nodes: nextNodes.every((node, index) => node === nodes[index]) ? nodes : nextNodes,
    groups: nextGroups.every((group, index) => group === groups[index]) ? groups : nextGroups,
  };
}

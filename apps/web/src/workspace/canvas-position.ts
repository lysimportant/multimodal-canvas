export type CanvasViewportBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FlowPosition = { x: number; y: number };
export type ScreenToFlowPosition = (position: FlowPosition) => FlowPosition;

import { DEFAULT_FLOW_NODE_WIDTH, DEFAULT_FLOW_NODE_HEIGHT } from '../canvas-utils';

/** 创建位置与节点实际默认尺寸共用常量，保持几何中心一致。 */
export const DEFAULT_NODE_FLOW_WIDTH = DEFAULT_FLOW_NODE_WIDTH;
/** 创建位置计算使用的默认高度，单位为画布像素。 */
export const DEFAULT_NODE_FLOW_HEIGHT = DEFAULT_FLOW_NODE_HEIGHT;

export function getCenteredCanvasNodePosition(
  bounds: CanvasViewportBounds,
  screenToFlowPosition: ScreenToFlowPosition,
  dimensions = { width: DEFAULT_NODE_FLOW_WIDTH, height: DEFAULT_NODE_FLOW_HEIGHT },
): FlowPosition | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;

  const center = screenToFlowPosition({
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  });

  return {
    x: center.x - dimensions.width / 2,
    y: center.y - dimensions.height / 2,
  };
}

/** 新节点与已有节点之间保留的最小间距，单位为画布像素。 */
export const NEW_NODE_PLACEMENT_GAP = 16;
/**
 * 每一行向右尝试的最大列数。
 *
 * 右侧第一格被占用就向下换行，保持新节点挨着父节点，而不是一路向右排开。
 */
export const NEW_NODE_PLACEMENT_MAX_COLUMNS = 1;
/** 向下寻找空位的最大行数，避免异常画布导致死循环。 */
const NEW_NODE_PLACEMENT_MAX_ROWS = 200;

export type PlacedNodeBox = {
  position: FlowPosition;
  width?: number;
  height?: number;
};

function nodeBoxDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/**
 * 计算新建节点的可用位置：优先放在来源节点右侧，发生碰撞时继续向右或向下寻找空位。
 *
 * 只读取节点自身保存的宽高，不改动来源节点尺寸；未保存尺寸的旧节点按该媒体的
 * 新建默认尺寸参与碰撞计算。
 *
 * @param source 来源节点当前的位置与尺寸。
 * @param existing 画布上其它节点（可以包含来源节点自身）。
 * @param dimensions 新节点使用的默认宽高。
 * @param gap 节点之间保留的间距，单位为画布像素。
 * @returns 与已有节点都不重叠的新节点左上角坐标。
 */
export function getNodePlacementRightOf(
  source: { position: FlowPosition; width?: number; height?: number },
  existing: readonly PlacedNodeBox[],
  dimensions: { width: number; height: number },
  gap: number = NEW_NODE_PLACEMENT_GAP,
): FlowPosition {
  const sourceWidth = nodeBoxDimension(source.width, dimensions.width);
  const sourceHeight = nodeBoxDimension(source.height, dimensions.height);
  const occupied = existing
    .map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: nodeBoxDimension(node.width, dimensions.width),
      height: nodeBoxDimension(node.height, dimensions.height),
    }))
    .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y));

  const startX = source.position.x + sourceWidth + gap;
  const startY = source.position.y;
  const stepX = dimensions.width + gap;

  for (let row = 0; row < NEW_NODE_PLACEMENT_MAX_ROWS; row += 1) {
    const candidateY = startY + row * (sourceHeight + gap);
    for (let column = 0; column < NEW_NODE_PLACEMENT_MAX_COLUMNS; column += 1) {
      const candidate = {
        x: startX + column * stepX,
        y: candidateY,
        width: dimensions.width,
        height: dimensions.height,
      };
      if (!occupied.some((node) => boxesOverlap(candidate, node))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
  }

  return { x: startX, y: startY };
}

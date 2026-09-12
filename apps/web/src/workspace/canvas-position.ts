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

export type CanvasViewportBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FlowPosition = { x: number; y: number };
export type ScreenToFlowPosition = (position: FlowPosition) => FlowPosition;

export const DEFAULT_NODE_FLOW_WIDTH = 180;
export const DEFAULT_NODE_FLOW_HEIGHT = 173;

export function getCenteredCanvasNodePosition(
  bounds: CanvasViewportBounds,
  screenToFlowPosition: ScreenToFlowPosition,
): FlowPosition | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;

  const center = screenToFlowPosition({
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  });

  return {
    x: center.x - DEFAULT_NODE_FLOW_WIDTH / 2,
    y: center.y - DEFAULT_NODE_FLOW_HEIGHT / 2,
  };
}

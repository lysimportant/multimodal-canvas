import { BaseEdge, getBezierPath, Position, type EdgeProps } from '@xyflow/react';

/** 可见锚点直径为 18px，连线终点收到圆心，避免停在外沿。 */
const HANDLE_CENTER_INSET = 9;

/**
 * 把路径端点从锚点外沿收进圆心。
 * @param x 当前端点 X，单位为画布坐标。
 * @param y 当前端点 Y，单位为画布坐标。
 * @param position 锚点所在边。
 * @returns 收进后的端点。
 */
function insetHandlePoint(x: number, y: number, position: Position) {
  switch (position) {
    case Position.Left:
      return { x: x + HANDLE_CENTER_INSET, y };
    case Position.Right:
      return { x: x - HANDLE_CENTER_INSET, y };
    case Position.Top:
      return { x, y: y + HANDLE_CENTER_INSET };
    case Position.Bottom:
      return { x, y: y - HANDLE_CENTER_INSET };
    default:
      return { x, y };
  }
}

/**
 * 画布默认连线：贝塞尔路径贴合锚点圆心，并叠加流光。
 * @param props React Flow 边渲染参数。
 * @returns 主路径与流光子路径。
 */
export function FlowingCanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const source = insetHandlePoint(sourceX, sourceY, sourcePosition);
  const target = insetHandlePoint(targetX, targetY, targetPosition);
  const [path] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        className={`canvas-flow-edge-path${selected ? ' is-selected' : ''}`}
      />
      <path d={path} className="canvas-flow-edge-meteor" />
    </>
  );
}

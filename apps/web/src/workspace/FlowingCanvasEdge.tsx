import {
  BaseEdge,
  getBezierPath,
  Position,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react';

/** 与节点锚点 CSS 直径保持一致，用于把落定连线从外沿收到圆心。 */
export const FLOW_HANDLE_SIZE = 18;

/**
 * 把 React Flow 给出的锚点外沿坐标收到可见圆点的圆心。
 *
 * xyflow 的 `getHandlePosition(..., center = false)` 对上/右/下/左分别取外沿，
 * 18px 锚点会让线停在圆点外侧 9px。四类媒体节点共用同一套锚点尺寸和居中样式，
 * 因此同一套内收对 text/image/audio/video 都成立。
 *
 * @param x 当前端点 X，单位为画布坐标。
 * @param y 当前端点 Y，单位为画布坐标。
 * @param position 锚点所在边。
 * @returns 圆心坐标。
 */
export function centerHandlePoint(x: number, y: number, position: Position) {
  const inset = FLOW_HANDLE_SIZE / 2;
  switch (position) {
    case Position.Left:
      return { x: x + inset, y };
    case Position.Right:
      return { x: x - inset, y };
    case Position.Top:
      return { x, y: y + inset };
    case Position.Bottom:
      return { x, y: y - inset };
    default:
      return { x, y };
  }
}

/**
 * 画布默认连线：四类节点的路径都对准锚点圆心，并叠加流光。
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
  const source = centerHandlePoint(sourceX, sourceY, sourcePosition);
  const target = centerHandlePoint(targetX, targetY, targetPosition);
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

/**
 * 拖拽连线预览。xyflow 对预览端点已经使用 `center = true`，不能再内收，
 * 否则会从圆心再往节点内偏移，松手后还会和落定边跳点。
 * @param props React Flow 连接线参数。
 * @returns 预览路径。
 */
export function FlowingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
}: Pick<
  ConnectionLineComponentProps,
  'fromX' | 'fromY' | 'toX' | 'toY' | 'fromPosition' | 'toPosition'
>) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  return (
    <g>
      <path d={path} className="canvas-flow-edge-path" fill="none" />
      <path d={path} className="canvas-flow-edge-meteor" fill="none" />
    </g>
  );
}

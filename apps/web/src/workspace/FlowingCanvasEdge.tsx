import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

/**
 * 画布默认连线：使用 React Flow 测得的锚点坐标，并叠加流光。
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
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
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

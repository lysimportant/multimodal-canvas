import {
  BaseEdge,
  Position,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react';

import {
  edgeEffectOverlayClassName,
  resolveEdgePath,
  useCanvasEdgeAppearance,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';

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

/** 基础路径的类名；`marching` 直接改造基础路径，因此把动画类名挂在同一元素上。 */
function baseEdgeClassName(effect: CanvasEdgeEffect, selected: boolean): string {
  const marching = effect === 'marching' ? ' canvas-edge-effect-marching' : '';
  return `canvas-flow-edge-path${marching}${selected ? ' is-selected' : ''}`;
}

/**
 * 特效叠加层。叠加层不参与命中测试，也不随选中态变化；选择、状态颜色和连线删除
 * 始终由基础边负责。
 * @param props.path 与基础边完全相同的路径，叠加层不会改写基础边的 `d`。
 * @param props.effect 当前动态特效。
 * @returns 叠加路径；`marching` 与 `none` 不渲染叠加层。
 */
function EdgeEffectOverlay({ path, effect }: { path: string; effect: CanvasEdgeEffect }) {
  const className = edgeEffectOverlayClassName(effect);
  if (!className) return null;
  return (
    <path d={path} aria-hidden="true" data-testid="edge-effect-overlay" className={className} />
  );
}

/**
 * 画布默认连线：四类节点的路径都对准锚点圆心，并按当前偏好叠加特效。
 * 路径形态与特效来自 `CanvasEdgeAppearanceProvider`，缺少 Provider 时使用默认值。
 * @param props React Flow 边渲染参数。
 * @returns 主路径与可选的特效叠加路径。
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
  const { pathStyle, effect } = useCanvasEdgeAppearance();
  const source = centerHandlePoint(sourceX, sourceY, sourcePosition);
  const target = centerHandlePoint(targetX, targetY, targetPosition);
  const path = resolveEdgePath(pathStyle, {
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
        className={baseEdgeClassName(effect, Boolean(selected))}
      />
      <EdgeEffectOverlay path={path} effect={effect} />
    </>
  );
}

/**
 * 拖拽连线预览。xyflow 对预览端点已经使用 `center = true`，不能再内收，
 * 否则会从圆心再往节点内偏移，松手后还会和落定边跳点。
 * 路径形态与特效由调用方注入，保证与落定边完全一致。
 * @param props React Flow 连接线参数与当前连接线外观。
 * @returns 预览路径与可选的特效叠加路径。
 */
export function FlowingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  pathStyle,
  effect,
}: Pick<
  ConnectionLineComponentProps,
  'fromX' | 'fromY' | 'toX' | 'toY' | 'fromPosition' | 'toPosition'
> & { pathStyle: CanvasEdgePathStyle; effect: CanvasEdgeEffect }) {
  const path = resolveEdgePath(pathStyle, {
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  return (
    <g>
      <path d={path} fill="none" className={baseEdgeClassName(effect, false)} />
      <EdgeEffectOverlay path={path} effect={effect} />
    </g>
  );
}

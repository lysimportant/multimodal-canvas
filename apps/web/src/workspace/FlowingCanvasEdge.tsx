import {
  BaseEdge,
  Position,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react';

import {
  resolveEdgePath,
  useCanvasEdgeAppearance,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';
import { CanvasEdgeEffectOverlay } from './CanvasEdgeEffectOverlay';

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
      <CanvasEdgeEffectOverlay path={path} effect={effect} />
    </>
  );
}

/**
 * 拖拽连线预览。xyflow 对预览端点已经使用 `center = true`，不能再内收，
 * 否则会从圆心再往节点内偏移，松手后还会和落定边跳点。
 * 路径形态与特效由调用方注入；从输入端反向拖线时交换端点，仍保持源到目标的方向。
 * @param props React Flow 连接线参数与当前连接线外观。
 * @param props.fromHandle 拖线起点锚点；未传时按源端拖线处理，传入 target 时反转几何方向。
 * @returns 预览路径与可选的特效叠加路径。
 */
export function FlowingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  fromHandle,
  pathStyle,
  effect,
}: Pick<
  ConnectionLineComponentProps,
  'fromX' | 'fromY' | 'toX' | 'toY' | 'fromPosition' | 'toPosition'
> &
  Partial<Pick<ConnectionLineComponentProps, 'fromHandle'>> & {
    pathStyle: CanvasEdgePathStyle;
    effect: CanvasEdgeEffect;
  }) {
  const fromTarget = fromHandle?.type === 'target';
  const path = resolveEdgePath(pathStyle, {
    sourceX: fromTarget ? toX : fromX,
    sourceY: fromTarget ? toY : fromY,
    targetX: fromTarget ? fromX : toX,
    targetY: fromTarget ? fromY : toY,
    sourcePosition: fromTarget ? toPosition : fromPosition,
    targetPosition: fromTarget ? fromPosition : toPosition,
  });
  return (
    <g>
      <path d={path} fill="none" className={baseEdgeClassName(effect, false)} />
      <CanvasEdgeEffectOverlay path={path} effect={effect} />
    </g>
  );
}

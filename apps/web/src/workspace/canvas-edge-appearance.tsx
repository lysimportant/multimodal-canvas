import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';
import { createContext, useContext, type ReactNode } from 'react';

/** 连接线路径形态；只影响几何，不改变画布边的 ID、顺序、端口和 DAG。 */
export type CanvasEdgePathStyle = 'bezier' | 'gentle' | 'smoothstep' | 'step' | 'straight';
/** 连接线动态特效；`none` 表示保留静态基础路径。 */
export type CanvasEdgeEffect =
  'meteor' | 'shooting-star' | 'marching' | 'cruiser' | 'multi' | 'breathe' | 'none';

/** 连接线外观偏好；由 `edgePathStyle` 与 `edgeEffect` 两个互相独立的字段组成。 */
export type CanvasEdgeAppearance = {
  /** 路径形态。 */
  pathStyle: CanvasEdgePathStyle;
  /** 动态特效。 */
  effect: CanvasEdgeEffect;
};

/** 连接线外观默认值：标准曲线 + 流光，与旧 `flow` 偏好的观感一致。 */
export const canvasEdgeAppearanceDefaults: CanvasEdgeAppearance = {
  pathStyle: 'bezier',
  effect: 'meteor',
};

/**
 * 轻弧曲线使用的贝塞尔曲率。xyflow 默认 0.25，降到 0.1 后控制点明显靠近两端连线，
 * 上下走向的连线才能和标准曲线区分开。
 */
export const FLOW_GENTLE_CURVATURE = 0.1;
/** 圆角折线的转角半径，单位为像素；xyflow 默认 5 在 2.5px 线宽下几乎看不出圆角。 */
export const FLOW_SMOOTH_STEP_RADIUS = 12;

/** 路径求解入参，坐标单位为画布坐标。 */
export type CanvasEdgePathParams = {
  /** 起点 X。 */
  sourceX: number;
  /** 起点 Y。 */
  sourceY: number;
  /** 终点 X。 */
  targetX: number;
  /** 终点 Y。 */
  targetY: number;
  /** 起点锚点所在边。 */
  sourcePosition: Position;
  /** 终点锚点所在边。 */
  targetPosition: Position;
};

/**
 * 按路径形态求解 SVG `d`，落定连线与拖拽预览共用同一套策略。
 *
 * 只调用 React Flow 自己的路径工具，保证几何与 xyflow 内建边一致：
 * `bezier`/`gentle` 用 `getBezierPath`，`smoothstep`/`step` 用同一 `getSmoothStepPath`
 * 的圆角与非圆角配置，`straight` 用 `getStraightPath`。
 *
 * @param pathStyle 路径形态。
 * @param params 两端坐标与锚点方向。
 * @returns 可直接用于 `<path d>` 的路径字符串。
 */
export function resolveEdgePath(
  pathStyle: CanvasEdgePathStyle,
  params: CanvasEdgePathParams,
): string {
  const { sourcePosition, targetPosition } = params;
  if (pathStyle === 'straight') {
    return getStraightPath(params)[0];
  }
  if (pathStyle === 'smoothstep' || pathStyle === 'step') {
    return getSmoothStepPath({
      ...params,
      sourcePosition,
      targetPosition,
      borderRadius: pathStyle === 'smoothstep' ? FLOW_SMOOTH_STEP_RADIUS : 0,
    })[0];
  }
  return getBezierPath({
    ...params,
    sourcePosition,
    targetPosition,
    curvature: pathStyle === 'gentle' ? FLOW_GENTLE_CURVATURE : undefined,
  })[0];
}

/** 需要额外叠加层的特效；`marching` 直接改造基础路径，`none` 完全静止。 */
const overlayEffects = new Set<CanvasEdgeEffect>([
  'meteor',
  'shooting-star',
  'cruiser',
  'multi',
  'breathe',
]);

/**
 * 特效叠加层的类名，`none` 没有叠加层。
 * @param effect 动态特效。
 * @returns 形如 `canvas-edge-effect-meteor` 的类名；无叠加层时返回 null。
 */
export function edgeEffectOverlayClassName(effect: CanvasEdgeEffect): string | null {
  return overlayEffects.has(effect) ? `canvas-edge-effect-${effect}` : null;
}

/**
 * 外观选项的小预览使用的固定几何，单位为 SVG 用户单位。
 *
 * 两端锚点对向（右->左）并保留 14 个单位的纵向落差，这样折线样式会产生可见的
 * 竖直走线段，圆角与直角能直接分辨。xyflow 的贝塞尔曲率只在锚点方向背离目标时
 * 生效，对向锚点下 `bezier` 与 `gentle` 的预览形态相同，差别在画布上才体现。
 */
const PREVIEW_GEOMETRY: CanvasEdgePathParams = {
  sourceX: 4,
  sourceY: 6,
  targetX: 64,
  targetY: 20,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};
/** 外观选项的小预览视框，宽高比与展示尺寸一致，避免缩放变形。 */
export const CANVAS_EDGE_PREVIEW_VIEW_BOX = '0 0 68 26';
/**
 * 外观面板小预览的固定路径；与画布使用同一套路径求解，预览即最终形态。
 * @param pathStyle 路径形态。
 * @returns 位于 `CANVAS_EDGE_PREVIEW_VIEW_BOX` 坐标系内的路径字符串。
 */
export function canvasEdgePreviewPath(pathStyle: CanvasEdgePathStyle): string {
  return resolveEdgePath(pathStyle, PREVIEW_GEOMETRY);
}

const CanvasEdgeAppearanceContext = createContext<CanvasEdgeAppearance>(
  canvasEdgeAppearanceDefaults,
);

/**
 * 向画布内所有边提供当前路径形态与动态特效。
 * @param props.children 画布子树。
 * @param props.appearance 当前连接线外观。
 */
export function CanvasEdgeAppearanceProvider({
  appearance,
  children,
}: {
  appearance: CanvasEdgeAppearance;
  children: ReactNode;
}) {
  return (
    <CanvasEdgeAppearanceContext.Provider value={appearance}>
      {children}
    </CanvasEdgeAppearanceContext.Provider>
  );
}

/**
 * 读取当前连接线外观。没有 Provider 时返回默认值，便于单独渲染与测试边组件。
 * @returns 当前路径形态与动态特效。
 */
export function useCanvasEdgeAppearance(): CanvasEdgeAppearance {
  return useContext(CanvasEdgeAppearanceContext);
}

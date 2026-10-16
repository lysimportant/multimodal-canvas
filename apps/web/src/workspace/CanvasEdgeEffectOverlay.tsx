import { useEffect, useId, useRef } from 'react';

import { edgeEffectOverlayClassName, type CanvasEdgeEffect } from './canvas-edge-appearance';

import './CanvasEdgeEffectOverlay.css';

/** 鎏光尾迹相对光头的长度，单位为画布坐标；短边按实际路径长度等比缩短。 */
const METEOR_TRAIL = 'M -22 0 L 0 0';
/** 尾迹的设计长度，用来把短边的尾迹按路径长度等比收敛，避免光束超出端点。 */
const METEOR_TRAIL_LENGTH = 22;

/**
 * 整条连接线上只有一束鎏光：一个亮头拖一条渐细光尾，沿真实路径从源走向目标。
 * 辉光用加宽的低透明笔触而不是 `filter`，避免每条边都挂一层滤镜。
 *
 * 不支持 `offset-path` 时退化为沿同一条路径行进的一束虚线光（`pathLength=1` 后
 * 周期 1.16 大于整条路径，任意时刻最多只出现一束），因此任何时候都只有一束光。
 *
 * @param props.path 从源节点到目标节点的 SVG 路径。
 * @returns 不参与命中的光束；减少动态效果时停在路径中点。
 */
function MeteorEdgeEffect({ path, emphasized }: { path: string; emphasized: boolean }) {
  const gradientId = useId();
  const overlayRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    /** 仅几何变化时测长，同帧更新合并；缩放与动画进度不触发测量。 */
    const frame = requestAnimationFrame(() => {
      const length = pathRef.current?.getTotalLength?.();
      // 无几何接口时保留完整尾迹；正常路径按 22 单位收敛，很短的边按自身长度缩放。
      if (length === undefined || !Number.isFinite(length)) return;
      const tailScale = Math.min(1, Math.max(0, length) / METEOR_TRAIL_LENGTH);
      overlayRef.current?.style.setProperty('--canvas-edge-meteor-tail-scale', String(tailScale));
    });
    return () => cancelAnimationFrame(frame);
  }, [path]);

  return (
    <g
      ref={overlayRef}
      className={`canvas-edge-effect-meteor${emphasized ? ' is-connected-selected' : ''}`}
      data-testid="edge-effect-overlay"
      aria-hidden="true"
      pointerEvents="none"
    >
      <defs>
        {/*
          尾迹是一条水平线，包围盒高度为 0；用默认的 objectBoundingBox 会让渐变退化，
          所以显式用 userSpaceOnUse，并把渐变端点对齐尾迹两端（-22 → 0）。
        */}
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={-METEOR_TRAIL_LENGTH}
          y1={0}
          x2={0}
          y2={0}
        >
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="100%" stopColor="currentColor" />
        </linearGradient>
      </defs>
      <path ref={pathRef} d={path} pathLength={1} className="canvas-edge-meteor-fallback" />
      <g
        className="canvas-edge-meteor-motion"
        style={{ offsetPath: `path(${JSON.stringify(path)})` }}
      >
        <path d={METEOR_TRAIL} className="canvas-edge-meteor-trail canvas-edge-meteor-trail-glow" />
        <path
          d={METEOR_TRAIL}
          className="canvas-edge-meteor-trail"
          stroke={`url(#${gradientId})`}
        />
        <circle cx="0" cy="0" r="2.8" className="canvas-edge-meteor-head" />
      </g>
    </g>
  );
}

/**
 * 画布、拖线和外观预览共用的特效层；不改变基础边的选择、状态颜色、标记与命中区域。
 * @param props.path 与基础边完全相同、从源到目标的 SVG 路径。
 * @param props.effect 独立于路径形态的特效；`marching` 与 `breathe` 沿用路径改造与脉冲层。
 * @returns 特效叠加层；`marching` 由基础边负责，`none` 不渲染叠加层。
 */
export function CanvasEdgeEffectOverlay({
  path,
  effect,
  emphasized = false,
}: {
  path: string;
  effect: CanvasEdgeEffect;
  /** 连接到选中节点时加宽、加速这一束鎏光。 */
  emphasized?: boolean;
}) {
  if (effect === 'meteor') {
    return <MeteorEdgeEffect path={path} emphasized={emphasized} />;
  }
  const className = edgeEffectOverlayClassName(effect);
  if (!className) return null;
  return (
    <path
      d={path}
      aria-hidden="true"
      data-testid="edge-effect-overlay"
      className={`${className}${emphasized ? ' is-connected-selected' : ''}`}
    />
  );
}

import { useEffect, useId, useRef } from 'react';

import { edgeEffectOverlayClassName, type CanvasEdgeEffect } from './canvas-edge-appearance';

import './CanvasEdgeEffectOverlay.css';

/**
 * 一条连续渐细光尾和一个亮头共用 CSS 运动路径，不堆叠粒子或逐帧更新 React。
 * 亮头沿真实路径从源到目标移动，短尾沿当前位置的反向切线伸展；折角处随切线转向。
 * @param props.path 从源节点到目标节点的 SVG 路径。
 * @returns 不参与命中的光束；减少动态效果时停在中点，不支持运动路径时显示静态亮点。
 */
function ShootingStarEdgeEffect({ path }: { path: string }) {
  const gradientId = useId();
  const overlayRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    /** 仅几何变化时测长，同帧更新合并；缩放与动画进度不触发测量。 */
    const frame = requestAnimationFrame(() => {
      const length = pathRef.current?.getTotalLength?.();
      // 无几何接口时保留 16 单位短尾；正常路径最长 32 单位且不超过路径的 22%。
      if (length === undefined || !Number.isFinite(length)) return;
      const tailScale = Math.min(1, (Math.max(0, length) * 0.22) / 32);
      overlayRef.current?.style.setProperty('--canvas-edge-star-tail-scale', String(tailScale));
    });
    return () => cancelAnimationFrame(frame);
  }, [path]);

  return (
    <g
      ref={overlayRef}
      className="canvas-edge-effect-shooting-star"
      data-testid="edge-effect-overlay"
      aria-hidden="true"
      pointerEvents="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="100%" stopColor="currentColor" />
        </linearGradient>
      </defs>
      <path ref={pathRef} d={path} pathLength={1} className="canvas-edge-shooting-star-fallback" />
      <g
        className="canvas-edge-shooting-star-motion"
        style={{ offsetPath: `path(${JSON.stringify(path)})` }}
      >
        <path
          d="M -32 0 Q -12 -0.6 0 -3 L 0 3 Q -12 0.6 -32 0 Z"
          className="canvas-edge-shooting-star-trail"
          fill={`url(#${gradientId})`}
        />
        <circle cx="0" cy="0" r="3" className="canvas-edge-shooting-star-head" />
      </g>
    </g>
  );
}

/**
 * 画布、拖线和外观预览共用的特效层；不改变基础边的选择、状态颜色、标记与命中区域。
 * @param props.path 与基础边完全相同、从源到目标的 SVG 路径。
 * @param props.effect 独立于路径形态的特效；旧流光等保留原来的路径与类名。
 * @returns 特效叠加层；`marching` 由基础边负责，`none` 不渲染叠加层。
 */
export function CanvasEdgeEffectOverlay({
  path,
  effect,
}: {
  path: string;
  effect: CanvasEdgeEffect;
}) {
  if (effect === 'shooting-star') return <ShootingStarEdgeEffect path={path} />;
  const className = edgeEffectOverlayClassName(effect);
  if (!className) return null;
  return (
    <path d={path} aria-hidden="true" data-testid="edge-effect-overlay" className={className} />
  );
}

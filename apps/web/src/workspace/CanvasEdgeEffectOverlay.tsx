import { useLayoutEffect, useRef } from 'react';

import { edgeEffectOverlayClassName, type CanvasEdgeEffect } from './canvas-edge-appearance';

import './CanvasEdgeEffectOverlay.css';

/**
 * 单个亮点与渐淡短尾迹共用基础边的真实路径。将路径归一到 1、虚线周期设为 2，
 * 保证长边也只有一个亮点；尾迹沿曲线/折线回溯，不用会在转角处偏离路径的切线拖尾。
 * @param props.path 从源节点到目标节点的 SVG 路径。
 * @returns 不参与命中测试的叠加层；减少动态效果时由 CSS 停在路径中点。
 */
function ShootingStarEdgeEffect({ path }: { path: string }) {
  const overlayRef = useRef<SVGGElement>(null);
  const headRef = useRef<SVGPathElement>(null);

  useLayoutEffect(() => {
    const length = headRef.current?.getTotalLength?.();
    // 无 SVG 几何接口时保留 CSS 的相对长度；浏览器中把尾迹限制在 22 个画布单位内。
    if (length === undefined) return;
    const tailLength = length > 0 ? Math.min(0.22, 22 / length) : 0;
    overlayRef.current?.style.setProperty('--canvas-edge-star-tail', `${tailLength}px`);
  }, [path]);

  return (
    <g
      ref={overlayRef}
      className="canvas-edge-effect-shooting-star"
      data-testid="edge-effect-overlay"
      aria-hidden="true"
      pointerEvents="none"
    >
      <path d={path} pathLength={1} className="canvas-edge-shooting-star-trail" />
      <path
        d={path}
        pathLength={1}
        className="canvas-edge-shooting-star-trail canvas-edge-shooting-star-trail-middle"
      />
      <path
        d={path}
        pathLength={1}
        className="canvas-edge-shooting-star-trail canvas-edge-shooting-star-trail-near"
      />
      <path ref={headRef} d={path} pathLength={1} className="canvas-edge-shooting-star-head" />
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

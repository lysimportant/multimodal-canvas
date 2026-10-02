import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CanvasEdgeEffectOverlay } from './CanvasEdgeEffectOverlay';
import { canvasEdgeAppearanceDefaults, edgeEffectOverlayClassName } from './canvas-edge-appearance';

/** jsdom 没有 SVG 长度求解接口；每项测试结束时恢复原有原型，避免污染其他组件。 */
const originalLengthDescriptor = Object.getOwnPropertyDescriptor(
  SVGElement.prototype,
  'getTotalLength',
);

/** 当前绘制帧的待执行测量；以确定性调度替代墙钟耗时断言。 */
const pendingFrames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  pendingFrames.clear();
  let nextFrameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pendingFrames.delete(id));
});

/** 执行一次绘制帧；回调中新提交的测量保留到下一帧。 */
function flushFrame() {
  act(() => {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    callbacks.forEach((callback) => callback(16));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalLengthDescriptor) {
    Object.defineProperty(SVGElement.prototype, 'getTotalLength', originalLengthDescriptor);
  } else {
    Reflect.deleteProperty(SVGElement.prototype, 'getTotalLength');
  }
});

/**
 * 只替换无布局环境的 SVG 长度测量，路径、叠加层与生命周期仍使用真实组件。
 * @param length 模拟路径长度，单位为画布坐标；0 用于重合端点。
 * @returns 可修改测量结果与检查调用次数的 mock。
 */
function mockPathLength(length: number) {
  const measure = vi.fn(() => length);
  Object.defineProperty(SVGElement.prototype, 'getTotalLength', {
    configurable: true,
    value: measure,
  });
  return measure;
}

describe('CanvasEdgeEffectOverlay', () => {
  it('流星光束不改变默认流光与旧效果类名', () => {
    expect(canvasEdgeAppearanceDefaults.effect).toBe('meteor');
    expect(edgeEffectOverlayClassName('meteor')).toBe('canvas-edge-effect-meteor');
    expect(edgeEffectOverlayClassName('shooting-star')).toBe('canvas-edge-effect-shooting-star');
    expect(edgeEffectOverlayClassName('none')).toBeNull();
    expect(edgeEffectOverlayClassName('marching')).toBeNull();
  });

  it.each([
    [0, 0],
    [-10, 0],
    [40, 0.275],
    [100, 0.6875],
    [1000, 1],
    [10000, 1],
  ])('路径长 %s 时尾迹缩放为 %s，最长保持 32 个画布单位', (length, ratio) => {
    const measure = mockPathLength(length);
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path={`M 0,0 L ${length},0`} effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    const overlay = container.querySelector<SVGGElement>('.canvas-edge-effect-shooting-star');
    expect(measure).toHaveBeenCalledTimes(1);
    expect(
      parseFloat(overlay?.style.getPropertyValue('--canvas-edge-star-tail-scale') ?? ''),
    ).toBeCloseTo(ratio);
    expect(container.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    expect(container.querySelectorAll('.canvas-edge-shooting-star-trail')).toHaveLength(1);
    container.querySelectorAll('.canvas-edge-shooting-star-fallback').forEach((path) => {
      expect(path).toHaveAttribute('pathLength', '1');
      expect(path).toHaveAttribute('d', `M 0,0 L ${length},0`);
    });
  });

  it('节点移动改变路径后重新限制尾迹长度，不卸载动画元素', () => {
    const measure = mockPathLength(1000);
    const { container, rerender } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    const head = container.querySelector('.canvas-edge-shooting-star-head');
    const overlay = container.querySelector<SVGGElement>('.canvas-edge-effect-shooting-star');
    expect(overlay?.style.getPropertyValue('--canvas-edge-star-tail-scale')).toBe('1');

    measure.mockReturnValue(100);
    rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 100,0 L 0,0" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.canvas-edge-shooting-star-head')).toBe(head);
    expect(
      container.querySelector<SVGGElement>('.canvas-edge-shooting-star-motion')?.style.offsetPath,
    ).toBe('path("M 100,0 L 0,0")');
    expect(overlay?.style.getPropertyValue('--canvas-edge-star-tail-scale')).toBe('0.6875');
  });

  it('没有 SVG 布局接口时仍可渲染光束并使用 CSS 默认短尾', () => {
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 60,20" effect="shooting-star" />
      </svg>,
    );
    expect(container.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    expect(container.querySelector('.canvas-edge-effect-shooting-star')).toHaveAttribute(
      'pointer-events',
      'none',
    );
  });

  it('每条边只有一条渐细光尾与一个亮头，渐变标识互不串色', () => {
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 100,0" effect="shooting-star" />
        <CanvasEdgeEffectOverlay path="M 100,0 L 0,0" effect="shooting-star" />
      </svg>,
    );
    const gradients = [...container.querySelectorAll('linearGradient')];
    expect(new Set(gradients.map((gradient) => gradient.id)).size).toBe(2);
    container.querySelectorAll('.canvas-edge-effect-shooting-star').forEach((overlay) => {
      const gradient = overlay.querySelector('linearGradient');
      const trail = overlay.querySelector('.canvas-edge-shooting-star-trail');
      expect(trail).toHaveAttribute('fill', 'url(#' + gradient?.id + ')');
      expect(gradient?.querySelector('stop')).toHaveAttribute('stop-opacity', '0');
      expect(overlay.querySelectorAll('.canvas-edge-shooting-star-trail')).toHaveLength(1);
      expect(overlay.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
      expect(overlay.querySelectorAll('animate, animateMotion, filter')).toHaveLength(0);
    });
  });

  it.each([NaN, Infinity])('无效测长 %s 不写入无效样式，保留默认短尾', (length) => {
    mockPathLength(length);
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 60,20" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    expect(
      container
        .querySelector<SVGGElement>('.canvas-edge-effect-shooting-star')
        ?.style.getPropertyValue('--canvas-edge-star-tail-scale'),
    ).toBe('');
  });

  it('光束沿源到目标运动，支持主题、减少动态效果、拖动与视口暂停和静态降级', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/workspace/CanvasEdgeEffectOverlay.css'),
      'utf8',
    ).replace(/\s+/g, ' ');

    expect(css).toContain('color: var(--canvas-edge-flow-color, var(--mc-accent-strong));');
    expect(css).toMatch(/\.canvas-edge-effect-shooting-star \{[^}]*pointer-events: none;/);
    expect(css).toContain('offset-anchor: 0px 0px;');
    expect(css).toContain('offset-rotate: auto;');
    expect(css).toContain(
      "@supports (offset-path: path('M 0 0 L 1 0')) and (offset-anchor: 0px 0px)",
    );
    expect(css).toMatch(/\.canvas-edge-shooting-star-fallback \{[^}]*stroke-dashoffset: -0.5;/);
    expect(css).toMatch(/0% \{[^}]*offset-distance: 0%;/);
    expect(css).toMatch(/100% \{[^}]*offset-distance: 100%;/);
    expect(css).toMatch(
      /\.canvas-area\.is-viewport-moving \.canvas-edge-effect-shooting-star \{[^}]*visibility: hidden;/,
    );
    expect(css).toMatch(
      /\.canvas-area\.is-viewport-moving \.canvas-edge-shooting-star-motion \{[^}]*animation-play-state: paused;/,
    );
    expect(css).toContain('.canvas-area.is-node-dragging .canvas-edge-effect-shooting-star,');
    expect(css).toContain('.canvas-area.is-node-dragging .canvas-edge-shooting-star-motion,');
    expect(css).toContain('filter: none;');
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('animation: none;');
    expect(reducedMotion).toContain('offset-distance: 50%;');
    expect(css).not.toMatch(/drop-shadow|blur\(|will-change:|#[0-9a-f]{3,8}|!important/);
  });
});

describe('CanvasEdgeEffectOverlay 拖动性能', () => {
  it('仅缩放视口不重复测长、不重建动画，也不调度下一帧', () => {
    const measure = mockPathLength(200);
    const renderAtZoom = (zoom: number) => (
      <svg>
        <g transform={'scale(' + zoom + ')'}>
          <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="shooting-star" />
        </g>
      </svg>
    );
    const view = render(renderAtZoom(1));
    flushFrame();
    const motion = view.container.querySelector('.canvas-edge-shooting-star-motion');
    for (const zoom of [0.25, 0.5, 1.5, 2]) view.rerender(renderAtZoom(zoom));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);
    expect(view.container.querySelector('.canvas-edge-shooting-star-motion')).toBe(motion);
  });
  it('同一绘制帧内连续 12 次更新只测量最终路径', () => {
    const measure = mockPathLength(1000);
    const view = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    measure.mockClear();
    for (let step = 1; step <= 12; step++) {
      measure.mockReturnValue(1000 + step * 10);
      view.rerender(
        <svg>
          <CanvasEdgeEffectOverlay
            path={'M 0,0 L ' + (1000 + step * 10) + ',0'}
            effect="shooting-star"
          />
        </svg>,
      );
    }
    expect(measure).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(1);
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.canvas-edge-effect-shooting-star')).toHaveStyle({
      '--canvas-edge-star-tail-scale': '1',
    });
    view.unmount();
    expect(pendingFrames.size).toBe(0);
  });

  it('切换特效或卸载时取消待执行测量，跨帧仍会测量最新路径', () => {
    const measure = mockPathLength(200);
    const view = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="shooting-star" />
      </svg>,
    );
    expect(pendingFrames.size).toBe(1);
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="none" />
      </svg>,
    );
    expect(pendingFrames.size).toBe(0);
    flushFrame();
    expect(measure).not.toHaveBeenCalled();
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    measure.mockReturnValue(1000);
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="shooting-star" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('.canvas-edge-effect-shooting-star')).toHaveStyle({
      '--canvas-edge-star-tail-scale': '1',
    });
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 500,0" effect="shooting-star" />
      </svg>,
    );
    expect(pendingFrames.size).toBe(1);
    view.unmount();
    expect(pendingFrames.size).toBe(0);
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

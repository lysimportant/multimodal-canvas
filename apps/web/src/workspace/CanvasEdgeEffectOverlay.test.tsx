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

/** 组件自动生成的光束尾迹：一个亮头、一条光尾与一条更宽的辉光尾迹。 */
function overlayParts(container: HTMLElement) {
  return {
    overlay: container.querySelector<SVGGElement>('.canvas-edge-effect-meteor'),
    head: container.querySelectorAll('.canvas-edge-meteor-head'),
    trail: container.querySelectorAll('.canvas-edge-meteor-trail'),
    glow: container.querySelectorAll('.canvas-edge-meteor-trail-glow'),
  };
}

describe('CanvasEdgeEffectOverlay', () => {
  it('流星鎏光是默认特效，并保留无叠加层特效的空类名约定', () => {
    expect(canvasEdgeAppearanceDefaults.effect).toBe('meteor');
    expect(edgeEffectOverlayClassName('meteor')).toBe('canvas-edge-effect-meteor');
    expect(edgeEffectOverlayClassName('breathe')).toBe('canvas-edge-effect-breathe');
    expect(edgeEffectOverlayClassName('none')).toBeNull();
    expect(edgeEffectOverlayClassName('marching')).toBeNull();
  });

  it.each([
    [0, 0],
    [-10, 0],
    [11, 0.5],
    [22, 1],
    [100, 1],
    [1000, 1],
  ])('路径长 %s 时尾迹缩放为 %s，最长保持 22 个画布单位', (length, ratio) => {
    const measure = mockPathLength(length);
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path={`M 0,0 L ${length},0`} effect="meteor" />
      </svg>,
    );
    flushFrame();
    const { overlay, head, trail, glow } = overlayParts(container);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(
      parseFloat(overlay?.style.getPropertyValue('--canvas-edge-meteor-tail-scale') ?? ''),
    ).toBeCloseTo(ratio);
    // 整条线只有这一束鎏光：一个亮头、一条光尾、一层辉光。
    expect(head).toHaveLength(1);
    expect(trail).toHaveLength(2);
    expect(glow).toHaveLength(1);
    container.querySelectorAll('.canvas-edge-meteor-fallback').forEach((path) => {
      expect(path).toHaveAttribute('pathLength', '1');
      expect(path).toHaveAttribute('d', `M 0,0 L ${length},0`);
    });
  });

  it('节点移动改变路径后重新限制尾迹长度，不卸载动画元素', () => {
    const measure = mockPathLength(1000);
    const { container, rerender } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="meteor" />
      </svg>,
    );
    flushFrame();
    const head = container.querySelector('.canvas-edge-meteor-head');
    const overlay = container.querySelector<SVGGElement>('.canvas-edge-effect-meteor');
    expect(overlay?.style.getPropertyValue('--canvas-edge-meteor-tail-scale')).toBe('1');

    measure.mockReturnValue(11);
    rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 100,0 L 0,0" effect="meteor" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.canvas-edge-meteor-head')).toBe(head);
    expect(
      container.querySelector<SVGGElement>('.canvas-edge-meteor-motion')?.style.offsetPath,
    ).toBe('path("M 100,0 L 0,0")');
    expect(overlay?.style.getPropertyValue('--canvas-edge-meteor-tail-scale')).toBe('0.5');
  });

  it('没有 SVG 布局接口时仍可渲染单束光束并使用 CSS 默认尾迹', () => {
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 60,20" effect="meteor" />
      </svg>,
    );
    const { overlay, head, trail } = overlayParts(container);
    expect(head).toHaveLength(1);
    expect(trail).toHaveLength(2);
    expect(overlay).toHaveAttribute('pointer-events', 'none');
  });

  it('每条边只有一个渐细光尾与一个亮头，渐变标识互不串色', () => {
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 100,0" effect="meteor" />
        <CanvasEdgeEffectOverlay path="M 100,0 L 0,0" effect="meteor" />
      </svg>,
    );
    const gradients = [...container.querySelectorAll('linearGradient')];
    expect(new Set(gradients.map((gradient) => gradient.id)).size).toBe(2);
    container.querySelectorAll('.canvas-edge-effect-meteor').forEach((overlay) => {
      const gradient = overlay.querySelector('linearGradient');
      const trail = overlay.querySelector(
        '.canvas-edge-meteor-trail:not(.canvas-edge-meteor-trail-glow)',
      );
      expect(trail).toHaveAttribute('stroke', 'url(#' + gradient?.id + ')');
      // 水平尾迹的包围盒高度为 0，渐变必须用 userSpaceOnUse 才不会退化。
      expect(gradient).toHaveAttribute('gradientUnits', 'userSpaceOnUse');
      expect(gradient).toHaveAttribute('x1', '-22');
      expect(gradient).toHaveAttribute('x2', '0');
      expect(gradient?.querySelector('stop')).toHaveAttribute('stop-opacity', '0');
      expect(overlay.querySelectorAll('.canvas-edge-meteor-head')).toHaveLength(1);
      expect(overlay.querySelectorAll('.canvas-edge-meteor-trail')).toHaveLength(2);
      // 不使用 SMIL 或逐边滤镜，光束由 CSS 运动路径驱动。
      expect(overlay.querySelectorAll('animate, animateMotion, filter')).toHaveLength(0);
    });
  });

  it('呼吸脉冲不渲染运动路径层，只保留沿基础路径的叠加层', () => {
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 60,20" effect="breathe" emphasized />
      </svg>,
    );
    expect(container.querySelectorAll('.canvas-edge-effect-breathe')).toHaveLength(1);
    expect(container.querySelector('.canvas-edge-effect-breathe')).toHaveClass(
      'is-connected-selected',
    );
    expect(container.querySelectorAll('.canvas-edge-meteor-head')).toHaveLength(0);
  });

  it.each([NaN, Infinity])('无效测长 %s 不写入无效样式，保留默认尾迹', (length) => {
    mockPathLength(length);
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 60,20" effect="meteor" />
      </svg>,
    );
    flushFrame();
    expect(
      container
        .querySelector<SVGGElement>('.canvas-edge-effect-meteor')
        ?.style.getPropertyValue('--canvas-edge-meteor-tail-scale'),
    ).toBe('');
  });

  it('光束跟随主题、沿源到目标运动，整条线只有一束鎏光', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/workspace/CanvasEdgeEffectOverlay.css'),
      'utf8',
    ).replace(/\s+/g, ' ');

    // 颜色全部来自主题变量，不混底色或白色。
    expect(css).toContain('color: var(--canvas-edge-beam, var(--mc-accent));');
    expect(css).toContain('stroke: currentColor;');
    expect(css).toMatch(/\.canvas-edge-meteor-trail-glow \{[^}]*stroke-opacity: 0.22;/);
    expect(css).toContain('offset-anchor: 0px 0px;');
    expect(css).toContain('offset-rotate: auto;');
    expect(css).toContain(
      "@supports (offset-path: path('M 0 0 L 1 0')) and (offset-anchor: 0px 0px)",
    );
    // 降级光斑同样只有一束：dasharray 的周期 1.16 大于归一化后的整条路径（1）。
    expect(css).toMatch(/\.canvas-edge-meteor-fallback \{[^}]*stroke-dasharray: 0.16 1;/);
    expect(css).toMatch(/@keyframes canvas-edge-meteor-dash \{[^}]*stroke-dashoffset: 0.16;/);
    // 起点在源点外侧、终点在目标点外侧，一个周期正好覆盖可见区间，不会出现空窗。
    expect(css).toMatch(/to \{[^}]*stroke-dashoffset: -1;/);
    expect(css).toMatch(/@keyframes canvas-edge-meteor-beam \{[^}]*offset-distance: 0%;/);
    expect(css).toMatch(/100% \{[^}]*offset-distance: 100%;/);
    expect(css).toMatch(
      /\.canvas-area\.is-viewport-moving \.canvas-edge-effect-meteor \{ filter: none; visibility: hidden;/,
    );
    expect(css).toMatch(
      /\.canvas-area\.is-viewport-moving \.canvas-edge-meteor-motion, \.canvas-area\.is-viewport-moving \.canvas-edge-meteor-fallback \{ animation-play-state: paused;/,
    );
    expect(css).toContain('.canvas-area.is-node-dragging .canvas-edge-effect-meteor,');
    expect(css).toContain('.canvas-area.is-node-dragging .canvas-edge-meteor-motion,');
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('animation: none;');
    expect(reducedMotion).toContain('offset-distance: 50%;');
    // 悬停态只用主题色派生变量，不引入滤镜、十六进制颜色或 important。
    expect(css).not.toMatch(/drop-shadow|blur\(|will-change:|#[0-9a-f]{3,8}|!important/);
  });
});

describe('CanvasEdgeEffectOverlay 拖动性能', () => {
  it('仅缩放视口不重复测长、不重建动画，也不调度下一帧', () => {
    const measure = mockPathLength(200);
    const renderAtZoom = (zoom: number) => (
      <svg>
        <g transform={'scale(' + zoom + ')'}>
          <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="meteor" />
        </g>
      </svg>
    );
    const view = render(renderAtZoom(1));
    flushFrame();
    const motion = view.container.querySelector('.canvas-edge-meteor-motion');
    for (const zoom of [0.25, 0.5, 1.5, 2]) view.rerender(renderAtZoom(zoom));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);
    expect(view.container.querySelector('.canvas-edge-meteor-motion')).toBe(motion);
  });
  it('同一绘制帧内连续 12 次更新只测量最终路径', () => {
    const measure = mockPathLength(1000);
    const view = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="meteor" />
      </svg>,
    );
    flushFrame();
    measure.mockClear();
    for (let step = 1; step <= 12; step++) {
      measure.mockReturnValue(1000 + step * 10);
      view.rerender(
        <svg>
          <CanvasEdgeEffectOverlay path={'M 0,0 L ' + (1000 + step * 10) + ',0'} effect="meteor" />
        </svg>,
      );
    }
    expect(measure).not.toHaveBeenCalled();
    expect(pendingFrames.size).toBe(1);
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('.canvas-edge-effect-meteor')).toHaveStyle({
      '--canvas-edge-meteor-tail-scale': '1',
    });
    view.unmount();
    expect(pendingFrames.size).toBe(0);
  });

  it('切换特效或卸载时取消待执行测量，跨帧仍会测量最新路径', () => {
    const measure = mockPathLength(200);
    const view = render(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="meteor" />
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
        <CanvasEdgeEffectOverlay path="M 0,0 L 200,0" effect="meteor" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(1);
    measure.mockReturnValue(1000);
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 1000,0" effect="meteor" />
      </svg>,
    );
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('.canvas-edge-effect-meteor')).toHaveStyle({
      '--canvas-edge-meteor-tail-scale': '1',
    });
    view.rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 0,0 L 500,0" effect="meteor" />
      </svg>,
    );
    expect(pendingFrames.size).toBe(1);
    view.unmount();
    expect(pendingFrames.size).toBe(0);
    flushFrame();
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

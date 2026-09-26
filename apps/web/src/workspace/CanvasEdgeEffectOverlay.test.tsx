import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasEdgeEffectOverlay } from './CanvasEdgeEffectOverlay';
import { canvasEdgeAppearanceDefaults, edgeEffectOverlayClassName } from './canvas-edge-appearance';

/** jsdom 没有 SVG 长度求解接口；每项测试结束时恢复原有原型，避免污染其他组件。 */
const originalLengthDescriptor = Object.getOwnPropertyDescriptor(
  SVGElement.prototype,
  'getTotalLength',
);

afterEach(() => {
  cleanup();
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
  it('新增单点流星不改变默认流光与旧效果类名', () => {
    expect(canvasEdgeAppearanceDefaults.effect).toBe('meteor');
    expect(edgeEffectOverlayClassName('meteor')).toBe('canvas-edge-effect-meteor');
    expect(edgeEffectOverlayClassName('shooting-star')).toBe('canvas-edge-effect-shooting-star');
    expect(edgeEffectOverlayClassName('none')).toBeNull();
    expect(edgeEffectOverlayClassName('marching')).toBeNull();
  });

  it.each([
    [0, 0],
    [40, 0.22],
    [100, 0.22],
    [1000, 0.022],
    [10000, 0.0022],
  ])('路径长 %s 时尾迹比例为 %s，最长保持 22 个画布单位', (length, ratio) => {
    const measure = mockPathLength(length);
    const { container } = render(
      <svg>
        <CanvasEdgeEffectOverlay path={`M 0,0 L ${length},0`} effect="shooting-star" />
      </svg>,
    );
    const overlay = container.querySelector<SVGGElement>('.canvas-edge-effect-shooting-star');
    expect(measure).toHaveBeenCalledTimes(1);
    expect(
      parseFloat(overlay?.style.getPropertyValue('--canvas-edge-star-tail') ?? ''),
    ).toBeCloseTo(ratio);
    expect(container.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    expect(container.querySelectorAll('.canvas-edge-shooting-star-trail')).toHaveLength(3);
    container.querySelectorAll('path').forEach((path) => {
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
    const head = container.querySelector('.canvas-edge-shooting-star-head');
    const overlay = container.querySelector<SVGGElement>('.canvas-edge-effect-shooting-star');
    expect(overlay?.style.getPropertyValue('--canvas-edge-star-tail')).toBe('0.022px');

    measure.mockReturnValue(200);
    rerender(
      <svg>
        <CanvasEdgeEffectOverlay path="M 200,0 L 0,0" effect="shooting-star" />
      </svg>,
    );
    expect(measure).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.canvas-edge-shooting-star-head')).toBe(head);
    expect(head).toHaveAttribute('d', 'M 200,0 L 0,0');
    expect(overlay?.style.getPropertyValue('--canvas-edge-star-tail')).toBe('0.11px');
  });

  it('没有 SVG 布局接口时仍可渲染单点与相对长度尾迹', () => {
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

  it('归一化周期只容纳一个亮点，沿源到目标运动，减少动态效果时停在中点', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/workspace/CanvasEdgeEffectOverlay.css'),
      'utf8',
    ).replace(/\s+/g, ' ');

    expect(css).toContain('stroke-dasharray: var(--canvas-edge-star-span) 2;');
    expect(css).toContain('--canvas-edge-star-span: 0px;');
    expect(css).toContain('stroke-dashoffset: calc(var(--canvas-edge-star-span) - 1px);');
    expect(css).toMatch(/\.canvas-edge-effect-shooting-star > path \{[^}]*pointer-events: none;/);
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotion).toContain('animation: none;');
    expect(reducedMotion).toContain(
      'stroke-dashoffset: calc(var(--canvas-edge-star-span) - 0.5px);',
    );
    expect(css).not.toContain('!important');
  });
});

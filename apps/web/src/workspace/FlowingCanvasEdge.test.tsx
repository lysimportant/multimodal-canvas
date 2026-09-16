import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from '@xyflow/react';

import {
  CanvasEdgeAppearanceProvider,
  FLOW_GENTLE_CURVATURE,
  FLOW_SMOOTH_STEP_RADIUS,
  canvasEdgeAppearanceDefaults,
  canvasEdgePreviewPath,
  edgeEffectOverlayClassName,
  resolveEdgePath,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';
import {
  FLOW_HANDLE_SIZE,
  FlowingCanvasEdge,
  FlowingConnectionLine,
  centerHandlePoint,
} from './FlowingCanvasEdge';

/** 五种路径形态，顺序与外观面板一致。 */
const pathStyles: CanvasEdgePathStyle[] = ['bezier', 'gentle', 'smoothstep', 'step', 'straight'];
/** 六种动态特效，`none` 不渲染叠加层。 */
const effects: CanvasEdgeEffect[] = ['meteor', 'marching', 'cruiser', 'multi', 'breathe', 'none'];

/** 同一条边的两端锚点参数，路径求解测试共用。 */
const edgeParams = {
  sourceX: 260,
  sourceY: 40,
  targetX: 20,
  targetY: 200,
  sourcePosition: Position.Left,
  targetPosition: Position.Bottom,
};

/** 按 xyflow 内建实现计算落定边的期望路径，先圆心内收再求解。 */
function settledPath(pathStyle: CanvasEdgePathStyle) {
  const source = centerHandlePoint(
    edgeParams.sourceX,
    edgeParams.sourceY,
    edgeParams.sourcePosition,
  );
  const target = centerHandlePoint(
    edgeParams.targetX,
    edgeParams.targetY,
    edgeParams.targetPosition,
  );
  return resolveEdgePath(pathStyle, {
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
    sourcePosition: edgeParams.sourcePosition,
    targetPosition: edgeParams.targetPosition,
  });
}

/** 记录基础边上的指针事件，用于确认叠加层没有抢走命中测试。 */
const onEdgePointerDown = vi.fn();

/** 在真实 Provider 下渲染一条落定边，验证组件确实消费上下文。 */
function renderEdge(pathStyle: CanvasEdgePathStyle, effect: CanvasEdgeEffect, selected = false) {
  const view = render(
    <CanvasEdgeAppearanceProvider appearance={{ pathStyle, effect }}>
      <svg onPointerDown={onEdgePointerDown}>
        <FlowingCanvasEdge
          id="edge-1"
          source="a"
          target="b"
          sourceX={edgeParams.sourceX}
          sourceY={edgeParams.sourceY}
          targetX={edgeParams.targetX}
          targetY={edgeParams.targetY}
          sourcePosition={edgeParams.sourcePosition}
          targetPosition={edgeParams.targetPosition}
          selected={selected}
        />
      </svg>
    </CanvasEdgeAppearanceProvider>,
  );
  return {
    unmount: view.unmount,
    base: view.container.querySelector('.react-flow__edge-path'),
    overlay: view.container.querySelector('[data-testid="edge-effect-overlay"]'),
  };
}

afterEach(() => {
  cleanup();
  onEdgePointerDown.mockClear();
});

describe('FlowingCanvasEdge', () => {
  it('圆心内收与四类节点共用的 18px 锚点直径一致', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(FLOW_HANDLE_SIZE).toBe(18);
    expect(css.replace(/\s+/g, ' ')).toMatch(
      /\.flow-asset-node \.react-flow__handle \{[^}]*height: 18px;[^}]*width: 18px;/,
    );
  });

  it.each([
    [Position.Right, 0, 10, -9, 10],
    [Position.Left, 100, 10, 109, 10],
    [Position.Top, 50, 0, 50, 9],
    [Position.Bottom, 50, 100, 50, 91],
  ] as const)('把 %s 锚点外沿收到圆心', (position, x, y, expectedX, expectedY) => {
    expect(centerHandlePoint(x, y, position)).toEqual({ x: expectedX, y: expectedY });
  });

  it('五种路径形态在同一组端点下几何各不相同', () => {
    const resolved = pathStyles.map((pathStyle) => resolveEdgePath(pathStyle, edgeParams));

    expect(new Set(resolved).size).toBe(pathStyles.length);
    expect(resolveEdgePath('bezier', edgeParams)).toBe(getBezierPath(edgeParams)[0]);
    expect(resolveEdgePath('gentle', edgeParams)).toBe(
      getBezierPath({ ...edgeParams, curvature: FLOW_GENTLE_CURVATURE })[0],
    );
    expect(resolveEdgePath('smoothstep', edgeParams)).toBe(
      getSmoothStepPath({ ...edgeParams, borderRadius: FLOW_SMOOTH_STEP_RADIUS })[0],
    );
    expect(resolveEdgePath('step', edgeParams)).toBe(
      getSmoothStepPath({ ...edgeParams, borderRadius: 0 })[0],
    );
    expect(resolveEdgePath('straight', edgeParams)).toBe(getStraightPath(edgeParams)[0]);
  });

  it('外观面板的小预览使用真实几何，圆角与直角折线可区分', () => {
    const previews = pathStyles.map((pathStyle) => canvasEdgePreviewPath(pathStyle));

    // 预览几何的锚点方向对向，xyflow 的曲率参数不参与，贝塞尔与轻弧预览同形。
    expect(new Set(previews).size).toBe(pathStyles.length - 1);
    expect(canvasEdgePreviewPath('bezier')).toBe(canvasEdgePreviewPath('gentle'));
    // 圆角折线自带圆弧半径，直角折线的过渡是零长度的退化曲线。
    expect(canvasEdgePreviewPath('smoothstep')).toMatch(/Q [\d.]+,6 /);
    expect(canvasEdgePreviewPath('step')).toMatch(/Q 34,6 34,6/);
    expect(canvasEdgePreviewPath('smoothstep')).not.toBe(canvasEdgePreviewPath('step'));
    expect(canvasEdgePreviewPath('straight')).toMatch(/^M [\d.]+,[\d.]+L [\d.]+,[\d.]+$/);
  });

  it('轻弧曲线在锚点方向背离目标时与标准曲线几何不同', () => {
    const asymmetric = {
      sourceX: 260,
      sourceY: 40,
      targetX: 20,
      targetY: 200,
      sourcePosition: Position.Left,
      targetPosition: Position.Bottom,
    };

    expect(resolveEdgePath('gentle', asymmetric)).not.toBe(resolveEdgePath('bezier', asymmetric));
    expect(resolveEdgePath('gentle', asymmetric)).toBe(
      getBezierPath({ ...asymmetric, curvature: FLOW_GENTLE_CURVATURE })[0],
    );
  });

  it.each(pathStyles)('%s 路径形态对准锚点圆心', (pathStyle) => {
    const { base } = renderEdge(pathStyle, 'meteor');

    expect(base).toHaveAttribute('d', settledPath(pathStyle));
  });

  it.each([
    [Position.Right, Position.Left, 0, 10, 100, 10],
    [Position.Bottom, Position.Top, 40, 80, 40, 0],
    [Position.Left, Position.Right, 20, 30, 200, 30],
    [Position.Top, Position.Bottom, 60, 0, 60, 120],
  ] as const)(
    '四类节点 %s->%s 连线都对准锚点圆心',
    (sourcePosition, targetPosition, sourceX, sourceY, targetX, targetY) => {
      const { container } = render(
        <svg>
          <FlowingCanvasEdge
            id="edge-1"
            source="a"
            target="b"
            sourceX={sourceX}
            sourceY={sourceY}
            targetX={targetX}
            targetY={targetY}
            sourcePosition={sourcePosition}
            targetPosition={targetPosition}
          />
        </svg>,
      );
      const source = centerHandlePoint(sourceX, sourceY, sourcePosition);
      const target = centerHandlePoint(targetX, targetY, targetPosition);

      expect(container.querySelector('.react-flow__edge-path')).toHaveAttribute(
        'd',
        resolveEdgePath(canvasEdgeAppearanceDefaults.pathStyle, {
          sourceX: source.x,
          sourceY: source.y,
          targetX: target.x,
          targetY: target.y,
          sourcePosition,
          targetPosition,
        }),
      );
    },
  );
});

describe('连接线路径与特效的独立性', () => {
  const combinations = pathStyles.flatMap((pathStyle) =>
    effects.map((effect) => [pathStyle, effect] as const),
  );

  it('覆盖 5 x 6 共 30 种组合', () => {
    expect(combinations).toHaveLength(30);
  });

  it.each(combinations)(
    '%s + %s：路径只由路径形态决定，叠加层只由特效决定',
    (pathStyle, effect) => {
      const { base, overlay } = renderEdge(pathStyle, effect);
      const expectedOverlayClass = edgeEffectOverlayClassName(effect);

      expect(base).toHaveAttribute('d', settledPath(pathStyle));
      expect(base).toHaveAttribute(
        'class',
        `react-flow__edge-path canvas-flow-edge-path${
          effect === 'marching' ? ' canvas-edge-effect-marching' : ''
        }`,
      );
      if (expectedOverlayClass) {
        expect(overlay).toHaveAttribute('class', expectedOverlayClass);
        expect(overlay).toHaveAttribute('d', settledPath(pathStyle));
      } else {
        expect(overlay).toBeNull();
      }
    },
  );

  it('切换特效不会改变基础路径的 d', () => {
    const paths = new Set<string>();
    for (const effect of effects) {
      const { base, unmount } = renderEdge('smoothstep', effect);
      paths.add(base?.getAttribute('d') ?? '');
      unmount();
    }

    expect(paths.size).toBe(1);
    expect([...paths][0]).toBe(settledPath('smoothstep'));
  });

  it('叠加层不接收指针事件，基础边仍是选择命中目标', () => {
    const { base, overlay } = renderEdge('bezier', 'meteor', true);

    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay?.hasAttribute('onclick')).toBe(false);
    expect(base).toHaveClass('is-selected');
    expect(overlay).not.toHaveClass('is-selected');
    // 选择态仍由基础边承担，叠加层不改变基础边的路径。
    expect(base).toHaveAttribute('d', settledPath('bezier'));
    // 叠加层位于基础边之后，但 CSS 只给它 pointer-events: none，也没有任何回调。
    expect(overlay).toHaveAttribute('class', 'canvas-edge-effect-meteor');
    fireEvent.pointerDown(overlay as Element);
    expect(onEdgePointerDown).toHaveBeenCalledTimes(1);

    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(
      /\.canvas-edge-effect-meteor, \.canvas-edge-effect-cruiser, \.canvas-edge-effect-multi, \.canvas-edge-effect-breathe \{[^}]*pointer-events: none;/,
    );
    expect(css).toMatch(
      /\.canvas-flow-edge-path\.is-selected \{[^}]*stroke: var\(--mc-accent-strong\);/,
    );
  });

  it('减少动态效果时关闭非必要动画并保留静态线型', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reducedMotion).toMatch(/\.canvas-edge-effect-meteor,[^}]*animation: none;/);
    expect(reducedMotion).toMatch(/\.canvas-edge-effect-breathe \{[^}]*opacity: 0\.4;/);
    expect(css).not.toContain('.edge-style-pulse');
    expect(css).not.toContain('.edge-style-minimal');
  });
});

describe('FlowingConnectionLine', () => {
  it.each(pathStyles)('%s 预览使用 xyflow 已居中的端点，不再二次内收', (pathStyle) => {
    const { container } = render(
      <svg>
        <FlowingConnectionLine
          fromX={0}
          fromY={10}
          toX={100}
          toY={10}
          fromPosition={Position.Right}
          toPosition={Position.Left}
          pathStyle={pathStyle}
          effect="meteor"
        />
      </svg>,
    );
    const preview = {
      sourceX: 0,
      sourceY: 10,
      targetX: 100,
      targetY: 10,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };

    expect(container.querySelector('.canvas-flow-edge-path')).toHaveAttribute(
      'd',
      resolveEdgePath(pathStyle, preview),
    );
    expect(container.querySelector('[data-testid="edge-effect-overlay"]')).toHaveAttribute(
      'd',
      resolveEdgePath(pathStyle, preview),
    );
  });

  it('预览与落定边对同一条连线给出相同几何', () => {
    expect(resolveEdgePath('straight', edgeParams)).toBe(getStraightPath(edgeParams)[0]);
    expect(settledPath('straight')).not.toBe(resolveEdgePath('straight', edgeParams));
  });

  it('无特效时预览不渲染叠加层', () => {
    const { container } = render(
      <svg>
        <FlowingConnectionLine
          fromX={0}
          fromY={10}
          toX={100}
          toY={10}
          fromPosition={Position.Right}
          toPosition={Position.Left}
          pathStyle="bezier"
          effect="none"
        />
      </svg>,
    );

    expect(container.querySelector('.canvas-flow-edge-path')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="edge-effect-overlay"]')).toBeNull();
  });
});

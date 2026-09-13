import '@testing-library/jest-dom/vitest';

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' };
  return {
    Position,
    getBezierPath: ({ sourceX, sourceY, targetX, targetY }: Record<string, number>) => [
      `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`,
    ],
    BaseEdge: ({ path, className }: { path: string; className?: string }) => (
      <path data-testid="base-edge" d={path} className={className} />
    ),
  };
});

import { Position } from '@xyflow/react';
import { FlowingCanvasEdge } from './FlowingCanvasEdge';

describe('FlowingCanvasEdge', () => {
  it('把端点收到锚点圆心并绘制流光', () => {
    const { container } = render(
      <svg>
        <FlowingCanvasEdge
          id="edge-1"
          source="a"
          target="b"
          sourceX={0}
          sourceY={10}
          targetX={100}
          targetY={10}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
        />
      </svg>,
    );

    expect(container.querySelector('[data-testid="base-edge"]')).toHaveAttribute(
      'd',
      'M -9 10 L 109 10',
    );
    expect(container.querySelector('.canvas-flow-edge-meteor')).toHaveAttribute(
      'd',
      'M -9 10 L 109 10',
    );
  });
});

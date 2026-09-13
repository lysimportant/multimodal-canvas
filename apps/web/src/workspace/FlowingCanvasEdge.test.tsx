import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import {
  FLOW_HANDLE_SIZE,
  FlowingCanvasEdge,
  FlowingConnectionLine,
  centerHandlePoint,
} from './FlowingCanvasEdge';

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

  it.each([
    ['image->video 右到左', Position.Right, Position.Left, 0, 10, 100, 10, 'M -9 10 L 109 10'],
    ['text->image 上到下', Position.Bottom, Position.Top, 40, 80, 40, 0, 'M 40 71 L 40 9'],
    ['audio->text 左到右', Position.Left, Position.Right, 20, 30, 200, 30, 'M 29 30 L 191 30'],
    ['video->audio 下到上', Position.Top, Position.Bottom, 60, 0, 60, 120, 'M 60 9 L 60 111'],
  ] as const)(
    '四类节点 %s 连线都对准锚点圆心并绘制流光',
    (_label, sourcePosition, targetPosition, sourceX, sourceY, targetX, targetY, path) => {
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

      expect(container.querySelector('[data-testid="base-edge"]')).toHaveAttribute('d', path);
      expect(container.querySelector('.canvas-flow-edge-meteor')).toHaveAttribute('d', path);
    },
  );

  it('拖拽预览使用 xyflow 已居中的端点，不再二次内收', () => {
    const { container } = render(
      <svg>
        <FlowingConnectionLine
          fromX={0}
          fromY={10}
          toX={100}
          toY={10}
          fromPosition={Position.Right}
          toPosition={Position.Left}
        />
      </svg>,
    );

    expect(container.querySelector('.canvas-flow-edge-path')).toHaveAttribute(
      'd',
      'M 0 10 L 100 10',
    );
    expect(container.querySelector('.canvas-flow-edge-meteor')).toHaveAttribute(
      'd',
      'M 0 10 L 100 10',
    );
  });
});

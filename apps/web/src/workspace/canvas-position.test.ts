import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NODE_FLOW_HEIGHT,
  DEFAULT_NODE_FLOW_WIDTH,
  getCenteredCanvasNodePosition,
} from './canvas-position';

describe('canvas node positioning', () => {
  it('centers the default node in flow coordinates at the current viewport center', () => {
    const position = getCenteredCanvasNodePosition(
      { left: 64, top: 0, width: 1096, height: 900 },
      ({ x, y }) => ({ x: (x - 64) / 2, y: y / 2 }),
    );

    expect(position).toEqual({
      x: 1096 / 2 / 2 - DEFAULT_NODE_FLOW_WIDTH / 2,
      y: 900 / 2 / 2 - DEFAULT_NODE_FLOW_HEIGHT / 2,
    });
  });

  it('does not create a position for an unavailable viewport', () => {
    expect(
      getCenteredCanvasNodePosition({ left: 0, top: 0, width: 0, height: 400 }, ({ x, y }) => ({
        x,
        y,
      })),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NODE_FLOW_HEIGHT,
  DEFAULT_NODE_FLOW_WIDTH,
  NEW_NODE_PLACEMENT_GAP,
  getCenteredCanvasNodePosition,
  getNodePlacementRightOf,
} from './canvas-position';

const imageDimensions = { width: 400, height: 266 };

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

describe('new node placement', () => {
  const source = { position: { x: 100, y: 50 }, width: 400, height: 266 };

  it('places the new node to the right of its source with a stable gap', () => {
    const position = getNodePlacementRightOf(source, [source], imageDimensions);

    expect(position).toEqual({
      x: 100 + 400 + NEW_NODE_PLACEMENT_GAP,
      y: 50,
    });
  });

  it('wraps below the source when the immediate right slot is taken', () => {
    const startX = 100 + 400 + NEW_NODE_PLACEMENT_GAP;
    const occupied = [source, { position: { x: startX, y: 50 }, width: 400, height: 266 }];

    expect(getNodePlacementRightOf(source, occupied, imageDimensions)).toEqual({
      x: startX,
      y: 50 + 266 + NEW_NODE_PLACEMENT_GAP,
    });
  });

  it('ignores nodes that only touch the gap and treats missing sizes as defaults', () => {
    const startX = 100 + 400 + NEW_NODE_PLACEMENT_GAP;
    const touching = { position: { x: 500, y: 50 }, width: NEW_NODE_PLACEMENT_GAP, height: 40 };
    expect(getNodePlacementRightOf(source, [touching], imageDimensions)).toEqual({
      x: startX,
      y: 50,
    });

    const legacyNode = { position: { x: startX, y: 50 } };
    const position = getNodePlacementRightOf(source, [legacyNode], imageDimensions);
    expect(position).toEqual({
      x: startX,
      y: 50 + 266 + NEW_NODE_PLACEMENT_GAP,
    });
  });
});

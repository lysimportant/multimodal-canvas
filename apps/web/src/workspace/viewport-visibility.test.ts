import { describe, expect, it } from 'vitest';

import { isNodeInViewport } from './viewport-visibility';

const viewport = { width: 800, height: 600 };
const identity = [0, 0, 1] as const;

function nodeAt(x: number, y: number) {
  return { position: { x, y }, width: 200, height: 120 };
}

describe('isNodeInViewport', () => {
  it('节点与视口有交叠时判定为可见', () => {
    expect(isNodeInViewport({ node: nodeAt(100, 100), transform: identity, viewport })).toBe(true);
    // 部分越界仍算可见。
    expect(isNodeInViewport({ node: nodeAt(-100, -50), transform: identity, viewport })).toBe(true);
    expect(isNodeInViewport({ node: nodeAt(750, 550), transform: identity, viewport })).toBe(true);
  });

  it('节点完全在视口外时判定为不可见', () => {
    expect(isNodeInViewport({ node: nodeAt(-201, 100), transform: identity, viewport })).toBe(
      false,
    );
    expect(isNodeInViewport({ node: nodeAt(801, 100), transform: identity, viewport })).toBe(false);
    expect(isNodeInViewport({ node: nodeAt(100, -121), transform: identity, viewport })).toBe(
      false,
    );
    expect(isNodeInViewport({ node: nodeAt(100, 601), transform: identity, viewport })).toBe(false);
  });

  it('考虑视口平移与缩放', () => {
    // 缩放 2 倍后，flow 坐标 500 落在屏幕 1000，超出 800 宽视口。
    expect(isNodeInViewport({ node: nodeAt(500, 100), transform: [0, 0, 2], viewport })).toBe(
      false,
    );
    // 向左平移 500 后，同一节点回到视口内。
    expect(isNodeInViewport({ node: nodeAt(500, 100), transform: [-500, 0, 2], viewport })).toBe(
      true,
    );
  });

  it('测量缺失或尺寸异常时按可见处理，避免误弹提示', () => {
    expect(isNodeInViewport({ node: undefined, transform: identity, viewport })).toBe(true);
    expect(isNodeInViewport({ node: nodeAt(3000, 3000), transform: [0, 0, 0], viewport })).toBe(
      true,
    );
    expect(
      isNodeInViewport({
        node: { position: { x: 3000, y: 3000 }, width: 0, height: 0 },
        transform: identity,
        viewport,
      }),
    ).toBe(true);
  });
});

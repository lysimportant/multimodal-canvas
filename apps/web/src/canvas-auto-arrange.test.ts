import { describe, expect, it } from 'vitest';
import {
  CANVAS_GROUP_MAX_SIZE,
  CANVAS_GROUP_MIN_SIZE,
  CANVAS_GROUP_NODE_LIMIT,
  canvasGroupSchema,
  type CanvasGroup,
} from '@multimodal-canvas/domain';

import { arrangeCanvasNodes } from './canvas-auto-arrange';
import {
  CANVAS_GROUP_PADDING,
  DEFAULT_FLOW_NODE_HEIGHT,
  DEFAULT_FLOW_NODE_WIDTH,
  type AssetFlowNode,
} from './canvas-utils';

/** 构造顺序与位置不一致的节点；坐标、宽高均为画布像素。 */
function node(index: number, overrides: Partial<AssetFlowNode> = {}): AssetFlowNode {
  return {
    id: `node-${index}`,
    type: 'image',
    position: { x: 700 - index * 13, y: -300 + index * 11 },
    width: 200,
    height: 100,
    data: { label: `节点 ${index}`, mediaType: 'image', mode: 'generate' },
    ...overrides,
  } as AssetFlowNode;
}

/** 构造合法分组，不复制成员数组；默认尺寸为 640×420 画布像素。 */
function group(id: string, nodeIds: string[], overrides: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    id,
    name: `组 ${id}`,
    position: { x: 900, y: 700 },
    width: 640,
    height: 420,
    nodeIds,
    ...overrides,
  };
}

/** 验证已有明确像素尺寸的矩形互不重叠；允许边界接触，不修改参数。 */
function expectNoOverlap(
  rectangles: { position: { x: number; y: number }; width: number; height: number }[],
) {
  rectangles.forEach((left, index) => {
    for (const right of rectangles.slice(index + 1)) {
      expect(
        left.position.x + left.width <= right.position.x ||
          right.position.x + right.width <= left.position.x ||
          left.position.y + left.height <= right.position.y ||
          right.position.y + right.height <= left.position.y,
      ).toBe(true);
    }
  });
}

/** 验证合法组框完整包含其成员及四周内边距；参数不变，尺寸单位为画布像素。 */
function expectGroupContainsMembers(target: CanvasGroup, nodes: AssetFlowNode[]) {
  expect(canvasGroupSchema.safeParse(target).success).toBe(true);
  for (const id of target.nodeIds) {
    const member = nodes.find((entry) => entry.id === id)!;
    const width = member.width ?? member.measured?.width ?? DEFAULT_FLOW_NODE_WIDTH;
    const height = member.height ?? member.measured?.height ?? DEFAULT_FLOW_NODE_HEIGHT;
    expect(member.position.x).toBeGreaterThanOrEqual(target.position.x + CANVAS_GROUP_PADDING);
    expect(member.position.y).toBeGreaterThanOrEqual(target.position.y + CANVAS_GROUP_PADDING);
    expect(member.position.x + width + CANVAS_GROUP_PADDING).toBeLessThanOrEqual(
      target.position.x + target.width,
    );
    expect(member.position.y + height + CANVAS_GROUP_PADDING).toBeLessThanOrEqual(
      target.position.y + target.height,
    );
  }
}

describe('arrangeCanvasNodes', () => {
  it('空画布直接复用输入数组', () => {
    const nodes: AssetFlowNode[] = [];
    const groups: CanvasGroup[] = [];
    Object.freeze(nodes);
    Object.freeze(groups);
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).toBe(nodes);
    expect(arranged.groups).toBe(groups);
  });

  it('单个无尺寸节点保留位置、原对象和数组，不写入默认尺寸', () => {
    const nodes = [node(0, { width: undefined, height: undefined })];
    const groups: CanvasGroup[] = [];
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).toBe(nodes);
    expect(arranged.nodes[0]).toBe(nodes[0]);
    expect(arranged.nodes[0].position).toBe(nodes[0].position);
    expect(arranged.nodes[0].width).toBeUndefined();
    expect(arranged.nodes[0].height).toBeUndefined();
    expect(arranged.groups).toBe(groups);
  });

  it.each([30, 31, 61])('%i 个节点从原包围盒左上角稳定排列，每行最多 30 个', (count) => {
    const nodes = Array.from({ length: count }, (_, index) =>
      node(index, { width: undefined, height: undefined }),
    );
    const origin = { x: 700 - (count - 1) * 13, y: -300 };
    const arranged = arrangeCanvasNodes(nodes, []);
    arranged.nodes.forEach((entry, index) => {
      expect(entry.id).toBe(nodes[index].id);
      expect(entry.position).toEqual({
        x: origin.x + (index % 30) * (DEFAULT_FLOW_NODE_WIDTH + 60),
        y: origin.y + Math.floor(index / 30) * (DEFAULT_FLOW_NODE_HEIGHT + 80),
      });
      expect(entry.width).toBeUndefined();
      expect(entry.height).toBeUndefined();
    });
    const repeated = arrangeCanvasNodes(arranged.nodes, arranged.groups);
    expect(repeated.nodes).toBe(arranged.nodes);
    expect(repeated.groups).toBe(arranged.groups);
  });

  it('列宽取整列最大值、行高取整行最大值，跨行异形节点不重叠', () => {
    const nodes = Array.from({ length: 61 }, (_, index) => node(index));
    nodes[30].width = 600;
    nodes[31].width = 300;
    nodes[20].height = 450;
    nodes[40].height = 380;
    const arranged = arrangeCanvasNodes(nodes, []);
    const origin = arranged.nodes[0].position;
    expect(arranged.nodes[1].position.x).toBe(origin.x + 600 + 60);
    expect(arranged.nodes[2].position.x).toBe(origin.x + 600 + 60 + 300 + 60);
    expect(arranged.nodes[30].position).toEqual({ x: origin.x, y: origin.y + 450 + 80 });
    expect(arranged.nodes[60].position).toEqual({
      x: origin.x,
      y: origin.y + 450 + 80 + 380 + 80,
    });
    expectNoOverlap(
      arranged.nodes.map((entry) => ({ ...entry, width: entry.width!, height: entry.height! })),
    );
  });

  it('宽高逐项优先持久尺寸，其次采用正数 measured，均不写回节点', () => {
    const nodes = Array.from({ length: 31 }, (_, index) =>
      node(index, {
        width: undefined,
        height: undefined,
        measured: { width: 310.5, height: 180.25 },
      }),
    );
    nodes[0] = node(0, { width: 400, height: undefined, measured: { width: 900, height: 280 } });
    nodes[1] = node(1, { width: undefined, height: 320, measured: { width: 500, height: 900 } });
    const arranged = arrangeCanvasNodes(nodes, []);
    const origin = arranged.nodes[0].position;
    expect(arranged.nodes[1].position.x).toBe(origin.x + 400 + 60);
    expect(arranged.nodes[2].position.x).toBe(origin.x + 400 + 60 + 500 + 60);
    expect(arranged.nodes[30].position.y).toBe(origin.y + 320 + 80);
    arranged.nodes.forEach((entry, index) => {
      expect(entry.width).toBe(nodes[index].width);
      expect(entry.height).toBe(nodes[index].height);
      expect(entry.measured).toBe(nodes[index].measured);
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '忽略非法 measured 尺寸 %s，沿用默认宽高',
    (invalid) => {
      const nodes = Array.from({ length: 31 }, (_, index) =>
        node(index, {
          width: undefined,
          height: undefined,
          measured: { width: invalid, height: invalid },
        }),
      );
      const arranged = arrangeCanvasNodes(nodes, []);
      expect(arranged.nodes[1].position.x - arranged.nodes[0].position.x).toBe(
        DEFAULT_FLOW_NODE_WIDTH + 60,
      );
      expect(arranged.nodes[30].position.y - arranged.nodes[0].position.y).toBe(
        DEFAULT_FLOW_NODE_HEIGHT + 80,
      );
    },
  );

  it('不修改冻结输入，完整保留顺序、尺寸、data、selected 和业务字段引用', () => {
    const nodes = Array.from({ length: 3 }, (_, index) => ({
      ...node(index),
      selected: index !== 1,
      dragging: false,
      hidden: index === 2,
      zIndex: index + 5,
      style: Object.freeze({ opacity: 0.9 }),
      measured: Object.freeze({ width: 880, height: 660 }),
      businessMetadata: Object.freeze({ revision: index }),
    }));
    for (const entry of nodes) {
      Object.freeze(entry.position);
      Object.freeze(entry.data);
      Object.freeze(entry);
    }
    Object.freeze(nodes);
    const memberIds = [nodes[2].id, nodes[0].id];
    Object.freeze(memberIds);
    const target = group('frozen', memberIds);
    Object.freeze(target.position);
    Object.freeze(target);
    const groups = [target];
    Object.freeze(groups);
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).not.toBe(nodes);
    arranged.nodes.forEach((entry, index) => {
      const { position: beforePosition, ...before } = nodes[index];
      const { position: afterPosition, ...after } = entry;
      expect(after).toEqual(before);
      expect(beforePosition).toEqual({ x: 700 - index * 13, y: -300 + index * 11 });
      expect(afterPosition).not.toBe(beforePosition);
      for (const key of Object.keys(before) as (keyof AssetFlowNode)[]) {
        expect(entry[key]).toBe(nodes[index][key]);
      }
    });
    expect(arranged.groups[0].nodeIds).toBe(memberIds);
    expect(target.position).toEqual({ x: 900, y: 700 });
    expect(target.width).toBe(640);
    expect(target.height).toBe(420);
  });

  it('只移动必要节点，已位于目标位置的节点和 position 复用引用', () => {
    const nodes = [
      node(0, { position: { x: 0, y: 0 } }),
      node(1, { position: { x: 900, y: 200 } }),
    ];
    const groups: CanvasGroup[] = [];
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).not.toBe(nodes);
    expect(arranged.nodes[0]).toBe(nodes[0]);
    expect(arranged.nodes[0].position).toBe(nodes[0].position);
    expect(arranged.nodes[1].position).toEqual({ x: 260, y: 0 });
    expect(arranged.groups).toBe(groups);
    expect(arrangeCanvasNodes(arranged.nodes, arranged.groups).nodes).toBe(arranged.nodes);
  });

  it('未分组节点在上、各组含空组按原顺序独立排列，成员保持节点输入顺序', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => node(index));
    const groups = [
      group('first', [nodes[5].id, nodes[2].id], { position: { x: -500, y: 20 } }),
      group('empty', [], { position: { x: 30, y: -600 }, width: 800, height: 300 }),
      group('last', [nodes[3].id, nodes[0].id]),
    ];
    const arranged = arrangeCanvasNodes(nodes, groups);
    const [first, empty, last] = arranged.groups;
    expect(arranged.nodes.map((entry) => entry.id)).toEqual(nodes.map((entry) => entry.id));
    expect(arranged.groups.map((entry) => entry.id)).toEqual(['first', 'empty', 'last']);
    expect(arranged.nodes[1].position).toEqual({ x: -500, y: -600 });
    expect(arranged.nodes[4].position).toEqual({ x: -240, y: -600 });
    expect(first.position).toEqual({ x: -500, y: -420 });
    expect(first.width).toBe(200 * 2 + 60 + CANVAS_GROUP_PADDING * 2);
    expect(first.height).toBe(100 + CANVAS_GROUP_PADDING * 2);
    expect(arranged.nodes[2].position).toEqual({ x: -476, y: -396 });
    expect(arranged.nodes[5].position.x).toBe(-216);
    expect(empty.position).toEqual({ x: -500, y: first.position.y + first.height + 80 });
    expect(empty.width).toBe(800);
    expect(empty.height).toBe(300);
    expect(last.position).toEqual({ x: -500, y: empty.position.y + empty.height + 80 });
    expect(arranged.nodes[0].position.x).toBe(last.position.x + CANVAS_GROUP_PADDING);
    expect(arranged.nodes[3].position.x).toBe(arranged.nodes[0].position.x + 260);
    arranged.groups.forEach((entry, index) => {
      expect(entry.name).toBe(groups[index].name);
      expect(entry.nodeIds).toBe(groups[index].nodeIds);
      expectGroupContainsMembers(entry, arranged.nodes);
    });
    expectNoOverlap([
      ...arranged.groups,
      ...[arranged.nodes[1], arranged.nodes[4]].map((entry) => ({
        ...entry,
        width: entry.width!,
        height: entry.height!,
      })),
    ]);
    const repeated = arrangeCanvasNodes(arranged.nodes, arranged.groups);
    expect(repeated.nodes).toBe(arranged.nodes);
    expect(repeated.groups).toBe(arranged.groups);
  });

  it.each([31, 61, CANVAS_GROUP_NODE_LIMIT])(
    '组内 %i 个节点最多 30 个一行，组框包含全部成员且符合领域上限',
    (count) => {
      const nodes = Array.from({ length: count }, (_, index) =>
        node(index, { width: undefined, height: undefined }),
      );
      const members = nodes.map((entry) => entry.id).reverse();
      const arranged = arrangeCanvasNodes(nodes, [group('many', members)]);
      expect(arranged.groups[0].nodeIds).toBe(members);
      expect(arranged.nodes[30].position.x).toBe(arranged.nodes[0].position.x);
      expect(arranged.nodes[30].position.y - arranged.nodes[0].position.y).toBe(
        DEFAULT_FLOW_NODE_HEIGHT + 80,
      );
      expectGroupContainsMembers(arranged.groups[0], arranged.nodes);
      const repeated = arrangeCanvasNodes(arranged.nodes, arranged.groups);
      expect(repeated.nodes).toBe(arranged.nodes);
      expect(repeated.groups).toBe(arranged.groups);
    },
  );

  it('只有空组时按组框最小 x/y 排列，保留尺寸、成员、顺序并保持幂等', () => {
    const nodes: AssetFlowNode[] = [];
    const groups = [
      group('empty-1', [], { position: { x: 400, y: -50 }, width: 700, height: 300 }),
      group('empty-2', [], { position: { x: -80, y: 600 }, width: 900, height: 800 }),
    ];
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).toBe(nodes);
    expect(arranged.groups[0].position).toEqual({ x: -80, y: -50 });
    expect(arranged.groups[1].position).toEqual({ x: -80, y: 330 });
    arranged.groups.forEach((entry, index) => {
      expect(entry.width).toBe(groups[index].width);
      expect(entry.height).toBe(groups[index].height);
      expect(entry.nodeIds).toBe(groups[index].nodeIds);
    });
    expectNoOverlap(arranged.groups);
    expect(arrangeCanvasNodes(nodes, arranged.groups).groups).toBe(arranged.groups);
  });

  it('仅调整组框尺寸时复用原组 position、成员数组及未移动节点', () => {
    const nodes = [node(0, { position: { x: 24, y: 24 } })];
    const groups = [group('sized', [nodes[0].id], { position: { x: 0, y: 0 } })];
    const arranged = arrangeCanvasNodes(nodes, groups);
    expect(arranged.nodes).toBe(nodes);
    expect(arranged.groups[0]).not.toBe(groups[0]);
    expect(arranged.groups[0].position).toBe(groups[0].position);
    expect(arranged.groups[0].nodeIds).toBe(groups[0].nodeIds);
    expect(arranged.groups[0].width).toBe(248);
    expect(arranged.groups[0].height).toBe(148);
    const repeated = arrangeCanvasNodes(arranged.nodes, arranged.groups);
    expect(repeated.nodes).toBe(nodes);
    expect(repeated.groups).toBe(arranged.groups);
    expect(repeated.groups[0]).toBe(arranged.groups[0]);
  });

  it('小节点组框至少 120 像素，保留成员尺寸与足够内边距', () => {
    const nodes = [node(0, { width: 1, height: 2 })];
    const arranged = arrangeCanvasNodes(nodes, [group('small', [nodes[0].id])]);
    expect(arranged.groups[0].width).toBe(CANVAS_GROUP_MIN_SIZE);
    expect(arranged.groups[0].height).toBe(CANVAS_GROUP_MIN_SIZE);
    expect(arranged.nodes[0].width).toBe(1);
    expect(arranged.nodes[0].height).toBe(2);
    expectGroupContainsMembers(arranged.groups[0], arranged.nodes);
  });

  it('组框依据 measured 计算完整包围盒，不沿用旧组框且不写回缺失尺寸', () => {
    const nodes = [
      node(0, { width: undefined, height: undefined, measured: { width: 800, height: 500 } }),
    ];
    const arranged = arrangeCanvasNodes(nodes, [group('measured', [nodes[0].id])]);
    expect(arranged.groups[0].width).toBe(848);
    expect(arranged.groups[0].height).toBe(548);
    expect(arranged.nodes[0].width).toBeUndefined();
    expect(arranged.nodes[0].height).toBeUndefined();
    expectGroupContainsMembers(arranged.groups[0], arranged.nodes);
  });

  it('大尺寸组必要时减少列数，不裁剪组框或节点，重复整理复用引用', () => {
    const nodes = Array.from({ length: 61 }, (_, index) =>
      node(index, { width: 400, height: 266 }),
    );
    const arranged = arrangeCanvasNodes(nodes, [
      group(
        'wide',
        nodes.map((entry) => entry.id),
      ),
    ]);
    expect(arranged.groups[0].width).toBe(21 * 400 + 20 * 60 + 48);
    expect(arranged.nodes[21].position.x).toBe(arranged.nodes[0].position.x);
    expect(arranged.nodes[21].position.y - arranged.nodes[0].position.y).toBe(266 + 80);
    expectGroupContainsMembers(arranged.groups[0], arranged.nodes);
    expectNoOverlap(arranged.nodes.map((entry) => ({ ...entry, width: 400, height: 266 })));
    const repeated = arrangeCanvasNodes(arranged.nodes, arranged.groups);
    expect(repeated.nodes).toBe(arranged.nodes);
    expect(repeated.groups).toBe(arranged.groups);
  });

  it('组框允许恰好到达 10,000 像素上限', () => {
    const size = CANVAS_GROUP_MAX_SIZE - CANVAS_GROUP_PADDING * 2;
    const nodes = [node(0, { width: size, height: size })];
    const arranged = arrangeCanvasNodes(nodes, [group('limit', [nodes[0].id])]);
    expect(arranged.groups[0].width).toBe(CANVAS_GROUP_MAX_SIZE);
    expect(arranged.groups[0].height).toBe(CANVAS_GROUP_MAX_SIZE);
    expectGroupContainsMembers(arranged.groups[0], arranged.nodes);
  });

  it.each(['width', 'height'] as const)(
    '成员 %s 加内边距超过上限时明确失败且输入不变',
    (dimension) => {
      const nodes = [node(0), node(1, { [dimension]: CANVAS_GROUP_MAX_SIZE })];
      const groups = [group('too-large', [nodes[1].id])];
      nodes.forEach((entry) => {
        Object.freeze(entry.position);
        Object.freeze(entry);
      });
      Object.freeze(nodes);
      Object.freeze(groups[0].position);
      Object.freeze(groups[0]);
      Object.freeze(groups);
      expect(() => arrangeCanvasNodes(nodes, groups)).toThrow(RangeError);
      expect(() => arrangeCanvasNodes(nodes, groups)).toThrow('too-large');
      expect(nodes[0].position).toEqual({ x: 700, y: -300 });
      expect(nodes[1][dimension]).toBe(CANVAS_GROUP_MAX_SIZE);
      expect(groups[0].position).toEqual({ x: 900, y: 700 });
    },
  );

  it('成员本身尺寸合法但所有列数组合均超宽或超高时不返回非法组框', () => {
    const nodes = Array.from({ length: CANVAS_GROUP_NODE_LIMIT }, (_, index) =>
      node(index, { width: 400, height: 400 }),
    );
    const groups = [
      group(
        'too-many-large',
        nodes.map((entry) => entry.id),
      ),
    ];
    expect(() => arrangeCanvasNodes(nodes, groups)).toThrow(RangeError);
    expect(groups[0].width).toBe(640);
    expect(groups[0].nodeIds).toHaveLength(CANVAS_GROUP_NODE_LIMIT);
  });
});

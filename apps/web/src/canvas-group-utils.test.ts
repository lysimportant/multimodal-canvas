import { describe, expect, it } from 'vitest';
import type { CanvasGroup, CanvasDocument } from '@multimodal-canvas/domain';

import {
  CANVAS_GROUP_DEFAULT_SIZE,
  CANVAS_GROUP_PADDING,
  assignNodeToGroup,
  copyCanvasSelection,
  createCanvasGroup,
  expandGroupToFitNode,
  fromCanvasDocument,
  groupContainsPoint,
  nodeCenter,
  nodesBoundingBox,
  normalizeCanvasGroups,
  parseCanvasClipboard,
  pasteCanvasClipboard,
  pruneGroupMembers,
  resizeCanvasGroup,
  resolveDropTargetGroup,
  serializeCanvasClipboard,
  toCanvasDocument,
  translateGroup,
  type AssetFlowNode,
  type CanvasClipboard,
  type FlowEdge,
} from './canvas-utils';

/** 构造带确定尺寸的节点，坐标与尺寸单位为画布像素。 */
function node(id: string, x: number, y: number, width = 200, height = 100): AssetFlowNode {
  return {
    id,
    type: 'image',
    position: { x, y },
    width,
    height,
    data: { label: id, mediaType: 'image', mode: 'generate' },
  } as AssetFlowNode;
}

/** 构造组，缺省位置与尺寸落在测试关注区域之外。 */
function group(overrides: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    id: 'g1',
    name: '场景',
    position: { x: 0, y: 0 },
    width: 640,
    height: 420,
    nodeIds: [],
    ...overrides,
  };
}

describe('group geometry', () => {
  it('包围盒使用节点位置与尺寸，忽略非有限坐标并补齐缺失尺寸', () => {
    expect(nodesBoundingBox([node('a', 0, 0, 200, 100), node('b', 300, 200, 100, 50)])).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 250,
    });
    expect(nodesBoundingBox([])).toBeUndefined();
    expect(
      nodesBoundingBox([
        { ...node('c', 0, 0), position: { x: Number.NaN, y: 0 } } as AssetFlowNode,
      ]),
    ).toBeUndefined();
    expect(
      nodesBoundingBox([{ ...node('d', 10, 20), width: undefined, height: undefined }]),
    ).toEqual({ x: 10, y: 20, width: 230, height: 216 });
  });

  it('有选区时按选区加内边距成组，无选区时创建默认空组', () => {
    const selected = createCanvasGroup({
      id: 'g1',
      name: '组 1',
      selectedNodes: [node('a', 100, 100, 200, 100), node('b', 400, 200, 100, 100)],
    });
    expect(selected.position).toEqual({
      x: 100 - CANVAS_GROUP_PADDING,
      y: 100 - CANVAS_GROUP_PADDING,
    });
    expect(selected.width).toBe(400 + CANVAS_GROUP_PADDING * 2);
    expect(selected.height).toBe(200 + CANVAS_GROUP_PADDING * 2);
    expect(selected.nodeIds).toEqual(['a', 'b']);

    const empty = createCanvasGroup({
      id: 'g2',
      name: '组 2',
      fallbackCenter: { x: 1000, y: 800 },
    });
    expect(empty.nodeIds).toEqual([]);
    expect(empty.width).toBe(CANVAS_GROUP_DEFAULT_SIZE.width);
    expect(empty.height).toBe(CANVAS_GROUP_DEFAULT_SIZE.height);
    expect(empty.position).toEqual({
      x: 1000 - CANVAS_GROUP_DEFAULT_SIZE.width / 2,
      y: 800 - CANVAS_GROUP_DEFAULT_SIZE.height / 2,
    });
  });

  it('落点判定扣掉标题条与内边距，边缘不误入组', () => {
    const target = group();
    expect(groupContainsPoint(target, { x: 320, y: 210 })).toBe(true);
    expect(groupContainsPoint(target, { x: 4, y: 4 })).toBe(false);
    expect(groupContainsPoint(target, { x: 636, y: 416 })).toBe(false);
  });

  it('重叠组优先最小包含区域，同面积用稳定 ID 决定', () => {
    const large = group({ id: 'big', width: 640, height: 420 });
    const small = group({ id: 'small', position: { x: 100, y: 100 }, width: 300, height: 300 });
    expect(resolveDropTargetGroup([large, small], { x: 200, y: 200 })?.id).toBe('small');
    expect(resolveDropTargetGroup([large], { x: 320, y: 210 })?.id).toBe('big');
    expect(resolveDropTargetGroup([large, small], { x: 900, y: 900 })).toBeUndefined();

    const sameAreaA = group({ id: 'aaa', position: { x: 100, y: 100 }, width: 300, height: 300 });
    const sameAreaB = group({ id: 'bbb', position: { x: 120, y: 120 }, width: 300, height: 300 });
    expect(resolveDropTargetGroup([sameAreaB, sameAreaA], { x: 200, y: 200 })?.id).toBe('aaa');
  });

  it('节点中心按实际尺寸计算，缺少尺寸时使用默认宽高', () => {
    expect(nodeCenter(node('a', 0, 0, 200, 100))).toEqual({ x: 100, y: 50 });
    expect(nodeCenter({ ...node('b', 10, 20), width: undefined, height: undefined })).toEqual({
      x: 125,
      y: 128,
    });
  });
});

describe('group membership', () => {
  it('一个节点最多属于一个组，改归属时先移除旧组', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a'] }), group({ id: 'g2', nodeIds: [] })];
    const moved = assignNodeToGroup(groups, 'a', 'g2');
    expect(moved[0].nodeIds).toEqual([]);
    expect(moved[1].nodeIds).toEqual(['a']);
  });

  it('解除归属保持其他成员与组本身不变', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a', 'b'] })];
    expect(assignNodeToGroup(groups, 'a', undefined)[0].nodeIds).toEqual(['b']);
  });

  it('无变化时返回原数组引用，避免多余的历史记录', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a'] })];
    expect(assignNodeToGroup(groups, 'a', 'g1')).toBe(groups);
    expect(assignNodeToGroup(groups, 'b', undefined)).toBe(groups);
  });

  it('扩展组只改变外框，不改变成员尺寸', () => {
    const target = group({ position: { x: 0, y: 0 }, width: 640, height: 420 });
    const member = node('a', 700, 500, 200, 100);
    const expanded = expandGroupToFitNode(target, member);
    expect(expanded.width).toBeGreaterThanOrEqual(700 + 200 + CANVAS_GROUP_PADDING);
    expect(expanded.height).toBeGreaterThanOrEqual(500 + 100 + CANVAS_GROUP_PADDING);
    expect(member.width).toBe(200);
    expect(expandGroupToFitNode(target, node('b', 10, 10, 100, 100))).toBe(target);
  });

  it('成员删除后同步成员列表，空组本身保留', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a', 'b'] })];
    expect(pruneGroupMembers(groups, ['a'])[0]).toMatchObject({ id: 'g1', nodeIds: ['a'] });
    expect(pruneGroupMembers(groups, [])[0]).toMatchObject({ id: 'g1', nodeIds: [] });
    expect(pruneGroupMembers(groups, ['a', 'b'])).toBe(groups);
  });
});

describe('group transform', () => {
  it('整组移动对组与成员使用同一位移', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a'] })];
    const nodes = [node('a', 100, 100), node('b', 900, 900)];
    const moved = translateGroup({ groups, nodes, groupId: 'g1', delta: { x: 40, y: -20 } });
    expect(moved?.groups[0].position).toEqual({ x: 40, y: -20 });
    expect(moved?.nodes[0].position).toEqual({ x: 140, y: 80 });
    expect(moved?.nodes[1].position).toEqual({ x: 900, y: 900 });
  });

  it('未知组或非有限位移拒绝移动', () => {
    const groups = [group({ id: 'g1', nodeIds: [] })];
    expect(
      translateGroup({ groups, nodes: [], groupId: 'ghost', delta: { x: 1, y: 1 } }),
    ).toBeUndefined();
    expect(
      translateGroup({
        groups,
        nodes: [],
        groupId: 'g1',
        delta: { x: Number.POSITIVE_INFINITY, y: 0 },
      }),
    ).toBeUndefined();
  });

  it('缩小到成员包围盒以下时被夹住，成员不会被挤出组', () => {
    const target = group({
      id: 'g1',
      position: { x: 0, y: 0 },
      width: 640,
      height: 420,
      nodeIds: ['a'],
    });
    const shrunk = resizeCanvasGroup(target, [node('a', 400, 300, 200, 100)], {
      width: 10,
      height: 10,
    });
    expect(shrunk.width).toBeGreaterThanOrEqual(400 + 200 + CANVAS_GROUP_PADDING);
    expect(shrunk.height).toBeGreaterThanOrEqual(300 + 100 + CANVAS_GROUP_PADDING);
    expect(resizeCanvasGroup(target, [], { width: 10, height: 10 })).toMatchObject({
      width: 120,
      height: 120,
    });
  });
});

describe('group persistence and clipboard', () => {
  const document: CanvasDocument = {
    revision: 3,
    nodes: [
      {
        id: 'a',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: 'A', mediaType: 'image', mode: 'generate' },
      },
      {
        id: 'b',
        type: 'text',
        position: { x: 400, y: 0 },
        data: { label: 'B', mediaType: 'text', mode: 'generate' },
      },
    ],
    edges: [],
    groups: [group({ id: 'g1', nodeIds: ['a'] })],
  };

  it('画布文档中的组可以往返读写，节点仍使用绝对坐标', () => {
    const flow = fromCanvasDocument(document);
    expect(flow.groups).toEqual([group({ id: 'g1', nodeIds: ['a'] })]);
    expect(flow.nodes.map((entry) => entry.position)).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
    ]);
    const saved = toCanvasDocument(flow.nodes, flow.edges, document.revision, flow.groups);
    expect(saved.groups).toEqual(document.groups);
  });

  it('旧画布没有 groups 字段时按空组读取，保存后写出空组列表', () => {
    const legacy: CanvasDocument = { revision: 0, nodes: document.nodes, edges: [] };
    const flow = fromCanvasDocument(legacy);
    expect(flow.groups).toEqual([]);
    expect(toCanvasDocument(flow.nodes, flow.edges, 0).groups).toEqual([]);
  });

  it('规范化丢弃悬空成员、重复归属并把尺寸抬到下限', () => {
    expect(
      normalizeCanvasGroups(
        [
          group({ id: 'g1', nodeIds: ['a', 'ghost', 'a'] }),
          group({ id: 'g2', width: 10, height: 10, nodeIds: ['a'] }),
        ],
        ['a'],
      ),
    ).toEqual([
      group({ id: 'g1', nodeIds: ['a'] }),
      group({ id: 'g2', width: 120, height: 120, nodeIds: [] }),
    ]);
  });

  it('剪贴板整组复制重建组 ID 与成员 ID 并保持同一位移', () => {
    const flow = fromCanvasDocument(document);
    let counter = 0;
    const clipboard: CanvasClipboard = copyCanvasSelection(
      flow.nodes.map((entry) => ({ ...entry, selected: true })),
      flow.edges,
      undefined,
      flow.groups,
    );
    const pasted = pasteCanvasClipboard(clipboard, () => `id${(counter += 1)}`, 48);
    expect(pasted.groups).toHaveLength(1);
    expect(pasted.groups?.[0].id).toMatch(/^group_copy_/);
    expect(pasted.groups?.[0].position).toEqual({ x: 48, y: 48 });
    expect(pasted.groups?.[0].nodeIds).toEqual([pasted.nodes[0].id]);
    expect(pasted.groups?.[0].nodeIds).not.toContain('a');
  });

  it('只复制部分成员时不携带悬空组归属', () => {
    const groups = [group({ id: 'g1', nodeIds: ['a', 'b'] })];
    const nodes = [{ ...node('a', 0, 0), selected: true }];
    expect(copyCanvasSelection(nodes, [], undefined, groups).groups).toEqual([]);
  });

  it('组随剪贴板序列化往返，旧内容缺少 groups 时按空组解析', () => {
    const clipboard: CanvasClipboard = {
      nodes: [node('a', 0, 0)],
      edges: [] as FlowEdge[],
      groups: [group({ id: 'g1', nodeIds: ['a'] })],
    };
    const parsed = parseCanvasClipboard(serializeCanvasClipboard(clipboard));
    expect(parsed?.groups).toEqual(clipboard.groups);

    const legacyPayload = JSON.stringify({
      format: 'multimodal-canvas/clipboard',
      version: 1,
      nodes: JSON.parse(JSON.stringify(clipboard.nodes)),
      edges: [],
    });
    expect(parseCanvasClipboard(legacyPayload)).toMatchObject({ nodes: expect.any(Array) });
    expect(parseCanvasClipboard(legacyPayload)?.groups).toBeUndefined();
  });

  it('组引用剪贴板之外的节点时整段内容视为不可信', () => {
    const payload = JSON.stringify({
      format: 'multimodal-canvas/clipboard',
      version: 1,
      nodes: JSON.parse(JSON.stringify([node('a', 0, 0)])),
      edges: [],
      groups: [group({ id: 'g1', nodeIds: ['outside'] })],
    });
    expect(parseCanvasClipboard(payload)).toBeUndefined();
  });
});

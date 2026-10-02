import { applyNodeChanges } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  createGenerationBatchProjector,
  projectGenerationBatches,
  reconcileGenerationBatchChanges,
} from './generation-batch-view';

/** 三个独立真实节点，宽高由用户设置，坐标为展开布局。 */
function batchNodes(): AssetFlowNode[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `result-${index}`,
    type: 'image',
    position: { x: 100 + index * 340, y: 200 },
    width: 300,
    height: 240,
    data: {
      label: `图片 ${index + 1}`,
      mediaType: 'image',
      mode: 'generate',
      generationBatch: { id: 'batch-1', rootNodeId: 'result-0', index },
    },
  }));
}

describe('批量卡牌显示投影', () => {
  it('默认收起在首节点后，每层 10px，保留真实尺寸、数据、坐标和连线', () => {
    const nodes = batchNodes();
    const edges: FlowEdge[] = [
      { id: 'root-edge', source: 'source', target: 'result-0' },
      { id: 'back-edge', source: 'source', target: 'result-1' },
    ];
    const view = projectGenerationBatches(nodes, edges);
    expect(view.nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 200 },
      { x: 110, y: 210 },
      { x: 120, y: 220 },
    ]);
    expect(nodes[1]!.position).toEqual({ x: 440, y: 200 });
    expect(view.nodes[1]!.data).toBe(nodes[1]!.data);
    expect(view.nodes.map(({ width, height }) => ({ width, height }))).toEqual(
      nodes.map(({ width, height }) => ({ width, height })),
    );
    expect(view.nodes[1]).toMatchObject({
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      selected: false,
    });
    expect(view.nodes[0]!.zIndex).toBeGreaterThan(view.nodes[1]!.zIndex!);
    expect(view.edges[0]).toBe(edges[0]);
    expect(view.edges[1]!.hidden).toBe(true);
    expect(edges[1]!.hidden).toBeUndefined();
  });

  it('收起时用首节点的拖动状态标记整叠，不修改原节点或既有投影', () => {
    const nodes = batchNodes();
    nodes[0]!.className = 'custom-root';
    nodes[1]!.className = 'custom-back';
    nodes[1]!.width = 420;
    nodes[1]!.height = 320;
    const edges: FlowEdge[] = [
      { id: 'root-edge', source: 'source', target: 'result-0' },
      { id: 'back-edge', source: 'source', target: 'result-1' },
    ];
    const before = projectGenerationBatches(nodes, edges);
    nodes[0]!.dragging = true;
    nodes[1]!.dragging = false;
    const original = structuredClone(nodes);
    const view = projectGenerationBatches(nodes, edges);
    expect(view.nodes).toHaveLength(nodes.length);
    view.nodes.forEach((node, index) => {
      expect(node.className?.split(' ')).toContain('is-generation-batch-dragging');
      expect({
        ...node,
        className: before.nodes[index]!.className,
        dragging: before.nodes[index]!.dragging,
      }).toEqual(before.nodes[index]);
      expect(node.data).toBe(nodes[index]!.data);
    });
    expect(view.edges).toEqual(before.edges);
    expect(view.views).toEqual(before.views);
    expect(nodes).toEqual(original);
  });

  it.each([false, undefined])('首节点未拖动时忽略后卡残留拖动状态：%s', (dragging) => {
    const nodes = batchNodes();
    if (dragging !== undefined) nodes[0]!.dragging = dragging;
    nodes[1]!.dragging = true;
    const view = projectGenerationBatches(nodes, []);
    for (const node of view.nodes) {
      expect(node.className?.split(' ')).not.toContain('is-generation-batch-dragging');
    }
  });

  it.each([0, 1])('展开后只标记实际拖动的成员，停止后移除标记：%s', (draggedIndex) => {
    const nodes = batchNodes();
    nodes[0]!.data.generationBatchExpanded = true;
    nodes[draggedIndex]!.dragging = true;
    const view = projectGenerationBatches(nodes, []);
    expect(
      view.nodes.map((node) => node.className?.includes('is-generation-batch-dragging')),
    ).toEqual(nodes.map((_, index) => index === draggedIndex));
    expect(view.nodes.map((node) => node.position)).toEqual(nodes.map((node) => node.position));
    nodes[draggedIndex]!.dragging = false;
    for (const node of projectGenerationBatches(nodes, []).nodes) {
      expect(node.className?.split(' ')).not.toContain('is-generation-batch-dragging');
    }
  });

  it('拖动状态按批次隔离，不影响另一批次或独立节点', () => {
    const nodes = batchNodes();
    const otherBatch = batchNodes().map((node) => ({
      ...node,
      id: 'other-' + node.id,
      data: {
        ...node.data,
        generationBatch: {
          ...node.data.generationBatch!,
          id: 'batch-2',
          rootNodeId: 'other-result-0',
        },
      },
    }));
    const independent: AssetFlowNode = {
      id: 'independent',
      type: 'image',
      position: { x: 0, y: 0 },
      dragging: true,
      className: 'custom-independent',
      data: { label: '独立图片', mediaType: 'image', mode: 'generate' },
    };
    nodes[0]!.dragging = true;
    const view = projectGenerationBatches([...nodes, ...otherBatch, independent], []);
    expect(
      view.nodes.map((node) => node.className?.includes('is-generation-batch-dragging')),
    ).toEqual([true, true, true, false, false, false, false]);
    expect(view.nodes.at(-1)).toBe(independent);
    expect(view.views.has(independent.id)).toBe(false);
  });

  it('展开恢复真实位置、既有交互配置和连线显示', () => {
    const nodes = batchNodes();
    nodes[0]!.data.generationBatchExpanded = true;
    const edges: FlowEdge[] = [{ id: 'edge', source: 'source', target: 'result-1' }];
    const view = projectGenerationBatches(nodes, edges);
    expect(view.nodes.map((node) => node.position)).toEqual(nodes.map((node) => node.position));
    expect(view.nodes[1]!.draggable).toBeUndefined();
    expect(view.edges[0]).toBe(edges[0]);
    expect(view.views.get('result-0')).toMatchObject({ count: 3, expanded: true, hidden: false });
  });

  it('删除首节点或遇到无效批次关联时，不遮挡剩余结果', () => {
    const nodes = batchNodes().slice(1);
    expect(projectGenerationBatches(nodes, []).nodes).toEqual(nodes);
    const invalidRoot = batchNodes();
    invalidRoot[0]!.data.generationBatch!.id = 'another-batch';
    expect(projectGenerationBatches(invalidRoot, []).views.size).toBe(0);
  });

  it('拖动整叠保留成员真实间距，并过滤投影坐标和后方选中事件', () => {
    const nodes = batchNodes();
    const view = projectGenerationBatches(nodes, []);
    const changes = reconcileGenerationBatchChanges(
      [
        { id: 'result-0', type: 'position', position: { x: 140, y: 230 }, dragging: true },
        { id: 'result-1', type: 'position', position: { x: 150, y: 240 }, dragging: true },
        { id: 'result-1', type: 'select', selected: true },
      ],
      nodes,
      view.views,
    );
    const moved = applyNodeChanges(changes, nodes);
    expect(moved.map((node) => node.position)).toEqual([
      { x: 140, y: 230 },
      { x: 480, y: 230 },
      { x: 820, y: 230 },
    ]);
    expect(moved[1]!.selected).not.toBe(true);
    for (const node of projectGenerationBatches(moved, []).nodes) {
      expect(node.className?.split(' ')).toContain('is-generation-batch-dragging');
    }
    const stopped = reconcileGenerationBatchChanges(
      [{ id: 'result-0', type: 'position', dragging: false }],
      moved,
      projectGenerationBatches(moved, []).views,
    );
    expect(stopped.filter((change) => change.type === 'position' && !change.dragging)).toHaveLength(
      3,
    );
    const settled = applyNodeChanges(stopped, moved);
    expect(settled.every((node) => node.dragging === false)).toBe(true);
    for (const node of projectGenerationBatches(settled, []).nodes) {
      expect(node.className?.split(' ')).not.toContain('is-generation-batch-dragging');
    }
    expect(settled.map((node) => node.position)).toEqual(moved.map((node) => node.position));
  });

  it('展开后移动首节点只影响自己，独立节点的尺寸变化继续传给原有处理器', () => {
    const nodes = batchNodes();
    nodes[0]!.data.generationBatchExpanded = true;
    const changes = reconcileGenerationBatchChanges(
      [
        { id: 'result-0', type: 'position', position: { x: 140, y: 230 } },
        { id: 'result-2', type: 'dimensions', dimensions: { width: 420, height: 300 } },
      ],
      nodes,
      projectGenerationBatches(nodes, []).views,
    );
    expect(changes).toHaveLength(2);
    const moved = applyNodeChanges(changes, nodes);
    expect(moved[1]!.position).toEqual(nodes[1]!.position);
    expect(moved[2]!.measured).toEqual({ width: 420, height: 300 });
  });
});

it('无新增批次隐藏时复用边列表，避免纯位置更新重建连接索引', () => {
  const nodes = batchNodes();
  const edges: FlowEdge[] = [
    { id: 'root', source: 'source', target: 'result-0' },
    { id: 'hidden-child', source: 'source', target: 'result-1', hidden: true },
  ];
  expect(projectGenerationBatches(nodes, edges).edges).toBe(edges);
  nodes[0]!.dragging = true;
  nodes[0]!.position = { x: 300, y: 500 };
  expect(projectGenerationBatches(nodes, edges).edges).toBe(edges);
  const visibleEdges = [{ ...edges[1]!, hidden: false }];
  expect(projectGenerationBatches([], visibleEdges).edges).toBe(visibleEdges);
  nodes[0]!.data.generationBatchExpanded = true;
  expect(projectGenerationBatches(nodes, visibleEdges).edges).toBe(visibleEdges);
  nodes[0]!.data.generationBatchExpanded = false;
  expect(projectGenerationBatches(nodes, visibleEdges).edges).toEqual([
    { ...visibleEdges[0], hidden: true },
  ]);
  expect(visibleEdges[0]?.hidden).toBe(false);
});

describe('批次投影实例缓存', () => {
  it('只移动一个展开节点时复用其它节点、批次状态和边', () => {
    const project = createGenerationBatchProjector();
    const nodes = batchNodes().map((node) => ({
      ...node,
      data: { ...node.data, generationBatchExpanded: true },
    }));
    const edges: FlowEdge[] = [{ id: 'edge', source: 'result-0', target: 'result-1' }];
    const first = project(nodes, edges);
    const moved = [
      { ...nodes[0]!, position: { x: 700, y: 900 }, dragging: true },
      ...nodes.slice(1),
    ];
    const next = project(moved, edges);
    expect(next.nodes[0]).not.toBe(first.nodes[0]);
    expect(next.nodes[1]).toBe(first.nodes[1]);
    expect(next.nodes[2]).toBe(first.nodes[2]);
    expect(next.views).toBe(first.views);
    expect(next.edges).toBe(first.edges);
    expect(next).toEqual(projectGenerationBatches(moved, edges));
  });

  it('收起批次移动时跟随首节点，隐藏边不重复创建；展开和删除正确失效', () => {
    const project = createGenerationBatchProjector();
    const nodes = batchNodes();
    const edges: FlowEdge[] = [{ id: 'edge', source: 'result-0', target: 'result-1' }];
    const first = project(nodes, edges);
    const moved = [
      { ...nodes[0]!, position: { x: 700, y: 900 }, dragging: true },
      ...nodes.slice(1),
    ];
    const next = project(moved, edges);
    expect(next.nodes[1]!.position).toEqual({ x: 710, y: 910 });
    expect(next.views).toBe(first.views);
    expect(next.edges).toBe(first.edges);
    const expanded = [
      { ...moved[0]!, data: { ...moved[0]!.data, generationBatchExpanded: true } },
      ...moved.slice(1),
    ];
    expect(project(expanded, edges)).toEqual(projectGenerationBatches(expanded, edges));
    expect(project(expanded.slice(1), edges)).toEqual(
      projectGenerationBatches(expanded.slice(1), edges),
    );
    expect(project([], []).views.size).toBe(0);
  });

  it('内容、层级、选中和成员排序变化仍与无缓存投影一致', () => {
    const project = createGenerationBatchProjector();
    let nodes = batchNodes();
    const edges: FlowEdge[] = [];
    project(nodes, edges);
    nodes = nodes.map((node, index) => ({
      ...node,
      selected: index === 1,
      zIndex: index * 10,
      data: { ...node.data, label: '新内容' },
    }));
    expect(project(nodes, edges)).toEqual(projectGenerationBatches(nodes, edges));
    nodes = nodes.slice().reverse();
    expect(project(nodes, edges)).toEqual(projectGenerationBatches(nodes, edges));
  });

  it('没有批次时不复制节点数组，多个画布实例互不干扰', () => {
    const a = createGenerationBatchProjector();
    const b = createGenerationBatchProjector();
    const plain = batchNodes().map((node) => ({
      ...node,
      data: { ...node.data, generationBatch: undefined },
    }));
    const nodes = batchNodes();
    const first = a(nodes, []);
    expect(b(plain, []).nodes).toBe(plain);
    expect(a(nodes, []).views).toBe(first.views);
  });
});

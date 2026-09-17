import { applyNodeChanges } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { projectGenerationBatches, reconcileGenerationBatchChanges } from './generation-batch-view';

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
    const stopped = reconcileGenerationBatchChanges(
      [{ id: 'result-0', type: 'position', dragging: false }],
      moved,
      projectGenerationBatches(moved, []).views,
    );
    expect(stopped.filter((change) => change.type === 'position' && !change.dragging)).toHaveLength(
      3,
    );
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

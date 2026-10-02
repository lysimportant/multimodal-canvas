import { describe, expect, it } from 'vitest';
import type { GenerationBatchView } from './generation-batch-view';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  projectDraggingEdges,
  reuseGenerationBatchViews,
  reuseNodeContentSnapshot,
} from './canvas-drag-performance';

/** 不含几何坐标的批次状态；位置变化不能改变这些节点交互语义。 */
const collapsed: GenerationBatchView = {
  rootNodeId: 'root',
  count: 3,
  expanded: false,
  hidden: true,
};

describe('reuseGenerationBatchViews', () => {
  it('普通节点和等值批次投影复用旧映射，不依赖成员遍历顺序', () => {
    const empty = new Map<string, GenerationBatchView>();
    expect(reuseGenerationBatchViews(empty, new Map())).toBe(empty);
    const previous = new Map([
      ['a', collapsed],
      ['b', { ...collapsed }],
    ]);
    const next = new Map([
      ['b', { ...collapsed }],
      ['a', { ...collapsed }],
    ]);
    expect(reuseGenerationBatchViews(previous, next)).toBe(previous);
    expect([...previous.keys()]).toEqual(['a', 'b']);
    expect([...next.keys()]).toEqual(['b', 'a']);
  });

  it.each<Partial<GenerationBatchView>>([
    { rootNodeId: 'new-root' },
    { count: 2 },
    { expanded: true },
    { hidden: false },
  ])('交互字段变化 %j 时发布新状态', (change) => {
    const previous = new Map([['a', collapsed]]);
    const next = new Map([['a', { ...collapsed, ...change }]]);
    expect(reuseGenerationBatchViews(previous, next)).toBe(next);
    expect(previous.get('a')).toBe(collapsed);
  });

  it('新增、删除或等量替换成员都不沿用旧状态', () => {
    const previous = new Map([['a', collapsed]]);
    for (const next of [
      new Map<string, GenerationBatchView>(),
      new Map([['b', collapsed]]),
      new Map([
        ['a', collapsed],
        ['b', collapsed],
      ]),
    ]) {
      expect(reuseGenerationBatchViews(previous, next)).toBe(next);
    }
  });
});

/** 内容快照的节点夹具；位置、尺寸和选择态只属于画布几何。 */
const contentNode: AssetFlowNode = {
  id: 'content',
  type: 'image',
  position: { x: 0, y: 0 },
  data: { label: '内容', mediaType: 'image', mode: 'generate' },
};

describe('reuseNodeContentSnapshot', () => {
  it('位置、尺寸、拖动和选择态变化复用内容快照，但不修改实时节点', () => {
    const previous = [contentNode];
    const next = [
      {
        ...contentNode,
        position: { x: 300, y: 200 },
        width: 600,
        height: 400,
        selected: true,
        dragging: true,
      },
    ];
    expect(reuseNodeContentSnapshot(previous, next)).toBe(previous);
    expect(next[0]?.position).toEqual({ x: 300, y: 200 });
  });
  it('内容、引用、成员和顺序变化都发布新快照', () => {
    const other = { ...contentNode, id: 'other' };
    const previous = [contentNode, other];
    for (const next of [
      [{ ...contentNode, data: { ...contentNode.data, prompt: '新内容' } }, other],
      [contentNode, { ...other, data: { ...other.data, contentUrl: '/v1/assets/new/content' } }],
      [other, contentNode],
      [contentNode],
      [contentNode, other, { ...contentNode, id: 'added' }],
      [contentNode, { ...other, id: 'replaced' }],
    ]) {
      expect(reuseNodeContentSnapshot(previous, next)).toBe(next);
    }
  });
});

describe('projectDraggingEdges', () => {
  /** 同时包含入边、出边、自环、无关边和原本隐藏的边。 */
  const edges: FlowEdge[] = [
    {
      id: 'incoming',
      source: 'a',
      target: 'moving',
      sourceHandle: 'output:image',
      targetHandle: 'input:content',
      selected: true,
      data: { order: 2 },
    },
    { id: 'outgoing', source: 'moving', target: 'b' },
    { id: 'loop', source: 'moving', target: 'moving' },
    { id: 'other', source: 'c', target: 'd' },
    { id: 'hidden', source: 'moving', target: 'd', hidden: true },
  ];

  it('仅暂隐拖动节点的入边、出边和自环，保留连接数据与原对象', () => {
    const before = structuredClone(edges);
    const projected = projectDraggingEdges(edges, ['moving']);
    expect(projected.map((edge) => edge.hidden === true)).toEqual([true, true, true, false, true]);
    expect(projected[0]).toEqual({ ...edges[0], hidden: true });
    expect(projected[3]).toBe(edges[3]);
    expect(projected[4]).toBe(edges[4]);
    expect(edges).toEqual(before);
  });

  it('多选拖动只隐藏各移动节点的相邻边，空闲或孤立节点不复制连线', () => {
    expect(projectDraggingEdges(edges, ['a', 'b']).map((edge) => edge.hidden === true)).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(projectDraggingEdges(edges, [])).toBe(edges);
    expect(projectDraggingEdges(edges, ['isolated'])).toBe(edges);
  });

  it('停止拖动恢复最新连线，不复活拖动期间删除的边，也不取消原有隐藏状态', () => {
    projectDraggingEdges(edges, ['moving']);
    const latest = edges.slice(1);
    expect(projectDraggingEdges(latest, [])).toBe(latest);
    expect(latest[0]?.hidden).toBeUndefined();
    expect(latest.at(-1)?.hidden).toBe(true);
  });
});

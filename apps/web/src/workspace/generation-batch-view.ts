import { createContext } from 'react';
import type { NodeChange } from '@xyflow/react';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { reuseGenerationBatchViews } from './canvas-drag-performance';

/** 批量卡牌的显示状态，只由画布计算，不写入节点数据。 */
export type GenerationBatchView = {
  /** 批次首个节点，同时也是展开/收起入口。 */
  rootNodeId: string;
  /** 当前仍存在的批次成员数。 */
  count: number;
  /** 是否按真实坐标显示全部成员。 */
  expanded: boolean;
  /** 是否为收起时不可交互的后方卡牌。 */
  hidden: boolean;
};

/** 供节点读取卡牌状态和请求持久化展开状态的画布上下文。 */
export const GenerationBatchViewContext = createContext<{
  views: ReadonlyMap<string, GenerationBatchView>;
  onExpandedChange?: ((rootNodeId: string, expanded: boolean) => void) | undefined;
}>({ views: new Map() });

/** 批次成员索引与显示状态；位置变化不重建成员表。 */
type BatchTopology = {
  batches: Array<{ rootIndex: number; members: number[]; expanded: boolean }>;
  views: ReadonlyMap<string, GenerationBatchView>;
};

/** 只比较批次拓扑字段，坐标、运行进度与其它参数不使成员缓存失效。 */
function sameBatchTopology(previous: AssetFlowNode[], next: AssetFlowNode[]): boolean {
  return (
    previous.length === next.length &&
    next.every((node, index) => {
      const prior = previous[index]!;
      const a = prior.data.generationBatch;
      const b = node.data.generationBatch;
      return (
        prior.id === node.id &&
        a?.id === b?.id &&
        a?.rootNodeId === b?.rootNodeId &&
        a?.index === b?.index &&
        prior.data.generationBatchExpanded === node.data.generationBatchExpanded
      );
    })
  );
}

/** 建立有效批次与稳定显示状态；缺失首节点的成员保持可访问。 */
function buildBatchTopology(nodes: AssetFlowNode[]): BatchTopology {
  const indexes = new Map(nodes.map((node, index) => [node.id, index]));
  const membersByRoot = new Map<number, number[]>();
  nodes.forEach((node, index) => {
    const batch = node.data.generationBatch;
    if (!batch) return;
    const rootIndex = indexes.get(batch.rootNodeId);
    if (rootIndex === undefined) return;
    const root = nodes[rootIndex]!;
    if (
      root.data.generationBatch?.id !== batch.id ||
      root.data.generationBatch.rootNodeId !== root.id ||
      root.data.generationBatch.index !== 0
    )
      return;
    const members = membersByRoot.get(rootIndex) ?? [];
    members.push(index);
    membersByRoot.set(rootIndex, members);
  });
  const views = new Map<string, GenerationBatchView>();
  const batches: BatchTopology['batches'] = [];
  for (const [rootIndex, members] of membersByRoot) {
    if (members.length < 2) continue;
    const root = nodes[rootIndex]!;
    const expanded = root.data.generationBatchExpanded === true;
    members.sort(
      (a, b) => nodes[a]!.data.generationBatch!.index - nodes[b]!.data.generationBatch!.index,
    );
    batches.push({ rootIndex, members, expanded });
    for (const index of members) {
      const node = nodes[index]!;
      views.set(node.id, {
        rootNodeId: root.id,
        count: members.length,
        expanded,
        hidden: !expanded && node.id !== root.id,
      });
    }
  }
  return { batches, views };
}

/** 单个批次节点最近一次几何投影；不保存历史帧。 */
type ProjectedBatchNode = {
  input: AssetFlowNode;
  dragging: boolean;
  zIndex: number | undefined;
  x: number;
  y: number;
  output: AssetFlowNode;
};

/**
 * 创建画布实例独享的批次投影缓存；只重建改变的节点，纯位移复用成员表和边。
 * @returns 接收真实节点/显示边并返回只读显示投影的函数；缓存不用于持久化。
 * @remarks 同一实例可反复调用；删除/换项目会替换拓扑并释放旧节点缓存。
 */
export function createGenerationBatchProjector() {
  let previousNodes: AssetFlowNode[] = [];
  let topology: BatchTopology = { batches: [], views: new Map() };
  const projected = new Map<string, ProjectedBatchNode>();
  let previousEdges: FlowEdge[] | undefined;
  let projectedEdges: FlowEdge[] = [];
  return (nodes: AssetFlowNode[], edges: FlowEdge[]) => {
    const topologyChanged = !sameBatchTopology(previousNodes, nodes);
    if (topologyChanged) {
      const next = buildBatchTopology(nodes);
      topology = { ...next, views: reuseGenerationBatchViews(topology.views, next.views) };
      projected.clear();
    }
    previousNodes = nodes;
    const displayNodes = topology.batches.length ? nodes.slice() : nodes;
    for (const { rootIndex, members, expanded } of topology.batches) {
      const root = nodes[rootIndex]!;
      const baseZIndex = expanded
        ? 0
        : Math.max(...members.map((index) => nodes[index]!.zIndex ?? 0));
      members.forEach((nodeIndex, index) => {
        const node = nodes[nodeIndex]!;
        const hidden = !expanded && node.id !== root.id;
        const dragging = expanded ? node.dragging === true : root.dragging === true;
        const zIndex = expanded ? node.zIndex : baseZIndex + members.length - index;
        const x = hidden ? root.position.x + index * 10 : node.position.x;
        const y = hidden ? root.position.y + index * 10 : node.position.y;
        const cached = projected.get(node.id);
        if (
          cached?.input === node &&
          cached.dragging === dragging &&
          cached.zIndex === zIndex &&
          cached.x === x &&
          cached.y === y
        ) {
          displayNodes[nodeIndex] = cached.output;
          return;
        }
        const output: AssetFlowNode = {
          ...node,
          className:
            `${node.className ?? ''} is-generation-batch${hidden ? ' is-generation-batch-hidden' : ''}${dragging ? ' is-generation-batch-dragging' : ''}`.trim(),
          ...(!expanded ? { zIndex } : {}),
          ...(hidden
            ? {
                position: { x, y },
                selected: false,
                draggable: false,
                selectable: false,
                connectable: false,
                focusable: false,
                domAttributes: { ...node.domAttributes, 'aria-hidden': true },
              }
            : {}),
        };
        projected.set(node.id, { input: node, dragging, zIndex, x, y, output });
        displayNodes[nodeIndex] = output;
      });
    }
    if (topologyChanged || previousEdges !== edges) {
      previousEdges = edges;
      projectedEdges = edges;
      edges.forEach((edge, index) => {
        if (
          !edge.hidden &&
          (topology.views.get(edge.source)?.hidden || topology.views.get(edge.target)?.hidden)
        ) {
          if (projectedEdges === edges) projectedEdges = edges.slice();
          projectedEdges[index] = { ...edge, hidden: true };
        }
      });
    }
    return { nodes: displayNodes, edges: projectedEdges, views: topology.views };
  };
}

/**
 * 一次性投影批量卡牌，保留原始坐标、尺寸、连接与参数；画布热路径应复用 projector。
 * @returns 不可写回文档的显示节点、显示边及批次状态。
 */
export function projectGenerationBatches(nodes: AssetFlowNode[], edges: FlowEdge[]) {
  return createGenerationBatchProjector()(nodes, edges);
}

/**
 * 把收起首节点的位移同步到成员真实坐标，忽略后方卡牌投影引起的位置/选中事件。
 * @param changes React Flow 发出的节点变化。
 * @param nodes 尚未应用本次变化的真实节点。
 * @param views 本帧批量显示状态。
 * @returns 可直接交给既有历史和持久化逻辑的真实节点变化；不改变节点尺寸。
 */
export function reconcileGenerationBatchChanges(
  changes: NodeChange<AssetFlowNode>[],
  nodes: AssetFlowNode[],
  views: ReadonlyMap<string, GenerationBatchView>,
): NodeChange<AssetFlowNode>[] {
  const result = changes.filter(
    (change) =>
      !(
        'id' in change &&
        views.get(change.id)?.hidden &&
        (change.type === 'position' || (change.type === 'select' && change.selected))
      ),
  );
  for (const change of changes) {
    if (change.type !== 'position') continue;
    const view = views.get(change.id);
    if (!view || view.expanded || view.rootNodeId !== change.id) continue;
    const root = nodes.find((node) => node.id === change.id);
    if (!root) continue;
    const delta = change.position
      ? { x: change.position.x - root.position.x, y: change.position.y - root.position.y }
      : { x: 0, y: 0 };
    for (const node of nodes) {
      if (node.id === root.id || views.get(node.id)?.rootNodeId !== root.id) continue;
      result.push({
        id: node.id,
        type: 'position',
        position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
        ...(change.dragging !== undefined ? { dragging: change.dragging } : {}),
      });
    }
  }
  return result;
}

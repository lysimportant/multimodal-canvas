import { createContext } from 'react';
import type { NodeChange } from '@xyflow/react';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';

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

/**
 * 将同批节点投影为卡牌堆叠，保留真实尺寸、数据和展开坐标。
 * @param nodes 持久化坐标对应的节点列表。
 * @param edges 全部连线；收起成员的连线只在显示层隐藏。
 * @returns 显示节点、显示连线和节点交互状态；找不到有效首节点时保持成员可访问。
 */
export function projectGenerationBatches(nodes: AssetFlowNode[], edges: FlowEdge[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const batches = new Map<string, AssetFlowNode[]>();
  for (const node of nodes) {
    const batch = node.data.generationBatch;
    if (!batch) continue;
    const root = nodesById.get(batch.rootNodeId);
    if (
      !root ||
      root.data.generationBatch?.id !== batch.id ||
      root.data.generationBatch.rootNodeId !== root.id ||
      root.data.generationBatch.index !== 0
    ) {
      continue;
    }
    const members = batches.get(root.id) ?? [];
    members.push(node);
    batches.set(root.id, members);
  }

  const views = new Map<string, GenerationBatchView>();
  const projected = new Map<string, AssetFlowNode>();
  for (const [rootId, members] of batches) {
    if (members.length < 2) continue;
    const root = nodesById.get(rootId)!;
    const expanded = root.data.generationBatchExpanded === true;
    members.sort(
      (left, right) => left.data.generationBatch!.index - right.data.generationBatch!.index,
    );
    const baseZIndex = Math.max(...members.map((node) => node.zIndex ?? 0));
    members.forEach((node, index) => {
      const hidden = !expanded && node.id !== rootId;
      views.set(node.id, { rootNodeId: rootId, count: members.length, expanded, hidden });
      projected.set(node.id, {
        ...node,
        className:
          `${node.className ?? ''} is-generation-batch${hidden ? ' is-generation-batch-hidden' : ''}`.trim(),
        ...(!expanded ? { zIndex: baseZIndex + members.length - index } : {}),
        ...(hidden
          ? {
              position: { x: root.position.x + index * 10, y: root.position.y + index * 10 },
              selected: false,
              draggable: false,
              selectable: false,
              connectable: false,
              focusable: false,
              domAttributes: { ...node.domAttributes, 'aria-hidden': true },
            }
          : {}),
      });
    });
  }
  return {
    nodes: nodes.map((node) => projected.get(node.id) ?? node),
    edges: edges.map((edge) =>
      views.get(edge.source)?.hidden || views.get(edge.target)?.hidden
        ? { ...edge, hidden: true }
        : edge,
    ),
    views,
  };
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

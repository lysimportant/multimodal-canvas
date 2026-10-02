import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import type { GenerationBatchView } from './generation-batch-view';

/**
 * 暂隐拖动节点的相邻连线，停止路径与特效渲染，但保留 React Flow 的连接关系。
 * @param edges 真实连线，不修改其属性、端口、顺序或已有隐藏状态。
 * @param draggingNodeIds 当前正在拖动的节点 ID；多选拖动时包含所有移动节点。
 * @returns 仅供显示的连线列表；无相邻可见边时复用原列表，不能用于保存或历史记录。
 */
export function projectDraggingEdges(edges: FlowEdge[], draggingNodeIds: readonly string[]) {
  if (draggingNodeIds.length === 0) return edges;
  const dragging = new Set(draggingNodeIds);
  let changed = false;
  const projected = edges.map((edge) => {
    if (!edge.hidden && (dragging.has(edge.source) || dragging.has(edge.target))) {
      changed = true;
      return { ...edge, hidden: true };
    }
    return edge;
  });
  return changed ? projected : edges;
}

/**
 * 复用未改变的批次显示状态，避免位置更新让每个节点的 Context 订阅失效。
 * 几何投影仍逐次计算；只比较影响展开、隐藏及交互的四个字段。
 * @param previous 最近提交的批次状态，不会被修改。
 * @param next 当前节点列表计算出的批次状态，不会被修改。
 * @returns 状态相同时返回旧引用；成员或显示状态变化时返回新映射。
 */
export function reuseGenerationBatchViews(
  previous: ReadonlyMap<string, GenerationBatchView>,
  next: ReadonlyMap<string, GenerationBatchView>,
): ReadonlyMap<string, GenerationBatchView> {
  if (previous.size !== next.size) return next;
  for (const [id, view] of next) {
    const prior = previous.get(id);
    if (
      !prior ||
      prior.rootNodeId !== view.rootNodeId ||
      prior.count !== view.count ||
      prior.expanded !== view.expanded ||
      prior.hidden !== view.hidden
    )
      return next;
  }
  return previous;
}

/**
 * 为参数表单复用内容快照，过滤纯坐标、选择与尺寸变化造成的整表单更新。
 * @param previous 上次提交给表单的节点，仅用于名称、内容和引用解析。
 * @param next 当前完整节点列表；新增、删除、顺序或 data 变化时必须发布新列表。
 * @returns 内容相同返回 previous。返回值可能保留旧坐标，不能用于拖动、保存或执行操作。
 */
export function reuseNodeContentSnapshot(
  previous: readonly AssetFlowNode[],
  next: readonly AssetFlowNode[],
): readonly AssetFlowNode[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index++) {
    if (previous[index]!.id !== next[index]!.id || previous[index]!.data !== next[index]!.data)
      return next;
  }
  return previous;
}

import type { GenerationBatchView } from './generation-batch-view';

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

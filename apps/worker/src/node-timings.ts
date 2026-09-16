import { nodeTimingSchema, type NodeTiming } from '@multimodal-canvas/domain';

/**
 * 合并同一个节点的生命周期时间，字段语义为「先写入者优先」。
 *
 * 轮询、重放、Worker 重启和迟到的重复事件都会再次提交同一节点的时间；合并必须
 * 保持单调：`queuedAt`、`startedAt`、`requestStartedAt`、`requestFinishedAt` 与
 * `finishedAt` 都只保留最早的可解析时刻，`outcome` 只在存在终态时刻时记录一次。
 * 因此重复的终态事件既不能让时间倒退，也不能延长已经结束的耗时。
 *
 * @param existing 已记录的节点时间；缺省表示首次记录。
 * @param incoming 本次事件携带的节点时间。
 * @returns 合并后的节点时间。
 * @throws {Error} 两个时间的 `nodeId` 不一致（拒绝把时间写到别的节点上）。
 */
export function mergeNodeTiming(
  existing: NodeTiming | undefined,
  incoming: NodeTiming,
): NodeTiming {
  if (existing && existing.nodeId !== incoming.nodeId) {
    throw new Error(`node timing identity mismatch: ${existing.nodeId} vs ${incoming.nodeId}`);
  }
  const queuedAt = earliestInstant(existing?.queuedAt, incoming.queuedAt);
  const startedAt = earliestInstant(existing?.startedAt, incoming.startedAt);
  const requestStartedAt = earliestInstant(existing?.requestStartedAt, incoming.requestStartedAt);
  const requestFinishedAt = earliestInstant(
    existing?.requestFinishedAt,
    incoming.requestFinishedAt,
  );
  const finishedAt = earliestInstant(existing?.finishedAt, incoming.finishedAt);
  // 终态标签与终态时刻一起只写一次；已有标签不会被后来的重复事件改写。
  const outcome = existing?.outcome ?? (finishedAt ? incoming.outcome : undefined);
  return {
    nodeId: existing?.nodeId ?? incoming.nodeId,
    ...(queuedAt ? { queuedAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(outcome ? { outcome } : {}),
    ...(requestStartedAt ? { requestStartedAt } : {}),
    ...(requestFinishedAt ? { requestFinishedAt } : {}),
  };
}

/**
 * 逐节点合并一组时间记录，用于累计本次执行的全部时间事件。
 *
 * @param existing 已累计的节点时间；缺省表示本次执行尚未记录。
 * @param incoming 本次事件携带的节点时间。
 * @returns 合并后的完整节点时间表；键为节点 ID。
 * @throws {Error} 表中某个键与其条目的 `nodeId` 不一致。
 */
export function mergeNodeTimings(
  existing: Record<string, NodeTiming> | undefined,
  incoming: Record<string, NodeTiming>,
): Record<string, NodeTiming> {
  const merged: Record<string, NodeTiming> = { ...(existing ?? {}) };
  for (const [nodeId, timing] of Object.entries(incoming)) {
    if (timing.nodeId !== nodeId) {
      throw new Error(`node timing key does not match its identity: ${nodeId}`);
    }
    merged[nodeId] = mergeNodeTiming(merged[nodeId], timing);
  }
  return merged;
}

/**
 * 解析持久化的 `runs.nodeTimings` JSON 列。
 *
 * 只保留结构合法的条目；键与条目 `nodeId` 不一致、或不符合 `nodeTimingSchema`
 * 的历史/损坏数据按缺失处理，绝不参与合并，也不会被写入新的时间。
 *
 * @param value `nodeTimings` 列的原始 JSON 值。
 * @returns 可参与合并的节点时间表。
 */
export function parseStoredNodeTimings(value: unknown): Record<string, NodeTiming> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed: Record<string, NodeTiming> = {};
  for (const [nodeId, candidate] of Object.entries(value as Record<string, unknown>)) {
    const timing = nodeTimingSchema.safeParse(candidate);
    if (!timing.success || timing.data.nodeId !== nodeId) continue;
    parsed[nodeId] = timing.data;
  }
  return parsed;
}

/** 返回两个时刻中较早且可解析的一个；无法解析的值按缺失处理，不参与比较。 */
function earliestInstant(left: string | undefined, right: string | undefined): string | undefined {
  const leftTime = parseInstant(left);
  const rightTime = parseInstant(right);
  if (leftTime === undefined) return rightTime === undefined ? undefined : right;
  if (rightTime === undefined) return left;
  return rightTime < leftTime ? right : left;
}

function parseInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

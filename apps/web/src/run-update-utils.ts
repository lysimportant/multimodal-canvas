import type { RunRecord } from '@multimodal-canvas/domain';

/** Public run DTO adds the safe upstream identity without exposing Provider payloads. */
export type ClientRunRecord = RunRecord & { platformJobId?: string };

/** Lifecycle updates from SSE intentionally omit the immutable input snapshot. */
export type RunUpdate = Omit<ClientRunRecord, 'snapshot'> & {
  snapshot?: RunRecord['snapshot'];
};

/** Preserve the last complete snapshot when a public lifecycle event omits it. */
export function mergeRunUpdate(
  current: ClientRunRecord | undefined,
  incoming: RunUpdate,
): ClientRunRecord | undefined {
  if (!current) return incoming.snapshot ? (incoming as ClientRunRecord) : undefined;
  if (current.id !== incoming.id) {
    return incoming.snapshot ? (incoming as ClientRunRecord) : undefined;
  }

  let result: RunRecord['result'];
  if (current.result && incoming.result) {
    result = { ...current.result, ...incoming.result };
    if (incoming.result.asset) {
      result.asset = current.result.asset
        ? { ...current.result.asset, ...incoming.result.asset }
        : incoming.result.asset;
    }
  } else {
    result = incoming.result ?? current.result;
  }
  return {
    ...current,
    ...incoming,
    snapshot: incoming.snapshot ?? current.snapshot,
    ...(result ? { result } : {}),
  };
}

const statusRank: Record<RunRecord['status'], number> = {
  draft: 0,
  queued: 1,
  preparing: 2,
  running: 3,
  processing: 4,
  archiving: 5,
  cancel_requested: 6,
  succeeded: 7,
  failed: 7,
  cancelled: 7,
};

/** Keep late SSE/poll/history responses from replacing a newer node run. */
export function shouldApplyRunUpdate(current: RunRecord | undefined, incoming: RunUpdate): boolean {
  if (!current) return true;
  if (current.id !== incoming.id) {
    const createdOrder = timestamp(incoming.createdAt) - timestamp(current.createdAt);
    if (createdOrder !== 0) return createdOrder > 0;
    if (incoming.attempt !== current.attempt) return incoming.attempt > current.attempt;
    return incoming.id.localeCompare(current.id) > 0;
  }

  const updatedOrder = timestamp(incoming.updatedAt) - timestamp(current.updatedAt);
  if (updatedOrder !== 0) return updatedOrder > 0;
  if (incoming.progress !== current.progress) return incoming.progress > current.progress;
  return statusRank[incoming.status] >= statusRank[current.status];
}

/**
 * 成功结果是否应清掉节点的「待更新」提示。
 *
 * `stale` 只是会话内的派生提示：一旦该节点最近的运行成功落地，它的展示结果就是
 * 这次执行的结果，上游改动带来的待更新状态也随之结束。早期实现还要求
 * `run.snapshot.canvasRevision >= 当前画布 revision`，但画布 revision 会因为任意
 * 无关编辑（移动节点、改其它节点、甚至只是保存）而前进，导致成功结果永远清不掉徽标
 * （线上项目 9fe6f9d2 即如此）。画布还有未保存改动时仍不清除，避免把「结果对应旧输入」
 * 误标成已更新。
 */
export function shouldClearNodeStale(run: RunRecord, hasUnsavedCanvasChanges: boolean): boolean {
  return run.status === 'succeeded' && !hasUnsavedCanvasChanges;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

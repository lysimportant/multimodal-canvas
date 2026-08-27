import type { RunRecord } from '@multimodal-canvas/domain';

const statusRank: Record<RunRecord['status'], number> = {
  draft: 0,
  queued: 1,
  preparing: 2,
  running: 3,
  processing: 4,
  cancel_requested: 5,
  succeeded: 6,
  failed: 6,
  cancelled: 6,
};

/** Keep late SSE/poll/history responses from replacing a newer node run. */
export function shouldApplyRunUpdate(current: RunRecord | undefined, incoming: RunRecord): boolean {
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

/** A result only makes a node current when it matches the saved canvas snapshot. */
export function shouldClearNodeStale(
  run: RunRecord,
  canvasRevision: number,
  hasUnsavedCanvasChanges: boolean,
): boolean {
  return (
    run.status === 'succeeded' &&
    !hasUnsavedCanvasChanges &&
    run.snapshot.canvasRevision >= canvasRevision
  );
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

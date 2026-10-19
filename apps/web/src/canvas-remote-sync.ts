import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import type { CanvasSnapshot } from './canvas-persistence';
import { fromCanvasDocument, toCanvasDocument } from './canvas-utils';

/** JSON 文档结构判等：忽略对象键顺序与未写入 JSON 的 undefined，不忽略数组顺序。 */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameJsonValue(a[key], b[key]))
  );
}

/** 仅在新修订或 409 边界比较持久化内容，不在拖动帧或相同修订轮询中编码整图。 */
export function remoteCanvasMatches(document: CanvasDocument, snapshot: CanvasSnapshot): boolean {
  const remote = fromCanvasDocument(document);
  return sameJsonValue(
    toCanvasDocument(remote.nodes, remote.edges, 0, remote.groups),
    toCanvasDocument(snapshot.nodes, snapshot.edges, 0, snapshot.groups),
  );
}

/** 新文档只替换持久化数据；仍存在节点的运行状态与结果由当前会话继续回显。 */
export function mergeRemoteCanvasRuntime(
  document: CanvasDocument,
  current: CanvasSnapshot,
  runs: Record<string, RunRecord>,
): CanvasSnapshot {
  const next = fromCanvasDocument(document);
  const previous = new Map(current.nodes.map((node) => [node.id, node]));
  next.nodes = next.nodes.map((node) => {
    const old = previous.get(node.id);
    const run = runs[node.id];
    if (node.data.manualOutput) return node;
    const data = old?.data;
    return {
      ...node,
      selected: old?.selected,
      data: {
        ...node.data,
        runStatus: run?.status ?? data?.runStatus,
        runId: run?.id ?? data?.runId,
        runProgress: run?.progress ?? data?.runProgress,
        runError: run ? run.error : data?.runError,
        upstreamTaskId: data?.upstreamTaskId,
        nodeTiming: run?.nodeTimings?.[node.id] ?? data?.nodeTiming,
        resultAsset:
          run?.status === 'succeeded'
            ? (run.result?.asset ?? data?.resultAsset)
            : data?.resultAsset,
        resultTiming:
          run?.status === 'succeeded'
            ? (run.nodeTimings?.[node.id] ?? data?.resultTiming)
            : data?.resultTiming,
      },
    };
  });
  return next;
}

import type { RunRecord } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from './canvas-utils';
import { sameCanvasContent, type CanvasSnapshot } from './canvas-persistence';

/** 历史仅保留最近 50 个不可变快照，避免随编辑时间无限增长。 */
const HISTORY_LIMIT = 50;

/**
 * 恢复用户编辑，同时保留实时运行字段；节点删除期间的结果由会话运行记录补齐。
 * @param target 撤销/重做目标，包含布局、分组及用户配置。
 * @param current 当前画布，其运行展示比历史快照更新。
 * @param runs 当前项目的运行记录，切项目时由 App 清空。
 * @returns 新画布引用；不修改目标快照、当前节点或运行记录。
 */
function restoreSnapshot(
  target: CanvasSnapshot,
  current: CanvasSnapshot,
  runs: Readonly<Record<string, RunRecord>>,
): CanvasSnapshot {
  const liveNodes = new Map(current.nodes.map((node) => [node.id, node]));
  return {
    ...target,
    nodes: target.nodes.map((node) => {
      const live = liveNodes.get(node.id);
      const data: AssetFlowNode['data'] = { ...node.data };
      if (live) {
        Object.assign(data, {
          runStatus: live.data.runStatus,
          runProgress: live.data.runProgress,
          runError: live.data.runError,
          nodeTiming: live.data.nodeTiming,
          resultAsset: live.data.resultAsset,
          resultTiming: live.data.resultTiming,
        });
      }
      const run = runs[node.id];
      if (run && (!data.manualOutput || data.manualOutputRunId === run.id)) {
        data.runStatus = run.status;
        data.runProgress = run.progress;
        data.runError = run.error;
        data.nodeTiming = run.nodeTimings?.[node.id];
        if (run.status === 'succeeded' && run.result?.asset) {
          data.resultAsset = run.result.asset;
          data.resultTiming = run.nodeTimings?.[node.id];
          if (data.manualOutputRunId === run.id) {
            data.manualOutput = undefined;
            data.manualOutputRunId = undefined;
          }
        }
      }
      const unchanged = (Object.keys(data) as Array<keyof typeof data>).every((key) =>
        Object.is(data[key], node.data[key]),
      );
      if (unchanged && !node.dragging && !node.resizing) return node;
      return { ...node, data, dragging: false, resizing: false };
    }),
  };
}

/**
 * 保留快照式撤销语义，只共享不可变图对象；不引入跨操作命令协议。
 * 编辑入口在变更前 remember，一次拖动/resize 只记一次；异步运行更新不记历史。
 */
export class CanvasHistory {
  /** 可撤销快照，由 App 只读其长度决定按钮状态。 */
  past: CanvasSnapshot[] = [];
  /** 撤销后暂存的快照；新用户编辑会清空。 */
  future: CanvasSnapshot[] = [];

  /** 捕获变更前的引用；相同内容去重，保留最多 50 步，不克隆或编码整图。 */
  remember(current: CanvasSnapshot): void {
    this.future = [];
    const previous = this.past.at(-1);
    if (previous && sameCanvasContent(previous, current)) return;
    this.past = [...this.past.slice(1 - HISTORY_LIMIT), current];
  }

  /** 撤销一次实际编辑，跳过没有移动的拖拽等空事务；无历史时返回 undefined。 */
  undo(
    current: CanvasSnapshot,
    runs: Readonly<Record<string, RunRecord>>,
  ): CanvasSnapshot | undefined {
    let previous = this.past.pop();
    while (previous && sameCanvasContent(previous, current)) previous = this.past.pop();
    if (!previous) return undefined;
    this.future.push(current);
    return restoreSnapshot(previous, current, runs);
  }

  /** 重做一次编辑，并从当前会话重新合并运行状态，不恢复历史中的旧进度。 */
  redo(
    current: CanvasSnapshot,
    runs: Readonly<Record<string, RunRecord>>,
  ): CanvasSnapshot | undefined {
    const next = this.future.pop();
    if (!next) return undefined;
    this.past.push(current);
    return restoreSnapshot(next, current, runs);
  }
}

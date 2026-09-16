import type { NodeTiming } from '@multimodal-canvas/domain';
import { Clock, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { formatNodeDuration, nodeTimingDuration } from '@multimodal-canvas/domain';

/** 运行中耗时的刷新间隔，单位毫秒；终态不再刷新。 */
export const NODE_DURATION_TICK_MS = 1000;

/**
 * 模块级共享时钟：整页只保留一个定时器。
 *
 * 运行中的节点才需要递增显示。若每个节点各自创建定时器，几十个静态节点就会
 * 产生同样多的空转任务，因此这里用订阅者集合共享一份间隔，并在最后一个订阅者
 * 离开时清理。页面不可见时跳过刷新。
 */
const clockSubscribers = new Set<(now: number) => void>();
let clockTimer: number | undefined;

function publishClockTick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  for (const subscriber of clockSubscribers) subscriber(now);
}

function subscribeNodeClock(subscriber: (now: number) => void): () => void {
  clockSubscribers.add(subscriber);
  clockTimer ??= window.setInterval(publishClockTick, NODE_DURATION_TICK_MS);
  return () => {
    clockSubscribers.delete(subscriber);
    if (clockSubscribers.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/**
 * 订阅共享的节点计时时钟。
 *
 * @param enabled 是否需要计时；为 false 时不订阅，也不创建定时器。
 * @returns 当前服务端参考时间，单位毫秒。
 */
export function useSharedNodeClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      // 停止计时时同步一次，避免下次启用时从一个过期基准继续。
      setNow(Date.now());
      return;
    }
    return subscribeNodeClock(setNow);
  }, [enabled]);

  return now;
}

type NodeDurationBadgeProps = {
  timing?: NodeTiming;
  /** 服务端参考时间，单位毫秒；由共享时钟提供。 */
  now: number;
  /** 外部已知的运行状态，用于没有终态时间时判断是否仍在运行。 */
  running?: boolean;
};

/**
 * 节点耗时显示。
 *
 * 未执行或缺少时间戳的节点显示“未记录”；时间顺序异常时标记不可用；
 * 运行中显示已用时间与进行中状态，完成后冻结为终态耗时。
 */
export function NodeDurationBadge({ timing, now, running = false }: NodeDurationBadgeProps) {
  if (!timing) {
    return (
      <span className="node-duration-badge is-unrecorded" title="未记录生成耗时">
        <Clock size={11} aria-hidden="true" /> 未记录
      </span>
    );
  }
  const duration = nodeTimingDuration(timing, now);
  if (duration.availability === 'unrecorded') {
    return (
      <span className="node-duration-badge is-unrecorded" title="未记录生成耗时">
        <Clock size={11} aria-hidden="true" /> 未记录
      </span>
    );
  }
  if (duration.availability === 'invalid') {
    return (
      <span
        className="node-duration-badge is-invalid"
        title={
          duration.reason === 'out-of-order'
            ? '服务端时间顺序异常，耗时不可用'
            : '服务端时间戳晚于当前时间，耗时不可用'
        }
      >
        <Clock size={11} aria-hidden="true" /> 耗时不可用
      </span>
    );
  }
  if (duration.availability === 'running') {
    return (
      <span className="node-duration-badge is-running" title="本节点正在执行">
        <Loader2 size={11} aria-hidden="true" className="node-duration-spinner" />
        {formatNodeDuration(duration.milliseconds)}
      </span>
    );
  }
  const label =
    timing.outcome === 'failed' ? '失败耗时' : timing.outcome === 'cancelled' ? '取消耗时' : '耗时';
  return (
    <span
      className={`node-duration-badge${running ? ' is-running' : ''}`}
      title={`${label} ${formatNodeDuration(duration.milliseconds)}`}
    >
      <Clock size={11} aria-hidden="true" /> {formatNodeDuration(duration.milliseconds)}
    </span>
  );
}

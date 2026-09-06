import { useEffect, useState } from 'react';

/** 退场期间保留节点，减少动态效果或不支持媒体查询时立即移除；时长单位为毫秒。 */
export function usePresence(open: boolean, durationMs: number): boolean {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches) {
      setPresent(false);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => window.clearTimeout(timeout);
  }, [open, durationMs]);
  return open || present;
}

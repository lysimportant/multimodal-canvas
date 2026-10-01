import { useCallback, useEffect, useRef } from 'react';

/** 连续编辑结束后的落盘等待时间，单位为毫秒。 */
export const CANVAS_DRAFT_DELAY_MS = 300;
/** 长时间持续输入也至少每两秒保存一次，避免无限延迟本地恢复点。 */
export const CANVAS_DRAFT_MAX_WAIT_MS = 2000;

/** 保存不可变画布快照的序列化入口，而非在每次拖动时复制整份文档。 */
type PendingDraft = { key: string; serialize: () => string };

/**
 * 合并连续拖动产生的本地草稿写入，不改变显式保存或服务端修订逻辑。
 * @param key 当前用户与项目隔离的草稿键；恢复完成前传 null，不写空画布。
 * @param serialize 捕获当前画布的序列化函数，调用方用 useCallback 稳定非画布更新。
 * @param onError 本地存储失败时报告错误，不静默宣称保存成功。
 * @returns 无。项目切换、卸载、pagehide 和进入后台立即保存最后一次快照。
 */
export function useCanvasDraft(
  key: string | null,
  serialize: () => string,
  onError: (error: unknown) => void,
): void {
  const pending = useRef<PendingDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    clearTimeout(deadline.current);
    deadline.current = undefined;
    timer.current = undefined;
    const draft = pending.current;
    if (!draft) return;
    pending.current = null;
    try {
      localStorage.setItem(draft.key, draft.serialize());
    } catch (error) {
      errorHandler.current(error);
    }
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [key, flush]);

  useEffect(() => {
    if (!key) return;
    pending.current = { key, serialize };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, CANVAS_DRAFT_DELAY_MS);
    deadline.current ??= setTimeout(flush, CANVAS_DRAFT_MAX_WAIT_MS);
    return () => clearTimeout(timer.current);
  }, [key, serialize, flush]);
}

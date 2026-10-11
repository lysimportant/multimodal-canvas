import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import {
  createVideoRecreationFrameBatch,
  initialVideoRecreationPreviews,
  type VideoRecreationPreviewItem,
  type VideoRecreationPreviewSource,
  type VideoRecreationPreviewState,
} from './video-recreation-frames';

export type {
  VideoRecreationPreviewItem,
  VideoRecreationPreviewSource,
  VideoRecreationPreviewState,
} from './video-recreation-frames';

/**
 * 合并同一来源的人物、商品截图；普通重新渲染不会重复读取完整视频。
 * @param source 原视频冻结版本；缺失时只显示来源提示，不发起请求。
 * @param items 角色和商品的合并列表，id 须唯一；标签不参与解码请求身份。
 * @returns 逐项内存预览和显式重试函数；切换账户、来源或卸载立即释放旧结果。
 */
export function useVideoRecreationPreviews(
  source: VideoRecreationPreviewSource | undefined,
  items: readonly VideoRecreationPreviewItem[],
): { previews: ReadonlyMap<string, VideoRecreationPreviewState>; retry: () => void } {
  const generation = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionGeneration,
    getAuthSessionGeneration,
  );
  const [attempt, setAttempt] = useState(0);
  const locations = JSON.stringify(
    items.map((item) => ({ id: item.id, preview: item.preview, appearances: item.appearances })),
  );
  const snapshot = useMemo(() => items.map((item) => ({ ...item })), [locations]);
  const initial = useMemo(() => initialVideoRecreationPreviews(snapshot), [snapshot]);
  const identity = JSON.stringify([
    generation,
    source?.assetId,
    source?.assetVersion,
    locations,
    attempt,
  ]);
  const [resolved, setResolved] = useState<{
    identity: string;
    previews: ReadonlyMap<string, VideoRecreationPreviewState>;
  }>();
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!source) return;
    let active = true;
    const batch = createVideoRecreationFrameBatch(source, snapshot, {
      onResult: (id, state) => {
        if (!active || generation !== getAuthSessionGeneration()) return;
        setResolved((current) => {
          const previews = new Map(current?.identity === identity ? current.previews : initial);
          previews.set(id, state);
          return { identity, previews };
        });
      },
    });
    void batch.promise.catch((error: unknown) => {
      if (!active || generation !== getAuthSessionGeneration()) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setResolved({
        identity,
        previews: new Map(
          [...initial].map(([id, state]) => [
            id,
            state.status === 'loading'
              ? { status: 'error', error: '原视频截图失败，请重试' }
              : state,
          ]),
        ),
      });
    });
    return () => {
      active = false;
      batch.release();
    };
  }, [source?.assetId, source?.assetVersion, generation, identity, initial, snapshot]);

  const missingSource = useMemo(
    () =>
      new Map(
        items.map((item) => [item.id, { status: 'missing', error: '原视频来源不可用' } as const]),
      ),
    [locations],
  );
  return {
    previews: !source
      ? missingSource
      : resolved?.identity === identity
        ? resolved.previews
        : initial,
    retry,
  };
}

/** 一个角色或商品卡片中的截图展示参数；重试应指向共享 batch。 */
export type VideoRecreationPreviewProps = {
  item: VideoRecreationPreviewItem;
  preview?: VideoRecreationPreviewState;
  onRetry: () => void;
};

/**
 * 展示实际原视频画面、定位来源或失败提示；自身不下载视频、不保存截图。
 * @param props 识别对象、共享预览状态及用户显式重试回调。
 * @returns 固定卡片区域内的图片或提示；没有定位时不冒充识别截图。
 */
export function VideoRecreationPreview({ item, preview, onRetry }: VideoRecreationPreviewProps) {
  const state = preview ?? initialVideoRecreationPreviews([item]).get(item.id)!;
  return (
    <figure
      className="video-recreation-preview"
      data-preview-state={state.status}
      data-timestamp-seconds={state.status === 'ready' ? state.timestampSeconds : undefined}
      data-cropped={state.status === 'ready' ? state.cropped : undefined}
    >
      {state.status === 'ready' ? (
        <>
          <img
            className="video-recreation-preview-image"
            src={state.url}
            alt={`${item.label}的原视频画面`}
          />
          <figcaption className="video-recreation-preview-caption">
            原视频 {Number(state.timestampSeconds.toFixed(2))} 秒
            {state.cropped ? ' · 局部裁剪' : ''}
            {state.location === 'appearance' && <small>按首次出现时间截帧</small>}
          </figcaption>
        </>
      ) : (
        <>
          <p
            className="video-recreation-preview-status"
            role={state.status === 'error' ? 'alert' : 'status'}
          >
            {state.status === 'loading' ? '正在截取原视频画面…' : state.error}
          </p>
          {state.status === 'error' && (
            <button
              type="button"
              className="video-recreation-preview-retry"
              aria-label={`重试${item.label}截图`}
              onClick={onRetry}
            >
              重试截图
            </button>
          )}
        </>
      )}
    </figure>
  );
}

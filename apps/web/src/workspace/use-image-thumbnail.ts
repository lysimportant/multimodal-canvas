import { useEffect, useState, useSyncExternalStore } from 'react';
import { getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import {
  acquireImageThumbnail,
  type ImageThumbnail,
  type ImageThumbnailSource,
} from './image-thumbnail-cache';

/** 缩略图显示状态；不承载原文件地址，避免预览和下载误用。 */
export type ImageThumbnailState = ImageThumbnail & { loading: boolean; error?: string };
/**
 * 按资产和鉴权代次订阅共享缩略图；身份变化立即隐藏旧结果并重新获取。
 * @param source 已校验的缩略图源；null 不请求图片，也不保留旧地址或尺寸。
 * @param retry 用户重试代次，变化时释放旧租约并重新获取。
 * @returns 当前代次的加载、图片或错误状态；请求失败转为 error，不回退旧图。
 * @remarks 卸载或依赖变化时释放租约，对象 URL 的回收仍由共享缓存负责。
 */
export function useImageThumbnail(
  source: ImageThumbnailSource | null,
  retry: number,
): ImageThumbnailState {
  const generation = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionGeneration,
    getAuthSessionGeneration,
  );
  const url = source?.url;
  const immutable = source?.immutable ?? false;
  const identity = `${generation}:${url ?? ''}:${retry}`;
  const [resolved, setResolved] = useState<ImageThumbnailState & { identity: string }>();
  useEffect(() => {
    if (!url) return;
    let active = true;
    const lease = acquireImageThumbnail({ url, immutable }, retry);
    void lease.promise
      .then((result) => {
        if (active && generation === getAuthSessionGeneration())
          setResolved({ ...result, identity, loading: false });
      })
      .catch((error: unknown) => {
        if (active && generation === getAuthSessionGeneration())
          setResolved({
            identity,
            url: '',
            loading: false,
            error: error instanceof Error ? error.message : '缩略图加载失败',
          });
      });
    return () => {
      active = false;
      lease.release();
    };
  }, [url, immutable, retry, identity, generation]);
  return resolved?.identity === identity ? resolved : { url: '', loading: !!url };
}

import { useEffect, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@multimodal-canvas/ui';
import { API_BASE_URL, mediaLabels } from '../workspace/contracts';
import { ImagePreviewStage } from '../workspace/ImagePreviewStage';
import { MediaPreviewPlayer } from '../workspace/MediaPreviewPlayer';
import '../workspace/artifact-preview.css';
import './public-asset-share.css';

/** 公开分享只接收展示所需字段，绝不依赖私有资源或账号会话。 */
const publicShareSchema = z.object({
  asset: z.object({
    name: z.string(),
    mediaType: z.enum(['text', 'image', 'audio', 'video']),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    contentUrl: z.string(),
  }),
  expiresAt: z.string().datetime(),
});

/** 当前链接的已验证展示内容；文字由公开内容接口单独读取。 */
type PublicShare = z.infer<typeof publicShareSchema> & { contentUrl: string; text?: string };

/** 将服务端分享错误转成访客可理解的提示，不显示内部请求或令牌。 */
function shareFailure(status: number): string {
  if (status === 404 || status === 403 || status === 401 || status === 410)
    return '分享链接已失效或资源不可用，请联系分享者获取新链接。';
  if (status === 429) return '访问过于频繁，请稍后重试。';
  return '暂时无法读取分享资源，请稍后重试。';
}

/**
 * 独立公开预览页：仅凭分享令牌读取指定版本，不加载或发送账户凭据。
 * @param token URL 片段中的分享令牌；缺失或格式异常时不发出请求。
 * @returns 资源预览、到期说明或可恢复的读取错误。
 */
export function PublicAssetSharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShare>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [imageExpanded, setImageExpanded] = useState(false);

  useEffect(() => {
    if (!imageExpanded) return;
    const exitExpanded = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImageExpanded(false);
    };
    window.addEventListener('keydown', exitExpanded);
    return () => window.removeEventListener('keydown', exitExpanded);
  }, [imageExpanded]);

  useEffect(() => {
    const previousReferrer = document.querySelector<HTMLMetaElement>('meta[name=referrer]');
    const referrer = previousReferrer ?? document.createElement('meta');
    const previousPolicy = referrer.content;
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    if (!previousReferrer) document.head.append(referrer);
    document.title = '共享资源 · LoveTV';
    return () => {
      if (previousReferrer) referrer.content = previousPolicy;
      else referrer.remove();
    };
  }, []);

  useEffect(() => {
    document.title =
      share && !error ? `${share.asset.name} · LoveTV 共享资源` : '共享资源 · LoveTV';
  }, [share, error]);

  useEffect(() => {
    setShare(undefined);
    setError(undefined);
    setImageExpanded(false);
    if (!/^[A-Za-z0-9_.-]{20,4096}$/.test(token)) {
      setError('分享链接不完整，请联系分享者重新复制链接。');
      return;
    }
    const abort = new AbortController();
    let expirationTimer: ReturnType<typeof setTimeout> | undefined;
    const query = new URLSearchParams({ token });
    const apiOrigin = new URL(API_BASE_URL || '/', window.location.origin).origin;
    /** 分享请求不复用 apiFetch，避免附带当前浏览器的登录身份或触发续期。 */
    const request = (url: string) =>
      fetch(url, {
        signal: abort.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    void (async () => {
      const response = await request(`${API_BASE_URL}/v1/asset-shares?${query}`);
      if (!response.ok) throw new Error(shareFailure(response.status));
      const parsed = publicShareSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('分享资源信息不完整，请稍后重试。');
      const result = parsed.data;
      const contentUrl = new URL(result.asset.contentUrl, apiOrigin);
      if (
        contentUrl.origin !== apiOrigin ||
        contentUrl.pathname !== '/v1/asset-shares/content' ||
        contentUrl.searchParams.get('token') !== token
      )
        throw new Error('分享资源地址无效，请联系分享者重新创建链接。');
      let text: string | undefined;
      if (result.asset.mediaType === 'text') {
        const content = await request(contentUrl.href);
        if (!content.ok) throw new Error(shareFailure(content.status));
        text = await content.text();
      }
      if (abort.signal.aborted) return;
      const remaining = Date.parse(result.expiresAt) - Date.now();
      if (remaining <= 0) throw new Error(shareFailure(410));
      setShare({ ...result, contentUrl: contentUrl.href, text });
      expirationTimer = setTimeout(
        () => {
          setShare(undefined);
          setError(shareFailure(410));
        },
        Math.min(remaining, 2_147_483_647),
      );
    })().catch((reason: unknown) => {
      if (!abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : '分享资源加载失败，请重试。');
    });
    return () => {
      abort.abort();
      clearTimeout(expirationTimer);
    };
  }, [token, attempt]);

  /** 媒体在元信息加载后也可能失效；隐藏预览并提供重新验证入口。 */
  const mediaFailed = () => setError('资源内容加载失败或链接已失效，请重新加载。');

  return (
    <main
      className={`public-asset-share${imageExpanded && share && !error ? ' is-image-expanded' : ''}`}
    >
      <header className="public-asset-share-topbar">
        <span className="public-asset-share-brand">
          <img
            src="/brand/lovetv-mascot.webp"
            alt="LoveTV 大肥鱼（鲸鱼娘）"
            width={48}
            height={48}
          />
          <span>
            LoveTV · <span>共享资源</span>
          </span>
        </span>
        <span className="public-asset-share-readonly">只读预览</span>
      </header>
      {error ? (
        <section className="public-asset-share-state" aria-label="分享资源状态">
          <h1>暂时无法查看资源</h1>
          <p role="alert">{error}</p>
          <Button type="button" onClick={() => setAttempt((current) => current + 1)}>
            <RefreshCw size={16} aria-hidden="true" />
            重新加载
          </Button>
        </section>
      ) : !share ? (
        <section className="public-asset-share-state" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          正在读取分享资源…
        </section>
      ) : (
        <>
          <section className="public-asset-share-details">
            <div>
              <h1>{share.asset.name}</h1>
              <p>
                {mediaLabels[share.asset.mediaType]} · 版本 {share.asset.version} · 有效至{' '}
                <time dateTime={share.expiresAt}>
                  {new Date(share.expiresAt).toLocaleString('zh-CN', { hour12: false })}
                </time>
              </p>
            </div>
            <a
              className="public-asset-share-download"
              href={share.contentUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <Download size={16} aria-hidden="true" />
              打开原文件
            </a>
          </section>
          <section
            className={`public-asset-share-content is-${share.asset.mediaType}`}
            aria-label="分享资源内容"
          >
            {share.asset.mediaType === 'image' ? (
              <ImagePreviewStage
                key={share.contentUrl}
                src={share.contentUrl}
                name={share.asset.name}
                expanded={imageExpanded}
                onExpandedChange={setImageExpanded}
                crossOrigin="anonymous"
                referrerPolicy="no-referrer"
                onError={mediaFailed}
              />
            ) : share.asset.mediaType === 'video' || share.asset.mediaType === 'audio' ? (
              <MediaPreviewPlayer
                key={share.contentUrl}
                kind={share.asset.mediaType}
                src={share.contentUrl}
                name={share.asset.name}
                crossOrigin="anonymous"
                onError={mediaFailed}
              />
            ) : (
              <pre>{share.text}</pre>
            )}
          </section>
          <p className="public-asset-share-footer">此链接仅展示分享时选定的资源版本。</p>
        </>
      )}
    </main>
  );
}

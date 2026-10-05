import { assetSchema, type Asset } from '@multimodal-canvas/domain';
import { FileImage, Film, ImageOff, LockKeyhole } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  apiFetch,
  getAuthSessionGeneration,
  readAuthSession,
  subscribeAuthSession,
} from '../auth-client';
import { isApiOriginUrl, resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from '../workspace/contracts';
import {
  getImageThumbnailSource,
  type ImageThumbnailSource,
} from '../workspace/image-thumbnail-cache';
import { useImageThumbnail } from '../workspace/use-image-thumbnail';
import { HomeDemoImage } from './HomeDemoImage';

/** 首页只读取一页近期资源，避免为了装饰画廊遍历当前用户的完整资源库。 */
const HOME_GALLERY_PAGE_SIZE = 48;
/** PC 首页保留四个固定尺寸预览格；空位继续显示占位，不改变页面几何。 */
const HOME_GALLERY_SLOT_COUNT = 4;
/** 每个格子最多准备一张备用预览，悬停或键盘聚焦时切换，不再次请求列表。 */
const HOME_GALLERY_ASSET_LIMIT = HOME_GALLERY_SLOT_COUNT * 2;

/** 首页登录画廊的数据状态；匿名访客只显示公开演示和占位。 */
export type HomeGalleryState = {
  status: 'anonymous' | 'loading' | 'ready' | 'empty' | 'error';
  assets: Asset[];
};

type ResolvedHomeGalleryState = HomeGalleryState & { identity: string };

/** 返回认证代次与不可变用户 ID，换号或退出时让旧画廊在同一帧失效。 */
function homeGallerySessionIdentity(): string {
  return String(getAuthSessionGeneration()) + ':' + (readAuthSession()?.user.id ?? '');
}

/** 适配 useSyncExternalStore 的无参数通知签名，不向 React 暴露会话对象。 */
function subscribeHomeGallerySession(onStoreChange: () => void): () => void {
  return subscribeAuthSession(() => onStoreChange());
}

/**
 * 从当前账户的一页资源中随机选出可用于首页的生成图片和视频。
 * @param assets 当前会话已获授权的资源列表。
 * @param random 随机数来源；测试可传入确定性实现。
 * @returns 最多八个不重复、状态可用且带生成运行来源的媒体资源。
 */
export function selectHomeGalleryAssets(
  assets: readonly Asset[],
  random: () => number = Math.random,
): Asset[] {
  const generated = assets.filter(
    (asset) =>
      asset.status === 'ready' &&
      (asset.mediaType === 'image' || asset.mediaType === 'video') &&
      asset.metadata?.generated === true &&
      typeof asset.metadata?.runId === 'string' &&
      asset.metadata.runId.length > 0,
  );
  for (let index = generated.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [generated[index], generated[target]] = [generated[target]!, generated[index]!];
  }
  return generated.slice(0, HOME_GALLERY_ASSET_LIMIT);
}

/**
 * 读取当前登录用户可见的一页生成媒体，不创建项目、运行或公开分享。
 * 页面卸载、退出和换号会中断请求；身份代次不一致的迟到结果不会进入状态。
 */
export function useHomeGeneratedGallery(): HomeGalleryState {
  const identity = useSyncExternalStore(
    subscribeHomeGallerySession,
    homeGallerySessionIdentity,
    homeGallerySessionIdentity,
  );
  const userId = readAuthSession()?.user.id;
  const [resolved, setResolved] = useState<ResolvedHomeGalleryState>();

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const expectedAuthGeneration = getAuthSessionGeneration();
    const url = new URL(API_BASE_URL + '/v1/assets', window.location.href);
    url.searchParams.set('status', 'ready');
    url.searchParams.set('page', '1');
    url.searchParams.set('pageSize', String(HOME_GALLERY_PAGE_SIZE));

    void apiFetch(url, { signal: controller.signal }, { expectedAuthGeneration })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          assets?: unknown;
          error?: string;
        } | null;
        if (!response.ok)
          throw new Error(payload?.error ?? '资源读取失败（' + response.status + '）');
        const parsed = assetSchema.array().safeParse(payload?.assets);
        if (!parsed.success) throw new Error('资源列表格式无效');
        const assets = selectHomeGalleryAssets(parsed.data);
        if (
          controller.signal.aborted ||
          expectedAuthGeneration !== getAuthSessionGeneration() ||
          readAuthSession()?.user.id !== userId
        )
          return;
        setResolved({
          identity,
          status: assets.length > 0 ? 'ready' : 'empty',
          assets,
        });
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          expectedAuthGeneration !== getAuthSessionGeneration() ||
          readAuthSession()?.user.id !== userId
        )
          return;
        setResolved({ identity, status: 'error', assets: [] });
      });

    return () => controller.abort();
  }, [identity, userId]);

  if (!userId) return { status: 'anonymous', assets: [] };
  if (resolved?.identity !== identity) return { status: 'loading', assets: [] };
  return resolved;
}

/** 视频只读取当前资源的海报衍生图，不为首页下载或解码原始视频。 */
function getVideoPosterSource(asset: Asset): ImageThumbnailSource | null {
  if (asset.mediaType !== 'video' || !asset.contentUrl) return null;
  const original = resolveUploadUrl(asset.contentUrl, API_BASE_URL);
  if (!isApiOriginUrl(original, API_BASE_URL, window.location.href)) return null;
  const parsed = new URL(original, window.location.href);
  const encodedId = encodeURIComponent(asset.id);
  const match = /^\/v1\/assets\/([^/]+)(?:\/versions\/([1-9]\d*))?\/content$/.exec(parsed.pathname);
  if (!match || match[1] !== encodedId) return null;
  const explicitVersion = match[2] ? Number(match[2]) : undefined;
  if (
    explicitVersion !== undefined &&
    (!Number.isSafeInteger(explicitVersion) || explicitVersion < 1)
  )
    return null;
  const revision = asset.sha256 ? '?v=' + asset.sha256 : '';
  return {
    url: resolveUploadUrl(
      '/v1/assets/' + encodedId + '/derivatives/poster' + revision,
      API_BASE_URL,
    ),
    immutable: false,
  };
}

/** 图片复用现有缩略图合同，视频复用同一鉴权缓存读取固定海报。 */
function getHomeGalleryPreviewSource(asset: Asset | null): ImageThumbnailSource | null {
  if (!asset) return null;
  return getImageThumbnailSource(asset) ?? getVideoPosterSource(asset);
}

/** 单层媒体预览；失败和缺失都保持固定尺寸占位，不回退加载原文件。 */
function HomeGalleryPreview({
  asset,
  alternate = false,
}: {
  asset: Asset | null;
  alternate?: boolean;
}) {
  const source = getHomeGalleryPreviewSource(asset);
  const preview = useImageThumbnail(source, 0);
  const [imageFailed, setImageFailed] = useState<string>();
  const failed =
    !asset || !source || !preview.url || !!preview.error || imageFailed === preview.url;
  const className =
    'mc-home-gallery-preview' +
    (alternate ? ' is-alternate' : '') +
    (failed ? ' is-placeholder' : '');

  return (
    <span className={className} aria-hidden="true">
      {!failed && preview.url ? (
        <img src={preview.url} alt="" loading="lazy" onError={() => setImageFailed(preview.url)} />
      ) : (
        <span className="mc-home-gallery-placeholder">
          {asset?.mediaType === 'video' ? <Film size={22} /> : <ImageOff size={22} />}
        </span>
      )}
      {asset?.mediaType === 'video' && (
        <span className="mc-home-gallery-kind">
          <Film size={12} /> VIDEO
        </span>
      )}
    </span>
  );
}

/** 一个预览格在 hover/focus 时显示备用资源，整个生命周期不重新获取资源列表。 */
function HomeGalleryTile({
  primary,
  alternate,
}: {
  primary: Asset | null;
  alternate: Asset | null;
}) {
  const hasAlternate = Boolean(primary && alternate && primary.id !== alternate.id);
  const label = primary
    ? hasAlternate
      ? '生成预览：' + primary.name + '；聚焦显示另一项生成结果'
      : '生成预览：' + primary.name
    : '生成预览占位';
  return (
    <div
      className={'mc-home-gallery-tile' + (hasAlternate ? ' has-alternate' : '')}
      role="img"
      aria-label={label}
      tabIndex={hasAlternate ? 0 : undefined}
    >
      <HomeGalleryPreview asset={primary} />
      {hasAlternate && <HomeGalleryPreview asset={alternate} alternate />}
    </div>
  );
}

/** 登录用户显示本人可见的生成缩略图；匿名和失败状态只展示公开演示或占位。 */
export function HomeGallery({ state }: { state: HomeGalleryState }) {
  const primary = state.assets.slice(0, HOME_GALLERY_SLOT_COUNT);
  const alternates = state.assets.slice(HOME_GALLERY_SLOT_COUNT);
  const slots = Array.from({ length: HOME_GALLERY_SLOT_COUNT }, (_, index) => ({
    primary: primary[index] ?? null,
    alternate:
      alternates[index] ??
      (primary.length > 1 ? (primary[(index + 1) % primary.length] ?? null) : null),
  }));
  const publicOnly = state.status !== 'ready';
  const statusCopy = {
    anonymous: '登录后可显示你自己的生成缩略图',
    loading: '正在读取当前账户的生成缩略图',
    ready: '仅限当前账户可见 · 悬停或聚焦切换',
    empty: '当前账户还没有可展示的图片或视频结果',
    error: '生成缩略图暂时不可用，已保留固定占位',
  }[state.status];

  return (
    <div className="mc-home-gallery" aria-label="LoveTV 生成作品预览">
      <header>
        <span>
          {publicOnly ? (
            <LockKeyhole size={15} aria-hidden="true" />
          ) : (
            <FileImage size={15} aria-hidden="true" />
          )}
          {publicOnly ? '公开演示与私有占位' : '你的生成结果'}
        </span>
        <small>{statusCopy}</small>
      </header>
      <div className="mc-home-gallery-grid">
        {state.status === 'anonymous' ? (
          <div
            className="mc-home-gallery-tile is-public"
            role="img"
            aria-label="公开自然观察演示画面"
          >
            <HomeDemoImage alt="" />
          </div>
        ) : null}
        {slots.slice(state.status === 'anonymous' ? 1 : 0).map((slot, index) => (
          <HomeGalleryTile key={(slot.primary?.id ?? 'placeholder') + '-' + index} {...slot} />
        ))}
      </div>
    </div>
  );
}

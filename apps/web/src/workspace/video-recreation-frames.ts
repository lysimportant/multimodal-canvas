import {
  apiFetch,
  getAuthSessionGeneration,
  readAuthSession,
  subscribeAuthSession,
} from '../auth-client';
import { API_BASE_URL } from './contracts';

/** 原视频的冻结资源版本；不接受外部 URL 或隐式最新版。 */
export type VideoRecreationPreviewSource = { assetId: string; assetVersion: number };

/** 原视频中的人物或商品定位；坐标相对于完整画面，取值为 0..1。 */
export type VideoRecreationPreviewItem = {
  id: string;
  label: string;
  preview?: {
    timestampSeconds: number;
    boundingBox?: { x: number; y: number; width: number; height: number };
  };
  appearances?: readonly { startSeconds: number; endSeconds: number }[];
};

/** 仅供当前界面展示的截帧状态；Blob URL 不能保存到画布或分析模板。 */
export type VideoRecreationPreviewState =
  | { status: 'loading' }
  | { status: 'missing'; error: string }
  | { status: 'error'; error: string }
  | {
      status: 'ready';
      url: string;
      timestampSeconds: number;
      cropped: boolean;
      location: 'preview' | 'appearance';
    };

/** 一次共享视频读取与串行截帧；释放后取消请求并撤销全部临时图片。 */
export type VideoRecreationFrameBatch = {
  promise: Promise<ReadonlyMap<string, VideoRecreationPreviewState>>;
  release: () => void;
};

/** 缩略画面最长边上限，限制画布像素和输出图片的内存占用。 */
const FRAME_MAX_EDGE = 480;
/** 视频下载包含响应正文；超时只结束本地预览，不重发请求。 */
const VIDEO_READ_TIMEOUT_MS = 60_000;
/** 解码、定位或图片编码迟迟不返回时允许用户显式重试。 */
const FRAME_TIMEOUT_MS = 10_000;
const VIDEO_CACHE_PREFIX = 'multimodal-canvas:video:v1:';
export const MAX_CACHED_VIDEO_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_VIDEOS = 2;
const memoryVideoCache = new Map<string, Blob>();
const backgroundVideoDownloads = new Map<string, AbortController>();
let cacheGeneration = getAuthSessionGeneration();
let cacheSessionListener: (() => void) | undefined;

async function cleanVideoCaches(currentName?: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(VIDEO_CACHE_PREFIX) && name !== currentName)
        .map((name) => caches.delete(name)),
    );
  } catch {
    // 浏览器限制存储时仍可继续使用网络预览。
  }
}

function currentVideoCacheName(): string | undefined {
  const userId = readAuthSession()?.user.id;
  const name = userId ? `${VIDEO_CACHE_PREFIX}${encodeURIComponent(userId)}` : undefined;
  if (!cacheSessionListener)
    cacheSessionListener = subscribeAuthSession(() => {
      if (cacheGeneration !== getAuthSessionGeneration()) {
        cacheGeneration = getAuthSessionGeneration();
        for (const controller of backgroundVideoDownloads.values()) controller.abort();
        backgroundVideoDownloads.clear();
        memoryVideoCache.clear();
        void cleanVideoCaches(currentVideoCacheName());
      }
    });
  if (cacheGeneration !== getAuthSessionGeneration()) {
    cacheGeneration = getAuthSessionGeneration();
    for (const controller of backgroundVideoDownloads.values()) controller.abort();
    backgroundVideoDownloads.clear();
    memoryVideoCache.clear();
  }
  void cleanVideoCaches(name);
  return name;
}

async function readCachedVideo(url: string, signal: AbortSignal): Promise<Blob | undefined> {
  const name = currentVideoCacheName();
  if (!name) return undefined;
  const memory = memoryVideoCache.get(url);
  if (memory) return memory;
  if (typeof caches === 'undefined') return undefined;
  try {
    const response = await caches.open(name).then((cache) => cache.match(url));
    if (!response) return undefined;
    const blob = await withAbort(response.blob(), signal);
    if (!blob.size) return undefined;
    rememberVideo(url, blob);
    return blob;
  } catch {
    return undefined;
  }
}

function rememberVideo(url: string, blob: Blob): void {
  if (blob.size > MAX_CACHED_VIDEO_BYTES || !blob.size) return;
  memoryVideoCache.delete(url);
  memoryVideoCache.set(url, blob);
  while (memoryVideoCache.size > MAX_CACHED_VIDEOS)
    memoryVideoCache.delete(memoryVideoCache.keys().next().value!);
}

async function cacheVideo(url: string, blob: Blob, generation: number): Promise<void> {
  if (blob.size > MAX_CACHED_VIDEO_BYTES || !blob.size) return;
  const name = currentVideoCacheName();
  if (!name || typeof caches === 'undefined' || generation !== getAuthSessionGeneration()) return;
  try {
    const cache = await caches.open(name);
    if (generation !== getAuthSessionGeneration()) return;
    await cache.put(
      url,
      new Response(blob, {
        headers: { 'content-type': blob.type || 'application/octet-stream' },
      }),
    );
    if (generation !== getAuthSessionGeneration()) {
      await caches.delete(name);
      return;
    }
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, -MAX_CACHED_VIDEOS).map((key) => cache.delete(key)));
  } catch {
    // 缓存失败不影响当前预览。
  }
}

function videoCacheKey(source: VideoRecreationPreviewSource): string {
  return `${API_BASE_URL}/v1/assets/${encodeURIComponent(source.assetId)}/versions/${source.assetVersion}/content`;
}

/** 仅读取本地冻结版本；命中时重新验证当前账户的读取权限。 */
export async function loadCachedFrozenVideo(
  source: VideoRecreationPreviewSource,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const generation = getAuthSessionGeneration();
  const contentUrl = videoCacheKey(source);
  const blob = await readCachedVideo(contentUrl, signal);
  signal.throwIfAborted();
  if (!blob) return undefined;
  const validation = await withAbort(
    apiFetch(
      contentUrl,
      { method: 'HEAD', signal, cache: 'no-store' },
      { expectedAuthGeneration: generation },
    ),
    signal,
  );
  if (!validation.ok) throw new Error(`原视频读取失败（${validation.status}），请重试`);
  return blob;
}

/** 同一冻结版本的原视频先读当前账户本地缓存，未命中才下载一次。 */
export async function loadFrozenVideo(
  source: VideoRecreationPreviewSource,
  signal: AbortSignal,
  maxBytes?: number,
): Promise<Blob> {
  const cached = await loadCachedFrozenVideo(source, signal);
  if (cached) return cached;
  const generation = getAuthSessionGeneration();
  const contentUrl = videoCacheKey(source);
  const response = await withAbort(
    apiFetch(contentUrl, { signal, cache: 'no-store' }, { expectedAuthGeneration: generation }),
    signal,
  );
  if (!response.ok) throw new Error(`原视频读取失败（${response.status}），请重试`);
  const declaredBytes = Number(response.headers.get('content-length'));
  if (maxBytes && Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
    throw new Error('视频超过本地缓存上限');
  const blob = await withAbort(response.blob(), signal);
  signal.throwIfAborted();
  if (maxBytes && blob.size > maxBytes) throw new Error('视频超过本地缓存上限');
  if (generation === getAuthSessionGeneration() && readAuthSession()) {
    rememberVideo(contentUrl, blob);
    void cacheVideo(contentUrl, blob, generation);
  }
  if (!blob.size) throw new Error('原视频内容为空，无法截取画面');
  return blob;
}

/** 首次预览先用浏览器播放；元数据就绪后独立下载并保存，以便关闭后再次打开。 */
export function warmFrozenVideoCache(
  source: VideoRecreationPreviewSource,
  knownSizeBytes = 0,
): void {
  if (!readAuthSession()) return;
  currentVideoCacheName();
  const key = videoCacheKey(source);
  if (backgroundVideoDownloads.has(key)) return;
  const controller = new AbortController();
  backgroundVideoDownloads.set(key, controller);
  const timer = setTimeout(() => controller.abort(), VIDEO_READ_TIMEOUT_MS);
  const generation = getAuthSessionGeneration();
  const download = async () => {
    if (knownSizeBytes > MAX_CACHED_VIDEO_BYTES) return;
    if (!knownSizeBytes) {
      const head = await apiFetch(
        key,
        { method: 'HEAD', signal: controller.signal, cache: 'no-store' },
        { expectedAuthGeneration: generation },
      );
      const sizeBytes = Number(head.headers.get('content-length'));
      if (!head.ok || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return;
      if (sizeBytes > MAX_CACHED_VIDEO_BYTES) return;
    }
    await loadFrozenVideo(source, controller.signal, MAX_CACHED_VIDEO_BYTES);
  };
  void download()
    .catch(() => {
      // 后台缓存失败不影响当前正在播放的视频。
    })
    .finally(() => {
      clearTimeout(timer);
      if (backgroundVideoDownloads.get(key) === controller) backgroundVideoDownloads.delete(key);
    });
}

/** 校验定位，不用任意首帧冒充没有画面证据的识别对象。 */
function resolveLocation(item: VideoRecreationPreviewItem):
  | {
      timestampSeconds: number;
      boundingBox?: NonNullable<VideoRecreationPreviewItem['preview']>['boundingBox'];
      location: 'preview' | 'appearance';
    }
  | Extract<VideoRecreationPreviewState, { status: 'missing' | 'error' }> {
  const timestampSeconds = item.preview?.timestampSeconds ?? item.appearances?.[0]?.startSeconds;
  if (timestampSeconds === undefined) return { status: 'missing', error: '分析未提供画面定位' };
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0)
    return { status: 'error', error: '画面时间点无效，请检查分析结果' };
  const boundingBox = item.preview?.boundingBox;
  if (
    boundingBox &&
    (!Object.values(boundingBox).every(Number.isFinite) ||
      boundingBox.x < 0 ||
      boundingBox.y < 0 ||
      boundingBox.width <= 0 ||
      boundingBox.height <= 0 ||
      boundingBox.x + boundingBox.width > 1 ||
      boundingBox.y + boundingBox.height > 1)
  )
    return { status: 'error', error: '画面裁剪范围无效，请检查分析结果' };
  return {
    timestampSeconds,
    ...(boundingBox ? { boundingBox } : {}),
    location: item.preview ? 'preview' : 'appearance',
  };
}

/** 创建加载占位或缺少定位的提示；不读取资源、不修改分析结果。 */
export function initialVideoRecreationPreviews(
  items: readonly VideoRecreationPreviewItem[],
): ReadonlyMap<string, VideoRecreationPreviewState> {
  return new Map(
    items.map((item) => {
      const location = resolveLocation(item);
      return [item.id, 'status' in location ? location : { status: 'loading' }];
    }),
  );
}

/** 等待可取消的异步操作；即使底层正文或编码迟到也不能继续发布图片。 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason ?? new DOMException('截图已取消', 'AbortError'));
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancelled));
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
  });
}

/** 浏览器媒体错误转为可展示说明，不把私有资源地址或响应正文带入界面。 */
function videoDecodeError(video: HTMLVideoElement): Error {
  return new Error(
    video.error?.code === 2
      ? '原视频读取失败，请重试'
      : '浏览器无法解码原视频，格式或编码可能不支持，请确认后重试',
  );
}

/** 在触发加载或 seek 之前注册事件，避免同步事件遗漏；始终移除监听和计时器。 */
function waitForVideo(
  video: HTMLVideoElement,
  events: readonly string[],
  ready: () => boolean,
  signal: AbortSignal,
  timeoutMessage: string,
  start: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      events.forEach((event) => video.removeEventListener(event, check));
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
    };
    const finish = (error?: unknown) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (ready()) finish();
    };
    const failed = () => finish(videoDecodeError(video));
    const cancelled = () => finish(signal.reason ?? new DOMException('截图已取消', 'AbortError'));
    if (signal.aborted) {
      cancelled();
      return;
    }
    events.forEach((event) => video.addEventListener(event, check));
    video.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => finish(new Error(timeoutMessage)), FRAME_TIMEOUT_MS);
    try {
      start();
      if (video.error) failed();
      else check();
    } catch (error) {
      finish(error);
    }
  });
}

/** 将已解码画面按归一化区域绘制为小图；只在编码成功后创建图片 URL。 */
async function encodeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  boundingBox: NonNullable<VideoRecreationPreviewItem['preview']>['boundingBox'],
  signal: AbortSignal,
): Promise<Blob> {
  const x = (boundingBox?.x ?? 0) * video.videoWidth;
  const y = (boundingBox?.y ?? 0) * video.videoHeight;
  const width = (boundingBox?.width ?? 1) * video.videoWidth;
  const height = (boundingBox?.height ?? 1) * video.videoHeight;
  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持画面截图，请更换浏览器后重试');
  context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
  const encoding = new AbortController();
  const timer = setTimeout(
    () => encoding.abort(new Error('画面截图编码超时，请重试')),
    FRAME_TIMEOUT_MS,
  );
  try {
    return await withAbort(
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob?.size) resolve(blob);
            else reject(new Error('画面截图失败，请重试'));
          },
          'image/jpeg',
          0.82,
        );
      }),
      AbortSignal.any([signal, encoding.signal]),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过鉴权 GET 读取冻结视频，用同一解码器串行提取人物和商品的原始画面。
 * @param source 精确资产版本；版本无效时返回错误，不读取最新版或外部地址。
 * @param items 角色与商品合并列表，id 须唯一；无 preview 时仅使用首次出现时间。
 * @param options 可取消信号与逐项结果回调；账户切换、取消和释放后不接纳迟到结果。
 * @returns 共享结果及幂等释放函数；调用方持有结果期间须保留 batch，卸载时释放。
 * @throws 取消或账户切换时 promise 拒绝；下载、解码和定位失败转换为各项错误。
 */
export function createVideoRecreationFrameBatch(
  source: VideoRecreationPreviewSource,
  items: readonly VideoRecreationPreviewItem[],
  options: {
    signal?: AbortSignal;
    onResult?: (id: string, state: VideoRecreationPreviewState) => void;
  } = {},
): VideoRecreationFrameBatch {
  const controller = new AbortController();
  const generation = getAuthSessionGeneration();
  const results = new Map(initialVideoRecreationPreviews(items));
  const imageUrls = new Set<string>();
  let video: HTMLVideoElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let videoUrl: string | undefined;
  let released = false;
  let unsubscribe = () => {};

  /** 解码器和原视频只为本次截帧保留，输出图片由 release 单独释放。 */
  const releaseVideo = () => {
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video = undefined;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = undefined;
    if (canvas) canvas.width = canvas.height = 0;
    canvas = undefined;
  };
  /** 先取消异步操作，再撤销当前界面的图片和解码资源。 */
  const release = () => {
    if (released) return;
    released = true;
    controller.abort(new DOMException('截图已取消', 'AbortError'));
    options.signal?.removeEventListener('abort', release);
    unsubscribe();
    releaseVideo();
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    imageUrls.clear();
  };
  unsubscribe = subscribeAuthSession(() => {
    if (generation !== getAuthSessionGeneration()) release();
  });
  options.signal?.addEventListener('abort', release, { once: true });
  if (options.signal?.aborted) release();

  /** 只发布仍属于当前账户和本次来源的结果。 */
  const publish = (id: string, state: VideoRecreationPreviewState) => {
    controller.signal.throwIfAborted();
    if (generation !== getAuthSessionGeneration())
      throw new DOMException('账户已改变，截图已取消', 'AbortError');
    results.set(id, state);
    options.onResult?.(id, state);
  };

  const promise = (async () => {
    try {
      // StrictMode 同步释放再挂载时，前一次尚未发送 GET 就能取消。
      await Promise.resolve();
      controller.signal.throwIfAborted();
      const located = items.filter((item) => results.get(item.id)?.status === 'loading');
      if (!located.length) return results;
      if (
        !source.assetId.trim() ||
        !Number.isSafeInteger(source.assetVersion) ||
        source.assetVersion < 1
      )
        throw new Error('原视频缺少有效的冻结版本，请重新选择来源');
      const downloading = new AbortController();
      const downloadSignal = AbortSignal.any([controller.signal, downloading.signal]);
      const timer = setTimeout(
        () => downloading.abort(new Error('原视频读取超时，请重试')),
        VIDEO_READ_TIMEOUT_MS,
      );
      let blob: Blob;
      try {
        blob = await loadFrozenVideo(source, downloadSignal);
        controller.signal.throwIfAborted();
      } finally {
        clearTimeout(timer);
      }
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      canvas = document.createElement('canvas');
      videoUrl = URL.createObjectURL(blob);
      const decoder = video;
      await waitForVideo(
        decoder,
        ['loadeddata', 'canplay'],
        () => decoder.readyState >= 2 && decoder.videoWidth > 0 && decoder.videoHeight > 0,
        controller.signal,
        '原视频解码超时，格式或编码可能不支持，请确认后重试',
        () => {
          decoder.src = videoUrl!;
          decoder.load();
        },
      );
      if (!Number.isFinite(decoder.duration) || decoder.duration <= 0)
        throw new Error('原视频时长无法读取，无法定位画面');
      for (const item of located) {
        controller.signal.throwIfAborted();
        const location = resolveLocation(item);
        if ('status' in location) continue;
        try {
          if (location.timestampSeconds >= decoder.duration)
            throw new Error('画面时间点超出原视频时长，请检查分析结果');
          if (decoder.currentTime !== location.timestampSeconds || decoder.seeking)
            await waitForVideo(
              decoder,
              ['seeked', 'loadeddata'],
              () =>
                !decoder.seeking &&
                decoder.readyState >= 2 &&
                Math.abs(decoder.currentTime - location.timestampSeconds) < 0.01,
              controller.signal,
              '原视频画面定位超时，请重试',
              () => {
                decoder.currentTime = location.timestampSeconds;
              },
            );
          const frame = await encodeFrame(decoder, canvas, location.boundingBox, controller.signal);
          controller.signal.throwIfAborted();
          const url = URL.createObjectURL(frame);
          imageUrls.add(url);
          publish(item.id, {
            status: 'ready',
            url,
            timestampSeconds: location.timestampSeconds,
            cropped: !!location.boundingBox,
            location: location.location,
          });
        } catch (error) {
          controller.signal.throwIfAborted();
          publish(item.id, {
            status: 'error',
            error: error instanceof Error ? error.message : '原视频截图失败，请重试',
          });
        }
      }
      return results;
    } catch (error) {
      controller.signal.throwIfAborted();
      for (const [id, state] of results)
        if (state.status === 'loading')
          publish(id, {
            status: 'error',
            error: error instanceof Error ? error.message : '原视频截图失败，请重试',
          });
      return results;
    } finally {
      releaseVideo();
    }
  })();
  return { promise, release };
}

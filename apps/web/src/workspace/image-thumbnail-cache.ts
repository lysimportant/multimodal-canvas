import type { Asset } from '@multimodal-canvas/domain';
import { apiFetch, getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import { isApiOriginUrl, resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from './contracts';

/** 小预览源；版本路径可长期复用，未标明版本的旧资源只作短期缓存。 */
export type ImageThumbnailSource = { url: string; immutable: boolean };
/** 展示图地址和已验证的原图像素；缺少元数据时不能以缩略图尺寸冒充原图。 */
export type ImageThumbnail = { url: string; originalWidth?: number; originalHeight?: number };
/** 引用期间保留 Blob URL；组件卸载后释放引用，由缓存决定回收时机。 */
export type ImageThumbnailLease = { promise: Promise<ImageThumbnail>; release: () => void };
/** 单标签页缓存限制；正在显示的图片不强制回收，闲置条目按最近使用顺序淘汰。 */
const MAX_IDLE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
/** 限制初次进入大项目时的请求/转码洪峰；队列只保留仍有消费者的任务。 */
const MAX_REQUESTS = 4;
let activeRequests = 0;
const waitingRequests: Array<() => void> = [];

/** 排队占用一个请求槽；排队期间取消立即移除，完成后唤醒下一项。 */
function acquireRequestSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = waitingRequests.indexOf(start);
      if (index >= 0) waitingRequests.splice(index, 1);
      reject(new DOMException('缩略图请求已取消', 'AbortError'));
    };
    const start = () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) {
        cancel();
        return;
      }
      activeRequests++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeRequests--;
        waitingRequests.shift()?.();
      });
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    if (activeRequests < MAX_REQUESTS) start();
    else {
      waitingRequests.push(start);
      signal.addEventListener('abort', cancel, { once: true });
    }
  });
}
/** 单个缩略图请求、引用和对象 URL 的生命周期。 */
type CacheEntry = {
  promise: Promise<ImageThumbnail>;
  abort: AbortController;
  refs: number;
  bytes: number;
  objectUrl?: string;
  expiresAt: number;
  usedAt: number;
};
/** 包括 TTL 替换后仍被组件引用的旧条目；退出账户必须撤销所有 URL。 */
const liveEntries = new Set<CacheEntry>();
const cache = new Map<string, CacheEntry>();
let generation = getAuthSessionGeneration();
let unsubscribeAuth: (() => void) | undefined;

/**
 * 仅应用内图片原文件可派生缩略图；外部 URL、data/blob 和显式衍生图保持原行为。
 * @returns 同一资产版本的统一地址；不支持的来源返回 null，不把凭据写入缓存键。
 */
export function getImageThumbnailSource(asset: Asset): ImageThumbnailSource | null {
  if (asset.mediaType !== 'image' || !asset.contentUrl) return null;
  const original = resolveUploadUrl(asset.contentUrl, API_BASE_URL);
  if (!isApiOriginUrl(original, API_BASE_URL, window.location.href)) return null;
  const parsed = new URL(original, window.location.href);
  const basePath = `/v1/assets/${encodeURIComponent(asset.id)}`;
  const match = /^\/v1\/assets\/([^/]+)(?:\/versions\/([1-9]\d*))?\/content$/.exec(parsed.pathname);
  if (!match || match[1] !== encodeURIComponent(asset.id)) return null;
  const version = match[2] ? Number(match[2]) : asset.latestVersion;
  if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return null;
  const path = version
    ? `${basePath}/versions/${version}/derivatives/thumbnail`
    : `${basePath}/derivatives/thumbnail`;
  const revision = !version && asset.sha256 ? `?v=${asset.sha256}` : '';
  return { url: resolveUploadUrl(`${path}${revision}`, API_BASE_URL), immutable: !!version };
}

/**
 * 将资源索引已知的图片版本固定为原文件地址，保证小图、Dialog 和下载读取同一版本。
 * 显式版本、外部地址和无版本的旧资源不改写；返回只读副本，不更新持久化资产。
 */
export function resolveOriginalImageAsset(asset: Asset): Asset {
  const source = getImageThumbnailSource(asset);
  if (!source?.immutable || /\/versions\/[1-9]\d*\/content(?:$|\?)/.test(asset.contentUrl))
    return asset;
  return { ...asset, contentUrl: source.url.replace(/\/derivatives\/thumbnail$/, '/content') };
}

/** 回收 URL 和未完成的网络请求；引用计数由持有者负责，不修改资产数据。 */
function dispose(entry: CacheEntry): void {
  liveEntries.delete(entry);
  entry.abort.abort();
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = undefined;
}

/** 退出或切换账户立即清空，迟到的旧账户响应不得进入新缓存。 */
export function clearImageThumbnailCache(): void {
  for (const entry of liveEntries) dispose(entry);
  cache.clear();
  generation = getAuthSessionGeneration();
}

/** 淘汰过期和超过容量的闲置缓存；不撤销组件正在使用的 URL。 */
function prune(): void {
  let bytes = [...liveEntries].reduce((sum, entry) => sum + entry.bytes, 0);
  const idle = [...cache.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key, entry] of idle) {
    if (entry.expiresAt > Date.now() && cache.size <= MAX_ENTRIES && bytes <= MAX_IDLE_BYTES)
      continue;
    bytes -= entry.bytes;
    cache.delete(key);
    dispose(entry);
  }
}

/** 可取消等待；同一槽位退避，防止服务端繁忙时把后续图片逐项打成失败。 */
function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('缩略图请求已取消', 'AbortError'));
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException('缩略图请求已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** 只重试明确的转码繁忙 GET，最多六次；其他失败保持原错误，不重试原文件或供应商请求。 */
async function fetchThumbnail(
  source: ImageThumbnailSource,
  retry: number,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await apiFetch(source.url, {
      signal,
      cache: retry > 0 ? 'reload' : source.immutable ? 'default' : 'no-cache',
    });
    if (response.status !== 503 || attempt >= 6) return response;
    const error = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (error?.code !== 'thumbnail_busy') return response;
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 1;
    const delay = Math.min(5000, Math.max(seconds * 1000, 500 * 2 ** attempt));
    await waitForRetry(delay, signal);
  }
}

/** 读取原图尺寸头，未知或无效值保持缺失。 */
function readDimension(response: Response, name: string): number | undefined {
  const value = Number(response.headers.get(name));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 合并同账户、同版本、同重试代次的请求，使用 Blob URL 让节点和资源栏复用展示图。
 * @param source 经过来源检查的缩略图地址。
 * @param retry 用户重试代次；避开损坏的浏览器响应和旧 Blob。
 * @returns 请求及幂等释放函数；失败不进入缓存，后续调用可重新请求。
 * @throws HTTP 失败、非图片、空内容、超限内容或账户切换时请求拒绝；不降级加载原图。
 */
export function acquireImageThumbnail(
  source: ImageThumbnailSource,
  retry = 0,
): ImageThumbnailLease {
  if (!unsubscribeAuth)
    unsubscribeAuth = subscribeAuthSession(() => {
      if (generation !== getAuthSessionGeneration()) clearImageThumbnailCache();
    });
  if (generation !== getAuthSessionGeneration()) clearImageThumbnailCache();
  const key = `${source.url}:${retry}`;
  let entry = cache.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    cache.delete(key);
    if (entry.refs === 0) dispose(entry);
    entry = undefined;
  }
  if (!entry) {
    const currentGeneration = generation;
    const next: CacheEntry = {
      abort: new AbortController(),
      refs: 0,
      bytes: 0,
      usedAt: Date.now(),
      expiresAt: Infinity,
      promise: Promise.resolve({ url: '' }),
    };
    liveEntries.add(next);
    next.promise = (async () => {
      const releaseSlot = await acquireRequestSlot(next.abort.signal);
      try {
        const response = await fetchThumbnail(source, retry, next.abort.signal);
        if (!response.ok) throw new Error(`缩略图读取失败（${response.status}），原文件未受影响`);
        const blob = await response.blob();
        if (!blob.type.startsWith('image/') || blob.size === 0 || blob.size > MAX_THUMBNAIL_BYTES)
          throw new Error('缩略图内容无效，请重试；原文件未受影响');
        if (next.abort.signal.aborted || currentGeneration !== getAuthSessionGeneration())
          throw new DOMException('缩略图请求已取消', 'AbortError');
        next.objectUrl = URL.createObjectURL(blob);
        next.bytes = blob.size;
        next.expiresAt = Date.now() + (source.immutable ? 10 * 60_000 : 30_000);
        prune();
        return {
          url: next.objectUrl,
          originalWidth: readDimension(response, 'x-original-width'),
          originalHeight: readDimension(response, 'x-original-height'),
        };
      } finally {
        releaseSlot();
      }
    })().catch((error: unknown) => {
      if (cache.get(key) === next) cache.delete(key);
      dispose(next);
      throw error;
    });
    cache.set(key, next);
    entry = next;
  }
  const current = entry;
  current.refs++;
  current.usedAt = Date.now();
  prune();
  let released = false;
  return {
    promise: current.promise,
    release: () => {
      if (released) return;
      released = true;
      current.refs--;
      current.usedAt = Date.now();
      if (current.refs === 0 && cache.get(key) !== current) dispose(current);
      else if (current.refs === 0 && !current.objectUrl) {
        // 严格模式会立即重新挂载；微任务内复核引用，避免取消共享请求。
        queueMicrotask(() => {
          if (current.refs !== 0 || current.objectUrl) return;
          if (cache.get(key) === current) cache.delete(key);
          dispose(current);
        });
      }
      prune();
    },
  };
}

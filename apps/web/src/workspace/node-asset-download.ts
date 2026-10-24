import type { Asset } from '@multimodal-canvas/domain';
import { apiFetch } from '../auth-client';
import {
  filenameFromContentDisposition,
  sanitizeDownloadFilename,
  type ProjectExportDownload,
} from '../export-utils';
import { isApiOriginUrl, resolveUploadUrl } from '../upload-utils';
import { API_BASE_URL } from './contracts';
import { resolveOriginalImageAsset } from './image-thumbnail-cache';

/** 常见图片、视频 MIME 对应扩展名，用于没有后缀的节点名称。 */
const mediaExtensions: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
};

/**
 * 下载节点当前回显的资产或版本，复用 API 会话认证与已有文件名处理。
 * 仅 API 同源地址接收 Bearer；CDN、data 和 blob 地址不携带认证信息。
 * @param inputAsset 当前回显资产；contentUrl 已指向来源、手动替换或指定结果版本。
 * @param signal 节点切换或卸载时取消请求。
 * @returns 文件内容与安全文件名，交由已有浏览器下载工具保存。
 * @throws 地址无效、网络失败、HTTP 失败、内容为空或请求取消时拒绝。
 */
export async function fetchNodeAssetDownload(
  inputAsset: Asset,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<ProjectExportDownload> {
  const asset = resolveOriginalImageAsset(inputAsset);
  if (!asset.contentUrl) throw new Error('暂无可下载内容');
  const contentUrl = resolveUploadUrl(asset.contentUrl, API_BASE_URL);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(contentUrl, window.location.href);
  } catch {
    throw new Error('下载地址无效');
  }
  if (
    !['http:', 'https:', 'data:', 'blob:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error('下载地址无效');
  }

  const apiContent = isApiOriginUrl(contentUrl, API_BASE_URL, window.location.href);
  let response: Response;
  try {
    response = apiContent
      ? await apiFetch(contentUrl, { cache: 'no-store', signal })
      : await fetch(contentUrl, {
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal,
        });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error('下载失败，请检查网络或资源跨域权限后重试', { cause });
  }
  if (!response.ok) throw new Error(`下载失败（${response.status}），请重试`);
  const blob =
    maxBytes === undefined
      ? await response.blob()
      : await readLimitedDownload(response, maxBytes, signal);
  if (blob.size === 0) throw new Error('下载内容为空，请重试');
  const extension =
    mediaExtensions[blob.type.split(';')[0].toLowerCase()] ??
    mediaExtensions[asset.mimeType.split(';')[0].toLowerCase()];
  const fallbackName = sanitizeDownloadFilename(
    asset.name,
    asset.mediaType === 'video' ? '视频' : '图片',
  );
  const filename =
    extension && !/\.[a-z\d]{2,8}$/i.test(fallbackName)
      ? `${fallbackName}.${extension}`
      : fallbackName;
  return {
    blob,
    filename: filenameFromContentDisposition(response.headers.get('content-disposition'), filename),
  };
}

/** 压缩入口限制下载内存；普通原文件下载保持原行为。 */
async function readLimitedDownload(response: Response, maxBytes: number, signal?: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取文件内容');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('图片过大，当前支持不超过 32 MB 的文件');
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('图片过大，当前支持不超过 32 MB 的文件');
      parts.push(new Uint8Array(value));
    }
    return new Blob(parts, { type: response.headers.get('content-type') ?? '' });
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

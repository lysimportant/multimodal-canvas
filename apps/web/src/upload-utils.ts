export type UploadMetadata = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

/** 单文件限制；在读取文件和计算摘要之前校验，避免大文件占用浏览器内存。 */
export const MAX_UPLOAD_SIZE_BYTES = 512 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function assertUploadSize(file: Pick<File, 'name' | 'size'>) {
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error(`${file.name} 超过单文件 512 MB 上传上限，请选择更小的文件`);
  }
}

/** 上传会话过期、传输超时和大小限制统一为可执行的中文提醒。 */
export function uploadFailureMessage(name: string, status: number, error?: string) {
  if (status === 413 || error === 'upload_too_large') {
    return `${name} 超过单文件 512 MB 上传上限，请选择更小的文件`;
  }
  if (status === 410 || error === 'upload_expired' || error === 'upload_session_expired') {
    return `${name} 上传会话已过期，请重新选择文件上传`;
  }
  if (status === 408 || status === 504) return `${name} 上传超时，请检查网络后重试`;
  if (status === 401) return '登录状态已过期，请重新登录后上传';
  return error ?? `${name} 上传失败（${status}）`;
}

export async function sha256Hex(content: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildUploadInitPayload(metadata: UploadMetadata) {
  return { ...metadata };
}

export function buildUploadCompletePayload(uploadId: string, metadata: UploadMetadata) {
  return { uploadId, ...metadata };
}

export function resolveUploadUrl(url: string, apiBaseUrl: string): string {
  // Generated previews may be returned as data/blob URLs; only API-relative
  // paths should be prefixed with the server origin.
  if (/^(?:https?:|data:|blob:)/i.test(url)) return url;
  return `${apiBaseUrl}${url}`;
}

/**
 * 把配置的 API 基址解析成绝对地址。
 * 空基址表示与当前页面同源；不能用 `new URL('', href)`，否则会变成当前路径。
 */
export function resolveApiBaseUrl(apiBaseUrl: string, currentHref: string): URL {
  const origin = new URL('/', currentHref).origin;
  return new URL(apiBaseUrl || origin, currentHref);
}

/**
 * 判断资源地址是否属于当前 API 源，用于决定是否附加鉴权头。
 *
 * @param value 媒体或文本结果地址，可以是相对路径。
 * @param apiBaseUrl 前端配置的 API 根；空字符串表示同源反向代理。
 * @param currentHref 当前页面地址，作为相对路径解析基准。
 * @returns 属于 API 源时为 true，CDN/data/blob 为 false。
 */
export function isApiOriginUrl(value: string, apiBaseUrl: string, currentHref: string): boolean {
  try {
    const apiUrl = resolveApiBaseUrl(apiBaseUrl, currentHref);
    const resultUrl = new URL(value, currentHref);
    const apiPath = apiUrl.pathname.replace(/\/$/, '');
    return (
      resultUrl.origin === apiUrl.origin &&
      (!apiPath || apiPath === '/' || resultUrl.pathname.startsWith(apiPath))
    );
  } catch {
    return false;
  }
}

export function resolveCompleteUrl(url: string, apiBaseUrl: string): string {
  return `${apiBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

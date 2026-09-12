export type UploadMetadata = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

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

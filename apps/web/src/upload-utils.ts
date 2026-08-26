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

export function resolveCompleteUrl(url: string, apiBaseUrl: string): string {
  return `${apiBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

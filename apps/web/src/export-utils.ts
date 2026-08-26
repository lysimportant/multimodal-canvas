export type ProjectExportKind = 'workflow' | 'results';

export type ProjectExportDownload = {
  blob: Blob;
  filename: string;
};

export type ExportFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DownloadUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

export type DownloadDocument = Pick<Document, 'createElement' | 'body' | 'documentElement'>;

export type DownloadEnvironment = {
  documentRef?: DownloadDocument;
  urlApi?: DownloadUrlApi;
  schedule?: (callback: () => void) => unknown;
};

/** Builds an export URL without allowing a project id to alter the path. */
export function buildProjectExportUrl(
  apiBaseUrl: string,
  projectId: string,
  kind: ProjectExportKind,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/export/${kind}`;
}

/** Fetches a project export and preserves the server-provided attachment name. */
export async function fetchProjectExport(
  apiBaseUrl: string,
  projectId: string,
  kind: ProjectExportKind,
  fetcher: ExportFetcher = fetch,
): Promise<ProjectExportDownload> {
  const response = await fetcher(buildProjectExportUrl(apiBaseUrl, projectId, kind), {
    cache: 'no-store',
    headers: { accept: kind === 'workflow' ? 'application/json' : 'application/zip' },
  });
  if (!response.ok) {
    throw new Error((await readExportError(response)) || `导出失败（${response.status}）`);
  }

  const blob = await response.blob();
  if (blob.size === 0) throw new Error('导出内容为空');
  return {
    blob,
    filename: filenameFromContentDisposition(
      response.headers.get('content-disposition'),
      kind === 'workflow' ? 'workflow.json' : 'results.zip',
    ),
  };
}

/** Starts a browser download without exposing the response URL to page history. */
export function downloadProjectExport(
  download: ProjectExportDownload,
  environment: DownloadEnvironment = {},
): void {
  const documentRef =
    environment.documentRef ?? (typeof document !== 'undefined' ? document : undefined);
  const urlApi = environment.urlApi ?? (typeof URL !== 'undefined' ? URL : undefined);
  if (!documentRef || !urlApi?.createObjectURL) {
    throw new Error('当前环境不支持文件下载');
  }

  const objectUrl = urlApi.createObjectURL(download.blob);
  try {
    const anchor = documentRef.createElement('a');
    anchor.href = objectUrl;
    anchor.download = sanitizeDownloadFilename(download.filename, 'export');
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    const parent = documentRef.body ?? documentRef.documentElement;
    if (!parent) throw new Error('当前文档不支持文件下载');
    parent.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    const revoke = () => urlApi.revokeObjectURL?.(objectUrl);
    if (environment.schedule) environment.schedule(revoke);
    else if (typeof window !== 'undefined') window.setTimeout(revoke, 0);
    else revoke();
  }
}

/** Keeps download names portable across Windows, macOS and Linux. */
export function sanitizeDownloadFilename(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  return (normalized || fallback).slice(0, 180);
}

/** Reads a server-provided filename while ignoring path traversal and malformed values. */
export function filenameFromContentDisposition(
  header: string | null | undefined,
  fallback: string,
): string {
  if (!header) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return sanitizeDownloadFilename(decodeURIComponent(encoded), fallback);
    } catch {
      // Fall through to the plain filename form.
    }
  }
  const plain =
    /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1];
  return plain ? sanitizeDownloadFilename(plain.trim(), fallback) : fallback;
}

async function readExportError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body.trim()) return '';
  try {
    const payload = JSON.parse(body) as { error?: unknown; message?: unknown };
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : '';
    if (message) return message;
  } catch {
    // Some gateways return plain text errors; use that text below.
  }
  return body.trim().slice(0, 500);
}

export type AssetVersionSummary = {
  id: string;
  assetId: string;
  version: number;
  sizeBytes: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  contentUrl: string;
};

type AssetVersionsResponse = {
  versions?: unknown;
  error?: string;
};

function isAssetVersionSummary(value: unknown): value is AssetVersionSummary {
  if (!value || typeof value !== 'object') return false;
  const version = value as Record<string, unknown>;
  return (
    typeof version.id === 'string' &&
    typeof version.assetId === 'string' &&
    typeof version.version === 'number' &&
    Number.isSafeInteger(version.version) &&
    version.version > 0 &&
    typeof version.sizeBytes === 'number' &&
    Number.isSafeInteger(version.sizeBytes) &&
    version.sizeBytes >= 0 &&
    typeof version.createdAt === 'string' &&
    typeof version.contentUrl === 'string' &&
    version.contentUrl.length > 0
  );
}

/** Loads the server's immutable asset version summaries for a run result. */
export async function fetchAssetVersions(
  assetId: string,
  apiBaseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<AssetVersionSummary[]> {
  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  const response = await fetcher(`${baseUrl}/v1/assets/${encodeURIComponent(assetId)}/versions`);
  const payload = (await response.json().catch(() => ({}))) as AssetVersionsResponse;
  if (!response.ok) {
    throw new Error(payload.error ?? '结果版本加载失败');
  }
  if (!Array.isArray(payload.versions)) {
    throw new Error('结果版本响应格式无效');
  }
  const versions = payload.versions.filter(isAssetVersionSummary);
  if (versions.length !== payload.versions.length) {
    throw new Error('结果版本响应格式无效');
  }
  return versions.sort((left, right) => left.version - right.version);
}

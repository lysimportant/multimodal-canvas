import type { CanvasDocument, RunRecord, RunResultAsset } from '@multimodal-canvas/domain';

import type { AssetScope, AssetStore, AssetVersionRecord } from './assets';
import type { Project, ProjectModelDefaults } from './projects';

/** Version of the on-disk export contract. Increment when the shape changes. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Conservative defaults which can be overridden with environment variables. */
export const DEFAULT_EXPORT_LIMITS = {
  maxFiles: 1_000,
  maxBytes: 500 * 1024 * 1024,
} as const;

export type ExportLimits = {
  maxFiles: number;
  maxBytes: number;
};

export type ExportArchiveEntry = {
  path: string;
  content: Buffer | string;
};

export type WorkflowExportResultReference = {
  runId: string;
  targetNodeId: string;
  mediaType: 'text' | 'image' | 'audio' | 'video';
  provider: string;
  modelAlias: string;
  summary?: string;
  asset?: {
    assetId: string;
    version?: number;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
    /** Relative path inside a results archive; never an external URL. */
    path?: string;
  };
};

export type WorkflowExport = {
  schemaVersion: number;
  exportedAt: string;
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
  canvas: CanvasDocument;
  modelDefaults?: ProjectModelDefaults;
  runs: unknown[];
  results: WorkflowExportResultReference[];
};

export type ResultsManifestFile = {
  path: string;
  assetId: string;
  version: number;
  runIds: string[];
  name: string;
  mediaType: 'text' | 'image' | 'audio' | 'video';
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
};

export type ResultsManifest = {
  schemaVersion: number;
  exportedAt: string;
  project: { id: string; name: string };
  fileCount: number;
  totalBytes: number;
  files: ResultsManifestFile[];
};

export type PrepareResultsExportInput = {
  project: Project;
  canvas: CanvasDocument;
  runs: readonly RunRecord[];
  modelDefaults?: ProjectModelDefaults;
  assetStore: AssetStore;
  assetScope?: AssetScope;
  exportedAt?: string;
  limits?: Partial<ExportLimits>;
};

export type PreparedResultsExport = {
  workflow: WorkflowExport;
  manifest: ResultsManifest;
  entries: ExportArchiveEntry[];
};

export class ExportError extends Error {
  constructor(
    public readonly code:
      | 'asset_unavailable'
      | 'asset_version_unavailable'
      | 'export_limit_exceeded'
      | 'invalid_export_limit',
    message: string,
    public readonly statusCode: 400 | 409 | 413 = 409,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Resolve limits from environment without allowing malformed values to turn
 * into an unlimited export. The two aliases keep local deployments backwards
 * compatible with early prototypes.
 */
export function resolveExportLimits(
  environment: Record<string, string | undefined> = process.env,
): ExportLimits {
  const maxFiles = parseLimit(
    environment.EXPORT_MAX_RESULT_FILES ??
      environment.RESULT_EXPORT_MAX_FILES ??
      environment.EXPORT_MAX_FILES ??
      environment.MAX_EXPORT_FILES,
    DEFAULT_EXPORT_LIMITS.maxFiles,
  );
  const maxBytes = parseLimit(
    environment.EXPORT_MAX_RESULT_BYTES ??
      environment.RESULT_EXPORT_MAX_BYTES ??
      environment.EXPORT_MAX_BYTES ??
      environment.MAX_EXPORT_BYTES,
    DEFAULT_EXPORT_LIMITS.maxBytes,
  );
  return { maxFiles, maxBytes };
}

/**
 * Build a portable workflow document. Values that could contain credentials,
 * signed URLs, or provider secrets are omitted recursively. This function is
 * deliberately pure so clients can test the export contract without storage.
 */
export function createWorkflowExport(input: {
  project: Project;
  canvas: CanvasDocument;
  runs: readonly RunRecord[];
  modelDefaults?: ProjectModelDefaults;
  exportedAt?: string;
  resultPaths?: ReadonlyMap<string, string>;
  resultAssets?: ReadonlyMap<
    string,
    { version: number; path?: string; mimeType?: string; sizeBytes?: number; sha256?: string }
  >;
}): WorkflowExport {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const project = {
    id: input.project.id,
    name: input.project.name,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
  };

  const runs = input.runs.map((run) => sanitizeExportValue(run) as unknown);
  const results = input.runs
    .filter((run) => run.status === 'succeeded' && run.result)
    .map((run) => {
      const result = run.result!;
      const reference: WorkflowExportResultReference = {
        runId: run.id,
        targetNodeId: result.targetNodeId,
        mediaType: result.mediaType,
        provider: result.provider,
        modelAlias: run.modelAlias,
        ...(result.summary ? { summary: result.summary } : {}),
      };
      const asset = result.asset;
      if (asset) {
        const normalized = input.resultAssets?.get(resultAssetKey(asset));
        reference.asset = {
          assetId: asset.assetId,
          ...((normalized?.version ?? asset.version)
            ? { version: normalized?.version ?? asset.version }
            : {}),
          ...((normalized?.mimeType ?? asset.mimeType)
            ? { mimeType: normalized?.mimeType ?? asset.mimeType }
            : {}),
          ...((normalized?.sizeBytes ?? asset.sizeBytes) !== undefined
            ? { sizeBytes: normalized?.sizeBytes ?? asset.sizeBytes }
            : {}),
          ...((normalized?.sha256 ?? asset.sha256)
            ? { sha256: normalized?.sha256 ?? asset.sha256 }
            : {}),
          ...(normalized?.path
            ? { path: normalized.path }
            : input.resultPaths?.get(run.id)
              ? { path: input.resultPaths.get(run.id) }
              : {}),
        };
      }
      return reference;
    });

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    project,
    canvas: sanitizeExportValue(input.canvas) as CanvasDocument,
    ...(input.modelDefaults && Object.keys(input.modelDefaults).length > 0
      ? { modelDefaults: sanitizeExportValue(input.modelDefaults) as ProjectModelDefaults }
      : {}),
    runs,
    results,
  };
}

/**
 * Resolve result assets, read their bytes, and prepare the entries consumed by
 * the ZIP helper. Only successful runs with a result asset are included.
 */
export async function prepareResultsExport(
  input: PrepareResultsExportInput,
): Promise<PreparedResultsExport> {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const limits = {
    ...resolveExportLimits(),
    ...(input.limits?.maxFiles !== undefined ? { maxFiles: input.limits.maxFiles } : {}),
    ...(input.limits?.maxBytes !== undefined ? { maxBytes: input.limits.maxBytes } : {}),
  };
  validateLimits(limits);

  type Candidate = {
    assetId: string;
    version: number;
    assetName: string;
    mediaType: 'text' | 'image' | 'audio' | 'video';
    mimeType: string;
    sizeBytes: number;
    sha256?: string;
    content: Buffer;
    runIds: string[];
    path: string;
  };

  const candidates = new Map<string, Candidate>();
  const assetCache = new Map<string, Awaited<ReturnType<AssetStore['get']>>>();
  const versionsCache = new Map<string, AssetVersionRecord[]>();
  const resultPaths = new Map<string, string>();
  const resultAssets = new Map<
    string,
    { version: number; path?: string; mimeType?: string; sizeBytes?: number; sha256?: string }
  >();

  for (const run of input.runs) {
    if (run.status !== 'succeeded' || !run.result?.asset) continue;
    const resultAsset = run.result.asset;
    const assetId = resultAsset.assetId;
    let asset = assetCache.get(assetId);
    if (asset === undefined) {
      asset = await input.assetStore.get(assetId, input.assetScope);
      assetCache.set(assetId, asset);
    }
    if (!asset) {
      throw new ExportError(
        'asset_unavailable',
        `result asset ${assetId} is unavailable or unauthorized`,
        409,
      );
    }

    let versions = versionsCache.get(assetId);
    if (!versions) {
      versions = await input.assetStore.listVersions(assetId, input.assetScope);
      versionsCache.set(assetId, versions);
    }
    const versionRecord = resolveVersionRecord(resultAsset, versions);
    if (resultAsset.version !== undefined && !versionRecord) {
      throw new ExportError(
        'asset_version_unavailable',
        `result asset ${assetId} version ${resultAsset.version} is unavailable`,
        409,
      );
    }
    const version = versionRecord?.version ?? resultAsset.version ?? latestVersion(versions) ?? 1;
    const key = `${assetId}:${version}`;

    let candidate = candidates.get(key);
    if (candidate) {
      if (!candidate.runIds.includes(run.id)) candidate.runIds.push(run.id);
      resultPaths.set(run.id, candidate.path);
      resultAssets.set(resultAssetKey(resultAsset), {
        version,
        path: candidate.path,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.sizeBytes,
        ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
      });
      continue;
    }

    const sizeHint = versionRecord?.sizeBytes ?? resultAsset.sizeBytes ?? asset.sizeBytes;
    if (!Number.isSafeInteger(sizeHint) || sizeHint < 0) {
      throw new ExportError('asset_unavailable', `result asset ${assetId} has invalid size`, 409);
    }
    if (candidates.size >= limits.maxFiles) {
      throw new ExportError(
        'export_limit_exceeded',
        `result export exceeds the ${limits.maxFiles} file limit`,
        413,
      );
    }
    if (
      sizeHint > limits.maxBytes ||
      totalCandidateBytes(candidates) + sizeHint > limits.maxBytes
    ) {
      throw new ExportError(
        'export_limit_exceeded',
        `result export exceeds the ${formatBytes(limits.maxBytes)} size limit`,
        413,
      );
    }

    let content = await input.assetStore.getVersionContent(assetId, version, input.assetScope);
    // Legacy stores may not expose a version row. The current asset content is
    // still a valid v1 fallback after the asset has been authorized above.
    if (!content && version === 1 && !versionRecord) content = asset.content;
    if (!content) {
      throw new ExportError(
        'asset_version_unavailable',
        `result asset ${assetId} version ${version} content is unavailable`,
        409,
      );
    }
    if (
      content.byteLength > limits.maxBytes ||
      totalCandidateBytes(candidates) + content.byteLength > limits.maxBytes
    ) {
      throw new ExportError(
        'export_limit_exceeded',
        `result export exceeds the ${formatBytes(limits.maxBytes)} size limit`,
        413,
      );
    }

    const mimeType = asset.mimeType || resultAsset.mimeType || 'application/octet-stream';
    const path = makeResultPath(asset.name, assetId, version, mimeType, candidates);
    candidate = {
      assetId,
      version,
      assetName: asset.name,
      mediaType: asset.mediaType,
      mimeType,
      sizeBytes: content.byteLength,
      ...((versionRecord?.sha256 ?? resultAsset.sha256 ?? asset.sha256)
        ? { sha256: versionRecord?.sha256 ?? resultAsset.sha256 ?? asset.sha256 }
        : {}),
      content,
      runIds: [run.id],
      path,
    };
    candidates.set(key, candidate);
    resultPaths.set(run.id, path);
    resultAssets.set(resultAssetKey(resultAsset), {
      version,
      path,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes,
      ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
    });
  }

  const files: ResultsManifestFile[] = [...candidates.values()].map((candidate) => ({
    path: candidate.path,
    assetId: candidate.assetId,
    version: candidate.version,
    runIds: [...candidate.runIds],
    name: candidate.assetName,
    mediaType: candidate.mediaType,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.sizeBytes,
    ...(candidate.sha256 ? { sha256: candidate.sha256 } : {}),
  }));
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const manifest: ResultsManifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    project: { id: input.project.id, name: input.project.name },
    fileCount: files.length,
    totalBytes,
    files,
  };
  const workflow = createWorkflowExport({
    project: input.project,
    canvas: input.canvas,
    runs: input.runs,
    ...(input.modelDefaults ? { modelDefaults: input.modelDefaults } : {}),
    exportedAt,
    resultPaths,
    resultAssets,
  });
  const entries: ExportArchiveEntry[] = [
    { path: 'workflow.json', content: JSON.stringify(workflow, null, 2) },
    { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
    ...[...candidates.values()].map((candidate) => ({
      path: candidate.path,
      content: candidate.content,
    })),
  ];
  return { workflow, manifest, entries };
}

/** Produce an RFC 6266-compatible attachment header value. */
export function attachmentDisposition(filename: string): string {
  const safe = sanitizeDownloadFilename(filename);
  // Node's raw header serializer only accepts latin-1 in the legacy
  // `filename` parameter. Keep an ASCII fallback and carry the original
  // Unicode name in RFC 5987's `filename*` parameter.
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'export';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export function sanitizeDownloadFilename(value: string, fallback = 'export'): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 120);
  return normalized || fallback;
}

function resultAssetKey(asset: RunResultAsset): string {
  return `${asset.assetId}:${asset.version ?? ''}`;
}

function resolveVersionRecord(
  resultAsset: RunResultAsset,
  versions: readonly AssetVersionRecord[],
): AssetVersionRecord | undefined {
  if (resultAsset.version !== undefined) {
    return versions.find((version) => version.version === resultAsset.version);
  }
  return versions.length > 0
    ? versions.reduce((latest, current) => (current.version > latest.version ? current : latest))
    : undefined;
}

function latestVersion(versions: readonly AssetVersionRecord[]): number | undefined {
  return versions.length > 0 ? Math.max(...versions.map((version) => version.version)) : undefined;
}

function makeResultPath(
  name: string,
  assetId: string,
  version: number,
  mimeType: string,
  existing: ReadonlyMap<string, unknown>,
): string {
  const rawName = sanitizeDownloadFilename(name, 'result');
  const dot = rawName.lastIndexOf('.');
  const extensionCandidate = dot > 0 && dot < rawName.length - 1 ? rawName.slice(dot) : '';
  const suppliedExtension = /^\.[a-z0-9]{1,16}$/i.test(extensionCandidate)
    ? extensionCandidate
    : '';
  let stem =
    (dot > 0 ? rawName.slice(0, dot) : rawName).replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) ||
    'result';
  const extension = suppliedExtension || mimeExtension(mimeType);
  // Keep the complete ZIP path below the archive helper's UTF-8 byte limit,
  // including names made entirely of multi-byte characters.
  // Leave room for a collision suffix containing the asset id.
  while (Buffer.byteLength(`results/${stem}-v${version}${extension}`, 'utf8') > 180) {
    stem = stem.slice(0, -1).trim();
    if (!stem) {
      stem = 'result';
      break;
    }
  }
  const base = `results/${stem}-v${version}${extension}`;
  if (!existingHasPath(existing, base)) return base;
  const suffix = sanitizePathPart(assetId).slice(0, 24) || 'asset';
  const withId = `results/${stem}-v${version}-${suffix}${extension}`;
  if (!existingHasPath(existing, withId)) return withId;
  let index = 2;
  while (existingHasPath(existing, `results/${stem}-v${version}-${suffix}-${index}${extension}`))
    index += 1;
  return `results/${stem}-v${version}-${suffix}-${index}${extension}`;
}

function existingHasPath(existing: ReadonlyMap<string, unknown>, path: string): boolean {
  for (const value of existing.values()) {
    if (isCandidate(value) && value.path === path) return true;
  }
  return false;
}

function isCandidate(value: unknown): value is { path: string } {
  return Boolean(
    value && typeof value === 'object' && 'path' in value && typeof value.path === 'string',
  );
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_');
}

function mimeExtension(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  const normalized =
    subtype === 'svg+xml'
      ? 'svg'
      : subtype === 'jpeg'
        ? 'jpg'
        : subtype === 'x-wav'
          ? 'wav'
          : subtype?.replace(/[^a-z0-9]/g, '');
  return normalized ? `.${normalized}` : '';
}

function totalCandidateBytes(
  candidates: ReadonlyMap<string, { content?: Buffer; sizeBytes?: number }>,
): number {
  let total = 0;
  for (const candidate of candidates.values()) {
    total += candidate.content?.byteLength ?? candidate.sizeBytes ?? 0;
  }
  return total;
}

function validateLimits(limits: ExportLimits): void {
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  ) {
    throw new ExportError('invalid_export_limit', 'export limits must be positive integers', 400);
  }
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${Math.round(value / (1024 * 1024))} MiB`;
}

/** Recursively remove secret-like keys and all URL fields from export data. */
export function sanitizeExportValue(value: unknown, key?: string): unknown {
  if (key && (isSensitiveExportKey(key) || /(?:url|uri)$/i.test(key))) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeExportValue(item))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeExportValue(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}

function isSensitiveExportKey(key: string): boolean {
  // Normalize camelCase and punctuation before matching so `apiKey`,
  // `api_key`, and `API-KEY` receive identical treatment.
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return /(?:^|_)(?:api_key|access_token|refresh_token|authorization|password|secret(?:_key)?|credential(?:s|_id|_version)?|signed_url|presigned_url)(?:_|$)/.test(
    normalized,
  );
}

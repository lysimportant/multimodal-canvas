import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient, type Prisma } from '@prisma/client';
import type {
  MediaType,
  ProviderJob,
  RunResult,
  RunResultAsset,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import type { ResultAssetArchiver } from './index';
import type { ResultAssetArchiveInput, ProviderOutput } from './result-output';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_FFPROBE_TIMEOUT_MS = 10_000;
const execFile = promisify(execFileCallback);

/** Small object-storage boundary shared by filesystem and S3 adapters. */
export interface ResultBlobStore {
  put(key: string, content: Buffer, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type ResultMediaProbeInput = {
  content: Buffer;
  mimeType: string;
  mediaType: MediaType;
};

export interface ResultMediaMetadataExtractor {
  extract(input: ResultMediaProbeInput): Promise<Record<string, unknown>>;
}

type FfprobeResult = {
  format?: { format_name?: string; duration?: string | number; size?: string | number };
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string | number;
  }>;
};

type FfprobeRunner = (binary: string, args: string[], timeoutMs: number) => Promise<string>;
type PublicHostLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

type ExistingResultArchive = {
  id: string;
  projectId: string | null;
  mediaType: string;
  mimeType: string;
  sizeBytes: bigint | number | string;
  sha256: string | null;
  contentKey: string;
  versions?: Array<{
    version: number;
    sizeBytes: bigint | number | string;
    sha256: string | null;
    contentKey: string;
  }>;
};

/** Worker-local ffprobe adapter used after a provider video has been downloaded. */
export class WorkerFfprobeMediaMetadataExtractor implements ResultMediaMetadataExtractor {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runner: FfprobeRunner;

  constructor(options: { binary?: string; timeoutMs?: number; runner?: FfprobeRunner } = {}) {
    this.binary = options.binary ?? process.env.FFPROBE_PATH ?? 'ffprobe';
    this.timeoutMs = positiveLimit(
      options.timeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS,
      'ffprobe timeout',
    );
    this.runner = options.runner ?? defaultFfprobeRunner;
  }

  async extract(input: ResultMediaProbeInput): Promise<Record<string, unknown>> {
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-canvas-worker-probe-'));
    const filePath = join(directory, `input.${extensionFor(input.mediaType, input.mimeType)}`);
    try {
      await writeFile(filePath, input.content, { flag: 'wx' });
      const stdout = await this.runner(
        this.binary,
        ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', filePath],
        this.timeoutMs,
      );
      return normalizeFfprobeOutput(JSON.parse(stdout) as FfprobeResult);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Filesystem storage adapter using the same `assets/<id>/v1` key convention as the API. */
export class WorkerFileBlobStore implements ResultBlobStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('asset storage root is required');
    this.root = resolve(rootDirectory);
  }

  async put(key: string, content: Buffer): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    if (!key || isAbsolute(key)) throw new Error('blob key must be a relative path');
    const target = resolve(this.root, key);
    const fromRoot = relative(this.root, target);
    if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..') {
      throw new Error('blob key escapes the storage root');
    }
    return target;
  }
}

/** S3-compatible storage adapter (works with MinIO in development). */
export class WorkerS3BlobStore implements ResultBlobStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    } = {},
  ) {
    if (!bucket.trim()) throw new Error('S3 bucket is required');
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async put(key: string, content: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export type PrismaResultAssetArchiverOptions = {
  blobStore: ResultBlobStore;
  keyPrefix?: string;
  contentUrl?: (assetId: string) => string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  fetchTimeoutMs?: number;
  /** Allow HTTP provider URLs only for local development/test environments. */
  allowHttp?: boolean;
  /** Resolve provider hostnames and reject private/link-local answers. */
  strictDns?: boolean;
  /** Injectable DNS resolver for deterministic security tests. */
  lookupHost?: PublicHostLookup;
  /** Optional ffprobe-compatible extractor for generated media metadata. */
  metadataExtractor?: ResultMediaMetadataExtractor;
};

/**
 * Persists a provider output as an Asset and its first AssetVersion.
 *
 * The provider output is intentionally not written to the run/provider-job
 * payload. Only the resulting asset reference is returned to the worker.
 */
export class PrismaResultAssetArchiver {
  private readonly blobStore: ResultBlobStore;
  private readonly keyPrefix: string;
  private readonly contentUrl: (assetId: string) => string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly fetchTimeoutMs: number;
  private readonly allowHttp: boolean;
  private readonly strictDns: boolean;
  private readonly lookupHost: PublicHostLookup;
  private readonly metadataExtractor?: ResultMediaMetadataExtractor;

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaResultAssetArchiverOptions,
  ) {
    this.blobStore = options.blobStore;
    this.keyPrefix = trimPrefix(options.keyPrefix ?? 'assets');
    this.contentUrl =
      options.contentUrl ?? ((assetId) => `/v1/assets/${assetId}/versions/1/content`);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = positiveLimit(options.maxBytes ?? DEFAULT_MAX_BYTES, 'max asset size');
    this.fetchTimeoutMs = positiveLimit(
      options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      'asset fetch timeout',
    );
    this.allowHttp = options.allowHttp ?? process.env.NODE_ENV !== 'production';
    this.strictDns = options.strictDns ?? process.env.NODE_ENV === 'production';
    this.lookupHost =
      options.lookupHost ?? ((hostname, lookupOptions) => dnsLookup(hostname, lookupOptions));
    this.metadataExtractor = options.metadataExtractor;
  }

  async archive(input: {
    runId: string;
    userId?: string;
    snapshot: RunSnapshot;
    result: RunResult;
    providerJob: ProviderJob;
    output?: ProviderOutput;
    archiveInput?: ResultAssetArchiveInput;
    archiveKey?: string;
    signal?: AbortSignal;
  }): Promise<RunResultAsset | undefined> {
    throwIfCancelled(input.signal);
    const archiveInput = input.archiveInput;
    if (!archiveInput) return undefined;
    if (!UUID_PATTERN.test(input.snapshot.projectId)) {
      throw new Error('cannot archive a result without a PostgreSQL project UUID');
    }
    if (input.userId && !UUID_PATTERN.test(input.userId)) {
      throw new Error('cannot archive a result with an invalid user UUID');
    }

    const content =
      archiveInput.content ?? (await this.download(archiveInput.contentUrl, input.signal));
    throwIfCancelled(input.signal);
    if (!content || content.byteLength === 0) {
      throw new Error('provider returned an empty result payload');
    }
    if (content.byteLength > this.maxBytes) {
      throw new Error(`provider result exceeds the ${this.maxBytes}-byte limit`);
    }

    const extractedMetadata = await this.tryExtractMetadata({
      content,
      mimeType: archiveInput.mimeType,
      mediaType: archiveInput.mediaType,
    });
    throwIfCancelled(input.signal);
    const enrichedArchiveInput: ResultAssetArchiveInput = extractedMetadata
      ? {
          ...archiveInput,
          metadata: { ...(archiveInput.metadata ?? {}), ...extractedMetadata },
        }
      : archiveInput;

    const digest = createHash('sha256').update(content).digest('hex');
    const assetId = deterministicResultAssetId(archiveIdentity(input));
    const contentKey = `${this.keyPrefix}/${assetId}/v1-${digest}`;
    const metadata = buildResultMetadata(input, enrichedArchiveInput);
    const existing = await this.findExistingArchive(assetId);
    if (existing) {
      return assertExistingArchiveMatches(existing, {
        assetId,
        projectId: input.snapshot.projectId,
        mediaType: enrichedArchiveInput.mediaType,
        mimeType: enrichedArchiveInput.mimeType,
        sizeBytes: content.byteLength,
        sha256: digest,
        contentKey,
        contentUrl: this.contentUrl(assetId),
      });
    }
    throwIfCancelled(input.signal);
    try {
      await this.blobStore.put(contentKey, content, enrichedArchiveInput.mimeType);
      throwIfCancelled(input.signal);
      await this.prisma.$transaction(async (transaction) => {
        throwIfCancelled(input.signal);
        await transaction.asset.create({
          data: {
            id: assetId,
            projectId: input.snapshot.projectId,
            ...(input.userId ? { ownerId: input.userId } : {}),
            name: resultAssetName(
              input.snapshot,
              enrichedArchiveInput.mediaType,
              enrichedArchiveInput.mimeType,
            ),
            mediaType: enrichedArchiveInput.mediaType.toUpperCase() as
              'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO',
            mimeType: enrichedArchiveInput.mimeType,
            sizeBytes: BigInt(content.byteLength),
            sha256: digest,
            contentKey,
            metadata: metadata as Prisma.InputJsonValue,
          },
        });
        throwIfCancelled(input.signal);
        await transaction.assetVersion.create({
          data: {
            assetId,
            version: 1,
            sizeBytes: BigInt(content.byteLength),
            sha256: digest,
            contentKey,
            metadata: metadata as Prisma.InputJsonValue,
          },
        });
      });
    } catch (error) {
      let raced: ExistingResultArchive | undefined;
      try {
        raced = await this.findExistingArchive(assetId);
      } catch {
        // Preserve the original transaction error when reconciliation itself
        // is unavailable.
      }
      if (raced) {
        try {
          return assertExistingArchiveMatches(raced, {
            assetId,
            projectId: input.snapshot.projectId,
            mediaType: enrichedArchiveInput.mediaType,
            mimeType: enrichedArchiveInput.mimeType,
            sizeBytes: content.byteLength,
            sha256: digest,
            contentKey,
            contentUrl: this.contentUrl(assetId),
          });
        } catch (collisionError) {
          await this.blobStore.delete(contentKey).catch(() => undefined);
          throw collisionError;
        }
      }
      await this.blobStore.delete(contentKey).catch(() => undefined);
      throw error;
    }

    return {
      assetId,
      version: 1,
      contentUrl: this.contentUrl(assetId),
      mimeType: enrichedArchiveInput.mimeType,
      sizeBytes: content.byteLength,
      sha256: digest,
    };
  }

  private async download(
    url: string | undefined,
    cancellationSignal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    if (!url) return undefined;
    throwIfCancelled(cancellationSignal);
    const parsed = validateRemoteUrl(url, this.allowHttp);
    await assertPublicResolvedHost(parsed.hostname, this.strictDns, this.lookupHost);
    const controller = new AbortController();
    const cancelDownload = () => controller.abort(cancellationSignal?.reason);
    cancellationSignal?.addEventListener('abort', cancelDownload, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetchImpl(parsed.toString(), {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`provider result download failed (${response.status})`);
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > this.maxBytes) {
        throw new Error(`provider result exceeds the ${this.maxBytes}-byte limit`);
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        return bytes;
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = Buffer.from(next.value);
          total += chunk.byteLength;
          if (total > this.maxBytes) {
            await reader.cancel();
            throw new Error(`provider result exceeds the ${this.maxBytes}-byte limit`);
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancelDownload);
    }
  }

  private async findExistingArchive(assetId: string): Promise<ExistingResultArchive | undefined> {
    const assetDelegate = (
      this.prisma as PrismaClient & {
        asset?: {
          findUnique?: (input: unknown) => Promise<ExistingResultArchive | null>;
        };
      }
    ).asset;
    if (!assetDelegate?.findUnique) return undefined;
    const row = await assetDelegate.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        projectId: true,
        mediaType: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        contentKey: true,
        versions: {
          where: { version: 1 },
          take: 1,
          select: {
            version: true,
            sizeBytes: true,
            sha256: true,
            contentKey: true,
          },
        },
      },
    });
    return row ?? undefined;
  }

  private async tryExtractMetadata(
    input: ResultMediaProbeInput,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.metadataExtractor || input.mediaType === 'text') return undefined;
    try {
      const metadata = await this.metadataExtractor.extract(input);
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    } catch {
      // Metadata probing is best-effort, matching upload handling in the API.
      return undefined;
    }
  }
}

/** Build a production archiver from the same environment variables as the API. */
export function createResultAssetArchiverFromEnvironment(): {
  resultArchiver?: ResultAssetArchiver;
  close?: () => Promise<void>;
} {
  if (!process.env.DATABASE_URL) return {};
  const prisma = new PrismaClient();
  const blobStore = process.env.S3_BUCKET
    ? new WorkerS3BlobStore(process.env.S3_BUCKET, {
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      })
    : new WorkerFileBlobStore(process.env.ASSET_STORAGE_ROOT ?? '.data/assets');
  const archiver = new PrismaResultAssetArchiver(prisma, {
    blobStore,
    maxBytes: Number(process.env.RESULT_ASSET_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    fetchTimeoutMs: Number(process.env.NEW_API_TIMEOUT_MS ?? DEFAULT_FETCH_TIMEOUT_MS),
    allowHttp: process.env.NODE_ENV !== 'production',
    ...(process.env.FFPROBE_ENABLED === 'true' || process.env.FFPROBE_PATH
      ? {
          metadataExtractor: new WorkerFfprobeMediaMetadataExtractor({
            binary: process.env.FFPROBE_PATH,
          }),
        }
      : {}),
  });
  return {
    resultArchiver: (input) => archiver.archive(input),
    close: () => prisma.$disconnect(),
  };
}

function buildResultMetadata(
  input: {
    runId: string;
    snapshot: RunSnapshot;
    result: RunResult;
    providerJob: ProviderJob;
  },
  archiveInput: ResultAssetArchiveInput,
): Record<string, unknown> {
  return {
    ...(archiveInput.metadata ?? {}),
    generated: true,
    runId: input.runId,
    provider: input.result.provider,
    providerJobId: input.providerJob.id,
    ...(input.providerJob.platformJobId ? { platformJobId: input.providerJob.platformJobId } : {}),
    targetNodeId: input.result.targetNodeId,
    modelAlias: input.snapshot.modelAlias,
    parameters: sanitizeParameters(input.snapshot.parameters),
    mediaType: archiveInput.mediaType,
    mimeType: archiveInput.mimeType,
  };
}

/** Derive the same archive identity when a retry is run under a new run ID. */
function archiveIdentity(input: {
  archiveKey?: string;
  runId: string;
  result: RunResult;
  providerJob: ProviderJob;
}): string {
  if (input.archiveKey?.trim()) return input.archiveKey.trim();
  const payloadIdentity = input.providerJob.payload?.requestProviderJobId;
  const requestIdentity =
    typeof payloadIdentity === 'string' && payloadIdentity.trim()
      ? payloadIdentity.trim()
      : (input.providerJob.platformJobId ?? input.providerJob.id);
  return `workflow-archive:fallback:${input.runId}:${input.result.targetNodeId}:${requestIdentity}`;
}

/** Hash-based UUID keeps the existing PostgreSQL UUID contract without randomness. */
export function deterministicResultAssetId(identity: string): string {
  const bytes = createHash('sha256')
    .update(`multimodal-canvas:result-asset:v1:${identity}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertExistingArchiveMatches(
  existing: ExistingResultArchive,
  expected: {
    assetId: string;
    projectId: string;
    mediaType: MediaType;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    contentKey: string;
    contentUrl: string;
  },
): RunResultAsset {
  const version = existing.versions?.find((candidate) => candidate.version === 1);
  const existingSize = Number(existing.sizeBytes);
  const versionSize = version ? Number(version.sizeBytes) : expected.sizeBytes;
  const compatible =
    existing.id === expected.assetId &&
    existing.projectId === expected.projectId &&
    existing.mediaType.toLowerCase() === expected.mediaType &&
    comparableMimeType(existing.mimeType) === comparableMimeType(expected.mimeType) &&
    existingSize === expected.sizeBytes &&
    existing.sha256?.toLowerCase() === expected.sha256.toLowerCase() &&
    existing.contentKey === expected.contentKey &&
    Boolean(version) &&
    versionSize === expected.sizeBytes &&
    version?.sha256?.toLowerCase() === expected.sha256.toLowerCase() &&
    version.contentKey === expected.contentKey;
  if (!compatible) {
    throw new Error(`result archive identity collision for asset ${expected.assetId}`);
  }
  return {
    assetId: expected.assetId,
    version: 1,
    contentUrl: expected.contentUrl,
    mimeType: expected.mimeType,
    sizeBytes: expected.sizeBytes,
    sha256: expected.sha256,
  };
}

function comparableMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('worker cancellation requested');
  error.name = 'WorkerCancellationError';
  throw error;
}

function sanitizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const value = sanitizeJsonValue(parameters, 0);
  return isJsonObject(value) ? value : {};
}

function sanitizeJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeJsonValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .slice(0, 32)
      .filter(([key]) => !/(api[_-]?key|authorization|token|secret|password|credential)/i.test(key))
      .map(([key, item]) => [key, sanitizeJsonValue(item, depth + 1)] as const)
      .filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined);
    return Object.fromEntries(entries);
  }
  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultAssetName(snapshot: RunSnapshot, mediaType: MediaType, mimeType: string): string {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  const label = target?.data.label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const extension = extensionFor(mediaType, mimeType);
  return `${(label || 'generated').slice(0, 80)}.${extension}`;
}

function extensionFor(mediaType: MediaType, mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';', 1)[0];
  if (normalized === 'text/plain') return 'txt';
  if (normalized === 'text/markdown') return 'md';
  if (normalized === 'text/json' || normalized === 'application/json') return 'json';
  const extension = normalized.split('/')[1]?.replace(/^x-/, '');
  if (extension) {
    if (extension === 'mpeg') return mediaType === 'audio' ? 'mp3' : 'mpeg';
    return extension;
  }
  return mediaType === 'text' ? 'txt' : mediaType;
}

function normalizeFfprobeOutput(result: FfprobeResult): Record<string, unknown> {
  const stream =
    result.streams?.find((candidate) => candidate.codec_type === 'video') ?? result.streams?.[0];
  const metadata: Record<string, unknown> = {};
  const format = result.format?.format_name?.trim();
  if (format) metadata.format = format;
  const duration = finiteNumber(result.format?.duration);
  if (duration !== undefined) metadata.durationSeconds = duration;
  const probeSize = finiteNumber(result.format?.size);
  if (probeSize !== undefined) metadata.probeSizeBytes = Math.trunc(probeSize);
  if (stream?.codec_name) metadata.codec = stream.codec_name;
  if (Number.isInteger(stream?.width)) metadata.width = stream?.width;
  if (Number.isInteger(stream?.height)) metadata.height = stream?.height;
  const frameRate = parseFrameRate(stream?.r_frame_rate);
  if (frameRate !== undefined) metadata.frameRate = frameRate;
  if (Number.isInteger(stream?.channels)) metadata.channels = stream?.channels;
  const sampleRate = finiteNumber(stream?.sample_rate);
  if (sampleRate !== undefined) metadata.sampleRate = Math.trunc(sampleRate);
  return metadata;
}

function finiteNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

function defaultFfprobeRunner(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return execFile(binary, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }).then(
    ({ stdout }) => String(stdout),
  );
}

function validateRemoteUrl(value: string, allowHttp: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('provider result URL is invalid');
  }
  if (parsed.username || parsed.password)
    throw new Error('provider result URL cannot contain credentials');
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error('provider result URL must use HTTPS');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('provider result URL points to a private host');
  }
  return parsed;
}

async function assertPublicResolvedHost(
  hostname: string,
  strictDns: boolean,
  lookupHost: PublicHostLookup,
): Promise<void> {
  if (!strictDns || isIP(hostname)) return;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupHost(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('provider result host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateHost(address))) {
    throw new Error('provider result host resolves to a private host');
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  if (version === 6) {
    if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length));
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      /^fe[89ab]/.test(host)
    );
  }
  return false;
}

function trimPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error('invalid blob key prefix');
  }
  return normalized;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

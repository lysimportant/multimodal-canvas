import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { PrismaClient, type Prisma } from '@prisma/client';
import type { Asset, AssetStatus, MediaType } from '@multimodal-canvas/domain';

/** Object storage boundary used by asset metadata stores. */
export interface BlobStore {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
  /** 可选的无内容存在性检查；只有对象缺失返回 false，权限及传输错误必须抛出。 */
  exists?(key: string): Promise<boolean>;
  /** Optional native short-lived GET URL (for example an S3 presigned URL). */
  createPresignedGetUrl?(
    key: string,
    options?: { expiresIn?: number; contentType?: string },
  ): Promise<string>;
}

/** S3-compatible object storage adapter (works with MinIO in development). */
export class S3BlobStore implements BlobStore {
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

  async put(key: string, content: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content }));
  }

  async get(key: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return undefined;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** 使用 HEAD 选择新旧派生键，避免签名时下载预览；不掩盖权限或网络故障。 */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isS3NotFound(error)) return false;
      throw error;
    }
  }

  async createPresignedPutUrl(
    key: string,
    options: { expiresIn?: number; contentType?: string } = {},
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresIn ?? 900 });
  }

  async createPresignedGetUrl(
    key: string,
    options: { expiresIn?: number; contentType?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresIn ?? 300 });
  }
}

/** In-memory object storage for tests and local development. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(key: string, content: Buffer): Promise<void> {
    this.blobs.set(key, Buffer.from(content));
  }

  async get(key: string): Promise<Buffer | undefined> {
    const content = this.blobs.get(key);
    return content ? Buffer.from(content) : undefined;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** Filesystem-backed object storage constrained to a single root directory. */
export class FileSystemBlobStore implements BlobStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('blob store root directory is required');
    this.root = resolve(rootDirectory);
  }

  async put(key: string, content: Buffer): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  /** 读取相对键；缺失或源文件下不可能存在的子路径返回 undefined，其它 I/O 错误继续抛出。 */
  async get(key: string): Promise<Buffer | undefined> {
    const target = this.pathFor(key);
    try {
      return await readFile(target);
    } catch (error) {
      if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        return undefined;
      throw error;
    }
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

export { FileSystemBlobStore as LocalFileBlobStore };

export type StoredAsset = Asset & { content: Buffer };

/** 后台资源索引包含归属与时间字段；内容字节和对象存储键仍不公开。 */
export type ManagementAsset = Asset & {
  ownerId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'upload' | 'generated';
};

/** 资源权限判定只需归属索引，不应为了鉴权下载内容。 */
export type AssetOwnership = { ownerId: string | null; projectId: string | null };

export type CreateAssetInput = {
  name: string;
  mediaType: MediaType;
  mimeType: string;
  content: Buffer;
  tags?: string[];
  metadata?: Record<string, unknown>;
  derivatives?: Record<string, { mimeType: string; content: Buffer }>;
  /** Optional project binding; omitted assets are global to their owner. */
  projectId?: string;
  /** User scope for persistent stores; omitted for legacy service calls. */
  ownerId?: string;
};

export type UpdateAssetInput = { name?: string; tags?: string[] };

export type CreateAssetVersionInput = {
  content: Buffer;
  metadata?: Record<string, unknown>;
};

export type AssetScope = {
  /** `null` explicitly selects global assets instead of omitting project scope. */
  projectId?: string | null;
  ownerId?: string;
};

/**
 * 资源索引查询条件。`list` 仍返回数组以兼容旧调用；分页参数只在
 * 同时提供时生效，调用方可通过 `count` 获取同一条件的总数。
 */
export type AssetListOptions = {
  query?: string;
  mediaType?: MediaType;
  status?: AssetStatus;
  /** 需要同时命中的标签；比较不区分大小写。 */
  tags?: readonly string[];
  /** 结果页，从 1 开始。 */
  page?: number;
  /** 每页数量，最大 200。 */
  pageSize?: number;
};

/** 资源列表的分页结果，供 API 层构造稳定的分页元数据。 */
export type AssetListPage = {
  assets: Asset[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * 将实际解析出的最新版本附加到公开资产元数据。
 *
 * `latestVersion` 是新客户端应读取的明确字段；`metadata.version` 保留
 * 对旧版资源提及编辑器的兼容。版本号始终来自资产版本索引，不能由
 * 用户提交的元数据覆盖。
 */
function withLatestAssetVersion<T extends Asset>(asset: T, latestVersion?: number): T {
  const metadata = asset.metadata ? { ...asset.metadata } : undefined;
  const metadataVersion = positiveVersion(metadata?.version);
  const resolvedVersion = latestVersion ?? asset.latestVersion ?? metadataVersion;
  if (resolvedVersion === undefined) {
    return (metadata ? { ...asset, metadata } : { ...asset }) as T;
  }
  return {
    ...asset,
    latestVersion: resolvedVersion,
    metadata: { ...(metadata ?? {}), version: resolvedVersion },
  } as T;
}

export type AssetAccessTokenPayload = {
  /** Canonical resource identifier, never a user-controlled URL. */
  resource: string;
  assetId: string;
  ownerId?: string;
  expiresAt: number;
};

/**
 * Creates a compact HMAC token for a single asset resource. The token is
 * intentionally independent from Bearer authentication so it can be used by
 * media tags and download clients after the issuing request has completed.
 */
export function createAssetAccessToken(payload: AssetAccessTokenPayload, secret: string): string {
  if (!secret.trim()) throw new Error('asset access token secret is required');
  const encodedPayload = encodeTokenPart(JSON.stringify(payload));
  const signature = signTokenPart(encodedPayload, secret);
  return `v1.${encodedPayload}.${signature}`;
}

export function verifyAssetAccessToken(
  token: string | undefined,
  secret: string,
  expectedResource: string,
  now = Date.now(),
): AssetAccessTokenPayload | undefined {
  if (!token || token.length > 16 * 1024 || !secret.trim()) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  const [version, encodedPayload, signature] = parts;
  if (!version || !encodedPayload || !signature) return undefined;
  const expectedSignature = signTokenPart(encodedPayload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const parsed = JSON.parse(decodeTokenPart(encodedPayload)) as AssetAccessTokenPayload;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.resource !== expectedResource ||
      typeof parsed.assetId !== 'string' ||
      parsed.assetId.length === 0 ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now
    ) {
      return undefined;
    }
    if (parsed.ownerId !== undefined && typeof parsed.ownerId !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function encodeTokenPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeTokenPart(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signTokenPart(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(`v1.${encodedPayload}`).digest('base64url');
}

export type AssetVersionRecord = {
  id: string;
  assetId: string;
  version: number;
  sizeBytes: number;
  sha256?: string;
  contentKey: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type StoredAssetDerivative = {
  kind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
};

export interface AssetStore {
  create(input: CreateAssetInput): Promise<StoredAsset>;
  list(scope?: AssetScope, options?: AssetListOptions): Promise<Asset[]>;
  /** 管理与个人资源库共享的元数据索引，不读取对象内容。 */
  listManagement?(scope?: AssetScope): Promise<ManagementAsset[]>;
  /** 定点读取归属以检查历史资源和项目之间的冲突。 */
  getOwnership?(id: string): Promise<AssetOwnership | undefined>;
  /** Optional optimized count; callers must fall back to `list` when absent. */
  count?(
    scope?: AssetScope,
    options?: Omit<AssetListOptions, 'page' | 'pageSize'>,
  ): Promise<number>;
  get(id: string, scope?: AssetScope): Promise<StoredAsset | undefined>;
  createVersion(
    assetId: string,
    input: CreateAssetVersionInput,
    scope?: AssetScope,
  ): Promise<AssetVersionRecord | undefined>;
  listVersions(assetId: string, scope?: AssetScope): Promise<AssetVersionRecord[]>;
  getVersionContent(
    assetId: string,
    version: number,
    scope?: AssetScope,
  ): Promise<Buffer | undefined>;
  getDerivative(
    id: string,
    kind: string,
    scope?: AssetScope,
  ): Promise<StoredAssetDerivative | undefined>;
  update(id: string, input: UpdateAssetInput, scope?: AssetScope): Promise<StoredAsset | undefined>;
  setArchived(id: string, archived: boolean, scope?: AssetScope): Promise<StoredAsset | undefined>;
  createPresignedGetUrl?(
    id: string,
    options: { version?: number; derivative?: string; expiresIn: number },
    scope?: AssetScope,
  ): Promise<string | undefined>;
}

/** Volatile asset store used when DATABASE_URL is not configured. */
export class MemoryAssetStore implements AssetStore {
  private readonly assets = new Map<string, StoredAsset>();
  private readonly projects = new Map<string, string | undefined>();
  private readonly owners = new Map<string, string | undefined>();
  /** 内存资源管理索引的真实创建/更新时间，测试与数据库行为保持一致。 */
  private readonly assetTimes = new Map<string, { createdAt: string; updatedAt: string }>();
  private readonly derivatives = new Map<string, Map<string, StoredAssetDerivative>>();
  private readonly versions = new Map<
    string,
    Map<number, AssetVersionRecord & { content: Buffer }>
  >();

  async create(input: CreateAssetInput): Promise<StoredAsset> {
    const id = `asset_${randomUUID()}`;
    const derivatives = mapDerivativeInputs(id, input.derivatives);
    if (derivatives.length > 0) {
      this.derivatives.set(
        id,
        new Map(derivatives.map((derivative) => [derivative.kind, derivative])),
      );
    }
    const derivedMetadata = metadataWithDerivatives(input.metadata, derivatives, id);
    const assetMetadata = withLatestVersionMetadata(derivedMetadata, 1);
    const asset: StoredAsset = {
      id,
      name: input.name,
      mediaType: input.mediaType,
      mimeType: input.mimeType,
      sizeBytes: input.content.byteLength,
      sha256: sha256(input.content),
      status: 'ready',
      contentUrl: `/v1/assets/${id}/content`,
      tags: input.tags ?? [],
      latestVersion: 1,
      ...(assetMetadata ? { metadata: assetMetadata } : {}),
      content: Buffer.from(input.content),
    };
    this.assets.set(id, asset);
    this.projects.set(id, input.projectId);
    this.owners.set(id, input.ownerId);
    const createdAt = new Date().toISOString();
    this.assetTimes.set(id, { createdAt, updatedAt: createdAt });
    this.versions.set(
      id,
      new Map([
        [
          1,
          {
            id: `${id}_version_1`,
            assetId: id,
            version: 1,
            sizeBytes: input.content.byteLength,
            sha256: asset.sha256,
            contentKey: `memory/${id}/v1`,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            createdAt,
            content: Buffer.from(input.content),
          },
        ],
      ]),
    );
    return { ...asset, content: Buffer.from(asset.content) };
  }

  async list(scope: AssetScope = {}, options: AssetListOptions = {}): Promise<Asset[]> {
    const filtered = Array.from(this.assets.values())
      .filter((asset) => this.matchesScope(asset.id, scope))
      .filter((asset) => matchesAssetListOptions(asset, options))
      .map(({ content: _content, ...asset }) =>
        withLatestAssetVersion(asset, this.latestVersionFor(asset.id)),
      );
    return paginateAssets(filtered, options);
  }

  /** 将私有归属索引与资源元数据合并，不返回资源内容。 */
  async listManagement(scope: AssetScope = {}): Promise<ManagementAsset[]> {
    return (await this.list(scope)).map((asset) => ({
      ...asset,
      ownerId: this.owners.get(asset.id) ?? null,
      projectId: this.projects.get(asset.id) ?? null,
      ...this.assetTimes.get(asset.id)!,
      source: asset.metadata?.runId ? 'generated' : 'upload',
    }));
  }
  /** 返回内存归属索引，不读取内容字节。 */
  async getOwnership(id: string): Promise<AssetOwnership | undefined> {
    return this.assets.has(id)
      ? { ownerId: this.owners.get(id) ?? null, projectId: this.projects.get(id) ?? null }
      : undefined;
  }

  async count(
    scope: AssetScope = {},
    options: Omit<AssetListOptions, 'page' | 'pageSize'> = {},
  ): Promise<number> {
    return Array.from(this.assets.values())
      .filter((asset) => this.matchesScope(asset.id, scope))
      .filter((asset) => matchesAssetListOptions(asset, options)).length;
  }

  async get(id: string, scope: AssetScope = {}): Promise<StoredAsset | undefined> {
    const asset = this.assets.get(id);
    return asset && this.matchesScope(id, scope)
      ? withLatestAssetVersion(
          { ...asset, content: Buffer.from(asset.content) },
          this.latestVersionFor(id),
        )
      : undefined;
  }

  async createVersion(
    assetId: string,
    input: CreateAssetVersionInput,
    scope: AssetScope = {},
  ): Promise<AssetVersionRecord | undefined> {
    const asset = this.assets.get(assetId);
    if (!asset || !this.matchesScope(assetId, scope)) return undefined;
    const versionMap = this.versions.get(assetId) ?? new Map();
    const version = Math.max(0, ...versionMap.keys()) + 1;
    const createdAt = new Date().toISOString();
    const record = {
      id: `${assetId}_version_${version}`,
      assetId,
      version,
      sizeBytes: input.content.byteLength,
      sha256: sha256(input.content),
      contentKey: `memory/${assetId}/v${version}`,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt,
      content: Buffer.from(input.content),
    } satisfies AssetVersionRecord & { content: Buffer };
    versionMap.set(version, record);
    this.versions.set(assetId, versionMap);
    this.assets.set(assetId, {
      ...asset,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      contentUrl: `/v1/assets/${assetId}/content`,
      latestVersion: version,
      metadata: withLatestVersionMetadata(asset.metadata, version),
      content: Buffer.from(input.content),
    });
    const times = this.assetTimes.get(assetId);
    if (times) times.updatedAt = new Date().toISOString();
    const { content: _content, ...publicRecord } = record;
    return publicRecord;
  }

  async listVersions(assetId: string, scope: AssetScope = {}): Promise<AssetVersionRecord[]> {
    if (!this.assets.has(assetId) || !this.matchesScope(assetId, scope)) return [];
    return [...(this.versions.get(assetId)?.values() ?? [])]
      .sort((left, right) => left.version - right.version)
      .map(({ content: _content, ...record }) => record);
  }

  async getVersionContent(
    assetId: string,
    version: number,
    scope: AssetScope = {},
  ): Promise<Buffer | undefined> {
    if (!this.assets.has(assetId) || !this.matchesScope(assetId, scope)) return undefined;
    const record = this.versions.get(assetId)?.get(version);
    return record ? Buffer.from(record.content) : undefined;
  }

  async getDerivative(
    id: string,
    kind: string,
    scope: AssetScope = {},
  ): Promise<StoredAssetDerivative | undefined> {
    if (!this.matchesScope(id, scope)) return undefined;
    const derivative = this.derivatives.get(id)?.get(kind);
    return derivative ? { ...derivative, content: Buffer.from(derivative.content) } : undefined;
  }

  async update(
    id: string,
    input: UpdateAssetInput,
    scope: AssetScope = {},
  ): Promise<StoredAsset | undefined> {
    const asset = this.assets.get(id);
    if (!asset || !this.matchesScope(id, scope)) return undefined;
    const next: StoredAsset = {
      ...asset,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    };
    this.assets.set(id, next);
    const times = this.assetTimes.get(id);
    if (times) times.updatedAt = new Date().toISOString();
    return { ...next, content: Buffer.from(next.content) };
  }

  async setArchived(
    id: string,
    archived: boolean,
    scope: AssetScope = {},
  ): Promise<StoredAsset | undefined> {
    const asset = this.assets.get(id);
    if (!asset || !this.matchesScope(id, scope)) return undefined;
    const next: StoredAsset = {
      ...asset,
      status: archived ? 'archived' : 'ready',
      ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
    };
    this.assets.set(id, next);
    const times = this.assetTimes.get(id);
    if (times) times.updatedAt = new Date().toISOString();
    return { ...next, content: Buffer.from(next.content) };
  }

  private matchesScope(id: string, scope: AssetScope): boolean {
    if (scope.projectId !== undefined && (this.projects.get(id) ?? null) !== scope.projectId) {
      return false;
    }
    if (scope.ownerId && this.owners.get(id) !== scope.ownerId) return false;
    return true;
  }

  private latestVersionFor(assetId: string): number | undefined {
    const versions = this.versions.get(assetId);
    if (!versions || versions.size === 0) return undefined;
    return Math.max(...versions.keys());
  }
}

export type PrismaAssetStoreOptions = {
  blobStore?: BlobStore;
  projectId?: string;
  ownerId?: string;
  keyPrefix?: string;
  contentUrl?: (assetId: string) => string;
};

/** PostgreSQL-backed metadata with bytes stored behind BlobStore. */
export class PrismaAssetStore implements AssetStore {
  private readonly blobStore: BlobStore;
  private readonly projectId?: string;
  private readonly ownerId?: string;
  private readonly keyPrefix: string;
  private readonly contentUrl: (assetId: string) => string;

  constructor(
    private readonly prisma: PrismaClient,
    optionsOrBlobStore: PrismaAssetStoreOptions | BlobStore = {},
  ) {
    const options = isBlobStore(optionsOrBlobStore)
      ? { blobStore: optionsOrBlobStore }
      : optionsOrBlobStore;
    this.blobStore = options.blobStore ?? new MemoryBlobStore();
    this.projectId = options.projectId;
    this.ownerId = options.ownerId;
    this.keyPrefix = trimPrefix(options.keyPrefix ?? 'assets');
    this.contentUrl = options.contentUrl ?? ((assetId) => `/v1/assets/${assetId}/content`);
  }

  /** 创建源资源、版本和旁路预览；失败时只清理本次新键，不触碰旧布局对象。 */
  async create(input: CreateAssetInput): Promise<StoredAsset> {
    const id = randomUUID();
    const hash = sha256(input.content);
    const contentKey = this.versionKey(id, 1);
    const derivatives = mapDerivativeInputs(id, input.derivatives);
    const derivedMetadata = metadataWithDerivatives(input.metadata, derivatives, id);
    const assetMetadata = withLatestVersionMetadata(derivedMetadata, 1);
    try {
      await this.blobStore.put(contentKey, input.content);
      for (const derivative of derivatives) {
        await this.blobStore.put(
          this.derivativeKey(contentKey, derivative.kind),
          derivative.content,
        );
      }
      const row = await this.prisma.$transaction(async (transaction) => {
        const asset = await transaction.asset.create({
          data: {
            id,
            ...((input.projectId ?? this.projectId)
              ? { projectId: input.projectId ?? this.projectId }
              : {}),
            ...((input.ownerId ?? this.ownerId) ? { ownerId: input.ownerId ?? this.ownerId } : {}),
            name: input.name,
            mediaType: toPrismaMediaType(input.mediaType),
            mimeType: input.mimeType,
            sizeBytes: BigInt(input.content.byteLength),
            sha256: hash,
            contentKey,
            tags: input.tags ?? [],
            ...(assetMetadata ? { metadata: assetMetadata as Prisma.InputJsonValue } : {}),
          },
        });
        await transaction.assetVersion.create({
          data: {
            assetId: asset.id,
            version: 1,
            sizeBytes: BigInt(input.content.byteLength),
            sha256: hash,
            contentKey,
          },
        });
        return asset;
      });
      return {
        ...mapAsset(row, this.contentUrl, 1),
        content: Buffer.from(input.content),
      };
    } catch (error) {
      await this.blobStore.delete(contentKey).catch(() => undefined);
      await Promise.all(
        derivatives.map((derivative) =>
          this.blobStore
            .delete(this.derivativeKey(contentKey, derivative.kind))
            .catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  async list(scope: AssetScope = {}, options: AssetListOptions = {}): Promise<Asset[]> {
    const rows = await this.prisma.asset.findMany({
      where: this.scopeWhere(scope),
      orderBy: { updatedAt: 'desc' },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true },
        },
      },
    });
    const assets = rows
      .map((row) => mapAsset(row, this.contentUrl, row.versions?.[0]?.version))
      .filter((asset) => matchesAssetListOptions(asset, options));
    return paginateAssets(assets, options);
  }

  /** 后台索引只读取数据库元数据，不下载 S3 或本地资源内容。 */
  async listManagement(scope: AssetScope = {}): Promise<ManagementAsset[]> {
    const rows = await this.prisma.asset.findMany({
      where: this.scopeWhere(scope),
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
    });
    return rows.map((row) => ({
      ...mapAsset(row, this.contentUrl, row.versions[0]?.version),
      ownerId: row.ownerId,
      projectId: row.projectId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      source: asRecord(row.metadata)?.runId ? 'generated' : 'upload',
    }));
  }
  /** 从数据库定点读取鉴权字段，不访问对象存储。 */
  async getOwnership(id: string): Promise<AssetOwnership | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return undefined;
    return (
      (await this.prisma.asset.findUnique({
        where: { id },
        select: { ownerId: true, projectId: true },
      })) ?? undefined
    );
  }

  async count(
    scope: AssetScope = {},
    options: Omit<AssetListOptions, 'page' | 'pageSize'> = {},
  ): Promise<number> {
    const rows = await this.prisma.asset.findMany({
      where: this.scopeWhere(scope),
      select: {
        id: true,
        name: true,
        mediaType: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        status: true,
        tags: true,
        archivedAt: true,
        metadata: true,
      },
    });
    return rows
      .map((row) => mapAsset(row, this.contentUrl))
      .filter((asset) => matchesAssetListOptions(asset, options)).length;
  }

  async get(id: string, scope: AssetScope = {}): Promise<StoredAsset | undefined> {
    const row = await this.prisma.asset.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!row) return undefined;
    const content = await this.blobStore.get(row.contentKey);
    if (!content) return undefined;
    return {
      ...mapAsset(row, this.contentUrl, await this.latestVersionFor(id)),
      content,
    };
  }

  /** 在项目/所有者范围内读取预览；新键缺失时只读回退旧 S3 键，存储错误不会触发回退。 */
  async getDerivative(
    id: string,
    kind: string,
    scope: AssetScope = {},
  ): Promise<StoredAssetDerivative | undefined> {
    const row = await this.prisma.asset.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { contentKey: true, metadata: true },
    });
    if (!row || !isSafeDerivativeKind(kind)) return undefined;
    const metadata = asRecord(row.metadata);
    const descriptor = asRecord(metadata?.derivatives)?.[kind];
    if (!asRecord(descriptor)?.mimeType) return undefined;
    for (const key of this.derivativeReadKeys(row.contentKey, kind)) {
      const content = await this.blobStore.get(key);
      if (content === undefined) continue;
      return {
        kind,
        mimeType: String(asRecord(descriptor)?.mimeType),
        sizeBytes: content.byteLength,
        sha256: sha256(content),
        content,
      };
    }
    return undefined;
  }

  async update(
    id: string,
    input: UpdateAssetInput,
    scope: AssetScope = {},
  ): Promise<StoredAsset | undefined> {
    const existing = await this.prisma.asset.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!existing) return undefined;
    const row = await this.prisma.asset.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      },
    });
    const content = await this.blobStore.get(row.contentKey);
    if (!content) return undefined;
    return {
      ...mapAsset(row, this.contentUrl, await this.latestVersionFor(id)),
      content,
    };
  }

  async setArchived(
    id: string,
    archived: boolean,
    scope: AssetScope = {},
  ): Promise<StoredAsset | undefined> {
    const existing = await this.prisma.asset.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!existing) return undefined;
    const row = await this.prisma.asset.update({
      where: { id },
      data: { status: archived ? 'ARCHIVED' : 'READY', archivedAt: archived ? new Date() : null },
    });
    const content = await this.blobStore.get(row.contentKey);
    if (!content) return undefined;
    return {
      ...mapAsset(row, this.contentUrl, await this.latestVersionFor(id)),
      content,
    };
  }

  async createVersion(
    assetId: string,
    input: CreateAssetVersionInput,
    scope: AssetScope = {},
  ): Promise<AssetVersionRecord | undefined> {
    const existing = await this.prisma.asset.findFirst({
      where: { id: assetId, ...this.scopeWhere(scope) },
      select: { id: true, metadata: true },
    });
    if (!existing) return undefined;
    const latest = await this.prisma.assetVersion.findFirst({
      where: { assetId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const hash = sha256(input.content);
    const contentKey = this.versionKey(assetId, version);
    await this.blobStore.put(contentKey, input.content);
    try {
      const row = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.assetVersion.create({
          data: {
            assetId,
            version,
            sizeBytes: BigInt(input.content.byteLength),
            sha256: hash,
            contentKey,
            ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
          },
        });
        await transaction.asset.update({
          where: { id: assetId },
          data: {
            sizeBytes: BigInt(input.content.byteLength),
            sha256: hash,
            contentKey,
            metadata: withLatestVersionMetadata(
              asRecord(existing.metadata),
              version,
            ) as Prisma.InputJsonValue,
          },
        });
        return created;
      });
      return mapVersion(row);
    } catch (error) {
      await this.blobStore.delete(contentKey).catch(() => undefined);
      throw error;
    }
  }

  async addVersion(assetId: string, input: CreateAssetVersionInput, scope: AssetScope = {}) {
    return this.createVersion(assetId, input, scope);
  }

  async listVersions(assetId: string, scope: AssetScope = {}): Promise<AssetVersionRecord[]> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!asset) return [];
    const rows = await this.prisma.assetVersion.findMany({
      where: { assetId },
      orderBy: { version: 'asc' },
    });
    return rows.map(mapVersion);
  }

  async getVersionContent(
    assetId: string,
    version: number,
    scope: AssetScope = {},
  ): Promise<Buffer | undefined> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!asset) return undefined;
    const row = await this.prisma.assetVersion.findFirst({ where: { assetId, version } });
    return row ? this.blobStore.get(row.contentKey) : undefined;
  }

  /** 为授权范围内的源版本或实际存在的预览签名；预览支持新旧布局，错误保持显式。 */
  async createPresignedGetUrl(
    assetId: string,
    options: { version?: number; derivative?: string; expiresIn: number },
    scope: AssetScope = {},
  ): Promise<string | undefined> {
    const presigner = this.blobStore.createPresignedGetUrl;
    if (!presigner) return undefined;
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, ...this.scopeWhere(scope) },
      select: { contentKey: true, mimeType: true },
    });
    if (!asset) return undefined;
    let key = asset.contentKey;
    let contentType = asset.mimeType;
    if (options.version !== undefined) {
      const version = await this.prisma.assetVersion.findFirst({
        where: { assetId, version: options.version },
        select: { contentKey: true },
      });
      if (!version) return undefined;
      key = version.contentKey;
    } else if (options.derivative !== undefined) {
      if (!isSafeDerivativeKind(options.derivative)) return undefined;
      const metadata = asRecord(
        (
          await this.prisma.asset.findFirst({
            where: { id: assetId, ...this.scopeWhere(scope) },
            select: { metadata: true },
          })
        )?.metadata,
      );
      const descriptor = asRecord(asRecord(metadata?.derivatives)?.[options.derivative]);
      if (!descriptor?.mimeType) return undefined;
      contentType = String(descriptor.mimeType);
      let existingKey: string | undefined;
      for (const candidate of this.derivativeReadKeys(key, options.derivative)) {
        const exists = this.blobStore.exists
          ? await this.blobStore.exists(candidate)
          : (await this.blobStore.get(candidate)) !== undefined;
        if (exists) {
          existingKey = candidate;
          break;
        }
      }
      if (!existingKey) return undefined;
      key = existingKey;
    }
    return presigner.call(this.blobStore, key, {
      expiresIn: options.expiresIn,
      contentType,
    });
  }

  private scopeWhere(scope: AssetScope = {}): { projectId?: string | null; ownerId?: string } {
    const projectId = scope.projectId !== undefined ? scope.projectId : this.projectId;
    const ownerId = scope.ownerId ?? this.ownerId;
    return {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(ownerId ? { ownerId } : {}),
    };
  }

  private async latestVersionFor(assetId: string): Promise<number | undefined> {
    const latest = await this.prisma.assetVersion.findFirst({
      where: { assetId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return latest?.version;
  }

  private versionKey(assetId: string, version: number): string {
    return `${this.keyPrefix}/${assetId}/v${version}`;
  }

  /** 新派生文件写入源文件的旁路目录，源对象键和内容不变。 */
  private derivativeKey(contentKey: string, kind: string): string {
    return `${contentKey}.derivatives/${kind}`;
  }

  /** 优先新键，只有不存在时才读取旧 S3 键；不迁移、不重写旧对象。 */
  private derivativeReadKeys(contentKey: string, kind: string): [string, string] {
    return [this.derivativeKey(contentKey, kind), `${contentKey}/derivatives/${kind}`];
  }
}

export function detectMediaType(name: string, mimeType: string): MediaType | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/')) return 'text';
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'txt' || extension === 'md' || extension === 'json') return 'text';
  return undefined;
}

function matchesAssetListOptions(asset: Asset, options: AssetListOptions): boolean {
  if (options.mediaType && asset.mediaType !== options.mediaType) return false;
  if (options.status && asset.status !== options.status) return false;

  const query = options.query?.trim().toLocaleLowerCase();
  if (query) {
    const metadata = asset.metadata;
    const aliases = metadata?.aliases;
    const alias = metadata?.alias;
    const searchableAliases = [
      ...(typeof alias === 'string' ? [alias] : []),
      ...(Array.isArray(aliases)
        ? aliases.filter((value): value is string => typeof value === 'string')
        : []),
    ];
    const searchable = [asset.name, asset.mimeType, ...asset.tags, ...searchableAliases]
      .join('\u0000')
      .toLocaleLowerCase();
    if (!searchable.includes(query)) return false;
  }

  if (options.tags && options.tags.length > 0) {
    const available = new Set(asset.tags.map((tag) => tag.trim().toLocaleLowerCase()));
    for (const tag of options.tags) {
      const normalized = tag.trim().toLocaleLowerCase();
      if (normalized && !available.has(normalized)) return false;
    }
  }
  return true;
}

function paginateAssets(assets: Asset[], options: AssetListOptions): Asset[] {
  if (options.page === undefined && options.pageSize === undefined) return assets;
  const page = normalizePage(options.page, 1);
  const pageSize = normalizePageSize(options.pageSize, 50);
  const start = (page - 1) * pageSize;
  return assets.slice(start, start + pageSize);
}

function normalizePage(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizePageSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, 200);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function trimPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error('invalid blob key prefix');
  }
  return normalized;
}

function isBlobStore(value: PrismaAssetStoreOptions | BlobStore): value is BlobStore {
  return 'put' in value && 'get' in value && 'delete' in value;
}

function toPrismaMediaType(mediaType: MediaType): 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' {
  return mediaType.toUpperCase() as 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';
}

function mapAsset(
  row: {
    id: string;
    name: string;
    mediaType: string;
    mimeType: string;
    sizeBytes: bigint;
    sha256: string | null;
    metadata?: Prisma.JsonValue | null;
    status: string;
    tags: string[];
    archivedAt: Date | null;
  },
  contentUrl: (assetId: string) => string,
  latestVersion?: number,
): Asset {
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : undefined;
  const resolvedLatestVersion = latestVersion ?? positiveVersion(metadata?.version);
  const publicMetadata =
    resolvedLatestVersion === undefined
      ? metadata
      : { ...(metadata ?? {}), version: resolvedLatestVersion };
  return {
    id: row.id,
    name: row.name,
    mediaType: row.mediaType.toLowerCase() as MediaType,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    ...(resolvedLatestVersion === undefined ? {} : { latestVersion: resolvedLatestVersion }),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    status: row.status.toLowerCase() as 'ready' | 'archived',
    contentUrl: contentUrl(row.id),
    tags: [...row.tags],
    ...(publicMetadata ? { metadata: publicMetadata } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
  };
}

/** 将版本号写入兼容元数据，但不生成空 metadata 对象。 */
function withLatestVersionMetadata(
  metadata: Record<string, unknown> | undefined,
  latestVersion: number,
): Record<string, unknown> {
  return { ...(metadata ?? {}), version: latestVersion };
}

function positiveVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function mapVersion(row: {
  id: string;
  assetId: string;
  version: number;
  sizeBytes: bigint;
  sha256: string | null;
  contentKey: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}): AssetVersionRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    version: row.version,
    sizeBytes: Number(row.sizeBytes),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    contentKey: row.contentKey,
    ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function isS3NotFound(value: unknown) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('$metadata' in value || '$fault' in value) &&
    (('name' in value && (value as { name?: string }).name === 'NoSuchKey') ||
      ('$metadata' in value &&
        (value as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)),
  );
}

function mapDerivativeInputs(
  assetId: string,
  inputs: Record<string, { mimeType: string; content: Buffer }> | undefined,
): StoredAssetDerivative[] {
  if (!inputs) return [];
  return Object.entries(inputs)
    .filter(([kind, input]) => isSafeDerivativeKind(kind) && input.content.byteLength > 0)
    .map(([kind, input]) => ({
      kind,
      mimeType: input.mimeType,
      sizeBytes: input.content.byteLength,
      sha256: sha256(input.content),
      content: Buffer.from(input.content),
    }));
}

function metadataWithDerivatives(
  metadata: Record<string, unknown> | undefined,
  derivatives: StoredAssetDerivative[],
  assetId: string,
): Record<string, unknown> | undefined {
  if (derivatives.length === 0 && !metadata) return undefined;
  const descriptor = Object.fromEntries(
    derivatives.map((derivative) => [
      derivative.kind,
      {
        mimeType: derivative.mimeType,
        sizeBytes: derivative.sizeBytes,
        sha256: derivative.sha256,
        contentUrl: `/v1/assets/${assetId}/derivatives/${derivative.kind}`,
      },
    ]),
  );
  return {
    ...(metadata ?? {}),
    ...(derivatives.length > 0 ? { derivatives: descriptor } : {}),
  };
}

function isSafeDerivativeKind(value: string): boolean {
  return /^(thumbnail|poster|waveform)$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

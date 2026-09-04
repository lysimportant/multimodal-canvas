import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import {
  runSnapshotSchema,
  type FrozenPromptMention,
  type MediaType,
  type RunInputSnapshot,
  type RunSnapshot,
} from '@multimodal-canvas/domain';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DATABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoredAssetReference = {
  id: string;
  projectId: string | null;
  ownerId: string | null;
  mediaType: MediaType;
  mimeType: string;
  sizeBytes: bigint;
  contentKey: string;
  /** 资产当前状态；旧仓储适配器可省略，默认按可用处理。 */
  status?: 'ready' | 'archived';
};

export type StoredAssetVersionReference = {
  assetId: string;
  version: number;
  sizeBytes: bigint;
  contentKey: string;
};

export interface AssetReferenceRepository {
  findAsset(assetId: string): Promise<StoredAssetReference | undefined>;
  findVersion(assetId: string, version: number): Promise<StoredAssetVersionReference | undefined>;
}

export interface AssetReferenceBlobStore {
  get(key: string, readLimitBytes: number): Promise<Buffer | undefined>;
  close?(): Promise<void>;
}

export interface AssetReferenceResolver {
  resolve(snapshot: RunSnapshot, context?: { userId?: string }): Promise<RunSnapshot>;
}

type ParsedAssetUrl = { assetId: string; version?: number };

/**
 * Replaces durable asset references with provider-readable, in-memory data
 * URLs. The returned snapshot must never cross a queue or persistence boundary.
 */
export class StoredAssetReferenceResolver implements AssetReferenceResolver {
  private readonly maxBytes: number;

  constructor(
    private readonly repository: AssetReferenceRepository,
    private readonly blobStore: AssetReferenceBlobStore,
    options: { maxBytes?: number } = {},
  ) {
    this.maxBytes = positiveByteLimit(options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  async resolve(snapshot: RunSnapshot, context: { userId?: string } = {}): Promise<RunSnapshot> {
    const cache = new Map<string, Promise<ResolvedAsset>>();
    const hydratedInputs = await Promise.all(
      snapshot.inputs.map((input) =>
        this.resolveInput(snapshot.projectId, context.userId, input, cache),
      ),
    );
    const hydratedNodes = new Map(
      hydratedInputs.map((input) => [input.nodeId, input.snapshot] as const),
    );
    const promptMentionNodes = await this.resolvePromptMentionNodes(
      snapshot,
      context.userId,
      cache,
    );

    const parsedSnapshot = runSnapshotSchema.parse({
      ...snapshot,
      nodes: snapshot.nodes.map((node) => hydratedNodes.get(node.id) ?? node),
      inputs: hydratedInputs,
    });

    // `promptMentionNodes` contains provider-only data URLs. Inject them after
    // the durable schema parse so they cannot be serialized back into queue or
    // persistence payloads, while preserving any separately hydrated input
    // fields on a node that also owns inline mentions.
    return {
      ...parsedSnapshot,
      nodes: parsedSnapshot.nodes.map((node) => {
        const promptNode = promptMentionNodes.get(node.id);
        if (!promptNode) return node;
        return {
          ...node,
          ...promptNode,
          data: { ...node.data, ...promptNode.data },
        };
      }),
    };
  }

  /**
   * 将冻结的内联提及解析为 Provider 进程内可读的临时内容。
   *
   * `RunSnapshot.promptMentions` 只保存资产身份和版本，不能依赖资产的
   * 最新版本。这里把对应版本编码为 data URL 写入临时节点文档；返回值
   * 只传给当前 Provider 调用，队列数据和持久化快照仍保持原样。
   */
  private async resolvePromptMentionNodes(
    snapshot: RunSnapshot,
    userId: string | undefined,
    cache: Map<string, Promise<ResolvedAsset>>,
  ): Promise<Map<string, RunSnapshot['nodes'][number]>> {
    if (!snapshot.promptMentions || snapshot.promptMentions.length === 0) return new Map();

    const frozenByNode = new Map<string, Map<string, FrozenPromptMention>>();
    for (const mention of snapshot.promptMentions) {
      const nodeId = mention.nodeId ?? snapshot.targetNodeId;
      const byMention = frozenByNode.get(nodeId) ?? new Map<string, FrozenPromptMention>();
      if (byMention.has(mention.mentionId)) {
        throw new Error(`duplicate frozen prompt mention ${mention.mentionId} for node ${nodeId}`);
      }
      byMention.set(mention.mentionId, mention);
      frozenByNode.set(nodeId, byMention);
    }

    const hydrated = new Map<string, ResolvedAsset>();
    for (const [nodeId, mentions] of frozenByNode) {
      const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error(`prompt mention references a missing node ${nodeId}`);
      const document = node.data.promptDocument;
      if (!document) {
        throw new Error(`prompt mention node ${nodeId} is missing promptDocument`);
      }
      const documentMentionIds = new Set(
        document.blocks.filter((block) => block.type === 'mention').map((block) => block.mentionId),
      );
      for (const [mentionId, mention] of mentions) {
        if (!documentMentionIds.has(mentionId)) {
          throw new Error(`frozen prompt mention ${mentionId} is missing from node ${nodeId}`);
        }
        const key = `${mention.assetId}:${mention.assetVersion}`;
        const resolved = await cached(cache, key, () =>
          this.loadAsset(snapshot.projectId, userId, mention.assetId, mention.assetVersion),
        );
        assertPromptMentionMetadata(mention, resolved, nodeId);
        hydrated.set(`${nodeId}\0${mentionId}`, resolved);
      }
      for (const block of document.blocks) {
        if (block.type === 'mention' && !mentions.has(block.mentionId)) {
          throw new Error(`prompt mention ${block.mentionId} on node ${nodeId} is not frozen`);
        }
      }
    }

    const result = new Map<string, RunSnapshot['nodes'][number]>();
    for (const [nodeId, mentions] of frozenByNode) {
      const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (!node?.data.promptDocument) continue;
      const document = node.data.promptDocument;
      const blocks = document.blocks.map((block) => {
        if (block.type !== 'mention') return block;
        const mention = mentions.get(block.mentionId);
        const resolved = hydrated.get(`${nodeId}\0${block.mentionId}`);
        if (!mention || !resolved) return block;
        // These fields are intentionally transient passthrough fields. They
        // are consumed by a Provider adapter and never copied to the durable
        // frozen mention list or a run result.
        return {
          ...block,
          assetVersion: mention.assetVersion,
          contentUrl: resolved.dataUrl,
          mimeType: resolved.mimeType,
        };
      });
      result.set(nodeId, {
        ...node,
        data: {
          ...node.data,
          promptDocument: { ...document, blocks },
        },
      });
    }
    return result;
  }

  private async resolveInput(
    projectId: string,
    userId: string | undefined,
    input: RunInputSnapshot,
    cache: Map<string, Promise<ResolvedAsset>>,
  ): Promise<RunInputSnapshot> {
    const contentUrl = input.snapshot.data.contentUrl;
    const parsedUrl = parseRelativeAssetUrl(contentUrl);
    if (isRelativeUrl(contentUrl) && !parsedUrl) {
      throw new Error(`asset reference URL is not supported for node ${input.nodeId}`);
    }

    const identifiers = [
      input.sourceAssetId,
      input.snapshot.data.assetId,
      parsedUrl?.assetId,
    ].filter((value): value is string => Boolean(value));
    if (identifiers.length === 0) return input;

    const assetId = identifiers[0];
    if (!assetId || identifiers.some((identifier) => identifier !== assetId)) {
      throw new Error(`asset reference identifiers do not match for node ${input.nodeId}`);
    }
    if (!DATABASE_UUID_PATTERN.test(assetId)) {
      throw new Error(`asset reference id is invalid for node ${input.nodeId}`);
    }

    if (parsedUrl?.version === undefined) {
      throw new Error(
        `asset reference ${assetId} for node ${input.nodeId} is missing an immutable version`,
      );
    }

    const version = parsedUrl.version;
    const cacheKey = `${assetId}:${version}`;
    const resolved = await cached(cache, cacheKey, () =>
      this.loadAsset(projectId, userId, assetId, version),
    );
    assertInputMetadata(input, resolved);

    return {
      ...input,
      sourceAssetId: assetId,
      snapshot: {
        ...input.snapshot,
        data: {
          ...input.snapshot.data,
          assetId,
          mimeType: resolved.mimeType,
          contentUrl: resolved.dataUrl,
          ...(resolved.mediaType === 'text' ? { prompt: undefined } : {}),
        },
      },
    };
  }

  private async loadAsset(
    projectId: string,
    userId: string | undefined,
    assetId: string,
    version: number,
  ): Promise<ResolvedAsset> {
    const asset = await this.repository.findAsset(assetId);
    if (!asset) throw new Error(`asset reference ${assetId} was not found`);
    const sameProject = asset.projectId === projectId;
    const accessibleGlobalAsset =
      asset.projectId === null && userId !== undefined && asset.ownerId === userId;
    if (!sameProject && !accessibleGlobalAsset) {
      throw new Error(`asset reference ${assetId} does not belong to the run project`);
    }
    if (asset.status === 'archived') {
      throw new Error(`asset reference ${assetId} is archived`);
    }
    assertMimeMatchesMediaType(asset.mimeType, asset.mediaType, assetId);

    const selected = await this.repository.findVersion(assetId, version);
    if (!selected) {
      throw new Error(`asset reference ${assetId} version ${version} was not found`);
    }
    if (selected.assetId !== assetId || selected.version !== version) {
      throw new Error(`asset reference ${assetId} returned an inconsistent version`);
    }
    const expectedSize = selected.sizeBytes;
    if (expectedSize <= 0n) throw new Error(`asset reference ${assetId} is empty`);
    if (expectedSize > BigInt(this.maxBytes)) {
      throw new Error(`asset reference ${assetId} exceeds the ${this.maxBytes}-byte limit`);
    }

    const content = await this.blobStore.get(selected.contentKey, Number(expectedSize) + 1);
    if (!content) throw new Error(`asset reference ${assetId} content is missing`);
    if (content.byteLength > this.maxBytes) {
      throw new Error(`asset reference ${assetId} exceeds the ${this.maxBytes}-byte limit`);
    }
    if (BigInt(content.byteLength) !== expectedSize) {
      throw new Error(`asset reference ${assetId} content size does not match its metadata`);
    }
    if (asset.mediaType === 'text') assertUtf8Text(content, assetId);

    const mimeType = normalizeMimeType(asset.mimeType);
    const providerMimeType = asset.mediaType === 'text' ? 'text/plain' : mimeType;
    return {
      assetId,
      version,
      mediaType: asset.mediaType,
      mimeType,
      dataUrl: `data:${providerMimeType};base64,${content.toString('base64')}`,
    };
  }
}

type ResolvedAsset = {
  assetId: string;
  version: number;
  mediaType: MediaType;
  mimeType: string;
  dataUrl: string;
};

class PrismaAssetReferenceRepository implements AssetReferenceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAsset(assetId: string): Promise<StoredAssetReference | undefined> {
    const row = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        projectId: true,
        ownerId: true,
        mediaType: true,
        mimeType: true,
        sizeBytes: true,
        contentKey: true,
        status: true,
      },
    });
    return row
      ? {
          ...row,
          status: row.status.toLowerCase() as 'ready' | 'archived',
          mediaType: row.mediaType.toLowerCase() as MediaType,
        }
      : undefined;
  }

  async findVersion(
    assetId: string,
    version: number,
  ): Promise<StoredAssetVersionReference | undefined> {
    const row = await this.prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId, version } },
      select: { assetId: true, version: true, sizeBytes: true, contentKey: true },
    });
    return row ?? undefined;
  }
}

class FileAssetReferenceBlobStore implements AssetReferenceBlobStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('asset storage root is required');
    this.root = resolve(rootDirectory);
  }

  async get(key: string, readLimitBytes: number): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.pathFor(key), 'r');
      const buffer = Buffer.allocUnsafe(positiveByteLimit(readLimitBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private pathFor(key: string): string {
    if (!key || isAbsolute(key)) throw new Error('blob key must be a relative path');
    const target = resolve(this.root, key);
    const fromRoot = relative(this.root, target);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new Error('blob key escapes the storage root');
    }
    return target;
  }
}

class S3AssetReferenceBlobStore implements AssetReferenceBlobStore {
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

  async get(key: string, readLimitBytes: number): Promise<Buffer | undefined> {
    const limit = positiveByteLimit(readLimitBytes);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${limit - 1}`,
        }),
      );
      if (!response.Body) return undefined;
      if (response.ContentLength !== undefined && response.ContentLength > limit) {
        const body = response.Body as typeof response.Body & { destroy?: () => void };
        body.destroy?.();
        throw new Error(`stored asset exceeds the ${limit}-byte read limit`);
      }
      const content = Buffer.from(await response.Body.transformToByteArray());
      if (content.byteLength > limit) {
        throw new Error(`stored asset exceeds the ${limit}-byte read limit`);
      }
      return content;
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

export function createAssetReferenceResolverFromEnvironment(): {
  assetReferenceResolver?: AssetReferenceResolver;
  close?: () => Promise<void>;
} {
  if (!process.env.DATABASE_URL) return {};
  const maxBytes = positiveByteLimit(
    Number(process.env.RESULT_ASSET_MAX_BYTES ?? DEFAULT_MAX_BYTES),
  );
  const prisma = new PrismaClient();
  const blobStore: AssetReferenceBlobStore = process.env.S3_BUCKET
    ? new S3AssetReferenceBlobStore(process.env.S3_BUCKET, {
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      })
    : new FileAssetReferenceBlobStore(process.env.ASSET_STORAGE_ROOT ?? '.data/assets');
  const resolver = new StoredAssetReferenceResolver(
    new PrismaAssetReferenceRepository(prisma),
    blobStore,
    { maxBytes },
  );

  return {
    assetReferenceResolver: resolver,
    close: async () => {
      const results = await Promise.allSettled([prisma.$disconnect(), blobStore.close?.()]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'asset resolver close failed');
    },
  };
}

function parseRelativeAssetUrl(value: string | undefined): ParsedAssetUrl | undefined {
  if (!isRelativeUrl(value)) return undefined;
  let pathname: string;
  try {
    pathname = new URL(value.trim(), 'https://worker.invalid').pathname;
  } catch {
    return undefined;
  }
  const match = /^\/v1\/assets\/([^/]+)\/(?:versions\/(\d+)\/)?content\/?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  let assetId: string;
  try {
    assetId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  if (!assetId) return undefined;
  if (!match[2]) return { assetId };
  const version = Number(match[2]);
  return Number.isSafeInteger(version) && version > 0 ? { assetId, version } : undefined;
}

function isRelativeUrl(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().startsWith('/');
}

function assertInputMetadata(input: RunInputSnapshot, resolved: ResolvedAsset): void {
  if (input.snapshot.data.mediaType !== resolved.mediaType) {
    throw new Error(
      `asset reference ${resolved.assetId} media type does not match node ${input.nodeId}`,
    );
  }
  const declaredMimeType = input.snapshot.data.mimeType;
  if (declaredMimeType && normalizeMimeType(declaredMimeType) !== resolved.mimeType) {
    throw new Error(`asset reference ${resolved.assetId} MIME type does not match its snapshot`);
  }
}

function assertPromptMentionMetadata(
  mention: FrozenPromptMention,
  resolved: ResolvedAsset,
  nodeId: string,
): void {
  if (mention.assetId !== resolved.assetId) {
    throw new Error(
      `prompt mention ${mention.mentionId} asset identity does not match node ${nodeId}`,
    );
  }
  if (mention.assetVersion !== resolved.version) {
    throw new Error(
      `prompt mention ${mention.mentionId} asset version does not match node ${nodeId}`,
    );
  }
  if (mention.mediaType !== resolved.mediaType) {
    throw new Error(
      `prompt mention ${mention.mentionId} media type does not match asset ${mention.assetId}`,
    );
  }
}

function assertMimeMatchesMediaType(mimeType: string, mediaType: MediaType, assetId: string): void {
  const normalized = normalizeMimeType(mimeType);
  const compatible =
    mediaType === 'text'
      ? normalized.startsWith('text/') ||
        normalized === 'application/json' ||
        normalized === 'application/xml'
      : normalized.startsWith(`${mediaType}/`);
  if (!compatible) {
    throw new Error(`asset reference ${assetId} MIME type does not match its media type`);
  }
}

function assertUtf8Text(content: Buffer, assetId: string): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`asset reference ${assetId} is not valid UTF-8 text`);
  }
}

function normalizeMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new Error('asset reference has an invalid MIME type');
  }
  return normalized;
}

async function cached(
  cache: Map<string, Promise<ResolvedAsset>>,
  key: string,
  load: () => Promise<ResolvedAsset>,
): Promise<ResolvedAsset> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('asset reference byte limit must be a positive safe integer');
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isS3NotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

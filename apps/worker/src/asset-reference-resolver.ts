import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaClient } from '@prisma/client';
import {
  imageEditSourceSchema,
  runSnapshotSchema,
  videoFamilyForModel,
  type FrozenPromptMention,
  type MediaType,
  type RunInputSnapshot,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { normalizeProviderAssetEndpoint } from './startup-config.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PROVIDER_ASSET_URL_EXPIRES_SECONDS = 60 * 60;
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
  /** 为 Provider 生成只读短期 URL；未配置公网对象端点的存储可省略。 */
  createProviderGetUrl?(
    key: string,
    options: { expiresIn: number; contentType: string },
  ): Promise<string>;
  close?(): Promise<void>;
}

export interface AssetReferenceResolver {
  resolve(snapshot: RunSnapshot, context?: { userId?: string }): Promise<RunSnapshot>;
  /** 发送前复核已解析资源的当前归属与归档状态，不重新读取文件；旧注入实现可省略。 */
  assertAccessible?(snapshot: RunSnapshot, context?: { userId?: string }): Promise<void>;
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
    const providerUrlCache = new Map<string, Promise<string>>();
    const hydratedInputs = await Promise.all(
      snapshot.inputs.map((input) =>
        this.resolveInput(snapshot, context.userId, input, cache, providerUrlCache),
      ),
    );
    const hydratedNodes = new Map(
      hydratedInputs.map((input) => [input.nodeId, input.snapshot] as const),
    );
    const promptMentionNodes = await this.resolvePromptMentionNodes(
      snapshot,
      context.userId,
      cache,
      providerUrlCache,
    );
    const imageEditSourceContents = await this.resolveImageEditSources(
      snapshot,
      context.userId,
      cache,
    );

    const parsedSnapshot = runSnapshotSchema.parse({
      ...snapshot,
      nodes: snapshot.nodes.map((node) => {
        const hydrated = hydratedNodes.get(node.id) ?? node;
        const imageEditContent = imageEditSourceContents.get(node.id);
        if (!imageEditContent) return hydrated;
        // 只读来源缩略图/审计字段在 Provider 进程内换成临时内容；
        // 冻结的 assetId/version 与队列快照都不受影响。
        return {
          ...hydrated,
          data: { ...hydrated.data, contentUrl: imageEditContent.dataUrl },
        };
      }),
      inputs: hydratedInputs,
    });

    // `promptMentionNodes` contains provider-only data URLs. Inject them after
    // the durable schema parse so they cannot be serialized back into queue or
    // persistence payloads, while preserving any separately hydrated input
    // fields on a node that also owns inline mentions.
    const resolvedSnapshot: RunSnapshot = {
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
    await this.assertAccessible(resolvedSnapshot, context);
    return resolvedSnapshot;
  }

  /**
   * 重新核验整次水合读取过的资源，避免读取后续资源期间前项已归档或权限已撤销。
   * @param snapshot 已水合的进程内快照；身份来自连线、冻结提及与图片编辑来源。
   * @param context 当前运行的用户身份，个人资源按同一身份复核。
   * @throws 任一资源消失、归档或归属不再匹配时阻止发送，不重读文件内容。
   */
  async assertAccessible(snapshot: RunSnapshot, context: { userId?: string } = {}): Promise<void> {
    const assetIds = new Set<string>();
    for (const input of snapshot.inputs) {
      const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
      if (assetId) assetIds.add(assetId);
    }
    for (const mention of snapshot.promptMentions ?? []) assetIds.add(mention.assetId);
    for (const node of snapshot.nodes) {
      const source = imageEditSourceSchema.safeParse(node.data.imageEditSource);
      if (source.success) assetIds.add(source.data.assetId);
    }
    for (const assetId of assetIds) {
      await this.requireAccessibleAsset(snapshot.projectId, context.userId, assetId);
    }
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
    providerUrlCache: Map<string, Promise<string>>,
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
        hydrated.set(`${nodeId}\0${mentionId}`, {
          ...resolved,
          providerContentUrl: await this.providerContentUrl(
            snapshot,
            nodeId,
            resolved,
            providerUrlCache,
          ),
        });
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
          contentUrl: resolved.providerContentUrl ?? resolved.dataUrl,
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

  /**
   * 按冻结的 `imageEditSource.assetId/version` 读取图片编辑来源内容。
   *
   * 编辑节点上的来源引用只保存资产身份，这里用运行前冻结的版本号读取不可变
   * 内容，绝不使用未版本化的最新地址；读取失败时明确报错而不是继续请求。
   *
   * @param snapshot 当前运行快照。
   * @param userId 资源归属用户，用于个人资源库授权。
   * @param cache 同一资产版本的进程内缓存。
   * @returns 节点 ID 到已解析内容的映射。
   */
  private async resolveImageEditSources(
    snapshot: RunSnapshot,
    userId: string | undefined,
    cache: Map<string, Promise<ResolvedAsset>>,
  ): Promise<Map<string, ResolvedAsset>> {
    const contents = new Map<string, ResolvedAsset>();
    for (const node of snapshot.nodes) {
      const parsed = imageEditSourceSchema.safeParse(node.data.imageEditSource);
      if (!parsed.success) continue;
      const source = parsed.data;
      const sourceNode = snapshot.nodes.find((candidate) => candidate.id === source.sourceNodeId);
      if (!sourceNode) {
        throw new Error(
          `image edit source node ${source.sourceNodeId} for node ${node.id} is missing`,
        );
      }
      if (sourceNode.data.assetId !== source.assetId) {
        throw new Error(
          `image edit source asset does not match node ${source.sourceNodeId} for node ${node.id}`,
        );
      }
      if (!DATABASE_UUID_PATTERN.test(source.assetId)) {
        throw new Error(`image edit source asset id is invalid for node ${node.id}`);
      }
      const parsedUrl = parseRelativeAssetUrl(sourceNode.data.contentUrl);
      if (!parsedUrl || parsedUrl.assetId !== source.assetId || parsedUrl.version === undefined) {
        throw new Error(
          `asset reference ${source.assetId} for node ${node.id} is missing an immutable version`,
        );
      }
      const resolved = await cached(cache, `${source.assetId}:${parsedUrl.version}`, () =>
        this.loadAsset(snapshot.projectId, userId, source.assetId, parsedUrl.version!),
      );
      if (resolved.mediaType !== 'image') {
        throw new Error(`image edit source for node ${node.id} is not an image asset`);
      }
      contents.set(node.id, resolved);
    }
    return contents;
  }

  private async resolveInput(
    snapshot: RunSnapshot,
    userId: string | undefined,
    input: RunInputSnapshot,
    cache: Map<string, Promise<ResolvedAsset>>,
    providerUrlCache: Map<string, Promise<string>>,
  ): Promise<RunInputSnapshot> {
    const inputContentUrl = input.snapshot.data.contentUrl;
    const parsedUrl = parseRelativeAssetUrl(inputContentUrl);
    if (isRelativeUrl(inputContentUrl) && !parsedUrl) {
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
    if (input.sourceAssetVersion !== undefined && input.sourceAssetVersion !== version) {
      throw new Error(`asset reference ${assetId} version does not match its frozen input`);
    }
    const cacheKey = `${assetId}:${version}`;
    const resolved = await cached(cache, cacheKey, () =>
      this.loadAsset(snapshot.projectId, userId, assetId, version),
    );
    assertInputMetadata(input, resolved);
    const providerContentUrl = await this.providerContentUrl(
      snapshot,
      snapshot.targetNodeId,
      resolved,
      providerUrlCache,
    );

    return {
      ...input,
      sourceAssetId: assetId,
      sourceAssetVersion: version,
      snapshot: {
        ...input.snapshot,
        data: {
          ...input.snapshot.data,
          assetId,
          mimeType: resolved.mimeType,
          contentUrl: providerContentUrl,
          ...(resolved.mediaType === 'text' ? { prompt: undefined } : {}),
        },
      },
    };
  }

  /**
   * 仅为官方明确要求 HTTP(S) 的视频参考素材生成短期 URL。
   * 图片和支持 data URL 的模型继续走内存内容，避免扩大外部可读面。
   */
  private async providerContentUrl(
    snapshot: RunSnapshot,
    consumerNodeId: string,
    resolved: ResolvedAsset,
    cache: Map<string, Promise<string>>,
  ): Promise<string> {
    if (!requiresProviderAssetUrl(snapshot, consumerNodeId, resolved.mediaType)) {
      return resolved.dataUrl;
    }
    const signer = this.blobStore.createProviderGetUrl;
    if (!signer) {
      throw new Error(
        `asset reference ${resolved.assetId} requires a public signed URL; configure S3_PROVIDER_ENDPOINT for this video model`,
      );
    }
    return cached(cache, resolved.contentKey, () =>
      signer.call(this.blobStore, resolved.contentKey, {
        expiresIn: PROVIDER_ASSET_URL_EXPIRES_SECONDS,
        contentType: resolved.mimeType,
      }),
    );
  }

  private async loadAsset(
    projectId: string,
    userId: string | undefined,
    assetId: string,
    version: number,
  ): Promise<ResolvedAsset> {
    const asset = await this.requireAccessibleAsset(projectId, userId, assetId);
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
      contentKey: selected.contentKey,
      dataUrl: `data:${providerMimeType};base64,${content.toString('base64')}`,
    };
  }

  /** 按运行项目或个人归属校验资源仍存在且未归档，返回当前元数据供读取与发送前共用。 */
  private async requireAccessibleAsset(
    projectId: string,
    userId: string | undefined,
    assetId: string,
  ): Promise<StoredAssetReference> {
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
    return asset;
  }
}

type ResolvedAsset = {
  assetId: string;
  version: number;
  mediaType: MediaType;
  mimeType: string;
  contentKey: string;
  dataUrl: string;
  providerContentUrl?: string;
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

/** S3 资源读取器；可用独立公网 endpoint 为 Provider 签发同一对象的短期 URL。 */
export class S3AssetReferenceBlobStore implements AssetReferenceBlobStore {
  private readonly client: S3Client;
  private readonly providerClient?: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      endpoint?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
      providerEndpoint?: string;
    } = {},
  ) {
    if (!bucket.trim()) throw new Error('S3 bucket is required');
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {};
    const shared = {
      region: options.region ?? 'us-east-1',
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...credentials,
    };
    this.client = new S3Client({
      ...shared,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
    const providerEndpoint = options.providerEndpoint
      ? normalizeProviderAssetEndpoint(options.providerEndpoint)
      : undefined;
    this.providerClient = providerEndpoint
      ? new S3Client({ ...shared, endpoint: providerEndpoint })
      : undefined;
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

  /** 为同一 bucket/key 生成一小时以内的 Provider 只读 URL，不改写已签名 Host。 */
  async createProviderGetUrl(
    key: string,
    options: { expiresIn: number; contentType: string },
  ): Promise<string> {
    if (!this.providerClient) {
      throw new Error('S3_PROVIDER_ENDPOINT is required for provider-readable asset URLs');
    }
    return getSignedUrl(
      this.providerClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
    this.providerClient?.destroy();
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
        providerEndpoint: process.env.S3_PROVIDER_ENDPOINT?.trim() || undefined,
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

/**
 * 判断冻结素材是否必须由上游通过 HTTP(S) 拉取。
 * 仅列出已确认的精确模型家族，未知或旧模型继续沿用原 data URL 行为。
 */
function requiresProviderAssetUrl(
  snapshot: RunSnapshot,
  consumerNodeId: string,
  mediaType: MediaType,
): boolean {
  const consumer = snapshot.nodes.find((node) => node.id === consumerNodeId);
  if (consumer?.data.mediaType !== 'video') return false;
  const modelAlias =
    consumerNodeId === snapshot.targetNodeId
      ? snapshot.modelAlias
      : consumer.data.modelAlias?.trim();
  if (!modelAlias) return false;
  const family = videoFamilyForModel(modelAlias);
  if (family === 'wan3') return mediaType === 'video' || mediaType === 'audio';
  if (family === 'seedance-2' || family === 'seedance-2.5') return mediaType === 'video';
  return false;
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

async function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
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

import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { sanitizeExceptionForObservability } from '@multimodal-canvas/observability';
import type { Asset } from '@multimodal-canvas/domain';
import type { AssetScope, AssetStore, AssetVersionRecord } from './assets';
import type { MediaDerivativeGenerator } from './media';

/** 缩略图缓存的进程内上限；仅保存可重建字节，实例间不共享，不写原文件或数据库。 */
export const THUMBNAIL_CACHE_LIMITS = {
  maxEntries: 128,
  maxBytes: 32 * 1024 * 1024,
  maxConcurrent: 4,
  ttlMs: 15 * 60_000,
  failureTtlMs: 30_000,
} as const;

/** 可调整的缓存边界；时间以毫秒计，now 仅用于注入可测试时钟。 */
export type ThumbnailCacheOptions = {
  [Key in keyof typeof THUMBNAIL_CACHE_LIMITS]?: number;
} & { now?: () => number };

/** 已授权的缩略图请求；version 冻结版本，revision 仅区分无版本记录的历史资源。 */
export type ThumbnailRequest = {
  assetId: string;
  scope: AssetScope;
  version?: number;
  revision?: string;
};

/** 返回图像字节和源图尺寸；尺寸来自对应版本元数据，未知时不提供。 */
export type AssetThumbnail = {
  content: Buffer;
  mimeType: string;
  etag: string;
  originalWidth?: number;
  originalHeight?: number;
};

/** 安全暴露给 HTTP 的失败；cause 仅供服务器诊断，绝不作为原图回退信号。 */
export class AssetThumbnailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AssetThumbnailError';
  }
}

/** 一次授权索引快照；版本键包含存储身份、摘要和元数据，不信任客户端的最新版本声明。 */
type SourceSnapshot = {
  key: string;
  version?: AssetVersionRecord;
  latestVersion?: number;
  asset?: Asset;
};

/** 成功与短期失败共用条目上限；失败不持有源文件、转码输出或异常堆栈。 */
type CacheEntry = {
  expiresAt: number;
  bytes: number;
  result?: AssetThumbnail;
  failure?: { status: number; code: string; message: string };
};

/**
 * 版本感知缩略图服务。每次请求重新授权并检查版本索引，缓存命中不下载原图。
 * 同键任务共用 Promise；不同键最多并发四个，超限立即拒绝，不积压无限队列。
 */
export class AssetThumbnailService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AssetThumbnail>>();
  private readonly limits: { [Key in keyof typeof THUMBNAIL_CACHE_LIMITS]: number };
  private readonly now: () => number;
  private bytes = 0;

  /** 注入已包装 owner/project 权限策略的存储和现有生成器；无效缓存边界立即抛错。 */
  constructor(
    private readonly store: AssetStore,
    private readonly generator: MediaDerivativeGenerator,
    options: ThumbnailCacheOptions = {},
  ) {
    this.limits = { ...THUMBNAIL_CACHE_LIMITS, ...options };
    this.now = options.now ?? Date.now;
    for (const key of Object.keys(THUMBNAIL_CACHE_LIMITS) as Array<
      keyof typeof THUMBNAIL_CACHE_LIMITS
    >) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) {
        throw new Error(`invalid thumbnail cache limit: ${key}`);
      }
    }
  }

  /**
   * 获取指定源版本的缩略图；不存在或越权返回 404，非图片返回 415。
   * 源存储故障为 502；生成器不可用、转码失败或容量超限为 503，不返回原图字节。
   */
  async get(input: ThumbnailRequest): Promise<AssetThumbnail> {
    if (
      input.version !== undefined &&
      (!Number.isSafeInteger(input.version) || input.version < 1)
    ) {
      throw new AssetThumbnailError(400, 'invalid_asset_version', 'invalid asset version');
    }
    if (input.revision !== undefined && input.revision.length > 256) {
      throw new AssetThumbnailError(
        400,
        'invalid_thumbnail_revision',
        'invalid thumbnail revision',
      );
    }
    const source = await this.snapshot(input);
    this.prune();
    const cached = this.entries.get(source.key);
    if (cached) {
      this.entries.delete(source.key);
      this.entries.set(source.key, cached);
      if (cached.failure) {
        throw new AssetThumbnailError(
          cached.failure.status,
          cached.failure.code,
          cached.failure.message,
        );
      }
      return cached.result!;
    }
    const pending = this.inflight.get(source.key);
    if (pending) {
      const result = await pending;
      // 同键可能同时来自冻结 URL 与 latest；每个等待者都需按自己的请求重查权限和修订。
      if ((await this.snapshot(input)).key !== source.key) throw sourceChanged();
      return result;
    }
    if (this.inflight.size >= this.limits.maxConcurrent) {
      throw new AssetThumbnailError(503, 'thumbnail_busy', 'thumbnail generation is busy');
    }
    const task = this.generate(input, source)
      .then(
        (result) => {
          this.remember(source.key, {
            result,
            bytes: result.content.byteLength,
            expiresAt: this.now() + this.limits.ttlMs,
          });
          return result;
        },
        (error: unknown) => {
          const failure =
            error instanceof AssetThumbnailError
              ? error
              : new AssetThumbnailError(
                  502,
                  'thumbnail_source_unavailable',
                  'thumbnail source unavailable',
                  { cause: error },
                );
          // 变更中的源和撤销的权限必须即时重查，不能把它们固化到负缓存。
          if (failure.status !== 409 && failure.status !== 404) {
            this.remember(source.key, {
              bytes: 0,
              expiresAt: this.now() + this.limits.failureTtlMs,
              failure: { status: failure.status, code: failure.code, message: failure.message },
            });
          }
          throw failure;
        },
      )
      .finally(() => this.inflight.delete(source.key));
    this.inflight.set(source.key, task);
    return task;
  }

  /** 只读取授权索引以识别版本；无版本资源通过授权元数据列表识别变更，v 不覆盖服务器摘要。 */
  private async snapshot(input: ThumbnailRequest): Promise<SourceSnapshot> {
    try {
      const versions = await this.store.listVersions(input.assetId, input.scope);
      const latestVersion = versions.reduce(
        (latest, record) => Math.max(latest, record.version),
        0,
      );
      const version = versions.find(
        (record) => record.version === (input.version ?? latestVersion),
      );
      if (input.version !== undefined && !version) throw notFound();
      const asset = version
        ? undefined
        : (await this.store.list(input.scope)).find((entry) => entry.id === input.assetId);
      if (!version && !asset) throw notFound();
      const identity = version
        ? [
            version.id,
            version.version,
            version.contentKey,
            version.sha256,
            version.sizeBytes,
            version.createdAt,
            version.metadata,
          ]
        : [asset!.sha256, asset!.sizeBytes, asset!.contentUrl, asset!.metadata, input.revision];
      const key = createHash('sha256')
        .update(
          JSON.stringify([input.scope, input.assetId, version ? 'version' : 'legacy', identity]),
        )
        .digest('hex');
      return { key, version, latestVersion, asset };
    } catch (error) {
      if (error instanceof AssetThumbnailError) throw error;
      throw new AssetThumbnailError(
        502,
        'thumbnail_source_unavailable',
        'thumbnail source unavailable',
        { cause: error },
      );
    }
  }

  /** 冷缓存读取源版本，初始版本可复用旧缩略图；绝不以当前衍生图替代历史版本。 */
  private async generate(input: ThumbnailRequest, source: SourceSnapshot): Promise<AssetThumbnail> {
    // list 不读取对象字节；空 owner 的已授权项目旧资源可能不在 owner 列表中，再走原权限 get。
    const asset =
      source.asset ??
      (await this.store.list(input.scope)).find((entry) => entry.id === input.assetId) ??
      (await this.store.get(input.assetId, input.scope));
    if (!asset) throw notFound();
    if (asset.mediaType !== 'image') {
      throw new AssetThumbnailError(
        415,
        'thumbnail_not_supported',
        'thumbnail requires an image asset',
      );
    }
    const dimensions = originalDimensions(
      source.version ? source.version.metadata : asset.metadata,
    );
    // 旧生成器固定宽度 640：已知竖图或小图须从原版本重建。未知尺寸的旧图可复用，
    // 但不保证其长边 <= 640，也不将缩略图尺寸冒充原尺寸。
    const needsResize =
      dimensions.originalWidth !== undefined &&
      dimensions.originalHeight !== undefined &&
      (dimensions.originalHeight > dimensions.originalWidth || dimensions.originalWidth < 640);
    let derivative: { content: Buffer; mimeType: string } | undefined =
      !needsResize &&
      ((!source.version && !source.latestVersion) ||
        (source.version?.version === 1 && source.latestVersion === 1))
        ? await this.store.getDerivative(input.assetId, 'thumbnail', input.scope)
        : undefined;
    if (derivative) {
      const current = await this.snapshot(input);
      if (current.key !== source.key) throw sourceChanged();
      // 当前衍生图没有版本读取合同：读取期间新增版本时丢弃它，转而读取冻结源版本。
      if (current.latestVersion !== source.latestVersion) derivative = undefined;
    }
    if (!derivative) {
      const content = source.version
        ? await this.store.getVersionContent(input.assetId, source.version.version, input.scope)
        : (await this.store.get(input.assetId, input.scope))?.content;
      if (!content) throw notFound();
      try {
        derivative = (
          await this.generator.generate({ content, mediaType: 'image', mimeType: asset.mimeType })
        ).find((entry) => entry.kind === 'thumbnail');
      } catch (error) {
        throw new AssetThumbnailError(
          503,
          'thumbnail_unavailable',
          'thumbnail generation unavailable',
          { cause: error },
        );
      }
    }
    if (
      !derivative ||
      !derivative.content.byteLength ||
      !/^image\/(jpeg|png|webp|avif|gif)$/.test(derivative.mimeType)
    ) {
      throw new AssetThumbnailError(
        503,
        'thumbnail_unavailable',
        'thumbnail generation unavailable',
      );
    }
    if (derivative.content.byteLength > this.limits.maxBytes) {
      throw new AssetThumbnailError(
        503,
        'thumbnail_too_large',
        'thumbnail exceeds cache byte limit',
      );
    }
    if ((await this.snapshot(input)).key !== source.key) throw sourceChanged();
    return {
      content: derivative.content,
      mimeType: derivative.mimeType,
      etag: `"${createHash('sha256').update(source.key).update(derivative.content).digest('hex')}"`,
      ...dimensions,
    };
  }

  /** 淘汰过期项；失败与成功共用有限 LRU，释放全部关联字节引用。 */
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.remove(key);
    }
  }

  /** 删除单个条目并同步实际缓存字节数。 */
  private remove(key: string): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }

  /** 写入前按条目数和字节数双重淘汰最久未访问项，不保存原图。 */
  private remember(key: string, entry: CacheEntry): void {
    this.prune();
    this.remove(key);
    while (
      this.entries.size >= this.limits.maxEntries ||
      this.bytes + entry.bytes > this.limits.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
  }
}

/** 只接受源元数据中的正整像素；缺失、字符串、NaN 和非整数都不冒充原尺寸。 */
function originalDimensions(
  metadata: Record<string, unknown> | undefined,
): Pick<AssetThumbnail, 'originalWidth' | 'originalHeight'> {
  const width = metadata?.width;
  const height = metadata?.height;
  return {
    ...(typeof width === 'number' && Number.isSafeInteger(width) && width > 0
      ? { originalWidth: width }
      : {}),
    ...(typeof height === 'number' && Number.isSafeInteger(height) && height > 0
      ? { originalHeight: height }
      : {}),
  };
}

/** 统一隐藏资源不存在、源版本缺失与越权的差异。 */
function notFound(): AssetThumbnailError {
  return new AssetThumbnailError(404, 'thumbnail_not_found', 'asset thumbnail not found');
}

/** 可变源在生成期间发生变化，要求调用方重新发起请求，不发布过期结果。 */
function sourceChanged(): AssetThumbnailError {
  return new AssetThumbnailError(
    409,
    'thumbnail_source_changed',
    'thumbnail source changed; retry request',
  );
}

/**
 * 输出 Cookie 会话或 Bearer 可读的预览；冻结版和 latest 均要求浏览器重验证。
 * 条件请求仍先鉴权。Vary 隔离 Cookie、Authorization 并保留 Origin，不扩展签名合同。
 */
export async function sendAssetThumbnail(
  service: AssetThumbnailService,
  input: ThumbnailRequest,
  reply: FastifyReply,
  ifNoneMatch?: string,
): Promise<unknown> {
  reply.header('cache-control', 'private, no-store');
  try {
    const thumbnail = await service.get(input);
    const vary = String(reply.getHeader('vary') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const header of ['Cookie', 'Authorization']) {
      if (!vary.some((entry) => entry.toLowerCase() === header.toLowerCase())) vary.push(header);
    }
    reply
      .header('vary', vary.join(', '))
      .header(
        'cache-control',
        input.version === undefined ? 'private, max-age=0, must-revalidate' : 'private, no-cache',
      )
      .header('etag', thumbnail.etag)
      .header('x-content-type-options', 'nosniff')
      .type(thumbnail.mimeType);
    if (thumbnail.originalWidth !== undefined)
      reply.header('x-original-width', thumbnail.originalWidth);
    if (thumbnail.originalHeight !== undefined)
      reply.header('x-original-height', thumbnail.originalHeight);
    if (
      ifNoneMatch
        ?.split(',')
        .some(
          (entry) => entry.trim() === '*' || entry.trim().replace(/^W\//, '') === thumbnail.etag,
        )
    ) {
      return reply.code(304).send();
    }
    return reply.send(thumbnail.content);
  } catch (error) {
    if (!(error instanceof AssetThumbnailError)) throw error;
    if (error.status >= 500) {
      reply.log.warn(
        { err: sanitizeExceptionForObservability(error), assetId: input.assetId },
        '缩略图请求失败',
      );
      reply.header(
        'retry-after',
        error.code === 'thumbnail_busy' ? '1' : String(THUMBNAIL_CACHE_LIMITS.failureTtlMs / 1000),
      );
    }
    if (error.status === 409) reply.header('retry-after', '1');
    return reply.code(error.status).send({ error: error.message, code: error.code });
  }
}

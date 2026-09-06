import { buildApp } from './app';
import { PrismaClient } from '@prisma/client';
import type { NewApiVideoContract } from '@multimodal-canvas/providers';
import { FileSystemBlobStore, MemoryAssetStore, PrismaAssetStore, S3BlobStore } from './assets';
import { FileProjectStore, PrismaProjectStore } from './projects';
import { BullMqRunService, MemoryRunService, redisConnectionFromUrl } from './runs';
import { FileAiSettingsStore } from './file-ai-settings';
import { PrismaAiSettingsStore } from './settings';
import { PrismaWebhookEventStore } from './webhooks';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';
import { PrismaUploadSessionStore } from './upload-sessions';
import { PrismaRunPersistence } from './run-persistence';
import { PrismaAuthStore } from './auth-store';
import { FileAuthStore } from './file-auth-store';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { createApiRateLimiter } from './runtime-rate-limit';
import { assertApiStartupConfiguration } from './startup-config';
import { resolveS3DownloadMode, resolveS3UploadMode } from './upload-transport';

assertApiStartupConfiguration();

/** 上传传输方式在客户端初始化前完成校验，proxy 仍使用同一 S3 存储和 TLS 配置。 */
const s3UploadMode = resolveS3UploadMode(process.env.S3_UPLOAD_MODE);
/** 下载代理仅改用 API 短期签名路径，保留同一 S3 后端及资源授权边界。 */
const s3DownloadMode = resolveS3DownloadMode(process.env.S3_DOWNLOAD_MODE);
const prisma = process.env.DATABASE_URL ? new PrismaClient() : undefined;
const rateLimiter = await createApiRateLimiter();
const authStore = prisma ? new PrismaAuthStore(prisma) : new FileAuthStore();
if (authStore instanceof FileAuthStore) await authStore.initialize();
const runPersistence = prisma ? new PrismaRunPersistence(prisma) : undefined;
const providerName = process.env.WORKER_PROVIDER === 'mock' ? 'mock' : 'newapi';
if (!prisma && providerName === 'newapi' && process.env.RUN_SERVICE === 'bullmq') {
  throw new Error(
    'RUN_SERVICE=bullmq with WORKER_PROVIDER=newapi requires DATABASE_URL; local file credentials are not shared with the worker',
  );
}
// 本地开发也要跨 API 重启保留已加密的凭据；测试直接调用 buildApp 时仍使用隔离内存存储。
const settingsStore = prisma ? new PrismaAiSettingsStore(prisma) : new FileAiSettingsStore();
// 在创建执行器和监听端口前完成设置存储初始化，避免坏文件、丢密钥或数据库故障
// 让 API 先对外提供服务，再在第一条请求或后台任务中失败。
await settingsStore.get();
const runExecutor =
  providerName === 'newapi'
    ? createNewApiRunExecutor({
        settingsStore,
        videoContract: (process.env.NEW_API_VIDEO_CONTRACT ??
          'newapi-unified-v1') as NewApiVideoContract,
        timeoutMs: Number(process.env.NEW_API_TIMEOUT_MS ?? 120_000),
        responseMaxBytes: Number(process.env.NEW_API_MAX_RESPONSE_BYTES ?? 50 * 1024 * 1024),
        ...(process.env.NEW_API_VIDEO_POLL_INTERVAL_MS
          ? { videoPollIntervalMs: Number(process.env.NEW_API_VIDEO_POLL_INTERVAL_MS) }
          : {}),
        ...(process.env.NEW_API_VIDEO_MAX_POLL_ATTEMPTS
          ? { videoMaxPollAttempts: Number(process.env.NEW_API_VIDEO_MAX_POLL_ATTEMPTS) }
          : {}),
        ...(process.env.NEW_API_VIDEO_MAX_CONTENT_BYTES
          ? { videoMaxContentBytes: Number(process.env.NEW_API_VIDEO_MAX_CONTENT_BYTES) }
          : {}),
        requireHttps: process.env.NODE_ENV === 'production',
      })
    : undefined;
const useMemoryRunService =
  process.env.RUN_SERVICE === 'memory' ||
  (process.env.NODE_ENV !== 'production' && process.env.RUN_SERVICE !== 'bullmq');
const runService = useMemoryRunService
  ? new MemoryRunService({
      providerName,
      ...(runExecutor ? { executor: runExecutor } : {}),
    })
  : new BullMqRunService({
      connection: redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      ...(process.env.RUN_QUEUE_NAME?.trim()
        ? { queueName: process.env.RUN_QUEUE_NAME.trim() }
        : {}),
      providerName,
      ...(runPersistence ? { persistence: runPersistence } : {}),
    });
// Keep local projects across API restarts when PostgreSQL is not configured.
// Tests that call buildApp() directly still receive the isolated in-memory
// store; this durable fallback is only used by the runnable API entrypoint.
const projectStore = prisma ? new PrismaProjectStore(prisma) : new FileProjectStore();
const blobStore = prisma
  ? process.env.S3_BUCKET
    ? new S3BlobStore(process.env.S3_BUCKET, {
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      })
    : new FileSystemBlobStore(process.env.ASSET_STORAGE_ROOT ?? '.data/assets')
  : undefined;
const assetStore = prisma
  ? new PrismaAssetStore(prisma, blobStore ? { blobStore } : {})
  : new MemoryAssetStore();
const uploadSessionStore = prisma
  ? new PrismaUploadSessionStore(prisma, {
      blobStore: blobStore!,
      ...(blobStore instanceof S3BlobStore && s3UploadMode === 'direct'
        ? {
            uploadUrlForKey: (contentKey) =>
              blobStore.createPresignedPutUrl(contentKey, {
                expiresIn: 15 * 60,
              }),
          }
        : {}),
    })
  : undefined;
const mediaMetadataExtractor =
  process.env.FFPROBE_ENABLED === 'true' || process.env.FFPROBE_PATH
    ? new FfprobeMediaMetadataExtractor({ binary: process.env.FFPROBE_PATH })
    : undefined;
const mediaDerivativeGenerator =
  process.env.FFMPEG_ENABLED === 'true' || process.env.FFMPEG_PATH
    ? new FfmpegMediaDerivativeGenerator({ binary: process.env.FFMPEG_PATH })
    : undefined;
const app = buildApp({
  s3DownloadMode,
  runService,
  ...(runExecutor ? { runExecutor } : {}),
  settingsStore,
  ...(runPersistence ? { runPersistence } : {}),
  ...(authStore ? { authStore } : {}),
  ...(prisma
    ? {
        userExists: async (userId: string) =>
          (await authStore.findUserById(userId))?.status === 'active',
      }
    : {}),
  ...(prisma ? { webhookEventStore: new PrismaWebhookEventStore(prisma) } : {}),
  assetStore,
  projectStore,
  ...(uploadSessionStore ? { uploadSessionStore } : {}),
  ...(mediaMetadataExtractor ? { mediaMetadataExtractor } : {}),
  ...(mediaDerivativeGenerator ? { mediaDerivativeGenerator } : {}),
  rateLimiter,
});
const port = Number(process.env.API_PORT ?? 3000);
const host =
  process.env.API_HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

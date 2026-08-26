import { buildApp } from './app';
import { PrismaClient } from '@prisma/client';
import { FileSystemBlobStore, MemoryAssetStore, PrismaAssetStore, S3BlobStore } from './assets';
import { FileProjectStore, PrismaProjectStore } from './projects';
import { BullMqRunService, MemoryRunService, redisConnectionFromUrl } from './runs';
import { AiSettingsStore, PrismaAiSettingsStore } from './settings';
import { PrismaWebhookEventStore } from './webhooks';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';
import { PrismaUploadSessionStore } from './upload-sessions';
import { PrismaRunPersistence } from './run-persistence';
import { PrismaAuthStore } from './auth-store';
import { createNewApiRunExecutor } from './newapi-run-executor';

const prisma = process.env.DATABASE_URL ? new PrismaClient() : undefined;
const authStore = prisma ? new PrismaAuthStore(prisma) : undefined;
const runPersistence = prisma ? new PrismaRunPersistence(prisma) : undefined;
const providerName = process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock';
const settingsStore = prisma ? new PrismaAiSettingsStore(prisma) : new AiSettingsStore();
const runExecutor =
  providerName === 'newapi'
    ? createNewApiRunExecutor({
        settingsStore,
        timeoutMs: Number(process.env.NEW_API_TIMEOUT_MS ?? 120_000),
        ...(process.env.NEW_API_VIDEO_PATH ? { videoPath: process.env.NEW_API_VIDEO_PATH } : {}),
        ...(process.env.NEW_API_VIDEO_CREATE_PATH
          ? { videoCreatePath: process.env.NEW_API_VIDEO_CREATE_PATH }
          : {}),
        ...(process.env.NEW_API_VIDEO_JOBS_PATH
          ? { videoJobsPath: process.env.NEW_API_VIDEO_JOBS_PATH }
          : {}),
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
      ...(blobStore instanceof S3BlobStore
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
  runService,
  ...(runExecutor ? { runExecutor } : {}),
  settingsStore,
  ...(authStore ? { authStore } : {}),
  ...(prisma
    ? {
        userExists: async (userId: string) => Boolean(await authStore!.findUserById(userId)),
      }
    : {}),
  ...(prisma ? { webhookEventStore: new PrismaWebhookEventStore(prisma) } : {}),
  assetStore,
  projectStore,
  ...(uploadSessionStore ? { uploadSessionStore } : {}),
  ...(mediaMetadataExtractor ? { mediaMetadataExtractor } : {}),
  ...(mediaDerivativeGenerator ? { mediaDerivativeGenerator } : {}),
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

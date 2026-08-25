import { buildApp } from './app';
import { PrismaClient } from '@prisma/client';
import { FileSystemBlobStore, MemoryAssetStore, PrismaAssetStore, S3BlobStore } from './assets';
import { PrismaProjectStore } from './projects';
import { BullMqRunService, MemoryRunService, redisConnectionFromUrl } from './runs';
import { AiSettingsStore, PrismaAiSettingsStore } from './settings';
import { PrismaWebhookEventStore } from './webhooks';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';
import { PrismaUploadSessionStore } from './upload-sessions';
import { PrismaRunPersistence } from './run-persistence';

const prisma = process.env.DATABASE_URL ? new PrismaClient() : undefined;
const runPersistence = prisma ? new PrismaRunPersistence(prisma) : undefined;
const useMemoryRunService =
  process.env.RUN_SERVICE === 'memory' ||
  (process.env.NODE_ENV !== 'production' && process.env.RUN_SERVICE !== 'bullmq');
const runService = useMemoryRunService
  ? new MemoryRunService({
      providerName: process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock',
    })
  : new BullMqRunService({
      connection: redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      providerName: process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock',
      ...(runPersistence ? { persistence: runPersistence } : {}),
    });
const projectStore = prisma ? new PrismaProjectStore(prisma) : undefined;
const settingsStore = prisma ? new PrismaAiSettingsStore(prisma) : new AiSettingsStore();
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
  settingsStore,
  ...(prisma
    ? {
        userExists: async (userId: string) =>
          Boolean(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })),
      }
    : {}),
  ...(prisma ? { webhookEventStore: new PrismaWebhookEventStore(prisma) } : {}),
  assetStore,
  ...(projectStore ? { projectStore } : {}),
  ...(uploadSessionStore ? { uploadSessionStore } : {}),
  ...(mediaMetadataExtractor ? { mediaMetadataExtractor } : {}),
  ...(mediaDerivativeGenerator ? { mediaDerivativeGenerator } : {}),
});
const port = Number(process.env.API_PORT ?? 3000);

try {
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

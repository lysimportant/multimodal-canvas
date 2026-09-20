import { buildApp } from './app';
import { FilePromptSkillStore, PrismaPromptSkillStore } from './prompt-skill-store';
import { PrismaClient } from '@prisma/client';
import { PrismaExecutionService } from '@multimodal-canvas/execution';
import { createCredentialEncryptionKeyringFromEnvironment } from '@multimodal-canvas/credential-crypto';
import { NewApiAccountClient } from './newapi-account-client';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings } from './newapi-account-settings';
import { AuthService } from './auth-service';
import type { NewApiVideoContract } from '@multimodal-canvas/providers';
import { FileSystemBlobStore, MemoryAssetStore, PrismaAssetStore, S3BlobStore } from './assets';
import { FileProjectStore, PrismaProjectStore } from './projects';
import { BullMqRunService, MemoryRunService, redisConnectionFromUrl } from './runs';
import { PrismaWebhookEventStore } from './webhooks';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';
import { PrismaUploadSessionStore } from './upload-sessions';
import { PrismaRunPersistence } from './run-persistence';
import { PrismaAuthStore } from './auth-store';
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
const runPersistence = prisma ? new PrismaRunPersistence(prisma) : undefined;
const providerName = process.env.WORKER_PROVIDER === 'mock' ? 'mock' : 'newapi';
if (
  !prisma ||
  !process.env.API_JWT_SECRET ||
  !process.env.NEW_API_ISSUER ||
  !process.env.NEW_API_CLIENT_ID ||
  !process.env.NEW_API_INSTANCE_ID ||
  !process.env.NEW_API_REDIRECT_URI ||
  !process.env.CANVAS_WEB_URL
)
  throw new Error(
    'New API 唯一登录需要 DATABASE_URL、API_JWT_SECRET、NEW_API_ISSUER、NEW_API_CLIENT_ID、NEW_API_INSTANCE_ID、NEW_API_REDIRECT_URI 和 CANVAS_WEB_URL',
  );
/** New API 唯一登录使用可撤销应用会话和已有服务端加密密钥环。 */
const authStore = new PrismaAuthStore(prisma);
const authService = new AuthService({ store: authStore, jwtSecret: process.env.API_JWT_SECRET });
const newApiAccount = new NewApiAccountService({
  prisma,
  auth: authService,
  keyring: createCredentialEncryptionKeyringFromEnvironment(),
  client: new NewApiAccountClient({
    issuer: process.env.NEW_API_ISSUER,
    clientId: process.env.NEW_API_CLIENT_ID,
    instanceId: process.env.NEW_API_INSTANCE_ID,
    redirectUri: process.env.NEW_API_REDIRECT_URI,
    clientSecret: process.env.NEW_API_CLIENT_SECRET,
  }),
  webUrl: process.env.CANVAS_WEB_URL,
  adminExternalIds: process.env.NEW_API_ADMIN_USER_IDS?.split(',')
    .map((id) => id.trim())
    .filter(Boolean),
});
const execution = new PrismaExecutionService(prisma);
/** 所有环境均使用本人 New API 目录，测试通过 buildApp 显式注入替身。 */
const settingsStore = new NewApiAccountSettings(newApiAccount);
/** 本地和数据库部署均保存各用户自定义 Skill 与内置覆盖。 */
const promptSkillStore = prisma ? new PrismaPromptSkillStore(prisma) : new FilePromptSkillStore();
if (promptSkillStore instanceof FilePromptSkillStore) await promptSkillStore.initialize();
const runExecutor =
  providerName === 'newapi'
    ? createNewApiRunExecutor({
        settingsStore,
        videoContract: (process.env.NEW_API_VIDEO_CONTRACT ??
          'newapi-video-v1') as NewApiVideoContract,
        ...(process.env.NEW_API_TIMEOUT_MS?.trim()
          ? { timeoutMs: Number(process.env.NEW_API_TIMEOUT_MS) }
          : {}),
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
if (providerName === 'newapi' && (!prisma || useMemoryRunService)) {
  throw new Error(
    '正式模型调用要求 DATABASE_URL 与 RUN_SERVICE=bullmq，以保证执行授权、发送意图和恢复持久化',
  );
}
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
      execution,
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
  newApiAccount,
  authService,
  promptSkillStore,
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
/** 只恢复已原子受理的 outbox；失败保留记录，后续按相同任务身份重投。 */
let dispatching = false;
const outboxTimer =
  runService instanceof BullMqRunService
    ? setInterval(() => {
        if (dispatching) return;
        dispatching = true;
        void runService
          .dispatchOutbox()
          .catch(() => app.log.warn({ code: 'outbox_publish_failed' }, '已授权任务等待队列恢复'))
          .finally(() => {
            dispatching = false;
          });
      }, 5_000)
    : undefined;
outboxTimer?.unref();
/** 撤销已经本地落库，远端暂时不可用时由后台继续完成同一撤销。 */
let revoking = false;
const revocationTimer = setInterval(() => {
  if (revoking) return;
  revoking = true;
  void newApiAccount
    .retryRevocations()
    .catch(() => app.log.warn({ code: 'newapi_revocation_pending' }, 'New API 授权撤销等待恢复'))
    .finally(() => {
      revoking = false;
    });
}, 30_000);
revocationTimer.unref();
app.addHook('onClose', async () => {
  if (outboxTimer) clearInterval(outboxTimer);
  clearInterval(revocationTimer);
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

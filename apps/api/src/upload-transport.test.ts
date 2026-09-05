import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UploadSessionStore } from './upload-sessions';
import {
  resolveS3DownloadMode,
  resolveS3UploadMode,
  type S3DownloadMode,
} from './upload-transport';

/** 入口外部边界的隔离替身，禁止测试连接数据库、Redis、Provider 或真实监听端口。 */
const entryMocks = vi.hoisted(() => ({
  buildApp:
    vi.fn<
      (options: {
        uploadSessionStore?: UploadSessionStore;
        s3DownloadMode?: S3DownloadMode;
      }) => unknown
    >(),
  listen: vi.fn(async () => ''),
  createPrisma: vi.fn(),
  createRateLimiter: vi.fn(async () => ({})),
  createQueue: vi.fn(),
  prisma: {
    uploadSession: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('./app', () => ({ buildApp: entryMocks.buildApp }));
vi.mock('@prisma/client', () => ({
  /** 仅返回内存查询替身，不创建 Prisma 连接。 */
  PrismaClient: class {
    constructor() {
      entryMocks.createPrisma();
      return entryMocks.prisma;
    }
  },
}));
vi.mock('./runtime-rate-limit', () => ({ createApiRateLimiter: entryMocks.createRateLimiter }));
vi.mock('./runs', () => ({
  /** 记录队列选择但不连接 Redis。 */
  BullMqRunService: class {
    constructor() {
      entryMocks.createQueue();
    }
  },
  MemoryRunService: vi.fn(),
  redisConnectionFromUrl: vi.fn(() => ({})),
}));
vi.mock('./settings', () => ({
  /** 初始化时不读取数据库或 Provider 设置。 */
  PrismaAiSettingsStore: class {
    /** 返回隔离设置，避免入口初始化触发外部请求。 */
    async get() {
      return {};
    }
  },
}));
vi.mock('./file-ai-settings', () => ({ FileAiSettingsStore: vi.fn() }));
vi.mock('./newapi-run-executor', () => ({ createNewApiRunExecutor: vi.fn() }));

/** 合成生产配置，只用于通过入口校验；所有外部连接均由测试替身接管。 */
const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://test:test@database.example:5432/canvas',
  REDIS_URL: 'rediss://redis.example:6379',
  S3_BUCKET: 'upload-transport-test',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: 'https://minio.example:9000',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-secret',
  API_JWT_SECRET: 'test-jwt-secret',
  API_PORT: '3000',
  API_HOST: '0.0.0.0',
  NEW_API_WEBHOOK_SECRET: 'test-webhook-secret',
  WORKER_PROVIDER: 'newapi',
  RUN_SERVICE: 'bullmq',
  CORS_ORIGIN: undefined,
  NEW_API_BASE_URL: undefined,
  NEW_API_API_KEY: undefined,
  S3_UPLOAD_MODE: undefined,
  S3_DOWNLOAD_MODE: undefined,
  API_TRUST_PROXY_HOPS: undefined,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [name, value] of Object.entries(productionEnvironment)) vi.stubEnv(name, value);
  entryMocks.buildApp.mockReturnValue({ listen: entryMocks.listen, log: { error: vi.fn() } });
  entryMocks.prisma.uploadSession.findFirst.mockResolvedValue({
    uploadId: 'upload-test',
    name: 'sample.png',
    mimeType: 'image/png',
    mediaType: 'IMAGE',
    sizeBytes: 5n,
    sha256: 'a'.repeat(64),
    tags: [],
    ownerId: 'owner-test',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T00:15:00Z'),
  });
  entryMocks.prisma.uploadSession.findUnique.mockResolvedValue({
    contentKey: 'uploads/upload-test',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('S3 upload mode parsing', () => {
  it('preserves direct uploads only when the setting is absent or explicitly direct', () => {
    expect(resolveS3UploadMode(undefined)).toBe('direct');
    expect(resolveS3UploadMode('direct')).toBe('direct');
    expect(resolveS3UploadMode('proxy')).toBe('proxy');
  });

  it.each(['', ' ', 'Proxy', 'DIRECT', ' proxy', 'direct ', 'unsupported'])(
    'rejects %j instead of falling back',
    (value) => {
      expect(() => resolveS3UploadMode(value)).toThrow(
        'S3_UPLOAD_MODE must be "proxy" or "direct"',
      );
    },
  );
});

describe('S3 download mode parsing', () => {
  it('defaults only missing configuration to direct and accepts explicit proxy', () => {
    expect(resolveS3DownloadMode(undefined)).toBe('direct');
    expect(resolveS3DownloadMode('direct')).toBe('direct');
    expect(resolveS3DownloadMode('proxy')).toBe('proxy');
  });

  it.each(['', ' ', 'Proxy', 'DIRECT', ' proxy', 'direct ', 'unsupported'])(
    'rejects %j instead of falling back',
    (value) => {
      expect(() => resolveS3DownloadMode(value)).toThrow(
        'S3_DOWNLOAD_MODE must be "proxy" or "direct"',
      );
    },
  );
});

describe('API entrypoint download transport', () => {
  it.each([undefined, 'direct', 'proxy'])(
    'injects the validated download mode %s',
    async (mode) => {
      vi.stubEnv('S3_DOWNLOAD_MODE', mode);
      await import('./index');
      expect(entryMocks.buildApp.mock.calls[0]?.[0].s3DownloadMode).toBe(mode ?? 'direct');
      expect(entryMocks.listen).toHaveBeenCalledOnce();
    },
  );

  it.each(['production', 'development', 'test'])(
    'rejects invalid download mode before constructing clients in %s',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('S3_DOWNLOAD_MODE', 'unsupported');
      await expect(import('./index')).rejects.toThrow(
        'S3_DOWNLOAD_MODE must be "proxy" or "direct"',
      );
      expect(entryMocks.createPrisma).not.toHaveBeenCalled();
      expect(entryMocks.createRateLimiter).not.toHaveBeenCalled();
      expect(entryMocks.createQueue).not.toHaveBeenCalled();
      expect(entryMocks.buildApp).not.toHaveBeenCalled();
      expect(entryMocks.listen).not.toHaveBeenCalled();
    },
  );
});

describe('API entrypoint proxy trust validation', () => {
  it.each(['production', 'development', 'test'])(
    'rejects unbounded trust before constructing clients in %s',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('API_TRUST_PROXY_HOPS', 'true');
      await expect(import('./index')).rejects.toThrow('API_TRUST_PROXY_HOPS must be "0" or "1"');
      expect(entryMocks.createPrisma).not.toHaveBeenCalled();
      expect(entryMocks.createRateLimiter).not.toHaveBeenCalled();
      expect(entryMocks.createQueue).not.toHaveBeenCalled();
      expect(entryMocks.buildApp).not.toHaveBeenCalled();
      expect(entryMocks.listen).not.toHaveBeenCalled();
    },
  );
});

describe('API entrypoint upload transport', () => {
  it.each([undefined, 'direct'])('retains 15-minute S3 signing for mode %s', async (mode) => {
    vi.stubEnv('S3_UPLOAD_MODE', mode);
    const { S3BlobStore } = await import('./assets');
    const presign = vi
      .spyOn(S3BlobStore.prototype, 'createPresignedPutUrl')
      .mockResolvedValue('https://minio.example:9000/signed-upload');
    await import('./index');

    const store = entryMocks.buildApp.mock.calls[0]?.[0].uploadSessionStore;
    expect(store).toBeDefined();
    expect(await store!.getUploadUrl('upload-test', { ownerId: 'owner-test' })).toBe(
      'https://minio.example:9000/signed-upload',
    );
    expect(presign).toHaveBeenCalledExactlyOnceWith('uploads/upload-test', { expiresIn: 900 });
    expect(entryMocks.listen).toHaveBeenCalledExactlyOnceWith({ host: '0.0.0.0', port: 3000 });
  });

  it('omits external upload URLs in proxy mode while retaining S3 writes', async () => {
    vi.stubEnv('S3_UPLOAD_MODE', 'proxy');
    const { S3BlobStore } = await import('./assets');
    const presign = vi
      .spyOn(S3BlobStore.prototype, 'createPresignedPutUrl')
      .mockRejectedValue(new Error('proxy must not request a presigned URL'));
    const put = vi.spyOn(S3BlobStore.prototype, 'put').mockResolvedValue();
    await import('./index');

    const store = entryMocks.buildApp.mock.calls[0]?.[0].uploadSessionStore;
    expect(store).toBeDefined();
    expect(await store!.getUploadUrl('upload-test', { ownerId: 'owner-test' })).toBeUndefined();
    expect(presign).not.toHaveBeenCalled();
    const content = Buffer.from('hello');
    await store!.putContent('upload-test', content, { ownerId: 'owner-test' });
    expect(put).toHaveBeenCalledExactlyOnceWith('uploads/upload-test', content);
    expect(entryMocks.createQueue).toHaveBeenCalledOnce();
    expect(entryMocks.listen).toHaveBeenCalledExactlyOnceWith({ host: '0.0.0.0', port: 3000 });
  });

  it.each(['production', 'development', 'test'])(
    'rejects invalid mode before constructing clients in %s',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('S3_UPLOAD_MODE', 'unsupported');
      await expect(import('./index')).rejects.toThrow('S3_UPLOAD_MODE must be "proxy" or "direct"');
      expect(entryMocks.createPrisma).not.toHaveBeenCalled();
      expect(entryMocks.createRateLimiter).not.toHaveBeenCalled();
      expect(entryMocks.createQueue).not.toHaveBeenCalled();
      expect(entryMocks.buildApp).not.toHaveBeenCalled();
      expect(entryMocks.listen).not.toHaveBeenCalled();
    },
  );
});

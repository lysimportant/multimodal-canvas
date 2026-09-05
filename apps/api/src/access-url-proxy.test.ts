import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type BuildAppOptions } from './app';
import { MemoryAssetStore, type AssetStore } from './assets';
import { signHs256Jwt } from './auth';
import type { S3DownloadMode } from './upload-transport';

/** 只用于内存 HTTP 请求的合成 JWT 密钥，不连接数据库或 Provider。 */
const jwtSecret = 'access-url-proxy-test-secret';
/** 合成用户 ID 遵循生产认证要求的 UUID 格式。 */
const ownerId = '11111111-1111-4111-8111-111111111111';
/** 用于验证跨所有者隔离的第二个合成用户。 */
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
/** 跟踪测试创建的实例，确保失败路径也释放内部计时器。 */
const apps: FastifyInstance[] = [];
/** 覆盖原文件、固定版本及所有派生预览的签名资源边界。 */
const resources = [
  { name: 'content', body: {}, path: '/content', content: 'source-bytes', mimeType: 'image/png' },
  {
    name: 'version',
    body: { version: 1 },
    path: '/versions/1/content',
    content: 'source-bytes',
    mimeType: 'image/png',
  },
  {
    name: 'thumbnail',
    body: { derivative: 'thumbnail' },
    path: '/derivatives/thumbnail',
    content: 'thumbnail-bytes',
    mimeType: 'image/jpeg',
  },
  {
    name: 'poster',
    body: { derivative: 'poster' },
    path: '/derivatives/poster',
    content: 'poster-bytes',
    mimeType: 'image/jpeg',
  },
  {
    name: 'waveform',
    body: { derivative: 'waveform' },
    path: '/derivatives/waveform',
    content: 'waveform-bytes',
    mimeType: 'image/png',
  },
] as const;

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', jwtSecret);
  vi.stubEnv('CORS_ORIGIN', '');
  vi.stubEnv('API_TRUST_PROXY_HOPS', undefined);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * 创建保留真实路由和资源授权检查的内存测试实例。
 * @param mode 下载方式；省略时验证默认 direct 契约。
 * @param logger 默认关闭日志；仅日志脱敏测试注入内存输出。
 * @returns 实例、两个不同所有者的资产、合成用户认证头及原生签名替身。
 */
async function createFixture(mode?: S3DownloadMode, logger: BuildAppOptions['logger'] = false) {
  const nativeUrl = 'https://minio:9000/private-bucket/object?X-Amz-Signature=test';
  const presign = vi
    .fn<NonNullable<AssetStore['createPresignedGetUrl']>>()
    .mockResolvedValue(nativeUrl);
  const store = Object.assign(new MemoryAssetStore(), { createPresignedGetUrl: presign });
  const asset = await store.create({
    name: 'source.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: Buffer.from('source-bytes'),
    ownerId,
    derivatives: {
      thumbnail: { mimeType: 'image/jpeg', content: Buffer.from('thumbnail-bytes') },
      poster: { mimeType: 'image/jpeg', content: Buffer.from('poster-bytes') },
      waveform: { mimeType: 'image/png', content: Buffer.from('waveform-bytes') },
    },
  });
  const otherAsset = await store.create({
    name: 'private.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: Buffer.from('other-owner-bytes'),
    ownerId: otherOwnerId,
  });
  const app = buildApp({
    logger,
    assetStore: store,
    ...(mode === undefined ? {} : { s3DownloadMode: mode }),
    userExists: async (userId) => [ownerId, otherOwnerId].includes(userId),
  });
  apps.push(app);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const ownerHeaders = {
    authorization: `Bearer ${signHs256Jwt({ sub: ownerId, exp: expiresAt }, jwtSecret)}`,
  };
  const otherHeaders = {
    authorization: `Bearer ${signHs256Jwt({ sub: otherOwnerId, exp: expiresAt }, jwtSecret)}`,
  };
  return { app, store, asset, otherAsset, ownerHeaders, otherHeaders, presign, nativeUrl };
}

describe('proxy asset access URLs', () => {
  it.each(resources)(
    'serves $name without Bearer and rejects expired or tampered URLs',
    async ({ body, path, content, mimeType }) => {
      const { app, store, asset, ownerHeaders, presign } = await createFixture('proxy');
      const getAsset = vi.spyOn(store, 'get');
      const unsignedPath = `/v1/assets/${asset.id}${path}`;
      expect((await app.inject({ method: 'GET', url: unsignedPath })).statusCode).toBe(401);

      const issued = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers: ownerHeaders,
        payload: { ...body, expiresInSeconds: 30 },
      });
      expect(issued.statusCode).toBe(200);
      const access = issued.json<{ url: string; expiresAt: string }>();
      expect(access.url).toMatch(/^\/v1\/assets\//);
      expect(access.url).not.toContain('minio');
      const parsed = new URL(access.url, 'http://localhost:8080');
      expect(parsed.pathname).toBe(unsignedPath);
      expect([...parsed.searchParams.keys()]).toEqual(['access_token']);
      expect(presign).not.toHaveBeenCalled();

      const downloaded = await app.inject({ method: 'GET', url: access.url });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers['content-type']).toContain(mimeType);
      expect(downloaded.rawPayload).toEqual(Buffer.from(content));
      expect(getAsset).toHaveBeenCalledWith(asset.id, { ownerId });

      parsed.searchParams.set('access_token', `${parsed.searchParams.get('access_token')}x`);
      expect(
        (await app.inject({ method: 'GET', url: `${parsed.pathname}${parsed.search}` })).statusCode,
      ).toBe(401);

      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(access.expiresAt));
      expect((await app.inject({ method: 'GET', url: access.url })).statusCode).toBe(401);
    },
  );

  it.each(resources)(
    'rejects unauthorized issuance and cross-asset reuse for $name',
    async ({ body, path }) => {
      const { app, asset, otherAsset, ownerHeaders, otherHeaders, presign } =
        await createFixture('proxy');
      const issueRequest = {
        method: 'POST' as const,
        url: `/v1/assets/${asset.id}/access-url`,
        payload: body,
      };
      expect((await app.inject(issueRequest)).statusCode).toBe(401);
      expect((await app.inject({ ...issueRequest, headers: otherHeaders })).statusCode).toBe(404);
      const issued = await app.inject({ ...issueRequest, headers: ownerHeaders });
      expect(issued.statusCode).toBe(200);
      const { url } = issued.json<{ url: string }>();
      const parsed = new URL(url, 'http://localhost:8080');
      const stolen = `/v1/assets/${otherAsset.id}${path}${parsed.search}`;
      expect((await app.inject({ method: 'GET', url: stolen })).statusCode).toBe(401);
      expect(presign).not.toHaveBeenCalled();
    },
  );

  it('rejects reuse of a content token for a derivative or fixed version', async () => {
    const { app, asset, ownerHeaders } = await createFixture('proxy');
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/assets/${asset.id}/access-url`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(issued.statusCode).toBe(200);
    const { search } = new URL(issued.json<{ url: string }>().url, 'http://localhost:8080');
    for (const resource of resources.slice(1)) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/assets/${asset.id}${resource.path}${search}`,
          })
        ).statusCode,
      ).toBe(401);
    }
  });

  it('rejects invalid injected download modes before building the app', () => {
    expect(() => buildApp({ s3DownloadMode: 'unsupported' as S3DownloadMode })).toThrow(
      'S3_DOWNLOAD_MODE must be "proxy" or "direct"',
    );
  });

  it('keeps signed access tokens and Bearer credentials out of request logs', async () => {
    const messages: string[] = [];
    const { app, asset, ownerHeaders } = await createFixture('proxy', {
      stream: { write: (message) => messages.push(message) },
    });
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/assets/${asset.id}/access-url`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(issued.statusCode).toBe(200);
    const { url } = issued.json<{ url: string }>();
    const accessToken = new URL(url, 'http://localhost:8080').searchParams.get('access_token');
    expect(accessToken).toBeTruthy();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes(accessToken!))).toBe(false);
    expect(messages.some((message) => message.includes(ownerHeaders.authorization))).toBe(false);
    expect(messages.some((message) => message.includes('access_token='))).toBe(false);
  });
});

describe('direct asset access URL compatibility', () => {
  it.each([undefined, 'direct'] as const)('prefers native URLs for mode %s', async (mode) => {
    const { app, asset, ownerHeaders, presign, nativeUrl } = await createFixture(mode);
    for (const resource of resources) {
      presign.mockClear();
      const issued = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers: ownerHeaders,
        payload: { ...resource.body, expiresInSeconds: 60 },
      });
      expect(issued.statusCode).toBe(200);
      expect(issued.json()).toMatchObject({ url: nativeUrl });
      expect(presign).toHaveBeenCalledExactlyOnceWith(
        asset.id,
        { ...resource.body, expiresIn: 60 },
        { ownerId },
      );
    }
  });

  it('retains API signed fallback when the store has no native URL', async () => {
    const { app, asset, ownerHeaders, presign } = await createFixture();
    presign.mockResolvedValue(undefined);
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/assets/${asset.id}/access-url`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(issued.statusCode).toBe(200);
    const { url } = issued.json<{ url: string }>();
    expect(url).toMatch(/^\/v1\/assets\//);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(presign).toHaveBeenCalledOnce();
  });
});

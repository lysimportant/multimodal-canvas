import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetThumbnailService } from './asset-thumbnails';
import { MemoryAssetStore, MemoryBlobStore, PrismaAssetStore } from './assets';
import { withAssetOwnershipPolicy } from './asset-ownership';
import { MemoryProjectStore } from './projects';
import {
  FfmpegMediaDerivativeGenerator,
  NoopMediaDerivativeGenerator,
  type MediaProbeInput,
} from './media';
import { buildApp } from './fixtures/test-app';
import { TestAuthContext } from './fixtures/auth-session';
import type { NewApiAccountService } from './newapi-account-service';
import { NEWAPI_SESSION_COOKIE } from './newapi-account-routes';

/** 构造可识别源版本的合成生成器；不会启动 ffmpeg 或改变原图。 */
function generator() {
  return {
    generate: vi.fn(async (input: MediaProbeInput) => [
      {
        kind: 'thumbnail' as const,
        mimeType: 'image/jpeg',
        content: Buffer.from(`thumb:${input.content}`),
      },
    ]),
  };
}

/** 创建真实内存版本索引，默认绑定测试 owner；输入全部为合成数据。 */
async function image(
  store: MemoryAssetStore,
  content = 'original',
  metadata?: Record<string, unknown>,
) {
  return store.create({
    name: 'source.png',
    ownerId: 'owner-a',
    mediaType: 'image',
    mimeType: 'image/png',
    content: Buffer.from(content),
    metadata,
  });
}

/** 默认请求明确冻结第一版，缓存授权不依赖可变 latest 路径。 */
function request(assetId: string, version: number | undefined = 1) {
  return { assetId, version, scope: { ownerId: 'owner-a' } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('版本缩略图与有界缓存', () => {
  it('按冻结源版本生成；命中与 latest 别名复用缓存，不再读取任何原图', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one', { width: 1920, height: 1080 });
    await store.createVersion(asset.id, {
      content: Buffer.from('two'),
      metadata: { width: 480, height: 960 },
    });
    const generate = generator();
    const service = new AssetThumbnailService(store, generate);
    const original = vi.spyOn(store, 'get');
    const versionContent = vi.spyOn(store, 'getVersionContent');
    const old = await service.get(request(asset.id));
    const current = await service.get(request(asset.id, 2));
    expect(old.content.toString()).toBe('thumb:one');
    expect(current.content.toString()).toBe('thumb:two');
    expect(old).toMatchObject({ originalWidth: 1920, originalHeight: 1080 });
    expect(current).toMatchObject({ originalWidth: 480, originalHeight: 960 });
    expect(old.etag).not.toBe(current.etag);
    await service.get(request(asset.id));
    const latest = await service.get({
      ...request(asset.id),
      version: undefined,
      revision: 'arbitrary-client-revision',
    });
    expect(latest.etag).toBe(current.etag);
    expect(generate.generate).toHaveBeenCalledTimes(2);
    expect(versionContent.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(original).not.toHaveBeenCalled();
  });

  it('复用初版已有衍生图，但不能把 MemoryStore 保留的初版缩略图冒充新版', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('one'),
      ownerId: 'owner-a',
      derivatives: { thumbnail: { mimeType: 'image/jpeg', content: Buffer.from('stored-one') } },
    });
    const generate = generator();
    const service = new AssetThumbnailService(store, generate);
    const read = vi.spyOn(store, 'getVersionContent');
    expect((await service.get(request(asset.id))).content.toString()).toBe('stored-one');
    expect(read).not.toHaveBeenCalled();
    expect(generate.generate).not.toHaveBeenCalled();
    await store.createVersion(asset.id, { content: Buffer.from('two') });
    expect(
      (await service.get({ ...request(asset.id), version: undefined })).content.toString(),
    ).toBe('thumb:two');
    expect((await service.get(request(asset.id))).content.toString()).toBe('stored-one');
    const cold = new AssetThumbnailService(store, generate);
    expect((await cold.get(request(asset.id))).content.toString()).toBe('thumb:one');
  });

  it.each([
    { width: 800, height: 2000 },
    { width: 80, height: 40 },
  ])('重建旧竖图和已放大的小图 %j', async (metadata) => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('source'),
      ownerId: 'owner-a',
      metadata,
      derivatives: { thumbnail: { mimeType: 'image/jpeg', content: Buffer.from('old-width-640') } },
    });
    const generate = generator();
    const service = new AssetThumbnailService(store, generate);
    expect((await service.get(request(asset.id))).content.toString()).toBe('thumb:source');
    expect(generate.generate).toHaveBeenCalledOnce();
  });

  it('尺寸只认对应版本 metadata；不继承最新资源上残留的旧尺寸', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one', { width: 4000, height: 3000 });
    await store.createVersion(asset.id, { content: Buffer.from('two') });
    await store.createVersion(asset.id, {
      content: Buffer.from('three'),
      metadata: { width: '640', height: -1 },
    });
    const service = new AssetThumbnailService(store, generator());
    for (const version of [2, 3]) {
      const thumbnail = await service.get(request(asset.id, version));
      expect(thumbnail.originalWidth).toBeUndefined();
      expect(thumbnail.originalHeight).toBeUndefined();
    }
  });

  it('按服务器摘要和 v 区分无版本旧资源，新增内容立即失效', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one');
    vi.spyOn(store, 'listVersions').mockResolvedValue([]);
    const read = vi.spyOn(store, 'get');
    const generate = generator();
    const service = new AssetThumbnailService(store, generate);
    const input = { ...request(asset.id), version: undefined, revision: 'r1' };
    expect((await service.get(input)).content.toString()).toBe('thumb:one');
    await service.get(input);
    expect(read).toHaveBeenCalledOnce();
    await service.get({ ...input, revision: 'r2' });
    expect(read).toHaveBeenCalledTimes(2);
    await store.createVersion(asset.id, { content: Buffer.from('two') });
    expect((await service.get(input)).content.toString()).toBe('thumb:two');
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 404 });
  });

  it('合并同键并发且不同键超过上限立即失败，不积压队列', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store);
    const other = await image(store, 'other');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = generator();
    generate.generate.mockImplementation(async (input) => {
      await gate;
      return [{ kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from(input.content) }];
    });
    const read = vi.spyOn(store, 'getVersionContent');
    const service = new AssetThumbnailService(store, generate, { maxConcurrent: 1 });
    const pending = Array.from({ length: 8 }, () => service.get(request(asset.id)));
    await vi.waitFor(() => expect(generate.generate).toHaveBeenCalledOnce());
    await expect(service.get(request(other.id))).rejects.toMatchObject({
      status: 503,
      code: 'thumbnail_busy',
    });
    release();
    await Promise.all(pending);
    expect(read).toHaveBeenCalledOnce();
    await service.get(request(other.id));
    expect(generate.generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { maxEntries: 2, maxBytes: 100 },
    { maxEntries: 10, maxBytes: 18 },
  ])('LRU 同时限制条目与字节 %j', async (limits) => {
    const store = new MemoryAssetStore();
    const assets = await Promise.all(['aaa', 'bbb', 'ccc'].map((source) => image(store, source)));
    const generate = generator();
    const service = new AssetThumbnailService(store, generate, limits);
    await service.get(request(assets[0].id));
    await service.get(request(assets[1].id));
    await service.get(request(assets[0].id));
    await service.get(request(assets[2].id));
    await service.get(request(assets[0].id));
    expect(generate.generate).toHaveBeenCalledTimes(3);
    await service.get(request(assets[1].id));
    expect(generate.generate).toHaveBeenCalledTimes(4);
  });

  it('成功 TTL 到期重建；失败短期缓存且过期可恢复，不重复下载或启动 ffmpeg', async () => {
    let now = 0;
    const store = new MemoryAssetStore();
    const asset = await image(store);
    const generate = generator();
    const read = vi.spyOn(store, 'getVersionContent');
    const service = new AssetThumbnailService(store, generate, {
      now: () => now,
      ttlMs: 100,
      failureTtlMs: 20,
    });
    await service.get(request(asset.id));
    now = 101;
    generate.generate.mockRejectedValueOnce(new Error('synthetic ffmpeg failure'));
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 503 });
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 503 });
    expect(read).toHaveBeenCalledTimes(2);
    now = 122;
    await service.get(request(asset.id));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('负缓存也受条目上限约束；过大的输出返回显式错误', async () => {
    const store = new MemoryAssetStore();
    const assets = await Promise.all(['a', 'b'].map((source) => image(store, source)));
    const generate = generator();
    const service = new AssetThumbnailService(store, generate, { maxEntries: 1, maxBytes: 2 });
    for (const asset of [assets[0], assets[1], assets[0]]) {
      await expect(service.get(request(asset.id))).rejects.toMatchObject({
        status: 503,
        code: 'thumbnail_too_large',
      });
    }
    expect(generate.generate).toHaveBeenCalledTimes(3);
  });

  it('缓存命中仍重查 owner、项目冲突和删除，不向他人返回字节或 304', async () => {
    const raw = new MemoryAssetStore();
    const projects = new MemoryProjectStore();
    const project = await projects.create({ name: 'project' }, { ownerId: 'owner-a' });
    const asset = await raw.create({
      name: 'legacy.png',
      projectId: project.id,
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('legacy'),
    });
    const service = new AssetThumbnailService(withAssetOwnershipPolicy(raw, projects), generator());
    await service.get(request(asset.id));
    await expect(
      service.get({ ...request(asset.id), scope: { ownerId: 'owner-b' } }),
    ).rejects.toMatchObject({ status: 404 });
    const ownership = vi
      .spyOn(raw, 'getOwnership')
      .mockResolvedValue({ ownerId: 'owner-b', projectId: project.id });
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 404 });
    ownership.mockRestore();
    await raw.delete(asset.id);
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 404 });
  });

  it('同一个共享测试适配器也按 owner 隔离缓存和 ETag', async () => {
    const raw = new MemoryAssetStore();
    const asset = await image(raw);
    vi.spyOn(raw, 'listVersions').mockImplementation(async () => [
      {
        id: 'v1',
        assetId: asset.id,
        version: 1,
        contentKey: 'v1',
        sizeBytes: 1,
        createdAt: '2026-01-01',
      },
    ]);
    vi.spyOn(raw, 'list').mockResolvedValue([asset]);
    vi.spyOn(raw, 'getVersionContent').mockImplementation(async (_id, _version, scope) =>
      Buffer.from(scope!.ownerId!),
    );
    const generate = generator();
    const service = new AssetThumbnailService(raw, generate);
    const a = await service.get(request(asset.id));
    const b = await service.get({ ...request(asset.id), scope: { ownerId: 'owner-b' } });
    expect(a.content.toString()).toBe('thumb:owner-a');
    expect(b.content.toString()).toBe('thumb:owner-b');
    expect(a.etag).not.toBe(b.etag);
    expect(generate.generate).toHaveBeenCalledTimes(2);
  });

  it('生成期间 latest 变化返回 409，冻结旧版本仍读取原版本，删除返回 404', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one');
    const generate = generator();
    generate.generate.mockImplementationOnce(async (input) => {
      await store.createVersion(asset.id, { content: Buffer.from('two') });
      return [{ kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from(input.content) }];
    });
    const service = new AssetThumbnailService(store, generate);
    await expect(service.get({ ...request(asset.id), version: undefined })).rejects.toMatchObject({
      status: 409,
    });
    expect((await service.get(request(asset.id))).content.toString()).toBe('thumb:one');
    generate.generate.mockImplementationOnce(async () => {
      await store.delete(asset.id);
      return [
        { kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('do-not-publish') },
      ];
    });
    await expect(service.get(request(asset.id, 2))).rejects.toMatchObject({ status: 404 });
  });

  it('存储故障为 502，缺源为 404，禁用和缺失 ffmpeg 都为 503，绝不回退原图', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store);
    const read = vi
      .spyOn(store, 'getVersionContent')
      .mockRejectedValue(new Error('synthetic storage failure'));
    const service = new AssetThumbnailService(store, generator());
    await expect(service.get(request(asset.id))).rejects.toMatchObject({
      status: 502,
      code: 'thumbnail_source_unavailable',
    });
    await expect(service.get(request(asset.id))).rejects.toMatchObject({ status: 502 });
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue(undefined);
    await expect(
      new AssetThumbnailService(store, generator()).get(request(asset.id)),
    ).rejects.toMatchObject({ status: 404 });
    read.mockRestore();
    for (const generate of [
      new NoopMediaDerivativeGenerator(),
      new FfmpegMediaDerivativeGenerator({
        binary: join(tmpdir(), 'nonexistent-thumbnail-ffmpeg-binary'),
      }),
    ]) {
      await expect(
        new AssetThumbnailService(store, generate).get(request(asset.id)),
      ).rejects.toMatchObject({ status: 503, code: 'thumbnail_unavailable' });
    }
  });

  it('Prisma 只下载选定历史源的 Blob；缓存命中不读取最新内容键或衍生图', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put('v1', Buffer.from('old'));
    await blobs.put('v2', Buffer.from('new'));
    const versions = [1, 2].map((version) => ({
      id: `version-${version}`,
      assetId: 'asset',
      version,
      sizeBytes: 3n,
      sha256: `hash-${version}`,
      contentKey: `v${version}`,
      metadata: null,
      createdAt: new Date('2026-01-01'),
    }));
    const row = {
      id: 'asset',
      name: 'image',
      ownerId: 'owner-a',
      projectId: null,
      mediaType: 'IMAGE',
      mimeType: 'image/png',
      sizeBytes: 3n,
      sha256: 'hash-2',
      contentKey: 'v2',
      status: 'READY',
      tags: [],
      metadata: { version: 2 },
      versions: [{ version: 2 }],
      archivedAt: null,
    };
    const prisma = {
      asset: { findFirst: vi.fn(async () => row), findMany: vi.fn(async () => [row]) },
      assetVersion: {
        findMany: vi.fn(async () => versions),
        findFirst: vi.fn(async ({ where }: { where: { version: number } }) =>
          versions.find((version) => version.version === where.version),
        ),
      },
    };
    const store = new PrismaAssetStore(prisma as never, { blobStore: blobs });
    const read = vi.spyOn(blobs, 'get');
    const service = new AssetThumbnailService(store, generator());
    expect((await service.get(request('asset'))).content.toString()).toBe('thumb:old');
    await service.get(request('asset'));
    expect(read.mock.calls.map(([key]) => key)).toEqual(['v1']);
  });
});

describe('缩略图 HTTP 合同', () => {
  it('Bearer 版本读取、原尺寸 CORS 头、304 与原文件下载各自独立', async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-thumbnail-test-secret');
    vi.stubEnv('API_AUTH_TOKEN', '');
    const auth = new TestAuthContext();
    const a = await auth.session({ email: 'thumbnail-a@example.test' });
    const b = await auth.session({ email: 'thumbnail-b@example.test' });
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'image.png',
      ownerId: a.user.id,
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('original-one'),
      metadata: { width: 2400, height: 3600 },
    });
    const generate = generator();
    const app = buildApp({
      logger: false,
      ...auth.appOptions,
      assetStore: store,
      mediaDerivativeGenerator: generate,
    });
    const url = `/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`;
    const headers = { authorization: `Bearer ${a.accessToken}`, origin: 'http://localhost:5173' };
    try {
      const first = await app.inject({ url, headers });
      expect(first.statusCode).toBe(200);
      expect(first.body).toBe('thumb:original-one');
      expect(first.headers['content-type']).toContain('image/jpeg');
      expect(first.headers['x-original-width']).toBe('2400');
      expect(first.headers['x-original-height']).toBe('3600');
      expect(first.headers['access-control-expose-headers']).toContain('x-original-width');
      expect(first.headers['access-control-expose-headers']).toContain('x-original-height');
      expect(first.headers['access-control-expose-headers']).toContain('etag');
      expect(first.headers.vary).toContain('Origin');
      expect(first.headers.vary).toContain('Authorization');
      expect(first.headers.vary).toContain('Cookie');
      expect(first.headers['cache-control']).toBe('private, no-cache');
      const etag = String(first.headers.etag);
      const conditional = await app.inject({
        url,
        headers: { ...headers, 'if-none-match': `"other", W/${etag}` },
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.body).toBe('');
      expect(conditional.headers['x-original-width']).toBe('2400');
      expect((await app.inject({ url, headers: { 'if-none-match': etag } })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url,
            headers: { authorization: `Bearer ${b.accessToken}`, 'if-none-match': etag },
          })
        ).statusCode,
      ).toBe(404);
      const latest = await app.inject({
        url: `/v1/assets/${asset.id}/derivatives/thumbnail?v=one`,
        headers,
      });
      expect(latest.statusCode).toBe(200);
      expect(latest.headers.etag).toBe(etag);
      expect(latest.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
      expect(generate.generate).toHaveBeenCalledOnce();
      await store.createVersion(asset.id, { content: Buffer.from('original-two') });
      const updated = await app.inject({
        url: `/v1/assets/${asset.id}/derivatives/thumbnail?v=one`,
        headers: { ...headers, 'if-none-match': etag },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).toBe('thumb:original-two');
      expect(updated.headers['x-original-width']).toBeUndefined();
      expect(updated.headers['x-original-height']).toBeUndefined();
      expect((await app.inject({ url: `/v1/assets/${asset.id}/content`, headers })).body).toBe(
        'original-two',
      );
      expect(
        (await app.inject({ url: `/v1/assets/${asset.id}/versions/1/content`, headers })).body,
      ).toBe('original-one');
      expect((await app.inject({ url, headers })).body).toBe('thumb:original-one');
      const signed = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers,
        payload: { version: 1 },
      });
      expect(signed.statusCode).toBe(200);
      const accessUrl = String(signed.json().url);
      const token = new URL(accessUrl, 'http://localhost').searchParams.get('access_token');
      expect(
        (await app.inject({ url: `${url}?access_token=${encodeURIComponent(token ?? '')}` }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('非法版本、缺版本、非图片和生成失败返回可识别错误，不返回原图或缓存错误响应', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store);
    const text = await store.create({
      name: 'text',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('private text'),
    });
    const app = buildApp({ logger: false, assetStore: store });
    try {
      for (const version of ['0', '-1', '1.5', 'no', '9007199254740992']) {
        const response = await app.inject(
          `/v1/assets/${asset.id}/versions/${version}/derivatives/thumbnail`,
        );
        expect(response.statusCode).toBe(400);
        expect(response.headers['cache-control']).toContain('no-store');
      }
      expect(
        (await app.inject(`/v1/assets/${asset.id}/versions/2/derivatives/thumbnail`)).statusCode,
      ).toBe(404);
      expect(
        (await app.inject(`/v1/assets/${text.id}/versions/1/derivatives/thumbnail`)).statusCode,
      ).toBe(415);
      const read = vi.spyOn(store, 'getVersionContent');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject(
          `/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`,
        );
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('thumbnail_unavailable');
        expect(response.headers['retry-after']).toBe('30');
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.body).not.toContain('original');
      }
      expect(read).toHaveBeenCalledOnce();
      expect(
        (await app.inject(`/v1/assets/${asset.id}/derivatives/thumbnail?v=${'x'.repeat(257)}`))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject(`/v1/assets/${asset.id}/derivatives/thumbnail?v=a&v=b`)).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('会话隔离、容量恢复与兼容入口', () => {
  it('Cookie 登录访问新路径；未登录、跨账户、删除与 logout 后缓存命中均不能绕过授权', async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-cookie-thumbnail-secret');
    vi.stubEnv('API_AUTH_TOKEN', '');
    const auth = new TestAuthContext();
    const a = await auth.session({ email: 'cookie-a@example.test' });
    const b = await auth.session({ email: 'cookie-b@example.test' });
    const account = {
      options: {
        webUrl: 'http://localhost:5173',
        client: { options: { redirectUri: 'http://localhost:3000/v1/auth/newapi/callback' } },
      },
      identity: vi.fn(async () => ({ status: 'active' })),
    } as unknown as NewApiAccountService;
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'cookie.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('private image'),
      ownerId: a.user.id,
      metadata: { width: 1200, height: 700 },
    });
    const app = buildApp({
      logger: false,
      ...auth.appOptions,
      newApiAccount: account,
      assetStore: store,
      mediaDerivativeGenerator: generator(),
    });
    const url = `/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`;
    const headers = {
      cookie: `${NEWAPI_SESSION_COOKIE}=${a.accessToken}`,
      origin: 'http://localhost:5173',
    };
    try {
      expect((await app.inject({ url })).statusCode).toBe(401);
      const first = await app.inject({ url, headers });
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('private, no-cache');
      expect(first.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(first.headers['access-control-allow-credentials']).toBe('true');
      for (const header of [
        'content-disposition',
        'content-length',
        'x-server-time',
        'etag',
        'x-original-width',
        'x-original-height',
      ]) {
        expect(first.headers['access-control-expose-headers']).toContain(header);
      }
      for (const header of ['Cookie', 'Authorization', 'Origin'])
        expect(first.headers.vary).toContain(header);
      const etag = String(first.headers.etag);
      const cached = await app.inject({ url, headers: { ...headers, 'if-none-match': etag } });
      expect(cached.statusCode).toBe(304);
      const denied = await app.inject({
        url,
        headers: { cookie: `${NEWAPI_SESSION_COOKIE}=${b.accessToken}`, 'if-none-match': etag },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.headers['cache-control']).toBe('private, no-store');
      const signed = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        headers,
        payload: { version: 1 },
      });
      expect(signed.statusCode).toBe(200);
      const token = new URL(signed.json().url, 'http://localhost').searchParams.get('access_token');
      // 新路径未加入签名免登录分类，原文件 token 不能授权缩略图。
      expect(
        (await app.inject({ url: `${url}?access_token=${encodeURIComponent(token!)}` })).statusCode,
      ).toBe(401);
      const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
      expect(logout.statusCode).toBe(200);
      expect(
        (await app.inject({ url, headers: { ...headers, 'if-none-match': etag } })).statusCode,
      ).toBe(401);
      const renewed = await auth.session({ email: 'cookie-a@example.test' });
      const renewedHeaders = {
        cookie: `${NEWAPI_SESSION_COOKIE}=${renewed.accessToken}`,
        'if-none-match': etag,
      };
      expect((await app.inject({ url, headers: renewedHeaders })).statusCode).toBe(304);
      await store.delete(asset.id);
      expect((await app.inject({ url, headers: renewedHeaders })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('旧签名缩略图合同不变，新版会话路径仍按真实版本生成', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'legacy.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('one'),
      derivatives: { thumbnail: { mimeType: 'image/jpeg', content: Buffer.from('stored-legacy') } },
    });
    await store.createVersion(asset.id, { content: Buffer.from('two') });
    const app = buildApp({
      logger: false,
      assetStore: store,
      mediaDerivativeGenerator: generator(),
    });
    try {
      const signed = await app.inject({
        method: 'POST',
        url: `/v1/assets/${asset.id}/access-url`,
        payload: { derivative: 'thumbnail' },
      });
      expect(signed.statusCode).toBe(200);
      expect((await app.inject(signed.json().url)).body).toBe('stored-legacy');
      expect((await app.inject(`/v1/assets/${asset.id}/derivatives/thumbnail`)).body).toBe(
        'thumb:two',
      );
      expect(
        (await app.inject(`/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`)).body,
      ).toBe('thumb:one');
      expect((await app.inject(`${signed.json().url}tampered`)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('四个 HTTP 转码槽满时仅返回短暂 busy，槽位释放后立即成功且不负缓存', async () => {
    const store = new MemoryAssetStore();
    const assets = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((source) => image(store, source)),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = generator();
    generate.generate.mockImplementation(async (input) => {
      await gate;
      return [
        {
          kind: 'thumbnail',
          mimeType: 'image/jpeg',
          content: Buffer.from(`thumb:${input.content}`),
        },
      ];
    });
    const app = buildApp({ logger: false, assetStore: store, mediaDerivativeGenerator: generate });
    try {
      const pending = assets
        .slice(0, 4)
        .map((asset) =>
          app
            .inject(`/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`)
            .then((response) => response),
        );
      await vi.waitFor(() => expect(generate.generate).toHaveBeenCalledTimes(4));
      const url = `/v1/assets/${assets[4].id}/versions/1/derivatives/thumbnail`;
      const busy = await app.inject(url);
      expect(busy.statusCode).toBe(503);
      expect(busy.json().code).toBe('thumbnail_busy');
      expect(busy.headers['retry-after']).toBe('1');
      expect(busy.headers['cache-control']).toBe('private, no-store');
      release();
      expect((await Promise.all(pending)).map((response) => response.statusCode)).toEqual([
        200, 200, 200, 200,
      ]);
      const recovered = await app.inject(url);
      expect(recovered.statusCode).toBe(200);
      expect(recovered.body).toBe('thumb:e');
    } finally {
      release();
      await app.close();
    }
  });

  it('真实 HTTP 启动冒烟：健康检查、授权缩略图和原文件路径保持独立', async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-thumbnail-http-secret');
    const auth = new TestAuthContext();
    const session = await auth.session({ email: 'http-thumb@example.test' });
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'http.png',
      ownerId: session.user.id,
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('http-original'),
    });
    const app = buildApp({
      logger: false,
      ...auth.appOptions,
      assetStore: store,
      mediaDerivativeGenerator: generator(),
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      expect((await fetch(`${address}/health`)).status).toBe(200);
      const headers = { authorization: `Bearer ${session.accessToken}` };
      const thumbnail = await fetch(
        `${address}/v1/assets/${asset.id}/versions/1/derivatives/thumbnail`,
        { headers },
      );
      expect(thumbnail.status).toBe(200);
      expect(await thumbnail.text()).toBe('thumb:http-original');
      const original = await fetch(`${address}/v1/assets/${asset.id}/content`, { headers });
      expect(original.status).toBe(200);
      expect(await original.text()).toBe('http-original');
    } finally {
      await app.close();
    }
  });

  it('旧缩略图尺寸未知时允许复用，但不能报告为已验证的 640 长边或原图尺寸', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'portrait.png',
      ownerId: 'owner-a',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('portrait-source'),
      derivatives: {
        thumbnail: { mimeType: 'image/jpeg', content: Buffer.from('legacy-640-by-1138') },
      },
    });
    const generate = generator();
    const result = await new AssetThumbnailService(store, generate).get(request(asset.id));
    expect(result.content.toString()).toBe('legacy-640-by-1138');
    expect(result.originalWidth).toBeUndefined();
    expect(result.originalHeight).toBeUndefined();
    expect(generate.generate).not.toHaveBeenCalled();
  });

  it('最新路径等待冻结版同键任务时重新检查修订，不会接收生成期间已过期的结果', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = generator();
    generate.generate.mockImplementation(async () => {
      await gate;
      return [{ kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('thumb:one') }];
    });
    const service = new AssetThumbnailService(store, generate);
    const old = service.get(request(asset.id));
    await vi.waitFor(() => expect(generate.generate).toHaveBeenCalledOnce());
    const snapshots = vi.spyOn(store, 'listVersions');
    const latest = expect(
      service.get({ ...request(asset.id), version: undefined }),
    ).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalled());
    await store.createVersion(asset.id, { content: Buffer.from('two') });
    release();
    expect((await old).content.toString()).toBe('thumb:one');
    await latest;
  });

  it('读取衍生图期间新增版本时丢弃不带版本的图，改从冻结源生成', async () => {
    const store = new MemoryAssetStore();
    const asset = await image(store, 'one');
    vi.spyOn(store, 'getDerivative').mockImplementationOnce(async () => {
      await store.createVersion(asset.id, { content: Buffer.from('two') });
      return {
        kind: 'thumbnail',
        mimeType: 'image/jpeg',
        content: Buffer.from('wrong-latest'),
        sizeBytes: 12,
        sha256: 'synthetic',
      };
    });
    const result = await new AssetThumbnailService(store, generator()).get(request(asset.id));
    expect(result.content.toString()).toBe('thumb:one');
  });
});

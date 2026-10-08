import {
  createProviderAssetAccessToken,
  providerAssetAccessPath,
} from '@multimodal-canvas/credential-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore, type AssetStore } from './assets';
import { MemoryAuthStore } from './auth-store';
import { buildApp } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';

const secret = 'provider-asset-route-test-secret';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(
  options: { mimeType?: string; mediaType?: 'text' | 'image' | 'audio' | 'video' } = {},
) {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', secret);
  vi.stubEnv('ASSET_ACCESS_URL_SECRET', '');
  const authStore = new MemoryAuthStore();
  await authStore.createUser({ email: 'owner@example.test', displayName: 'Owner' });
  const owner = (await authStore.findUserByEmail('owner@example.test'))!;
  const other = await authStore.createUser({ email: 'other@example.test', displayName: 'Other' });
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: 'Provider project' }, { ownerId: owner.id });
  const assetStore = new MemoryAssetStore();
  const asset = await assetStore.create({
    name: 'source.mp4',
    mediaType: options.mediaType ?? 'video',
    mimeType: options.mimeType ?? 'video/mp4',
    content: Buffer.from('0123456789'),
    ownerId: owner.id,
    projectId: project.id,
    metadata: { privateNote: 'must not be exposed' },
  });
  const app = buildApp({ logger: false, assetStore, projectStore, authStore });
  const token = (
    version = 1,
    overrides: Partial<{ assetId: string; projectId: string | null; ownerId: string }> = {},
  ) =>
    createProviderAssetAccessToken(
      {
        assetId: overrides.assetId ?? asset.id,
        version,
        projectId: overrides.projectId === undefined ? project.id : overrides.projectId,
        ownerId: overrides.ownerId ?? owner.id,
        expiresAt: Date.now() + 300_000,
      },
      secret,
    );
  return { app, authStore, owner, other, projectStore, project, assetStore, asset, token };
}

describe('Provider frozen asset access route', () => {
  it('serves only the signed frozen version and does not expose metadata', async () => {
    const context = await fixture();
    try {
      await context.assetStore.createVersion(
        context.asset.id,
        { content: Buffer.from('new-version') },
        { ownerId: context.owner.id, projectId: context.project.id },
      );
      const response = await context.app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from('0123456789'));
      expect(response.headers['content-type']).toContain('video/mp4');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).not.toContain('privateNote');
      expect(response.headers['x-asset-id']).toBeUndefined();
    } finally {
      await context.app.close();
    }
  });

  it('rejects missing, tampered, expired, cross-asset and cross-version tokens', async () => {
    const context = await fixture();
    try {
      const path = providerAssetAccessPath(context.asset.id, 1);
      expect((await context.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
      const valid = context.token();
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${path}?access_token=${encodeURIComponent(`${valid}x`)}`,
          })
        ).statusCode,
      ).toBe(401);
      const expiresAt = Date.now() + 1_000;
      const expired = createProviderAssetAccessToken(
        {
          assetId: context.asset.id,
          version: 1,
          projectId: context.project.id,
          ownerId: context.owner.id,
          expiresAt,
        },
        secret,
      );
      vi.setSystemTime(expiresAt);
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${path}?access_token=${encodeURIComponent(expired)}`,
          })
        ).statusCode,
      ).toBe(401);
      vi.setSystemTime(new Date());
      const other = await context.assetStore.create({
        name: 'other.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
        content: Buffer.from('other'),
        ownerId: context.owner.id,
        projectId: context.project.id,
      });
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${providerAssetAccessPath(other.id, 1)}?access_token=${encodeURIComponent(valid)}`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${providerAssetAccessPath(context.asset.id, 2)}?access_token=${encodeURIComponent(valid)}`,
          })
        ).statusCode,
      ).toBe(401);
      const otherOwnerToken = context.token(1, { ownerId: context.other.id });
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${path}?access_token=${encodeURIComponent(otherOwnerToken)}`,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await context.app.close();
    }
  });

  it('rechecks project ownership, active owner, archived and deleted state', async () => {
    const context = await fixture();
    try {
      const url = () =>
        `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`;
      expect((await context.app.inject({ method: 'GET', url: url() })).statusCode).toBe(200);

      const originalProjectGet = context.projectStore.get.bind(context.projectStore);
      const transferredProjectGet = vi
        .spyOn(context.projectStore, 'get')
        .mockImplementation(async (id, scope) => {
          const project = await originalProjectGet(id, scope);
          return project ? { ...project, ownerId: context.other.id } : undefined;
        });
      expect((await context.app.inject({ method: 'GET', url: url() })).statusCode).toBe(404);
      transferredProjectGet.mockRestore();

      await context.authStore.updateUser(context.owner.id, { status: 'disabled' });
      expect((await context.app.inject({ method: 'GET', url: url() })).statusCode).toBe(401);
      await context.authStore.updateUser(context.owner.id, { status: 'active' });

      await context.assetStore.setArchived(context.asset.id, true, {
        ownerId: context.owner.id,
        projectId: context.project.id,
      });
      expect((await context.app.inject({ method: 'GET', url: url() })).statusCode).toBe(404);
      await context.assetStore.setArchived(context.asset.id, false, {
        ownerId: context.owner.id,
        projectId: context.project.id,
      });
      await context.assetStore.delete(context.asset.id, {
        ownerId: context.owner.id,
        projectId: context.project.id,
      });
      expect((await context.app.inject({ method: 'GET', url: url() })).statusCode).toBe(404);
    } finally {
      await context.app.close();
    }
  });

  it('supports one byte range for GET and HEAD and forces HTML to download', async () => {
    const context = await fixture();
    try {
      const url = `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`;
      const ranged = await context.app.inject({
        method: 'GET',
        url,
        headers: { range: 'bytes=2-5' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.rawPayload).toEqual(Buffer.from('2345'));
      expect(ranged.headers['content-range']).toBe('bytes 2-5/10');
      const head = await context.app.inject({
        method: 'HEAD',
        url,
        headers: { range: 'bytes=2-5' },
      });
      expect(head.statusCode).toBe(206);
      expect(head.rawPayload.byteLength).toBe(0);
      expect(head.headers['content-length']).toBe('4');
      const fullHead = await context.app.inject({ method: 'HEAD', url });
      expect(fullHead.statusCode).toBe(200);
      expect(fullHead.rawPayload.byteLength).toBe(0);
      expect(fullHead.headers['content-length']).toBe('10');
      const invalidRange = await context.app.inject({
        method: 'GET',
        url,
        headers: { range: 'bytes=20-25' },
      });
      expect(invalidRange.statusCode).toBe(416);
      expect(invalidRange.headers['content-range']).toBe('bytes */10');
    } finally {
      await context.app.close();
    }

    const htmlContext = await fixture({ mediaType: 'text', mimeType: 'text/html' });
    try {
      const html = await htmlContext.app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(htmlContext.asset.id, 1)}?access_token=${encodeURIComponent(htmlContext.token())}`,
      });
      expect(html.statusCode).toBe(200);
      expect(html.headers['content-type']).toContain('application/octet-stream');
      expect(html.headers['content-disposition']).toContain('attachment');
      expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    } finally {
      await htmlContext.app.close();
    }
  });

  it('HEAD and invalid ranges do not open content; GET opens only the requested range', async () => {
    const context = await fixture();
    try {
      const original = context.assetStore.getVersionContentSource.bind(context.assetStore);
      const open = vi.fn(async (range?: { start: number; end: number }) => {
        const source = await original(context.asset.id, 1, {
          ownerId: context.owner.id,
          projectId: context.project.id,
        });
        return source?.open(range);
      });
      vi.spyOn(context.assetStore, 'getVersionContentSource').mockImplementation(
        async (id, version, scope) => {
          const source = await original(id, version, scope);
          return source && { ...source, open };
        },
      );
      const buffered = vi.spyOn(context.assetStore, 'getVersionContent');
      const url = `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`;
      expect((await context.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
      expect(
        (await context.app.inject({ method: 'HEAD', url, headers: { range: 'bytes=2-5' } }))
          .statusCode,
      ).toBe(206);
      expect(
        (await context.app.inject({ method: 'GET', url, headers: { range: 'bytes=20-25' } }))
          .statusCode,
      ).toBe(416);
      expect(open).not.toHaveBeenCalled();
      const response = await context.app.inject({
        method: 'GET',
        url,
        headers: { range: 'bytes=2-5' },
      });
      expect(response.rawPayload).toEqual(Buffer.from('2345'));
      expect(open).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 5 });
      expect(buffered).not.toHaveBeenCalled();
    } finally {
      await context.app.close();
    }
  });

  it('keeps GET, HEAD and Range behavior for stores without the new source method', async () => {
    const context = await fixture();
    const legacyStore: AssetStore = context.assetStore;
    legacyStore.getVersionContentSource = undefined;
    const app = buildApp({
      logger: false,
      assetStore: legacyStore,
      projectStore: context.projectStore,
      authStore: context.authStore,
    });
    try {
      const url = `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`;
      const get = await app.inject({ method: 'GET', url });
      expect(get.rawPayload).toEqual(Buffer.from('0123456789'));
      const head = await app.inject({ method: 'HEAD', url });
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe('10');
      const ranged = await app.inject({ method: 'GET', url, headers: { range: 'bytes=2-5' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.rawPayload).toEqual(Buffer.from('2345'));
    } finally {
      await app.close();
      await context.app.close();
    }
  });

  it('keeps ordinary asset endpoints authenticated and does not accept provider tokens there', async () => {
    const context = await fixture();
    try {
      const ordinary = `/v1/assets/${context.asset.id}/versions/1/content`;
      expect((await context.app.inject({ method: 'GET', url: ordinary })).statusCode).toBe(401);
      expect(
        (
          await context.app.inject({
            method: 'GET',
            url: `${ordinary}?access_token=${encodeURIComponent(context.token())}`,
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await context.app.close();
    }
  });

  it('按签名所有者读取个人素材，拒绝其他所有者与写操作', async () => {
    const context = await fixture();
    try {
      const personal = await context.assetStore.create({
        name: 'personal.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('personal-image'),
        ownerId: context.owner.id,
      });
      const path = providerAssetAccessPath(personal.id, 1);
      const query = (ownerId: string) =>
        `?access_token=${context.token(1, {
          assetId: personal.id,
          projectId: null,
          ownerId,
        })}`;
      const response = await context.app.inject({
        method: 'GET',
        url: path + query(context.owner.id),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('personal-image');
      expect(
        (await context.app.inject({ method: 'GET', url: path + query(context.other.id) }))
          .statusCode,
      ).toBe(404);
      expect(
        (await context.app.inject({ method: 'POST', url: path + query(context.owner.id) }))
          .statusCode,
      ).toBe(401);
    } finally {
      await context.app.close();
    }
  });

  it('存储故障保留服务端错误状态，响应不泄露内部对象地址', async () => {
    const context = await fixture();
    try {
      vi.spyOn(context.assetStore, 'getVersionContentSource').mockRejectedValue(
        new Error('synthetic private/object/key storage failure'),
      );
      const response = await context.app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${context.token()}`,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'internal_error' });
      expect(response.body).not.toContain('private/object/key');
    } finally {
      await context.app.close();
    }
  });

  it('does not expose storage details when opening the content stream fails', async () => {
    const context = await fixture();
    try {
      const original = context.assetStore.getVersionContentSource.bind(context.assetStore);
      vi.spyOn(context.assetStore, 'getVersionContentSource').mockImplementation(
        async (id, version, scope) => {
          const source = await original(id, version, scope);
          return source
            ? {
                ...source,
                open: async () => {
                  throw new Error('synthetic private/object/key storage failure');
                },
              }
            : undefined;
        },
      );
      const response = await context.app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${context.token()}`,
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private/object/key');
    } finally {
      await context.app.close();
    }
  });

  it('returns a JSON 404 if the object disappears between HEAD and GET', async () => {
    const context = await fixture();
    try {
      const original = context.assetStore.getVersionContentSource.bind(context.assetStore);
      vi.spyOn(context.assetStore, 'getVersionContentSource').mockImplementation(
        async (id, version, scope) => {
          const source = await original(id, version, scope);
          return source ? { ...source, open: async () => undefined } : undefined;
        },
      );
      const response = await context.app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${context.token()}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({ error: 'provider asset not found' });
    } finally {
      await context.app.close();
    }
  });

  it('applies the shared rate limiter before reading provider bytes', async () => {
    const context = await fixture();
    const consume = vi.fn(async (_key: string, options: { limit: number; windowMs: number }) => ({
      allowed: false,
      limit: options.limit,
      remaining: 0,
      resetAt: Date.now() + options.windowMs,
      retryAfterSeconds: 1,
    }));
    const app = buildApp({
      logger: false,
      assetStore: context.assetStore,
      projectStore: context.projectStore,
      authStore: context.authStore,
      rateLimiter: { consume },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${providerAssetAccessPath(context.asset.id, 1)}?access_token=${encodeURIComponent(context.token())}`,
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('1');
      expect(consume).toHaveBeenCalledWith(
        expect.stringMatching(/^provider-asset:/),
        expect.objectContaining({ limit: 120, windowMs: 60_000 }),
      );
    } finally {
      await app.close();
      await context.app.close();
    }
  });
});

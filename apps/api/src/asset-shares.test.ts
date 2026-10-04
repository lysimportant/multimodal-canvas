import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { createAssetShareToken, verifyAssetShareToken } from './asset-shares';
import { signHs256Jwt } from './auth';
import { MemoryRateLimiter } from './rate-limit';

const jwtSecret = 'asset-share-jwt-secret';
const shareSecret = 'asset-share-hmac-secret';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
const apps: FastifyInstance[] = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', jwtSecret);
  vi.stubEnv('ASSET_ACCESS_URL_SECRET', shareSecret);
  vi.stubEnv('CORS_ORIGIN', '');
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function bearer(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signHs256Jwt(
      { sub: userId, exp: Math.floor(Date.now() / 1000) + 3_600 },
      jwtSecret,
    )}`,
  };
}

async function fixture(mimeType = 'video/mp4') {
  const active = new Set([ownerId, otherOwnerId]);
  const store = new MemoryAssetStore();
  const asset = await store.create({
    name: 'private-result.mp4',
    mediaType: mimeType.startsWith('video/') ? 'video' : 'text',
    mimeType,
    content: Buffer.from('version-one'),
    ownerId,
    metadata: { prompt: 'must-not-leak', projectId: 'must-not-leak' },
  });
  const other = await store.create({
    name: 'other.mp4',
    mediaType: 'video',
    mimeType: 'video/mp4',
    content: Buffer.from('other-owner'),
    ownerId: otherOwnerId,
  });
  const app = buildApp({
    assetStore: store,
    userExists: async (userId) => active.has(userId),
  });
  apps.push(app);
  return { app, store, asset, other, active };
}

async function issueShare(
  app: FastifyInstance,
  assetId: string,
  owner = ownerId,
  payload: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/assets/${assetId}/share`,
    headers: bearer(owner),
    payload,
  });
}

describe('asset share routes', () => {
  it('requires a user session and keeps cross-owner assets undiscoverable', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'service-token');
    const { app, asset } = await fixture();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/assets/${asset.id}/share`,
          headers: { authorization: 'Bearer service-token' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect((await issueShare(app, asset.id, otherOwnerId)).statusCode).toBe(404);
  });

  it('freezes the current version for seven days and exposes only approved metadata', async () => {
    const { app, store, asset } = await fixture();
    await store.createVersion(asset.id, { content: Buffer.from('version-two') }, { ownerId });
    const issued = await issueShare(app, asset.id);
    expect(issued.statusCode).toBe(200);
    const share = issued.json<{ token: string; expiresAt: string; version: number }>();
    expect(share.version).toBe(2);
    expect(share.token).not.toContain(asset.id);
    expect(share.token).not.toContain(ownerId);
    expect(Date.parse(share.expiresAt) - Date.now()).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1_000);

    await store.createVersion(asset.id, { content: Buffer.from('version-three') }, { ownerId });
    const metadata = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares?token=${encodeURIComponent(share.token)}`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers['cache-control']).toBe('no-store');
    expect(metadata.headers['x-content-type-options']).toBe('nosniff');
    expect(metadata.json()).toEqual({
      asset: {
        name: 'private-result.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: Buffer.byteLength('version-two'),
        version: 2,
        contentUrl: `/v1/asset-shares/content?token=${encodeURIComponent(share.token)}`,
      },
      expiresAt: share.expiresAt,
    });
    expect(JSON.stringify(metadata.json())).not.toMatch(
      /assetId|owner|project|metadata|prompt|credential/i,
    );

    const content = await app.inject({
      method: 'GET',
      url: metadata.json<{ asset: { contentUrl: string } }>().asset.contentUrl,
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(Buffer.from('version-two'));
    expect(content.headers['accept-ranges']).toBe('bytes');
    expect(content.headers['referrer-policy']).toBe('no-referrer');
  });

  it('supports a selected historical version, HEAD and single byte ranges', async () => {
    const { app, store, asset } = await fixture();
    await store.createVersion(asset.id, { content: Buffer.from('0123456789') }, { ownerId });
    const issued = await issueShare(app, asset.id, ownerId, { version: 2 });
    const token = issued.json<{ token: string }>().token;
    const url = `/v1/asset-shares/content?token=${encodeURIComponent(token)}`;

    const partial = await app.inject({ method: 'GET', url, headers: { range: 'bytes=2-5' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload).toEqual(Buffer.from('2345'));
    expect(partial.headers['content-range']).toBe('bytes 2-5/10');
    expect(partial.headers['content-length']).toBe('4');

    const head = await app.inject({ method: 'HEAD', url });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.byteLength).toBe(0);
    expect(head.headers['content-length']).toBe('10');

    const invalid = await app.inject({ method: 'GET', url, headers: { range: 'bytes=20-30' } });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');
  });

  it('rejects unsafe version numbers, duplicate tokens and missing frozen content', async () => {
    const { app, store, asset } = await fixture();
    expect(
      (await issueShare(app, asset.id, ownerId, { version: Number.MAX_SAFE_INTEGER + 1 }))
        .statusCode,
    ).toBe(400);

    const token = (await issueShare(app, asset.id)).json<{ token: string }>().token;
    expect(
      (
        await app.inject({
          method: 'GET',
          url:
            '/v1/asset-shares?token=' +
            encodeURIComponent(token) +
            '&token=' +
            encodeURIComponent(token),
        })
      ).statusCode,
    ).toBe(404);

    expect(verifyAssetShareToken([token], shareSecret)).toBeUndefined();
    expect(verifyAssetShareToken({ token }, shareSecret)).toBeUndefined();
    expect(verifyAssetShareToken(Symbol('token'), shareSecret)).toBeUndefined();

    vi.spyOn(store, 'getVersionContent').mockResolvedValueOnce(undefined);
    expect((await issueShare(app, asset.id)).statusCode).toBe(404);
  });

  it('keeps an empty frozen version readable instead of treating it as missing', async () => {
    const { app, store, asset } = await fixture();
    vi.spyOn(store, 'getVersionContent').mockResolvedValue(Buffer.alloc(0));

    const issued = await issueShare(app, asset.id);
    expect(issued.statusCode).toBe(200);
    const token = issued.json<{ token: string }>().token;
    const content = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares/content?token=${encodeURIComponent(token)}`,
    });

    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.byteLength).toBe(0);
    expect(content.headers['content-length']).toBe('0');
  });

  it('rejects tampered, expired and access-url tokens in the share purpose', async () => {
    const { app, asset } = await fixture();
    const issued = await issueShare(app, asset.id);
    const token = issued.json<{ token: string }>().token;
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${tampered}` })).statusCode,
    ).toBe(404);

    const expired = createAssetShareToken(
      { assetId: asset.id, ownerId, version: 1, expiresAt: Date.now() - 1 },
      shareSecret,
    );
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${expired}` })).statusCode,
    ).toBe(404);

    const access = await app.inject({
      method: 'POST',
      url: `/v1/assets/${asset.id}/access-url`,
      headers: bearer(ownerId),
      payload: { version: 1 },
    });
    const accessToken = new URL(
      access.json<{ url: string }>().url,
      'http://localhost',
    ).searchParams.get('access_token')!;
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${accessToken}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/assets/${asset.id}/versions/1/content?access_token=${encodeURIComponent(token)}`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('invalidates links when the owner, asset or ready state becomes unavailable', async () => {
    const { app, store, asset, active } = await fixture();
    const ownerToken = (await issueShare(app, asset.id)).json<{ token: string }>().token;
    active.delete(ownerId);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${ownerToken}` })).statusCode,
    ).toBe(404);
    active.add(ownerId);

    await store.setArchived(asset.id, true, { ownerId });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${ownerToken}` })).statusCode,
    ).toBe(404);
    await store.setArchived(asset.id, false, { ownerId });
    await store.delete(asset.id, { ownerId });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/asset-shares?token=${ownerToken}` })).statusCode,
    ).toBe(404);
  });

  it('forces executable content to a sandboxed attachment', async () => {
    const { app, asset } = await fixture('text/html');
    const token = (await issueShare(app, asset.id)).json<{ token: string }>().token;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares/content?token=${encodeURIComponent(token)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not log the complete share token and rate limits public reads by IP', async () => {
    const messages: string[] = [];
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'logged.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      content: Buffer.from('logged-content'),
      ownerId,
    });
    const app = buildApp({
      assetStore: store,
      userExists: async () => true,
      logger: { stream: { write: (message) => messages.push(message) } },
      rateLimiter: new MemoryRateLimiter(),
    });
    apps.push(app);
    const token = (await issueShare(app, asset.id)).json<{ token: string }>().token;
    const url = `/v1/asset-shares?token=${encodeURIComponent(token)}`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(messages.some((message) => message.includes(token))).toBe(false);
    expect(messages.some((message) => message.includes('token='))).toBe(false);

    for (let index = 1; index < 120; index += 1) {
      expect((await app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(429);
  });

  it('fails closed when public reads cannot confirm an active owner', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'unstable.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('unstable'),
      ownerId,
    });
    const token = createAssetShareToken(
      { assetId: asset.id, ownerId, version: 1, expiresAt: Date.now() + 60_000 },
      shareSecret,
    );
    const readApp = buildApp({ assetStore: store });
    apps.push(readApp);
    expect(
      (await readApp.inject({ method: 'GET', url: `/v1/asset-shares?token=${token}` })).statusCode,
    ).toBe(404);
  });
});

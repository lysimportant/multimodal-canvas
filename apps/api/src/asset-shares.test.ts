import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import {
  ASSET_SHARE_ACCESS_TTL_MS,
  createAssetShareAccessToken,
  createAssetShareToken,
  createPasswordProtectedAssetShareToken,
  isPasswordProtectedAssetShare,
  verifyAssetShareAccessToken,
  verifyAssetSharePassword,
  verifyAssetShareToken,
} from './asset-shares';
import { signHs256Jwt } from './auth';
import { openApiDocument } from './openapi';
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

async function unlockShare(app: FastifyInstance, token: string, password: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/asset-shares/unlock',
    payload: { token, password },
  });
}

describe('asset share password token contracts', () => {
  it('uses random-salt v2 encryption and rejects version downgrade or token-purpose reuse', async () => {
    const now = Date.now();
    const input = {
      assetId: 'asset-password-contract',
      ownerId,
      version: 3,
      expiresAt: now + 2 * ASSET_SHARE_ACCESS_TTL_MS,
    };
    const password = '  exact password marker  ';
    const first = await createPasswordProtectedAssetShareToken(input, shareSecret, password);
    const second = await createPasswordProtectedAssetShareToken(input, shareSecret, password);

    expect(first).toMatch(/^v2\./);
    expect(second).toMatch(/^v2\./);
    expect(second).not.toBe(first);
    expect(first).not.toContain(password);
    const firstPayload = verifyAssetShareToken(first, shareSecret, now);
    const secondPayload = verifyAssetShareToken(second, shareSecret, now);
    expect(firstPayload && isPasswordProtectedAssetShare(firstPayload)).toBe(true);
    expect(secondPayload && isPasswordProtectedAssetShare(secondPayload)).toBe(true);
    expect(firstPayload?.password?.salt).not.toBe(secondPayload?.password?.salt);
    await expect(verifyAssetSharePassword(firstPayload!, password)).resolves.toBe(true);
    await expect(verifyAssetSharePassword(firstPayload!, password.trim())).resolves.toBe(false);

    const downgraded = `v1.${first.split('.').slice(1).join('.')}`;
    expect(verifyAssetShareToken(downgraded, shareSecret, now)).toBeUndefined();

    const grant = createAssetShareAccessToken(first, input.expiresAt, shareSecret, now);
    expect(grant.expiresAt).toBe(now + ASSET_SHARE_ACCESS_TTL_MS);
    expect(
      verifyAssetShareAccessToken(grant.accessToken, first, input.expiresAt, shareSecret, now),
    ).toMatchObject({ expiresAt: grant.expiresAt });
    expect(
      verifyAssetShareAccessToken(grant.accessToken, second, input.expiresAt, shareSecret, now),
    ).toBeUndefined();
    expect(
      verifyAssetShareAccessToken(
        grant.accessToken,
        first,
        input.expiresAt,
        shareSecret,
        grant.expiresAt,
      ),
    ).toBeUndefined();
    expect(verifyAssetShareToken(grant.accessToken, shareSecret, now)).toBeUndefined();
    expect(
      verifyAssetShareAccessToken(first, first, input.expiresAt, shareSecret, now),
    ).toBeUndefined();
  });

  it('caps an unlock grant at the earlier share expiration', () => {
    const now = Date.now();
    const shareExpiresAt = now + 5 * 60_000;
    const token = createAssetShareToken(
      { assetId: 'asset-short-share', ownerId, version: 1, expiresAt: shareExpiresAt },
      shareSecret,
    );

    expect(createAssetShareAccessToken(token, shareExpiresAt, shareSecret, now).expiresAt).toBe(
      shareExpiresAt,
    );
  });
});

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
    expect(share.token).toMatch(/^v1\./);
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

  it('keeps an explicit empty password on the compatible v1 response and read contract', async () => {
    const { app, asset } = await fixture();
    const issued = await issueShare(app, asset.id, ownerId, { password: '' });

    expect(issued.statusCode).toBe(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    expect(issued.json()).toEqual({
      token: expect.stringMatching(/^v1\./),
      expiresAt: expect.any(String),
      version: 1,
    });
    const token = issued.json<{ token: string }>().token;
    expect(verifyAssetShareToken(token, shareSecret)?.password).toBeUndefined();
    const metadata = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares?token=${encodeURIComponent(token)}`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().asset.contentUrl).toBe(
      `/v1/asset-shares/content?token=${encodeURIComponent(token)}`,
    );
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

  it('protects metadata, HEAD and Range content until the exact password unlocks it', async () => {
    const { app, store, asset } = await fixture();
    await store.createVersion(asset.id, { content: Buffer.from('newer-version') }, { ownerId });
    const password = '  Preserve Spaces  ';
    const issued = await issueShare(app, asset.id, ownerId, { version: 1, password });
    expect(issued.statusCode).toBe(200);
    const share = issued.json<{ token: string; expiresAt: string; version: number }>();
    expect(share.token).toMatch(/^v2\./);
    expect(share.version).toBe(1);

    await store.createVersion(asset.id, { content: Buffer.from('latest-version') }, { ownerId });
    const contentLookup = vi.spyOn(store, 'getVersionContent');
    const metadataUrl = `/v1/asset-shares?token=${encodeURIComponent(share.token)}`;
    const contentUrl = `/v1/asset-shares/content?token=${encodeURIComponent(share.token)}`;

    const directMetadata = await app.inject({ method: 'GET', url: metadataUrl });
    expect(directMetadata.statusCode).toBe(401);
    expect(directMetadata.headers['cache-control']).toBe('no-store');
    expect(directMetadata.json()).toEqual({
      code: 'SHARE_PASSWORD_REQUIRED',
      error: expect.any(String),
    });
    expect(directMetadata.body).not.toMatch(/private-result|video\/mp4|contentUrl|sizeBytes/i);

    const directHead = await app.inject({ method: 'HEAD', url: metadataUrl });
    expect(directHead.statusCode).toBe(401);
    expect(directHead.headers['cache-control']).toBe('no-store');
    expect(directHead.json()).toEqual({
      code: 'SHARE_PASSWORD_REQUIRED',
      error: expect.any(String),
    });
    expect(directHead.body).not.toMatch(/private-result|video\/mp4|contentUrl|sizeBytes/i);

    const directRange = await app.inject({
      method: 'GET',
      url: contentUrl,
      headers: { range: 'bytes=0-6' },
    });
    expect(directRange.statusCode).toBe(401);
    expect(directRange.json()).toEqual({
      code: 'SHARE_PASSWORD_REQUIRED',
      error: expect.any(String),
    });
    expect(directRange.headers['accept-ranges']).toBeUndefined();
    expect(directRange.headers['content-range']).toBeUndefined();

    const directContentHead = await app.inject({ method: 'HEAD', url: contentUrl });
    expect(directContentHead.statusCode).toBe(401);
    expect(directContentHead.headers['accept-ranges']).toBeUndefined();
    expect(directContentHead.json()).toEqual({
      code: 'SHARE_PASSWORD_REQUIRED',
      error: expect.any(String),
    });
    expect(contentLookup).not.toHaveBeenCalled();

    const wrong = await unlockShare(app, share.token, password.trim());
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['cache-control']).toBe('no-store');
    expect(wrong.json()).toEqual({
      code: 'SHARE_PASSWORD_INVALID',
      error: expect.any(String),
    });

    const unlocked = await unlockShare(app, share.token, password);
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.headers['cache-control']).toBe('no-store');
    const grant = unlocked.json<{ accessToken: string; expiresAt: string }>();
    expect(grant.accessToken).toMatch(/^a1\./);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(ASSET_SHARE_ACCESS_TTL_MS);
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.parse(share.expiresAt));
    expect(contentLookup).not.toHaveBeenCalled();

    const metadata = await app.inject({
      method: 'GET',
      url: `${metadataUrl}&access_token=${encodeURIComponent(grant.accessToken)}`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({
      asset: {
        name: 'private-result.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
        sizeBytes: Buffer.byteLength('version-one'),
        version: 1,
        contentUrl: `${contentUrl}&access_token=${encodeURIComponent(grant.accessToken)}`,
      },
      expiresAt: grant.expiresAt,
    });
    expect(JSON.stringify(metadata.json())).not.toMatch(/owner|project|metadata|prompt|salt|hash/i);

    const partial = await app.inject({
      method: 'GET',
      url: metadata.json<{ asset: { contentUrl: string } }>().asset.contentUrl,
      headers: { range: 'bytes=0-6' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload).toEqual(Buffer.from('version'));
    expect(partial.headers['content-range']).toBe('bytes 0-6/11');

    const authorizedHead = await app.inject({
      method: 'HEAD',
      url: metadata.json<{ asset: { contentUrl: string } }>().asset.contentUrl,
    });
    expect(authorizedHead.statusCode).toBe(200);
    expect(authorizedHead.rawPayload.byteLength).toBe(0);
    expect(authorizedHead.headers['content-length']).toBe('11');
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

  it('validates password fields by UTF-16 length without widening the anonymous route allowlist', async () => {
    const { app, asset } = await fixture();
    const maxPassword = '😀'.repeat(64);
    expect(maxPassword.length).toBe(128);
    const accepted = await issueShare(app, asset.id, ownerId, { password: maxPassword });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().token).toMatch(/^v2\./);

    for (const payload of [
      { password: 42 },
      { password: null },
      { password: `${maxPassword}x` },
      { password: 'valid', extra: true },
    ]) {
      const response = await issueShare(app, asset.id, ownerId, payload);
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }

    const token = accepted.json<{ token: string }>().token;
    for (const payload of [
      { token },
      { token: 42, password: maxPassword },
      { token, password: `${maxPassword}x` },
      { token, password: maxPassword, extra: true },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/asset-shares/unlock',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }

    for (const request of [
      { method: 'GET' as const, url: '/v1/asset-shares/unlock' },
      { method: 'PUT' as const, url: '/v1/asset-shares/unlock', payload: {} },
      { method: 'POST' as const, url: '/v1/asset-shares', payload: {} },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
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

  it('expires unlock grants and prevents cross-link or cross-purpose authorization', async () => {
    const { app, asset } = await fixture();
    const password = 'binding-secret';
    const first = (await issueShare(app, asset.id, ownerId, { password })).json<{
      token: string;
    }>();
    const second = (await issueShare(app, asset.id, ownerId, { password })).json<{
      token: string;
    }>();
    expect(second.token).not.toBe(first.token);

    const unlocked = await unlockShare(app, first.token, password);
    expect(unlocked.statusCode).toBe(200);
    const grant = unlocked.json<{ accessToken: string; expiresAt: string }>();

    const crossLink = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares?token=${encodeURIComponent(second.token)}&access_token=${encodeURIComponent(grant.accessToken)}`,
    });
    expect(crossLink.statusCode).toBe(401);
    expect(crossLink.json().code).toBe('SHARE_PASSWORD_REQUIRED');

    const shareAsGrant = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares?token=${encodeURIComponent(first.token)}&access_token=${encodeURIComponent(first.token)}`,
    });
    expect(shareAsGrant.statusCode).toBe(401);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/asset-shares?token=${encodeURIComponent(grant.accessToken)}`,
        })
      ).statusCode,
    ).toBe(404);

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.expiresAt));
    const expiredGrant = await app.inject({
      method: 'GET',
      url: `/v1/asset-shares?token=${encodeURIComponent(first.token)}&access_token=${encodeURIComponent(grant.accessToken)}`,
    });
    expect(expiredGrant.statusCode).toBe(401);
    expect(expiredGrant.json().code).toBe('SHARE_PASSWORD_REQUIRED');
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

  it('returns 404 from unlock for malformed, unprotected, expired or archived shares', async () => {
    const { app, store, asset } = await fixture();
    expect((await unlockShare(app, 'not-a-share-token', 'password')).statusCode).toBe(404);

    const unprotected = (await issueShare(app, asset.id)).json<{ token: string }>().token;
    expect((await unlockShare(app, unprotected, 'password')).statusCode).toBe(404);

    const expired = await createPasswordProtectedAssetShareToken(
      { assetId: asset.id, ownerId, version: 1, expiresAt: Date.now() - 1 },
      shareSecret,
      'password',
    );
    expect((await unlockShare(app, expired, 'password')).statusCode).toBe(404);

    const protectedToken = (
      await issueShare(app, asset.id, ownerId, { password: 'password' })
    ).json<{ token: string }>().token;
    await store.setArchived(asset.id, true, { ownerId });
    const archived = await unlockShare(app, protectedToken, 'password');
    expect(archived.statusCode).toBe(404);
    expect(archived.headers['cache-control']).toBe('no-store');
  });

  it('returns 404 when the share expires while asynchronous password verification is running', async () => {
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'expiring-share.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      content: Buffer.from('expiring-share'),
      ownerId,
    });
    const app = buildApp({
      assetStore: store,
      userExists: async () => true,
      logger: false,
      rateLimiter: {
        consume: async (_key, options) => ({
          allowed: true,
          limit: options.limit,
          remaining: options.limit - 1,
          resetAt: 0,
          retryAfterSeconds: 1,
        }),
      },
    });
    apps.push(app);
    const verificationTime = 1_000_000;
    const expiresAt = verificationTime + 1;
    const token = await createPasswordProtectedAssetShareToken(
      { assetId: asset.id, ownerId, version: 1, expiresAt },
      shareSecret,
      'expiring-password',
    );
    vi.spyOn(Date, 'now').mockReturnValueOnce(verificationTime).mockReturnValue(expiresAt);

    const response = await unlockShare(app, token, 'expiring-password');
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: 'asset share not found or expired' });
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

  it('keeps unlock attempts limited for 15 minutes across short-window reads and redacts body/query secrets', async () => {
    let limiterNow = 0;
    const messages: string[] = [];
    const store = new MemoryAssetStore();
    const asset = await store.create({
      name: 'protected-log.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      content: Buffer.from('protected-log-content'),
      ownerId,
    });
    const app = buildApp({
      assetStore: store,
      userExists: async () => true,
      logger: { stream: { write: (message) => messages.push(message) } },
      rateLimiter: new MemoryRateLimiter({ now: () => limiterNow }),
    });
    apps.push(app);
    const password = 'password-body-marker-keep-private';
    const token = (await issueShare(app, asset.id, ownerId, { password })).json<{ token: string }>()
      .token;
    const unlocked = await unlockShare(app, token, password);
    expect(unlocked.statusCode).toBe(200);
    const accessToken = unlocked.json<{ accessToken: string }>().accessToken;
    const metadataUrl = `/v1/asset-shares?token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(accessToken)}`;
    expect((await app.inject({ method: 'GET', url: metadataUrl })).statusCode).toBe(200);

    for (let attempt = 1; attempt < 10; attempt += 1) {
      expect(
        (await unlockShare(app, `invalid-token-${attempt}`, `password-body-marker-${attempt}`))
          .statusCode,
      ).toBe(404);
    }

    limiterNow = 60_000;
    expect((await app.inject({ method: 'GET', url: metadataUrl })).statusCode).toBe(200);
    const blocked = await unlockShare(app, 'invalid-token-blocked', 'password-body-marker-blocked');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.headers['x-ratelimit-limit']).toBe('10');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(14 * 60);
    expect(blocked.json().code).toBe('asset_share_unlock_rate_limit_exceeded');

    const logs = messages.join('');
    expect(logs).not.toContain(password);
    expect(logs).not.toContain('password-body-marker');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain('token=');
    expect(logs).not.toContain('access_token=');
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

describe('asset share OpenAPI contract', () => {
  it('documents password issuance, anonymous unlock and grants on every protected read method', () => {
    const paths = openApiDocument.paths as Record<string, any>;
    const issueSchema =
      paths['/v1/assets/{assetId}/share'].post.requestBody.content['application/json'].schema;
    expect(issueSchema.properties.password).toMatchObject({ type: 'string', maxLength: 128 });

    const unlock = paths['/v1/asset-shares/unlock'].post;
    expect(unlock.security).toEqual([]);
    expect(unlock.requestBody.content['application/json'].schema).toMatchObject({
      required: ['token', 'password'],
      additionalProperties: false,
    });
    expect(unlock.responses).toMatchObject({
      '200': expect.any(Object),
      '400': expect.any(Object),
      '401': expect.any(Object),
      '404': expect.any(Object),
      '429': expect.any(Object),
      '503': expect.any(Object),
    });

    for (const [path, methods] of [
      ['/v1/asset-shares', ['get', 'head']],
      ['/v1/asset-shares/content', ['get', 'head']],
    ] as const) {
      for (const method of methods) {
        const operation = paths[path][method];
        expect(operation.security).toEqual([]);
        expect(operation.parameters.map((parameter: { name: string }) => parameter.name)).toContain(
          'access_token',
        );
        expect(operation.responses['401']).toBeDefined();
      }
    }
  });
});

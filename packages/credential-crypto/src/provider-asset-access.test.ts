import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createProviderAssetAccessToken,
  createProviderAssetUrlSignerFromEnvironment,
  PROVIDER_ASSET_ACCESS_TTL_SECONDS,
  providerAssetAccessPath,
  verifyProviderAssetAccessToken,
  type ProviderAssetAccessGrant,
} from './index';

const NOW = 1_700_000_000_000;
const SECRET = 'synthetic-provider-asset-secret';

function grant(overrides: Partial<ProviderAssetAccessGrant> = {}): ProviderAssetAccessGrant {
  return {
    assetId: 'asset/provider-1',
    version: 3,
    projectId: 'project-1',
    ownerId: 'owner-1',
    expiresAt: NOW + 15 * 60 * 1000,
    ...overrides,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** 构造测试用签名载荷，覆盖 iat 和严格字段校验。 */
function signedPayload(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = encode(payload);
  const domainKey = createHmac('sha256', secret).update('provider-asset-access', 'utf8').digest();
  const signature = createHmac('sha256', domainKey)
    .update(`v1.${encoded}`, 'utf8')
    .digest('base64url');
  return `v1.${encoded}.${signature}`;
}

describe('Provider asset access token', () => {
  it('shared URL signer preserves the frozen grant and one-hour token contract', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const signer = createProviderAssetUrlSignerFromEnvironment({
        CANVAS_WEB_URL: 'https://canvas.example.com/workspace',
        ASSET_ACCESS_URL_SECRET: SECRET,
        API_JWT_SECRET: 'synthetic-other-session-key',
      });
      const { expiresAt: _expiresAt, ...frozen } = grant();
      const url = new URL(signer!(frozen));
      const token = url.searchParams.get('access_token')!;
      expect(url.origin).toBe('https://canvas.example.com');
      expect(url.pathname).toBe('/v1/provider-assets/asset%2Fprovider-1/versions/3/content');
      expect(verifyProviderAssetAccessToken(token, SECRET, NOW)).toEqual({
        ...frozen,
        expiresAt: NOW + PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000,
      });
      expect(
        verifyProviderAssetAccessToken(token, 'synthetic-other-session-key', NOW),
      ).toBeUndefined();
      expect(
        verifyProviderAssetAccessToken(
          token,
          SECRET,
          NOW + PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000,
        ),
      ).toBeUndefined();
      expect(url.toString()).not.toContain(SECRET);
    } finally {
      clock.mockRestore();
    }
  });

  it('round-trips a grant and builds an encoded version path', () => {
    const input = grant();
    const token = createProviderAssetAccessToken(input, SECRET, NOW);

    expect(token.split('.')).toHaveLength(3);
    expect(verifyProviderAssetAccessToken(token, SECRET, NOW)).toEqual(input);
    expect(providerAssetAccessPath(input.assetId, input.version)).toBe(
      '/v1/provider-assets/asset%2Fprovider-1/versions/3/content',
    );
  });

  it('uses the one-hour boundary and rejects invalid grant fields', () => {
    const boundary = grant({ expiresAt: NOW + PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000 });
    expect(
      verifyProviderAssetAccessToken(
        createProviderAssetAccessToken(boundary, SECRET, NOW),
        SECRET,
        NOW,
      ),
    ).toEqual(boundary);
    expect(() =>
      createProviderAssetAccessToken(
        grant({ expiresAt: NOW + PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000 + 1 }),
        SECRET,
        NOW,
      ),
    ).toThrow('maximum ttl');
    expect(() => createProviderAssetAccessToken(grant({ version: 0 }), SECRET, NOW)).toThrow(
      'version',
    );
    expect(() => createProviderAssetAccessToken(grant({ ownerId: '  ' }), SECRET, NOW)).toThrow(
      'ownerId',
    );
    expect(() =>
      createProviderAssetAccessToken({ ...grant(), extra: true } as never, SECRET, NOW),
    ).toThrow('fields');
  });

  it('rejects expiry at now, empty secrets, wrong keys, and tampering', () => {
    expect(() => createProviderAssetAccessToken(grant({ expiresAt: NOW }), SECRET, NOW)).toThrow(
      'expiration',
    );
    expect(() => createProviderAssetAccessToken(grant(), '  ', NOW)).toThrow('secret');

    const token = createProviderAssetAccessToken(grant(), SECRET, NOW);
    const [version, payload, signature] = token.split('.');
    const tampered = `${version}.${payload}.${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
    expect(verifyProviderAssetAccessToken(tampered, SECRET, NOW)).toBeUndefined();
    expect(verifyProviderAssetAccessToken(token, 'other-secret', NOW)).toBeUndefined();
    expect(verifyProviderAssetAccessToken(token, undefined, NOW)).toBeUndefined();
    expect(verifyProviderAssetAccessToken(undefined, SECRET, NOW)).toBeUndefined();
  });

  it('does not accept an ordinary HS256 JWT signed with the same secret', () => {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({ sub: 'owner-1', exp: Math.floor(NOW / 1000) + 600 });
    const signature = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`, 'utf8')
      .digest('base64url');

    expect(
      verifyProviderAssetAccessToken(`${header}.${payload}.${signature}`, SECRET, NOW),
    ).toBeUndefined();
  });

  it('requires iat and enforces its maximum lifetime', () => {
    const base = grant({ expiresAt: NOW + 1_000 });
    const withoutIat = signedPayload(base);
    expect(verifyProviderAssetAccessToken(withoutIat, SECRET, NOW)).toBeUndefined();

    const stale = signedPayload({
      ...base,
      iat: NOW - PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000 - 1,
    });
    expect(verifyProviderAssetAccessToken(stale, SECRET, NOW)).toBeUndefined();

    const futureIat = signedPayload({ ...base, iat: NOW + 1 });
    expect(verifyProviderAssetAccessToken(futureIat, SECRET, NOW)).toBeUndefined();

    const extraField = signedPayload({ ...base, iat: NOW, unexpected: true });
    expect(verifyProviderAssetAccessToken(extraField, SECRET, NOW)).toBeUndefined();
  });

  it('enforces canonical base64url and token length limits', () => {
    const token = createProviderAssetAccessToken(grant(), SECRET, NOW);
    const [version, payload, signature] = token.split('.');
    expect(
      verifyProviderAssetAccessToken(`${version}.${payload}=.${signature}`, SECRET, NOW),
    ).toBeUndefined();
    expect(
      verifyProviderAssetAccessToken(`${token}${'x'.repeat(16 * 1024)}`, SECRET, NOW),
    ).toBeUndefined();
    expect(providerAssetAccessPath('a b?c', 1)).toBe(
      '/v1/provider-assets/a%20b%3Fc/versions/1/content',
    );
    expect(() => providerAssetAccessPath('', 1)).toThrow('assetId');
    expect(() => providerAssetAccessPath('asset', 1.5)).toThrow('version');
  });
});

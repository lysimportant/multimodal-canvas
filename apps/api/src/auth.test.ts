import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { authenticateBearer } from './auth';

function token(payload: Record<string, unknown>, secret = 'test-secret') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('Bearer authentication', () => {
  it('keeps static service tokens compatible', () => {
    expect(authenticateBearer('Bearer static-token', { apiToken: 'static-token' })).toEqual({
      ok: true,
      principal: { method: 'api-token' },
    });
  });

  it('verifies HS256 user claims and time bounds', () => {
    const jwt = token({
      user_id: '123e4567-e89b-12d3-a456-426614174000',
      exp: 2_000,
      nbf: 1_000,
    });
    expect(
      authenticateBearer(`Bearer ${jwt}`, { jwtSecret: 'test-secret', now: () => 1_500_000 }),
    ).toEqual({
      ok: true,
      principal: { method: 'jwt', userId: '123e4567-e89b-12d3-a456-426614174000' },
    });
  });

  it('rejects external numeric or non-UUID user ids before owner scoping', () => {
    for (const claim of [{ user_id: 486 }, { sub: 'user-1' }]) {
      const jwt = token(claim);
      expect(authenticateBearer(`Bearer ${jwt}`, { jwtSecret: 'test-secret' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('rejects a forged, expired, or not-yet-valid token', () => {
    const jwt = token({ sub: 'user-1', exp: 10 });
    expect(
      authenticateBearer(`Bearer ${jwt}`, { jwtSecret: 'test-secret', now: () => 11_000 }),
    ).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    const future = token({ sub: 'user-1', nbf: 20 });
    expect(
      authenticateBearer(`Bearer ${future}`, { jwtSecret: 'test-secret', now: () => 10_000 }),
    ).toMatchObject({
      ok: false,
      reason: 'not-yet-valid',
    });
    expect(
      authenticateBearer(`Bearer ${jwt.slice(0, -1)}x`, { jwtSecret: 'test-secret' }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });
});

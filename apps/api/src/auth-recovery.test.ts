import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './fixtures/test-app';
import { TestAuthContext } from './fixtures/auth-session';
import { AuthService, AuthServiceError } from './auth-service';
import type { NewApiAccountService } from './newapi-account-service';

beforeEach(() => {
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', 'auth-recovery-test-secret');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const context = new TestAuthContext();
  const session = await context.session({ email: 'recovery@example.test' });
  const service = {
    options: {
      auth: context.auth,
      webUrl: 'http://localhost:8080',
      client: { options: { redirectUri: 'http://localhost:8080/v1/auth/newapi/callback' } },
    },
    synchronizeIfStale: vi.fn(async () => undefined),
    identity: vi.fn(async () => ({ status: 'active', expiresAt: new Date(Date.now() + 86400000) })),
  } as unknown as NewApiAccountService;
  const app = buildApp({ logger: false, newApiAccount: service, ...context.appOptions });
  return { app, context, session, headers: { cookie: `canvas_session=${session.accessToken}` } };
}

describe('authentication failure classification and recovery', () => {
  it('distinguishes missing credentials from short-lived token expiry and permits renewal', async () => {
    const { app, context } = await fixture();
    try {
      const missing = await app.inject({ method: 'GET', url: '/v1/projects' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().code).toBe('authentication_missing');
      const user = (await context.store.findUserByEmail('recovery@example.test'))!;
      const oldIssuer = new AuthService({
        store: context.store,
        jwtSecret: 'auth-recovery-test-secret',
        now: () => Date.now() - 16 * 60000,
      });
      const old = await oldIssuer.issueToken(user);
      const headers = { cookie: `canvas_session=${old.accessToken}` };
      const expired = await app.inject({ method: 'GET', url: '/v1/projects', headers });
      expect(expired.statusCode).toBe(401);
      expect(expired.json().code).toBe('access_token_expired');
      const restored = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
      expect(restored.statusCode).toBe(200);
      expect(restored.headers['set-cookie']).toContain('canvas_session=');
      expect(restored.json()).not.toHaveProperty('accessToken');
    } finally {
      await app.close();
    }
  });

  it.each(['lookup', 'rotation'] as const)(
    'returns 503 for a temporary %s storage failure, keeping the session usable',
    async (stage) => {
      const { app, context, session, headers } = await fixture();
      try {
        const method = stage === 'lookup' ? 'verifySessionForRefresh' : 'refresh';
        vi.spyOn(context.auth, method).mockRejectedValueOnce(
          new Error('synthetic database unavailable'),
        );
        const response = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'authentication_unavailable' });
        expect(response.body).not.toContain('synthetic database');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect((await context.auth.verifyAccessToken(session.accessToken)).user.id).toBe(
          session.user.id,
        );
      } finally {
        await app.close();
      }
    },
  );

  it('keeps a rotation conflict recognizable as 401 instead of internal server error', async () => {
    const { app, context, headers } = await fixture();
    try {
      vi.spyOn(context.auth, 'refresh').mockRejectedValueOnce(
        new AuthServiceError('session_revoked', 'session has been revoked'),
      );
      const response = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('session_revoked');
    } finally {
      await app.close();
    }
  });

  it('still rejects an explicitly revoked session before renewal', async () => {
    const { app, context, session, headers } = await fixture();
    try {
      await context.auth.logout(session.accessToken);
      const response = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe('session_revoked');
    } finally {
      await app.close();
    }
  });
});

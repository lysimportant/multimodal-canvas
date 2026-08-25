import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAuthStore } from './auth-store';
import { hashPassword } from './auth-service';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authentication routes', () => {
  it('registers, logs in, resolves the current user, and revokes one session', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
    const app = buildApp({ logger: false, authStore: new MemoryAuthStore() });

    try {
      const registered = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: 'Route.User@Example.com',
          password: 'correct password',
          displayName: 'Route User',
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.json()).toMatchObject({
        tokenType: 'Bearer',
        user: { email: 'route.user@example.com', displayName: 'Route User', role: 'user' },
      });
      expect(registered.json().user).not.toHaveProperty('passwordHash');

      const accessToken = registered.json().accessToken as string;
      const me = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { email: 'route.user@example.com' } });

      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Owned project' },
      });
      expect(project.statusCode).toBe(201);

      const logout = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ loggedOut: true });

      const revokedMe = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(revokedMe.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns generic login errors and revokes all sessions for the user', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
    const app = buildApp({ logger: false, authStore: new MemoryAuthStore() });

    try {
      const registration = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'sessions@example.com', password: 'correct password' },
      });
      const firstToken = registration.json().accessToken as string;
      const secondLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'SESSIONS@example.com', password: 'correct password' },
      });
      expect(secondLogin.statusCode).toBe(200);
      const secondToken = secondLogin.json().accessToken as string;

      const logoutAll = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout-all',
        headers: { authorization: `Bearer ${firstToken}` },
      });
      expect(logoutAll.statusCode).toBe(200);
      expect(logoutAll.json().revokedSessions).toBe(2);

      for (const accessToken of [firstToken, secondToken]) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(response.statusCode).toBe(401);
      }

      const unknown = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'missing@example.com', password: 'correct password' },
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json()).toEqual({ error: 'invalid email or password' });
    } finally {
      await app.close();
    }
  });

  it('does not expose auth routes when no JWT signing secret is configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', '');
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'disabled@example.com', password: 'correct password' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'authentication service unavailable' });
    } finally {
      await app.close();
    }
  });

  it('allows an administrator session to manage platform settings but rejects a regular user', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
    const authStore = new MemoryAuthStore();
    await authStore.createUser({
      email: 'admin@example.com',
      passwordHash: await hashPassword('correct password'),
      role: 'admin',
    });
    const app = buildApp({ logger: false, authStore });

    try {
      const adminLogin = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'admin@example.com', password: 'correct password' },
      });
      expect(adminLogin.statusCode).toBe(200);
      const adminToken = adminLogin.json().accessToken as string;
      const adminSettings = await app.inject({
        method: 'GET',
        url: '/v1/settings/ai',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(adminSettings.statusCode).toBe(200);

      const regularRegistration = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: { email: 'user@example.com', password: 'correct password' },
      });
      const regularToken = regularRegistration.json().accessToken as string;
      const regularSettings = await app.inject({
        method: 'GET',
        url: '/v1/settings/ai',
        headers: { authorization: `Bearer ${regularToken}` },
      });
      expect(regularSettings.statusCode).toBe(403);
      expect(regularSettings.json()).toEqual({
        error: 'platform credential access is not permitted',
      });
    } finally {
      await app.close();
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAuthStore } from './auth-store';
import { hashPassword } from './auth-service';
import { TestAccountMailSender, registerVerifiedTestUser } from './fixtures/account-mail';
import { signHs256Jwt } from './auth';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authentication routes', () => {
  it.each(['test', 'production'])(
    '账户存储在 %s 环境拒绝旧无 sid JWT，显式 userExists 不能绕过',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('API_AUTH_TOKEN', 'synthetic-service-token');
      vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
      const authStore = new MemoryAuthStore();
      const user = await authStore.createUser({
        email: 'legacy-route@example.test',
        passwordHash: await hashPassword('correct password'),
      });
      const userExists = vi.fn(async () => true);
      const app = buildApp({ logger: false, authStore, userExists });
      const now = Math.floor(Date.now() / 1000);
      const legacy = signHs256Jwt(
        { sub: user.id, iat: now, exp: now + 3600, role: 'user' },
        'route-test-secret',
      );
      try {
        const denied = await app.inject({
          method: 'GET',
          url: '/v1/projects',
          headers: { authorization: `Bearer ${legacy}` },
        });
        expect(denied.statusCode).toBe(401);
        expect(denied.json().code).toBe('session_required');
        expect(userExists).not.toHaveBeenCalled();
        const login = await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: user.email, password: 'correct password' },
        });
        expect(login.statusCode).toBe(200);
        const oldHeaders = { authorization: `Bearer ${login.json().accessToken}` };
        const changed = await app.inject({
          method: 'POST',
          url: '/v1/account/password',
          headers: oldHeaders,
          payload: { currentPassword: 'correct password', newPassword: 'replacement password' },
        });
        expect(changed.statusCode).toBe(200);
        expect(
          (await app.inject({ method: 'GET', url: '/v1/projects', headers: oldHeaders }))
            .statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/projects',
              headers: { authorization: `Bearer ${legacy}` },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/projects',
              headers: { authorization: `Bearer ${changed.json().accessToken}` },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/projects',
              headers: { authorization: 'Bearer synthetic-service-token' },
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it('无账户存储的显式外部用户适配器仍可接续无 sid JWT，但不能获得管理员设置权限', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
    const userExists = vi.fn(async () => true);
    const app = buildApp({ logger: false, userExists });
    const token = signHs256Jwt(
      {
        sub: '11111111-1111-4111-8111-111111111111',
        exp: Math.floor(Date.now() / 1000) + 300,
        role: 'admin',
      },
      'route-test-secret',
    );
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/projects',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(userExists).toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/settings/ai',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('registers, logs in, resolves the current user, and revokes one session', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
    const mail = new TestAccountMailSender();
    const app = buildApp({
      logger: false,
      authStore: new MemoryAuthStore(),
      accountMailSender: mail,
    });

    try {
      const registered = await registerVerifiedTestUser(app, mail, {
        email: 'Route.User@Example.com',
        password: 'correct password',
        displayName: 'Route User',
      });
      expect(registered.statusCode).toBe(200);
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
    const mail = new TestAccountMailSender();
    const app = buildApp({
      logger: false,
      authStore: new MemoryAuthStore(),
      accountMailSender: mail,
    });

    try {
      const registration = await registerVerifiedTestUser(app, mail, {
        email: 'sessions@example.com',
        password: 'correct password',
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
    const mail = new TestAccountMailSender();
    const app = buildApp({ logger: false, authStore, accountMailSender: mail });

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

      const regularRegistration = await registerVerifiedTestUser(app, mail, {
        email: 'user@example.com',
        password: 'correct password',
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

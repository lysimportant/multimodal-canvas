import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './fixtures/test-app';
import { TestAuthContext } from './fixtures/auth-session';
import { signHs256Jwt } from './auth';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', 'route-test-secret');
});
afterEach(() => vi.unstubAllEnvs());

describe('New API 身份建立后的会话路由', () => {
  it.each(['test', 'production'])(
    '%s 环境拒绝无持久会话的旧 JWT，用户适配器不能绕过',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const context = new TestAuthContext();
      const current = await context.session({ email: 'legacy@example.test' });
      const userExists = vi.fn(async () => true);
      const app = buildApp({ logger: false, ...context.appOptions, userExists });
      const legacy = signHs256Jwt(
        { sub: current.user.id, exp: Math.floor(Date.now() / 1000) + 300, role: 'user' },
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
        const headers = { authorization: `Bearer ${current.accessToken}` };
        expect((await app.inject({ method: 'GET', url: '/v1/projects', headers })).statusCode).toBe(
          200,
        );
        await context.auth.logout(current.accessToken);
        expect((await app.inject({ method: 'GET', url: '/v1/projects', headers })).statusCode).toBe(
          401,
        );
      } finally {
        await app.close();
      }
    },
  );

  it('读取公开资料、创建本人项目，退出只撤销当前会话', async () => {
    const context = new TestAuthContext();
    const first = await context.session({
      email: 'sessions@example.test',
      displayName: 'Session User',
    });
    const second = await context.session({ email: 'sessions@example.test' });
    const app = buildApp({ logger: false, ...context.appOptions });
    const headers = { authorization: `Bearer ${first.accessToken}` };
    try {
      const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { id: first.user.id, displayName: 'Session User' } });
      expect(me.body).not.toContain('passwordHash');
      expect(me.body).not.toContain('tokenHash');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/projects',
            headers,
            payload: { name: 'Owned project' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).json(),
      ).toEqual({ loggedOut: true });
      expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/auth/me',
            headers: { authorization: `Bearer ${second.accessToken}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('退出所有会话不会影响另一位用户，管理员权限由服务端记录决定', async () => {
    const context = new TestAuthContext();
    const first = await context.session({ email: 'a@example.test' });
    const second = await context.session({ email: 'a@example.test' });
    const admin = await context.session({ email: 'admin@example.test', role: 'admin' });
    const app = buildApp({ logger: false, ...context.appOptions });
    try {
      const headers = { authorization: `Bearer ${first.accessToken}` };
      expect(
        (await app.inject({ method: 'GET', url: '/v1/admin/resource-groups', headers })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/logout-all', headers })).json()
          .revokedSessions,
      ).toBe(2);
      for (const session of [first, second])
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/auth/me',
              headers: { authorization: `Bearer ${session.accessToken}` },
            })
          ).statusCode,
        ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/admin/resource-groups',
            headers: { authorization: `Bearer ${admin.accessToken}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('已退役的注册、密码、邮件和管理员写入口始终返回 410', async () => {
    const context = new TestAuthContext();
    const app = buildApp({ logger: false, ...context.appOptions });
    try {
      for (const url of [
        '/v1/auth/register',
        '/v1/auth/login',
        '/v1/account/password',
        '/v1/account/email',
        '/v1/admin/bootstrap',
      ]) {
        const response = await app.inject({ method: 'POST', url, payload: {} });
        expect(response.statusCode, url).toBe(410);
      }
      for (const [method, url] of [
        ['DELETE', '/v1/settings/ai/credentials'],
        ['DELETE', '/v1/settings/ai/credentials/old-id'],
        ['POST', '/v1/settings/ai/credentials/old-id/activate'],
        ['PATCH', '/v1/settings/ai/credentials/old-id/defaults'],
        ['POST', '/v1/settings/ai/test'],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, url).toBe(410);
        expect(response.json().code).toBe('legacy_endpoint_retired');
      }
      expect(await context.store.listUsers()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

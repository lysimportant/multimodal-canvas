import { describe, expect, it } from 'vitest';

import { MemoryAuthStore } from './auth-store';
import { AuthService, AuthServiceError, hashPassword, verifyPassword } from './auth-service';
import { verifyHs256Jwt } from './auth';

describe('email/password authentication service', () => {
  it('hashes passwords with scrypt and never returns the password hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$1\$32768\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);

    const store = new MemoryAuthStore();
    const service = new AuthService({
      store,
      jwtSecret: 'test-secret',
      now: () => 1_700_000_000_000,
    });
    const response = await service.register({
      email: 'User@Example.com',
      password: 'correct horse battery staple',
      displayName: 'Test User',
    });
    expect(response.user).toMatchObject({ email: 'user@example.com', role: 'user' });
    expect(response.user).not.toHaveProperty('passwordHash');
    expect(response.accessToken).not.toContain('correct horse');
  });

  it('uses one generic login failure for unknown email and wrong password', async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, jwtSecret: 'test-secret' });
    await service.register({ email: 'known@example.com', password: 'correct password' });

    const failures = await Promise.all(
      [
        service.login({ email: 'missing@example.com', password: 'correct password' }),
        service.login({ email: 'known@example.com', password: 'wrong password' }),
      ].map(async (request) => {
        try {
          await request;
          return undefined;
        } catch (error) {
          return error;
        }
      }),
    );
    expect(failures).toHaveLength(2);
    for (const error of failures) {
      expect(error).toBeInstanceOf(AuthServiceError);
      expect(error).toMatchObject({
        code: 'invalid_credentials',
        message: 'invalid email or password',
      });
    }
  });

  it('issues a short-lived role-bearing token and supports session revocation', async () => {
    let now = 1_700_000_000_000;
    const store = new MemoryAuthStore();
    const service = new AuthService({
      store,
      jwtSecret: 'test-secret',
      accessTokenTtlSeconds: 300,
      now: () => now,
    });
    const registered = await service.register({
      email: 'admin@example.com',
      password: 'correct password',
    });
    const user = await store.findUserByEmail('admin@example.com');
    expect(user).toBeDefined();
    // Roles are stored server-side; this simulates an administrator promotion
    // without trusting a caller-provided JWT role claim.
    const adminStore = new MemoryAuthStore();
    const adminService = new AuthService({
      store: adminStore,
      jwtSecret: 'test-secret',
      now: () => now,
    });
    const admin = await adminStore.createUser({
      email: 'admin2@example.com',
      passwordHash: await hashPassword('correct password'),
      role: 'admin',
    });
    expect(admin.role).toBe('admin');
    const adminToken = await adminService.login({
      email: 'admin2@example.com',
      password: 'correct password',
    });
    const claims = verifyHs256Jwt(adminToken.accessToken, 'test-secret', () => now, true);
    expect(claims).toMatchObject({ ok: true, claims: { sub: admin.id, role: 'admin' } });
    expect(adminToken.expiresIn).toBe(900);
    await expect(adminService.verifyAccessToken(adminToken.accessToken)).resolves.toMatchObject({
      user: { id: admin.id, role: 'admin' },
    });

    expect(await adminService.logout(adminToken.accessToken)).toBe(true);
    await expect(adminService.verifyAccessToken(adminToken.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });

    const second = await service.login({
      email: 'admin@example.com',
      password: 'correct password',
    });
    now += 1_000;
    expect(await service.logoutAll(registered.user.id)).toBe(2);
    await expect(service.verifyAccessToken(second.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  it('rejects expired access tokens and invalidates the session after expiry', async () => {
    let now = 1_700_000_000_000;
    const store = new MemoryAuthStore();
    const service = new AuthService({
      store,
      jwtSecret: 'test-secret',
      accessTokenTtlSeconds: 60,
      now: () => now,
    });
    const response = await service.register({
      email: 'expiry@example.com',
      password: 'correct password',
    });
    now += 61_000;
    await expect(service.verifyAccessToken(response.accessToken)).rejects.toMatchObject({
      code: 'invalid_token',
    });
    expect(await service.logout(response.accessToken)).toBe(false);
  });
});

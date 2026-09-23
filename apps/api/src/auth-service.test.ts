import { describe, expect, it } from 'vitest';
import { MemoryAuthStore } from './auth-store';
import { AuthService } from './auth-service';
import { verifyHs256Jwt } from './auth';

describe('已验证身份的 Canvas 会话', () => {
  it('New API 会话以已验证授权为上限，旧 7 天会话续期后可延长但不能绕过撤销', async () => {
    let now = Date.now();
    const store = new MemoryAuthStore();
    const user = await store.createUser({ email: 'synthetic@example.test' });
    const auth = new AuthService({
      store,
      jwtSecret: 'synthetic-secret',
      now: () => now,
      maxSessionTtlSeconds: 30 * 86400,
    });
    const grant = new Date(now + 25 * 86400000);
    const initial = await auth.issueToken(user, grant);
    expect(initial.refreshExpiresAt).toBe(grant.toISOString());
    const capped = await auth.issueToken(user, new Date(now + 50 * 86400000));
    expect(Date.parse(capped.refreshExpiresAt)).toBe(now + 30 * 86400000);
    const legacy = await auth.issueToken(user, new Date(now + 7 * 86400000));
    now += 86400000;
    const renewed = await auth.refresh(legacy.accessToken, grant);
    expect(renewed.refreshExpiresAt).toBe(grant.toISOString());
    await expect(auth.refresh(legacy.accessToken, grant)).rejects.toMatchObject({
      code: 'session_revoked',
    });
    await store.updateUser(user.id, { status: 'disabled' });
    await expect(auth.refresh(renewed.accessToken, grant)).rejects.toMatchObject({
      code: 'invalid_token',
    });
    await store.updateUser(user.id, { status: 'active' });
    now = grant.getTime();
    await expect(auth.refresh(renewed.accessToken, grant)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });
  it('签发短期会话、服务端角色及最晚期限，不公开会话材料', async () => {
    const store = new MemoryAuthStore();
    const user = await store.createUser({ email: 'synthetic@example.test', role: 'admin' });
    const auth = new AuthService({ store, jwtSecret: 'synthetic-secret' });
    const result = await auth.issueToken(user);
    expect(result.expiresIn).toBe(900);
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(verifyHs256Jwt(result.accessToken, 'synthetic-secret', Date.now, true)).toMatchObject({
      ok: true,
      claims: { sub: user.id, role: 'admin' },
    });
    expect((await auth.verifyAccessToken(result.accessToken)).user.id).toBe(user.id);
    await auth.logout(result.accessToken);
    await expect(auth.verifyAccessToken(result.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  it('过期访问令牌只能续期且续期不会延长绝对期限，原令牌不能再用', async () => {
    let now = Date.now();
    const store = new MemoryAuthStore();
    const user = await store.createUser({ email: 'synthetic@example.test' });
    const auth = new AuthService({
      store,
      jwtSecret: 'synthetic-secret',
      now: () => now,
      accessTokenTtlSeconds: 60,
    });
    const first = await auth.issueToken(user, new Date(now + 300_000));
    now += 61_000;
    await expect(auth.verifyAccessToken(first.accessToken)).rejects.toMatchObject({
      code: 'invalid_token',
    });
    const renewed = await auth.refresh(first.accessToken);
    expect(renewed.refreshExpiresAt).toBe(first.refreshExpiresAt);
    await expect(auth.refresh(first.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
    now += 300_000;
    await expect(auth.refresh(renewed.accessToken)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('访问令牌过期但绝对期限尚有效时主动退出仍撤销会话', async () => {
    let now = Date.now();
    const store = new MemoryAuthStore();
    const user = await store.createUser({ email: 'synthetic@example.test' });
    const auth = new AuthService({ store, jwtSecret: 'synthetic-secret', now: () => now });
    const first = await auth.issueToken(user);
    now += 16 * 60000;
    expect(await auth.logout(first.accessToken)).toBe(true);
    await expect(auth.refresh(first.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  it('并发续期最多签发一次，禁用或注销所有会话后不能恢复', async () => {
    const store = new MemoryAuthStore();
    const user = await store.createUser({ email: 'synthetic@example.test' });
    const auth = new AuthService({ store, jwtSecret: 'synthetic-secret' });
    const first = await auth.issueToken(user);
    const results = await Promise.allSettled([
      auth.refresh(first.accessToken),
      auth.refresh(first.accessToken),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const renewed = results.find((result) => result.status === 'fulfilled')!;
    if (renewed.status !== 'fulfilled') throw new Error('expected successful renewal');
    expect(await auth.logoutAll(user.id)).toBe(1);
    await expect(auth.verifyAccessToken(renewed.value.accessToken)).rejects.toThrow();
    await store.updateUser(user.id, { status: 'disabled' });
    await expect(auth.issueToken((await store.findUserById(user.id))!)).rejects.toThrow();
  });
});

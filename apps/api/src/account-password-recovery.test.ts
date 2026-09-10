/** 匿名密码找回的隔离安全回归；只使用内存账户与合成邮件，不连接 SMTP。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { AccountService } from './account-service';
import { MemoryAuthStore } from './auth-store';
import { AuthService, hashPassword } from './auth-service';
import { TestAccountMailSender } from './fixtures/account-mail';
import { openApiDocument } from './openapi';

/** 服务测试用时钟显式推进冷却和过期；所有密码、邮箱与会话都是合成值。 */
function fixture() {
  let now = Date.now();
  const store = new MemoryAuthStore();
  const mail = new TestAccountMailSender();
  const auth = new AuthService({ store, jwtSecret: 'synthetic-recovery-secret', now: () => now });
  const service = new AccountService({
    store,
    auth,
    mail,
    secret: 'synthetic-recovery-secret',
    now: () => now,
  });
  return {
    store,
    mail,
    auth,
    service,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-recovery-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('ADMIN_SETUP_TOKEN', '');
  vi.stubEnv('API_AUTH_RATE_LIMIT_PER_MINUTE', '1000');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('匿名邮箱密码找回', () => {
  it('不存在、待验证、禁用及正常邮箱统一受理，只有正常账户发信且冷却期间不重复发送', async () => {
    const { store, mail, service, advance } = fixture();
    const passwordHash = await hashPassword('synthetic-old-password');
    for (const status of ['active', 'pending', 'disabled'] as const)
      await store.createUser({ email: `${status}@example.test`, passwordHash, status });
    for (const email of [
      'missing@example.test',
      'pending@example.test',
      'disabled@example.test',
      'ACTIVE@example.test',
    ])
      expect(await service.requestSelfServicePasswordReset(email)).toEqual({ accepted: true });
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]).toMatchObject({ to: 'active@example.test', purpose: 'reset' });
    expect((await store.listAudit())[0]).toMatchObject({
      action: 'account.password.reset.request',
      actorId: undefined,
    });
    const previous = await store.findChallenge('active@example.test', 'reset');
    expect(await service.requestSelfServicePasswordReset('active@example.test')).toEqual({
      accepted: true,
    });
    expect(mail.messages).toHaveLength(1);
    expect((await store.findChallenge('active@example.test', 'reset'))?.id).toBe(previous?.id);
    advance(60_001);
    expect(await service.requestSelfServicePasswordReset('active@example.test')).toEqual({
      accepted: true,
    });
    expect(mail.messages).toHaveLength(2);
    expect((await store.findChallenge('active@example.test', 'reset'))?.id).not.toBe(previous?.id);
  });

  it('验证前旧密码和会话不变，成功后旧密码与所有旧会话失效且验证码不能再次使用', async () => {
    const { auth, service, mail } = fixture();
    const previous = await auth.register({
      email: 'reset@example.test',
      password: 'synthetic-old-password',
    });
    const second = await auth.login({
      email: previous.user.email,
      password: 'synthetic-old-password',
    });
    await service.requestSelfServicePasswordReset(previous.user.email);
    expect((await auth.verifyAccessToken(previous.accessToken)).user.id).toBe(previous.user.id);
    await expect(
      auth.login({ email: previous.user.email, password: 'synthetic-old-password' }),
    ).resolves.toMatchObject({ user: { id: previous.user.id } });
    const input = {
      email: previous.user.email,
      purpose: 'reset' as const,
      code: mail.latest(previous.user.email, 'reset').code,
      password: 'synthetic-new-password',
    };
    const recovered = await service.verify(input);
    expect((await auth.verifyAccessToken(recovered.accessToken)).user.id).toBe(previous.user.id);
    await expect(auth.verifyAccessToken(previous.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
    await expect(auth.verifyAccessToken(second.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
    await expect(
      auth.login({ email: previous.user.email, password: 'synthetic-old-password' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      auth.login({ email: previous.user.email, password: 'synthetic-new-password' }),
    ).resolves.toMatchObject({ user: { id: previous.user.id } });
    await expect(service.verify(input)).rejects.toMatchObject({ code: 'verification_expired' });
  });

  it('五次错误后拒绝正确验证码，新申请的验证码十分钟后过期', async () => {
    const { auth, service, mail, advance } = fixture();
    const previous = await auth.register({
      email: 'limits@example.test',
      password: 'synthetic-old-password',
    });
    await service.requestSelfServicePasswordReset(previous.user.email);
    const code = mail.latest(previous.user.email, 'reset').code;
    const input = {
      email: previous.user.email,
      purpose: 'reset' as const,
      password: 'synthetic-new-password',
    };
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(
        service.verify({ ...input, code: code === '000000' ? '111111' : '000000' }),
      ).rejects.toMatchObject({ code: 'invalid_verification_code' });
    await expect(service.verify({ ...input, code })).rejects.toMatchObject({
      code: 'verification_expired',
    });
    advance(60_001);
    await service.requestSelfServicePasswordReset(previous.user.email);
    advance(10 * 60_000 + 1);
    await expect(
      service.verify({ ...input, code: mail.latest(previous.user.email, 'reset').code }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
    expect((await auth.verifyAccessToken(previous.accessToken)).user.id).toBe(previous.user.id);
  });

  it('邮件未配置、投递失败和存储故障明确失败，SMTP 内部错误不泄露', async () => {
    const { auth, service, mail, store } = fixture();
    mail.configured = false;
    await expect(
      service.requestSelfServicePasswordReset('missing@example.test'),
    ).rejects.toMatchObject({ code: 'email_not_configured', statusCode: 503 });
    mail.configured = true;
    await auth.register({ email: 'failure@example.test', password: 'synthetic-old-password' });
    mail.fail = true;
    await expect(
      service.requestSelfServicePasswordReset('failure@example.test'),
    ).rejects.toMatchObject({ code: 'email_delivery_failed', statusCode: 503 });
    const deliveries = await store.listDeliveries();
    expect(deliveries[0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(deliveries)).not.toContain('synthetic-secret-must-not-leak');
    vi.spyOn(store, 'findUserByEmail').mockRejectedValueOnce(
      new Error('synthetic-store-unavailable'),
    );
    await expect(service.requestSelfServicePasswordReset('failure@example.test')).rejects.toThrow(
      'synthetic-store-unavailable',
    );
  });

  it('匿名 HTTP 申请和邮箱验证闭环，凭据错误仍然返回 401', async () => {
    const { store, mail, auth } = fixture();
    const previous = await auth.register({
      email: 'http@example.test',
      password: 'synthetic-old-password',
    });
    const app = buildApp({ logger: false, authStore: store, accountMailSender: mail });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: previous.user.email, password: 'synthetic-wrong-password' },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'invalid email or password' });
      for (const email of ['missing@example.test', previous.user.email]) {
        const requested = await app.inject({
          method: 'POST',
          url: '/v1/auth/password/reset/request',
          payload: { email },
        });
        expect(requested.statusCode).toBe(202);
        expect(requested.json()).toEqual({ accepted: true });
      }
      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/reset/request',
        payload: { email: previous.user.email, password: 'unwanted-field' },
      });
      expect(invalid.statusCode).toBe(400);
      const reset = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: {
          email: previous.user.email,
          purpose: 'reset',
          code: mail.latest(previous.user.email, 'reset').code,
          password: 'synthetic-new-password',
        },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().user.id).toBe(previous.user.id);
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: previous.user.email, password: 'synthetic-new-password' },
      });
      expect(login.statusCode).toBe(200);
      const oldSession = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${previous.accessToken}` },
      });
      expect(oldSession.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('公开找回入口沿用共享认证限流，OpenAPI 声明匿名通用受理协议', async () => {
    vi.stubEnv('API_AUTH_RATE_LIMIT_PER_MINUTE', '1');
    const mail = new TestAccountMailSender();
    const app = buildApp({ logger: false, accountMailSender: mail });
    try {
      const request = {
        method: 'POST' as const,
        url: '/v1/auth/password/reset/request',
        payload: { email: 'missing@example.test' },
      };
      expect((await app.inject(request)).statusCode).toBe(202);
      const blocked = await app.inject(request);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe('auth_rate_limit_exceeded');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(mail.messages).toHaveLength(0);
      const operation = openApiDocument.paths['/v1/auth/password/reset/request'].post;
      expect(operation.security).toEqual([]);
      expect(operation.requestBody.content['application/json'].schema.required).toEqual(['email']);
      expect(operation.responses['202']).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

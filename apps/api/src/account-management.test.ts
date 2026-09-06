import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { AccountService } from './account-service';
import { MemoryAuthStore } from './auth-store';
import { AuthService, hashPassword } from './auth-service';
import { FileAuthStore } from './file-auth-store';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { TestAccountMailSender, registerVerifiedTestUser } from './fixtures/account-mail';

/** 各用例使用隔离账户和可注入时钟，不发送真实邮件。 */
function fixture() {
  let now = Date.now();
  const store = new MemoryAuthStore();
  const mail = new TestAccountMailSender();
  const auth = new AuthService({ store, jwtSecret: 'synthetic-test-secret', now: () => now });
  const service = new AccountService({
    store,
    auth,
    mail,
    secret: 'synthetic-test-secret',
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
  vi.stubEnv('API_JWT_SECRET', 'synthetic-test-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('ADMIN_SETUP_TOKEN', '');
  vi.stubEnv('API_AUTH_RATE_LIMIT_PER_MINUTE', '1000');
});
afterEach(() => vi.unstubAllEnvs());

describe('账户初始化、邮箱验证与敏感状态', () => {
  it('并发首次初始化只有一位管理员，完成标记不因管理员状态变化重开', async () => {
    const { service, mail, store } = fixture();
    await service.requestBootstrap({ email: 'first@example.test', password: 'correct-password' });
    await service.requestBootstrap({ email: 'second@example.test', password: 'correct-password' });
    const results = await Promise.allSettled(
      ['first', 'second'].map((name) =>
        service.verify({
          email: `${name}@example.test`,
          purpose: 'bootstrap',
          code: mail.latest(`${name}@example.test`, 'bootstrap').code,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const users = await store.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('admin');
    await store.updateUser(users[0].id, { status: 'disabled' });
    expect(await service.bootstrapStatus()).toMatchObject({ initialized: true });
    await expect(
      service.requestBootstrap({ email: 'third@example.test', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'already_initialized' });
  });

  it('已有管理员兼容完成标记且其历史邮箱不会被伪装成已验证', async () => {
    const { store, auth, service } = fixture();
    const user = await store.createUser({
      email: 'legacy@example.test',
      passwordHash: await hashPassword('correct-password'),
      role: 'admin',
    });
    expect((await service.bootstrapStatus()).initialized).toBe(true);
    const loggedIn = await auth.login({ email: user.email, password: 'correct-password' });
    expect(loggedIn.user.emailVerifiedAt).toBeUndefined();
    expect(loggedIn.user.status).toBe('active');
  });

  it('缺少邮件配置明确失败且不会创建免验证账户', async () => {
    const { service, mail, store } = fixture();
    mail.configured = false;
    await expect(
      service.register({ email: 'new@example.test', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'email_not_configured', statusCode: 503 });
    expect(await store.listUsers()).toHaveLength(0);
    expect(await store.findChallenge('new@example.test', 'register')).toBeUndefined();
  });

  it('新注册验证前不能登录，验证码摘要不含明码且只能消费一次', async () => {
    const { service, auth, mail, store } = fixture();
    await service.register({ email: 'NEW@example.test', password: 'correct-password' });
    await expect(
      auth.login({ email: 'new@example.test', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'email_verification_required' });
    const code = mail.latest('new@example.test', 'register').code;
    const challenge = await store.findChallenge('new@example.test', 'register');
    expect(challenge!.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge!.codeHash).not.toBe(code);
    const loggedIn = await service.verify({ email: 'new@example.test', code, purpose: 'register' });
    expect(loggedIn.user.emailVerifiedAt).toBeTruthy();
    await expect(
      service.verify({ email: 'new@example.test', code, purpose: 'register' }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
    await expect(
      service.verify({ email: 'new@example.test', code, purpose: 'bootstrap' }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
  });

  it('验证尝试次数和重发频率持久化，重发后旧码失效，过期不消费', async () => {
    const { service, mail, store, advance } = fixture();
    await service.register({ email: 'limits@example.test', password: 'correct-password' });
    const oldCode = mail.latest('limits@example.test', 'register').code;
    const wrong = oldCode === '000000' ? '111111' : '000000';
    for (let index = 0; index < 5; index += 1)
      await expect(
        service.verify({ email: 'limits@example.test', purpose: 'register', code: wrong }),
      ).rejects.toMatchObject({ code: 'invalid_verification_code' });
    expect((await store.findChallenge('limits@example.test', 'register'))!.attempts).toBe(5);
    await expect(
      service.verify({ email: 'limits@example.test', purpose: 'register', code: oldCode }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
    await expect(service.resend('limits@example.test', 'register')).rejects.toMatchObject({
      code: 'verification_rate_limited',
    });
    advance(60_001);
    await service.resend('limits@example.test', 'register');
    const currentCode = mail.latest('limits@example.test', 'register').code;
    if (currentCode !== oldCode)
      await expect(
        service.verify({ email: 'limits@example.test', purpose: 'register', code: oldCode }),
      ).rejects.toMatchObject({ code: 'invalid_verification_code' });
    advance(10 * 60_000 + 1);
    await expect(
      service.verify({ email: 'limits@example.test', purpose: 'register', code: currentCode }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
  });

  it('SMTP 失败保留待激活用户和可重发记录但不暴露邮件密钥', async () => {
    const { service, store, mail, advance } = fixture();
    mail.fail = true;
    const invitation = await service.invite('11111111-1111-4111-8111-111111111111', {
      email: 'invite@example.test',
      displayName: '邀请用户',
    });
    expect(invitation.delivery.status).toBe('failed');
    expect(invitation.user.status).toBe('pending');
    expect(JSON.stringify(await store.listDeliveries())).not.toContain(
      'synthetic-secret-must-not-leak',
    );
    mail.fail = false;
    advance(60_001);
    await service.resend('invite@example.test', 'invite');
    const activated = await service.verify({
      email: 'invite@example.test',
      purpose: 'invite',
      code: mail.latest('invite@example.test', 'invite').code,
      password: 'chosen-password',
    });
    expect(activated.user.status).toBe('active');
    expect(await store.listUsers()).toHaveLength(1);
  });

  it('禁用使令牌失效，不能禁用最后一位管理员或把待验证账户恢复为已激活', async () => {
    const { service, auth, store } = fixture();
    const admin = await store.createUser({
      email: 'admin@example.test',
      passwordHash: await hashPassword('correct-password'),
      role: 'admin',
    });
    await expect(
      service.updateUser(admin.id, admin.id, { status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'last_admin' });
    const pending = await service.invite(admin.id, { email: 'pending@example.test' });
    await service.updateUser(admin.id, pending.user.id, { status: 'disabled' });
    expect((await service.updateUser(admin.id, pending.user.id, { status: 'active' })).status).toBe(
      'pending',
    );
    const active = await auth.register({
      email: 'active@example.test',
      password: 'correct-password',
    });
    await service.updateUser(admin.id, active.user.id, { status: 'disabled' });
    await expect(auth.verifyAccessToken(active.accessToken)).rejects.toBeTruthy();
    await expect(
      auth.login({ email: 'active@example.test', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'account_disabled' });
  });

  it('更换邮箱要求当前身份和新邮箱验证码，完成前旧邮箱有效且完成后撤销旧会话', async () => {
    const { service, auth, mail, store } = fixture();
    const current = await auth.register({
      email: 'before@example.test',
      password: 'correct-password',
    });
    await service.requestEmailChange(
      current.user.id,
      current.user.id,
      'after@example.test',
      'correct-password',
    );
    expect((await store.findUserById(current.user.id))!.email).toBe('before@example.test');
    const verify = {
      email: 'after@example.test',
      purpose: 'email' as const,
      code: mail.latest('after@example.test', 'email').code,
    };
    await expect(service.verify(verify)).rejects.toMatchObject({ code: 'authentication_required' });
    const changed = await service.verify(verify, current.user.id);
    expect(changed.user.email).toBe('after@example.test');
    await expect(auth.verifyAccessToken(current.accessToken)).rejects.toBeTruthy();
    expect((await auth.verifyAccessToken(changed.accessToken)).user.id).toBe(current.user.id);
  });

  it('改密校验当前密码，成功撤销旧会话并签发新会话', async () => {
    const { service, auth } = fixture();
    const current = await auth.register({
      email: 'password@example.test',
      password: 'old-password',
    });
    await expect(
      service.changePassword(current.user.id, 'wrong-password', 'new-password'),
    ).rejects.toMatchObject({ code: 'invalid_current_password' });
    const changed = await service.changePassword(current.user.id, 'old-password', 'new-password');
    await expect(auth.verifyAccessToken(current.accessToken)).rejects.toBeTruthy();
    expect((await auth.verifyAccessToken(changed.accessToken)).user.id).toBe(current.user.id);
    await expect(
      auth.login({ email: 'password@example.test', password: 'old-password' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('有效会话可续期且七天绝对期限不因刷新延长', async () => {
    const { auth, store, advance } = fixture();
    const initial = await auth.register({
      email: 'refresh@example.test',
      password: 'correct-password',
    });
    const first = await auth.verifyAccessToken(initial.accessToken);
    advance(14 * 60_000);
    const refreshed = await auth.refresh(initial.accessToken);
    const second = await auth.verifyAccessToken(refreshed.accessToken);
    expect(second.session.absoluteExpiresAt).toEqual(first.session.absoluteExpiresAt);
    expect(second.session.expiresAt.getTime()).toBeGreaterThan(first.session.expiresAt.getTime());
    expect(await store.listSessions(initial.user.id)).toHaveLength(2);
    advance(7 * 24 * 60 * 60_000);
    await expect(auth.refresh(refreshed.accessToken)).rejects.toBeTruthy();
  });

  it('修改密码后撤销尚未消费的重置验证码，旧邮件不能覆盖新密码', async () => {
    const { service, auth, mail } = fixture();
    const current = await auth.register({ email: 'reset@example.test', password: 'old-password' });
    await service.requestPasswordReset('11111111-1111-4111-8111-111111111111', current.user.id);
    const code = mail.latest('reset@example.test', 'reset').code;
    await service.changePassword(current.user.id, 'old-password', 'new-password');
    await expect(
      service.verify({
        email: 'reset@example.test',
        purpose: 'reset',
        code,
        password: 'unwanted-password',
      }),
    ).rejects.toMatchObject({ code: 'verification_expired' });
    expect(
      (await auth.login({ email: 'reset@example.test', password: 'new-password' })).user.id,
    ).toBe(current.user.id);
  });
});

describe('后台 HTTP 权限与分用户资源', () => {
  it('公网首次初始化缺部署凭据拒绝，配置后拒绝错误凭据', async () => {
    const mail = new TestAccountMailSender();
    let app = buildApp({ logger: false, accountMailSender: mail });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/admin/bootstrap/request',
        remoteAddress: '203.0.113.8',
        payload: { email: 'remote@example.test', password: 'correct-password' },
      });
      expect(denied.statusCode).toBe(503);
      expect(denied.json().code).toBe('setup_token_required');
    } finally {
      await app.close();
    }
    vi.stubEnv('ADMIN_SETUP_TOKEN', 'synthetic-setup-token');
    app = buildApp({ logger: false, accountMailSender: mail });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/admin/bootstrap/request',
        payload: {
          email: 'remote@example.test',
          password: 'correct-password',
          setupToken: 'wrong',
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(mail.messages).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('初始化、邀请、资料、安全、用户状态与审计经真实 HTTP 路由闭环', async () => {
    const mail = new TestAccountMailSender();
    const app = buildApp({ logger: false, accountMailSender: mail });
    try {
      expect((await app.inject('/v1/admin/bootstrap')).json().initialized).toBe(false);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/bootstrap/request',
            payload: {
              email: 'admin@example.test',
              password: 'correct-password',
              displayName: '管理员',
            },
          })
        ).statusCode,
      ).toBe(202);
      const verified = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: {
          email: 'admin@example.test',
          purpose: 'bootstrap',
          code: mail.latest('admin@example.test', 'bootstrap').code,
        },
      });
      expect(verified.statusCode).toBe(200);
      const headers = { authorization: `Bearer ${verified.json().accessToken}` };
      expect((await app.inject('/v1/admin/bootstrap')).json().initialized).toBe(true);
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers,
        payload: { email: 'evil@example.test', role: 'admin' },
      });
      expect(rejected.statusCode).toBe(400);
      const invited = await app.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers,
        payload: { email: 'invited@example.test', displayName: '用户' },
      });
      expect(invited.statusCode).toBe(202);
      const activated = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: {
          email: 'invited@example.test',
          purpose: 'invite',
          code: mail.latest('invited@example.test', 'invite').code,
          password: 'chosen-password',
        },
      });
      expect(activated.statusCode).toBe(200);
      const userHeaders = { authorization: `Bearer ${activated.json().accessToken}` };
      for (const url of [
        '/v1/admin/users',
        '/v1/admin/overview',
        '/v1/admin/audit',
        '/v1/admin/system',
        '/v1/admin/resource-groups',
      ])
        expect((await app.inject({ method: 'GET', url, headers: userHeaders })).statusCode).toBe(
          403,
        );
      const saved = await app.inject({
        method: 'PATCH',
        url: '/v1/account/profile',
        headers: userHeaders,
        payload: { displayName: '新名称', bio: '用户简介' },
      });
      expect(saved.json().user.displayName).toBe('新名称');
      expect(saved.body).not.toContain('passwordHash');
      const password = await app.inject({
        method: 'POST',
        url: '/v1/account/password',
        headers: userHeaders,
        payload: { currentPassword: 'chosen-password', newPassword: 'replacement-password' },
      });
      expect(password.statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/account/profile', headers: userHeaders }))
          .statusCode,
      ).toBe(401);
      const disabled = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/users/${activated.json().user.id}`,
        headers,
        payload: { status: 'disabled' },
      });
      expect(disabled.json().user.status).toBe('disabled');
      const events = (await app.inject({ method: 'GET', url: '/v1/admin/audit', headers })).json()
        .events;
      expect(
        events.some((event: { action: string }) => event.action === 'account.password.update'),
      ).toBe(true);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/admin/system', headers })).json().mail
          .deliveries,
      ).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('资源列表、分组、详情、版本、下载和编辑全部按服务器所有者边界校验', async () => {
    const store = new MemoryAuthStore();
    const mail = new TestAccountMailSender();
    const assets = new MemoryAssetStore();
    const projects = new MemoryProjectStore();
    await store.createUser({
      email: 'admin@example.test',
      role: 'admin',
      passwordHash: await hashPassword('correct-password'),
    });
    const app = buildApp({
      logger: false,
      authStore: store,
      accountMailSender: mail,
      assetStore: assets,
      projectStore: projects,
    });
    try {
      const admin = (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'admin@example.test', password: 'correct-password' },
        })
      ).json();
      const a = (
        await registerVerifiedTestUser(app, mail, {
          email: 'a@example.test',
          password: 'correct-password',
        })
      ).json();
      const b = (
        await registerVerifiedTestUser(app, mail, {
          email: 'b@example.test',
          password: 'correct-password',
        })
      ).json();
      const adminHeaders = { authorization: `Bearer ${admin.accessToken}` };
      const aHeaders = { authorization: `Bearer ${a.accessToken}` };
      const projectA = await projects.create({ name: 'A项目' }, { ownerId: a.user.id });
      const projectB = await projects.create({ name: 'B项目' }, { ownerId: b.user.id });
      const uploadA = await assets.create({
        ownerId: a.user.id,
        name: 'A上传',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('AAAA'),
      });
      const generatedA = await assets.create({
        ownerId: a.user.id,
        projectId: projectA.id,
        name: 'A生成',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('generated'),
        metadata: { runId: 'run-test' },
      });
      await assets.create({
        projectId: projectA.id,
        name: 'A历史项目资源',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('legacy'),
      });
      const uploadB = await assets.create({
        ownerId: b.user.id,
        name: 'B上传',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('BBBB'),
      });
      const unassigned = await assets.create({
        name: '待归属',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('legacy-private'),
      });
      const conflict = await assets.create({
        ownerId: a.user.id,
        projectId: projectB.id,
        name: '归属冲突',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('conflict-private'),
      });
      const own = await app.inject({
        method: 'GET',
        url: '/v1/account/resources',
        headers: aHeaders,
      });
      expect(own.json().total).toBe(3);
      expect(own.body).not.toContain(uploadB.id);
      expect(own.body).not.toContain(unassigned.id);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/account/resources?ownerId=${b.user.id}`,
            headers: aHeaders,
          })
        ).statusCode,
      ).toBe(400);
      for (const id of [uploadB.id, unassigned.id, conflict.id]) {
        for (const suffix of ['', '/content', '/content?version=1'])
          expect(
            (
              await app.inject({
                method: 'GET',
                url: `/v1/account/resources/${id}${suffix}`,
                headers: aHeaders,
              })
            ).statusCode,
          ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/v1/account/resources/${id}`,
              headers: aHeaders,
              payload: { name: '越权' },
            })
          ).statusCode,
        ).toBe(404);
      }
      expect(
        (await app.inject({ method: 'GET', url: '/v1/admin/resources', headers: adminHeaders }))
          .statusCode,
      ).toBe(400);
      const groups = (
        await app.inject({ method: 'GET', url: '/v1/admin/resource-groups', headers: adminHeaders })
      ).json().groups;
      expect(
        groups.find((group: { ownerId: string }) => group.ownerId === a.user.id).resourceCount,
      ).toBe(3);
      expect(groups.find((group: { ownerId: null }) => group.ownerId === null).resourceCount).toBe(
        2,
      );
      for (const headers of [aHeaders, { authorization: `Bearer ${b.accessToken}` }]) {
        for (const suffix of [
          '/content',
          '/versions',
          '/versions/1/content',
          '/derivatives/thumbnail',
        ])
          expect(
            (
              await app.inject({
                method: 'GET',
                url: `/v1/assets/${conflict.id}${suffix}`,
                headers,
              })
            ).statusCode,
          ).toBe(404);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/v1/assets/${conflict.id}/access-url`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
      }
      const oldList = await app.inject({ method: 'GET', url: '/v1/assets', headers: aHeaders });
      expect(oldList.body).not.toContain(conflict.id);
      const oldProjectList = await app.inject({
        method: 'GET',
        url: `/v1/assets?projectId=${projectB.id}`,
        headers: { authorization: `Bearer ${b.accessToken}` },
      });
      expect(oldProjectList.body).not.toContain(conflict.id);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/admin/resources?ownerId=${a.user.id}&source=generated`,
            headers: adminHeaders,
          })
        )
          .json()
          .assets.map((asset: { id: string }) => asset.id),
      ).toEqual([generatedA.id]);
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/account/resources/${uploadA.id}`,
        headers: aHeaders,
      });
      expect(detail.body).not.toContain('contentKey');
      expect(detail.json().versions).toHaveLength(1);
      const partial = await app.inject({
        method: 'GET',
        url: `/v1/account/resources/${uploadA.id}/content`,
        headers: { ...aHeaders, range: 'bytes=1-2' },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.body).toBe('AA');
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/resources/${uploadB.id}`,
        headers: adminHeaders,
        payload: { name: 'B重命名', tags: ['审核'], status: 'archived' },
      });
      expect(renamed.json().asset).toMatchObject({
        name: 'B重命名',
        status: 'archived',
        ownerId: b.user.id,
      });
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/v1/admin/resources/${uploadB.id}`,
            headers: adminHeaders,
            payload: { status: 'ready' },
          })
        ).json().asset.status,
      ).toBe('ready');
      const access = await app.inject({
        method: 'POST',
        url: `/v1/assets/${uploadA.id}/access-url`,
        headers: aHeaders,
        payload: {},
      });
      expect(access.statusCode).toBe(200);
      const signedUrl = access.json().url as string;
      expect((await app.inject({ method: 'GET', url: signedUrl })).statusCode).toBe(200);
      await app.inject({
        method: 'PATCH',
        url: `/v1/admin/users/${a.user.id}`,
        headers: adminHeaders,
        payload: { status: 'disabled' },
      });
      expect((await app.inject({ method: 'GET', url: signedUrl })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/account/resources', headers: aHeaders }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('会话列表不泄露令牌摘要，退出其他会话及指定会话都核对本人身份', async () => {
    const mail = new TestAccountMailSender();
    const app = buildApp({ logger: false, accountMailSender: mail });
    try {
      const first = (
        await registerVerifiedTestUser(app, mail, {
          email: 'sessions@example.test',
          password: 'correct-password',
        })
      ).json();
      const second = (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'sessions@example.test', password: 'correct-password' },
        })
      ).json();
      const headers = { authorization: `Bearer ${first.accessToken}` };
      const listed = await app.inject({ method: 'GET', url: '/v1/account/sessions', headers });
      expect(listed.body).not.toContain('tokenHash');
      expect(listed.json().sessions).toHaveLength(2);
      expect(
        listed.json().sessions.filter((entry: { current: boolean }) => entry.current),
      ).toHaveLength(1);
      expect(
        (
          await app.inject({ method: 'POST', url: '/v1/account/sessions/revoke-others', headers })
        ).json().revokedSessions,
      ).toBe(1);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/account/profile',
            headers: { authorization: `Bearer ${second.accessToken}` },
          })
        ).statusCode,
      ).toBe(401);
      const other = (
        await registerVerifiedTestUser(app, mail, {
          email: 'other@example.test',
          password: 'correct-password',
        })
      ).json();
      const currentId = listed.json().sessions.find((entry: { current: boolean }) => entry.current)
        .id as string;
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/account/sessions/${currentId}`,
            headers: { authorization: `Bearer ${other.accessToken}` },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({ method: 'DELETE', url: `/v1/account/sessions/${currentId}`, headers })
        ).json().revoked,
      ).toBe(true);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/account/profile', headers })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('本地文件账户在重建存储后保留初始化、邮件状态和会话', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-account-test-'));
    const path = join(directory, 'store.bin');
    try {
      const store = new FileAuthStore(path);
      await store.initialize();
      const mail = new TestAccountMailSender();
      const auth = new AuthService({ store, jwtSecret: 'synthetic-test-secret' });
      const service = new AccountService({ store, auth, mail, secret: 'synthetic-test-secret' });
      await service.requestBootstrap({
        email: 'restart@example.test',
        password: 'correct-password',
      });
      const activated = await service.verify({
        email: 'restart@example.test',
        purpose: 'bootstrap',
        code: mail.latest('restart@example.test', 'bootstrap').code,
      });
      await store.close();
      const reopened = new FileAuthStore(path);
      await reopened.initialize();
      expect(await reopened.bootstrapInitialized()).toBe(true);
      expect((await reopened.listDeliveries())[0].status).toBe('accepted');
      expect(
        (
          await new AuthService({
            store: reopened,
            jwtSecret: 'synthetic-test-secret',
          }).verifyAccessToken(activated.accessToken)
        ).user.id,
      ).toBe(activated.user.id);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

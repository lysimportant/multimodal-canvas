import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import { precheckVideoGenerationInputs } from '@multimodal-canvas/domain';
import { AuthService } from './auth-service';
import { PrismaAuthStore } from './auth-store';
import { NewApiAccountClient } from './newapi-account-client';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';
import { buildApp } from './fixtures/test-app';
import { PrismaProjectStore } from './projects';
import { createRunSnapshot } from './runs';

/** 必须显式给出隔离数据库；普通单测不连接本机实际业务实例。 */
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  const database = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(database.hostname) ||
    !/(?:_test|_ci)$/.test(database.pathname)
  )
    throw new Error('账号接入验收仅接受已确认隔离的本机 _test/_ci 数据库');
}
describe.skipIf(!databaseUrl)('New API 本人身份与分组隔离', () => {
  const schemaName = `newapi_account_${randomUUID().replaceAll('-', '')}`;
  const scopedDatabaseUrl = new URL(databaseUrl ?? 'postgresql://unused@127.0.0.1/unused_test');
  scopedDatabaseUrl.searchParams.set('schema', schemaName);
  const prisma = new PrismaClient({
    datasources: { db: { url: scopedDatabaseUrl.toString() } },
  });
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const prismaCli = fileURLToPath(
    new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
  );
  const prismaSchema = fileURLToPath(new URL('../../../prisma/schema.prisma', import.meta.url));
  const execFileAsync = promisify(execFile);
  const keyring = new CredentialEncryptionKeyring({ currentSecret: 'synthetic-account-keyring' });
  const auth = new AuthService({
    store: new PrismaAuthStore(prisma),
    jwtSecret: 'synthetic-account-jwt',
  });
  let selectedUser = 'account-a';
  let groups = ['default', 'auto', '神秘分组', '神秘分组2'];
  let changedGroup = false;
  let unavailable = false;
  let failGroup = '';
  let lostGroupResponse = '';
  let accountDenied = false;
  let profile: { display_name: string; email?: string } = { display_name: 'same-name' };
  const operations = new Map<string, { token: string; key: string }>();
  const calls: string[] = [];
  let issuer: string;
  let service: NewApiAccountService;

  beforeAll(async () => {
    await execFileAsync(
      process.execPath,
      [prismaCli, 'db', 'push', '--schema', prismaSchema, '--skip-generate'],
      {
        cwd: workspaceRoot,
        env: { ...process.env, DATABASE_URL: scopedDatabaseUrl.toString() },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await prisma.$connect();
  }, 60_000);
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await prisma.$disconnect();
  }, 30_000);
  beforeEach(() => {
    selectedUser = 'account-a';
    groups = ['default', 'auto', '神秘分组', '神秘分组2'];
    changedGroup = false;
    unavailable = false;
    failGroup = '';
    lostGroupResponse = '';
    accountDenied = false;
    profile = { display_name: 'same-name' };
    operations.clear();
    calls.length = 0;
    issuer = `https://newapi-${crypto.randomUUID()}.example.test`;
    service = new NewApiAccountService({
      prisma,
      keyring,
      auth,
      webUrl: 'http://localhost:5173',
      client: new NewApiAccountClient({
        issuer,
        clientId: 'canvas',
        instanceId: 'isolated',
        redirectUri: 'http://localhost:3000/v1/auth/newapi/callback',
        fetchImpl: vi.fn(async (input, init) => {
          const url = new URL(String(input));
          calls.push(`${init?.method} ${decodeURIComponent(url.pathname)}`);
          if (unavailable) return new Response('{}', { status: 503 });
          const body = init?.body ? JSON.parse(String(init.body)) : {};
          const headers = new Headers(init?.headers);
          const account = headers.get('authorization')?.includes('account-b')
            ? 'account-b'
            : 'account-a';
          const user = { id: selectedUser, ...profile, status: 'active' };
          if (url.pathname === '/api/canvas/token')
            return Response.json({
              issuer,
              user,
              grant: {
                id: `grant-${selectedUser}`,
                token: `synthetic-grant-${selectedUser}`,
                expires_at: new Date(Date.now() + 3600000).toISOString(),
                scopes: ['identity:read', 'groups:read', 'tokens:manage'],
              },
            });
          if (url.pathname === '/api/canvas/account' && accountDenied)
            return new Response('{}', { status: 401 });
          if (url.pathname === '/api/canvas/account')
            return Response.json({
              user: { ...user, id: account },
              grant_id: `grant-${account}`,
              groups,
            });
          if (url.pathname.startsWith('/api/canvas/groups/')) {
            const group = decodeURIComponent(url.pathname.split('/').at(-1)!);
            if (group === failGroup) return new Response('{}', { status: 503 });
            const operation = operations.get(body.operation_id) ?? {
              token: crypto.randomUUID(),
              key: `synthetic-${account}-${Buffer.from(group).toString('hex')}`,
            };
            operations.set(body.operation_id, operation);
            if (group === lostGroupResponse) {
              lostGroupResponse = '';
              return new Response('{}', { status: 503 });
            }
            return Response.json({
              token_id: operation.token,
              key: operation.key,
              group: changedGroup ? 'different-group' : group,
              status: 'active',
              credential_revision: 1,
              permission_revision: 1,
              auto_groups: group === 'auto' ? ['default'] : [],
            });
          }
          if (url.pathname === '/v1/canvas/catalog')
            return Response.json({
              models: [
                {
                  id: 'exact-model',
                  media_type: 'text',
                  contract: 'openai-chat-completions',
                  available: true,
                },
              ],
            });
          if (url.pathname === '/api/canvas/revoke') return Response.json({ revoked: true });
          throw new Error('unexpected test path');
        }),
      }),
    });
  });

  /** 完整一次性事务回调，仅使用合成身份和合成 Key。 */
  async function login() {
    const started = await service.start();
    const state = new URL(started.url).searchParams.get('state')!;
    return service.callback(state, 'synthetic-code', started.browser);
  }

  it('访问令牌过期后仅续期入口可使用原 Cookie，轮换撤销旧会话且失败不续期', async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const result = await login();
    const app = buildApp({
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: new PrismaProjectStore(prisma),
    });
    const original = `canvas_session=${result.accessToken}`;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
    try {
      expect(
        (await app.inject({ url: '/v1/auth/me', headers: { cookie: original } })).statusCode,
      ).toBe(401);
      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: original },
      });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json()).not.toHaveProperty('accessToken');
      const renewed = String(refreshed.headers['set-cookie']).split(';')[0]!;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/refresh',
            headers: { cookie: original },
          })
        ).statusCode,
      ).toBe(401);
      unavailable = true;
      const failed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: renewed },
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.headers['set-cookie']).toBeUndefined();
      clock.mockReturnValue(Date.now() + 8 * 86400000);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/refresh',
            headers: { cookie: renewed },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      clock.mockRestore();
      vi.unstubAllEnvs();
      await app.close();
    }
  });

  it('无邮箱可登录；首次全部纳入组建 Key；排除精确名称且重复刷新不增加关系', async () => {
    const result = await login();
    expect(result.user.email).toBeUndefined();
    const before = await service.status(result.user.id);
    expect(before.groups.map((group) => group.group).sort()).toEqual([
      'auto',
      'default',
      '神秘分组2',
    ]);
    expect(operations.size).toBe(3);
    await Promise.all([service.synchronize(result.user.id), service.synchronize(result.user.id)]);
    expect(operations.size).toBe(3);
    expect(
      (await service.status(result.user.id)).groups.map((group) => group.credentialId),
    ).toEqual(before.groups.map((group) => group.credentialId));
    expect(calls.filter((call) => call.endsWith('/groups/神秘分组'))).toEqual([]);
    expect(await service.models(result.user.id)).toHaveLength(3);
    groups.push('added');
    await service.synchronize(result.user.id);
    expect(operations.size).toBe(4);
    const walletTables = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('wallets', 'wallet_entries')
    `;
    expect(Number(walletTables[0]?.count)).toBe(0);
  });

  it('两个同名账号不会合并；目录与设置不允许跨用户引用', async () => {
    const a = await login();
    selectedUser = 'account-b';
    const b = await login();
    expect(a.user.id).not.toBe(b.user.id);
    const aModels = await service.models(a.user.id);
    const bModels = await service.models(b.user.id);
    expect(aModels[0]!.credentialId).not.toBe(bModels[0]!.credentialId);
    await expect(
      service.models(b.user.id, undefined, aModels[0]!.credentialId),
    ).rejects.toMatchObject({ code: 'credential_not_found' });
    const settings = new NewApiAccountSettings(service);
    await newApiRequestUser.run(b.user.id, async () => {
      expect(await settings.hasCredential(aModels[0]!.credentialId!)).toBe(false);
    });
    await expect(settings.get()).rejects.toMatchObject({ code: 'authentication_required' });
  });

  it('上游修改邮箱昵称不改变资源归属，同邮箱的新 ID 仍是独立用户', async () => {
    const first = await login();
    const projects = new PrismaProjectStore(prisma);
    const project = await projects.create(
      { name: 'Identity profile ownership' },
      { ownerId: first.user.id },
    );
    const credentials = (await service.status(first.user.id)).groups.map(
      (entry) => entry.credentialId,
    );
    profile = { display_name: 'renamed-user', email: 'same-mail@example.test' };
    const renamed = await login();
    expect(renamed.user).toMatchObject({
      id: first.user.id,
      email: profile.email,
      displayName: profile.display_name,
    });
    expect(
      (await service.status(renamed.user.id)).groups.map((entry) => entry.credentialId),
    ).toEqual(credentials);
    expect(await projects.get(project.id, { ownerId: renamed.user.id })).toBeDefined();
    selectedUser = 'account-b';
    const recreated = await login();
    expect(recreated.user.id).not.toBe(first.user.id);
    expect(recreated.user.email).toBe(renamed.user.email);
    expect(await projects.get(project.id, { ownerId: recreated.user.id })).toBeUndefined();
  });

  it('持久化回读保留显式视频模式和完成动作，缺尾帧仍在发送前拒绝', async () => {
    const session = await login();
    const store = new PrismaProjectStore(prisma);
    const owner = { ownerId: session.user.id };
    const project = await store.create({ name: 'Video mode persistence' }, owner);
    const videoData = {
      label: 'First and last frame',
      mediaType: 'video' as const,
      mode: 'generate' as const,
      videoMode: 'first_last_frame' as const,
      modelAlias: 'wan3.0-video',
      completionAction: 'fill_designated_image_node' as const,
      completionTargetNodeId: 'image-target',
      generationCount: 2,
      promptSkillId: 'cinematic',
      resourceRefs: [
        {
          id: 'reference-1',
          assetId: 'frozen-image',
          assetVersion: 1,
          mediaType: 'image' as const,
          name: 'First frame',
        },
      ],
    };
    await store.updateCanvas(
      project.id,
      {
        revision: 0,
        nodes: [
          {
            id: 'first',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              label: 'First',
              mediaType: 'image',
              mode: 'source',
              contentUrl: 'https://assets.example.test/first.png',
            },
          },
          { id: 'video', type: 'video', position: { x: 200, y: 0 }, data: videoData },
        ],
        edges: [
          {
            id: 'first-edge',
            sourceNodeId: 'first',
            sourceHandle: 'output:image',
            targetNodeId: 'video',
            targetHandle: 'input:firstFrame',
            order: 0,
          },
        ],
      },
      owner,
    );
    const canvas = await store.getCanvas(project.id, owner);
    expect(canvas?.nodes.find((node) => node.id === 'video')?.data).toEqual(videoData);
    const snapshot = createRunSnapshot(project.id, canvas!, 'video', {
      modelAlias: videoData.modelAlias,
    });
    const target = snapshot.nodes.find((node) => node.id === 'video')!;
    const precheck = precheckVideoGenerationInputs(snapshot.inputs, {
      modelAlias: target.data.modelAlias,
      videoMode: target.data.videoMode,
    });
    expect(precheck.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '首尾帧模式需要同时连接首帧和尾帧' }),
      ]),
    );
  });

  it('上游已建 Key 但回包丢失时刷新复用原操作，不增加成功组令牌', async () => {
    lostGroupResponse = 'default';
    const result = await login();
    const identity = await service.identity(result.user.id);
    const binding = await prisma.newApiGroupBinding.findUniqueOrThrow({
      where: { identityId_group: { identityId: identity.id, group: 'default' } },
    });
    const token = operations.get(binding.operationId)!.token;
    expect(binding.status).toBe('unavailable');
    expect(binding.credentialId).toBeNull();
    expect(operations.size).toBe(3);
    await service.synchronize(result.user.id);
    const restored = await prisma.newApiGroupBinding.findUniqueOrThrow({
      where: { id: binding.id },
    });
    expect(restored).toMatchObject({
      operationId: binding.operationId,
      upstreamTokenId: token,
      status: 'active',
    });
    expect(operations.size).toBe(3);
  });

  it('上游明确拒绝账号后撤销本地所有会话，不把拒绝当只读网络故障', async () => {
    const result = await login();
    expect((await auth.verifyAccessToken(result.accessToken)).user.id).toBe(result.user.id);
    accountDenied = true;
    await expect(service.synchronize(result.user.id)).rejects.toMatchObject({
      code: 'authorization_revoked',
    });
    await expect(service.identity(result.user.id)).rejects.toMatchObject({
      code: 'authorization_revoked',
    });
    expect(
      await prisma.authSession.count({ where: { userId: result.user.id, revokedAt: null } }),
    ).toBe(0);
    await expect(auth.verifyAccessToken(result.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
  });

  it('并发首次登录只有一个内部用户，state 不可重放或跨浏览器消费', async () => {
    const results = await Promise.all([login(), login()]);
    expect(results[0]!.user.id).toBe(results[1]!.user.id);
    const started = await service.start();
    const state = new URL(started.url).searchParams.get('state')!;
    await expect(service.callback(state, 'code', 'wrong-browser')).rejects.toMatchObject({
      code: 'invalid_login',
    });
    await service.callback(state, 'code', started.browser);
    await expect(service.callback(state, 'code', started.browser)).rejects.toMatchObject({
      code: 'invalid_login',
    });
    const expired = await service.start();
    const expiredState = new URL(expired.url).searchParams.get('state')!;
    await prisma.newApiLoginTransaction.update({
      where: { stateHash: createHash('sha256').update(expiredState).digest('hex') },
      data: { expiresAt: new Date(0) },
    });
    await expect(service.callback(expiredState, 'code', expired.browser)).rejects.toMatchObject({
      code: 'invalid_login',
    });
  });

  it('部分分组失败保留成功组，改组拒绝，恢复只使用原操作身份', async () => {
    failGroup = 'auto';
    const result = await login();
    expect(
      (await service.status(result.user.id)).groups.find((group) => group.group === 'auto')?.status,
    ).toBe('unavailable');
    failGroup = '';
    await service.synchronize(result.user.id);
    expect(operations.size).toBe(3);
    const credentialId = (await service.models(result.user.id))[0]!.credentialId!;
    changedGroup = true;
    await expect(service.validateGroup(result.user.id, credentialId)).rejects.toMatchObject({
      code: 'group_changed',
    });
  });

  it('Cookie 会话隔离项目、拒绝旧入口和跨站写入，退出后立即失效', async () => {
    const result = await login();
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const app = buildApp({
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: new PrismaProjectStore(prisma),
    });
    try {
      const cookie = `canvas_session=${result.accessToken}`;
      expect(
        (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {} })).statusCode,
      ).toBe(410);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/projects',
            headers: { cookie, origin: 'https://other.example.test' },
            payload: { name: 'rejected' },
          })
        ).statusCode,
      ).toBe(403);
      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie, origin: 'http://localhost:5173' },
        payload: { name: 'isolated-project' },
      });
      expect(project.statusCode, project.body).toBe(201);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/models', headers: { cookie } })).json().models,
      ).toHaveLength(3);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it('远端撤销失败先关闭本地会话，重建服务后继续同一撤销且清除完成的密文', async () => {
    const result = await login();
    unavailable = true;
    await service.revoke(result.user.id);
    await expect(auth.verifyAccessToken(result.accessToken)).rejects.toThrow();
    await expect(service.identity(result.user.id)).rejects.toMatchObject({
      code: 'authorization_revoked',
    });
    const pending = await prisma.newApiGrantRevocation.findFirstOrThrow({ where: { issuer } });
    expect(pending.completedAt).toBeNull();
    expect(pending.error).toContain('未确认');
    unavailable = false;
    await new NewApiAccountService(service.options).retryRevocations();
    const completed = await prisma.newApiGrantRevocation.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(completed.completedAt).not.toBeNull();
    expect(completed.encryptedGrant).toBe('');
    const count = calls.filter((call) => call.endsWith('/api/canvas/revoke')).length;
    await service.retryRevocations();
    expect(calls.filter((call) => call.endsWith('/api/canvas/revoke'))).toHaveLength(count);
  });

  it('资源归属只读接口允许管理员，无邮箱身份可显示，普通用户不能越权', async () => {
    service.options.adminExternalIds = ['account-a'];
    const administrator = await login();
    selectedUser = 'account-b';
    const member = await login();
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const app = buildApp({
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: new PrismaProjectStore(prisma),
    });
    try {
      const url = `/v1/admin/resource-owners/${member.user.id}`;
      expect(
        (await app.inject({ url, headers: { cookie: `canvas_session=${member.accessToken}` } }))
          .statusCode,
      ).toBe(403);
      const response = await app.inject({
        url,
        headers: { cookie: `canvas_session=${administrator.accessToken}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        user: { id: member.user.id },
        projects: [],
        stats: { resourceCount: 0 },
      });
      expect(response.json()).not.toHaveProperty('password');
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});

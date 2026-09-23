import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import { precheckVideoGenerationInputs, type RunSnapshot } from '@multimodal-canvas/domain';
import { PrismaExecutionService } from '@multimodal-canvas/execution';
import { AuthService } from './auth-service';
import { PrismaAuthStore } from './auth-store';
import { NewApiAccountClient } from './newapi-account-client';
import { NewApiAccountService, authority } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';
import { buildApp } from './fixtures/test-app';
import { PrismaProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';
import { MemoryBlobStore, PrismaAssetStore } from './assets';

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
    maxSessionTtlSeconds: 30 * 86400,
  });
  let selectedUser = 'account-a';
  let groups = ['default', 'auto', '神秘分组', '神秘分组2'];
  let changedGroup = false;
  let unavailable = false;
  let grantLifetimeMs = 3600000;
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
    grantLifetimeMs = 3600000;
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
                expires_at: new Date(Date.now() + grantLifetimeMs).toISOString(),
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

  it('登录入口只转发显式换号提示，非法和重复 prompt 不创建事务', async () => {
    const app = buildApp({
      logger: false,
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: new PrismaProjectStore(prisma),
    });
    const before = await prisma.newApiLoginTransaction.count();
    try {
      for (const prompt of [undefined, 'select_account']) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/auth/newapi/start?next=%2Fsettings${prompt ? `&prompt=${prompt}` : ''}`,
        });
        expect(response.statusCode, response.body).toBe(302);
        const location = new URL(response.headers.location!);
        expect(location.origin).toBe(issuer);
        expect(location.searchParams.get('prompt')).toBe(prompt ?? null);
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('redirect_uri')).toBe(
          service.options.client.options.redirectUri,
        );
        expect(response.headers['set-cookie']).toContain('canvas_login=');
        expect(response.headers['set-cookie']).not.toContain('canvas_session=');
      }
      expect(await prisma.newApiLoginTransaction.count()).toBe(before + 2);
      for (const query of [
        'prompt=none',
        'prompt=',
        'prompt=select_account&prompt=select_account',
      ]) {
        expect(
          (await app.inject({ method: 'GET', url: `/v1/auth/newapi/start?${query}` })).statusCode,
        ).toBe(400);
      }
      expect(await prisma.newApiLoginTransaction.count()).toBe(before + 2);
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('取消登录只消费本人事务并返回登录页，旧会话保留且拒绝伪造和重放', async () => {
    const app = buildApp({ logger: false, newApiAccount: service, authService: auth });
    const before = {
      identities: await prisma.newApiIdentity.count(),
      sessions: await prisma.authSession.count(),
      groups: await prisma.newApiGroupBinding.count(),
    };
    try {
      const started = await service.start('/settings', 'select_account');
      const state = new URL(started.url).searchParams.get('state')!;
      const url = `/v1/auth/newapi/callback?state=${state}&error=access_denied`;
      const wrongBrowser = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: 'canvas_login=another-browser' },
      });
      expect(wrongBrowser.statusCode).toBe(400);
      const cookie = `canvas_login=${started.browser}; canvas_session=synthetic-current-session`;
      expect(
        (await app.inject({ method: 'GET', url: `${url}&code=ambiguous`, headers: { cookie } }))
          .statusCode,
      ).toBe(400);
      const cancelled = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(cancelled.statusCode).toBe(302);
      const destination = new URL(cancelled.headers.location!);
      expect(destination.origin).toBe(service.options.webUrl);
      expect(destination.pathname).toBe('/auth/login');
      expect(destination.searchParams.get('next')).toBe('/settings');
      expect(destination.searchParams.get('error')).toBe('login_cancelled');
      expect(cancelled.headers['set-cookie']).toContain('canvas_login=;');
      expect(cancelled.headers['set-cookie']).toContain('Max-Age=0');
      expect(cancelled.headers['set-cookie']).not.toContain('canvas_session=');
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(400);
      await expect(
        service.callback(state, 'synthetic-code', started.browser),
      ).rejects.toMatchObject({ code: 'invalid_login' });
      expect(await prisma.newApiIdentity.count()).toBe(before.identities);
      expect(await prisma.authSession.count()).toBe(before.sessions);
      expect(await prisma.newApiGroupBinding.count()).toBe(before.groups);
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('访问令牌过期后主动退出仍清 Cookie、撤销旧会话', async () => {
    const result = await login();
    const app = buildApp({ logger: false, newApiAccount: service, authService: auth });
    const cookie = `canvas_session=${result.accessToken}`;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60000);
    try {
      const crossSite = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { cookie, origin: 'https://other.example.test' },
      });
      expect(crossSite.statusCode).toBe(403);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toContain('Max-Age=0');
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie } }))
          .statusCode,
      ).toBe(401);
    } finally {
      clock.mockRestore();
      await app.close();
    }
  });

  it('旧 7 天会话在上游复核后延长至 grant 到期，但已轮换 Cookie 不可复用', async () => {
    grantLifetimeMs = 25 * 86400000;
    const result = await login();
    expect(Date.parse(result.refreshExpiresAt) - Date.now()).toBeGreaterThan(24 * 86400000);
    const store = new PrismaAuthStore(prisma);
    const user = await store.findUserById(result.user.id);
    const legacy = await auth.issueToken(user!, new Date(Date.now() + 7 * 86400000));
    const app = buildApp({ logger: false, newApiAccount: service, authService: auth });
    const cookie = `canvas_session=${legacy.accessToken}`;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).not.toHaveProperty('accessToken');
      const maxAge = Number(String(response.headers['set-cookie']).match(/Max-Age=(\d+)/)?.[1]);
      expect(maxAge).toBeGreaterThan(7 * 86400);
      const renewed = String(response.headers['set-cookie']).split(';')[0]!;
      const session = (await auth.verifyAccessToken(decodeURIComponent(renewed.split('=')[1]!)))
        .session;
      expect(session?.absoluteExpiresAt?.toISOString()).toBe(result.refreshExpiresAt);
      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

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

  it('跨账号导入保留模型建议但不继承分组凭据，重选前不创建运行授权', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const accountA = await login();
    selectedUser = 'account-b';
    const accountB = await login();
    const accountAGroups = (await service.status(accountA.user.id)).groups;
    const accountBGroups = (await service.status(accountB.user.id)).groups;
    const accountBModels = await service.models(accountB.user.id, 'text');
    const accountACredential = accountAGroups.find(
      (entry) => entry.group === 'default',
    )?.credentialId;
    const accountBCredential = accountBGroups.find(
      (entry) => entry.group === 'default',
    )?.credentialId;
    expect(accountACredential).toBeTruthy();
    expect(accountBCredential).toBeTruthy();
    expect(accountBGroups.filter((entry) => entry.credentialId)).toHaveLength(3);
    expect(accountBModels.filter((entry) => entry.id === 'exact-model')).toHaveLength(3);

    const projects = new PrismaProjectStore(prisma);
    const runs = new MemoryRunService({ providerName: 'newapi' });
    const createRun = vi.spyOn(runs, 'create');
    const app = buildApp({
      logger: false,
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: projects,
      runService: runs,
    });
    const cookieA = `canvas_session=${accountA.accessToken}`;
    const cookieB = `canvas_session=${accountB.accessToken}`;
    try {
      const sourceProjectResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: cookieA },
        payload: { name: '账号 A 导出源' },
      });
      expect(sourceProjectResponse.statusCode, sourceProjectResponse.body).toBe(201);
      const sourceProjectId = sourceProjectResponse.json().project.id as string;
      const sourceCanvas = {
        revision: 0,
        nodes: [
          {
            id: 'shared-text-node',
            type: 'text',
            position: { x: 160, y: 240 },
            data: {
              label: '必须保留的正文',
              mediaType: 'text',
              mode: 'generate',
              prompt: 'Preserve this exact imported content.',
              modelAlias: 'exact-model',
              credentialId: accountACredential,
              parameters: { temperature: 0.35 },
            },
          },
        ],
        edges: [],
      };
      const savedCanvas = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${sourceProjectId}/canvas`,
        headers: { cookie: cookieA },
        payload: sourceCanvas,
      });
      expect(savedCanvas.statusCode, savedCanvas.body).toBe(200);
      const savedDefault = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${sourceProjectId}/models/defaults`,
        headers: { cookie: cookieA },
        payload: {
          text: { modelAlias: 'exact-model', credentialId: accountACredential },
        },
      });
      expect(savedDefault.statusCode, savedDefault.body).toBe(200);
      expect(savedDefault.json().defaults).toEqual({
        text: { modelAlias: 'exact-model', credentialId: accountACredential },
      });

      const exported = await app.inject({
        method: 'GET',
        url: `/v1/projects/${sourceProjectId}/export/workflow`,
        headers: { cookie: cookieA },
      });
      expect(exported.statusCode, exported.body).toBe(200);
      const workflow = exported.json();
      expect(workflow.canvas.nodes[0]).toMatchObject({
        id: 'shared-text-node',
        position: { x: 160, y: 240 },
        data: {
          label: '必须保留的正文',
          prompt: 'Preserve this exact imported content.',
          modelAlias: 'exact-model',
          parameters: { temperature: 0.35 },
        },
      });
      expect(workflow.modelDefaults).toEqual({ text: { modelAlias: 'exact-model' } });
      for (const credentialId of accountAGroups.flatMap((entry) =>
        entry.credentialId ? [entry.credentialId] : [],
      )) {
        expect(exported.body).not.toContain(credentialId);
      }

      const targetProjectResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { cookie: cookieB },
        payload: { name: '账号 B 导入目标' },
      });
      expect(targetProjectResponse.statusCode, targetProjectResponse.body).toBe(201);
      const targetProjectId = targetProjectResponse.json().project.id as string;
      const imported = await app.inject({
        method: 'POST',
        url: `/v1/projects/${targetProjectId}/import/workflow`,
        headers: { cookie: cookieB },
        payload: { workflow, expectedRevision: 0 },
      });
      expect(imported.statusCode, imported.body).toBe(200);
      const importedNodeId = imported.json().canvas.nodes[0].id as string;
      expect(importedNodeId).not.toBe('shared-text-node');
      expect(imported.json().nodeIdMap).toEqual({ 'shared-text-node': importedNodeId });
      expect(imported.json().canvas.nodes[0]).toMatchObject({
        position: { x: 160, y: 240 },
        data: {
          label: '必须保留的正文',
          prompt: 'Preserve this exact imported content.',
          modelAlias: 'exact-model',
          parameters: { temperature: 0.35 },
        },
      });
      expect(imported.json().canvas.nodes[0].data).not.toHaveProperty('credentialId');
      expect(imported.json().modelDefaults).toEqual({ text: 'exact-model' });
      expect(imported.json().issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'MODEL_SELECTION_REQUIRED',
            nodeId: importedNodeId,
            modelAlias: 'exact-model',
          }),
          expect.objectContaining({
            code: 'MODEL_SELECTION_REQUIRED',
            mediaType: 'text',
            modelAlias: 'exact-model',
          }),
        ]),
      );
      for (const credentialId of accountAGroups.flatMap((entry) =>
        entry.credentialId ? [entry.credentialId] : [],
      )) {
        expect(imported.body).not.toContain(credentialId);
      }
      expect(
        (await projects.getCanvas(sourceProjectId, { ownerId: accountA.user.id }))?.nodes[0]?.id,
      ).toBe('shared-text-node');
      expect(
        (await projects.getCanvas(targetProjectId, { ownerId: accountB.user.id }))?.nodes[0]?.id,
      ).toBe(importedNodeId);

      const rejectedRun = await app.inject({
        method: 'POST',
        url: `/v1/nodes/${importedNodeId}/runs`,
        headers: { cookie: cookieB },
        payload: { projectId: targetProjectId },
      });
      expect(rejectedRun.statusCode, rejectedRun.body).toBe(400);
      expect(rejectedRun.json()).toMatchObject({ code: 'model_unavailable' });
      expect(createRun).not.toHaveBeenCalled();
      expect(await runs.listByProject(targetProjectId)).toEqual([]);
      expect(await prisma.run.count({ where: { projectId: targetProjectId } })).toBe(0);
      expect(
        await prisma.executionAuthorization.count({ where: { projectId: targetProjectId } }),
      ).toBe(0);

      const foreignDefault = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${targetProjectId}/models/defaults`,
        headers: { cookie: cookieB },
        payload: {
          text: { modelAlias: 'exact-model', credentialId: accountACredential },
        },
      });
      expect(foreignDefault.statusCode, foreignDefault.body).toBe(404);
      expect(foreignDefault.json()).toMatchObject({ code: 'credential_not_found' });
      expect(
        await projects.getModelDefaults(targetProjectId, { ownerId: accountB.user.id }),
      ).toEqual({ text: 'exact-model' });

      const ownDefault = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${targetProjectId}/models/defaults`,
        headers: { cookie: cookieB },
        payload: {
          text: { modelAlias: 'exact-model', credentialId: accountBCredential },
        },
      });
      expect(ownDefault.statusCode, ownDefault.body).toBe(200);
      expect(ownDefault.json().defaults).toEqual({
        text: { modelAlias: 'exact-model', credentialId: accountBCredential },
      });
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it('导入默认模型写入失败时回滚画布、默认模型及版本，修复后可原版本重试', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const session = await login();
    const owner = { ownerId: session.user.id };
    const projects = new PrismaProjectStore(prisma);
    const project = await projects.create({ name: 'Atomic workflow import' }, owner);
    const originalCanvas = await projects.updateCanvas(
      project.id,
      { revision: 0, nodes: [], edges: [], groups: [] },
      owner,
    );
    const originalDefaults = await projects.updateModelDefaults(
      project.id,
      { text: 'original-model', image: 'retained-image' },
      owner,
    );
    const originalProject = await projects.get(project.id, owner);
    const app = buildApp({
      logger: false,
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: projects,
    });
    const workflow = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      project,
      canvas: {
        revision: 0,
        nodes: [
          {
            id: randomUUID(),
            type: 'text',
            position: { x: 15, y: 30 },
            data: { label: 'Imported node', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
      modelDefaults: { text: 'reject-import' },
      runs: [],
      results: [],
    };
    try {
      // 仅在随机测试 schema 中拒绝该默认值，让真实数据库在写入阶段失败。
      await prisma.$executeRawUnsafe(
        `ALTER TABLE project_model_defaults ADD CONSTRAINT import_failure_fixture CHECK ("modelAlias" <> 'reject-import')`,
      );
      const failed = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/import/workflow`,
        headers: { cookie: `canvas_session=${session.accessToken}` },
        payload: { workflow, expectedRevision: originalCanvas.revision },
      });
      expect(failed.statusCode, failed.body).toBe(500);
      expect(await projects.getCanvas(project.id, owner)).toEqual(originalCanvas);
      expect(await projects.getModelDefaults(project.id, owner)).toEqual(originalDefaults);
      expect(await projects.get(project.id, owner)).toEqual(originalProject);
      await prisma.$executeRawUnsafe(
        'ALTER TABLE project_model_defaults DROP CONSTRAINT import_failure_fixture',
      );
      const imported = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/import/workflow`,
        headers: { cookie: `canvas_session=${session.accessToken}` },
        payload: { workflow, expectedRevision: originalCanvas.revision },
      });
      expect(imported.statusCode, imported.body).toBe(200);
      expect(imported.json().canvas).toMatchObject({
        revision: originalCanvas.revision + 1,
        nodes: workflow.canvas.nodes,
      });
      expect(imported.json().modelDefaults).toEqual({
        text: 'reject-import',
        image: 'retained-image',
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE project_model_defaults DROP CONSTRAINT IF EXISTS import_failure_fixture',
      );
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it('导入拒绝外人素材及失效版本，保留本人图片来源版本且不复制运行或资产', async () => {
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const a = await login();
    selectedUser = 'account-b';
    const b = await login();
    const owner = { ownerId: b.user.id };
    const projects = new PrismaProjectStore(prisma);
    const assets = new PrismaAssetStore(prisma, { blobStore: new MemoryBlobStore() });
    const source = await projects.create({ name: 'Private source' }, { ownerId: a.user.id });
    const target = await projects.create({ name: 'Import reference target' }, owner);
    const foreignAsset = await assets.create({
      ownerId: a.user.id,
      projectId: source.id,
      name: 'Private image',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('private-image'),
    });
    const ownAsset = await assets.create({
      ownerId: b.user.id,
      name: 'Own image',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('original-image'),
    });
    await assets.createVersion(ownAsset.id, { content: Buffer.from('new-image') }, owner);
    const beforeCanvas = await projects.getCanvas(target.id, owner);
    const beforeCounts = { assets: await prisma.asset.count(), runs: await prisma.run.count() };
    const app = buildApp({
      logger: false,
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: projects,
      assetStore: assets,
    });
    const workflow = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      project: source,
      canvas: {
        revision: 0,
        nodes: [
          {
            id: 'source-image',
            type: 'image',
            position: { x: 1, y: 2 },
            data: { label: 'Image', mediaType: 'image', mode: 'source' },
          },
        ],
        edges: [],
      },
      modelDefaults: { text: 'exact-model' },
      runs: [{ id: 'exported-run' }],
      results: [{ runId: 'exported-run', asset: { assetId: foreignAsset.id, version: 1 } }],
    };
    try {
      for (const data of [
        { assetId: foreignAsset.id },
        {
          resourceRefs: [
            { id: 'ref', assetId: foreignAsset.id, mediaType: 'image', name: 'Reference' },
          ],
        },
        { imageEditSource: { sourceNodeId: 'source-image', assetId: foreignAsset.id, version: 1 } },
        { imageEditSource: { sourceNodeId: 'source-image', assetId: ownAsset.id, version: 99 } },
      ]) {
        const result = await app.inject({
          method: 'POST',
          url: `/v1/projects/${target.id}/import/workflow`,
          headers: { cookie: `canvas_session=${b.accessToken}` },
          payload: {
            ...workflow,
            canvas: {
              ...workflow.canvas,
              nodes: [
                {
                  ...workflow.canvas.nodes[0],
                  data: { ...workflow.canvas.nodes[0].data, ...data },
                },
              ],
            },
          },
        });
        expect(result.statusCode, result.body).toBe(400);
        expect(result.json().code).toBe('asset_unavailable');
        expect(await projects.getCanvas(target.id, owner)).toEqual(beforeCanvas);
        expect(await projects.getModelDefaults(target.id, owner)).toEqual({});
      }
      const imported = await app.inject({
        method: 'POST',
        url: `/v1/projects/${target.id}/import/workflow`,
        headers: { cookie: `canvas_session=${b.accessToken}` },
        payload: {
          ...workflow,
          canvas: {
            ...workflow.canvas,
            nodes: [
              {
                ...workflow.canvas.nodes[0],
                data: {
                  ...workflow.canvas.nodes[0].data,
                  assetId: ownAsset.id,
                  resourceRefs: [
                    {
                      id: 'ref',
                      assetId: ownAsset.id,
                      assetVersion: 1,
                      mediaType: 'image',
                      name: 'Reference',
                    },
                  ],
                  imageEditSource: {
                    sourceNodeId: 'source-image',
                    assetId: ownAsset.id,
                    version: 1,
                    sourceKind: 'result',
                  },
                },
              },
            ],
          },
        },
      });
      expect(imported.statusCode, imported.body).toBe(200);
      const nodeId = imported.json().nodeIdMap['source-image'];
      const saved = await projects.getCanvas(target.id, owner);
      expect(saved?.nodes[0].data).toMatchObject({
        assetId: ownAsset.id,
        resourceRefs: [{ assetId: ownAsset.id, assetVersion: 1 }],
        imageEditSource: {
          sourceNodeId: nodeId,
          assetId: ownAsset.id,
          version: 1,
          sourceKind: 'result',
        },
      });
      expect(await assets.getOwnership(foreignAsset.id)).toEqual({
        ownerId: a.user.id,
        projectId: source.id,
      });
      expect(await assets.getOwnership(ownAsset.id)).toEqual({
        ownerId: b.user.id,
        projectId: null,
      });
      expect({ assets: await prisma.asset.count(), runs: await prisma.run.count() }).toEqual(
        beforeCounts,
      );
      expect(await assets.getVersionContent(ownAsset.id, 1, owner)).toEqual(
        Buffer.from('original-image'),
      );
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
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

  it('轮换排空旧任务和 unknown，丢失回包后原操作恢复且冻结旧版本不可再受理', async () => {
    const account = await login();
    const identity = await service.identity(account.user.id);
    const binding = await prisma.newApiGroupBinding.findUniqueOrThrow({
      where: { identityId_group: { identityId: identity.id, group: 'default' } },
      include: { credential: true },
    });
    const credential = binding.credential!;
    const project = await new PrismaProjectStore(prisma).create(
      { name: 'Controlled rotation' },
      { ownerId: account.user.id },
    );
    const snapshot: RunSnapshot = {
      projectId: project.id,
      canvasRevision: 1,
      targetNodeId: 'target',
      modelAlias: 'exact-model',
      parameters: {},
      submittedAt: new Date().toISOString(),
      inputs: [],
      edges: [],
      credentialId: credential.id,
      credentialVersion: credential.version,
      nodes: [
        {
          id: 'target',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: 'Rotation',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'exact-model',
          },
        },
      ],
      executionBindings: {
        target: {
          credentialId: credential.id,
          credentialVersion: 1,
          modelAlias: 'exact-model',
          mediaType: 'text',
          contract: 'openai-chat-completions',
          authority: authority(identity, binding),
        },
      },
    };
    const execution = new PrismaExecutionService(prisma);
    const input = (runId: string, value = snapshot) => ({
      runId,
      userId: account.user.id,
      snapshot: value,
      queueName: 'rotation-test',
      payload: {
        runId,
        userId: account.user.id,
        snapshot: value,
        attempt: 1,
        provider: 'newapi' as const,
        cancelRequested: false,
      },
    });
    const submitted = await execution.createSubmission(input(`rotation-${randomUUID()}`));
    const remote = vi.spyOn(service.options.client, 'rotateGroup');
    await expect(service.rotateGroup(account.user.id, credential.id, 1)).rejects.toMatchObject({
      code: 'rotation_busy',
    });
    expect(remote).not.toHaveBeenCalled();
    await prisma.run.update({ where: { id: submitted.databaseRunId }, data: { status: 'FAILED' } });
    await prisma.runSendIntent.create({
      data: {
        runId: submitted.runId,
        nodeId: 'target',
        attempt: 1,
        requestIdentity: 'synthetic-request',
        status: 'unknown',
      },
    });
    await expect(service.rotateGroup(account.user.id, credential.id, 1)).rejects.toMatchObject({
      code: 'rotation_busy',
    });
    await prisma.runSendIntent.update({
      where: { runId_nodeId_attempt: { runId: submitted.runId, nodeId: 'target', attempt: 1 } },
      data: { status: 'sent' },
    });
    await expect(service.rotateGroup(account.user.id, credential.id, 1)).rejects.toMatchObject({
      code: 'rotation_busy',
    });
    await prisma.run.update({
      where: { id: submitted.databaseRunId },
      data: { status: 'SUCCEEDED' },
    });
    let remoteCalls = 0;
    let operationId = '';
    const rotatedKey = 'synthetic-controlled-rotation-key';
    remote.mockImplementation(async (_grant, group, operation, previous) => {
      if (!operationId) operationId = operation;
      expect(operation).toBe(operationId);
      expect(previous).toEqual({
        tokenId: binding.upstreamTokenId,
        revision: '1',
        fingerprint: credential.keyFingerprint,
      });
      if (++remoteCalls === 1) throw new Error('synthetic lost rotation response');
      return {
        token_id: binding.upstreamTokenId!,
        key: rotatedKey,
        group,
        status: 'active',
        credential_revision: '2',
        permission_revision: '2',
        auto_groups: [],
      };
    });
    await expect(service.rotateGroup(account.user.id, credential.id, 1)).rejects.toThrow(
      'synthetic lost',
    );
    await service.synchronize(account.user.id);
    expect(
      (await service.status(account.user.id)).groups.find((group) => group.group === 'default')
        ?.status,
    ).toBe('unavailable');
    await expect(
      execution.createSubmission(input(`rotation-stale-${randomUUID()}`)),
    ).rejects.toMatchObject({ code: 'binding_changed' });
    const recovered = new NewApiAccountService(service.options);
    await expect(recovered.rotateGroup(account.user.id, credential.id, 1)).resolves.toEqual({
      credentialId: credential.id,
      version: 2,
      completed: true,
    });
    await recovered.rotateGroup(account.user.id, credential.id, 1);
    expect(remoteCalls).toBe(2);
    const current = await prisma.aiCredential.findUniqueOrThrow({ where: { id: credential.id } });
    expect(current.version).toBe(2);
    expect(keyring.decrypt(current.encryptedApiKey).plaintext).toBe(rotatedKey);
    const previous = await prisma.newApiCredentialRotation.findUniqueOrThrow({
      where: { credentialId_fromVersion: { credentialId: credential.id, fromVersion: 1 } },
    });
    expect(previous.completedAt).not.toBeNull();
    expect(keyring.decrypt(previous.encryptedApiKey).plaintext).toBe(
      keyring.decrypt(credential.encryptedApiKey).plaintext,
    );
    expect((await execution.requireAuthorization(submitted.runId)).snapshot).toEqual(snapshot);
    await expect(
      execution.createSubmission(input(`rotation-late-${randomUUID()}`)),
    ).rejects.toMatchObject({ code: 'binding_changed' });
    const fresh = structuredClone(snapshot);
    fresh.credentialVersion = 2;
    fresh.executionBindings!.target!.credentialVersion = 2;
    fresh.executionBindings!.target!.authority.credentialRevision = '2';
    fresh.executionBindings!.target!.authority.permissionRevision = '2';
    await expect(
      execution.createSubmission(input(`rotation-fresh-${randomUUID()}`, fresh)),
    ).resolves.toMatchObject({ status: 'active' });
    selectedUser = 'account-b';
    const b = await login();
    await expect(service.rotateGroup(b.user.id, credential.id, 1)).rejects.toMatchObject({
      code: 'credential_not_found',
    });
  });

  it('并发轮换与提交只能受理一方，维护入口拒绝非管理员和跨站请求', async () => {
    vi.stubEnv('API_JWT_SECRET', 'synthetic-account-jwt');
    const account = await login();
    const identity = await service.identity(account.user.id);
    const binding = await prisma.newApiGroupBinding.findUniqueOrThrow({
      where: { identityId_group: { identityId: identity.id, group: 'default' } },
      include: { credential: true },
    });
    const credential = binding.credential!;
    const app = buildApp({
      logger: false,
      newApiAccount: service,
      authService: auth,
      authStore: new PrismaAuthStore(prisma),
      projectStore: new PrismaProjectStore(prisma),
    });
    try {
      const request = {
        method: 'POST' as const,
        url: `/v1/account/newapi/groups/${credential.id}/rotate`,
        headers: {
          cookie: `canvas_session=${account.accessToken}`,
          origin: 'http://localhost:5173',
        },
        payload: { expectedVersion: 1 },
      };
      expect((await app.inject(request)).statusCode).toBe(403);
      await prisma.user.update({ where: { id: account.user.id }, data: { role: 'ADMIN' } });
      expect(
        (
          await app.inject({
            ...request,
            headers: { ...request.headers, origin: 'https://untrusted.example' },
          })
        ).statusCode,
      ).toBe(403);
      expect((await app.inject({ ...request, payload: { expectedVersion: 0 } })).statusCode).toBe(
        400,
      );
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
    const project = await new PrismaProjectStore(prisma).create(
      { name: 'Rotation race' },
      { ownerId: account.user.id },
    );
    const snapshot: RunSnapshot = {
      projectId: project.id,
      canvasRevision: 1,
      targetNodeId: 'target',
      modelAlias: 'exact-model',
      submittedAt: new Date().toISOString(),
      parameters: {},
      inputs: [],
      edges: [],
      nodes: [
        {
          id: 'target',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Race', mediaType: 'text', mode: 'generate', modelAlias: 'exact-model' },
        },
      ],
      executionBindings: {
        target: {
          credentialId: credential.id,
          credentialVersion: 1,
          modelAlias: 'exact-model',
          mediaType: 'text',
          contract: 'openai-chat-completions',
          authority: authority(identity, binding),
        },
      },
    };
    vi.spyOn(service.options.client, 'rotateGroup').mockResolvedValue({
      token_id: binding.upstreamTokenId!,
      key: 'synthetic-race-rotation-key',
      group: 'default',
      status: 'active',
      credential_revision: '2',
      permission_revision: '2',
      auto_groups: [],
    });
    const runId = `rotation-race-${randomUUID()}`;
    const results = await Promise.allSettled([
      service.rotateGroup(account.user.id, credential.id, 1),
      new PrismaExecutionService(prisma).createSubmission({
        runId,
        userId: account.user.id,
        snapshot,
        queueName: 'rotation-test',
        payload: {
          runId,
          userId: account.user.id,
          snapshot,
          attempt: 1,
          provider: 'newapi',
          cancelRequested: false,
        },
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(['rotation_busy', 'binding_changed']).toContain(rejected.reason.code);
    const version = (await prisma.aiCredential.findUniqueOrThrow({ where: { id: credential.id } }))
      .version;
    expect(await prisma.executionAuthorization.count({ where: { runId } })).toBe(
      version === 1 ? 1 : 0,
    );
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountService } from './account-service';
import { AuthService } from './auth-service';
import { PrismaAuthStore } from './auth-store';
import { FileSystemBlobStore, PrismaAssetStore } from './assets';
import { PrismaProjectStore } from './projects';
import { TestAccountMailSender } from './fixtures/account-mail';
import { withAssetOwnershipPolicy } from './asset-ownership';

/** 此测试只允许专用本机测试数据库，禁止 schema 参数误隔离旧 public 迁移。 */
const databaseUrl = process.env.TEST_ACCOUNT_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/admin_account_test(?:_[a-z0-9]+)?$/.test(url.pathname) ||
    (url.searchParams.get('schema') && url.searchParams.get('schema') !== 'public')
  )
    throw new Error(
      'TEST_ACCOUNT_DATABASE_URL 必须指向本机独立 admin_account_test 数据库的 public schema',
    );
}
/** 缺少明确测试连接时跳过，不能回退使用开发或生产 DATABASE_URL。 */
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL 管理员初始化和账户资源持久化', () => {
  const prisma = new PrismaClient({
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });
  let directory: string;
  /** 只清理命名和连接均已校验的专用测试数据库。 */
  async function cleanFixtureDatabase() {
    await prisma.assetVersion.deleteMany();
    await prisma.asset.deleteMany();
    await prisma.project.deleteMany();
    await prisma.authSession.deleteMany();
    await prisma.user.deleteMany();
    await prisma.adminBootstrap.deleteMany();
    await prisma.emailChallenge.deleteMany();
    await prisma.emailDelivery.deleteMany();
    await prisma.accountAudit.deleteMany();
  }
  beforeAll(async () => {
    await prisma.$connect();
    await cleanFixtureDatabase();
    directory = await mkdtemp(join(tmpdir(), 'canvas-admin-db-test-'));
  });
  afterAll(async () => {
    await cleanFixtureDatabase();
    await prisma.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('两个独立数据库客户端并发初始化仅成功一次，重连后标记和登录会话仍存在', async () => {
    const secondClient = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const storeA = new PrismaAuthStore(prisma);
    const storeB = new PrismaAuthStore(secondClient);
    const mail = new TestAccountMailSender();
    const authA = new AuthService({ store: storeA, jwtSecret: 'synthetic-test-secret' });
    const authB = new AuthService({ store: storeB, jwtSecret: 'synthetic-test-secret' });
    const a = new AccountService({
      store: storeA,
      auth: authA,
      mail,
      secret: 'synthetic-test-secret',
    });
    const b = new AccountService({
      store: storeB,
      auth: authB,
      mail,
      secret: 'synthetic-test-secret',
    });
    try {
      await a.requestBootstrap({ email: 'db-first@example.test', password: 'correct-password' });
      await b.requestBootstrap({ email: 'db-second@example.test', password: 'correct-password' });
      const attempts = await Promise.allSettled([
        a.verify({
          email: 'db-first@example.test',
          purpose: 'bootstrap',
          code: mail.latest('db-first@example.test', 'bootstrap').code,
        }),
        b.verify({
          email: 'db-second@example.test',
          purpose: 'bootstrap',
          code: mail.latest('db-second@example.test', 'bootstrap').code,
        }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
      const success = attempts.find((attempt) => attempt.status === 'fulfilled')!;
      if (success.status !== 'fulfilled') throw new Error('并发初始化缺少成功结果');
      await secondClient.$disconnect();
      await secondClient.$connect();
      expect((await b.bootstrapStatus()).initialized).toBe(true);
      expect((await authB.verifyAccessToken(success.value.accessToken)).user.id).toBe(
        success.value.user.id,
      );
      await prisma.user.delete({ where: { id: success.value.user.id } });
      expect((await a.bootstrapStatus()).initialized).toBe(true);
    } finally {
      await secondClient.$disconnect();
    }
  });

  it('邀请激活、失败尝试、唯一邮箱和审计写入实际数据库，验证并发只能消费一次', async () => {
    const store = new PrismaAuthStore(prisma);
    const mail = new TestAccountMailSender();
    const auth = new AuthService({ store, jwtSecret: 'synthetic-test-secret' });
    const service = new AccountService({ store, auth, mail, secret: 'synthetic-test-secret' });
    const invitation = await service.invite('11111111-1111-4111-8111-111111111111', {
      email: 'db-user@example.test',
      displayName: '数据库用户',
    });
    const code = mail.latest('db-user@example.test', 'invite').code;
    await expect(
      service.verify({
        email: 'db-user@example.test',
        purpose: 'invite',
        code: code === '000000' ? '111111' : '000000',
        password: 'correct-password',
      }),
    ).rejects.toMatchObject({ code: 'invalid_verification_code' });
    expect(
      (await prisma.emailChallenge.findUnique({
        where: { email_purpose: { email: 'db-user@example.test', purpose: 'invite' } },
      }))!.attempts,
    ).toBe(1);
    const activations = await Promise.allSettled([
      service.verify({
        email: 'db-user@example.test',
        purpose: 'invite',
        code,
        password: 'correct-password',
      }),
      service.verify({
        email: 'db-user@example.test',
        purpose: 'invite',
        code,
        password: 'correct-password',
      }),
    ]);
    expect(activations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.findUserById(invitation.user.id))!.status).toBe('active');
    await expect(
      service.register({ email: 'DB-USER@example.test', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    expect(
      (await store.listAudit()).some((event) => event.action === 'account.verify.invite'),
    ).toBe(true);
  });

  it('资源上传、生成元数据、归属及版本通过实际数据库与文件对象存储重建后保持', async () => {
    const store = new PrismaAuthStore(prisma);
    const user = (await store.findUserByEmail('db-user@example.test'))!;
    const projects = new PrismaProjectStore(prisma);
    const project = await projects.create({ name: '隔离资源项目' }, { ownerId: user.id });
    const assets = new PrismaAssetStore(prisma, { blobStore: new FileSystemBlobStore(directory) });
    const asset = await assets.create({
      ownerId: user.id,
      projectId: project.id,
      name: '生成文本',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('第一版'),
      metadata: { runId: 'synthetic-run' },
    });
    await assets.createVersion(asset.id, { content: Buffer.from('第二版') }, { ownerId: user.id });
    const reopened = new PrismaAssetStore(prisma, {
      blobStore: new FileSystemBlobStore(directory),
    });
    const managed = await reopened.listManagement({ ownerId: user.id });
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      ownerId: user.id,
      projectId: project.id,
      source: 'generated',
      latestVersion: 2,
    });
    expect((await reopened.getVersionContent(asset.id, 1, { ownerId: user.id }))!.toString()).toBe(
      '第一版',
    );
    expect(
      await reopened.get(asset.id, { ownerId: '22222222-2222-4222-8222-222222222222' }),
    ).toBeUndefined();
  });

  it('Prisma 历史空 owner 资源通过已核验项目恢复读取，其他用户和冲突项目约束仍拒绝', async () => {
    const store = new PrismaAuthStore(prisma);
    const user = (await store.findUserByEmail('db-user@example.test'))!;
    const projects = new PrismaProjectStore(prisma);
    const project = await projects.create({ name: '历史空归属项目' }, { ownerId: user.id });
    expect(project.ownerId).toBe(user.id);
    expect((await projects.get(project.id))?.ownerId).toBe(user.id);
    expect(
      (await projects.list({ ownerId: user.id })).every((entry) => entry.ownerId === user.id),
    ).toBe(true);
    const raw = new PrismaAssetStore(prisma, { blobStore: new FileSystemBlobStore(directory) });
    const legacy = await raw.create({
      projectId: project.id,
      name: '历史资源',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('legacy-database-content'),
    });
    const assets = withAssetOwnershipPolicy(raw, projects);
    expect(await raw.get(legacy.id, { ownerId: user.id })).toBeUndefined();
    expect((await assets.get(legacy.id, { ownerId: user.id }))?.content.toString()).toBe(
      'legacy-database-content',
    );
    expect(await assets.listVersions(legacy.id, { ownerId: user.id })).toHaveLength(1);
    expect((await assets.getVersionContent(legacy.id, 1, { ownerId: user.id }))?.toString()).toBe(
      'legacy-database-content',
    );
    for (const scope of [
      { ownerId: '22222222-2222-4222-8222-222222222222' },
      { ownerId: user.id, projectId: null },
    ]) {
      expect(await assets.get(legacy.id, scope)).toBeUndefined();
      expect(await assets.listVersions(legacy.id, scope)).toEqual([]);
      expect(await assets.getVersionContent(legacy.id, 1, scope)).toBeUndefined();
    }
    expect(await raw.getOwnership(legacy.id)).toEqual({ ownerId: null, projectId: project.id });
    const canvas = await projects.updateCanvas(
      project.id,
      {
        revision: 0,
        nodes: [
          {
            id: 'node_legacy_asset',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: '历史资源节点', mediaType: 'text', mode: 'source', assetId: legacy.id },
          },
        ],
        edges: [],
      },
      { ownerId: user.id },
    );
    expect(canvas.nodes[0].data.assetId).toBe(legacy.id);
    const other = await store.createUser({
      email: 'db-other@example.test',
      passwordHash: user.passwordHash!,
    });
    const otherProject = await projects.create({ name: '其他用户项目' }, { ownerId: other.id });
    const conflict = await raw.create({
      ownerId: user.id,
      projectId: otherProject.id,
      name: '归属冲突资源',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('conflict-content'),
    });
    expect(await assets.get(conflict.id, { ownerId: user.id })).toBeUndefined();
    expect(await assets.get(conflict.id, { ownerId: other.id })).toBeUndefined();
    await expect(
      projects.updateCanvas(
        otherProject.id,
        {
          revision: 0,
          nodes: [
            {
              id: 'node_conflict_asset',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: '冲突节点', mediaType: 'text', mode: 'source', assetId: conflict.id },
            },
          ],
          edges: [],
        },
        { ownerId: other.id },
      ),
    ).rejects.toMatchObject({ code: 'invalid_asset' });
  });
});

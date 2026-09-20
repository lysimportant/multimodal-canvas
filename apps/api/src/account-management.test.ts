import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './fixtures/test-app';
import { AuthService } from './auth-service';
import { FileAuthStore } from './fixtures/file-auth-store';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { TestAuthContext, issueTestSession } from './fixtures/auth-session';
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-test-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
});
afterEach(() => vi.unstubAllEnvs());
describe('后台资源与会话边界', () => {
  it('资源列表、分组、详情、版本、下载和编辑全部按服务器所有者边界校验', async () => {
    const context = new TestAuthContext();
    const store = context.store;
    const mail = context;
    const assets = new MemoryAssetStore();
    const projects = new MemoryProjectStore();
    await store.createUser({
      email: 'admin@example.test',
      role: 'admin',
    });
    const app = buildApp({
      logger: false,
      ...mail.appOptions,
      assetStore: assets,
      projectStore: projects,
    });
    try {
      const admin = await context.session({ email: 'admin@example.test', role: 'admin' });
      const a = (
        await issueTestSession(app, mail, {
          email: 'a@example.test',
          password: 'correct-password',
        })
      ).json();
      const b = (
        await issueTestSession(app, mail, {
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
      await store.updateUser(a.user.id, { status: 'disabled' });
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
    const mail = new TestAuthContext();
    const app = buildApp({ logger: false, ...mail.appOptions });
    try {
      const first = (
        await issueTestSession(app, mail, {
          email: 'sessions@example.test',
          password: 'correct-password',
        })
      ).json();
      const second = await mail.session({ email: 'sessions@example.test' });
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
        await issueTestSession(app, mail, {
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
  it('文件存储重建后保留会话及资源身份', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-account-test-'));
    const path = join(directory, 'store.bin');
    try {
      const store = new FileAuthStore(path);
      await store.initialize();
      const auth = new AuthService({ store, jwtSecret: 'synthetic-test-secret' });
      const user = await store.createUser({ email: 'restart@example.test' });
      const session = await auth.issueToken(user);
      await store.close();
      const reopened = new FileAuthStore(path);
      await reopened.initialize();
      try {
        expect(
          (
            await new AuthService({
              store: reopened,
              jwtSecret: 'synthetic-test-secret',
            }).verifyAccessToken(session.accessToken)
          ).user.id,
        ).toBe(user.id);
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

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
import type { RunRecord } from '@multimodal-canvas/domain';
import { ExecutionError } from '@multimodal-canvas/execution';
import { createRunSnapshot, RunServiceError, type RunService } from './runs';
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-test-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('WEB_PORT', '5173');
});

/** 已发送的合成视频任务；敏感字段仅用于确认公开 DTO 不回显。 */
function videoRun(
  projectId: string,
  userId: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const timestamp = '2026-10-12T00:00:00.000Z';
  return {
    id: 'run-video',
    userId,
    projectId,
    targetNodeId: 'video-target',
    status: 'failed',
    progress: 40,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'synthetic-video-model',
    snapshot: createRunSnapshot(
      projectId,
      {
        revision: 1,
        nodes: [
          {
            id: 'video-target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: {
              label: '合成视频',
              mediaType: 'video',
              mode: 'generate',
              prompt: 'PRIVATE_FROZEN_PROMPT',
            },
          },
        ],
        edges: [],
      },
      'video-target',
      { modelAlias: 'synthetic-video-model', credentialId: 'PRIVATE_CREDENTIAL_ID' },
    ),
    providerJob: {
      id: 'provider-job-video',
      provider: 'newapi',
      platformJobId: 'PRIVATE_PLATFORM_JOB_ID',
      status: 'running',
      progress: 40,
      payload: { token: 'PRIVATE_PROVIDER_PAYLOAD' },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** 只保留管理路由依赖的内存记录；恢复 Mock 不创建任何模型请求。 */
function managementRuns(records: RunRecord[]) {
  const recover = vi.fn(async (id: string) => {
    const current = records.find((run) => run.id === id)!;
    return { ...current, status: 'queued' as const };
  });
  const service: RunService = {
    create: vi.fn(),
    get: vi.fn(async (id: string) => records.find((run) => run.id === id)),
    listByProject: vi.fn(async (projectId: string) =>
      records.filter((run) => run.projectId === projectId),
    ),
    recover,
    retry: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { service, recover };
}

describe('管理任务详情与视频获取', () => {
  it('本人和管理员读取原平台任务 ID 并恢复原任务，不回传快照或签名地址', async () => {
    const context = new TestAuthContext();
    const owner = await context.session({ email: 'video-owner@example.test' });
    const other = await context.session({ email: 'video-other@example.test' });
    const admin = await context.session({ email: 'video-admin@example.test', role: 'admin' });
    const projects = new MemoryProjectStore();
    const project = await projects.create({ name: '视频项目' }, { ownerId: owner.user.id });
    const record = videoRun(project.id, owner.user.id);
    const records = [record, videoRun(project.id, other.user.id, { id: 'run-conflict' })];
    const { service, recover } = managementRuns(records);
    const app = buildApp({
      logger: false,
      ...context.appOptions,
      projectStore: projects,
      runService: service,
    });
    const headers = { authorization: `Bearer ${owner.accessToken}` };
    const adminHeaders = { authorization: `Bearer ${admin.accessToken}` };
    try {
      const list = await app.inject({ method: 'GET', url: '/v1/account/runs', headers });
      expect(list.json().runs).toHaveLength(1);
      expect(list.json().runs[0]).toMatchObject({ id: record.id, recoverableVideo: true });
      expect(list.body).not.toContain('PRIVATE_PLATFORM_JOB_ID');
      for (const base of ['/v1/account/runs', '/v1/admin/runs']) {
        const authorizedHeaders = base.includes('/admin/') ? adminHeaders : headers;
        const detail = await app.inject({
          method: 'GET',
          url: `${base}/${record.id}`,
          headers: authorizedHeaders,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().run).toMatchObject({
          id: record.id,
          ownerId: owner.user.id,
          recoverableVideo: true,
          platformJobId: 'PRIVATE_PLATFORM_JOB_ID',
        });
        expect(detail.body).not.toMatch(
          /PRIVATE_FROZEN_PROMPT|PRIVATE_CREDENTIAL_ID|PRIVATE_PROVIDER_PAYLOAD|snapshot|providerJob|credential/,
        );
        const response = await app.inject({
          method: 'POST',
          url: `${base}/${record.id}/recover`,
          headers: authorizedHeaders,
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({
          accepted: true,
          run: { id: record.id, status: 'queued', recoverableVideo: false },
        });
        expect(response.body).not.toMatch(/PRIVATE_|snapshot|providerJob|credential/);
        expect(recover).toHaveBeenLastCalledWith(record.id, { retrieveOnly: true });
        for (const method of ['GET', 'POST'] as const) {
          expect(
            (
              await app.inject({
                method,
                url: `${base}/run-conflict${method === 'POST' ? '/recover' : ''}`,
                headers: authorizedHeaders,
              })
            ).statusCode,
          ).toBe(404);
        }
      }
      expect(recover).toHaveBeenCalledTimes(2);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.retry).not.toHaveBeenCalled();
      for (const method of ['GET', 'POST'] as const) {
        const suffix = method === 'POST' ? '/recover' : '';
        expect(
          (await app.inject({ method, url: `/v1/account/runs/${record.id}${suffix}` })).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              method,
              url: `/v1/account/runs/${record.id}${suffix}`,
              headers: { authorization: `Bearer ${other.accessToken}` },
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (await app.inject({ method, url: `/v1/admin/runs/${record.id}${suffix}`, headers }))
            .statusCode,
        ).toBe(403);
      }
      expect(
        (await context.store.listAudit()).filter(
          (event) => event.action === 'run.video.retrieve.request',
        ),
      ).toHaveLength(2);
      const resultRecord = videoRun(project.id, owner.user.id, {
        id: 'run-archived',
        status: 'succeeded',
        result: {
          summary: '视频已归档',
          targetNodeId: record.targetNodeId,
          mediaType: 'video',
          provider: 'newapi',
          inputCount: 0,
          asset: {
            assetId: 'result-asset',
            version: 1,
            contentUrl: 'https://private.example.test/?signature=PRIVATE_SIGNED_URL',
          },
          providerJob: record.providerJob,
        },
      });
      records.push(resultRecord);
      const result = await app.inject({
        method: 'GET',
        url: `/v1/account/runs/${resultRecord.id}`,
        headers,
      });
      expect(result.json().run).toMatchObject({
        platformJobId: 'PRIVATE_PLATFORM_JOB_ID',
        recoverableVideo: false,
        result: { asset: { assetId: 'result-asset' } },
      });
      expect(result.body).not.toMatch(/PRIVATE_SIGNED_URL|contentUrl|providerJob/);
    } finally {
      await app.close();
    }
  });

  it('取消中的任务、非视频、无平台 ID、已有结果和未知归属均不接受获取请求', async () => {
    const context = new TestAuthContext();
    const owner = await context.session({ email: 'eligibility-owner@example.test' });
    const projects = new MemoryProjectStore();
    const project = await projects.create({ name: '资格项目' }, { ownerId: owner.user.id });
    const original = videoRun(project.id, owner.user.id);
    const records = [
      videoRun(project.id, owner.user.id, { id: 'run-cancelled', status: 'cancelled' }),
      videoRun(project.id, owner.user.id, { id: 'run-cancelling', status: 'cancel_requested' }),
      videoRun(project.id, owner.user.id, { id: 'run-running', status: 'running' }),
      videoRun(project.id, owner.user.id, {
        id: 'run-no-platform',
        providerJob: { ...original.providerJob!, platformJobId: undefined },
      }),
      videoRun(project.id, owner.user.id, {
        id: 'run-blank-platform',
        providerJob: { ...original.providerJob!, platformJobId: '   ' },
      }),
      videoRun(project.id, owner.user.id, { id: 'run-no-job', providerJob: undefined }),
      videoRun(project.id, owner.user.id, { id: 'run-no-owner', userId: undefined }),
      videoRun(project.id, owner.user.id, { id: 'run-other-provider', provider: 'mock' }),
      videoRun(project.id, owner.user.id, {
        id: 'run-job-provider-mismatch',
        providerJob: { ...original.providerJob!, provider: 'mock' },
      }),
      videoRun(project.id, owner.user.id, {
        id: 'run-completed-without-resource',
        status: 'succeeded',
      }),
      videoRun(project.id, owner.user.id, {
        id: 'run-non-video',
        snapshot: {
          ...original.snapshot,
          nodes: original.snapshot.nodes.map((node) => ({
            ...node,
            data: { ...node.data, mediaType: 'text' as const },
          })),
        },
      }),
      videoRun(project.id, owner.user.id, {
        id: 'run-result',
        result: {
          summary: '已有结果',
          mediaType: 'video',
          provider: 'newapi',
          inputCount: 0,
          targetNodeId: original.targetNodeId,
          asset: { assetId: 'existing-asset' },
        },
      }),
    ];
    const { service, recover } = managementRuns(records);
    const app = buildApp({
      logger: false,
      ...context.appOptions,
      projectStore: projects,
      runService: service,
    });
    const headers = { authorization: `Bearer ${owner.accessToken}` };
    try {
      const list = await app.inject({ method: 'GET', url: '/v1/account/runs', headers });
      expect(
        list
          .json()
          .runs.filter((run: { recoverableVideo: boolean }) => run.recoverableVideo)
          .map((run: { id: string }) => run.id),
      ).toEqual(['run-cancelled']);
      for (const record of records.slice(1)) {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/account/runs/${record.id}/recover`,
          headers,
          payload: {},
        });
        expect(response.statusCode).toBe(409);
      }
      expect(recover).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/account/runs/run-cancelled/recover',
            headers,
          })
        ).statusCode,
      ).toBe(202);
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('拒绝参数或身份替换，并明确返回执行层冲突和后端不可用', async () => {
    const context = new TestAuthContext();
    const owner = await context.session({ email: 'reject-owner@example.test' });
    const projects = new MemoryProjectStore();
    const project = await projects.create({ name: '拒绝项目' }, { ownerId: owner.user.id });
    const original = videoRun(project.id, owner.user.id);
    const { service, recover } = managementRuns([original]);
    const app = buildApp({
      logger: false,
      ...context.appOptions,
      projectStore: projects,
      runService: service,
    });
    const headers = { authorization: `Bearer ${owner.accessToken}` };
    const url = `/v1/account/runs/${original.id}/recover`;
    try {
      for (const payload of [
        { retrieveOnly: false },
        { retrieveOnly: true },
        { snapshot: {} },
        { ownerId: owner.user.id },
        { parameters: { duration: 10 } },
        [],
      ]) {
        expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, 'content-type': 'application/json' },
            payload: 'null',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url: `${url}?ownerId=other`, headers })).statusCode,
      ).toBe(400);
      expect(recover).not.toHaveBeenCalled();
      recover.mockRejectedValueOnce(new ExecutionError('send_requires_review', '平台任务证据不足'));
      const conflict = await app.inject({ method: 'POST', url, headers });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ code: 'send_requires_review', error: '平台任务证据不足' });
      recover.mockRejectedValueOnce(new RunServiceError('invalid_state', '原任务仍在执行中'));
      expect((await app.inject({ method: 'POST', url, headers })).json().error).toBe(
        '原任务仍在执行中',
      );
      recover.mockRejectedValueOnce(
        new ExecutionError('authorization_revoked', '原执行授权已撤销'),
      );
      const revoked = await app.inject({ method: 'POST', url, headers });
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json()).toEqual({ code: 'authorization_revoked', error: '原执行授权已撤销' });
      for (const identity of [
        { id: 'other-run' },
        { userId: 'other-owner' },
        { projectId: 'other-project' },
        { targetNodeId: 'other-node' },
        { attempt: 2 },
      ]) {
        recover.mockResolvedValueOnce({ ...original, ...identity, status: 'queued' });
        const conflict = await app.inject({ method: 'POST', url, headers });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toEqual({ code: 'recovery_conflict', error: '恢复任务身份已变化' });
      }
      service.recover = undefined;
      expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
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

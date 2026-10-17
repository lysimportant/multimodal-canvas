import { describe, expect, it, vi } from 'vitest';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import type { AiCredential } from '@prisma/client';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { GlobalStoreAccount, normalizeGlobalStoreBaseUrl } from './globalstore-account';
import { NewApiAccountService } from './newapi-account-service';
import { NewApiAccountSettings, newApiRequestUser } from './newapi-account-settings';
import Fastify from 'fastify';
import { registerNewApiAccountRoutes } from './newapi-account-routes';
import { NewApiAccountError } from './newapi-account-client';
import type { AuthenticatedSession } from './auth-service';

function fixture() {
  const rows: AiCredential[] = [];
  const keyring = new CredentialEncryptionKeyring({
    currentSecret: 'globalstore-fixture-encryption-secret',
  });
  const prisma = {
    aiCredential: {
      create: vi.fn(async ({ data }: { data: Partial<AiCredential> }) => {
        const row = {
          id: `00000000-0000-4000-a000-${String(rows.length + 1).padStart(12, '0')}`,
          version: 1,
          projectId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as AiCredential;
        rows.unshift(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { ownerId: string; provider: string; projectId: null; id?: string };
        }) =>
          rows.find(
            (row) =>
              row.ownerId === where.ownerId &&
              row.provider === where.provider &&
              row.projectId === where.projectId &&
              (!where.id || row.id === where.id),
          ) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: { ownerId: string; provider: string; projectId: null } }) =>
          rows.filter(
            (row) =>
              row.ownerId === where.ownerId &&
              row.provider === where.provider &&
              row.projectId === where.projectId,
          ),
      ),
    },
    newApiIdentity: { findUnique: vi.fn(async () => null) },
  };
  const account = new GlobalStoreAccount(prisma as never, keyring);
  return { rows, keyring, prisma, account };
}

const input = {
  baseUrl: 'https://saas.globalstore.ai',
  apiKey: 'synthetic-globalstore-fixture-key',
  models: [{ id: 'seedream-5.0', mediaType: 'image' as const }],
};

describe('GlobalStore 本人模型登记', () => {
  it('HTTP入口要求本人会话，只返回安全目录，拒绝未支持的媒体类型', async () => {
    const f = fixture();
    const service = new NewApiAccountService({
      prisma: f.prisma,
      keyring: f.keyring,
      client: { options: { redirectUri: 'https://canvas.fixture.org/v1/auth/newapi/callback' } },
      webUrl: 'http://localhost:5173',
    } as never);
    const sessions = new WeakMap<object, AuthenticatedSession>();
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-synthetic-user'])
        sessions.set(request, {
          user: { id: String(request.headers['x-synthetic-user']) },
        } as AuthenticatedSession);
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof NewApiAccountError ? error.status : 500)
        .send({ error: error instanceof Error ? error.message : 'fixture request failed' }),
    );
    registerNewApiAccountRoutes(app, service, sessions);
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/account/globalstore/models',
            payload: input,
          })
        ).statusCode,
      ).toBe(401);
      expect(f.rows).toHaveLength(0);
      const saved = await app.inject({
        method: 'POST',
        url: '/v1/account/globalstore/models',
        headers: { 'x-synthetic-user': 'owner-1' },
        payload: input,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(input.apiKey);
      expect(saved.headers['cache-control']).toBe('no-store');
      const other = await app.inject({
        method: 'GET',
        url: '/v1/account/globalstore/models',
        headers: { 'x-synthetic-user': 'owner-2' },
      });
      expect(other.json()).toEqual({ models: [] });
      const unsupported = await app.inject({
        method: 'POST',
        url: '/v1/account/globalstore/models',
        headers: { 'x-synthetic-user': 'owner-1' },
        payload: { ...input, models: [{ id: 'unsupported', mediaType: 'audio' }] },
      });
      expect(unsupported.statusCode).toBe(400);
      expect(f.rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('加密保存并返回真实凭据目录；更新保留历史凭据且不返回密钥', async () => {
    const f = fixture();
    const first = await f.account.save('owner-1', {
      ...input,
      models: [...input.models, { id: 'wan3.0-Prime', mediaType: 'video' }],
    });
    const second = await f.account.save('owner-1', {
      ...input,
      apiKey: 'second-synthetic-fixture-key',
      models: [{ id: 'seedream-5.1', mediaType: 'image' }],
    });
    expect(first.credentialId).not.toBe(second.credentialId);
    expect(f.rows).toHaveLength(2);
    expect(f.keyring.decrypt(f.rows[1]!.encryptedApiKey).plaintext).toBe(input.apiKey);
    expect(f.rows[1]!.encryptedApiKey).not.toContain(input.apiKey);
    expect(await f.account.get('owner-1')).toMatchObject({
      credentialId: second.credentialId,
      baseUrl: 'https://saas.globalstore.ai/kyyReactApiServer/v2/model-center',
    });
    expect(await f.account.get('other-owner')).toEqual({ models: [] });
    expect(await f.account.credential('other-owner', first.credentialId)).toBeNull();
    expect(JSON.stringify(first)).not.toMatch(/apiKey|encryptedApiKey|fingerprint/i);
    expect(first.models[0]).toMatchObject({
      id: 'seedream-5.0',
      credentialId: first.credentialId,
      mediaTypes: ['image'],
      provider: 'globalstore',
      contract: 'globalstore-model-center-image-v2',
      available: true,
    });
    expect(first.models[1]).toMatchObject({
      id: 'wan3.0-Prime',
      mediaTypes: ['video'],
      provider: 'globalstore',
      contract: 'globalstore-model-center-video-v2',
    });

    const service = new NewApiAccountService({
      prisma: f.prisma,
      keyring: f.keyring,
      webUrl: 'http://localhost:5173',
    } as never);
    await expect(service.models('owner-1', 'image')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'seedream-5.0', credentialId: first.credentialId }),
        expect.objectContaining({ id: 'seedream-5.1', credentialId: second.credentialId }),
      ]),
    );
    await expect(service.models('owner-1', 'image', first.credentialId)).resolves.toEqual([
      expect.objectContaining({ credentialId: first.credentialId }),
    ]);
    await expect(service.models('owner-1', 'video', first.credentialId)).resolves.toEqual([
      expect.objectContaining({
        id: 'wan3.0-Prime',
        mediaTypes: ['video'],
        contract: 'globalstore-model-center-video-v2',
      }),
    ]);
    await expect(service.models('owner-2', 'image')).rejects.toMatchObject({
      code: 'authorization_revoked',
    });
  });

  it('旧 JSON 目录未记录媒体类型时仍按图片读取', async () => {
    const f = fixture();
    const saved = await f.account.save('owner-1', input);
    f.rows[0]!.modelCatalog = [{ id: 'legacy-image' }];

    await expect(f.account.get('owner-1')).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          id: 'legacy-image',
          mediaTypes: ['image'],
          contract: 'globalstore-model-center-image-v2',
        }),
      ],
    });
    expect(saved.credentialId).toBe(f.rows[0]!.id);
  });

  it.each([
    'http://saas.globalstore.ai',
    'https://127.0.0.1',
    'https://saas.globalstore.ai/v1',
    'https://user:pass@saas.globalstore.ai',
    'https://saas.globalstore.ai?api_key=synthetic',
  ])('拒绝无效基址 %s', (url) => {
    expect(() => normalizeGlobalStoreBaseUrl(url)).toThrow();
  });

  it('按本人冻结图片合同并拒绝版本、模型、媒体或归属不匹配', async () => {
    const f = fixture();
    const saved = await f.account.save('owner-1', input);
    const service = new NewApiAccountService({
      prisma: f.prisma,
      keyring: f.keyring,
      webUrl: 'http://localhost:5173',
    } as never);
    const validateGroup = vi
      .spyOn(service, 'validateGroup')
      .mockRejectedValue(new Error('not a New API credential'));
    const snapshot: RunSnapshot = {
      projectId: 'fixture-project',
      canvasRevision: 1,
      targetNodeId: 'image',
      modelAlias: 'seedream-5.0',
      parameters: {},
      submittedAt: new Date().toISOString(),
      nodeCredentialReferences: {
        image: { credentialId: saved.credentialId, credentialVersion: 1 },
      },
      nodes: [
        {
          id: 'image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    };
    const frozen = await service.freeze('owner-1', snapshot);
    expect(frozen.executionBindings?.image).toEqual({
      credentialId: saved.credentialId,
      credentialVersion: 1,
      modelAlias: 'seedream-5.0',
      mediaType: 'image',
      provider: 'globalstore',
      contract: 'globalstore-model-center-image-v2',
    });
    expect(validateGroup).not.toHaveBeenCalled();
    expect(JSON.stringify(frozen)).not.toContain(input.apiKey);
    await expect(
      service.freeze('owner-1', { ...snapshot, modelAlias: 'unknown-model' }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    await expect(
      service.freeze('owner-1', {
        ...snapshot,
        nodeCredentialReferences: {
          image: { credentialId: saved.credentialId, credentialVersion: 2 },
        },
      }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    await expect(service.freeze('other-owner', snapshot)).rejects.toThrow(
      'not a New API credential',
    );
    const settings = new NewApiAccountSettings(service);
    await expect(
      newApiRequestUser.run('owner-1', () => settings.getCredentialReference(saved.credentialId)),
    ).resolves.toEqual({ credentialId: saved.credentialId, credentialVersion: 1 });
  });

  it('按视频目录类型冻结视频合同并拒绝媒体类型不匹配', async () => {
    const f = fixture();
    const saved = await f.account.save('owner-1', {
      ...input,
      models: [{ id: 'wan3.0-Prime', mediaType: 'video' }],
    });
    const service = new NewApiAccountService({
      prisma: f.prisma,
      keyring: f.keyring,
      webUrl: 'http://localhost:5173',
    } as never);
    const snapshot: RunSnapshot = {
      projectId: 'fixture-project',
      canvasRevision: 1,
      targetNodeId: 'video',
      modelAlias: 'wan3.0-Prime',
      parameters: {},
      submittedAt: new Date().toISOString(),
      nodeCredentialReferences: {
        video: { credentialId: saved.credentialId, credentialVersion: 1 },
      },
      nodes: [
        {
          id: 'video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: { label: 'Video', mediaType: 'video', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    };

    await expect(service.freeze('owner-1', snapshot)).resolves.toMatchObject({
      executionBindings: {
        video: {
          credentialId: saved.credentialId,
          credentialVersion: 1,
          modelAlias: 'wan3.0-Prime',
          mediaType: 'video',
          provider: 'globalstore',
          contract: 'globalstore-model-center-video-v2',
        },
      },
    });
    await expect(
      service.freeze('owner-1', { ...snapshot, modelAlias: 'image-only' }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});

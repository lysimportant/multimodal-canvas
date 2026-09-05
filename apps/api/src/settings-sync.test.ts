import { randomUUID } from 'node:crypto';

import type { AiCredential, ModelCatalog } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import {
  AiCredentialNotFoundError,
  PrismaAiSettingsStore,
  type CredentialReference,
} from './settings';

/** 仅供内存数据库夹具加密合成凭据，不连接真实 Provider。 */
const encryptionSecret = 'settings-sync-synthetic-encryption-secret';

/** 模拟数据库返回副本和持久化写入，两个存储实例不共享任何进程缓存。 */
function createSettingsDatabase() {
  const credentials: AiCredential[] = [];
  const catalog: ModelCatalog[] = [];
  const overrides: Array<Record<string, unknown>> = [];
  /** 模拟数据库按提交时间排序，避免依赖测试执行毫秒数。 */
  let timestamp = Date.now();
  const aiCredential = {
    findFirst: vi.fn(async (query?: { where?: { id?: string; version?: number } }) => {
      const matching = credentials.filter(
        (row) =>
          (!query?.where?.id || row.id === query.where.id) &&
          (query?.where?.version === undefined || row.version === query.where.version),
      );
      const latest = matching.sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || right.version - left.version,
      )[0];
      return latest ? structuredClone(latest) : null;
    }),
    findMany: vi.fn(async () => structuredClone(credentials)),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const created = {
        ...data,
        id: randomUUID(),
        createdAt: new Date(++timestamp),
        updatedAt: new Date(timestamp),
        defaultModels: data.label === 'revoked' ? null : data.defaultModels,
      } as AiCredential;
      credentials.push(created);
      return structuredClone(created);
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<AiCredential> }) => {
        const row = credentials.find((credential) => credential.id === where.id);
        if (!row) throw new Error('synthetic credential not found');
        Object.assign(row, data);
        return structuredClone(row);
      },
    ),
  };
  const modelCatalog = {
    findMany: vi.fn(async (query?: { where?: { credentialId?: string } }) =>
      structuredClone(
        catalog.filter(
          (row) => !query?.where?.credentialId || row.credentialId === query.where.credentialId,
        ),
      ),
    ),
    deleteMany: vi.fn(async ({ where }: { where: { credentialId: string } }) => {
      for (let index = catalog.length - 1; index >= 0; index -= 1) {
        if (catalog[index]?.credentialId === where.credentialId) catalog.splice(index, 1);
      }
    }),
    createMany: vi.fn(async ({ data }: { data: ModelCatalog[] }) => {
      catalog.push(...structuredClone(data));
    }),
  };
  const transaction = {
    aiCredential,
    modelCatalog,
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ updatedAt: new Date(++timestamp) }]),
  };
  const prisma = {
    ...transaction,
    modelCapabilityOverride: { findMany: vi.fn(async () => structuredClone(overrides)) },
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ data: [{ id: 'synthetic-text-model', mediaType: 'text' }] }),
  );
  /** 使用相同数据库创建独立设置缓存，不启动服务器或后台同步任务。 */
  const createStore = () =>
    new PrismaAiSettingsStore(prisma as never, encryptionSecret, {
      fetchImpl,
      modelRequestMaxAttempts: 1,
    });
  return { prisma, credentials, catalog, overrides, fetchImpl, createStore };
}

/** 建立已预热的两个 API 设置实例；所有后续变更仅通过写实例落到共享存储。 */
async function warmSettingsInstances() {
  const database = createSettingsDatabase();
  const writer = database.createStore();
  await writer.update({ baseUrl: 'https://sync.example/v1', apiKey: 'synthetic-first-key' });
  const frozen = await writer.getCredentialReference();
  const reader = database.createStore();
  await expect(reader.getProviderCredentials()).resolves.toMatchObject({
    apiKey: 'synthetic-first-key',
  });
  return { ...database, writer, reader, frozen };
}

/** 创建可手动释放的异步屏障，兼容项目 ES2022 目标且不依赖定时等待。 */
function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY_ID', 'settings-sync');
  vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Prisma settings synchronization between running instances', () => {
  it.each([
    'get',
    'hasCredential',
    'getCredentialReference',
    'selectedReference',
    'getProviderCredentials',
    'listCredentials',
    'listModels',
    'testConnection',
    'refreshModels',
    'selectedRefresh',
  ])('observes a remote revocation on the next %s call', async (operation) => {
    const { writer, reader, frozen, fetchImpl } = await warmSettingsInstances();
    await writer.removeCredentials();

    switch (operation) {
      case 'get':
        await expect(reader.get()).resolves.toMatchObject({ configured: false, baseUrl: '' });
        break;
      case 'hasCredential':
        await expect(reader.hasCredential(frozen.credentialId!)).resolves.toBe(false);
        break;
      case 'getCredentialReference':
        await expect(reader.getCredentialReference()).resolves.toEqual({});
        break;
      case 'selectedReference':
        await expect(reader.getCredentialReference(frozen.credentialId)).rejects.toThrow(
          AiCredentialNotFoundError,
        );
        break;
      case 'getProviderCredentials':
        await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
        break;
      case 'listCredentials':
        await expect(reader.listCredentials()).resolves.toEqual([
          expect.objectContaining({ id: frozen.credentialId, active: false }),
        ]);
        break;
      case 'listModels':
        await expect(reader.listModels(undefined, frozen.credentialId)).rejects.toThrow(
          AiCredentialNotFoundError,
        );
        break;
      case 'testConnection':
        await expect(reader.testConnection()).resolves.toMatchObject({ ok: false });
        break;
      case 'refreshModels':
        await expect(reader.refreshModels()).rejects.toThrow('尚未配置');
        break;
      case 'selectedRefresh':
        await expect(reader.refreshModels(frozen.credentialId)).rejects.toThrow(
          AiCredentialNotFoundError,
        );
        break;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps exact frozen references readable after remote rotation and revocation', async () => {
    const { writer, reader, frozen } = await warmSettingsInstances();
    await writer.update({ apiKey: 'synthetic-second-key' });
    await expect(reader.getProviderCredentials()).resolves.toMatchObject({
      apiKey: 'synthetic-second-key',
    });
    const current = await reader.getCredentialReference();
    expect(current.credentialId).not.toBe(frozen.credentialId);
    await writer.removeCredentials();
    await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
    await expect(reader.getProviderCredentials(frozen)).resolves.toMatchObject({
      apiKey: 'synthetic-first-key',
    });
    await expect(reader.getProviderCredentials(current)).resolves.toMatchObject({
      apiKey: 'synthetic-second-key',
    });
    for (const invalid of [
      { credentialId: '' },
      { credentialVersion: 0 },
      { credentialId: frozen.credentialId },
      { credentialVersion: frozen.credentialVersion },
      { ...frozen, credentialVersion: frozen.credentialVersion! + 100 },
    ] satisfies CredentialReference[]) {
      await expect(reader.getProviderCredentials(invalid)).resolves.toBeUndefined();
    }
  });

  it('loads remote defaults before merging a partial update', async () => {
    const { writer, reader, frozen } = await warmSettingsInstances();
    await writer.update({ defaultModels: { text: 'remote-text' } });
    await expect(reader.resolveModel('text')).resolves.toBe('remote-text');
    await writer.update({ defaultModels: { video: 'remote-video' } });
    await reader.update({ defaultModels: { image: 'local-image' } });
    await expect(writer.get()).resolves.toMatchObject({
      defaultModels: {
        text: { modelAlias: 'remote-text' },
        video: { modelAlias: 'remote-video' },
        image: { modelAlias: 'local-image' },
      },
    });
    await expect(reader.getCredentialReference()).resolves.toEqual(frozen);
  });

  it('does not resurrect remotely revoked credentials when saving defaults', async () => {
    const { writer, reader, frozen } = await warmSettingsInstances();
    await writer.removeCredentials();
    await reader.update({ defaultModels: { text: 'saved-without-credential' } });
    await expect(writer.get()).resolves.toMatchObject({
      configured: false,
      defaultModels: { text: { modelAlias: 'saved-without-credential' } },
    });
    await expect(writer.getProviderCredentials()).resolves.toBeUndefined();
    await expect(reader.getCredentialReference()).resolves.toEqual({});
    await expect(reader.getProviderCredentials(frozen)).resolves.toMatchObject({
      apiKey: 'synthetic-first-key',
    });
  });

  it('fails closed during a database outage and recovers without restarting', async () => {
    const { writer, reader, prisma, fetchImpl } = await warmSettingsInstances();
    await writer.removeCredentials();
    const read = prisma.aiCredential.findFirst.getMockImplementation()!;
    prisma.aiCredential.findFirst.mockRejectedValue(new Error('synthetic database unavailable'));
    await expect(reader.getProviderCredentials()).rejects.toThrow('database unavailable');
    await expect(reader.testConnection()).rejects.toThrow('database unavailable');
    await expect(reader.update({ defaultModels: { text: 'must-not-save' } })).rejects.toThrow(
      'database unavailable',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    prisma.aiCredential.findFirst.mockImplementation(read);
    await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
    await writer.update({ baseUrl: 'https://sync.example/v1', apiKey: 'synthetic-recovered-key' });
    await expect(reader.getProviderCredentials()).resolves.toMatchObject({
      apiKey: 'synthetic-recovered-key',
    });
  });

  it('replaces remote catalogs and overrides, including deleted entries', async () => {
    const { writer, reader, frozen, catalog, overrides } = await warmSettingsInstances();
    await writer.refreshModels();
    overrides.push({
      credentialId: frozen.credentialId,
      modelAlias: 'synthetic-text-model',
      mediaType: 'TEXT',
      capabilities: { contextWindow: 4096 },
    });
    await expect(reader.listModels('text')).resolves.toEqual([
      expect.objectContaining({
        id: 'synthetic-text-model',
        capabilities: { contextWindow: 4096 },
      }),
    ]);
    overrides.length = 0;
    await expect(reader.listModels('text')).resolves.toEqual([
      expect.not.objectContaining({ capabilities: { contextWindow: 4096 } }),
    ]);
    catalog.length = 0;
    await expect(reader.listModels('text')).resolves.toEqual([]);
  });

  it('clears previously cached state if the database no longer has a credential row', async () => {
    const { reader, credentials } = await warmSettingsInstances();
    credentials.length = 0;
    await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
    await expect(reader.getCredentialReference()).resolves.toEqual({});
  });

  it('waits for a local write and never serves its uncommitted credentials', async () => {
    const { reader, prisma } = await warmSettingsInstances();
    const entered = createSignal();
    const release = createSignal();
    prisma.aiCredential.create.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic write failed');
    });
    const writing = reader.update({ apiKey: 'synthetic-uncommitted-key' });
    const failedWrite = expect(writing).rejects.toThrow('synthetic write failed');
    await entered.promise;
    const reading = reader.getProviderCredentials();
    const observed = vi.fn();
    void reading.then(observed);
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    release.resolve();
    await failedWrite;
    await expect(reading).resolves.toMatchObject({ apiKey: 'synthetic-first-key' });
  });

  it('keeps the latest persisted defaults when explicitly reactivating a historical key', async () => {
    const { writer, reader, frozen } = await warmSettingsInstances();
    await writer.update({ apiKey: 'synthetic-second-key' });
    await writer.update({ defaultModels: { text: 'remote-default' } });
    await expect(reader.activateCredential(frozen.credentialId!)).resolves.toMatchObject({
      defaultModels: { text: { modelAlias: 'remote-default' } },
    });
    const activated = await writer.getCredentialReference();
    expect(activated.credentialId).not.toBe(frozen.credentialId);
    await expect(writer.getProviderCredentials()).resolves.toMatchObject({
      apiKey: 'synthetic-first-key',
    });
  });

  it('does not serve a partial view after catalog loading fails', async () => {
    const { writer, reader, prisma } = await warmSettingsInstances();
    await writer.removeCredentials();
    prisma.modelCatalog.findMany.mockRejectedValueOnce(new Error('synthetic catalog unavailable'));
    await expect(reader.get()).rejects.toThrow('catalog unavailable');
    await expect(reader.get()).resolves.toMatchObject({ configured: false });
    await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
  });

  it('uses the higher version to resolve same-timestamp revocation ordering', async () => {
    const { writer, reader, prisma, credentials } = await warmSettingsInstances();
    await writer.removeCredentials();
    for (const credential of credentials) credential.updatedAt = new Date('2026-09-05T00:00:00Z');
    await expect(reader.getProviderCredentials()).resolves.toBeUndefined();
    expect(prisma.aiCredential.findFirst).toHaveBeenLastCalledWith({
      where: { projectId: null },
      orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
    });
  });

  it('does not resolve malformed frozen references to an otherwise configured active key', async () => {
    const { reader, frozen } = await warmSettingsInstances();
    for (const invalid of [
      { credentialId: '' },
      { credentialVersion: 0 },
      { credentialId: frozen.credentialId },
      { credentialVersion: frozen.credentialVersion },
      { ...frozen, credentialVersion: -1 },
      { ...frozen, credentialVersion: 1.5 },
    ] satisfies CredentialReference[]) {
      await expect(reader.getProviderCredentials(invalid)).resolves.toBeUndefined();
    }
  });

  it('propagates HTTP credential revocation to a second warmed API without exposing keys', async () => {
    const { writer, reader, frozen, fetchImpl } = await warmSettingsInstances();
    const firstApp = buildApp({ logger: false, settingsStore: writer });
    const secondApp = buildApp({ logger: false, settingsStore: reader });
    try {
      const before = await secondApp.inject({ method: 'GET', url: '/v1/settings/ai' });
      expect(before.statusCode).toBe(200);
      expect(before.json().settings.configured).toBe(true);
      const revoked = await firstApp.inject({
        method: 'DELETE',
        url: '/v1/settings/ai/credentials',
      });
      expect(revoked.statusCode).toBe(200);
      const after = await secondApp.inject({ method: 'GET', url: '/v1/settings/ai' });
      expect(after.statusCode).toBe(200);
      expect(after.json().settings.configured).toBe(false);
      const connection = await secondApp.inject({ method: 'POST', url: '/v1/settings/ai/test' });
      expect(connection.statusCode).toBe(200);
      expect(connection.json().result.ok).toBe(false);
      const refresh = await secondApp.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
        payload: { credentialId: frozen.credentialId },
      });
      expect(refresh.statusCode).toBe(404);
      expect(refresh.json().code).toBe('credential_not_found');
      expect(fetchImpl).not.toHaveBeenCalled();
      for (const response of [before, revoked, after, connection, refresh]) {
        expect(response.body).not.toContain('synthetic-first-key');
        expect(response.body).not.toContain(encryptionSecret);
        expect(response.body).not.toContain('encryptedApiKey');
      }
    } finally {
      await firstApp.close();
      await secondApp.close();
    }
  });
});

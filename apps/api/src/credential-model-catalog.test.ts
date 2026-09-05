import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';

import { buildApp } from './app';
import { hashPassword } from './auth-service';
import { MemoryAuthStore } from './auth-store';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';
import { AiSettingsStore, PrismaAiSettingsStore } from './settings';

const encryptionSecret = 'credential-model-catalog-test-secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

function modelsResponse(id: string, mediaType: 'text' | 'image' | 'video') {
  return new Response(JSON.stringify({ data: [{ id, mediaType }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type CredentialRow = {
  id: string;
  version: number;
  baseUrl: string;
  encryptedApiKey: string;
  keyFingerprint: string;
  defaultModels: unknown;
  updatedAt: Date;
};

type CatalogRow = {
  id?: string;
  credentialId: string | null;
  modelAlias: string;
  name: string;
  mediaType: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';
  capabilities: Record<string, unknown> | null;
  limitations: Record<string, unknown> | null;
  price: Record<string, unknown> | null;
  refreshedAt: Date;
};

function credentialRow(
  id: string,
  version: number,
  baseUrl: string,
  apiKey: string,
  updatedAt: string,
): CredentialRow {
  const seed = new AiSettingsStore(encryptionSecret);
  seed.update({ baseUrl, apiKey });
  const persisted = seed.getPersisted();
  return {
    id,
    version,
    baseUrl: persisted.baseUrl,
    encryptedApiKey: persisted.encryptedApiKey,
    keyFingerprint: persisted.keyFingerprint,
    defaultModels: null,
    updatedAt: new Date(updatedAt),
  };
}

function catalogRow(
  credentialId: string | null,
  modelAlias: string,
  mediaType: CatalogRow['mediaType'],
): CatalogRow {
  return {
    credentialId,
    modelAlias,
    name: modelAlias,
    mediaType,
    capabilities: null,
    limitations: null,
    price: null,
    refreshedAt: new Date('2026-08-28T01:00:00.000Z'),
  };
}

/** 构造目录持久化替身；事务复用同一存储，锁和数据库时间的真实行为另由 PostgreSQL 集成验收。 */
function createPrismaCatalogFixture(
  initialCredentials: CredentialRow[],
  initialCatalog: CatalogRow[],
) {
  const credentials = initialCredentials.map((row) => ({ ...row }));
  const catalog = initialCatalog.map((row) => ({ ...row }));
  /** 合成数据库时钟独立于应用 Date.now；写入时间仍不得早于现有最大时间加一毫秒。 */
  const databaseClockMs = new Date('2026-08-28T02:00:00.000Z').getTime();
  let credentialSequence = 0;
  let modelSequence = 0;

  const aiCredential = {
    findFirst: vi.fn(async (query?: { where?: { id?: string } }): Promise<CredentialRow | null> => {
      if (query?.where?.id) {
        return credentials.find((row) => row.id === query.where?.id) ?? null;
      }
      return (
        [...credentials].sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || right.version - left.version,
        )[0] ?? null
      );
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (!(data.updatedAt instanceof Date) || !Number.isFinite(data.updatedAt.getTime())) {
        throw new Error('Credential fixture requires the transaction database timestamp');
      }
      credentialSequence += 1;
      const created: CredentialRow = {
        id: `00000000-0000-4000-8000-${String(credentialSequence).padStart(12, '0')}`,
        version: data.version as number,
        baseUrl: data.baseUrl as string,
        encryptedApiKey: data.encryptedApiKey as string,
        keyFingerprint: data.keyFingerprint as string,
        defaultModels: data.defaultModels,
        updatedAt: new Date(data.updatedAt),
      };
      credentials.push(created);
      return created;
    }),
  };

  const modelCatalog = {
    findMany: vi.fn(async (query?: { where?: { credentialId?: string | null } }) => {
      const credentialId = query?.where?.credentialId;
      return catalog
        .filter((row) => credentialId === undefined || row.credentialId === credentialId)
        .map((row) => ({ ...row }));
    }),
    deleteMany: vi.fn(async ({ where }: { where: { credentialId: string | null } }) => {
      let count = 0;
      for (let index = catalog.length - 1; index >= 0; index -= 1) {
        if (catalog[index]?.credentialId === where.credentialId) {
          catalog.splice(index, 1);
          count += 1;
        }
      }
      return { count };
    }),
    createMany: vi.fn(async ({ data }: { data: Array<Omit<CatalogRow, 'id'>> }) => {
      for (const row of data) {
        modelSequence += 1;
        catalog.push({ ...row, id: `catalog-${modelSequence}` });
      }
      return { count: data.length };
    }),
  };

  const transaction = {
    aiCredential,
    modelCatalog,
    $executeRaw: vi.fn(async (query: TemplateStringsArray) => {
      expect(query.join('')).toBe('LOCK TABLE "ai_credentials" IN SHARE ROW EXCLUSIVE MODE');
      return 0;
    }),
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      expect(query.join('')).toContain('clock_timestamp()');
      expect(query.join('')).toContain('MAX("updatedAt")');
      return [
        {
          updatedAt: new Date(
            Math.max(databaseClockMs, ...credentials.map((row) => row.updatedAt.getTime() + 1)),
          ),
        },
      ];
    }),
  };
  const prisma = {
    aiCredential,
    modelCatalog,
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  };

  return { prisma, credentials, catalog, aiCredential, modelCatalog, transaction };
}

function threeMediaCanvas(): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_chat',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: 'Chat', mediaType: 'text', mode: 'generate' },
      },
      {
        id: 'node_image',
        type: 'image',
        position: { x: 240, y: 0 },
        data: { label: 'Image', mediaType: 'image', mode: 'generate' },
      },
      {
        id: 'node_video',
        type: 'video',
        position: { x: 480, y: 0 },
        data: { label: 'Video', mediaType: 'video', mode: 'generate' },
      },
    ],
    edges: [],
  };
}

describe('credential-scoped model catalogs', () => {
  it('deduplicates saves, isolates catalogs, and preserves each catalog on refresh failure', async () => {
    let failChatRefresh = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (authorization === 'Bearer chat-key') {
        if (failChatRefresh) throw new Error('chat catalog unavailable');
        return modelsResponse('shared-model', 'text');
      }
      if (authorization === 'Bearer image-key') return modelsResponse('shared-model', 'image');
      throw new Error('unexpected credential');
    });
    const store = new AiSettingsStore(encryptionSecret, {
      fetchImpl,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });

    store.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    const chatReference = store.getCredentialReference();
    store.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    expect(store.getCredentialReference()).toEqual(chatReference);
    expect(store.listCredentials()).toHaveLength(1);

    store.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const imageReference = store.getCredentialReference();
    await store.refreshModels(chatReference.credentialId);
    expect(store.getCredentialReference()).toEqual(imageReference);
    await store.refreshModels(imageReference.credentialId);

    expect(store.listModels('text', chatReference.credentialId)).toEqual([
      expect.objectContaining({
        id: 'shared-model',
        credentialId: chatReference.credentialId,
        mediaTypes: ['text'],
      }),
    ]);
    expect(store.listModels('image', imageReference.credentialId)).toEqual([
      expect.objectContaining({
        id: 'shared-model',
        credentialId: imageReference.credentialId,
        mediaTypes: ['image'],
      }),
    ]);
    expect(store.listModels('image', chatReference.credentialId)).toEqual([]);

    failChatRefresh = true;
    await expect(store.refreshModels(chatReference.credentialId)).rejects.toThrow(
      'chat catalog unavailable',
    );
    expect(store.listModels(undefined, chatReference.credentialId)).toEqual([
      expect.objectContaining({ id: 'shared-model', credentialId: chatReference.credentialId }),
    ]);
    expect(store.listModels(undefined, imageReference.credentialId)).toEqual([
      expect.objectContaining({ id: 'shared-model', credentialId: imageReference.credentialId }),
    ]);
  });

  it('persists a refresh only inside the selected Prisma credential scope', async () => {
    const activeSeed = new AiSettingsStore(encryptionSecret);
    activeSeed.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    const active = activeSeed.getPersisted();
    const imageSeed = new AiSettingsStore(encryptionSecret);
    imageSeed.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const image = imageSeed.getPersisted();
    const activeRow = {
      id: '123e4567-e89b-12d3-a456-426614174061',
      version: 4,
      ...active,
      defaultModels: null,
      updatedAt: new Date(active.updatedAt),
    };
    const imageRow = {
      id: '123e4567-e89b-12d3-a456-426614174062',
      version: 2,
      ...image,
      defaultModels: null,
      updatedAt: new Date(image.updatedAt),
    };
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = { modelCatalog: { deleteMany, createMany } };
    const prisma = {
      aiCredential: {
        findFirst: vi.fn(async (query?: { where?: { id?: string } }) =>
          query?.where?.id === imageRow.id ? imageRow : activeRow,
        ),
      },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(modelsResponse('image-v2', 'image'));
    const store = new PrismaAiSettingsStore(prisma as never, encryptionSecret, {
      fetchImpl,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });

    await expect(store.refreshModels(imageRow.id)).resolves.toEqual([
      expect.objectContaining({ id: 'image-v2', credentialId: imageRow.id }),
    ]);
    await expect(store.getCredentialReference()).resolves.toEqual({
      credentialId: activeRow.id,
      credentialVersion: activeRow.version,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://image.example.com/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer image-key' } }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { credentialId: imageRow.id } });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          credentialId: imageRow.id,
          modelAlias: 'image-v2',
          mediaType: 'IMAGE',
        }),
      ],
    });
  });

  it('persists a copied catalog for a new credential version and reloads it after restart', async () => {
    const active = credentialRow(
      '123e4567-e89b-12d3-a456-426614174071',
      4,
      'https://chat.example.com/v1',
      'chat-key',
      '2026-08-28T01:00:00.000Z',
    );
    const fixture = createPrismaCatalogFixture(
      [active],
      [catalogRow(active.id, 'chat-v1', 'TEXT')],
    );
    const store = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);

    await store.update({ defaultModels: { text: 'chat-v1' } });
    const nextReference = await store.getCredentialReference();

    expect(nextReference.credentialId).not.toBe(active.id);
    expect(fixture.transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.transaction.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(fixture.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.aiCredential.create.mock.invocationCallOrder[0]!,
    );
    const databaseTimestamp = (await fixture.transaction.$queryRaw.mock.results[0]!.value)[0]!
      .updatedAt;
    expect(
      fixture.credentials.find((row) => row.id === nextReference.credentialId)?.updatedAt,
    ).toEqual(databaseTimestamp);
    expect(fixture.catalog).toContainEqual(
      expect.objectContaining({ credentialId: nextReference.credentialId, modelAlias: 'chat-v1' }),
    );

    const reloaded = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);
    await expect(reloaded.listModels('text', nextReference.credentialId)).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-v1',
        credentialId: nextReference.credentialId,
        mediaTypes: ['text'],
      }),
    ]);
  });

  it('persists the historical catalog when activating a credential and reloads the new version', async () => {
    const historical = credentialRow(
      '123e4567-e89b-12d3-a456-426614174072',
      2,
      'https://image.example.com/v1',
      'image-key',
      '2026-08-28T00:30:00.000Z',
    );
    const active = credentialRow(
      '123e4567-e89b-12d3-a456-426614174073',
      5,
      'https://chat.example.com/v1',
      'chat-key',
      '2026-08-28T01:00:00.000Z',
    );
    const fixture = createPrismaCatalogFixture(
      [historical, active],
      [catalogRow(historical.id, 'image-v1', 'IMAGE')],
    );
    const store = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);

    await store.activateCredential(historical.id);
    const nextReference = await store.getCredentialReference();
    expect(fixture.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      fixture.credentials.find((row) => row.id === nextReference.credentialId)?.updatedAt.getTime(),
    ).toBeGreaterThan(active.updatedAt.getTime());
    const reloaded = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);

    await expect(reloaded.listModels('image', nextReference.credentialId)).resolves.toEqual([
      expect.objectContaining({
        id: 'image-v1',
        credentialId: nextReference.credentialId,
        mediaTypes: ['image'],
      }),
    ]);
  });

  it('serializes a model refresh with a settings write so the new version copies fresh models', async () => {
    const active = credentialRow(
      '123e4567-e89b-12d3-a456-426614174074',
      3,
      'https://chat.example.com/v1',
      'chat-key',
      '2026-08-28T01:00:00.000Z',
    );
    const fixture = createPrismaCatalogFixture(
      [active],
      [catalogRow(active.id, 'chat-old', 'TEXT')],
    );
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await refreshGate;
      return modelsResponse('chat-fresh', 'text');
    });
    const store = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret, {
      fetchImpl,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });

    const refresh = store.refreshModels(active.id);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const update = store.update({ defaultModels: { text: 'chat-fresh' } });
    await Promise.resolve();
    expect(fixture.aiCredential.create).not.toHaveBeenCalled();
    expect(fixture.transaction.$executeRaw).not.toHaveBeenCalled();
    expect(fixture.transaction.$queryRaw).not.toHaveBeenCalled();

    releaseRefresh?.();
    await refresh;
    await update;
    const nextReference = await store.getCredentialReference();
    expect(fixture.transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.$queryRaw).toHaveBeenCalledTimes(1);

    expect(
      fixture.catalog.filter((row) => row.credentialId === nextReference.credentialId),
    ).toEqual([expect.objectContaining({ modelAlias: 'chat-fresh', mediaType: 'TEXT' })]);
  });

  it('consumes a legacy null catalog once and persists it under the active credential', async () => {
    const active = credentialRow(
      '123e4567-e89b-12d3-a456-426614174075',
      1,
      'https://chat.example.com/v1',
      'chat-key',
      '2026-08-28T01:00:00.000Z',
    );
    const fixture = createPrismaCatalogFixture([active], [catalogRow(null, 'legacy-chat', 'TEXT')]);
    const store = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);

    await expect(store.listModels('text')).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-chat',
        credentialId: active.id,
        mediaTypes: ['text'],
      }),
    ]);
    expect(fixture.catalog).toEqual([
      expect.objectContaining({ credentialId: active.id, modelAlias: 'legacy-chat' }),
    ]);

    const reloaded = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);
    await expect(reloaded.listModels('text')).resolves.toHaveLength(1);
  });

  it('discards legacy null rows when an active credential already has a scoped catalog', async () => {
    const active = credentialRow(
      '123e4567-e89b-12d3-a456-426614174076',
      2,
      'https://chat.example.com/v1',
      'chat-key',
      '2026-08-28T01:00:00.000Z',
    );
    const fixture = createPrismaCatalogFixture(
      [active],
      [catalogRow(active.id, 'chat-current', 'TEXT'), catalogRow(null, 'chat-legacy', 'TEXT')],
    );
    const store = new PrismaAiSettingsStore(fixture.prisma as never, encryptionSecret);

    await expect(store.listModels('text')).resolves.toEqual([
      expect.objectContaining({ id: 'chat-current', credentialId: active.id }),
    ]);
    expect(fixture.catalog).toEqual([
      expect.objectContaining({ credentialId: active.id, modelAlias: 'chat-current' }),
    ]);
  });
});

describe('credential-scoped HTTP contracts', () => {
  it('refreshes and lists models by credential without changing the active credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (authorization === 'Bearer chat-key') return modelsResponse('chat-v1', 'text');
      if (authorization === 'Bearer image-key') return modelsResponse('image-v1', 'image');
      throw new Error('unexpected credential');
    });
    const store = new AiSettingsStore(encryptionSecret, {
      fetchImpl,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    const chat = store.getCredentialReference();
    store.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const image = store.getCredentialReference();
    const app = buildApp({ logger: false, settingsStore: store });
    try {
      const chatRefresh = await app.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
        payload: { credentialId: chat.credentialId },
      });
      const activeRefresh = await app.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
      });
      const chatModels = await app.inject({
        method: 'GET',
        url: `/v1/models?credentialId=${chat.credentialId}&mediaType=text`,
      });
      const imageModels = await app.inject({
        method: 'GET',
        url: `/v1/models?credentialId=${image.credentialId}&mediaType=image`,
      });

      expect(chatRefresh.statusCode).toBe(200);
      expect(activeRefresh.statusCode).toBe(200);
      expect(chatModels.json().models).toEqual([
        expect.objectContaining({ id: 'chat-v1', credentialId: chat.credentialId }),
      ]);
      expect(imageModels.json().models).toEqual([
        expect.objectContaining({ id: 'image-v1', credentialId: image.credentialId }),
      ]);
      expect(store.getCredentialReference()).toEqual(image);

      const missing = await app.inject({
        method: 'GET',
        url: '/v1/models?credentialId=123e4567-e89b-12d3-a456-426614174099',
      });
      const invalidRefresh = await app.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
        payload: { credentialId: 'not-a-uuid' },
      });
      expect(missing.statusCode).toBe(404);
      expect(invalidRefresh.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('freezes the selected chat, image, or video credential into a run snapshot', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const store = new AiSettingsStore(encryptionSecret);
    store.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    const chat = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'chat-v1',
          name: 'Chat v1',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      chat.credentialId,
    );
    store.update({ baseUrl: 'https://video.example.com/v1', apiKey: 'video-key' });
    const video = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'video-v1',
          name: 'Video v1',
          mediaTypes: ['video'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      video.credentialId,
    );
    store.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const image = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'image-v1',
          name: 'Image v1',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      image.credentialId,
    );

    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi' });
    const app = buildApp({ logger: false, projectStore, settingsStore: store, runService });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Credential runs' },
      });
      const projectId = created.json().project.id as string;
      const saved = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: threeMediaCanvas(),
      });
      expect(saved.statusCode).toBe(200);

      const cases = [
        { nodeId: 'node_chat', modelAlias: 'chat-v1', reference: chat },
        { nodeId: 'node_image', modelAlias: 'image-v1', reference: image },
        { nodeId: 'node_video', modelAlias: 'video-v1', reference: video },
      ];
      for (const item of cases) {
        const submitted = await app.inject({
          method: 'POST',
          url: `/v1/nodes/${item.nodeId}/runs`,
          payload: {
            projectId,
            modelAlias: item.modelAlias,
            credentialId: item.reference.credentialId,
          },
        });
        expect(submitted.statusCode).toBe(202);
        const publicRun = submitted.json().run;
        expect(publicRun).toMatchObject({
          modelAlias: item.modelAlias,
          snapshot: { canvasRevision: 1, inputs: [] },
        });
        expect(publicRun.snapshot.inputCount).toBe(0);
        const internalRun = await runService.get(publicRun.id);
        expect(internalRun).toBeDefined();
        expect(internalRun!.snapshot).toMatchObject({
          credentialId: item.reference.credentialId,
          credentialVersion: item.reference.credentialVersion,
          modelAlias: item.modelAlias,
        });
      }

      const wrongCredential = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_image/runs',
        payload: {
          projectId,
          modelAlias: 'image-v1',
          credentialId: chat.credentialId,
        },
      });
      expect(wrongCredential.statusCode).toBe(400);
      expect(wrongCredential.json()).toMatchObject({ code: 'model_unavailable' });

      const activeFallback = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_image/runs',
        payload: { projectId, modelAlias: 'image-v1' },
      });
      expect(activeFallback.statusCode).toBe(202);
      const activePublicRun = activeFallback.json().run;
      expect(activePublicRun.snapshot).toEqual({ canvasRevision: 1, inputCount: 0, inputs: [] });
      const activeInternalRun = await runService.get(activePublicRun.id);
      expect(activeInternalRun).toBeDefined();
      expect(activeInternalRun!.snapshot).toMatchObject({
        credentialId: image.credentialId,
        credentialVersion: image.credentialVersion,
      });
    } finally {
      await app.close();
    }
  });

  it('freezes a different credential for every provider-backed node in one DAG run', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'newapi');
    const store = new AiSettingsStore(encryptionSecret);
    store.update({ baseUrl: 'https://chat.example.com/v1', apiKey: 'chat-key' });
    const chat = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'chat-v1',
          name: 'Chat v1',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      chat.credentialId,
    );
    store.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const image = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'image-v1',
          name: 'Image v1',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      image.credentialId,
    );
    store.update({ baseUrl: 'https://video.example.com/v1', apiKey: 'video-key' });
    const video = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'video-v1',
          name: 'Video v1',
          mediaTypes: ['video'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      video.credentialId,
    );

    const canvas: CanvasDocument = {
      revision: 0,
      nodes: [
        {
          id: 'node_chat',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: 'Chat',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'chat-v1',
            credentialId: chat.credentialId,
          },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 240, y: 0 },
          data: {
            label: 'Image',
            mediaType: 'image',
            mode: 'generate',
            modelAlias: 'image-v1',
            credentialId: image.credentialId,
          },
        },
        {
          id: 'node_video',
          type: 'video',
          position: { x: 480, y: 0 },
          data: {
            label: 'Video',
            mediaType: 'video',
            mode: 'generate',
            modelAlias: 'video-v1',
            credentialId: video.credentialId,
          },
        },
      ],
      edges: [
        {
          id: 'edge_chat_image',
          sourceNodeId: 'node_chat',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
        {
          id: 'edge_image_video',
          sourceNodeId: 'node_image',
          sourceHandle: 'output:image',
          targetNodeId: 'node_video',
          targetHandle: 'input:firstFrame',
          order: 0,
        },
      ],
    };
    const projectStore = new MemoryProjectStore();
    const runService = new MemoryRunService({ providerName: 'newapi' });
    const app = buildApp({ logger: false, projectStore, settingsStore: store, runService });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Multi-key DAG' },
      });
      const projectId = created.json().project.id as string;
      const saved = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: canvas,
      });
      expect(saved.statusCode).toBe(200);

      const submitted = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_video/runs',
        payload: { projectId },
      });

      expect(submitted.statusCode).toBe(202);
      const publicRun = submitted.json().run;
      expect(publicRun).toMatchObject({
        modelAlias: 'video-v1',
        snapshot: { canvasRevision: 1, inputCount: 1, inputs: [null] },
      });
      const internalRun = await runService.get(publicRun.id);
      expect(internalRun).toBeDefined();
      expect(internalRun!.snapshot).toMatchObject({
        modelAlias: 'video-v1',
        credentialId: video.credentialId,
        credentialVersion: video.credentialVersion,
        nodeCredentialReferences: {
          node_chat: chat,
          node_image: image,
          node_video: video,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('lets a regular project user run with a configured credential without managing its secret', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'credential-run-auth-secret');
    vi.stubEnv('WORKER_PROVIDER', 'newapi');

    const settingsStore = new AiSettingsStore(encryptionSecret);
    settingsStore.update({ baseUrl: 'https://image.example.com/v1', apiKey: 'image-key' });
    const credential = settingsStore.getCredentialReference();
    settingsStore.replaceModels(
      [
        {
          id: 'image-v1',
          name: 'Image v1',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.credentialId,
    );

    const authStore = new MemoryAuthStore();
    await authStore.createUser({
      email: 'creator@example.com',
      passwordHash: await hashPassword('correct password'),
      role: 'user',
    });
    const runService = new MemoryRunService({ providerName: 'newapi' });
    const app = buildApp({ logger: false, authStore, settingsStore, runService });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'creator@example.com', password: 'correct password' },
      });
      const authorization = `Bearer ${login.json().accessToken as string}`;
      const created = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization },
        payload: { name: 'Regular user credential run' },
      });
      const projectId = created.json().project.id as string;
      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        headers: { authorization },
        payload: {
          revision: 0,
          nodes: [threeMediaCanvas().nodes[1]],
          edges: [],
        },
      });

      const submitted = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_image/runs',
        headers: { authorization },
        payload: {
          projectId,
          modelAlias: 'image-v1',
          credentialId: credential.credentialId,
        },
      });

      expect(submitted.statusCode).toBe(202);
      const publicRun = submitted.json().run;
      expect(publicRun).toMatchObject({
        modelAlias: 'image-v1',
        snapshot: { canvasRevision: 1, inputCount: 0, inputs: [] },
      });
      const internalRun = await runService.get(publicRun.id);
      expect(internalRun).toBeDefined();
      expect(internalRun!.snapshot).toMatchObject({
        credentialId: credential.credentialId,
        credentialVersion: credential.credentialVersion,
        modelAlias: 'image-v1',
      });
    } finally {
      await app.close();
    }
  });
});

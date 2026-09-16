import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  AiCredentialNotFoundError,
  AiSettingsStore,
  normalizeModelsPayload,
  PrismaAiSettingsStore,
} from './settings';

/** 生成历史单密钥 AES-GCM 载荷，覆盖未记录 encryptionKeyId 的旧快照迁移。 */
function legacyCiphertext(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

/** 为单位测试的 Prisma 替身提供事务锁与数据库时间接口；真实锁由集成测试验证。 */
function mockSettingsSql() {
  return {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ updatedAt: new Date() }]),
  };
}

/** 将简化存储替身包装为与 Prisma 相同的交互事务调用形状。 */
function withSettingsTransaction(client: object) {
  return {
    ...client,
    $transaction: vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({ ...client, ...mockSettingsSql() }),
    ),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Prisma AI settings encryption', () => {
  it('requires a stable encryption secret instead of generating one at runtime', () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY', '');

    expect(() => new PrismaAiSettingsStore({} as never)).toThrow(
      'AI_CREDENTIAL_ENCRYPTION_KEY is required',
    );
  });

  it('writes a key-id with newly persisted credentials without exposing the encryption secret', async () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY_ID', 'current-2026');
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: '123e4567-e89b-12d3-a456-426614174099',
      updatedAt: new Date('2026-09-05T00:00:00.000Z'),
    }));
    const prisma = {
      aiCredential: { findFirst: vi.fn().mockResolvedValue(null), create },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const store = new PrismaAiSettingsStore(
      withSettingsTransaction(prisma) as never,
      'current-encryption-secret',
    );

    await store.update({ baseUrl: 'https://rotation.example/v1', apiKey: 'provider-secret' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ encryptionKeyId: 'current-2026' }),
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain('provider-secret');
  });

  it('rehydrates a legacy Prisma credential through the configured historical key and persists current key-id', async () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY_ID', 'current-2026');
    vi.stubEnv(
      'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      JSON.stringify({ retired: 'retired-encryption-secret' }),
    );
    const legacy = new AiSettingsStore('retired-encryption-secret');
    legacy.update({ baseUrl: 'https://legacy.example/v1', apiKey: 'legacy-provider-key' });
    const persisted = legacy.getPersisted();
    persisted.encryptedApiKey = legacyCiphertext(
      'legacy-provider-key',
      'retired-encryption-secret',
    );
    delete persisted.encryptionKeyId;
    const update = vi.fn(async () => undefined);
    const credential = {
      id: '123e4567-e89b-12d3-a456-426614174098',
      version: 1,
      baseUrl: persisted.baseUrl,
      encryptedApiKey: persisted.encryptedApiKey,
      encryptionKeyId: null,
      keyFingerprint: persisted.keyFingerprint,
      defaultModels: null,
      updatedAt: new Date('2026-09-05T00:00:00.000Z'),
    };
    const prisma = {
      aiCredential: { findFirst: vi.fn().mockResolvedValue(credential), update },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'current-encryption-secret');

    await store.get();

    await expect(
      store.getProviderCredentials({ credentialId: credential.id, credentialVersion: 1 }),
    ).resolves.toEqual({
      baseUrl: credential.baseUrl,
      apiKey: 'legacy-provider-key',
    });
    expect(update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: credential.id,
        version: 1,
        encryptedApiKey: persisted.encryptedApiKey,
        encryptionKeyId: null,
        updatedAt: credential.updatedAt,
      }),
      data: expect.objectContaining({
        encryptionKeyId: 'current-2026',
        updatedAt: credential.updatedAt,
      }),
    });
    expect(JSON.stringify(update.mock.calls)).not.toContain('legacy-provider-key');
  });
});

describe('New API model catalog normalization', () => {
  it('Prisma 超时扩展兼容旧默认模型，保存及恢复后可重新加载', async () => {
    /** 模拟数据库当前行及单行设置更新，不涉及真实凭据。 */
    let row = {
      id: '123e4567-e89b-12d3-a456-426614174077',
      version: 1,
      baseUrl: '',
      encryptedApiKey: '',
      keyFingerprint: '',
      encryptionKeyId: null,
      defaultModels: { text: 'legacy-text' } as Record<string, unknown>,
      updatedAt: new Date(),
    };
    const update = vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
      row = { ...row, ...data };
      return row;
    });
    const prisma = withSettingsTransaction({
      aiCredential: { findFirst: vi.fn(async () => row), update, create: update },
      modelCatalog: { findMany: vi.fn(async () => []) },
    });
    const store = new PrismaAiSettingsStore(prisma as never, 'synthetic-timeout-secret');
    expect((await store.get()).timeoutMs).toBe(900_000);
    await store.update({ timeoutMs: 1_800_000 });
    expect(row.defaultModels).toEqual({
      text: { modelAlias: 'legacy-text' },
      __timeoutMs: 1_800_000,
    });
    const reopened = new PrismaAiSettingsStore(prisma as never, 'synthetic-timeout-secret');
    expect(await reopened.get()).toMatchObject({
      timeoutMs: 1_800_000,
      defaultModels: { text: { modelAlias: 'legacy-text' } },
    });
    await reopened.update({ timeoutMs: 900_000 });
    expect(row.defaultModels).toEqual({ text: { modelAlias: 'legacy-text' } });
    expect((await store.get()).timeoutMs).toBe(900_000);
    await reopened.update({ timeoutMs: 1_800_000 });
    await reopened.removeCredentials();
    expect((await store.get()).timeoutMs).toBe(1_800_000);
  });

  it('uses a longer provider timeout by default and validates custom values', () => {
    const store = new AiSettingsStore('provider-timeout-test');

    expect(store.get().timeoutMs).toBe(900_000);
    expect(store.update({ timeoutMs: 1_200_000 }).timeoutMs).toBe(1_200_000);
    expect(() => store.update({ timeoutMs: 999 })).toThrow('Provider timeout');
    expect(() => store.update({ timeoutMs: 2_147_483_648 })).toThrow('Provider timeout');
    const previous = store.get();
    expect(() =>
      store.update({ baseUrl: 'https://should-not-change.example', timeoutMs: 0 }),
    ).toThrow('Provider timeout');
    expect(store.get()).toEqual(previous);
  });

  it('does not bootstrap model aliases from environment variables', () => {
    vi.stubEnv('NEW_API_TEXT_MODEL', ' text-model ');

    const store = new AiSettingsStore('test-encryption-secret');

    expect(store.get().defaultModels).toEqual({});
  });

  it('accepts gateway model aliases and merges duplicate capability records', () => {
    const models = normalizeModelsPayload({
      data: [
        {
          id: ' omni-1 ',
          name: 'Omni 1',
          media_type: 'image-generation',
          limits: { maxWidth: 2048 },
          pricing: { perRun: '0.01', currency: 'USD' },
        },
        {
          id: 'omni-1',
          modalities: ['text', 'audio'],
          capabilities: { streaming: true },
        },
        { id: 'text-only', type: 'chat' },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models.find((model) => model.id === 'omni-1')).toMatchObject({
      name: 'Omni 1',
      mediaTypes: ['image', 'text', 'audio'],
      capabilities: { streaming: true },
      limitations: { maxWidth: 2048 },
      price: { perRun: '0.01', currency: 'USD' },
    });
    expect(models.find((model) => model.id === 'text-only')?.mediaTypes).toEqual(['text']);
  });

  it('supports raw arrays and ignores malformed model records', () => {
    expect(
      normalizeModelsPayload([
        null,
        { id: '', type: 'image' },
        { id: 'img-1', supportedMediaTypes: ['image', 'video'] },
      ]),
    ).toMatchObject([{ id: 'img-1', mediaTypes: ['image', 'video'] }]);
    expect(normalizeModelsPayload({ data: 'not-an-array' })).toEqual([]);
  });

  it('infers gpt-image-2 as an image model from the real New API model shape', () => {
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-image-2',
          object: 'model',
          created: 1_756_000_000,
          owned_by: 'newapi',
          supported_endpoint_types: ['images'],
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'gpt-image-2',
      name: 'gpt-image-2',
      mediaTypes: ['image'],
    });
  });

  it('infers video aliases when gateways omit explicit media capabilities', () => {
    const models = normalizeModelsPayload({
      data: [
        { id: 'grok-imagine-video-1.5', object: 'model' },
        { id: 'minimax_h3-768p', object: 'model' },
        { id: 'minimax_h3（按次）', object: 'model' },
      ],
    });

    expect(models.map((model) => [model.id, model.mediaTypes])).toEqual([
      ['grok-imagine-video-1.5', ['video']],
      ['minimax_h3-768p', ['video']],
      ['minimax_h3（按次）', ['video']],
    ]);
  });

  it('保留视频模型 ID 中的完整按次后缀', () => {
    const modelId = 'grok-imagine-video-1.5（按次）';
    const models = normalizeModelsPayload({
      data: [{ id: modelId, object: 'model' }],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: modelId,
        name: modelId,
        mediaTypes: ['video'],
      }),
    ]);
  });

  it('补齐明确 GPT-5.6 文本模型缺失或仅 low 的推理强度', () => {
    const models = normalizeModelsPayload({
      data: [
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6' },
        { id: 'gpt-5.6-codex' },
        {
          id: 'gpt-5.6-terra',
          capabilities: { reasoning_effort: ['low'], streaming: true },
        },
        {
          id: 'gpt-5.6-luna',
          type: 'text',
          capabilities: { contextWindow: 256_000 },
        },
      ],
    });
    const expected = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

    expect(models).toHaveLength(5);
    expect(models.map((model) => model.capabilities?.reasoning_effort)).toEqual([
      expected,
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(models[3]?.capabilities).toMatchObject({ streaming: true });
    expect(models[4]?.capabilities).toMatchObject({ contextWindow: 256_000 });
  });

  it('保留完整或非 GPT 模型的显式推理强度声明', () => {
    const explicit = ['none', 'low', 'medium', 'high'];
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-5.6-sol',
          capabilities: { reasoning_effort: explicit },
        },
        {
          id: 'gpt-4o',
          capabilities: { reasoning_effort: ['low'] },
        },
        {
          id: 'gpt-5.6-terra',
          media_type: 'image',
          capabilities: { reasoning_effort: ['low'] },
        },
      ],
    });

    expect(models[0]?.capabilities?.reasoning_effort).toBe(explicit);
    expect(models[1]?.capabilities?.reasoning_effort).toEqual(['low']);
    expect(models[2]?.capabilities?.reasoning_effort).toEqual(['low']);
  });

  it('在内存模型目录替换和重复记录合并时继续保留 GPT-5.6 的完整档位', () => {
    const expected = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-5.6-sol',
          capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high'] },
        },
        {
          id: 'gpt-5.6-sol',
          capabilities: { reasoning_effort: ['low'] },
        },
      ],
    });
    const store = new AiSettingsStore('test-encryption-secret');
    store.replaceModels([
      {
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        mediaTypes: ['text'],
        capabilities: { reasoning_effort: ['low'] },
        refreshedAt: '2026-08-26T00:00:00.000Z',
      },
    ]);

    expect(models[0]?.capabilities?.reasoning_effort).toEqual(['none', 'low', 'medium', 'high']);
    expect(store.listModels('text')[0]?.capabilities?.reasoning_effort).toEqual(expected);
  });

  it('applies media-specific capability overrides to filtered and unfiltered models', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.replaceModels([
      {
        id: 'image-v1',
        name: 'Image v1',
        mediaTypes: ['image'],
        capabilities: { base64: true },
        refreshedAt: '2026-08-26T00:00:00.000Z',
      },
    ]);
    store.replaceCapabilityOverrides([
      { modelAlias: 'image-v1', mediaType: 'image', capabilities: { maxSize: '2048x2048' } },
    ]);

    expect(store.listModels('image')[0]?.capabilities).toEqual({
      base64: true,
      maxSize: '2048x2048',
    });
    // 工作区节点编辑器请求不带 mediaType 的完整目录；覆盖必须同样可见，
    // 否则“目录显式声明”的能力会被客户端误判为未声明。
    expect(store.listModels()[0]?.capabilities).toEqual({
      base64: true,
      maxSize: '2048x2048',
    });
  });

  it('applies every declared media override when the catalog is requested unfiltered', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.replaceModels([
      {
        id: 'multi-media',
        name: 'Multi media',
        mediaTypes: ['image', 'video'],
        refreshedAt: '2026-08-26T00:00:00.000Z',
      },
    ]);
    store.replaceCapabilityOverrides([
      { modelAlias: 'multi-media', mediaType: 'image', capabilities: { imageEdit: true } },
      { modelAlias: 'multi-media', mediaType: 'video', capabilities: { resolutions: ['720p'] } },
    ]);

    expect(store.listModels()[0]?.capabilities).toEqual({
      imageEdit: true,
      resolutions: ['720p'],
    });
  });

  it('isolates capability overrides for same-named models across credentials', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.replaceModels(
      [
        {
          id: 'shared-model',
          name: 'Shared model',
          mediaTypes: ['image'],
          capabilities: { base: true },
          credentialId: 'credential-a',
          refreshedAt: '2026-08-26T00:00:00.000Z',
        },
        {
          id: 'shared-model',
          name: 'Shared model',
          mediaTypes: ['image'],
          capabilities: { base: true },
          credentialId: 'credential-b',
          refreshedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      'credential-a',
    );
    store.replaceModels(
      [
        {
          id: 'shared-model',
          name: 'Shared model',
          mediaTypes: ['image'],
          capabilities: { base: true },
          credentialId: 'credential-b',
          refreshedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      'credential-b',
    );
    store.replaceCapabilityOverrides([
      {
        credentialId: 'credential-a',
        modelAlias: 'shared-model',
        mediaType: 'image',
        capabilities: { maxSize: '2048x2048' },
      },
      {
        credentialId: 'credential-b',
        modelAlias: 'shared-model',
        mediaType: 'image',
        capabilities: { maxSize: '4096x4096' },
      },
    ]);

    expect(store.listModels('image', 'credential-a')[0]?.capabilities).toEqual({
      base: true,
      maxSize: '2048x2048',
    });
    expect(store.listModels('image', 'credential-b')[0]?.capabilities).toEqual({
      base: true,
      maxSize: '4096x4096',
    });
  });

  it('keeps legacy null-credential overrides readable as a fallback', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.replaceModels([
      {
        id: 'legacy-model',
        name: 'Legacy model',
        mediaTypes: ['image'],
        credentialId: 'credential-a',
        refreshedAt: '2026-08-26T00:00:00.000Z',
      },
    ]);
    store.replaceCapabilityOverrides([
      {
        credentialId: null,
        modelAlias: 'legacy-model',
        mediaType: 'image',
        capabilities: { legacy: true },
      },
    ]);

    expect(store.listModels('image', 'credential-a')[0]?.capabilities).toEqual({ legacy: true });
  });

  it('hydrates capability overrides from the PostgreSQL store when available', async () => {
    const prisma = {
      aiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      modelCatalog: {
        findMany: vi.fn().mockResolvedValue([
          {
            credentialId: null,
            modelAlias: 'image-v1',
            name: 'Image v1',
            mediaType: 'IMAGE',
            capabilities: { base64: true },
            limitations: null,
            price: null,
            refreshedAt: new Date('2026-08-26T00:00:00.000Z'),
          },
        ]),
      },
      modelCapabilityOverride: {
        findMany: vi.fn().mockResolvedValue([
          {
            modelAlias: 'image-v1',
            mediaType: 'IMAGE',
            capabilities: { maxSize: '2048x2048' },
          },
        ]),
      },
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await expect(store.listModels('image')).resolves.toMatchObject([
      { id: 'image-v1', capabilities: { base64: true, maxSize: '2048x2048' } },
    ]);
  });

  it('hydrates same-named capability overrides in separate credential scopes', async () => {
    const seedA = new AiSettingsStore('test-encryption-secret');
    seedA.update({ baseUrl: 'https://a.example.com/v1', apiKey: 'synthetic-key-a' });
    const persistedA = seedA.getPersisted();
    const seedB = new AiSettingsStore('test-encryption-secret');
    seedB.update({ baseUrl: 'https://b.example.com/v1', apiKey: 'synthetic-key-b' });
    const persistedB = seedB.getPersisted();
    const credentialA = {
      id: '123e4567-e89b-12d3-a456-426614174081',
      version: 1,
      ...persistedA,
      defaultModels: null,
      updatedAt: new Date('2026-08-26T00:00:00.000Z'),
    };
    const credentialB = {
      id: '123e4567-e89b-12d3-a456-426614174082',
      version: 1,
      ...persistedB,
      defaultModels: null,
      updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const prisma = {
      aiCredential: {
        findFirst: vi.fn(async (query?: { where?: { id?: string } }) =>
          query?.where?.id === credentialA.id ? credentialA : credentialB,
        ),
      },
      modelCatalog: {
        findMany: vi.fn().mockResolvedValue([
          {
            credentialId: credentialA.id,
            modelAlias: 'shared-model',
            name: 'Shared model',
            mediaType: 'IMAGE',
            capabilities: { base: true },
            limitations: null,
            price: null,
            refreshedAt: new Date('2026-08-26T00:00:00.000Z'),
          },
          {
            credentialId: credentialB.id,
            modelAlias: 'shared-model',
            name: 'Shared model',
            mediaType: 'IMAGE',
            capabilities: { base: true },
            limitations: null,
            price: null,
            refreshedAt: new Date('2026-08-26T00:00:00.000Z'),
          },
        ]),
      },
      modelCapabilityOverride: {
        findMany: vi.fn().mockResolvedValue([
          {
            credentialId: credentialA.id,
            modelAlias: 'shared-model',
            mediaType: 'IMAGE',
            capabilities: { maxSize: '2048x2048' },
          },
          {
            credentialId: credentialB.id,
            modelAlias: 'shared-model',
            mediaType: 'IMAGE',
            capabilities: { maxSize: '4096x4096' },
          },
        ]),
      },
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await expect(store.listModels('image', credentialA.id)).resolves.toEqual([
      expect.objectContaining({
        id: 'shared-model',
        credentialId: credentialA.id,
        capabilities: { base: true, maxSize: '2048x2048' },
      }),
    ]);
    await expect(store.listModels('image', credentialB.id)).resolves.toEqual([
      expect.objectContaining({
        id: 'shared-model',
        credentialId: credentialB.id,
        capabilities: { base: true, maxSize: '4096x4096' },
      }),
    ]);
  });

  it('keeps a previous catalog when a refresh request fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ id: 'text-v1', type: 'text' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new AiSettingsStore('test-encryption-secret', {
      fetchImpl,
      modelRequestTimeoutMs: 100,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'test-key' });
    await expect(store.refreshModels()).resolves.toMatchObject([{ id: 'text-v1' }]);

    fetchImpl.mockRejectedValue(new Error('upstream unavailable'));
    await expect(store.refreshModels()).rejects.toThrow('upstream unavailable');
    expect(store.listModels()).toMatchObject([{ id: 'text-v1' }]);
  });

  it('adds /v1 when a user enters only the gateway origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'text-v1', type: 'text' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new AiSettingsStore('test-encryption-secret', {
      fetchImpl,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://gateway.example.com', apiKey: 'test-key' });

    await expect(store.refreshModels()).resolves.toMatchObject([{ id: 'text-v1' }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/models',
      expect.objectContaining({
        headers: { authorization: 'Bearer test-key' },
        redirect: 'error',
      }),
    );
  });

  it('retries a connection test up to ten attempts and succeeds on the last one', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      fetchImpl.mockRejectedValueOnce(new Error(`temporary failure ${attempt + 1}`));
    }
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: 'gpt-image-2', supported_endpoint_types: ['images'] }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const store = new AiSettingsStore('test-encryption-secret', {
      fetchImpl,
      modelRequestMaxAttempts: 20,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'test-key' });

    await expect(store.testConnection()).resolves.toEqual({ ok: true, modelCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('stops after ten failed model requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('upstream unavailable'));
    const onTestConnectionError = vi.fn();
    const store = new AiSettingsStore('test-encryption-secret', {
      fetchImpl,
      onTestConnectionError,
      modelRequestMaxAttempts: 50,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'test-key' });

    await expect(store.testConnection()).resolves.toEqual({
      ok: false,
      error: '连接失败',
    });
    expect(onTestConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'upstream unavailable' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('does not expose sensitive upstream connection errors to the client', async () => {
    const upstreamError = new Error(
      'Request failed for https://gateway.example.test/v1/models?api_key=server-key: ' +
        'Authorization: Bearer server-key; response body: internal provider details',
    );
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(upstreamError);
    const onTestConnectionError = vi.fn();
    const store = new AiSettingsStore('test-encryption-secret', {
      fetchImpl,
      onTestConnectionError,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://gateway.example.test/v1', apiKey: 'server-key' });

    const result = await store.testConnection();

    expect(result).toEqual({ ok: false, error: '连接失败' });
    expect(JSON.stringify(result)).not.toContain('gateway.example.test');
    expect(JSON.stringify(result)).not.toContain('server-key');
    expect(JSON.stringify(result)).not.toContain('internal provider details');
    expect(onTestConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('gateway.example.test') }),
    );
    expect(onTestConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.not.stringContaining('server-key') }),
    );
  });

  it('rejects an oversized model catalog response before parsing it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'text-v1', type: 'text' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '1024' },
      }),
    );
    const store = new AiSettingsStore('response-limit-test', {
      fetchImpl,
      modelRequestMaxResponseBytes: 128,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'synthetic-key' });

    await expect(store.refreshModels()).rejects.toThrow('模型服务响应超出大小限制');
    expect(store.listModels()).toEqual([]);
  });

  it('enforces the model catalog response limit while streaming', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'text-v1', type: 'text' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const store = new AiSettingsStore('stream-response-limit-test', {
      fetchImpl,
      modelRequestMaxResponseBytes: 8,
      modelRequestMaxAttempts: 1,
      modelRequestRetryDelayMs: 0,
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'synthetic-key' });

    await expect(store.refreshModels()).rejects.toThrow('模型服务响应超出大小限制');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps immutable credential versions for queued run snapshots', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ baseUrl: 'https://one.example.com/v1', apiKey: 'key-one' });
    const firstReference = store.getCredentialReference();
    expect(firstReference.credentialId).toBeTruthy();
    expect(firstReference.credentialVersion).toBe(1);

    store.update({ baseUrl: 'https://two.example.com/v1', apiKey: 'key-two' });
    const secondReference = store.getCredentialReference();
    expect(secondReference.credentialVersion).toBe(2);
    expect(store.getProviderCredentials(firstReference)).toEqual({
      baseUrl: 'https://one.example.com/v1',
      apiKey: 'key-one',
    });
    expect(store.getProviderCredentials(secondReference)).toEqual({
      baseUrl: 'https://two.example.com/v1',
      apiKey: 'key-two',
    });
  });

  it('deduplicates identical credentials and activates an immutable historical credential', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ baseUrl: 'https://one.example.com/v1', apiKey: 'key-one' });
    const firstReference = store.getCredentialReference();
    const firstCredential = store.listCredentials()[0];

    store.update({ baseUrl: 'https://one.example.com/v1', apiKey: 'key-one' });
    expect(store.getCredentialReference()).toEqual(firstReference);
    expect(store.listCredentials()).toHaveLength(1);

    store.update({ baseUrl: 'https://two.example.com/v1', apiKey: 'key-two' });
    const secondReference = store.getCredentialReference();
    expect(store.listCredentials()).toHaveLength(2);
    expect(store.listCredentials().find((credential) => credential.active)?.baseUrl).toBe(
      'https://two.example.com/v1',
    );

    expect(store.activateCredential(firstCredential!.id)).toMatchObject({
      baseUrl: 'https://one.example.com/v1',
      configured: true,
      keyFingerprint: firstCredential!.keyFingerprint,
    });
    expect(store.listCredentials()).toHaveLength(2);
    expect(store.listCredentials().find((credential) => credential.active)?.baseUrl).toBe(
      'https://one.example.com/v1',
    );
    expect(JSON.stringify(store.listCredentials())).not.toContain('key-one');
    expect(store.getProviderCredentials(firstReference)).toEqual({
      baseUrl: 'https://one.example.com/v1',
      apiKey: 'key-one',
    });
    expect(store.getProviderCredentials(secondReference)).toEqual({
      baseUrl: 'https://two.example.com/v1',
      apiKey: 'key-two',
    });
  });

  it('删除指定内存 Key 后不再列出或刷新，同名新保存不能恢复旧 ID', async () => {
    const store = new AiSettingsStore('synthetic-test-secret');
    store.update({ baseUrl: 'https://delete.example.test/v1', apiKey: 'synthetic-deleted-key' });
    const reference = store.getCredentialReference();
    store.update({ baseUrl: 'https://keep.example.test/v1', apiKey: 'synthetic-kept-key' });
    expect(store.removeCredential(reference.credentialId!)).toMatchObject({ configured: true });
    expect(store.listCredentials()).toHaveLength(1);
    expect(store.activateCredential(reference.credentialId!)).toBeUndefined();
    expect(() => store.listModels(undefined, reference.credentialId!)).toThrow(
      AiCredentialNotFoundError,
    );
    await expect(store.refreshModels(reference.credentialId!)).rejects.toThrow(
      AiCredentialNotFoundError,
    );
    expect(store.getProviderCredentials(reference)).toEqual({
      baseUrl: 'https://delete.example.test/v1',
      apiKey: 'synthetic-deleted-key',
    });
    store.update({ baseUrl: 'https://delete.example.test/v1', apiKey: 'synthetic-deleted-key' });
    expect(store.hasCredential(reference.credentialId!)).toBe(false);
  });

  it('revokes the active credential without breaking historical snapshots', () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ baseUrl: 'https://queued.example.com/v1', apiKey: 'queued-key' });
    const snapshotReference = store.getCredentialReference();

    expect(store.removeCredentials()).toMatchObject({ configured: false, baseUrl: '' });
    expect(store.hasCredential(snapshotReference.credentialId!)).toBe(false);
    expect(() => store.getCredentialReference(snapshotReference.credentialId)).toThrow(
      AiCredentialNotFoundError,
    );
    expect(store.getProviderCredentials()).toBeUndefined();
    expect(store.getProviderCredentials(snapshotReference)).toEqual({
      baseUrl: 'https://queued.example.com/v1',
      apiKey: 'queued-key',
    });
  });

  it('appends a revoked Prisma version instead of deleting historical rows', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: '123e4567-e89b-12d3-a456-426614174013',
      version: 1,
      baseUrl: '',
      encryptedApiKey: '',
      keyFingerprint: '',
      defaultModels: null,
      updatedAt: new Date('2026-08-26T00:00:00.000Z'),
    });
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'synthetic-revoked',
    }));
    const deleteMany = vi.fn();
    const prisma = {
      aiCredential: { findFirst, create, deleteMany },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({ aiCredential: { findFirst, create }, ...mockSettingsSql() }),
      ),
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await store.removeCredentials();

    expect(deleteMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: {
        projectId: null,
        ownerId: null,
        version: 2,
        baseUrl: '',
        encryptedApiKey: '',
        encryptionKeyId: null,
        keyFingerprint: '',
        defaultModels: Prisma.JsonNull,
        label: 'revoked',
        updatedAt: expect.any(Date),
      },
    });
    await expect(store.hasCredential('123e4567-e89b-12d3-a456-426614174013')).resolves.toBe(false);
    await expect(
      store.getCredentialReference('123e4567-e89b-12d3-a456-426614174013'),
    ).rejects.toThrow(AiCredentialNotFoundError);
  });

  it('rolls back in-memory credentials when Prisma persistence fails', async () => {
    const create = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const prisma = {
      aiCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const store = new PrismaAiSettingsStore(
      withSettingsTransaction(prisma) as never,
      'test-encryption-secret',
    );

    await expect(
      store.update({ baseUrl: 'https://gateway.example.com/v1', apiKey: 'temporary-key' }),
    ).rejects.toThrow('database unavailable');
    await expect(store.get()).resolves.toMatchObject({
      baseUrl: '',
      configured: false,
      defaultModels: {},
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not append a Prisma version when the saved connection is unchanged', async () => {
    const seed = new AiSettingsStore('test-encryption-secret');
    seed.update({ baseUrl: 'https://same.example.com/v1', apiKey: 'same-key' });
    const persisted = seed.getPersisted();
    const activeRow = {
      id: '123e4567-e89b-12d3-a456-426614174041',
      version: 6,
      baseUrl: persisted.baseUrl,
      encryptedApiKey: persisted.encryptedApiKey,
      keyFingerprint: persisted.keyFingerprint,
      defaultModels: null,
      updatedAt: new Date('2026-08-27T06:00:00.000Z'),
    };
    const findFirst = vi.fn().mockResolvedValue(activeRow);
    const create = vi.fn();
    const prisma = {
      aiCredential: { findFirst, create },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await expect(
      store.update({ baseUrl: activeRow.baseUrl, apiKey: 'same-key' }),
    ).resolves.toMatchObject({
      baseUrl: activeRow.baseUrl,
      keyFingerprint: activeRow.keyFingerprint,
    });
    expect(create).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('lists Prisma credential history by unique connection and marks the active row', async () => {
    const seed = new AiSettingsStore('test-encryption-secret');
    seed.update({ baseUrl: 'https://active.example.com/v1', apiKey: 'active-key' });
    const active = seed.getPersisted();
    const activeId = '123e4567-e89b-12d3-a456-426614174021';
    const rows = [
      {
        id: activeId,
        version: 3,
        baseUrl: active.baseUrl,
        encryptedApiKey: active.encryptedApiKey,
        keyFingerprint: active.keyFingerprint,
        defaultModels: null,
        updatedAt: new Date('2026-08-27T03:00:00.000Z'),
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174020',
        version: 2,
        baseUrl: active.baseUrl,
        encryptedApiKey: active.encryptedApiKey,
        keyFingerprint: active.keyFingerprint,
        defaultModels: null,
        updatedAt: new Date('2026-08-27T02:00:00.000Z'),
      },
    ];
    const prisma = {
      aiCredential: {
        findFirst: vi.fn().mockResolvedValue(rows[0]),
        findMany: vi.fn().mockResolvedValue(rows),
      },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await expect(store.listCredentials()).resolves.toEqual([
      {
        id: activeId,
        baseUrl: 'https://active.example.com/v1',
        keyFingerprint: active.keyFingerprint,
        updatedAt: '2026-08-27T03:00:00.000Z',
        active: true,
      },
    ]);
  });

  it('activates a Prisma credential by appending a new immutable version', async () => {
    const activeSeed = new AiSettingsStore('test-encryption-secret');
    activeSeed.update({ baseUrl: 'https://active.example.com/v1', apiKey: 'active-key' });
    const active = activeSeed.getPersisted();
    const historicalSeed = new AiSettingsStore('test-encryption-secret');
    historicalSeed.update({ baseUrl: 'https://history.example.com/v1', apiKey: 'history-key' });
    const historical = historicalSeed.getPersisted();
    const activeRow = {
      id: '123e4567-e89b-12d3-a456-426614174031',
      version: 4,
      baseUrl: active.baseUrl,
      encryptedApiKey: active.encryptedApiKey,
      keyFingerprint: active.keyFingerprint,
      defaultModels: { text: { modelAlias: 'text-model' } },
      updatedAt: new Date('2026-08-27T04:00:00.000Z'),
    };
    const historicalRow = {
      id: '123e4567-e89b-12d3-a456-426614174030',
      version: 2,
      baseUrl: historical.baseUrl,
      encryptedApiKey: historical.encryptedApiKey,
      keyFingerprint: historical.keyFingerprint,
      defaultModels: null,
      updatedAt: new Date('2026-08-27T02:00:00.000Z'),
    };
    const createdId = '123e4567-e89b-12d3-a456-426614174032';
    /** 模拟已提交的当前行，让每次读穿缓存都得到实际持久化结果。 */
    let latestRow: Record<string, unknown> = activeRow;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      latestRow = {
        ...data,
        id: createdId,
        version: data.version as number,
        updatedAt: new Date('2026-08-27T05:00:00.000Z'),
      };
      return latestRow;
    });
    const modelCatalog = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    };
    const transaction = {
      aiCredential: { create, findFirst: vi.fn(async () => latestRow) },
      modelCatalog,
      ...mockSettingsSql(),
    };
    const prisma = {
      aiCredential: {
        findFirst: vi.fn(async (query?: { where?: { id?: string } }) =>
          query?.where?.id === historicalRow.id ? historicalRow : latestRow,
        ),
        create,
      },
      modelCatalog,
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
    };
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

    await expect(store.activateCredential(historicalRow.id)).resolves.toMatchObject({
      baseUrl: historicalRow.baseUrl,
      keyFingerprint: historicalRow.keyFingerprint,
      defaultModels: { text: { modelAlias: 'text-model' } },
    });
    await expect(store.getCredentialReference()).resolves.toEqual({
      credentialId: createdId,
      credentialVersion: 5,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        baseUrl: historicalRow.baseUrl,
        keyFingerprint: historicalRow.keyFingerprint,
        version: 5,
        defaultModels: { text: { modelAlias: 'text-model' } },
      },
    });
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain('history-key');
  });
});

/** 合成设置行：只保存测试用密文，不包含真实 Key。 */
type SyntheticCredentialRow = {
  id: string;
  projectId: string | null;
  ownerId: string | null;
  label: string;
  baseUrl: string;
  encryptedApiKey: string;
  encryptionKeyId: string | null;
  keyFingerprint: string;
  version: number;
  defaultModels: unknown;
  updatedAt: Date;
};

/**
 * 覆盖设置存储实际查询形状的内存替身：按 where 过滤，按 updatedAt/version 排序。
 * 它用于验证独立凭据行不参与“最新行即活动连接”的选择，不连接真实数据库。
 */
function createSyntheticSettingsDatabase() {
  const rows: SyntheticCredentialRow[] = [];
  let clock = Date.parse('2026-09-05T00:00:00.000Z');
  type Query = {
    where?: Record<string, unknown>;
    orderBy?: Array<Record<string, 'asc' | 'desc'>>;
  };
  const matches = (row: SyntheticCredentialRow, where: Record<string, unknown> = {}) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
    if (where.baseUrl !== undefined && row.baseUrl !== where.baseUrl) return false;
    if (where.keyFingerprint !== undefined && row.keyFingerprint !== where.keyFingerprint)
      return false;
    if (where.version !== undefined && row.version !== where.version) return false;
    const labelFilter = where.label as { not?: string; notIn?: string[] } | undefined;
    if (labelFilter?.not !== undefined && row.label === labelFilter.not) return false;
    if (labelFilter?.notIn?.includes(row.label)) return false;
    return true;
  };
  const sortValue = (row: SyntheticCredentialRow, field: string) =>
    field === 'updatedAt' ? row.updatedAt.getTime() : row.version;
  const select = (query?: Query) =>
    [...rows.filter((row) => matches(row, query?.where))]
      .sort((left, right) => {
        for (const clause of query?.orderBy ?? []) {
          const [field, direction] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
          const difference = sortValue(right, field) - sortValue(left, field);
          if (difference !== 0) return direction === 'desc' ? difference : -difference;
        }
        return 0;
      })
      .map((row) => structuredClone(row));
  const findFirst = vi.fn(async (query?: Query) => select(query)[0] ?? null);
  const findMany = vi.fn(async (query?: Query) => select(query));
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const stored =
      data.defaultModels === Prisma.JsonNull || data.defaultModels === Prisma.DbNull
        ? null
        : (data.defaultModels ?? null);
    const row: SyntheticCredentialRow = {
      id: randomUUID(),
      projectId: null,
      ownerId: null,
      label: 'default',
      baseUrl: '',
      encryptedApiKey: '',
      encryptionKeyId: null,
      keyFingerprint: '',
      version: 1,
      ...(data as Partial<SyntheticCredentialRow>),
      defaultModels: stored,
      updatedAt: (data.updatedAt as Date | undefined) ?? new Date(++clock),
    };
    rows.push(row);
    return structuredClone(row);
  });
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((entry) => entry.id === where.id);
      if (!row) throw new Error('synthetic credential row not found');
      Object.assign(row, data);
      return structuredClone(row);
    },
  );
  const transaction = {
    aiCredential: { findFirst, findMany, create, update },
    modelCatalog: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ updatedAt: new Date(++clock) }]),
  };
  const prisma = {
    ...transaction,
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  };
  return { prisma, rows };
}

describe('独立凭据与按凭据类型默认模型', () => {
  it('新增独立内存凭据不改变活动连接，并可按 ID 使用自己的目录', async () => {
    const refreshedAt = new Date().toISOString();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: 'independent-image', mediaType: 'image' }] }),
    );
    const store = new AiSettingsStore('independent-memory-secret', {
      fetchImpl,
      modelRequestMaxAttempts: 1,
    });
    store.update({
      baseUrl: 'https://active.example.test/v1',
      apiKey: 'synthetic-active-key',
      defaultModels: { text: 'active-text' },
    });
    const activeReference = store.getCredentialReference();
    const activeView = store.get();
    store.replaceModels(
      [
        {
          id: 'active-text',
          name: 'Active text',
          mediaTypes: ['text'],
          refreshedAt,
        },
      ],
      activeReference.credentialId,
    );

    const created = store.update({
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    });
    const { createdCredentialId, ...unchangedView } = created;

    expect(createdCredentialId).toBeTruthy();
    expect(unchangedView).toEqual(activeView);
    expect(store.getCredentialReference()).toEqual(activeReference);
    expect(store.get()).toEqual(activeView);

    const credentials = store.listCredentials();
    expect(credentials).toHaveLength(2);
    const independent = credentials.find((entry) => entry.id === createdCredentialId);
    expect(independent).toMatchObject({
      baseUrl: 'https://independent.example.test/v1',
      active: false,
    });
    // 没有配置过的凭据不生成推断默认值。
    expect(independent?.defaultModels).toBeUndefined();
    expect(credentials.find((entry) => entry.active)?.id).toBe(activeReference.credentialId);

    const independentReference = store.getCredentialReference(createdCredentialId!);
    expect(store.hasCredential(createdCredentialId!)).toBe(true);
    expect(store.listModels(undefined, createdCredentialId)).toEqual([]);

    await store.refreshModels(createdCredentialId!);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer synthetic-independent-key' },
    });
    expect(store.listModels('image', createdCredentialId).map((model) => model.id)).toEqual([
      'independent-image',
    ]);
    expect(store.listModels('image', activeReference.credentialId)).toEqual([]);
    expect(store.get()).toEqual(activeView);
    expect(store.getProviderCredentials(independentReference)).toEqual({
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
    });
  });

  it('相同地址与 Key 重复保存复用同一独立凭据 ID', () => {
    const store = new AiSettingsStore('independent-dedupe-secret');
    store.update({ baseUrl: 'https://active.example.test/v1', apiKey: 'synthetic-active-key' });
    const input = {
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    };

    const first = store.update(input).createdCredentialId;
    const second = store.update(input).createdCredentialId;

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(store.listCredentials()).toHaveLength(2);
    expect(store.update({ apiKey: 'synthetic-later-key' }).createdCredentialId).toBeUndefined();
  });

  it('按凭据读写类型默认模型，未知 ID 返回 undefined 且不混合另一凭据', () => {
    const store = new AiSettingsStore('credential-defaults-secret');
    store.update({ baseUrl: 'https://active.example.test/v1', apiKey: 'synthetic-active-key' });
    const activeId = store.getCredentialReference().credentialId!;
    const independentId = store.update({
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    }).createdCredentialId!;

    expect(
      store.updateCredentialDefaults(independentId, {
        image: { modelAlias: 'shared-image', credentialId: independentId },
        text: 'independent-text',
      }),
    ).toBeDefined();

    expect(
      store.listCredentials().find((entry) => entry.id === independentId)?.defaultModels,
    ).toEqual({
      image: { modelAlias: 'shared-image', credentialId: independentId },
      text: { modelAlias: 'independent-text' },
    });
    // 全局默认模型不因独立凭据的默认值改变。
    expect(store.get().defaultModels).toEqual({});

    expect(
      store.updateCredentialDefaults(activeId, {
        image: { modelAlias: 'shared-image', credentialId: activeId },
      }),
    ).toBeDefined();
    expect(store.get().defaultModels).toEqual({
      image: { modelAlias: 'shared-image', credentialId: activeId },
    });
    expect(store.listCredentials().find((entry) => entry.id === activeId)?.defaultModels).toEqual({
      image: { modelAlias: 'shared-image', credentialId: activeId },
    });

    // 同名模型在两个凭据中保持各自的归属，互不覆盖。
    expect(
      store.listCredentials().find((entry) => entry.id === independentId)?.defaultModels?.image,
    ).toEqual({ modelAlias: 'shared-image', credentialId: independentId });

    expect(store.updateCredentialDefaults(independentId, { text: null })).toBeDefined();
    expect(
      store.listCredentials().find((entry) => entry.id === independentId)?.defaultModels,
    ).toEqual({ image: { modelAlias: 'shared-image', credentialId: independentId } });

    expect(
      store.updateCredentialDefaults('123e4567-e89b-12d3-a456-426614174099', { text: 'missing' }),
    ).toBeUndefined();
  });

  it('删除被默认模型引用的 Key 后保持失效状态，不回退到另一个 Key', () => {
    const store = new AiSettingsStore('credential-delete-secret');
    store.update({ baseUrl: 'https://deleted.example.test/v1', apiKey: 'synthetic-deleted-key' });
    const deletedId = store.getCredentialReference().credentialId!;
    store.updateCredentialDefaults(deletedId, {
      image: { modelAlias: 'deleted-image', credentialId: deletedId },
    });
    const keptId = store.update({
      baseUrl: 'https://kept.example.test/v1',
      apiKey: 'synthetic-kept-key',
      activate: false,
    }).createdCredentialId!;

    const removed = store.removeCredential(deletedId);

    expect(removed).toMatchObject({
      configured: false,
      baseUrl: '',
      // 默认值保持指向已删除的 ID，不静默改写为另一个 Key。
      defaultModels: { image: { modelAlias: 'deleted-image', credentialId: deletedId } },
    });
    expect(removed?.keyFingerprint).toBeUndefined();
    expect(store.listCredentials()).toEqual([
      expect.objectContaining({ id: keptId, active: false }),
    ]);
    expect(store.hasCredential(deletedId)).toBe(false);
    expect(store.hasCredential(keptId)).toBe(false);
    expect(() => store.listModels(undefined, deletedId)).toThrow(AiCredentialNotFoundError);
    expect(store.activateCredential(deletedId)).toBeUndefined();
    expect(store.updateCredentialDefaults(deletedId, { text: 'deleted-text' })).toBeUndefined();
    expect(store.getProviderCredentials()).toBeUndefined();
  });

  it('Prisma 独立凭据以非活动行持久化并保留活动引用', async () => {
    const database = createSyntheticSettingsDatabase();
    const writer = new PrismaAiSettingsStore(database.prisma as never, 'independent-prisma-secret');
    await writer.update({
      baseUrl: 'https://active.example.test/v1',
      apiKey: 'synthetic-active-key',
    });
    const activeReference = await writer.getCredentialReference();
    const activeView = await writer.get();

    const created = await writer.update({
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    });

    expect(created.createdCredentialId).toBeTruthy();
    const { createdCredentialId, ...unchangedView } = created;
    expect(unchangedView).toEqual(activeView);
    expect(await writer.getCredentialReference()).toEqual(activeReference);

    const row = database.rows.find((entry) => entry.id === createdCredentialId);
    expect(row).toMatchObject({
      label: 'independent',
      baseUrl: 'https://independent.example.test/v1',
      version: 2,
    });
    // 只有密文进入数据库，明文 Key 不出现在任何持久化字段里。
    expect(JSON.stringify(row)).not.toContain('synthetic-independent-key');

    const reopened = new PrismaAiSettingsStore(
      database.prisma as never,
      'independent-prisma-secret',
    );
    const summaries = await reopened.listCredentials();
    expect(summaries).toHaveLength(2);
    expect(summaries.find((entry) => entry.id === activeReference.credentialId)).toMatchObject({
      active: true,
    });
    expect(summaries.find((entry) => entry.id === createdCredentialId)).toMatchObject({
      baseUrl: 'https://independent.example.test/v1',
      active: false,
    });
    // 新建独立行不能让重启后的实例把它当成活动连接。
    expect(await reopened.getCredentialReference()).toEqual(activeReference);
    expect(await reopened.get()).toEqual(activeView);
    expect(await reopened.hasCredential(createdCredentialId!)).toBe(true);
    const independentReference = await writer.getCredentialReference(createdCredentialId!);
    await expect(reopened.getProviderCredentials(independentReference)).resolves.toEqual({
      baseUrl: 'https://independent.example.test/v1',
      apiKey: 'synthetic-independent-key',
    });

    await expect(
      reopened.updateCredentialDefaults(createdCredentialId!, {
        image: { modelAlias: 'independent-image', credentialId: createdCredentialId },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdCredentialId,
          defaultModels: {
            image: { modelAlias: 'independent-image', credentialId: createdCredentialId },
          },
        }),
      ]),
    );
    // 非活动凭据的默认模型不进入全局设置视图。
    expect(await reopened.get()).toEqual(activeView);
    await expect(
      reopened.updateCredentialDefaults('123e4567-e89b-12d3-a456-426614174099', {
        text: 'missing',
      }),
    ).resolves.toBeUndefined();
    await expect(writer.update({ timeoutMs: 1_200_000 })).resolves.toMatchObject({
      timeoutMs: 1_200_000,
    });
  });

  it('Prisma 删除独立凭据不撤销活动连接，删除活动连接也不回退到独立凭据', async () => {
    const database = createSyntheticSettingsDatabase();
    const store = new PrismaAiSettingsStore(database.prisma as never, 'independent-remove-secret');
    await store.update({
      baseUrl: 'https://active.example.test/v1',
      apiKey: 'synthetic-active-key',
    });
    const activeReference = await store.getCredentialReference();
    const activeView = await store.get();
    const createdCredentialId = (
      await store.update({
        baseUrl: 'https://independent.example.test/v1',
        apiKey: 'synthetic-independent-key',
        activate: false,
      })
    ).createdCredentialId!;

    // 删除独立凭据只标记该连接，不追加撤销墓碑，也不改变活动连接。
    await expect(store.removeCredential(createdCredentialId)).resolves.toEqual(activeView);
    expect(await store.getCredentialReference()).toEqual(activeReference);
    await expect(store.hasCredential(createdCredentialId)).resolves.toBe(false);
    // 独立行使用专用删除标记，否则它会重新进入“最新行即活动连接”的候选范围。
    expect(database.rows.find((row) => row.id === createdCredentialId)?.label).toBe(
      'independent-deleted',
    );
    expect(database.rows.some((row) => row.label === 'revoked')).toBe(false);
    expect((await store.listCredentials()).map((entry) => entry.id)).toEqual([
      activeReference.credentialId,
    ]);

    // 删除活动连接后，仍保存的独立凭据不会被自动选中。
    const kept = await store.update({
      baseUrl: 'https://kept.example.test/v1',
      apiKey: 'synthetic-kept-key',
      activate: false,
    });
    await expect(store.removeCredential(activeReference.credentialId!)).resolves.toMatchObject({
      configured: false,
      baseUrl: '',
    });
    expect(await store.getCredentialReference()).toEqual({});
    await expect(store.hasCredential(kept.createdCredentialId!)).resolves.toBe(false);
    expect((await store.listCredentials()).map((entry) => entry.id)).toEqual([
      kept.createdCredentialId,
    ]);
  });
});

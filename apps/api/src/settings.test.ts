import { createCipheriv, createHash, randomBytes } from 'node:crypto';

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
    const store = new PrismaAiSettingsStore(prisma as never, 'current-encryption-secret');

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

  it('applies media-specific capability overrides only to filtered models', () => {
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
    expect(store.listModels()[0]?.capabilities).toEqual({ base64: true });
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
    const create = vi.fn().mockResolvedValue({});
    const deleteMany = vi.fn();
    const prisma = {
      aiCredential: { findFirst, create, deleteMany },
      modelCatalog: { findMany: vi.fn().mockResolvedValue([]) },
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
    const store = new PrismaAiSettingsStore(prisma as never, 'test-encryption-secret');

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
    expect(findFirst).toHaveBeenCalledTimes(1);
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
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: createdId,
      version: data.version as number,
      updatedAt: new Date('2026-08-27T05:00:00.000Z'),
    }));
    const modelCatalog = {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    };
    const transaction = { aiCredential: { create }, modelCatalog };
    const prisma = {
      aiCredential: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(activeRow)
          .mockResolvedValueOnce(historicalRow)
          .mockResolvedValueOnce(activeRow),
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

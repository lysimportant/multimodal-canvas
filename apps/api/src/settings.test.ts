import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiSettingsStore, normalizeModelsPayload, PrismaAiSettingsStore } from './settings';

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
});

describe('New API model catalog normalization', () => {
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

  it('hydrates capability overrides from the PostgreSQL store when available', async () => {
    const prisma = {
      aiCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      modelCatalog: {
        findMany: vi.fn().mockResolvedValue([
          {
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
    });
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'test-key' });
    await expect(store.refreshModels()).resolves.toMatchObject([{ id: 'text-v1' }]);

    fetchImpl.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(store.refreshModels()).rejects.toThrow('upstream unavailable');
    expect(store.listModels()).toMatchObject([{ id: 'text-v1' }]);
  });
});

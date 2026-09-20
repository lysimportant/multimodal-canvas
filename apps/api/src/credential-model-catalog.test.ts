import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';

afterEach(() => {
  vi.unstubAllEnvs();
});

function modelsResponse(id: string, mediaType: 'text' | 'image' | 'video') {
  return Response.json({ data: [{ id, mediaType }] });
}

describe('凭据范围模型目录', () => {
  it('激活所选凭据时继承其目录，显式清空连接后不再返回活动引用', () => {
    const store = new MemoryAiSettingsStore('credential-activation-test');
    store.update({ baseUrl: 'https://first.example.com/v1', apiKey: 'first-key' });
    const first = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'first-model',
          name: 'First model',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      first.credentialId,
    );
    store.update({ baseUrl: 'https://second.example.com/v1', apiKey: 'second-key' });
    const second = store.getCredentialReference();
    store.replaceModels(
      [
        {
          id: 'second-model',
          name: 'Second model',
          mediaTypes: ['image'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      second.credentialId,
    );

    expect(store.activateCredential(first.credentialId!)).toMatchObject({ configured: true });
    const activated = store.getCredentialReference();
    expect(store.listModels(undefined, activated.credentialId)).toEqual([
      expect.objectContaining({ id: 'first-model', credentialId: activated.credentialId }),
    ]);

    expect(store.update({ apiKey: '' })).toMatchObject({ configured: false });
    expect(store.getCredentialReference()).toEqual({});
    expect(store.getProviderCredentials()).toBeUndefined();
  });

  it('隔离同名模型、保留冻结版本，并在刷新失败时保留原目录', async () => {
    let failChatRefresh = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer chat-key') {
        if (failChatRefresh) throw new Error('chat catalog unavailable');
        return modelsResponse('shared-model', 'text');
      }
      if (authorization === 'Bearer image-key') return modelsResponse('shared-model', 'image');
      throw new Error('unexpected credential');
    });
    const store = new MemoryAiSettingsStore('credential-model-catalog-test', {
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
    expect(store.getProviderCredentials(chatReference)).toEqual({
      baseUrl: 'https://chat.example.com/v1',
      apiKey: 'chat-key',
    });
    expect(store.getCredentialReference()).toEqual(imageReference);

    failChatRefresh = true;
    await expect(store.refreshModels(chatReference.credentialId)).rejects.toThrow(
      'chat catalog unavailable',
    );
    expect(store.listModels(undefined, chatReference.credentialId)).toEqual([
      expect.objectContaining({ id: 'shared-model', credentialId: chatReference.credentialId }),
    ]);
  });

  it('HTTP 刷新和查询只返回所选凭据目录且不泄露合成 Key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer chat-key') return modelsResponse('chat-v1', 'text');
      if (authorization === 'Bearer image-key') return modelsResponse('image-v1', 'image');
      throw new Error('unexpected credential');
    });
    const store = new MemoryAiSettingsStore('credential-http-test', {
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
      const imageRefresh = await app.inject({
        method: 'POST',
        url: '/v1/settings/ai/models/refresh',
        payload: { credentialId: image.credentialId },
      });
      const chatList = await app.inject({
        method: 'GET',
        url: `/v1/models?mediaType=text&credentialId=${chat.credentialId}`,
      });
      const imageList = await app.inject({
        method: 'GET',
        url: `/v1/models?mediaType=image&credentialId=${image.credentialId}`,
      });

      expect(chatRefresh.statusCode).toBe(200);
      expect(imageRefresh.statusCode).toBe(200);
      expect(chatList.json().models).toEqual([
        expect.objectContaining({ id: 'chat-v1', credentialId: chat.credentialId }),
      ]);
      expect(imageList.json().models).toEqual([
        expect.objectContaining({ id: 'image-v1', credentialId: image.credentialId }),
      ]);
      const serialized = [chatRefresh, imageRefresh, chatList, imageList]
        .map((response) => response.body)
        .join('\n');
      expect(serialized).not.toContain('chat-key');
      expect(serialized).not.toContain('image-key');
      expect(store.getCredentialReference()).toEqual(image);
    } finally {
      await app.close();
    }
  });
});

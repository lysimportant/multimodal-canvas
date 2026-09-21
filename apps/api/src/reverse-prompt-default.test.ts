import type { ModelCatalogEntry } from './settings';
import { describe, expect, it } from 'vitest';

import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { resolveReversePromptDefault } from './reverse-prompts';

const REFRESHED_AT = '2026-09-21T00:00:00.000Z';

/** 为直接单测创建一个独立合成凭据及其文字模型目录。 */
function addCredential(
  store: MemoryAiSettingsStore,
  suffix: string,
  models: ModelCatalogEntry[] = [textModel(`text-${suffix}`)],
): string {
  const result = store.update({
    baseUrl: `https://group-${suffix}.example.invalid/v1`,
    apiKey: `synthetic-${suffix}`,
    activate: false,
  });
  const credentialId = result.createdCredentialId;
  if (!credentialId) throw new Error('合成凭据创建失败');
  store.replaceModels(models, credentialId);
  return credentialId;
}

/** 构造不访问网络的文字目录项。 */
function textModel(id: string): ModelCatalogEntry {
  return { id, name: id, mediaTypes: ['text'], refreshedAt: REFRESHED_AT };
}

describe('反推文字默认模型解析', () => {
  it.each([1, 2])('没有个人默认时不从 %i 个分组目录推导凭据', async (groupCount) => {
    const store = new MemoryAiSettingsStore();
    for (let index = 0; index < groupCount; index += 1) addCredential(store, String(index));

    await expect(resolveReversePromptDefault(store)).resolves.toBeUndefined();
  });

  it('保留带凭据身份的显式个人默认', async () => {
    const store = new MemoryAiSettingsStore();
    const credentialId = addCredential(store, 'explicit', [textModel('explicit-text')]);
    store.update({
      defaultModels: { text: { modelAlias: 'explicit-text', credentialId } },
    });

    await expect(resolveReversePromptDefault(store)).resolves.toEqual({
      modelAlias: 'explicit-text',
      credentialId,
    });
  });

  it('显式默认失效时保留原身份，不自动换到仍可用的其他分组', async () => {
    const store = new MemoryAiSettingsStore();
    const expiredCredentialId = addCredential(store, 'expired', [textModel('retired-text')]);
    addCredential(store, 'available', [textModel('available-text')]);
    store.update({
      defaultModels: {
        text: { modelAlias: 'retired-text', credentialId: expiredCredentialId },
      },
    });
    store.removeCredential(expiredCredentialId);

    await expect(resolveReversePromptDefault(store)).resolves.toEqual({
      modelAlias: 'retired-text',
      credentialId: expiredCredentialId,
    });
  });

  it('显式开启合成兼容时保留凭据默认和目录首项回退', async () => {
    const boundStore = new MemoryAiSettingsStore();
    const boundCredentialId = addCredential(boundStore, 'bound', [textModel('bound-text')]);
    boundStore.updateCredentialDefaults(boundCredentialId, { text: 'bound-text' });
    await expect(resolveReversePromptDefault(boundStore, true)).resolves.toEqual({
      modelAlias: 'bound-text',
      credentialId: boundCredentialId,
    });

    const catalogStore = new MemoryAiSettingsStore();
    addCredential(catalogStore, 'catalog', [textModel('catalog-text')]);
    const catalogCredential = catalogStore.listCredentials()[0]!;
    await expect(resolveReversePromptDefault(catalogStore, true)).resolves.toEqual({
      modelAlias: 'catalog-text',
      credentialId: catalogCredential.id,
    });
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { FileAiSettingsStore } from './file-ai-settings';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';

afterEach(() => {
  vi.unstubAllEnvs();
});

type StorageFixture = {
  directory: string;
  filePath: string;
  keyPath: string;
};

/** 创建独立的本地凭据存储目录，避免测试读取或删除工作区数据。 */
async function createStorageFixture(): Promise<StorageFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'multimodal-ai-credentials-'));
  return {
    directory,
    filePath: join(directory, 'ai-credentials.json'),
    keyPath: join(directory, 'ai-credentials.key'),
  };
}

/** 在测试结束后移除已验证位于系统临时目录的专用夹具目录。 */
async function withStorageFixture(run: (fixture: StorageFixture) => Promise<void>): Promise<void> {
  const fixture = await createStorageFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

/** 生成符合 New API 目录响应契约的单模型响应。 */
function modelsResponse(id: string, mediaType: 'text' | 'image' | 'video'): Response {
  return new Response(JSON.stringify({ data: [{ id, mediaType }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FileAiSettingsStore persistence', () => {
  it('启动轮换必须写回全部历史密文，移除旧密钥后仍能恢复冻结版本', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const original = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'synthetic-old-secret',
        credentialKeyring: new CredentialEncryptionKeyring({
          currentKeyId: 'old',
          currentSecret: 'synthetic-old-secret',
        }),
      });
      await original.update({
        baseUrl: 'https://rotation.example/v1',
        apiKey: 'synthetic-key-one',
      });
      const firstReference = await original.getCredentialReference();
      await original.update({
        baseUrl: 'https://rotation.example/v1',
        apiKey: 'synthetic-key-two',
      });
      const secondReference = await original.getCredentialReference();
      await original.close();
      const rotated = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'synthetic-new-secret',
        credentialKeyring: new CredentialEncryptionKeyring({
          currentKeyId: 'new',
          currentSecret: 'synthetic-new-secret',
          previousSecrets: { old: 'synthetic-old-secret' },
        }),
      });
      await rotated.get();
      const serialized = await readFile(filePath, 'utf8');
      expect(serialized).not.toContain('mc:v2:old:');
      expect(serialized).not.toContain('synthetic-key-one');
      expect(serialized).not.toContain('synthetic-key-two');
      await rotated.close();
      const recovered = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'synthetic-new-secret',
        credentialKeyring: new CredentialEncryptionKeyring({
          currentKeyId: 'new',
          currentSecret: 'synthetic-new-secret',
        }),
      });
      await expect(recovered.getProviderCredentials(firstReference)).resolves.toMatchObject({
        apiKey: 'synthetic-key-one',
      });
      await expect(recovered.getProviderCredentials(secondReference)).resolves.toMatchObject({
        apiKey: 'synthetic-key-two',
      });
      expect(await recovered.getCredentialReference()).toEqual(secondReference);
      await recovered.close();
    });
  });

  it('轮换写回失败时拒绝启动并保留原始凭据文件', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const original = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'synthetic-old-secret',
        credentialKeyring: new CredentialEncryptionKeyring({
          currentKeyId: 'old',
          currentSecret: 'synthetic-old-secret',
        }),
      });
      await original.update({ baseUrl: 'https://rotation.example/v1', apiKey: 'synthetic-key' });
      await original.close();
      const before = await readFile(filePath, 'utf8');
      const persistence = vi
        .spyOn(FileAiSettingsStore.prototype as unknown as { persist(): Promise<void> }, 'persist')
        .mockRejectedValueOnce(new Error('synthetic-write-failure'));
      try {
        const rotated = new FileAiSettingsStore({
          filePath,
          encryptionKeyFile: keyPath,
          encryptionSecret: 'synthetic-new-secret',
          credentialKeyring: new CredentialEncryptionKeyring({
            currentKeyId: 'new',
            currentSecret: 'synthetic-new-secret',
            previousSecrets: { old: 'synthetic-old-secret' },
          }),
        });
        await expect(rotated.get()).rejects.toThrow('cannot be decrypted');
        expect(persistence).toHaveBeenCalledOnce();
        expect(await readFile(filePath, 'utf8')).toBe(before);
      } finally {
        persistence.mockRestore();
      }
    });
  });

  it('persists encrypted credentials across restarts without writing the API key into JSON', async () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY', '');
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const apiKey = 'file-store-restart-key';
      const first = new FileAiSettingsStore({ filePath, encryptionKeyFile: keyPath });
      await expect(
        first.update({ baseUrl: 'https://restart.example.com/v1', apiKey }),
      ).resolves.toMatchObject({ configured: true, baseUrl: 'https://restart.example.com/v1' });
      const reference = await first.getCredentialReference();
      await first.close();

      const serialized = await readFile(filePath, 'utf8');
      expect(serialized).toContain('encryptedApiKey');
      expect(serialized).not.toContain(apiKey);

      const restarted = new FileAiSettingsStore({ filePath, encryptionKeyFile: keyPath });
      await expect(restarted.get()).resolves.toMatchObject({
        configured: true,
        baseUrl: 'https://restart.example.com/v1',
      });
      await expect(restarted.getProviderCredentials(reference)).resolves.toEqual({
        baseUrl: 'https://restart.example.com/v1',
        apiKey,
      });
      await restarted.close();
    });
  });

  it('preserves historical versions for frozen jobs after activation and revocation', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const secret = 'file-store-history-encryption-secret';
      const first = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: secret,
      });
      await first.update({ baseUrl: 'https://first.example.com/v1', apiKey: 'first-history-key' });
      const firstReference = await first.getCredentialReference();
      await first.update({
        baseUrl: 'https://second.example.com/v1',
        apiKey: 'second-history-key',
      });
      const secondReference = await first.getCredentialReference();
      await first.close();

      const restarted = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: secret,
      });
      await expect(restarted.getProviderCredentials(firstReference)).resolves.toEqual({
        baseUrl: 'https://first.example.com/v1',
        apiKey: 'first-history-key',
      });
      await expect(restarted.getProviderCredentials(secondReference)).resolves.toEqual({
        baseUrl: 'https://second.example.com/v1',
        apiKey: 'second-history-key',
      });

      await expect(
        restarted.activateCredential(firstReference.credentialId!),
      ).resolves.toMatchObject({
        configured: true,
        baseUrl: 'https://first.example.com/v1',
      });
      const activeReference = await restarted.getCredentialReference();
      expect(activeReference.credentialId).not.toBe(firstReference.credentialId);

      await expect(restarted.removeCredentials()).resolves.toMatchObject({ configured: false });
      await restarted.close();

      const revoked = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: secret,
      });
      await expect(revoked.get()).resolves.toMatchObject({ configured: false });
      await expect(revoked.getProviderCredentials(firstReference)).resolves.toEqual({
        baseUrl: 'https://first.example.com/v1',
        apiKey: 'first-history-key',
      });
      await expect(revoked.getProviderCredentials(activeReference)).resolves.toEqual({
        baseUrl: 'https://first.example.com/v1',
        apiKey: 'first-history-key',
      });
      await revoked.close();
    });
  });

  it('persists credential-scoped model catalogs across restarts', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => modelsResponse('video-v1', 'video'));
      const options = {
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'file-store-catalog-encryption-secret',
        fetchImpl,
        modelRequestMaxAttempts: 1,
        modelRequestRetryDelayMs: 0,
      };
      const first = new FileAiSettingsStore(options);
      await first.update({ baseUrl: 'https://catalog.example.com/v1', apiKey: 'catalog-key' });
      const reference = await first.getCredentialReference();
      await expect(first.refreshModels(reference.credentialId)).resolves.toEqual([
        expect.objectContaining({ id: 'video-v1', credentialId: reference.credentialId }),
      ]);
      await first.close();

      const restarted = new FileAiSettingsStore(options);
      await expect(restarted.listModels('video', reference.credentialId)).resolves.toEqual([
        expect.objectContaining({
          id: 'video-v1',
          credentialId: reference.credentialId,
          mediaTypes: ['video'],
        }),
      ]);
      await restarted.close();
    });
  });

  it('fails closed when the storage key is missing, incorrect, or the JSON is corrupt', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY', '');
      const original = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'original-file-store-secret',
      });
      await original.update({ baseUrl: 'https://failure.example.com/v1', apiKey: 'failure-key' });
      await original.update({ baseUrl: 'https://history.example.com/v1', apiKey: 'history-key' });
      await original.close();

      const wrongSecret = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'wrong-file-store-secret',
      });
      await expect(wrongSecret.get()).rejects.toThrow('cannot be decrypted');

      const inconsistent = JSON.parse(await readFile(filePath, 'utf8')) as {
        activeCredential: { credentialId: string };
        activeSettings: unknown;
        credentials: Array<{ id: string }>;
      };
      const historical = inconsistent.credentials.find(
        (credential) => credential.id !== inconsistent.activeCredential.credentialId,
      );
      if (!historical) throw new Error('expected a historical credential fixture');
      inconsistent.activeSettings = historical;
      await writeFile(filePath, JSON.stringify(inconsistent), 'utf8');
      const inconsistentStore = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'original-file-store-secret',
      });
      await expect(inconsistentStore.get()).rejects.toThrow(
        'invalid local AI credential storage file',
      );

      await rm(keyPath, { force: true });
      const missingKey = new FileAiSettingsStore({ filePath, encryptionKeyFile: keyPath });
      await expect(missingKey.get()).rejects.toThrow('encryption key is missing');
    });

    await withStorageFixture(async ({ filePath, keyPath }) => {
      await writeFile(filePath, '{not valid JSON', 'utf8');
      const corrupt = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'corrupt-file-store-secret',
      });
      await expect(corrupt.get()).rejects.toThrow();
    });
  });

  it('serializes concurrent writes without losing credential versions', async () => {
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const store = new FileAiSettingsStore({
        filePath,
        encryptionKeyFile: keyPath,
        encryptionSecret: 'file-store-concurrency-secret',
      });
      await Promise.all([
        store.update({ baseUrl: 'https://first.concurrent.example/v1', apiKey: 'concurrent-one' }),
        store.update({ baseUrl: 'https://second.concurrent.example/v1', apiKey: 'concurrent-two' }),
        store.update({
          baseUrl: 'https://third.concurrent.example/v1',
          apiKey: 'concurrent-three',
        }),
      ]);
      await expect(store.get()).resolves.toMatchObject({
        configured: true,
        baseUrl: 'https://third.concurrent.example/v1',
      });
      await store.close();

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        credentials: Array<{ version: number }>;
      };
      expect(persisted.credentials.map((credential) => credential.version).sort()).toEqual([
        1, 2, 3,
      ]);
    });
  });
});

describe('FileAiSettingsStore HTTP integration', () => {
  it('returns persisted settings after an API restart without exposing the submitted key', async () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY', '');
    await withStorageFixture(async ({ filePath, keyPath }) => {
      const apiKey = 'http-file-store-key';
      const firstStore = new FileAiSettingsStore({ filePath, encryptionKeyFile: keyPath });
      const firstApp = buildApp({ logger: false, settingsStore: firstStore });
      try {
        const saved = await firstApp.inject({
          method: 'PATCH',
          url: '/v1/settings/ai',
          payload: { baseUrl: 'https://http-restart.example.com/v1', apiKey },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json().settings).toMatchObject({ configured: true });
        expect(saved.body).not.toContain(apiKey);
      } finally {
        await firstApp.close();
      }

      const serialized = await readFile(filePath, 'utf8');
      expect(serialized).not.toContain(apiKey);

      const restartedStore = new FileAiSettingsStore({ filePath, encryptionKeyFile: keyPath });
      const restartedApp = buildApp({ logger: false, settingsStore: restartedStore });
      try {
        const settings = await restartedApp.inject({ method: 'GET', url: '/v1/settings/ai' });
        expect(settings.statusCode).toBe(200);
        expect(settings.json().settings).toMatchObject({
          configured: true,
          baseUrl: 'https://http-restart.example.com/v1',
        });
        expect(settings.body).not.toContain(apiKey);
      } finally {
        await restartedApp.close();
      }
    });
  });
});

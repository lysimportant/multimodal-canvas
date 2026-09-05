import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CredentialEncryptionError,
  CredentialEncryptionKeyring,
  createCredentialEncryptionKeyringFromEnvironment,
  parsePreviousCredentialEncryptionKeys,
} from './index';

/** 生成旧单密钥格式，用于验证平滑迁移而不是生成新的生产密文。 */
function legacyCiphertext(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

describe('CredentialEncryptionKeyring', () => {
  it('rejects normalized duplicate historical key identifiers without overwriting key material', () => {
    expect(() =>
      parsePreviousCredentialEncryptionKeys(JSON.stringify({ old: 'first', ' old ': 'second' })),
    ).toThrow('key-id 重复');
  });

  it('rejects tampered GCM payloads and mismatched recorded key identifiers', () => {
    const keyring = new CredentialEncryptionKeyring({
      currentKeyId: 'current',
      currentSecret: 'synthetic-secret',
    });
    const ciphertext = keyring.encrypt('synthetic-provider-key');
    const payload = Buffer.from(ciphertext.split(':')[3]!, 'base64url');
    payload[12] = payload[12]! ^ 1;
    expect(() => keyring.decrypt(`mc:v2:current:${payload.toString('base64url')}`)).toThrow(
      '无法解密',
    );
    expect(() => keyring.decrypt(ciphertext, 'different')).toThrow('key-id 不匹配');
  });

  it('writes a versioned current-key envelope and reads it without rotation', () => {
    const keyring = new CredentialEncryptionKeyring({
      currentKeyId: '2026-09-current',
      currentSecret: 'current-secret',
    });

    const ciphertext = keyring.encrypt('provider-key');

    expect(ciphertext).toMatch(/^mc:v2:2026-09-current:[A-Za-z0-9_-]+$/);
    expect(keyring.decrypt(ciphertext)).toEqual({
      plaintext: 'provider-key',
      keyId: '2026-09-current',
      needsReencryption: false,
    });
    expect(keyring.reencrypt(ciphertext)).toEqual({
      ciphertext,
      keyId: '2026-09-current',
      changed: false,
    });
  });

  it('reads legacy ciphertext with a previous key and emits current-key replacement', () => {
    const ciphertext = legacyCiphertext('historical-provider-key', 'retired-secret');
    const keyring = new CredentialEncryptionKeyring({
      currentKeyId: 'current',
      currentSecret: 'current-secret',
      previousSecrets: { retired: 'retired-secret' },
    });

    expect(keyring.decrypt(ciphertext)).toEqual({
      plaintext: 'historical-provider-key',
      keyId: 'retired',
      needsReencryption: true,
    });
    const reencrypted = keyring.reencrypt(ciphertext);
    expect(reencrypted).toMatchObject({ keyId: 'current', changed: true });
    expect(reencrypted.ciphertext).not.toContain('historical-provider-key');
    expect(keyring.decrypt(reencrypted.ciphertext)).toEqual({
      plaintext: 'historical-provider-key',
      keyId: 'current',
      needsReencryption: false,
    });
  });

  it('reads an explicit old key-id only when that key is configured', () => {
    const oldWriter = new CredentialEncryptionKeyring({
      currentKeyId: 'old',
      currentSecret: 'old-secret',
    });
    const ciphertext = oldWriter.encrypt('queued-provider-key');
    const rotated = new CredentialEncryptionKeyring({
      currentKeyId: 'new',
      currentSecret: 'new-secret',
      previousSecrets: { old: 'old-secret' },
    });

    expect(rotated.decrypt(ciphertext)).toMatchObject({
      plaintext: 'queued-provider-key',
      keyId: 'old',
      needsReencryption: true,
    });
    expect(() =>
      new CredentialEncryptionKeyring({ currentKeyId: 'new', currentSecret: 'new-secret' }).decrypt(
        ciphertext,
      ),
    ).toThrow(CredentialEncryptionError);
    expect(() =>
      new CredentialEncryptionKeyring({ currentKeyId: 'new', currentSecret: 'new-secret' }).decrypt(
        ciphertext,
      ),
    ).toThrow('key-id 未配置');
  });

  it('rejects malformed key-ring configuration and ciphertext without exposing secrets', () => {
    expect(() => parsePreviousCredentialEncryptionKeys('{not-json')).toThrow('JSON 对象');
    expect(
      () =>
        new CredentialEncryptionKeyring({
          currentKeyId: 'same',
          currentSecret: 'current-secret',
          previousSecrets: { same: 'old-secret' },
        }),
    ).toThrow('不能与当前 key-id 相同');
    expect(() =>
      new CredentialEncryptionKeyring({ currentSecret: 'current-secret' }).decrypt(
        'mc:v2:bad key:payload',
      ),
    ).toThrow(CredentialEncryptionError);
  });

  it('loads the deployment key-ring environment without serializing its values', () => {
    const keyring = createCredentialEncryptionKeyringFromEnvironment({
      AI_CREDENTIAL_ENCRYPTION_KEY_ID: 'active-2026',
      AI_CREDENTIAL_ENCRYPTION_KEY: 'active-secret',
      AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: 'old-secret' }),
    });

    expect(keyring.currentKeyId).toBe('active-2026');
    expect(JSON.stringify(keyring)).not.toContain('active-secret');
    expect(JSON.stringify(keyring)).not.toContain('old-secret');
  });
});

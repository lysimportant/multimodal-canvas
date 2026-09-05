import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 当前密文格式使用的稳定前缀。 */
const CIPHER_PREFIX = 'mc:v2:';
/** 未显式配置 key-id 时，为兼容旧单密钥部署使用的标识。 */
export const DEFAULT_CREDENTIAL_ENCRYPTION_KEY_ID = 'default';
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MINIMUM_GCM_PAYLOAD_BYTES = 12 + 16;

/** 密钥轮换环境变量的固定名称。 */
export const CREDENTIAL_ENCRYPTION_KEY_ID_ENV = 'AI_CREDENTIAL_ENCRYPTION_KEY_ID';
export const CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS_ENV = 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS';

/** 用于构造当前密钥和历史回退密钥的输入。 */
export type CredentialEncryptionKeyringOptions = {
  /** 当前用于新增或重加密密文的稳定标识。 */
  currentKeyId?: string;
  /** 当前密钥材料；只保存在进程内，绝不能持久化或记录日志。 */
  currentSecret: string;
  /** 仍需解密历史快照的旧密钥，键为 key-id。 */
  previousSecrets?: Readonly<Record<string, string>>;
};

/** 解密结果会说明密文是否应在安全写入边界重加密。 */
export type CredentialDecryptionResult = {
  plaintext: string;
  keyId: string;
  /** 旧格式或旧 key-id 密文需要迁移到当前密钥。 */
  needsReencryption: boolean;
};

/** 重加密后的持久化字段。 */
export type CredentialReencryptionResult = {
  ciphertext: string;
  keyId: string;
  changed: boolean;
};

/** 不携带密钥、明文或密文内容的稳定加密配置/解密错误。 */
export class CredentialEncryptionError extends Error {
  /** 构造固定业务错误码和无敏感信息的消息，不保留原始密码学异常。 */
  constructor(
    public readonly code:
      'invalid_keyring' | 'invalid_ciphertext' | 'unknown_key_id' | 'decryption_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialEncryptionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * API 与 Worker 共用的 AES-256-GCM 凭据密钥环。
 *
 * 新格式为 `mc:v2:<key-id>:<base64url(iv|tag|ciphertext)>`。旧格式只有
 * base64url 载荷，读取时会按当前密钥、再按历史密钥尝试；成功读取后调用方
 * 应在自身的原子持久化边界完成重加密，不能把明文返回给路由或日志。
 */
export class CredentialEncryptionKeyring {
  /** 当前写入标识，仅用于选择密钥，不是密钥材料。 */
  readonly currentKeyId: string;
  /** 当前进程内的派生密钥，不得序列化或输出日志。 */
  private readonly keys: ReadonlyMap<string, Buffer>;
  /** 无 key-id 的旧密文按当前密钥优先的顺序恢复。 */
  private readonly legacyKeyOrder: readonly string[];

  /** 初始化只读密钥环；空密钥或重复标识抛出 invalid_keyring。 */
  constructor(options: CredentialEncryptionKeyringOptions) {
    const currentKeyId = normalizeCredentialEncryptionKeyId(
      options.currentKeyId ?? DEFAULT_CREDENTIAL_ENCRYPTION_KEY_ID,
    );
    const entries = new Map<string, Buffer>();
    entries.set(currentKeyId, deriveEncryptionKey(options.currentSecret, 'current'));
    for (const [rawKeyId, secret] of Object.entries(options.previousSecrets ?? {})) {
      const keyId = normalizeCredentialEncryptionKeyId(rawKeyId);
      if (keyId === currentKeyId) {
        throw new CredentialEncryptionError(
          'invalid_keyring',
          '历史凭据加密 key-id 不能与当前 key-id 相同',
        );
      }
      if (entries.has(keyId)) {
        throw new CredentialEncryptionError('invalid_keyring', '历史凭据加密 key-id 重复');
      }
      entries.set(keyId, deriveEncryptionKey(secret, `previous:${keyId}`));
    }
    this.currentKeyId = currentKeyId;
    this.keys = entries;
    this.legacyKeyOrder = [...entries.keys()];
  }

  /** 使用当前 key-id 写入不含明文的版本化密文。 */
  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string') {
      throw new CredentialEncryptionError('invalid_ciphertext', '凭据明文必须是字符串');
    }
    const key = this.keys.get(this.currentKeyId);
    if (!key) throw new CredentialEncryptionError('invalid_keyring', '当前凭据加密密钥不可用');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CIPHER_PREFIX}${this.currentKeyId}:${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
  }

  /** 解密当前或历史密文，并标记是否需要在下一次受控写入时轮换。 */
  decrypt(ciphertext: string, expectedKeyId?: string): CredentialDecryptionResult {
    if (typeof ciphertext !== 'string' || !ciphertext.trim()) {
      throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文格式无效');
    }
    const versioned = parseVersionedCiphertext(ciphertext);
    if (versioned) {
      if (
        expectedKeyId !== undefined &&
        normalizeCredentialEncryptionKeyId(expectedKeyId) !== versioned.keyId
      ) {
        throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文与 key-id 不匹配');
      }
      const key = this.keys.get(versioned.keyId);
      if (!key) {
        throw new CredentialEncryptionError('unknown_key_id', '凭据加密 key-id 未配置');
      }
      return {
        plaintext: decryptPayload(versioned.payload, key),
        keyId: versioned.keyId,
        needsReencryption: versioned.keyId !== this.currentKeyId,
      };
    }

    if (ciphertext.startsWith(CIPHER_PREFIX)) {
      throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文版本格式无效');
    }
    const payload = parsePayload(ciphertext);
    for (const keyId of this.legacyKeyOrder) {
      const key = this.keys.get(keyId);
      if (!key) continue;
      try {
        return {
          plaintext: decryptPayload(payload, key),
          keyId,
          needsReencryption: true,
        };
      } catch (error) {
        if (!(error instanceof CredentialEncryptionError)) throw error;
      }
    }
    throw new CredentialEncryptionError('decryption_failed', '存储的 AI 凭据无法解密');
  }

  /** 在不暴露明文的前提下返回当前格式密文及 key-id。 */
  reencrypt(ciphertext: string, expectedKeyId?: string): CredentialReencryptionResult {
    const decrypted = this.decrypt(ciphertext, expectedKeyId);
    if (!decrypted.needsReencryption) {
      return { ciphertext, keyId: this.currentKeyId, changed: false };
    }
    return {
      ciphertext: this.encrypt(decrypted.plaintext),
      keyId: this.currentKeyId,
      changed: true,
    };
  }
}

/** 校验并规范化会进入持久化密文的 key-id。 */
export function normalizeCredentialEncryptionKeyId(value: string): string {
  const keyId = value.trim();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new CredentialEncryptionError(
      'invalid_keyring',
      '凭据加密 key-id 必须为 1 到 64 位字母数字、点、下划线或连字符',
    );
  }
  return keyId;
}

/**
 * 解析 `AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` 的 JSON 对象。
 *
 * 采用 JSON 而非逗号分隔格式，避免密钥材料中的标点造成歧义。解析失败应让
 * 生产入口 fail-closed，调用方不应记录原始环境变量内容。
 */
export function parsePreviousCredentialEncryptionKeys(
  value: string | undefined,
): Record<string, string> {
  if (value === undefined || value.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CredentialEncryptionError('invalid_keyring', '历史凭据加密密钥必须是 JSON 对象');
  }
  if (!isRecord(parsed)) {
    throw new CredentialEncryptionError('invalid_keyring', '历史凭据加密密钥必须是 JSON 对象');
  }
  const result: Record<string, string> = {};
  for (const [rawKeyId, secret] of Object.entries(parsed)) {
    const keyId = normalizeCredentialEncryptionKeyId(rawKeyId);
    if (typeof secret !== 'string' || !secret.trim()) {
      throw new CredentialEncryptionError('invalid_keyring', '历史凭据加密密钥不能为空');
    }
    if (Object.hasOwn(result, keyId)) {
      throw new CredentialEncryptionError('invalid_keyring', '历史凭据加密 key-id 重复');
    }
    result[keyId] = secret;
  }
  return result;
}

/** 从部署环境构造密钥环，不会把任何密钥值写入错误信息。 */
export function createCredentialEncryptionKeyringFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialEncryptionKeyring {
  const currentSecret = environment.AI_CREDENTIAL_ENCRYPTION_KEY;
  if (typeof currentSecret !== 'string' || !currentSecret.trim()) {
    throw new CredentialEncryptionError('invalid_keyring', '当前凭据加密密钥不能为空');
  }
  return new CredentialEncryptionKeyring({
    currentKeyId:
      environment[CREDENTIAL_ENCRYPTION_KEY_ID_ENV] ?? DEFAULT_CREDENTIAL_ENCRYPTION_KEY_ID,
    currentSecret,
    previousSecrets: parsePreviousCredentialEncryptionKeys(
      environment[CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS_ENV],
    ),
  });
}

/** 保持旧 SHA-256 派生规则，空材料失败且不回显原值。 */
function deriveEncryptionKey(secret: string, source: string): Buffer {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new CredentialEncryptionError('invalid_keyring', `凭据加密密钥无效（${source}）`);
  }
  // 保持既有单密钥 SHA-256 派生方式，旧 AES-GCM 载荷才能在轮换期间继续读取。
  return createHash('sha256').update(secret).digest();
}

/** 解析版本化包装；旧格式返回 undefined，损坏的新格式直接失败。 */
function parseVersionedCiphertext(value: string): { keyId: string; payload: Buffer } | undefined {
  if (!value.startsWith(CIPHER_PREFIX)) return undefined;
  const remainder = value.slice(CIPHER_PREFIX.length);
  const separator = remainder.indexOf(':');
  if (separator <= 0 || separator === remainder.length - 1) {
    throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文版本格式无效');
  }
  return {
    keyId: normalizeCredentialEncryptionKeyId(remainder.slice(0, separator)),
    payload: parsePayload(remainder.slice(separator + 1)),
  };
}

/** 验证编码与 GCM 最短载荷长度，不在错误中包含密文。 */
function parsePayload(value: string): Buffer {
  if (!BASE64_URL_PATTERN.test(value)) {
    throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文格式无效');
  }
  const payload = Buffer.from(value, 'base64url');
  if (payload.byteLength < MINIMUM_GCM_PAYLOAD_BYTES) {
    throw new CredentialEncryptionError('invalid_ciphertext', '凭据密文格式无效');
  }
  return payload;
}

/** 校验 GCM 标签并解密；认证失败统一转为无敏感内容的异常。 */
function decryptPayload(payload: Buffer, key: Buffer): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new CredentialEncryptionError('decryption_failed', '存储的 AI 凭据无法解密');
  }
}

/** 仅接受非 null 对象，不把数组当作历史密钥映射。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

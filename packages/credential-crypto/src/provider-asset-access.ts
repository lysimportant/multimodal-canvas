import { createHmac, timingSafeEqual } from 'node:crypto';

/** Provider 素材访问令牌允许的最长有效期（秒）。 */
export const PROVIDER_ASSET_ACCESS_TTL_SECONDS = 3600;

const TOKEN_VERSION = 'v1';
const TOKEN_PURPOSE = 'provider-asset-access';
const TOKEN_SEPARATOR = '.';
const TTL_MILLISECONDS = PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_PAYLOAD_PART_LENGTH = 12 * 1024;
const MAX_PAYLOAD_BYTES = 9 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_FIELDS = ['assetId', 'version', 'projectId', 'ownerId', 'expiresAt', 'iat'] as const;
const GRANT_FIELDS = ['assetId', 'version', 'projectId', 'ownerId', 'expiresAt'] as const;

/** API 与 Worker 之间传递的 Provider 素材版本授权载荷。 */
export type ProviderAssetAccessGrant = {
  /** 素材稳定标识。 */
  assetId: string;
  /** 要读取的素材版本，必须为正安全整数。 */
  version: number;
  /** 所属项目标识；个人素材可使用 null。 */
  projectId: string | null;
  /** 素材所有者稳定标识。 */
  ownerId: string;
  /** Unix 毫秒时间戳，到期时间必须在签发时一小时以内。 */
  expiresAt: number;
};

type ProviderAssetAccessTokenPayload = ProviderAssetAccessGrant & {
  /** Unix 毫秒签发时间；用于校验令牌最长有效期。 */
  iat: number;
};

/**
 * 签发独立用途域的 Provider 素材访问令牌。
 *
 * 令牌使用固定版本、用途声明和域隔离 HMAC-SHA256 签名，不兼容登录 JWT
 * 或普通素材 access token。令牌本身不包含密钥，调用方不得记录密钥或完整令牌。
 *
 * @param grant 素材版本、项目和所有者授权，以及毫秒级到期时间。
 * @param secret API 与 Worker 共享的签名密钥；不得为空白字符串。
 * @param now 签发时的 Unix 毫秒时间戳，默认使用当前时间。
 * @returns `v1.<payload>.<signature>` 形式的短期签名令牌。
 * @throws 输入字段、时间窗口或密钥无效时抛出 `TypeError` 或 `Error`。
 */
export function createProviderAssetAccessToken(
  grant: ProviderAssetAccessGrant,
  secret: string,
  now = Date.now(),
): string {
  validateSecretForSigning(secret);
  validateNow(now);
  const validatedGrant = validateGrant(grant, now);
  const payload: ProviderAssetAccessTokenPayload = { ...validatedGrant, iat: now };
  const encodedPayload = encodePayload(payload);
  const signed = `${TOKEN_VERSION}${TOKEN_SEPARATOR}${encodedPayload}`;
  const signature = sign(signed, secret);
  return `${signed}${TOKEN_SEPARATOR}${signature}`;
}

/**
 * 校验 Provider 素材访问令牌并返回不含内部 `iat` 的授权载荷。
 *
 * 校验会拒绝空密钥、错误用途域、错误签名、非法字段、过期令牌和超过一小时
 * 的签发窗口。所有不可信输入失败均返回 `undefined`，不会把密码学异常泄露给路由。
 *
 * @param token 未信任的令牌字符串。
 * @param secret 与签发端相同的共享签名密钥。
 * @param now 用于时间校验的 Unix 毫秒时间戳，默认使用当前时间。
 * @returns 校验后的素材授权；令牌无效时返回 `undefined`。
 */
export function verifyProviderAssetAccessToken(
  token: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): ProviderAssetAccessGrant | undefined {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    typeof secret !== 'string' ||
    !secret.trim() ||
    !isSafeTimestamp(now)
  ) {
    return undefined;
  }

  const parts = token.split(TOKEN_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return undefined;
  const encodedPayload = parts[1];
  const suppliedSignature = parts[2];
  if (
    !encodedPayload ||
    !suppliedSignature ||
    encodedPayload.length > MAX_PAYLOAD_PART_LENGTH ||
    !isCanonicalBase64Url(encodedPayload) ||
    !isCanonicalBase64Url(suppliedSignature)
  ) {
    return undefined;
  }

  let suppliedSignatureBytes: Buffer;
  try {
    suppliedSignatureBytes = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    return undefined;
  }
  const expectedSignature = Buffer.from(
    sign(`${TOKEN_VERSION}.${encodedPayload}`, secret),
    'base64url',
  );
  if (
    suppliedSignatureBytes.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignatureBytes, expectedSignature)
  ) {
    return undefined;
  }

  const payload = decodePayload(encodedPayload);
  if (!payload) return undefined;
  const validated = validateTokenPayload(payload, now);
  if (!validated) return undefined;
  return validated;
}

/**
 * 构造 Provider 素材版本内容路径。
 *
 * @param assetId 素材稳定标识，会按 URI 路径段编码。
 * @param version 正素材版本号，必须为正安全整数。
 * @returns `/v1/provider-assets/{assetId}/versions/{version}/content` 路径。
 * @throws 素材标识或版本号无效时抛出 `TypeError`。
 */
export function providerAssetAccessPath(assetId: string, version: number): string {
  const normalizedAssetId = validateIdentifier(assetId, 'assetId');
  validateVersion(version);
  return `/v1/provider-assets/${encodeURIComponent(normalizedAssetId)}/versions/${version}/content`;
}

/** 校验签发密钥；错误信息不回显密钥内容。 */
function validateSecretForSigning(secret: string): void {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('provider asset access secret is required');
  }
}

/** 校验用于时间比较的 Unix 毫秒时间戳。 */
function validateNow(now: number): void {
  if (!isSafeTimestamp(now)) throw new TypeError('provider asset access time is invalid');
}

/** 只接受非空的稳定标识，并保留调用方的原始字符串。 */
function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`provider asset access ${field} is required`);
  }
  return value;
}

/** 校验正安全整数版本号。 */
function validateVersion(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError('provider asset access version is invalid');
  }
}

/** 校验授权载荷的严格字段和时间窗口，并复制为稳定对象。 */
function validateGrant(value: unknown, now: number): ProviderAssetAccessGrant {
  if (!isRecord(value) || !hasExactlyFields(value, GRANT_FIELDS)) {
    throw new TypeError('provider asset access grant fields are invalid');
  }
  const assetId = validateIdentifier(value.assetId, 'assetId');
  validateVersion(value.version);
  const version = value.version as number;
  const projectId =
    value.projectId === null ? null : validateIdentifier(value.projectId, 'projectId');
  const ownerId = validateIdentifier(value.ownerId, 'ownerId');
  if (!isSafeTimestamp(value.expiresAt) || value.expiresAt <= now) {
    throw new TypeError('provider asset access expiration is invalid');
  }
  const expiresAt = value.expiresAt;
  if (now > Number.MAX_SAFE_INTEGER - TTL_MILLISECONDS || expiresAt > now + TTL_MILLISECONDS) {
    throw new TypeError('provider asset access expiration exceeds maximum ttl');
  }
  return {
    assetId,
    version,
    projectId,
    ownerId,
    expiresAt,
  };
}

/** 校验签名后的 JSON 载荷，并剥离签发时间字段。 */
function validateTokenPayload(
  value: Record<string, unknown>,
  now: number,
): ProviderAssetAccessGrant | undefined {
  if (!hasExactlyFields(value, TOKEN_FIELDS)) return undefined;
  try {
    const grant = validateGrant(
      {
        assetId: value.assetId,
        version: value.version,
        projectId: value.projectId,
        ownerId: value.ownerId,
        expiresAt: value.expiresAt,
      },
      now,
    );
    if (!isSafeTimestamp(value.iat) || value.iat > now) return undefined;
    if (grant.expiresAt > value.iat + TTL_MILLISECONDS) return undefined;
    return grant;
  } catch {
    return undefined;
  }
}

/** 编码并限制 payload 大小，避免令牌成为无界输入容器。 */
function encodePayload(payload: ProviderAssetAccessTokenPayload): string {
  const serialized = JSON.stringify(payload);
  const encoded = Buffer.from(serialized, 'utf8').toString('base64url');
  if (
    encoded.length > MAX_PAYLOAD_PART_LENGTH ||
    Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES
  ) {
    throw new TypeError('provider asset access payload is too large');
  }
  return encoded;
}

/** 解析 canonical base64url JSON payload。 */
function decodePayload(encoded: string): Record<string, unknown> | undefined {
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAYLOAD_BYTES) return undefined;
    const canonical = bytes.toString('base64url');
    if (canonical !== encoded) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 使用独立用途域派生 HMAC 密钥并签名，避免与其他 access token 共用格式。 */
function sign(value: string, secret: string): string {
  const domainKey = createHmac('sha256', secret).update(TOKEN_PURPOSE, 'utf8').digest();
  return createHmac('sha256', domainKey).update(value, 'utf8').digest('base64url');
}

/** 严格识别无填充 canonical base64url 字符串。 */
function isCanonicalBase64Url(value: string): boolean {
  if (!BASE64URL_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').toString('base64url') === value;
  } catch {
    return false;
  }
}

/** 检查对象只含契约允许的自有字段。 */
function hasExactlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === 'string' && fields.includes(key))
  );
}

/** 判断是否为可安全参与毫秒级比较的时间戳。 */
function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 仅接受普通的非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

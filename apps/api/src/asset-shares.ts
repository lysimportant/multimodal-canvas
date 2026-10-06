import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

/** 无数据库分享链接的固定有效期，单位为毫秒；需要单条撤销时应改用持久分享记录。 */
export const ASSET_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** 密码解锁授权的最长有效期，最终到期时间不得超过原分享。 */
export const ASSET_SHARE_ACCESS_TTL_MS = 60 * 60 * 1_000;

/** 无密码分享的兼容格式；现有调用方和旧服务继续只识别该版本。 */
const LEGACY_TOKEN_VERSION = 'v1';
/** 密码保护分享的独立格式；旧服务会因版本不匹配而拒绝。 */
const PASSWORD_TOKEN_VERSION = 'v2';
/** 密钥派生和附加认证数据使用的固定用途，阻止其它令牌跨接口复用。 */
const TOKEN_PURPOSE = 'asset-share';
/** 令牌只接受规范 base64url 分段与版本分隔符，并限制请求解析成本。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,4096}$/;
/** AES-GCM 推荐的 96 位随机 IV 长度。 */
const IV_BYTES = 12;
/** 每个密码分享独立生成的 128 位 scrypt salt。 */
const PASSWORD_SALT_BYTES = 16;
/** scrypt 输出长度；256 位摘要可直接用恒定时间比较。 */
const PASSWORD_HASH_BYTES = 32;
/** 密码按 JavaScript UTF-16 code unit 计数的合同上限。 */
const MAX_PASSWORD_LENGTH = 128;
/** 解锁授权使用独立格式和用途，不能作为分享令牌使用。 */
const ACCESS_TOKEN_VERSION = 'a1';
const ACCESS_TOKEN_PURPOSE = 'asset-share-access';
const ACCESS_TOKEN_PATTERN = /^a1\.[A-Za-z0-9_-]{20,2048}\.[A-Za-z0-9_-]{43}$/;

/** 分享令牌只定位一个所有者的一项资产版本，不承载项目或生成信息。 */
export type AssetShareTokenPayload = {
  purpose: typeof TOKEN_PURPOSE;
  assetId: string;
  ownerId: string;
  version: number;
  expiresAt: number;
  password?: {
    algorithm: 'scrypt';
    salt: string;
    hash: string;
  };
};

/** 密码解锁后签发的短期授权，只暴露原分享摘要和授权到期时间。 */
export type AssetShareAccessTokenPayload = {
  purpose: typeof ACCESS_TOKEN_PURPOSE;
  shareTokenDigest: string;
  expiresAt: number;
};

/**
 * 创建与短期预览令牌用途隔离的不透明 AES-256-GCM 分享令牌。
 *
 * @param input - 已冻结的资源、所有者、版本和毫秒级到期时间。
 * @param secret - 稳定服务端密钥；函数会按分享用途派生独立密钥。
 * @returns 可放入 URL 查询参数的不透明令牌。
 * @throws secret 为空时抛出错误。
 */
export function createAssetShareToken(
  input: Omit<AssetShareTokenPayload, 'purpose' | 'password'>,
  secret: string,
): string {
  if (!secret.trim()) throw new Error('asset share secret is required');
  const payload: AssetShareTokenPayload = { purpose: TOKEN_PURPOSE, ...input };
  return encryptSharePayload(payload, secret, LEGACY_TOKEN_VERSION);
}

/**
 * 创建密码保护的 v2 分享令牌；密码摘要和随机 salt 只存在于 AES-GCM 密文中。
 *
 * @param input - 已冻结的资源、所有者、版本和毫秒级到期时间。
 * @param secret - 稳定服务端密钥；v2 使用独立版本派生密钥。
 * @param password - 1..128 个 UTF-16 code unit 的原始密码，不做 trim 或 Unicode 归一化。
 * @returns 可放入 URL 查询参数的 v2 不透明令牌。
 * @throws secret 为空或密码不符合长度合同时抛出错误。
 */
export async function createPasswordProtectedAssetShareToken(
  input: Omit<AssetShareTokenPayload, 'purpose' | 'password'>,
  secret: string,
  password: string,
): Promise<string> {
  if (!secret.trim()) throw new Error('asset share secret is required');
  if (password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
    throw new TypeError('asset share password length is invalid');
  }
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derivePasswordHash(password, salt);
  const payload: AssetShareTokenPayload = {
    purpose: TOKEN_PURPOSE,
    ...input,
    password: {
      algorithm: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
    },
  };
  return encryptSharePayload(payload, secret, PASSWORD_TOKEN_VERSION);
}

/**
 * 判断已验证分享是否需要密码解锁。
 *
 * @param payload - 已通过 `verifyAssetShareToken` 验证的载荷。
 * @returns v2 密码字段存在时返回 true。
 */
export function isPasswordProtectedAssetShare(
  payload: AssetShareTokenPayload,
): payload is AssetShareTokenPayload & {
  password: NonNullable<AssetShareTokenPayload['password']>;
} {
  return payload.password !== undefined;
}

/**
 * 使用令牌内的随机 salt 异步校验原始密码。
 *
 * @param payload - 已验证的 v2 分享载荷。
 * @param password - 调用方提交的原始密码，不做 trim 或 Unicode 归一化。
 * @returns 密码摘要恒定时间匹配时返回 true；非 v2 或字段无效时返回 false。
 */
export async function verifyAssetSharePassword(
  payload: AssetShareTokenPayload,
  password: string,
): Promise<boolean> {
  if (!isPasswordProtectedAssetShare(payload) || password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  const salt = decodeCanonicalTokenPart(payload.password.salt);
  const expected = decodeCanonicalTokenPart(payload.password.hash);
  if (
    !salt ||
    salt.byteLength !== PASSWORD_SALT_BYTES ||
    !expected ||
    expected.byteLength !== PASSWORD_HASH_BYTES
  ) {
    return false;
  }
  const actual = await derivePasswordHash(password, salt);
  return timingSafeEqual(actual, expected);
}

/**
 * 签发与原分享令牌摘要绑定的短期解锁授权。
 *
 * @param shareToken - 已验证的原始 v2 分享令牌。
 * @param shareExpiresAt - 原分享毫秒级到期时间。
 * @param secret - 与分享令牌相同的稳定服务端密钥，按独立用途派生签名密钥。
 * @param now - 签发时间，默认当前毫秒时间戳。
 * @returns 独立用途授权及其 ISO 到期时间使用的毫秒值。
 * @throws 输入无效、密钥为空或原分享已经到期时抛出错误。
 */
export function createAssetShareAccessToken(
  shareToken: string,
  shareExpiresAt: number,
  secret: string,
  now = Date.now(),
): { accessToken: string; expiresAt: number } {
  if (!TOKEN_PATTERN.test(shareToken)) throw new TypeError('asset share token is invalid');
  if (!secret.trim()) throw new Error('asset share secret is required');
  if (!Number.isSafeInteger(shareExpiresAt) || shareExpiresAt <= now) {
    throw new TypeError('asset share expiration is invalid');
  }
  const expiresAt = Math.min(shareExpiresAt, now + ASSET_SHARE_ACCESS_TTL_MS);
  const payload: AssetShareAccessTokenPayload = {
    purpose: ACCESS_TOKEN_PURPOSE,
    shareTokenDigest: shareTokenDigest(shareToken),
    expiresAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signed = `${ACCESS_TOKEN_VERSION}.${encodedPayload}`;
  const signature = createHmac('sha256', accessTokenKey(secret)).update(signed).digest('base64url');
  return { accessToken: `${signed}.${signature}`, expiresAt };
}

/**
 * 校验解锁授权签名、用途、原分享摘要和双重到期边界。
 *
 * @param accessToken - 未信任的查询参数。
 * @param shareToken - 当前请求携带且已验证的原始分享令牌。
 * @param shareExpiresAt - 当前分享毫秒级到期时间。
 * @param secret - 签发端使用的稳定服务端密钥。
 * @param now - 用于判断到期的毫秒时间戳，默认当前时间。
 * @returns 校验后的授权载荷，无效时返回 undefined。
 */
export function verifyAssetShareAccessToken(
  accessToken: unknown,
  shareToken: string,
  shareExpiresAt: number,
  secret: string | undefined,
  now = Date.now(),
): AssetShareAccessTokenPayload | undefined {
  if (
    typeof accessToken !== 'string' ||
    !secret?.trim() ||
    !ACCESS_TOKEN_PATTERN.test(accessToken)
  ) {
    return undefined;
  }
  const parts = accessToken.split('.');
  if (parts.length !== 3 || parts[0] !== ACCESS_TOKEN_VERSION || !parts[1] || !parts[2]) {
    return undefined;
  }
  try {
    const encodedPayload = parts[1];
    const suppliedSignature = decodeCanonicalTokenPart(parts[2]);
    if (!suppliedSignature || suppliedSignature.byteLength !== 32) return undefined;
    const expectedSignature = createHmac('sha256', accessTokenKey(secret))
      .update(`${ACCESS_TOKEN_VERSION}.${encodedPayload}`)
      .digest();
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) return undefined;

    const payloadBytes = decodeCanonicalTokenPart(encodedPayload);
    if (!payloadBytes) return undefined;
    const payload = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
    if (
      payload.purpose !== ACCESS_TOKEN_PURPOSE ||
      typeof payload.shareTokenDigest !== 'string' ||
      !Number.isSafeInteger(payload.expiresAt) ||
      Number(payload.expiresAt) <= now ||
      Number(payload.expiresAt) > shareExpiresAt
    ) {
      return undefined;
    }
    const suppliedDigest = decodeCanonicalTokenPart(payload.shareTokenDigest);
    const expectedDigest = createHash('sha256').update(shareToken, 'utf8').digest();
    if (
      !suppliedDigest ||
      suppliedDigest.byteLength !== expectedDigest.byteLength ||
      !timingSafeEqual(suppliedDigest, expectedDigest)
    ) {
      return undefined;
    }
    return payload as AssetShareAccessTokenPayload;
  } catch {
    return undefined;
  }
}

/**
 * 使用版本绑定的密钥和 AAD 加密分享载荷，防止 v2 降级为 v1。
 *
 * @param payload - 已构造并验证边界的分享载荷。
 * @param secret - 稳定服务端密钥。
 * @param version - 决定密钥派生、AAD 和令牌前缀的格式版本。
 * @returns 四段式 AES-GCM 不透明令牌。
 */
function encryptSharePayload(
  payload: AssetShareTokenPayload,
  secret: string,
  version: typeof LEGACY_TOKEN_VERSION | typeof PASSWORD_TOKEN_VERSION,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', shareKey(secret, version), iv);
  cipher.setAAD(Buffer.from(`${TOKEN_PURPOSE}.${version}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${version}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

/**
 * 校验分享令牌的类型、用途、签名、字段和值域；到期时间等于当前时刻即失效。
 *
 * @param token - 未信任的查询参数或调用方输入。
 * @param secret - 签发端使用的稳定服务端密钥。
 * @param now - 用于判断到期的毫秒时间戳，默认当前时间。
 * @returns 校验后的固定版本载荷，无效时返回 undefined。
 */
export function verifyAssetShareToken(
  token: unknown,
  secret: string | undefined,
  now = Date.now(),
): AssetShareTokenPayload | undefined {
  if (typeof token !== 'string' || !secret?.trim() || !TOKEN_PATTERN.test(token)) {
    return undefined;
  }
  const parts = token.split('.');
  const version = parts[0];
  if (
    parts.length !== 4 ||
    (version !== LEGACY_TOKEN_VERSION && version !== PASSWORD_TOKEN_VERSION) ||
    !parts[1] ||
    !parts[2] ||
    !parts[3]
  ) {
    return undefined;
  }
  try {
    const iv = decodeCanonicalTokenPart(parts[1]);
    const ciphertext = decodeCanonicalTokenPart(parts[2]);
    const tag = decodeCanonicalTokenPart(parts[3]);
    if (!iv || !ciphertext || !tag) return undefined;
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
      return undefined;
    }
    const decipher = createDecipheriv('aes-256-gcm', shareKey(secret, version), iv);
    decipher.setAAD(Buffer.from(`${TOKEN_PURPOSE}.${version}`, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    if (
      payload.purpose !== TOKEN_PURPOSE ||
      typeof payload.assetId !== 'string' ||
      !payload.assetId ||
      typeof payload.ownerId !== 'string' ||
      !payload.ownerId ||
      !Number.isSafeInteger(payload.version) ||
      Number(payload.version) < 1 ||
      !Number.isSafeInteger(payload.expiresAt) ||
      Number(payload.expiresAt) <= now
    ) {
      return undefined;
    }
    if (version === LEGACY_TOKEN_VERSION && payload.password !== undefined) return undefined;
    if (version === PASSWORD_TOKEN_VERSION && !isValidPasswordProtection(payload.password)) {
      return undefined;
    }
    return payload as AssetShareTokenPayload;
  } catch {
    return undefined;
  }
}

/** 单段 HTTP Range 解析结果；多段和越界请求均明确拒绝。 */
export type AssetByteRange = { start: number; end: number };

/**
 * 解析单段 HTTP 字节范围。
 *
 * @param header - Range 请求头；缺失时返回 undefined。
 * @param size - 完整内容字节数。
 * @returns 有效闭区间；语法或边界无效时返回 null。
 */
export function parseAssetByteRange(
  header: string | undefined,
  size: number,
): AssetByteRange | undefined | null {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 1) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * 选择公开内容的响应类型，避免浏览器内联解释可执行格式。
 *
 * @param mimeType - 资源登记的 MIME 类型。
 * @returns 安全响应类型及是否强制附件下载。
 */
export function publicAssetContentType(mimeType: string): {
  mimeType: string;
  attachment: boolean;
} {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const inline =
    normalized === 'text/plain' ||
    (normalized.startsWith('image/') && normalized !== 'image/svg+xml') ||
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/');
  return inline
    ? { mimeType: normalized || 'application/octet-stream', attachment: false }
    : { mimeType: 'application/octet-stream', attachment: true };
}

/**
 * 从稳定服务端密钥派生仅供资源分享使用的 256 位密钥。
 *
 * @param secret - 稳定服务端密钥。
 * @returns AES-256-GCM 使用的 32 字节密钥。
 */
function shareKey(
  secret: string,
  version: typeof LEGACY_TOKEN_VERSION | typeof PASSWORD_TOKEN_VERSION,
): Buffer {
  return createHash('sha256').update(`${TOKEN_PURPOSE}.${version}\0${secret}`, 'utf8').digest();
}

/**
 * 派生仅供解锁授权签名使用的密钥。
 *
 * @param secret - 稳定服务端密钥。
 * @returns HMAC-SHA256 使用的 32 字节密钥。
 */
function accessTokenKey(secret: string): Buffer {
  return createHash('sha256')
    .update(`${ACCESS_TOKEN_PURPOSE}.${ACCESS_TOKEN_VERSION}\0${secret}`, 'utf8')
    .digest();
}

/**
 * 计算绑定解锁授权的原分享令牌摘要。
 *
 * @param token - 原始分享令牌文本。
 * @returns 规范 base64url SHA-256 摘要。
 */
function shareTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * 异步执行 scrypt，避免密码校验阻塞事件循环。
 *
 * @param password - 不做 trim 或归一化的原始密码。
 * @param salt - 令牌内固定长度的随机 salt。
 * @returns 32 字节密码摘要。
 */
function derivePasswordHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_HASH_BYTES, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * 校验 v2 密码字段的算法、规范编码和固定字节长度。
 *
 * @param value - 解密后仍不信任的密码字段。
 * @returns 字段可用于 scrypt 校验时返回 true。
 */
function isValidPasswordProtection(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.algorithm !== 'scrypt' ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.hash !== 'string'
  ) {
    return false;
  }
  const salt = decodeCanonicalTokenPart(candidate.salt);
  const hash = decodeCanonicalTokenPart(candidate.hash);
  return salt?.byteLength === PASSWORD_SALT_BYTES && hash?.byteLength === PASSWORD_HASH_BYTES;
}

/**
 * 解码并拒绝非规范 base64url，避免同一令牌出现多个文本表示。
 *
 * @param value - 一个令牌分段。
 * @returns 规范解码结果，输入不规范时返回 undefined。
 */
function decodeCanonicalTokenPart(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

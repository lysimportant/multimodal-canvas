import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 无数据库分享链接的固定有效期，单位为毫秒；需要单条撤销时应改用持久分享记录。 */
export const ASSET_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** 分享令牌格式版本；升级加密布局时必须更换并保留明确兼容边界。 */
const TOKEN_VERSION = 'v1';
/** 密钥派生和附加认证数据使用的固定用途，阻止其它令牌跨接口复用。 */
const TOKEN_PURPOSE = 'asset-share';
/** 令牌只接受规范 base64url 分段与版本分隔符，并限制请求解析成本。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,4096}$/;
/** AES-GCM 推荐的 96 位随机 IV 长度。 */
const IV_BYTES = 12;

/** 分享令牌只定位一个所有者的一项资产版本，不承载项目或生成信息。 */
export type AssetShareTokenPayload = {
  purpose: typeof TOKEN_PURPOSE;
  assetId: string;
  ownerId: string;
  version: number;
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
  input: Omit<AssetShareTokenPayload, 'purpose'>,
  secret: string,
): string {
  if (!secret.trim()) throw new Error('asset share secret is required');
  const payload: AssetShareTokenPayload = { purpose: TOKEN_PURPOSE, ...input };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', shareKey(secret), iv);
  cipher.setAAD(Buffer.from(`${TOKEN_PURPOSE}.${TOKEN_VERSION}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_VERSION}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
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
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2] || !parts[3]) {
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
    const decipher = createDecipheriv('aes-256-gcm', shareKey(secret), iv);
    decipher.setAAD(Buffer.from(`${TOKEN_PURPOSE}.${TOKEN_VERSION}`, 'utf8'));
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
function shareKey(secret: string): Buffer {
  return createHash('sha256')
    .update(`${TOKEN_PURPOSE}.${TOKEN_VERSION}\0${secret}`, 'utf8')
    .digest();
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

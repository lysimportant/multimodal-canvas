import { isIP } from 'node:net';
import {
  createProviderAssetAccessToken,
  providerAssetAccessPath,
  PROVIDER_ASSET_ACCESS_TTL_SECONDS,
  type ProviderAssetAccessGrant,
} from './provider-asset-access.js';

/** API 与 Worker 共同使用的部署环境；不读取请求来源或用户提交的地址。 */
export type ProviderAssetUrlEnvironment = Readonly<Record<string, string | undefined>>;

/** 仅为已核验归属的冻结素材版本生成临时访问地址，不写入队列或数据库。 */
export type ProviderAssetUrlSigner = (asset: Omit<ProviderAssetAccessGrant, 'expiresAt'>) => string;

/**
 * 复用部署的网站地址和稳定服务端密钥，为 Provider 生成本站 HTTPS 素材链接。
 * 本机 HTTP、私网或缺失配置时不启用；不从请求 Host 或用户输入推断域名。
 * @param environment 网站来源与稳定签名密钥；专用素材密钥优先于 API_JWT_SECRET。
 * @returns 可供 API 验签的签发器；网站尚无公网 HTTPS 入口时返回 undefined。
 * @throws 签发时资产身份、冻结版本或归属字段非法；错误不包含签名密钥。
 */
export function createProviderAssetUrlSignerFromEnvironment(
  environment: ProviderAssetUrlEnvironment = process.env,
): ProviderAssetUrlSigner | undefined {
  const webUrl = environment.CANVAS_WEB_URL?.trim();
  const secret = environment.ASSET_ACCESS_URL_SECRET?.trim() || environment.API_JWT_SECRET?.trim();
  if (!webUrl || !secret) return undefined;
  let origin: string;
  try {
    const site = new URL(webUrl);
    site.hostname = site.hostname.replace(/\.$/, '');
    origin = new URL(normalizeProviderAssetEndpoint(site.toString())).origin;
  } catch {
    return undefined;
  }
  return (asset) => {
    const token = createProviderAssetAccessToken(
      { ...asset, expiresAt: Date.now() + PROVIDER_ASSET_ACCESS_TTL_SECONDS * 1000 },
      secret,
    );
    return `${origin}${providerAssetAccessPath(asset.assetId, asset.version)}?access_token=${encodeURIComponent(token)}`;
  };
}

/**
 * 校验只用于 Provider 拉取冻结素材的对象存储 endpoint。
 * @param value 部署配置的公网 HTTPS 地址，允许路径但禁止凭据、查询和片段。
 * @returns URL 标准化结果；不修改主机尾点，保留后续 S3 签名的 Host。
 * @throws 地址格式非法、使用 HTTP 或明显属于私网/保留域名时拒绝。
 * 此检查不查询 DNS，也不能替代部署后的外部 GET 验收。
 */
export function normalizeProviderAssetEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('S3_PROVIDER_ENDPOINT must be a valid public HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isObviouslyPrivateHostname(url.hostname)
  ) {
    throw new Error('S3_PROVIDER_ENDPOINT must be a public HTTPS URL');
  }
  return url.toString();
}

/** 忽略 DNS 尾点后排除回环、私网、链路本地和保留测试域名；不做 DNS 查询。 */
function isObviouslyPrivateHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (
    ['localhost', '::', '::1'].includes(normalized) ||
    ['.localhost', '.local', '.internal', '.test', '.example', '.invalid'].some((suffix) =>
      normalized.endsWith(suffix),
    )
  ) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0, third = 0] = normalized.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      /^(?:fc|fd|fe[89ab]|ff)/.test(normalized) ||
      normalized.startsWith('::ffff:') ||
      normalized === '2001:db8::' ||
      normalized.startsWith('2001:db8:')
    );
  }
  return !normalized.includes('.');
}

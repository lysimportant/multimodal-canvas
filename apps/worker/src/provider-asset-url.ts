import {
  createProviderAssetAccessToken,
  providerAssetAccessPath,
  PROVIDER_ASSET_ACCESS_TTL_SECONDS,
  type ProviderAssetAccessGrant,
} from '@multimodal-canvas/credential-crypto';
import { normalizeProviderAssetEndpoint, type StartupEnvironment } from './startup-config.js';

/** 仅为已核验归属的冻结素材版本生成临时访问地址，不写入队列或数据库。 */
export type ProviderAssetUrlSigner = (asset: Omit<ProviderAssetAccessGrant, 'expiresAt'>) => string;

/**
 * 复用部署的网站地址和稳定服务端密钥，为 Provider 生成本站 HTTPS 素材链接。
 * 本机 HTTP、私网或缺失配置时不启用；不从请求 Host 或用户输入推断域名。
 * @returns 可供 API 验签的签发器；网站尚无公网 HTTPS 入口时返回 undefined。
 */
export function createProviderAssetUrlSignerFromEnvironment(
  environment: StartupEnvironment = process.env,
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

import type { FastifyInstance } from 'fastify';

import { verifyProviderAssetAccessToken } from '@multimodal-canvas/credential-crypto';

import type { AssetStore } from './assets';
import type { AuthStore } from './auth-store';
import { parseAssetByteRange, publicAssetContentType } from './asset-shares';
import type { ProjectStore } from './projects';

/** Provider 素材读取使用的固定路由；签名方只应通过共享路径函数生成地址。 */
export const PROVIDER_ASSET_ACCESS_ROUTE = '/v1/provider-assets/:assetId/versions/:version/content';

/** 同一来源每分钟最多读取 Provider 素材的次数。 */
export const PROVIDER_ASSET_READ_RATE_LIMIT = 120;

/** Provider 素材路由依赖；assetStore 必须已应用项目归属策略。 */
export type ProviderAssetRouteOptions = {
  /** 已通过 `withAssetOwnershipPolicy` 包装的资产存储。 */
  assetStore: AssetStore;
  /** 用于重新核对签名项目当前所有者的项目存储。 */
  projectStore: ProjectStore;
  /** 存在账户存储时，已停用或已删除的所有者不能继续读取。 */
  authStore?: AuthStore;
  /** 仅来自 ASSET_ACCESS_URL_SECRET 或 API_JWT_SECRET 的稳定密钥。 */
  secret?: string;
};

/**
 * 判断请求是否精确命中允许短期签名匿名读取的 Provider 素材路由。
 *
 * @param method HTTP 方法；只有 GET 和 HEAD 可匿名进入路由处理器。
 * @param pathname 不含查询参数的原始请求路径。
 * @returns 精确匹配固定版本内容路径时返回 true。
 */
export function isProviderAssetAccessRequest(method: string, pathname: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    /^\/v1\/provider-assets\/[^/?#]+\/versions\/[1-9][0-9]*\/content$/.test(pathname)
  );
}

/**
 * 注册仅供 Provider 读取冻结素材版本的短期签名 GET/HEAD 路由。
 *
 * 路由不签发 URL，也不读取 Host。令牌通过后仍会重新核对账户状态、项目所有权、
 * 资产归属、归档状态和 MIME；所有失败都不会返回资产元数据。
 *
 * @param app Fastify 应用实例。
 * @param options 已包装的存储、可选账户存储和稳定签名密钥。
 */
export function registerProviderAssetRoutes(
  app: FastifyInstance,
  options: ProviderAssetRouteOptions,
): void {
  app.route<{
    Params: { assetId: string; version: string };
    Querystring: { access_token?: unknown };
  }>({
    method: ['GET', 'HEAD'],
    url: PROVIDER_ASSET_ACCESS_ROUTE,
    handler: async (request, reply) => {
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');

      const version = Number(request.params.version);
      if (
        !/^[1-9][0-9]*$/.test(request.params.version) ||
        !Number.isSafeInteger(version) ||
        typeof request.query.access_token !== 'string'
      ) {
        return reply.code(401).send({ error: 'invalid or expired provider asset URL' });
      }
      const grant = verifyProviderAssetAccessToken(request.query.access_token, options.secret);
      if (!grant || grant.assetId !== request.params.assetId || grant.version !== version) {
        return reply.code(401).send({ error: 'invalid or expired provider asset URL' });
      }

      if (options.authStore) {
        const owner = await options.authStore.findUserById(grant.ownerId);
        if (!owner || owner.status !== 'active') {
          return reply.code(401).send({ error: 'invalid or expired provider asset URL' });
        }
      }

      if (grant.projectId !== null) {
        const project = await options.projectStore.get(grant.projectId, {
          ownerId: grant.ownerId,
        });
        if (!project || project.ownerId !== grant.ownerId) {
          return reply.code(404).send({ error: 'provider asset not found' });
        }
      }

      const scope = { ownerId: grant.ownerId, projectId: grant.projectId };
      const asset = options.assetStore.getMetadata
        ? await options.assetStore.getMetadata(grant.assetId, scope)
        : await options.assetStore.get(grant.assetId, scope);
      if (
        !asset ||
        asset.status !== 'ready' ||
        !isCompatibleMediaType(asset.mimeType, asset.mediaType)
      ) {
        return reply.code(404).send({ error: 'provider asset not found' });
      }
      const source = options.assetStore.getVersionContentSource
        ? await options.assetStore.getVersionContentSource(grant.assetId, grant.version, scope)
        : undefined;
      const content = options.assetStore.getVersionContentSource
        ? undefined
        : await options.assetStore.getVersionContent(grant.assetId, grant.version, scope);
      const sizeBytes = source?.sizeBytes ?? content?.byteLength;
      if (sizeBytes === undefined) {
        return reply.code(404).send({ error: 'provider asset not found' });
      }

      const range = parseAssetByteRange(request.headers.range, sizeBytes);
      const contentType = publicAssetContentType(asset.mimeType);
      reply
        .header('accept-ranges', 'bytes')
        .header(
          'content-security-policy',
          "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        .type(contentType.mimeType);
      if (contentType.attachment) reply.header('content-disposition', 'attachment');

      if (range === null) {
        return reply.header('content-range', `bytes */${sizeBytes}`).code(416).send();
      }
      const payload =
        request.method === 'HEAD'
          ? undefined
          : source
            ? await source.open(range ?? undefined)
            : range
              ? content!.subarray(range.start, range.end + 1)
              : content;
      if (request.method !== 'HEAD' && payload === undefined) {
        reply.removeHeader('content-type');
        reply.removeHeader('content-disposition');
        return reply.code(404).send({ error: 'provider asset not found' });
      }
      if (range) {
        reply
          .header('content-range', `bytes ${range.start}-${range.end}/${sizeBytes}`)
          .header('content-length', String(range.end - range.start + 1))
          .code(206);
        return reply.send(payload);
      }

      reply.header('content-length', String(sizeBytes));
      return reply.send(payload);
    },
  });
}

/** 校验资源登记的 MIME 语法及其与媒体类型的兼容关系。 */
function isCompatibleMediaType(mimeType: unknown, mediaType: unknown): boolean {
  if (typeof mimeType !== 'string' || typeof mediaType !== 'string') return false;
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) return false;
  if (mediaType === 'text') {
    return (
      normalized.startsWith('text/') ||
      normalized === 'application/json' ||
      normalized === 'application/xml'
    );
  }
  return ['image', 'audio', 'video'].includes(mediaType) && normalized.startsWith(`${mediaType}/`);
}

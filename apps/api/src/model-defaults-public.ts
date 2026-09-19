import { mediaTypes, type MediaType, type ModelSelection } from '@multimodal-canvas/domain';
import { z } from 'zod';
import { ModelMarketplaceError, type ModelMarketplace } from './model-marketplace';
import type { ProjectModelDefaults } from './projects';

/** 用户可见的默认选择，只包含展示名称和稳定商品身份，不含上游连接引用。 */
export type PublicModelSelection = Pick<ModelSelection, 'modelAlias' | 'platformModelId'>;
/** 旧默认值保留字符串形状；对象只输出公开字段，不修改已保存的设置。 */
export type PublicModelDefaults = Partial<Record<MediaType, string | PublicModelSelection>>;
/** 已解析的默认视图统一返回对象；无法映射时保留原选择，缺少平台 ID 表示必须重新选择。 */
export type ResolvedModelDefaults = Partial<Record<MediaType, PublicModelSelection>>;

/**
 * 裁剪项目默认值，避免普通账户读写默认设置时收到内部连接 ID。
 * @param defaults 原始项目默认值；未配置的媒体类型保持缺省。
 * @returns 新的公开对象，保留旧 alias 与已保存的平台身份，不修改持久数据。
 */
export function publicModelDefaults(defaults: ProjectModelDefaults): PublicModelDefaults {
  const output: PublicModelDefaults = {};
  for (const mediaType of mediaTypes) {
    const selection = defaults[mediaType];
    if (selection === undefined) continue;
    output[mediaType] =
      typeof selection === 'string'
        ? selection
        : {
            modelAlias: selection.modelAlias,
            ...(selection.platformModelId ? { platformModelId: selection.platformModelId } : {}),
          };
  }
  return output;
}

/**
 * 在服务端把当前默认值解析为公开平台身份，使用与运行入口相同的精确匹配规则。
 * @param defaults 当前作用域默认值，不混入其他连接的默认模型。
 * @param marketplace 商品服务；已有平台 ID 优先，否则按 alias、原连接和媒体类型唯一解析。
 * @returns 不含连接信息的默认视图；停用、缺价、歧义或无效旧记录保留原选择，不替换为首个商品。
 * @throws 数据库或服务故障继续向上抛出，不能把读取失败伪装成没有默认模型。
 */
export async function resolvePublicModelDefaults(
  defaults: ProjectModelDefaults,
  marketplace: Pick<ModelMarketplace, 'resolvePublishedModel' | 'resolveLegacyModel'>,
): Promise<ResolvedModelDefaults> {
  const output: ResolvedModelDefaults = {};
  for (const mediaType of mediaTypes) {
    const configured = defaults[mediaType];
    if (configured === undefined) continue;
    const selection = typeof configured === 'string' ? { modelAlias: configured } : configured;
    const preserved: PublicModelSelection = {
      modelAlias: selection.modelAlias,
      ...(selection.platformModelId ? { platformModelId: selection.platformModelId } : {}),
    };
    output[mediaType] = preserved;
    try {
      const resolved = selection.platformModelId
        ? await marketplace.resolvePublishedModel(selection.platformModelId)
        : await marketplace.resolveLegacyModel(
            selection.modelAlias.trim(),
            selection.credentialId,
            mediaType,
          );
      if (resolved.model.mediaType.toLowerCase() !== mediaType) continue;
      output[mediaType] = {
        modelAlias: resolved.binding.upstreamModelId,
        platformModelId: resolved.model.id,
      };
    } catch (error) {
      if (error instanceof z.ZodError) continue;
      if (error instanceof ModelMarketplaceError && error.status < 500) continue;
      throw error;
    }
  }
  return output;
}

/**
 * 为项目默认值 GET/PATCH 生成一致响应；内部设置只对有配置权限的调用者保留。
 * @returns defaults 保持原管理视图或公开裁剪视图；启用广场时额外提供 resolvedDefaults。
 * @throws 商品服务的基础设施错误继续抛出；不写入默认设置或发起 Provider 请求。
 */
export async function projectModelDefaultsResponse(input: {
  defaults: ProjectModelDefaults;
  marketplace?: ModelMarketplace;
  canManageSettings: boolean;
}) {
  return {
    defaults: input.canManageSettings ? input.defaults : publicModelDefaults(input.defaults),
    ...(input.marketplace
      ? { resolvedDefaults: await resolvePublicModelDefaults(input.defaults, input.marketplace) }
      : {}),
  };
}

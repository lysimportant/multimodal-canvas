import {
  formatCnyNanos,
  marketplaceModelSchema,
  type BillingPriceRule,
  type MarketplaceModel,
} from '@multimodal-canvas/domain';
import { managementRequest } from '../management/client';

/** 广场查询只使用服务端公开字段；每页上限一百，切换账户由外层查询键隔离。 */
export async function fetchMarketplace(
  input: { query?: string; mediaType?: string; page?: number; signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams({ page: String(input.page ?? 1), pageSize: '100' });
  if (input.query) params.set('query', input.query);
  if (input.mediaType) params.set('mediaType', input.mediaType);
  const result = await managementRequest<{ items: unknown[]; total: number }>(
    `/model-marketplace?${params}`,
    { signal: input.signal },
  );
  return {
    items: result.items.map((item) => marketplaceModelSchema.parse(item)),
    total: result.total,
  };
}

/** 将精确整数售价转换为用户可读的人民币与计费单位，保留微额小数。 */
export function marketplacePriceLabel(rule: BillingPriceRule | undefined): string {
  if (!rule) return '暂未定价';
  if (rule.unit === 'per_token')
    return `输入 ¥${formatCnyNanos(rule.inputPriceNanos)} / 百万 Token · 输出 ¥${formatCnyNanos(rule.outputPriceNanos)} / 百万 Token`;
  const labels = { per_call: '次', per_image: '张', per_second: '秒', per_character: '字符' };
  return `¥${formatCnyNanos(rule.unitPriceNanos)} / ${labels[rule.unit]}${rule.variants ? '起（按规格）' : ''}`;
}

/** 节点目录沿用实际模型字符串识别已知参数族，同时额外保存平台稳定身份。 */
export function marketplaceSelection(model: MarketplaceModel) {
  return {
    id: model.modelAlias ?? model.id,
    platformModelId: model.id,
    name: model.name,
    mediaTypes: [model.mediaType],
    capabilities: model.capabilities,
    limitations: model.limitations,
    price: model.pricing?.rule,
    availability: model.availability,
    pricing: model.pricing,
  };
}

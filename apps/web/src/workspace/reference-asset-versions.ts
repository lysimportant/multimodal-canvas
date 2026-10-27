/**
 * 为「添加参考资料」按需补齐画布来源的最新资源版本。
 *
 * 资源索引只加载当前分页，画布上的来源节点又只带不带版本号的内容地址；
 * 此时直接引用会被 createSelectedNodesPromptDocument 判为资源版本未知。
 * 这里读取服务端的不可变版本列表，用最高版本补齐目录条目后再重试引用。
 */
import type { Asset } from '@multimodal-canvas/domain';

import { apiFetch } from '../auth-client';
import type { AssetFlowNode } from '../canvas-utils';
import { fetchAssetVersions, type AssetVersionSummary } from '../result-versions';
import { canvasAssetSeeds } from '../use-project-assets';
import { missingReferenceAssetVersions } from './connected-prompt-assets';
import { API_BASE_URL } from './contracts';

/** 补齐版本后的资源目录，以及需要写回全局索引的新条目。 */
export type ResolvedReferenceAssets = {
  /** 供本次添加使用的目录；按 id 合并补齐条目，没有缺失时原样返回。 */
  assets: readonly Asset[];
  /** 本次新解析出的目录条目，调用方需要合并进全局资源索引。 */
  resolved: Asset[];
};

/** 测试可注入 API 地址与 fetch 实现，生产环境使用默认值。 */
export type ResolveReferenceAssetsOptions = {
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
};

/**
 * 为本次添加的参考来源补齐目录中缺失的最新版本。
 * @param sources 本次添加的参考来源节点。
 * @param assets 当前已加载资源目录；可能缺少页外来源的最新版。
 * @param options 可注入的 API 地址与 fetch 实现。
 * @returns 合并后的目录与新增条目；没有缺失时不发起请求并原样返回目录。
 * @throws 来源资源无法构造、版本列表为空或版本读取失败时整次拒绝。
 */
export async function ensureReferenceAssetVersions(
  sources: readonly AssetFlowNode[],
  assets: readonly Asset[],
  options: ResolveReferenceAssetsOptions = {},
): Promise<ResolvedReferenceAssets> {
  const missing = missingReferenceAssetVersions(sources, assets);
  if (missing.length === 0) return { assets, resolved: [] };
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_URL;
  const fetcher = options.fetcher ?? apiFetch;
  const resolved: Asset[] = [];
  for (const target of missing) {
    const node = sources.find((source) => source.id === target.sourceNodeId);
    const catalog = assets.find((asset) => asset.id === target.assetId);
    const base = catalog ?? (node ? canvasAssetSeeds([node])[0] : undefined);
    if (!base) throw new Error('「' + target.label + '」的资源版本未知，请先确认当前素材');
    let versions: AssetVersionSummary[];
    try {
      versions = await fetchAssetVersions(target.assetId, apiBaseUrl, fetcher);
    } catch (error) {
      throw new Error('「' + target.label + '」的资源版本读取失败，请稍后重试', { cause: error });
    }
    const latest = versions.at(-1);
    if (!latest) throw new Error('「' + target.label + '」的资源版本未知，请先确认当前素材');
    resolved.push({ ...base, latestVersion: latest.version });
  }
  const merged = new Map(assets.map((asset) => [asset.id, asset]));
  for (const asset of resolved) merged.set(asset.id, asset);
  return { assets: [...merged.values()], resolved };
}

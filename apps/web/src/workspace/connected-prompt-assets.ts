/**
 * 收集提示词资源条可用的连线输入，并补齐生成结果的预览地址。
 */
import type { Asset } from '@multimodal-canvas/domain';

import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { resultAssetContentUrl } from './node-echo-text';

/** 提示词资源条使用的连线资源，至少要能预览。 */
export type ConnectedPromptAsset = Pick<Asset, 'id' | 'name' | 'mediaType'> &
  Partial<Pick<Asset, 'contentUrl' | 'mimeType' | 'status' | 'sizeBytes' | 'tags'>>;

/**
 * 收集可出现在提示词「引用资源」条里的上游资源。
 * 图生图原图已经在来源图预览里，不重复放进资源条。
 * @param nodeId 当前编辑的节点。
 * @param nodes 画布节点。
 * @param edges 画布边。
 * @param assets 项目资源目录。
 * @returns 去重后的连线资源；没有可预览地址时仍返回身份，供诊断。
 */
export function collectConnectedPromptAssets(
  nodeId: string,
  nodes: readonly AssetFlowNode[],
  edges: readonly FlowEdge[],
  assets: readonly Asset[] = [],
): ConnectedPromptAsset[] {
  const items: ConnectedPromptAsset[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    if (edge.targetHandle === 'input:imageEdit') continue;
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) continue;
    const result = source.data.resultAsset;
    const assetId = result?.assetId ?? source.data.assetId;
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    const catalog = assets.find((asset) => asset.id === assetId);
    const contentUrl =
      catalog?.contentUrl ??
      result?.contentUrl ??
      source.data.contentUrl ??
      resultAssetContentUrl(assetId, result?.version);
    items.push({
      id: assetId,
      name: catalog?.name ?? source.data.label,
      mediaType: source.data.mediaType,
      contentUrl,
      mimeType: catalog?.mimeType ?? result?.mimeType ?? source.data.mimeType ?? '',
      status: catalog?.status ?? 'ready',
      sizeBytes: catalog?.sizeBytes ?? result?.sizeBytes ?? 0,
      tags: catalog?.tags ?? [],
    });
  }
  return items;
}

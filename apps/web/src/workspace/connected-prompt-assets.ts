/**
 * 收集提示词资源条可用的连线输入，并补齐生成结果的预览地址。
 */
import type { Asset } from '@multimodal-canvas/domain';

import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { nodeEchoAssetVersion, resultAssetContentUrl } from './node-echo-text';

/** 提示词资源条使用的连线资源，至少要能预览。 */
export type ConnectedPromptAsset = Pick<Asset, 'id' | 'name' | 'mediaType'> &
  Partial<Pick<Asset, 'contentUrl' | 'mimeType' | 'status' | 'sizeBytes' | 'tags'>> & {
    /** 当前目标节点保存的引用别名，不修改资源库文件名。 */
    referenceName?: string;
    /** 目标引用或来源回显已确定的版本；不因资源目录更新而替换。 */
    assetVersion?: number;
    /** 尚未冻结的旧别名，仅用于只读恢复投影。 */
    referenceNeedsSync?: boolean;
    /** 生成来源版本未知，不能借资源目录最新版建立引用。 */
    versionUnavailable?: boolean;
  };

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
  const references = nodes.find((node) => node.id === nodeId)?.data.resourceRefs ?? [];
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    if (edge.targetHandle === 'input:imageEdit') continue;
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) continue;
    const result = source.data.resultAsset;
    const assetId = result?.assetId ?? source.data.assetId;
    if (!assetId) continue;
    const catalog = assets.find((asset) => asset.id === assetId);
    const reference =
      references.find((reference) => reference.id === `connected:${assetId}`) ??
      references.find((reference) => reference.assetId === assetId);
    const assetVersion =
      reference?.assetVersion ??
      nodeEchoAssetVersion(source) ??
      (source.data.mode === 'source' && !result ? catalog?.latestVersion : undefined);
    const versionUnavailable = assetVersion === undefined && source.data.mode !== 'source';
    const identity = JSON.stringify([assetId, assetVersion]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const contentUrl =
      assetVersion !== undefined
        ? resultAssetContentUrl(assetId, assetVersion)
        : versionUnavailable
          ? undefined
          : (catalog?.contentUrl ??
            result?.contentUrl ??
            source.data.contentUrl ??
            resultAssetContentUrl(assetId));
    items.push({
      id: assetId,
      name: catalog?.name ?? source.data.label,
      ...(reference?.name ? { referenceName: reference.name } : {}),
      ...(reference && reference.assetVersion === undefined ? { referenceNeedsSync: true } : {}),
      ...(assetVersion !== undefined ? { assetVersion } : {}),
      ...(versionUnavailable ? { versionUnavailable: true } : {}),
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

/**
 * 图片编辑来源图预览：解析冻结原图地址，并收成 AssetPreview 可用的资源。
 */
import type { Asset } from '@multimodal-canvas/domain';
import { imageEditSourceOf } from '@multimodal-canvas/domain';

import type { AssetFlowNode } from '../canvas-utils';
import { nodeEchoContentUrl, resultAssetContentUrl } from './node-echo-text';

/** 图片编辑节点上只读展示的来源图身份。 */
export type ImageEditSourcePreview = {
  /** 冻结的来源资产 ID。 */
  assetId: string;
  /** 来源画布节点 ID，用于说明这张图来自哪个节点。 */
  sourceNodeId: string;
  /** 来源节点或资源的显示名。 */
  name: string;
  /** 只读缩略图地址；来源不可访问时缺省。 */
  contentUrl?: string;
  /** 来源媒体 MIME 类型。 */
  mimeType?: string;
  /** 创建编辑节点时已知的资产版本，仅作固定版本标识展示。 */
  version?: number;
  /** 来源资产已不可读取或与节点记录不一致，提交前必须阻止运行。 */
  versionUnavailable?: boolean;
};

/**
 * 解析图片编辑节点的只读来源图预览。
 *
 * 生成结果往往不在项目目录里，优先用来源节点回显和 resultAsset，再回退目录与版本化内容路径。
 *
 * @param node 当前打开的快速编辑器节点。
 * @param nodes 画布全部节点。
 * @param assets 当前项目可访问资源，用于补齐资源名和最新版本。
 * @returns 命中图片编辑语义时的来源描述；普通生成节点返回 undefined。
 */
export function resolveImageEditSourcePreview(
  node: AssetFlowNode,
  nodes: readonly AssetFlowNode[],
  assets: readonly Asset[] = [],
): ImageEditSourcePreview | undefined {
  const source = imageEditSourceOf(node.data);
  if (!source) return undefined;
  const sourceNode = nodes.find((candidate) => candidate.id === source.sourceNodeId);
  const catalogAsset = assets.find((asset) => asset.id === source.assetId);
  const resultAsset =
    sourceNode?.data.resultAsset?.assetId === source.assetId
      ? sourceNode.data.resultAsset
      : undefined;
  const stillMatchesSource = Boolean(
    sourceNode &&
    (sourceNode.data.assetId === source.assetId ||
      sourceNode.data.resultAsset?.assetId === source.assetId),
  );
  const matchedNodeUrl = stillMatchesSource
    ? (resultAsset?.contentUrl ??
      (sourceNode?.data.assetId === source.assetId ? sourceNode.data.contentUrl : undefined) ??
      (sourceNode ? nodeEchoContentUrl(sourceNode) : undefined))
    : undefined;
  const resolvedContentUrl =
    matchedNodeUrl ??
    catalogAsset?.contentUrl ??
    resultAsset?.contentUrl ??
    resultAssetContentUrl(source.assetId, source.version);
  const version = source.version ?? resultAsset?.version ?? catalogAsset?.latestVersion;
  return {
    assetId: source.assetId,
    sourceNodeId: source.sourceNodeId,
    name: sourceNode?.data.label ?? catalogAsset?.name ?? source.assetId,
    ...(resolvedContentUrl ? { contentUrl: resolvedContentUrl } : {}),
    mimeType:
      resultAsset?.mimeType ?? sourceNode?.data.mimeType ?? catalogAsset?.mimeType ?? 'image/png',
    ...(version ? { version } : {}),
    versionUnavailable: !stillMatchesSource && !resultAsset,
  };
}

/**
 * 把来源图预览收成 AssetPreview 可用的资源，以便走 access-url 签名。
 * @param source 已解析的来源图。
 * @returns 有内容地址时可预览的资源；否则 undefined。
 */
export function imageEditSourcePreviewAsset(source: ImageEditSourcePreview): Asset | undefined {
  if (!source.contentUrl) return undefined;
  return {
    id: source.assetId,
    name: source.name,
    mediaType: 'image',
    mimeType: source.mimeType?.trim() || 'image/png',
    sizeBytes: 0,
    status: 'ready',
    contentUrl: source.contentUrl,
    tags: [],
    ...(source.version ? { latestVersion: source.version } : {}),
  };
}

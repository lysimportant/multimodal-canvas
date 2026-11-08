import {
  portRoleSchema,
  videoPromptReferenceIdentity,
  type Asset,
  type PortRole,
} from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { nodeEchoAssetVersion } from './node-echo-text';

/** 已连接但目前无法解析为明确素材版本的来源，不能冒充有效引用。 */
type PendingVideoInput = { nodeId: string; label: string; role: PortRole; reason: string };

/**
 * 按来源实际固定版本统计可解析的连线输入；最终文件可读性仍由提交前预检负责。
 * 不使用目标的显示别名覆盖来源版本，不合并未知版本或不同用途。
 */
export function summarizeConnectedVideoInputs(
  nodeId: string,
  nodes: readonly AssetFlowNode[],
  edges: readonly Pick<FlowEdge, 'source' | 'target' | 'targetHandle'>[],
  assets: readonly Asset[] = [],
): { roles: PortRole[]; counts: Map<PortRole, number>; pending: PendingVideoInput[] } {
  const sources = new Map(nodes.map((node) => [node.id, node]));
  const catalog = new Map(assets.map((asset) => [asset.id, asset]));
  const seen = new Set<string>();
  const roles: PortRole[] = [];
  const counts = new Map<PortRole, number>();
  const pending: PendingVideoInput[] = [];
  for (const edge of edges) {
    if (edge.target !== nodeId || !edge.targetHandle?.startsWith('input:')) continue;
    const role = portRoleSchema.safeParse(edge.targetHandle.slice('input:'.length));
    if (!role.success) continue;
    const source = sources.get(edge.source);
    if (source?.data.enabled === false) continue;
    roles.push(role.data);
    const result = source?.data.manualOutput ? undefined : source?.data.resultAsset;
    const assetId = result?.assetId ?? source?.data.assetId;
    const asset = assetId ? catalog.get(assetId) : undefined;
    if (source?.data.mediaType === 'text') {
      // 纯文字来源可以直接贡献 prompt，无需上传资产；Provider 不对文字输入按媒体身份去重。
      const hasText =
        source.data.promptDocument?.blocks.some((block) =>
          block.type === 'text' ? block.text.trim().length > 0 : true,
        ) ?? !!source.data.prompt?.trim();
      if (hasText || assetId || source.data.contentUrl) {
        counts.set(role.data, (counts.get(role.data) ?? 0) + 1);
      } else {
        pending.push({
          nodeId: source.id,
          label: source.data.label,
          role: role.data,
          reason: '尚无文字内容',
        });
      }
      continue;
    }
    const assetVersion = source
      ? (nodeEchoAssetVersion(source) ??
        (source.data.mode === 'source' && !result ? asset?.latestVersion : undefined))
      : undefined;
    const reason = !source
      ? '来源节点不存在'
      : !assetId
        ? '尚无素材'
        : asset &&
            (asset.status !== 'ready' ||
              asset.archivedAt ||
              asset.mediaType !== source.data.mediaType)
          ? '素材不可用'
          : assetVersion === undefined
            ? '素材版本未知'
            : undefined;
    if (reason) {
      pending.push({
        nodeId: edge.source,
        label: source?.data.label ?? edge.source,
        role: role.data,
        reason,
      });
      continue;
    }
    const identity = videoPromptReferenceIdentity({
      assetId: assetId!,
      assetVersion,
      mediaType: source!.data.mediaType as 'image' | 'video' | 'audio',
      role: role.data,
    });
    if (seen.has(identity)) continue;
    seen.add(identity);
    counts.set(role.data, (counts.get(role.data) ?? 0) + 1);
  }
  return { roles, counts, pending };
}

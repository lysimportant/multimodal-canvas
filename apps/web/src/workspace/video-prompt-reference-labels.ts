import {
  buildVideoPromptReferences,
  collectVideoInputSet,
  getExecutionPromptDocument,
  orderVideoPromptMedia,
  videoInputRoleForPromptMention,
  videoPromptReferenceIdentity,
  yuanliuVideoContractForModel,
  type NodeResourceRef,
  type PromptDocument,
  type RunInputSnapshot,
  type VideoMode,
  type VideoPromptMediaDescriptor,
} from '@multimodal-canvas/domain';
import type { ConnectedPromptAsset } from './connected-prompt-assets';

export type VideoPromptReferenceContext = {
  modelAlias?: string;
  videoMode?: VideoMode;
};

/** 将前端冻结身份投影成执行层输入；编号与请求共用分类、排序和标记函数。 */
export function videoPromptReferenceLabels(
  context: VideoPromptReferenceContext,
  document: PromptDocument | undefined,
  connectedAssets: readonly ConnectedPromptAsset[] = [],
  resourceRefs: readonly NodeResourceRef[] = [],
): ReadonlyMap<string, readonly string[]> {
  const inputs: RunInputSnapshot[] = [];
  for (const asset of connectedAssets) {
    if (asset.versionUnavailable || asset.assetVersion === undefined) continue;
    for (const binding of asset.videoInputBindings ?? []) {
      inputs.push({
        ...binding,
        sourceAssetId: asset.id,
        sourceAssetVersion: asset.assetVersion,
        snapshot: {
          id: binding.nodeId,
          type: asset.mediaType,
          position: { x: 0, y: 0 },
          data: {
            label: asset.name,
            mediaType: asset.mediaType,
            mode: 'source',
            assetId: asset.id,
          },
        },
      });
    }
  }
  const identities = new Set(
    inputs.map((input) =>
      JSON.stringify([input.sourceAssetId, input.sourceAssetVersion, input.role]),
    ),
  );
  const executionDocument = getExecutionPromptDocument({ promptDocument: document, resourceRefs });
  const mentions = executionDocument?.blocks.filter((block) => block.type === 'mention') ?? [];
  for (const [index, mention] of mentions.entries()) {
    // 未冻结的历史引用不借最新版猜编号，发送前由 API 解析真实版本。
    if (mention.assetVersion === undefined || mention.placeholder || mention.placeholderReason)
      continue;
    const role = videoInputRoleForPromptMention(
      mention.mediaType,
      context.videoMode,
      context.modelAlias,
    );
    if (!role) continue;
    const identity = JSON.stringify([mention.assetId, mention.assetVersion, role]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    const nodeId = `mention:${mention.mentionId}`;
    inputs.push({
      nodeId,
      role,
      sortOrder: 10_000 + index,
      sourceAssetId: mention.assetId,
      sourceAssetVersion: mention.assetVersion,
      snapshot: {
        id: nodeId,
        type: mention.mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: mention.label,
          mediaType: mention.mediaType,
          mode: 'source',
          assetId: mention.assetId,
        },
      },
    });
  }
  const mode =
    context.videoMode ??
    (yuanliuVideoContractForModel(context.modelAlias) ? 'omni_reference' : undefined);
  const { inputSet, issues } = collectVideoInputSet(inputs, mode);
  if (issues.length) return new Map();
  const selected = [
    inputSet.firstFrame,
    inputSet.lastFrame,
    ...inputSet.character,
    ...inputSet.style,
    ...inputSet.referenceImage,
    ...inputSet.content,
    ...inputSet.audioTrack,
  ].filter((input): input is RunInputSnapshot => input !== undefined);
  const descriptors: Array<VideoPromptMediaDescriptor & { nodeId: string; sortOrder: number }> = [];
  for (const input of selected) {
    const mediaType = input.snapshot.data.mediaType;
    if (mediaType === 'text' || !input.sourceAssetId) continue;
    descriptors.push({
      assetId: input.sourceAssetId,
      assetVersion: input.sourceAssetVersion,
      mediaType,
      role:
        input === inputSet.firstFrame
          ? 'firstFrame'
          : input === inputSet.lastFrame
            ? 'lastFrame'
            : input.role,
      nodeId: input.nodeId,
      sortOrder: input.sortOrder,
    });
  }
  const seen = new Set<string>();
  const deduplicate =
    executionDocument?.blocks.some(
      (block) =>
        block.type === 'mention' &&
        block.inline &&
        !block.executionOnly &&
        block.mediaType !== 'text',
    ) ?? false;
  const ordered = orderVideoPromptMedia(descriptors, resourceRefs).filter((item) => {
    if (!deduplicate) return true;
    const key = videoPromptReferenceIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const labels = new Map<string, string[]>();
  for (const reference of buildVideoPromptReferences(ordered, 'generic', { deduplicate })) {
    const key = JSON.stringify([reference.assetId, reference.assetVersion]);
    const previous = labels.get(key) ?? [];
    if (!previous.includes(reference.displayLabel)) previous.push(reference.displayLabel);
    labels.set(key, previous);
  }
  return labels;
}

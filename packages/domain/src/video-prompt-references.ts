import {
  videoFamilyForModel,
  videoInputRoleForPromptMention,
  type NodeResourceRef,
  type PromptDocument,
  type PromptMention,
  type VideoMode,
  type VideoReferenceSyntax,
} from './index.js';

export type VideoPromptMediaDescriptor = {
  assetId: string;
  assetVersion?: number;
  mediaType: 'image' | 'video' | 'audio';
  role?: string;
};

export type VideoPromptTokenFamily = 'seedance' | 'wan' | 'h3' | 'generic';

/** 独立出现的 h3 段（如 `mt-h3`、`h3-official`），用于识别家族表未收录的 H3 渠道别名。 */
const H3_ALIAS_PATTERN = /(?:^|[-_.])h3(?:$|[-_.])/i;

/** 预览和 Provider 使用同一套模型素材编号语法。 */
export function videoPromptTokenFamilyForModel(modelAlias?: string): VideoPromptTokenFamily {
  const family = videoFamilyForModel(modelAlias);
  if (family.includes('seedance')) return 'seedance';
  if (family.startsWith('wan')) return 'wan';
  // 933 / ManSui 等渠道把官方 H3 暴露为家族表未收录的别名（如 `mt-h3`）：
  // 这些模型仍按 H3 官方六段格式使用 `<Picture N>` / `<Video N>` / `<Audio N>`，
  // 不能因为家族未知就退化成通用 `Image N`。
  if (family.includes('minimax-h3') || H3_ALIAS_PATTERN.test((modelAlias ?? '').trim()))
    return 'h3';
  return 'generic';
}

/**
 * 节点级“转换语法器”优先：显式覆盖值大于按模型家族自动匹配的默认语法。
 * 仅影响正文内联引用的编号写法，不改变发送结构或上游协议。
 */
export function videoPromptTokenFamilyForNode(
  modelAlias: string | undefined,
  override: VideoReferenceSyntax | undefined,
): VideoPromptTokenFamily {
  return override ?? videoPromptTokenFamilyForModel(modelAlias);
}

export class VideoPromptReferenceMappingError extends Error {
  constructor(readonly mention: PromptMention) {
    super('视频引用没有对应的实际发送素材');
    this.name = 'VideoPromptReferenceMappingError';
  }
}

/**
 * 按最终发送素材身份替换内联提及，不推测文件名或修改普通正文。
 * Provider 可提供冻结版本解析器；预览使用当前文档中已解析的资产版本。
 */
export function renderVideoPromptReferenceDocument(
  document: PromptDocument,
  references: readonly { identity: string; token: string }[],
  context: {
    modelAlias?: string;
    videoMode?: VideoMode;
    resolveAssetVersion?: (mention: PromptMention) => number | undefined;
  },
): PromptDocument {
  const byIdentity = new Map(references.map((item) => [item.identity, item]));
  return {
    ...document,
    blocks: document.blocks.map((block, blockIndex) => {
      if (block.type === 'text') return block;
      if (block.executionOnly) return { type: 'text' as const, text: '' };
      if (!block.inline || block.mediaType === 'text') return block;
      const reference = byIdentity.get(
        videoPromptReferenceIdentity({
          assetId: block.assetId,
          assetVersion: context.resolveAssetVersion?.(block) ?? block.assetVersion,
          mediaType: block.mediaType,
          role: videoInputRoleForPromptMention(
            block.mediaType,
            context.videoMode,
            context.modelAlias,
          ),
        }),
      );
      if (!reference) throw new VideoPromptReferenceMappingError(block);
      const entityName = block.entityName?.trim() || block.binding?.entityName?.trim();
      let text = entityName ? `${reference.token}（${entityName}）` : reference.token;
      const nextBlock = document.blocks
        .slice(blockIndex + 1)
        .find((next) => (next.type === 'text' ? next.text.length > 0 : !next.executionOnly));
      // 避免“图1”+“2人”合并成“图12人”，同时保留其余正文空白。
      if (
        /\p{Decimal_Number}$/u.test(text) &&
        nextBlock?.type === 'text' &&
        /^\p{Decimal_Number}/u.test(nextBlock.text)
      )
        text += ' ';
      return { type: 'text' as const, text };
    }),
  };
}

/** 资产版本和输入角色共同标识实际发送项；显示名不参与身份。 */
export function videoPromptReferenceIdentity(item: VideoPromptMediaDescriptor): string {
  return JSON.stringify([item.assetId, item.assetVersion ?? null, item.mediaType, item.role ?? '']);
}

/**
 * 按实际发送顺序分类型计数，重复的同身份项复用编号。
 * Seedance / Wan 使用中文指南的素材指代，H3 保留专用标签。
 * 来源与替换边界见 docs/video-prompt-references.md；不改写用户普通文本。
 */
export function buildVideoPromptReferences<T extends VideoPromptMediaDescriptor>(
  items: readonly T[],
  family: VideoPromptTokenFamily = 'generic',
  options: { deduplicate?: boolean } = {},
): Array<T & { identity: string; index: number; displayLabel: string; token: string }> {
  const counts = { image: 0, video: 0, audio: 0 };
  const indexes = new Map<string, number>();
  return items.map((item) => {
    const identity = videoPromptReferenceIdentity(item);
    let index = options.deduplicate === false ? undefined : indexes.get(identity);
    if (index === undefined) {
      index = ++counts[item.mediaType];
      indexes.set(identity, index);
    }
    const english = { image: 'Image', video: 'Video', audio: 'Audio' }[item.mediaType];
    const chinese = { image: '图', video: '视频', audio: '音频' }[item.mediaType];
    const token =
      family === 'seedance'
        ? `${chinese} ${index}`
        : family === 'wan'
          ? `${chinese}${index}`
          : family === 'h3'
            ? `<${item.mediaType === 'image' ? 'Picture' : english} ${index}>`
            : `${english} ${index}`;
    return { ...item, identity, index, displayLabel: `${english}${index}`, token };
  });
}

/** 首尾帧保持既有发送槽位，其余素材使用显式资源条顺序。 */
export function orderVideoPromptMedia<
  T extends VideoPromptMediaDescriptor & { nodeId: string; sortOrder: number },
>(inputs: readonly T[], resourceRefs?: readonly NodeResourceRef[]): T[] {
  const media = [...inputs].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.nodeId.localeCompare(b.nodeId),
  );
  if (!resourceRefs?.some((ref) => ref.attached || ref.id.startsWith('ordered:'))) return media;
  const orders = new Map<string, number>();
  resourceRefs.forEach((ref, index) => {
    if (ref.assetVersion === undefined) return;
    const key = JSON.stringify([ref.assetId, ref.assetVersion]);
    if (!orders.has(key)) orders.set(key, index);
  });
  const keyframe = (item: T) => item.role === 'firstFrame' || item.role === 'lastFrame';
  const references = media
    .filter((item) => !keyframe(item))
    .map((item, index) => ({
      item,
      index,
      order: orders.get(JSON.stringify([item.assetId, item.assetVersion])) ?? resourceRefs.length,
    }))
    .sort((a, b) => a.order - b.order || a.index - b.index);
  let index = 0;
  return media.map((item) => (keyframe(item) ? item : references[index++]!.item));
}

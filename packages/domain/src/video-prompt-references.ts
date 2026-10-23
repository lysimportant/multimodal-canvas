import type { NodeResourceRef } from './index.js';

export type VideoPromptMediaDescriptor = {
  assetId: string;
  assetVersion?: number;
  mediaType: 'image' | 'video' | 'audio';
  role?: string;
};

export type VideoPromptTokenFamily = 'seedance' | 'wan' | 'h3' | 'generic';

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

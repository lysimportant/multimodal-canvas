import {
  mentionDisplayName,
  promptDocumentSchema,
  type NodeResourceRef,
  type PromptDocument,
} from '@multimodal-canvas/domain';

import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';

/**
 * 生成文档内不重复的提及 ID；不重建已有提及。
 * @param existingIds 当前文档已占用的 ID。
 * @returns 未占用的新 ID；随机值碰撞时追加数字后缀。
 */
export function createPromptMentionId(existingIds: Iterable<string>): string {
  const occupied = new Set(existingIds);
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `mention_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (!occupied.has(random)) return random;
  let suffix = 2;
  while (occupied.has(`${random}_${suffix}`)) suffix += 1;
  return `${random}_${suffix}`;
}

/**
 * ASCII 别名只匹配独立词；中文沿用连续正文中的完整名称匹配。
 * @param text 原始文字块。
 * @param start 名称起点，UTF-16 索引。
 * @param end 名称终点，不含该位置。
 * @param name 已匹配的完整名称。
 * @returns 该文字范围是否可提升为引用。
 */
export function canPromoteResourceNameAt(
  text: string,
  start: number,
  end: number,
  name: string,
): boolean {
  if (!name) return false;
  if (![...name].every((character) => character.charCodeAt(0) <= 127)) return true;
  const left = start === 0 ? '' : (text[start - 1] ?? '');
  const right = end >= text.length ? '' : (text[end] ?? '');
  return !/[A-Za-z0-9_]/u.test(left) && !/[A-Za-z0-9_]/u.test(right);
}

/**
 * 将显式命名的连线资源同步到正文，只拆分匹配的文字块，不追加或替换普通文字。
 * @param input 目标节点当前提示词；已有结构化文档优先。
 * @param resource 经目标节点连线解析的资产、版本和旧别名。
 * @param name 已校验的新别名。
 * @returns 有变化时返回文档；没有匹配内容时返回 undefined，保留旧纯文本格式。
 * @throws 同名引用属于不同资产/版本或结果超出文档限制时拒绝更新。
 */
export function renameConnectedPromptDocument(
  input: { prompt?: string; promptDocument?: PromptDocument },
  resource: ConnectedPromptAsset,
  name: string,
): PromptDocument | undefined {
  if (!name || name.trim() !== name || name.length > 160) {
    throw new Error('资源名称应为 1 至 160 个字符，且不含首尾空白');
  }
  if (resource.versionUnavailable) {
    throw new Error('连线生成结果缺少明确版本，请等待来源结果恢复后再引用');
  }
  const document: PromptDocument = input.promptDocument ?? {
    version: 1,
    blocks: [{ type: 'text', text: input.prompt ?? '' }],
  };
  const mentions = document.blocks.filter((block) => block.type === 'mention');
  const matching = mentions.filter(
    (mention) => mention.assetId === resource.id && mention.assetVersion === resource.assetVersion,
  );
  if (
    mentions.some((mention) => mentionDisplayName(mention) === name && !matching.includes(mention))
  ) {
    throw new Error('这个名字已被其他资源或版本占用');
  }
  const previousName = resource.referenceName;
  const ids = new Set(mentions.map((mention) => mention.mentionId));
  const blocks: PromptDocument['blocks'] = [];
  let changed = false;
  for (const block of document.blocks) {
    if (block.type === 'mention') {
      if (
        matching.includes(block) &&
        mentionDisplayName(block) === previousName &&
        previousName !== name
      ) {
        blocks.push({ ...block, entityName: name });
        changed = true;
      } else blocks.push(block);
      continue;
    }
    let cursor = 0;
    let from = 0;
    while (from < block.text.length) {
      const start = block.text.indexOf(name, from);
      if (start < 0) break;
      const end = start + name.length;
      from = end;
      if (!canPromoteResourceNameAt(block.text, start, end, name)) continue;
      if (start > cursor) blocks.push({ type: 'text', text: block.text.slice(cursor, start) });
      const mentionId = createPromptMentionId(ids);
      ids.add(mentionId);
      blocks.push({
        type: 'mention',
        mentionId,
        assetId: resource.id,
        label: resource.name,
        mediaType: resource.mediaType,
        entityName: name,
        ...(resource.assetVersion !== undefined ? { assetVersion: resource.assetVersion } : {}),
      });
      cursor = end;
      changed = true;
    }
    if (cursor === 0) blocks.push(block);
    else if (cursor < block.text.length)
      blocks.push({ type: 'text', text: block.text.slice(cursor) });
  }
  if (!changed) return undefined;
  const nextDocument = { ...document, blocks };
  promptDocumentSchema.parse(nextDocument);
  return nextDocument;
}

/**
 * 只读恢复未冻结的旧连线别名；已冻结引用视为用户已确认，不复活主动解绑的文字。
 * @param input 持久化提示词，不会原地修改。
 * @param resources 当前连线身份与旧别名；名称只用于定位文字，不用于推断资产。
 * @returns 编辑或提交时可采用的文档；没有变化时保留原文档。
 * @throws 待恢复名称存在身份歧义、缺少明确版本或超出文档限制。
 */
export function projectConnectedPromptDocument(
  input: { prompt?: string; promptDocument?: PromptDocument },
  resources: readonly ConnectedPromptAsset[],
): PromptDocument | undefined {
  let document = input.promptDocument;
  const pending = resources
    .filter((resource) => resource.referenceNeedsSync && resource.referenceName)
    .sort((left, right) => right.referenceName!.length - left.referenceName!.length);
  for (const resource of pending) {
    const name = resource.referenceName!;
    const blocks = document?.blocks ?? [{ type: 'text', text: input.prompt ?? '' }];
    const hasPlaintextName = blocks.some((block) => {
      if (block.type !== 'text') return false;
      let from = 0;
      while (from < block.text.length) {
        const start = block.text.indexOf(name, from);
        if (start < 0) return false;
        from = start + name.length;
        if (canPromoteResourceNameAt(block.text, start, from, name)) return true;
      }
      return false;
    });
    if (!hasPlaintextName) continue;
    if (resource.assetVersion === undefined) {
      throw new Error(`引用“${name}”缺少明确版本，请等待来源结果恢复后再引用`);
    }
    if (
      resources.some(
        (other) =>
          other.referenceName === name &&
          (other.id !== resource.id || other.assetVersion !== resource.assetVersion),
      )
    ) {
      throw new Error(`引用“${name}”对应多个资源或版本，请先明确连线别名`);
    }
    document =
      renameConnectedPromptDocument({ ...input, promptDocument: document }, resource, name) ??
      document;
  }
  return document;
}

/**
 * 用户明确编辑后补齐旧别名的已知版本，避免下次打开重新绑定已解绑的文字。
 * @param references 原引用列表；保留既有身份、顺序和已冻结版本。
 * @param resources 连线解析结果；歧义或未知版本不推断。
 * @returns 仅在版本确知且唯一时复制对应引用；不修改原列表。
 */
export function freezeConnectedResourceReferences(
  references: NodeResourceRef[] | undefined,
  resources: readonly ConnectedPromptAsset[],
): NodeResourceRef[] | undefined {
  if (!references) return references;
  return references.map((reference) => {
    if (reference.assetVersion !== undefined) return reference;
    const authoritative =
      references.find((item) => item.id === `connected:${reference.assetId}`) ??
      references.find((item) => item.assetId === reference.assetId);
    if (authoritative !== reference) return reference;
    const candidates = resources.filter((resource) => resource.id === reference.assetId);
    const version = candidates[0]?.assetVersion;
    return version !== undefined && candidates.every((item) => item.assetVersion === version)
      ? { ...reference, assetVersion: version }
      : reference;
  });
}

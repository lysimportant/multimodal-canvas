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

/** 去掉引用排序标记，比较时只使用资源身份。 */
function unorderReferenceId(id: string): string {
  return id.replace(/^(?:ordered:)+/u, '');
}

/** 资源引用身份包含冻结版本；显示名和来源节点不参与去重。 */
function referenceIdentity(
  reference:
    | Pick<NodeResourceRef, 'assetId' | 'assetVersion'>
    | Pick<ConnectedPromptAsset, 'id' | 'assetVersion'>,
): string {
  return JSON.stringify([
    'assetId' in reference ? reference.assetId : reference.id,
    reference.assetVersion,
  ]);
}

/** 校验资源别名，供连线和独立资料共用。 */
function assertResourceName(name: string): void {
  if (!name || name.trim() !== name || name.length > 160) {
    throw new Error('资源名称应为 1 至 160 个字符，且不含首尾空白');
  }
}

/**
 * 只修改已有提及的元数据；普通文字不会因资源改名而被扫描或拆分。
 * 旧式（非 inline）提及保留原显示文字，并在其后放入新的 inline 元数据块，
 * 这样改名不会悄悄改写用户正文，同时新名称仍可供资源条和后续编辑使用。
 */
function renamePromptMentions(
  document: PromptDocument,
  resource: ConnectedPromptAsset,
  name: string,
): PromptDocument | undefined {
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
  if (!previousName || previousName === name) return undefined;
  let changed = false;
  const blocks: PromptDocument['blocks'] = [];
  for (const block of document.blocks) {
    if (
      block.type === 'mention' &&
      matching.includes(block) &&
      mentionDisplayName(block) === previousName
    ) {
      changed = true;
      if (block.inline) {
        blocks.push({ ...block, entityName: name });
      } else {
        // 旧 mention 的可见名称属于正文；拆成文字和空显示的 inline 原子。
        blocks.push({ type: 'text', text: previousName });
        blocks.push({ ...block, entityName: name, inline: true });
      }
    } else {
      blocks.push(block);
    }
  }
  if (!changed) return undefined;
  const nextDocument = { ...document, blocks };
  promptDocumentSchema.parse(nextDocument);
  return nextDocument;
}

/** 仅供旧画布只读投影：把明确旧别名拆成旧式 mention，绝不由普通改名回调调用。 */
function projectLegacyName(
  document: PromptDocument,
  resource: ConnectedPromptAsset,
  name: string,
): PromptDocument | undefined {
  const mentions = document.blocks.filter((block) => block.type === 'mention');
  if (
    mentions.some(
      (mention) =>
        mentionDisplayName(mention) === name &&
        (mention.assetId !== resource.id || mention.assetVersion !== resource.assetVersion),
    )
  ) {
    throw new Error('这个名字已被其他资源或版本占用');
  }
  const ids = new Set(mentions.map((mention) => mention.mentionId));
  const blocks: PromptDocument['blocks'] = [];
  let changed = false;
  for (const block of document.blocks) {
    if (block.type === 'mention') {
      blocks.push(block);
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
 * 更新显式引用的资源别名；旧名称转成普通文字，正文不随别名改写。
 * @param input 目标节点当前提示词；已有结构化文档优先。
 * @param resource 经目标节点连线解析的资产、版本和旧别名。
 * @param name 已校验的新别名。
 * @returns 有变化时返回文档；没有匹配内容时返回 undefined，保留普通正文。
 * @throws 同名引用属于不同资产/版本或结果超出文档限制时拒绝更新。
 */
export function renameConnectedPromptDocument(
  input: { prompt?: string; promptDocument?: PromptDocument },
  resource: ConnectedPromptAsset,
  name: string,
): PromptDocument | undefined {
  assertResourceName(name);
  if (resource.versionUnavailable) {
    throw new Error('连线生成结果缺少明确版本，请等待来源结果恢复后再引用');
  }
  const document: PromptDocument = input.promptDocument ?? {
    version: 1,
    blocks: [{ type: 'text', text: input.prompt ?? '' }],
  };
  return renamePromptMentions(document, resource, name);
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
    const currentDocument = document ?? {
      version: 1 as const,
      blocks: [{ type: 'text' as const, text: input.prompt ?? '' }],
    };
    document = projectLegacyName(currentDocument, resource, name) ?? currentDocument;
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
    // 独立资料的未冻结身份不能借连线或目录最新版补版本；只有旧连线别名允许在明确唯一时冻结。
    if (reference.attached || reference.assetVersion !== undefined) return reference;
    const authoritative = references.find(
      (item) => !item.attached && unorderReferenceId(item.id) === `connected:${reference.assetId}`,
    );
    if (authoritative !== reference) return reference;
    const candidates = resources.filter((resource) => resource.id === reference.assetId);
    const version = candidates[0]?.assetVersion;
    return version !== undefined && candidates.every((item) => item.assetVersion === version)
      ? { ...reference, assetVersion: version }
      : reference;
  });
}

/**
 * 正文编辑保留已添加资料，按原列表、旧文档、连线和新文档顺序补齐资料。
 * @param data 编辑前的节点文档与资料；不根据名称推断资产。
 * @param document 编辑后的正文，删除提及只改变正文，不缩减资料池。
 * @param resources 已解析的连线资料，保留冻结版本及原排序。
 * @returns 去重且可独立持久化的资料列表；移除资料必须走显式删除动作。
 */
export function retainNodeResourceReferences(
  data: { promptDocument?: PromptDocument; resourceRefs?: NodeResourceRef[] },
  document: PromptDocument,
  resources: readonly ConnectedPromptAsset[],
): NodeResourceRef[] {
  const saved = freezeConnectedResourceReferences(data.resourceRefs, resources) ?? [];
  const previousMentions = (data.promptDocument?.blocks ?? []).filter(
    (block): block is Extract<PromptDocument['blocks'][number], { type: 'mention' }> =>
      block.type === 'mention',
  );
  const allMentions = [
    ...previousMentions,
    ...document.blocks.filter(
      (block): block is Extract<PromptDocument['blocks'][number], { type: 'mention' }> =>
        block.type === 'mention',
    ),
  ];
  const mentionKeys = new Set(allMentions.map(referenceIdentity));
  const connectedByKey = new Map<string, ConnectedPromptAsset>();
  for (const resource of resources) {
    if (resource.versionUnavailable) continue;
    const key = referenceIdentity(resource);
    if (!connectedByKey.has(key)) connectedByKey.set(key, resource);
  }
  const result: NodeResourceRef[] = [];
  const seen = new Set<string>();
  const add = (reference: NodeResourceRef, attached: boolean) => {
    const key = referenceIdentity(reference);
    const existingIndex = result.findIndex((item) => referenceIdentity(item) === key);
    if (existingIndex >= 0) {
      if (attached && !result[existingIndex]!.attached)
        result[existingIndex] = { ...result[existingIndex]!, attached: true };
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    result.push(attached ? { ...reference, attached: true } : reference);
  };
  const referenceForConnected = (reference: NodeResourceRef): NodeResourceRef => {
    const connected = connectedByKey.get(referenceIdentity(reference));
    if (
      !connected ||
      reference.attached ||
      !connected.sourceNodeId ||
      connected.assetVersion === undefined
    )
      return reference;
    const id = `connected:source:${encodeURIComponent(connected.sourceNodeId)}:${encodeURIComponent(connected.id)}`;
    return { ...reference, id: reference.id.startsWith('ordered:') ? `ordered:${id}` : id };
  };
  // 先按已保存顺序恢复资料。正文删除不会影响 attached 资料；
  // 未 attached 的旧资料只有仍有正文提及或仍有连线时才保留。
  for (const reference of saved) {
    const key = referenceIdentity(reference);
    const connected = connectedByKey.has(key);
    if (!reference.attached && !mentionKeys.has(key) && !connected) continue;
    add(
      referenceForConnected(reference),
      Boolean(reference.attached || (mentionKeys.has(key) && !connected)),
    );
  }

  // 旧正文引用也是已添加的资料，删除其内联位置不能丢掉资料身份。
  for (const mention of previousMentions) {
    const connected = connectedByKey.has(referenceIdentity(mention));
    add(
      {
        id: `reference:${mention.mentionId}`,
        assetId: mention.assetId,
        assetVersion: mention.assetVersion,
        mediaType: mention.mediaType,
        name: mentionDisplayName(mention),
      },
      !connected,
    );
  }

  // 再追加当前仍存在的连线输入。连线输入是执行图的一部分，
  // 默认不升级为 generic attached，尤其不能把首尾帧或文字端口合成提示词资料。
  for (const resource of resources) {
    if (resource.versionUnavailable || resource.assetVersion === undefined) continue;
    const key = referenceIdentity(resource);
    if (result.some((reference) => referenceIdentity(reference) === key)) continue;
    const id = resource.sourceNodeId
      ? `connected:source:${encodeURIComponent(resource.sourceNodeId)}:${encodeURIComponent(resource.id)}`
      : `connected:${resource.id}`;
    add(
      {
        id,
        assetId: resource.id,
        assetVersion: resource.assetVersion,
        mediaType: resource.mediaType,
        name: resource.referenceName ?? resource.name.slice(0, 160),
      },
      false,
    );
  }

  // 最后才加入新文档中的独立身份；它们不应插到既有连线卡片之前。
  for (const mention of allMentions) {
    const key = referenceIdentity(mention);
    const connected = connectedByKey.has(key);
    add(
      {
        id: `reference:${mention.mentionId}`,
        assetId: mention.assetId,
        assetVersion: mention.assetVersion,
        mediaType: mention.mediaType,
        name: mentionDisplayName(mention),
      },
      !connected,
    );
  }
  return result;
}

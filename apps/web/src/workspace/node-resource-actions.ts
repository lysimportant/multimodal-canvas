/** 为当前节点添加、移除画布资源及保存引用顺序；纯计算，不触发上传或生成。 */
import {
  getEffectivePromptDocument,
  isPortConnectionAllowed,
  mentionDisplayName,
  nodeDataSchema,
  renderPromptDocument,
  uniqueResourceDisplayName,
  type Asset,
  type NodeResourceRef,
  type PromptDocument,
  type PromptMention,
} from '@multimodal-canvas/domain';

import { markDownstreamNodesStale, type AssetFlowNode, type FlowEdge } from '../canvas-utils';
import { validateResolvedCanvasConnection } from '../connection-utils';
import { projectConnectedPromptDocument } from '../resource-mention-sync';
import {
  collectConnectedPromptAssets,
  createConnectedResourceReferenceId,
  createSelectedNodesPromptDocument,
  type ConnectedPromptAsset,
} from './connected-prompt-assets';

/** 引用身份包含冻结版本；相同资产的不同版本不可在排序时合并。 */
export type NodeResourceIdentity = Pick<NodeResourceRef, 'assetId' | 'assetVersion'>;

/** 返回可用于去重和排序的版本化身份，不依赖名称或卡片序号。 */
function identity(
  resource: NodeResourceIdentity | Pick<ConnectedPromptAsset, 'id' | 'assetVersion'>,
): string {
  return JSON.stringify([
    'assetId' in resource ? resource.assetId : resource.id,
    resource.assetVersion,
  ]);
}

/** 绑定来源节点而非来源当前版本；旧 ID 迁移只保留已有的显式排序标记。 */
function bindReferenceSource(reference: NodeResourceRef, sourceNodeId: string): NodeResourceRef {
  const id = createConnectedResourceReferenceId(sourceNodeId, reference.assetId);
  return { ...reference, id: reference.id.startsWith('ordered:') ? 'ordered:' + id : id };
}

/**
 * 先恢复编辑器可见的未冻结别名投影，再合并正文和连线引用；不复活已解绑的冻结引用。
 * @returns 同一有效文档、引用池及是否需要写回投影；旧别名列表不声明资源排序。
 * @throws 旧别名有歧义、版本未知或投影文档超过限制时拒绝操作。
 */
function referencePool(
  target: AssetFlowNode,
  nodes: readonly AssetFlowNode[],
  edges: readonly FlowEdge[],
  assets: readonly Asset[],
): { references: NodeResourceRef[]; document: PromptDocument; projected: boolean } {
  const references: NodeResourceRef[] = [];
  const savedReferences = target.data.resourceRefs ?? [];
  const seen = new Set<string>();
  const connected = collectConnectedPromptAssets(target.id, nodes, edges, assets);
  const promptDocument = projectConnectedPromptDocument(target.data, connected);
  const document = getEffectivePromptDocument({ ...target.data, promptDocument });
  const projected = promptDocument !== target.data.promptDocument;
  if (connected.some((input) => input.versionUnavailable)) {
    throw new Error('引用资源的来源绑定或版本不明确，请先确认来源连线');
  }
  const mentions = document.blocks.filter((block) => block.type === 'mention');
  const mentionKeys = new Set(mentions.map(identity));
  const connectedByKey = new Map(connected.map((input) => [identity(input), input]));
  /** 按冻结身份去重，并把已解析的旧别名迁移到来源 ID，不改变已确认顺序。 */
  const add = (resource: NodeResourceRef, input?: ConnectedPromptAsset, promote = false) => {
    const key = identity(resource);
    const existingIndex = references.findIndex((item) => identity(item) === key);
    if (existingIndex >= 0) {
      if (promote && !references[existingIndex]!.attached)
        references[existingIndex] = { ...references[existingIndex]!, attached: true };
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    const saved =
      savedReferences.find((item) => identity(item) === key) ??
      (input?.referenceNeedsSync
        ? savedReferences.find(
            (item) =>
              item.assetId === resource.assetId &&
              item.assetVersion === undefined &&
              item.name === input.referenceName,
          )
        : undefined);
    const reference = {
      ...resource,
      id: saved?.id ?? resource.id,
      name: saved?.name ?? resource.name,
      ...(saved?.attached ? { attached: true } : {}),
    };
    const bound = input?.sourceNodeId
      ? bindReferenceSource(reference, input.sourceNodeId)
      : reference;
    references.push(promote ? { ...bound, attached: true } : bound);
  };
  // 先按已保存顺序恢复旧资料；正文删除不会复活未 attached 的旧引用，
  // 仍存在的连线则保留其卡片顺序和来源绑定。
  for (const resource of savedReferences) {
    const input =
      connectedByKey.get(identity(resource)) ??
      (resource.assetVersion === undefined
        ? connected.find(
            (item) =>
              item.referenceNeedsSync &&
              item.id === resource.assetId &&
              item.referenceName === resource.name,
          )
        : undefined);
    const resolved =
      input?.assetVersion !== undefined && resource.assetVersion === undefined
        ? { ...resource, assetVersion: input.assetVersion }
        : resource;
    const key = identity(resolved);
    if (!resource.attached && !mentionKeys.has(key) && !input) continue;
    add(resolved, input, Boolean(resource.attached || (mentionKeys.has(key) && !input)));
  }

  // 没有资料池的旧节点按编辑器原顺序恢复正文引用，再追加连线资料。
  for (const block of mentions) {
    const input = connectedByKey.get(identity(block));
    add(
      {
        id: `reference:${block.mentionId}`,
        assetId: block.assetId,
        mediaType: block.mediaType,
        name: input?.referenceName ?? mentionDisplayName(block),
        ...(block.assetVersion !== undefined ? { assetVersion: block.assetVersion } : {}),
      },
      input,
      !input,
    );
  }
  // 连线输入默认只是执行图输入，尤其不能把首尾帧转成 generic attached。
  const names = new Set(references.map((reference) => reference.name));
  for (const input of connected) {
    if (input.versionUnavailable || input.assetVersion === undefined) continue;
    if (references.some((reference) => identity(reference) === identity(input))) continue;
    const name = input.referenceName ?? uniqueResourceDisplayName(input.name, names);
    names.add(name);
    add(
      {
        id: `connected:${input.id}:${input.assetVersion ?? ''}`,
        assetId: input.id,
        mediaType: input.mediaType,
        name,
        ...(input.assetVersion !== undefined ? { assetVersion: input.assetVersion } : {}),
      },
      input,
    );
  }

  return { references, document, projected };
}

/**
 * 原子添加节点资料及来源连线，不改正文；重复点击同一身份不会重复添加。
 * @param targetId 保持选中的生成节点，不允许选择自身或无资源来源。
 * @param sourceId 被点击的画布节点；引用其当前已确定版本，不生成新资源。
 * @returns 新图及 changed 标志；原数组和节点不变，成功变更可作为一个撤销步骤保存。
 * 素材/图片修改节点只保存独立资料，不添加输入边；其他节点原子添加连线。
 * 视频生成节点的文字资料尚无 mention 映射，需使用提示词连线；已有帧连线不得转成参考 mention。
 * @throws 资源缺失、版本未知、循环、输入类型不兼容、文档或引用数量超限时整次拒绝。
 */
export function addNodeResourceReference(
  nodes: readonly AssetFlowNode[],
  edges: readonly FlowEdge[],
  assets: readonly Asset[],
  targetId: string,
  sourceId: string,
): { nodes: AssetFlowNode[]; edges: FlowEdge[]; changed: boolean } {
  const target = nodes.find((node) => node.id === targetId);
  const source = nodes.find((node) => node.id === sourceId);
  if (!target || !source) throw new Error('节点已不存在，请退出添加模式后重试');
  if (targetId === sourceId) throw new Error('不能把节点自身添加为参考资源');
  // 素材节点没有输入口；图片修改节点保留原图连线，额外资料独立保存到引用池。
  const referenceOnly = target.data.mode === 'source' || Boolean(target.data.imageEditSource);
  const currentSource = source.data.manualOutput
    ? { ...source, data: { ...source.data, resultAsset: undefined } }
    : source;
  const picked = createSelectedNodesPromptDocument([currentSource], assets).blocks.find(
    (block): block is PromptMention => block.type === 'mention',
  );
  if (!picked) throw new Error('来源节点没有可引用的资源');
  if (!referenceOnly && target.data.mediaType === 'video' && picked.mediaType === 'text') {
    throw new Error('视频节点尚不支持文字资源提及，请使用提示词连线；原连线和生成模式未改变');
  }
  if (
    !referenceOnly &&
    target.data.mediaType === 'video' &&
    edges.some(
      (edge) =>
        edge.target === targetId &&
        (edge.targetHandle === 'input:firstFrame' || edge.targetHandle === 'input:lastFrame'),
    )
  ) {
    throw new Error('首尾帧输入不能通过添加参考资源转成正文提及；原帧连线和生成模式未改变');
  }
  const { references: pool, document, projected } = referencePool(target, nodes, edges, assets);
  const existing = pool.find((item) => identity(item) === identity(picked));
  const name =
    existing?.name ??
    uniqueResourceDisplayName(picked.label, new Set(pool.map((item) => item.name)));
  const hasEdge = edges.some((edge) => edge.source === sourceId && edge.target === targetId);
  const reference = existing ?? {
    id: `reference:${picked.mentionId}`,
    assetId: picked.assetId,
    assetVersion: picked.assetVersion,
    mediaType: picked.mediaType,
    name,
  };
  const boundReference = referenceOnly
    ? reference
    : existing?.id.replace(/^(?:ordered:)+/, '').startsWith('connected:source:')
      ? existing
      : bindReferenceSource(reference, sourceId);
  if (
    pool.some(
      (item) =>
        item !== existing &&
        item.id.replace(/^(?:ordered:)+/, '') === boundReference.id.replace(/^(?:ordered:)+/, ''),
    )
  ) {
    throw new Error('该来源已绑定其他冻结版本，请先确认原引用；正文和连线未改变');
  }
  const resourceRefs = existing
    ? pool.map((item) => (item === existing ? { ...boundReference, attached: true } : item))
    : [...pool, { ...boundReference, attached: true }];
  const unchangedReferences =
    resourceRefs.length === target.data.resourceRefs?.length &&
    resourceRefs.every((item, index) => {
      const saved = target.data.resourceRefs![index];
      return (
        item.id === saved.id &&
        identity(item) === identity(saved) &&
        item.name === saved.name &&
        item.attached === saved.attached &&
        item.mediaType === saved.mediaType
      );
    });
  if ((hasEdge || referenceOnly) && !projected && unchangedReferences)
    return { nodes: [...nodes], edges: [...edges], changed: false };
  // 添加参考资料不删除原有首尾帧连接；兼容性必须在写入图之前整体检查。
  const nextTarget: AssetFlowNode = {
    ...target,
    data: {
      ...target.data,
      ...nodeDataSchema.parse({
        ...target.data,
        ...(projected ? { promptDocument: document } : {}),
        resourceRefs,
        stale: true,
        ...(!referenceOnly &&
        !hasEdge &&
        target.data.mediaType === 'video' &&
        !['omni_reference', 'video_edit', 'video_extend'].includes(target.data.videoMode ?? '')
          ? { videoMode: 'omni_reference' as const }
          : {}),
      }),
    },
  };
  const nextNodes = nodes.map((node) => (node.id === targetId ? nextTarget : node));
  const nextEdges = [...edges];
  if (nextTarget.data.videoMode !== target.data.videoMode) {
    for (const edge of edges.filter((item) => item.target === targetId)) {
      const existingSource = nodes.find((node) => node.id === edge.source);
      if (
        !existingSource ||
        !isPortConnectionAllowed(
          existingSource,
          edge.sourceHandle ?? '',
          nextTarget,
          edge.targetHandle ?? '',
        )
      ) {
        throw new Error('当前首尾帧连线与全能参考不兼容，请先确认生成模式；原连线未改变');
      }
    }
  }
  if (!hasEdge && !referenceOnly) {
    const validation = validateResolvedCanvasConnection(
      { source: sourceId, target: targetId, sourceHandle: null, targetHandle: null },
      nextNodes,
      nextEdges,
    );
    if (!validation.ok)
      throw new Error(
        validation.reason === 'cycle'
          ? '不能创建循环依赖'
          : '该资源类型无法连接当前节点，请检查生成模式',
      );
    nextEdges.push({
      ...validation.connection,
      id: `edge_reference_${crypto.randomUUID()}`,
      animated: true,
    });
  }
  return {
    nodes: markDownstreamNodesStale(nextNodes, nextEdges, [targetId]),
    edges: nextEdges,
    changed: true,
  };
}

/**
 * 保存带 ordered: 标记的完整排列，保留正文、资产版本和来源连线身份。
 * @param resources 资源条拖拽后的全部版本化身份，不能缺项或重复。
 * @returns 待保存的目标节点数据；连线与提示词文字不移动。
 * @throws 引用池已变化、身份无效或超过引用数量限制时拒绝，不静默丢弃资源。
 */
export function reorderNodeResources(
  target: AssetFlowNode,
  nodes: readonly AssetFlowNode[],
  edges: readonly FlowEdge[],
  assets: readonly Asset[],
  resources: readonly NodeResourceIdentity[],
): AssetFlowNode['data'] {
  const { references: pool, document, projected } = referencePool(target, nodes, edges, assets);
  const byId = new Map(pool.map((item) => [identity(item), item]));
  const keys = resources.map(identity);
  if (
    keys.length !== pool.length ||
    new Set(keys).size !== pool.length ||
    keys.some((key) => !byId.has(key))
  ) {
    throw new Error('引用资源已变化，请重新拖动排序');
  }
  const resourceRefs = keys.map((key) => {
    const reference = byId.get(key)!;
    return {
      ...reference,
      id: reference.id.startsWith('ordered:') ? reference.id : 'ordered:' + reference.id,
    };
  });
  const data = { ...target.data, ...(projected ? { promptDocument: document } : {}), resourceRefs };
  nodeDataSchema.parse(data);
  return data;
}

/**
 * 移除目标资源的文字绑定、冻结引用和入边，保留全部提示词文字及源节点。
 * @param targetId 当前被编辑的节点 ID；不会操作同来源连接的其他目标。
 * @param resource 被点击卡片的资产及版本；未知版本只匹配未知版本卡片。
 * @param document 编辑器解除绑定后的文档；省略时将目标提及转换为普通文字。
 * @returns 新图及 changed 标志，供父层一次记录撤销和自动保存；不修改输入数据。
 * @throws 目标不存在、文档改变原文或数据不合法时拒绝整次操作。
 */
export function removeNodeResourceReference(
  nodes: readonly AssetFlowNode[],
  edges: readonly FlowEdge[],
  assets: readonly Asset[],
  targetId: string,
  resource: NodeResourceIdentity,
  document?: PromptDocument,
): { nodes: AssetFlowNode[]; edges: FlowEdge[]; changed: boolean } {
  const target = nodes.find((node) => node.id === targetId);
  if (!target) throw new Error('节点已不存在，请重新打开编辑器');
  const key = identity(resource);
  // 每条边独立解析，避免资源条去重后漏掉同资产同版本的其他来源。
  const removedInputs = edges.flatMap((edge) => {
    if (edge.target !== targetId || edge.targetHandle === 'input:imageEdit') return [];
    const input = collectConnectedPromptAssets(targetId, nodes, [edge], assets)[0];
    return input && identity({ assetId: input.id, assetVersion: input.assetVersion }) === key
      ? [{ edge, input }]
      : [];
  });
  const removedEdges = new Set(removedInputs.map(({ edge }) => edge.id));
  const references = target.data.resourceRefs;
  const resourceRefs = references?.filter((reference) => {
    if (identity(reference) === key) return false;
    if (reference.assetId !== resource.assetId || reference.assetVersion !== undefined) return true;
    const referenceId = reference.id.replace(/^(?:ordered:)+/, '');
    return !removedInputs.some(({ edge, input }) =>
      referenceId.startsWith('connected:source:')
        ? referenceId === createConnectedResourceReferenceId(edge.source, input.id)
        : input.referenceNeedsSync && input.referenceName === reference.name,
    );
  });
  const previousDocument = getEffectivePromptDocument(target.data);
  const hasMention = previousDocument.blocks.some(
    (block) => block.type === 'mention' && identity(block) === key,
  );
  if (!removedEdges.size && resourceRefs?.length === references?.length && !hasMention) {
    return { nodes: [...nodes], edges: [...edges], changed: false };
  }
  const blocks: PromptDocument['blocks'] = [];
  for (const block of (document ?? previousDocument).blocks) {
    const next =
      block.type === 'mention' && identity(block) === key
        ? { type: 'text' as const, text: block.inline ? '' : mentionDisplayName(block) }
        : block;
    const last = blocks.at(-1);
    if (next.type === 'text' && last?.type === 'text') {
      blocks[blocks.length - 1] = { type: 'text', text: last.text + next.text };
    } else blocks.push(next);
  }
  const nextDocument: PromptDocument = { ...(document ?? previousDocument), blocks };
  const prompt = renderPromptDocument(nextDocument);
  if (prompt !== renderPromptDocument(previousDocument)) {
    throw new Error('提示词已变化，请重新点击移除引用；当前文字未修改');
  }
  const data = {
    ...target.data,
    promptDocument: nextDocument,
    prompt,
    ...(references ? { resourceRefs } : {}),
    stale: true,
  };
  nodeDataSchema.parse(data);
  const nextEdges = edges.filter((edge) => !removedEdges.has(edge.id));
  const nextNodes = nodes.map((node) => (node.id === targetId ? { ...node, data } : node));
  return {
    nodes: markDownstreamNodesStale(nextNodes, nextEdges, [targetId]),
    edges: nextEdges,
    changed: true,
  };
}

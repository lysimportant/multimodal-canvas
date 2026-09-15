/**
 * 生成到新节点的纯函数：回显判断、字段继承、文字拼接和末帧查找。
 * 不改父节点，不猜测未落地的编辑 URL。
 */
import type { ImageEditSource, PromptDocument, RunRecord } from '@multimodal-canvas/domain';
import {
  getEffectivePromptDocument,
  isImageEditSourceNode,
  nodeHasEcho,
  promptDocumentSchema,
  renderPromptDocument,
} from '@multimodal-canvas/domain';

import type { AssetFlowNode } from '../canvas-utils';

/** 运行写入目标：原地覆盖或修改到新建子节点。 */
export type NodeRunTarget = 'sameNode' | 'newNode';

/** 文字修改路径里插入回显正文的可见分隔标记。 */
export const GENERATED_CONTENT_MARKER = '【已生成内容】';

/**
 * 读取节点当前提示词纯文本。
 * @param data 节点 data。
 * @returns 结构化文档渲染结果，否则回退旧 prompt。
 */
export function nodePromptText(data: { prompt?: string; promptDocument?: PromptDocument }): string {
  if (data.promptDocument) return renderPromptDocument(data.promptDocument);
  return data.prompt ?? '';
}

/**
 * 判断节点是否已填写可用于生成或分叉的提示词。
 * @param data 节点 data。
 * @returns 去掉空白后仍有内容时为 true。
 */
export function nodeHasPrompt(data: { prompt?: string; promptDocument?: PromptDocument }): boolean {
  return Boolean(nodePromptText(data).trim());
}

/**
 * 判断节点是否可以点「生成」写回当前节点。
 * 从资产添加的独立来源节点也算；运行时会先提升为 generate，不覆盖未提交的资产身份。
 * @param node 当前节点。
 */
export function canRunSameNode(_node: AssetFlowNode): boolean {
  return true;
}

/**
 * 判断节点是否可以点「新节点」。
 * 必须已有回显；来源图片节点允许分叉，空节点不行。
 * @param node 当前节点。
 */
export function canForkNewNode(node: AssetFlowNode): boolean {
  return nodeHasEcho(node);
}

/**
 * 子节点从父节点继承的生成配置，不含产物字段。
 * @param data 父节点 data。
 * @returns 可写入 createGenerateNode 的覆盖字段。
 */
export function inheritedGenerateData(data: AssetFlowNode['data']): Partial<AssetFlowNode['data']> {
  return {
    ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
    ...(data.promptDocument ? { promptDocument: structuredClone(data.promptDocument) } : {}),
    ...(data.modelAlias ? { modelAlias: data.modelAlias } : {}),
    ...(data.credentialId ? { credentialId: data.credentialId } : {}),
    ...(data.parameters ? { parameters: structuredClone(data.parameters) } : {}),
    ...(data.resourceRefs ? { resourceRefs: structuredClone(data.resourceRefs) } : {}),
    ...(data.inferenceStrength ? { inferenceStrength: data.inferenceStrength } : {}),
  };
}

/**
 * 冻结当前节点回显，作为图生图原图。
 * 生成结果写入 version 与 sourceKind=result；上传资源只写 assetId。
 * @param source 被点击的图片节点。
 * @returns 可写入子节点的 imageEditSource；没有回显时为 undefined。
 */
export function freezeImageEditSource(source: AssetFlowNode): ImageEditSource | undefined {
  if (!isImageEditSourceNode(source)) return undefined;
  const resultAsset = source.data.resultAsset;
  const assetId = resultAsset?.assetId ?? source.data.assetId;
  if (!assetId) return undefined;
  return {
    sourceNodeId: source.id,
    assetId,
    ...(resultAsset?.version !== undefined ? { version: resultAsset.version } : {}),
    sourceKind: resultAsset ? 'result' : 'asset',
  };
}

/**
 * 把回显正文追加到提示词文档末尾，保留原提及块。
 * @param source 当前提示词。
 * @param generatedText 已生成正文。
 * @returns 子节点应写入的 prompt 与 promptDocument。
 * @throws 回显为空或拼接后超出文档限制。
 */
export function appendGeneratedContentToPrompt(
  source: { prompt?: string; promptDocument?: PromptDocument },
  generatedText: string,
): { prompt: string; promptDocument: PromptDocument } {
  const trimmed = generatedText.trim();
  if (!trimmed) {
    throw new Error('无法读取当前回显正文');
  }
  const base = source.promptDocument
    ? structuredClone(source.promptDocument)
    : getEffectivePromptDocument({ prompt: source.prompt ?? '' });
  const suffix = `\n\n${GENERATED_CONTENT_MARKER}\n${trimmed}`;
  const next = {
    version: 1 as const,
    blocks: [...base.blocks, { type: 'text' as const, text: suffix }],
  };
  const parsed = promptDocumentSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error('拼接后的提示词超出限制，请缩短提示词或回显正文后再试');
  }
  return {
    promptDocument: parsed.data,
    prompt: renderPromptDocument(parsed.data),
  };
}

/**
 * 查找画布上已经存在、可连接为首帧的末帧图片节点。
 * 只使用现成资产或节点，不在这次点击里抽帧。
 * @param source 父视频节点。
 * @param nodes 当前画布节点。
 * @param run 父节点最近一次运行记录。
 * @returns 可作为 firstFrame 来源的图片节点。
 */
export function findReadyFinalFrameImageNode(
  source: AssetFlowNode,
  nodes: readonly AssetFlowNode[],
  run?: RunRecord,
): AssetFlowNode | undefined {
  const frame = run?.result?.finalFrame;
  if (frame?.status === 'ready' && frame.nodeId) {
    const byId = nodes.find(
      (node) => node.id === frame.nodeId && node.data.mediaType === 'image' && nodeHasEcho(node),
    );
    if (byId) return byId;
  }
  if (frame?.status === 'ready' && frame.assetId) {
    const byAsset = nodes.find(
      (node) =>
        node.id !== source.id &&
        node.data.mediaType === 'image' &&
        nodeHasEcho(node) &&
        (node.data.resultAsset?.assetId === frame.assetId || node.data.assetId === frame.assetId),
    );
    if (byAsset) return byAsset;
  }
  const expectedLabel = `${source.data.label}末帧`;
  return nodes.find(
    (node) =>
      node.id !== source.id &&
      node.data.mediaType === 'image' &&
      node.data.label === expectedLabel &&
      nodeHasEcho(node),
  );
}

/**
 * 生成不重名的分叉子节点名称。
 * @param sourceLabel 被点击节点名称。
 * @param nodes 当前画布节点。
 * @returns 形如「修改 原名」且在画布内唯一的名称。
 */
export function createUniqueForkLabel(
  sourceLabel: string,
  nodes: readonly Pick<AssetFlowNode, 'data'>[],
): string {
  const base = `修改 ${sourceLabel}`.slice(0, 120);
  const existing = new Set(nodes.map((node) => node.data.label));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

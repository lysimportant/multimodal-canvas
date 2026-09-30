import {
  renderPromptDocument,
  type CanvasDocument,
  type CanvasNode,
} from '@multimodal-canvas/domain';

import { RunServiceError, type RunService } from './runs';

/** 这些输入角色消费文字正文，而不是要求重新调用上游文字模型。 */
const textInputHandles = new Set(['input:content', 'input:prompt', 'input:negativePrompt']);

/** 仅供本次执行使用的文本来源与归档版本；不修改保存画布。 */
type ConnectedTextInputs = {
  canvas: CanvasDocument;
  sourceVersions: Record<string, number>;
};

/**
 * 将直接连线的已有文字结果或填写完成的正文冻结为输入，避免下游生成重跑文字模型。
 * @param input 已授权的项目、目标、画布和只读运行记录服务。
 * @returns 独立执行画布与明确的资产版本；空白文字仍沿用原 DAG 执行语义。
 * @throws RunServiceError 已有归档结果缺少版本，或未生成的正文含不能作为纯文本传递的资源提及。
 * @remarks 手动输出由原资产冻结流程处理；明确运行文字节点本身时不将目标转成来源。
 */
export async function withConnectedTextInputs(input: {
  projectId: string;
  canvas: CanvasDocument;
  targetNodeId: string;
  runService: Pick<RunService, 'listByProject'>;
}): Promise<ConnectedTextInputs> {
  const connectedIds = new Set(
    input.canvas.edges
      .filter(
        (edge) =>
          edge.targetNodeId === input.targetNodeId && textInputHandles.has(edge.targetHandle),
      )
      .map((edge) => edge.sourceNodeId),
  );
  const sources = input.canvas.nodes.filter(
    (node) =>
      connectedIds.has(node.id) &&
      node.id !== input.targetNodeId &&
      node.data.mediaType === 'text' &&
      node.data.mode === 'generate' &&
      node.data.enabled !== false &&
      !node.data.manualOutput,
  );
  const unchanged = { canvas: input.canvas, sourceVersions: {} };
  if (sources.length === 0) return unchanged;
  const runs = (await input.runService.listByProject(input.projectId))
    .filter((run) => run.projectId === input.projectId && run.status === 'succeeded')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const replacements = new Map<string, CanvasNode>();
  const sourceVersions: Record<string, number> = {};
  for (const source of sources) {
    const result = runs.find(
      (run) =>
        run.targetNodeId === source.id &&
        run.result?.targetNodeId === source.id &&
        run.result.mediaType === 'text' &&
        run.result.asset,
    )?.result?.asset;
    const document = source.data.promptDocument;
    const text = document === undefined ? source.data.prompt : renderPromptDocument(document);
    if (!result && !text?.trim()) continue;
    const data = { ...source.data, mode: 'source' as const };
    if (result) {
      if (result.version === undefined || !Number.isInteger(result.version) || result.version < 1) {
        throw new RunServiceError(
          'invalid_target',
          `节点「${source.data.label}」的文字结果缺少冻结版本，请重新选择文字结果`,
        );
      }
      sourceVersions[source.id] = result.version;
      data.assetId = result.assetId;
      data.contentUrl = `/v1/assets/${encodeURIComponent(result.assetId)}/versions/${result.version}/content`;
      if (result.mimeType) data.mimeType = result.mimeType;
      // 上游生成指令不等于结果正文；Worker 只读取冻结的 txt 版本。
      delete data.prompt;
    } else {
      if (document?.blocks.some((block) => block.type === 'mention')) {
        throw new RunServiceError(
          'invalid_target',
          `节点「${source.data.label}」的文字包含资源提及，请先生成文字结果再引用，不能仅传递资源名称`,
        );
      }
      data.prompt = text;
      delete data.assetId;
      delete data.contentUrl;
    }
    delete data.promptDocument;
    delete data.modelAlias;
    delete data.credentialId;
    delete data.parameters;
    delete data.inferenceStrength;
    replacements.set(source.id, { ...source, data });
  }
  if (replacements.size === 0) return unchanged;
  return {
    sourceVersions,
    canvas: {
      ...input.canvas,
      nodes: input.canvas.nodes.map((node) => replacements.get(node.id) ?? node),
    },
  };
}

import {
  imageEditSourceOf,
  type CanvasDocument,
  type RunResultAsset,
} from '@multimodal-canvas/domain';

import { RunServiceError, type RunService } from './runs';

/** 图片编辑和视频图像输入可消费已有图片，不必再次运行其生成链。 */
const imageInputHandles = new Set([
  'input:content',
  'input:imageEdit',
  'input:referenceImage',
  'input:firstFrame',
  'input:lastFrame',
]);

/** 仅用于本次提交的来源投影和明确版本，不写入用户画布。 */
type ConnectedImageResults = {
  canvas: CanvasDocument;
  sourceVersions: Record<string, number>;
};

/**
 * 将目标连线中的已有生成图片投影为固定来源，阻断无关上游的再次生成。
 * @param input 已授权项目、目标、持久化画布和只读运行查询。
 * @returns 独立执行画布及结果版本；空图片和非图片输入保留原 DAG 语义。
 * @throws RunServiceError 显式原图不属于该节点，或已有结果缺少不可变版本。
 * @remarks 只采用同项目同节点的成功归档结果；资产权限、归档及版本有效性仍由提交边界复核。
 */
export async function withConnectedImageResults(input: {
  projectId: string;
  canvas: CanvasDocument;
  targetNodeId: string;
  runService: Pick<RunService, 'listByProject'>;
}): Promise<ConnectedImageResults> {
  const target = input.canvas.nodes.find((node) => node.id === input.targetNodeId);
  const unchanged = { canvas: input.canvas, sourceVersions: {} };
  if (!target || !['image', 'video'].includes(target.data.mediaType)) return unchanged;
  const connectedIds = new Set(
    input.canvas.edges
      .filter((edge) => edge.targetNodeId === target.id && imageInputHandles.has(edge.targetHandle))
      .map((edge) => edge.sourceNodeId),
  );
  const sources = input.canvas.nodes.filter(
    (node) =>
      connectedIds.has(node.id) &&
      node.id !== target.id &&
      node.data.mediaType === 'image' &&
      node.data.mode === 'generate' &&
      node.data.enabled !== false &&
      !node.data.manualOutput,
  );
  if (sources.length === 0) return unchanged;
  const runs = (await input.runService.listByProject(input.projectId))
    .filter((run) => run.projectId === input.projectId && run.status === 'succeeded')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const pinnedSource = imageEditSourceOf(target.data);
  const results = new Map<string, RunResultAsset>();
  const sourceVersions: Record<string, number> = {};
  for (const source of sources) {
    const pinned = pinnedSource?.sourceNodeId === source.id ? pinnedSource : undefined;
    const result = runs.find(
      (run) =>
        run.targetNodeId === source.id &&
        run.result?.targetNodeId === source.id &&
        run.result.mediaType === 'image' &&
        run.result.asset &&
        (!pinned ||
          (run.result.asset.assetId === pinned.assetId &&
            (pinned.version === undefined || run.result.asset.version === pinned.version))),
    )?.result?.asset;
    if (!result) {
      if (pinned?.sourceKind === 'result') {
        throw new RunServiceError(
          'invalid_target',
          `节点「${source.data.label}」的原图生成结果已不可用，请重新选择原图`,
        );
      }
      continue;
    }
    if (result.version === undefined || !Number.isInteger(result.version) || result.version < 1) {
      throw new RunServiceError(
        'invalid_target',
        `节点「${source.data.label}」的图片结果缺少冻结版本，请重新选择原图`,
      );
    }
    results.set(source.id, result);
    sourceVersions[source.id] = result.version;
  }
  if (results.size === 0) return unchanged;
  return {
    sourceVersions,
    canvas: {
      ...input.canvas,
      nodes: input.canvas.nodes.map((node) => {
        const result = results.get(node.id);
        if (!result) return node;
        const data = {
          ...node.data,
          mode: 'source' as const,
          assetId: result.assetId,
          contentUrl: `/v1/assets/${encodeURIComponent(result.assetId)}/versions/${sourceVersions[node.id]}/content`,
          ...(result.mimeType ? { mimeType: result.mimeType } : {}),
        };
        // 旧提示词仅是生成配置；引用已归档图片时不再解析或授权其中的资源。
        delete data.prompt;
        delete data.promptDocument;
        delete data.modelAlias;
        delete data.credentialId;
        delete data.parameters;
        delete data.inferenceStrength;
        return { ...node, data };
      }),
    },
  };
}

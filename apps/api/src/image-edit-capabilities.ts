import {
  imageEditCapability,
  imageEditSourceSchema,
  type FrozenImageEditCapability,
  type ImageEditSource,
  type MediaType,
  type NodeMode,
} from '@multimodal-canvas/domain';

/**
 * 图片编辑提交前能力预检。
 *
 * 与资源提及能力预检同构：目录未声明图片编辑能力时 fail-closed，在创建 Run
 * 之前返回稳定错误码，绝不生成 Provider 请求，也不退回文生图。
 */

/** 图片编辑预检的失败原因。 */
export type ImageEditFailureReason =
  | 'capability_unknown'
  | 'mime_unsupported'
  | 'source_node_missing'
  | 'source_not_image'
  | 'source_asset_missing'
  | 'source_asset_mismatch';

/** 预检返回的单项诊断；只包含节点与资产身份，不含媒体内容或 URL。 */
export type ImageEditCapabilityDiagnostic = {
  code:
    | 'IMAGE_EDIT_CAPABILITY_UNKNOWN'
    | 'IMAGE_EDIT_MIME_UNSUPPORTED'
    | 'IMAGE_EDIT_SOURCE_NODE_MISSING'
    | 'IMAGE_EDIT_SOURCE_NOT_IMAGE'
    | 'IMAGE_EDIT_SOURCE_ASSET_MISSING'
    | 'IMAGE_EDIT_SOURCE_ASSET_MISMATCH';
  message: string;
  requestId: string;
  nodeId: string;
  modelAlias: string;
  reason: ImageEditFailureReason;
  mediaType: MediaType;
  sourceNodeId?: string;
  assetId?: string;
};

/** 预检结果。命中时由路由转换为 400 稳定错误码。 */
export type ImageEditCapabilityCheck = {
  issues: ImageEditCapabilityDiagnostic[];
  /** 需要冻结到运行快照的图片编辑能力；无编辑语义时为 undefined。 */
  frozenCapability?: FrozenImageEditCapability;
  /** 目标节点声明的编辑来源；无编辑语义时为 undefined。 */
  source?: ImageEditSource;
};

/** 画布节点的最小结构，避免能力模块依赖 Fastify 或完整画布对象。 */
export type ImageEditCapabilityNode = {
  id: string;
  data: {
    mediaType: MediaType;
    mode: NodeMode;
    assetId?: string;
    contentUrl?: string;
    imageEditSource?: unknown;
  };
};

/** 画布连线的最小结构，用于识别显式 `imageEdit` 输入角色。 */
export type ImageEditCapabilityEdge = {
  sourceNodeId: string;
  targetNodeId: string;
  targetHandle: string;
};

/** 模型目录项的最小结构。 */
export type ImageEditCapabilityModel = {
  mediaTypes?: readonly MediaType[];
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
};

/** 图片编辑输入角色句柄。 */
const IMAGE_EDIT_HANDLE = 'input:imageEdit';

/**
 * 校验图片编辑节点的模型能力与来源资产身份。
 *
 * 目标节点既没有 `imageEditSource`、也没有 `imageEdit` 入边时返回空结果，
 * 普通图片生成节点保持原行为。
 *
 * @param input 目标节点、画布节点与边、模型和请求 ID。
 */
export function checkImageEditCapabilities(input: {
  nodes: readonly ImageEditCapabilityNode[];
  edges: readonly ImageEditCapabilityEdge[];
  targetNodeId: string;
  modelAlias: string;
  model?: ImageEditCapabilityModel;
  requestId: string;
}): ImageEditCapabilityCheck {
  const target = input.nodes.find((node) => node.id === input.targetNodeId);
  if (!target) return { issues: [] };

  const parsedSource = imageEditSourceSchema.safeParse(target.data.imageEditSource);
  const source = parsedSource.success ? parsedSource.data : undefined;
  const incomingEditEdge = input.edges.find(
    (edge) => edge.targetNodeId === input.targetNodeId && edge.targetHandle === IMAGE_EDIT_HANDLE,
  );
  if (!source && !incomingEditEdge) return { issues: [] };

  const issues: ImageEditCapabilityDiagnostic[] = [];
  const capability = resolveImageEditCapability(input.model);
  const frozenCapability = toFrozenCapability(capability);
  if (!capability.declared) {
    issues.push(
      diagnostic(input, source, {
        code: 'IMAGE_EDIT_CAPABILITY_UNKNOWN',
        reason: 'capability_unknown',
        message: `模型 ${input.modelAlias} 未声明图片编辑能力，无法修改图片`,
      }),
    );
  }

  if (!incomingEditEdge) {
    issues.push(
      diagnostic(input, source, {
        code: 'IMAGE_EDIT_SOURCE_ASSET_MISSING',
        reason: 'source_asset_missing',
        message: `图片编辑节点 ${input.targetNodeId} 缺少来源图连线`,
      }),
    );
  }

  if (source) {
    const sourceNode = input.nodes.find((node) => node.id === source.sourceNodeId);
    if (!sourceNode) {
      issues.push(
        diagnostic(input, source, {
          code: 'IMAGE_EDIT_SOURCE_NODE_MISSING',
          reason: 'source_node_missing',
          message: `图片编辑来源节点 ${source.sourceNodeId} 已不存在`,
        }),
      );
    } else if (sourceNode.data.mediaType !== 'image') {
      issues.push(
        diagnostic(input, source, {
          code: 'IMAGE_EDIT_SOURCE_NOT_IMAGE',
          reason: 'source_not_image',
          message: `图片编辑来源节点 ${source.sourceNodeId} 不是图片节点`,
        }),
      );
    } else if (!sourceNode.data.assetId || !sourceNode.data.contentUrl) {
      issues.push(
        diagnostic(input, source, {
          code: 'IMAGE_EDIT_SOURCE_ASSET_MISSING',
          reason: 'source_asset_missing',
          message: `图片编辑来源节点 ${source.sourceNodeId} 没有可用的图片资产`,
        }),
      );
    } else if (sourceNode.data.assetId !== source.assetId) {
      // 来源节点已被替换为另一张图时保留节点与边，但阻止运行并提示修复。
      issues.push(
        diagnostic(input, source, {
          code: 'IMAGE_EDIT_SOURCE_ASSET_MISMATCH',
          reason: 'source_asset_mismatch',
          message: '来源节点的当前资产与编辑节点记录的资产不一致，请重新创建修改节点',
        }),
      );
    }
  }

  return {
    issues,
    ...(frozenCapability ? { frozenCapability } : {}),
    ...(source ? { source } : {}),
  };
}

/** 解析目录声明的图片编辑能力；复用领域层的 fail-closed 解析。 */
function resolveImageEditCapability(
  model: ImageEditCapabilityModel | undefined,
): ReturnType<typeof imageEditCapability> {
  const capabilities = mergeCapabilityRecords(model?.capabilities, model?.limitations);
  return imageEditCapability({ capabilities });
}

function mergeCapabilityRecords(
  capabilities: Record<string, unknown> | undefined,
  limitations: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!capabilities && !limitations) return undefined;
  // limitations 先展开，显式 capabilities 覆盖；与资源提及预检保持同一优先级。
  return { ...(limitations ?? {}), ...(capabilities ?? {}) };
}

function toFrozenCapability(
  capability: ReturnType<typeof imageEditCapability>,
): FrozenImageEditCapability | undefined {
  if (!capability.declared) return undefined;
  return {
    declared: true,
    ...(capability.mimeTypes ? { mimeTypes: [...capability.mimeTypes] } : {}),
    ...(capability.sizes ? { sizes: [...capability.sizes] } : {}),
    ...(capability.parameters ? { parameters: [...capability.parameters] } : {}),
  };
}

function diagnostic(
  input: {
    targetNodeId: string;
    modelAlias: string;
    requestId: string;
    nodes: readonly ImageEditCapabilityNode[];
  },
  source: ImageEditSource | undefined,
  details: Pick<ImageEditCapabilityDiagnostic, 'code' | 'reason' | 'message'>,
): ImageEditCapabilityDiagnostic {
  const target = input.nodes.find((node) => node.id === input.targetNodeId);
  return {
    ...details,
    requestId: input.requestId,
    nodeId: input.targetNodeId,
    modelAlias: input.modelAlias,
    mediaType: target?.data.mediaType ?? 'image',
    ...(source ? { sourceNodeId: source.sourceNodeId, assetId: source.assetId } : {}),
  };
}

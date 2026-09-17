import {
  imageEditCapability,
  imageEditSourceSchema,
  type FrozenImageEditCapability,
  type FrozenPromptMention,
  type ImageEditSource,
  type MediaType,
  type NodeMode,
} from '@multimodal-canvas/domain';

/**
 * 图片编辑提交前能力预检。
 *
 * 图片来源连线与提示词图片提及共用编辑能力。缺少目录声明时允许兼容接口处理，
 * 明确禁用或来源身份无效时在创建 Run 之前拒绝，绝不退回文生图。
 */

/** 图片编辑预检的失败原因。 */
export type ImageEditFailureReason =
  | 'capability_unsupported'
  | 'mime_unsupported'
  | 'source_node_missing'
  | 'source_not_image'
  | 'source_asset_missing'
  | 'source_asset_mismatch';

/** 预检返回的单项诊断；只包含节点与资产身份，不含媒体内容或 URL。 */
export type ImageEditCapabilityDiagnostic = {
  code:
    | 'IMAGE_EDIT_CAPABILITY_UNSUPPORTED'
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
  /** 需要冻结到运行快照的图片编辑限制；没有声明或没有图片输入时为 undefined。 */
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

/** 画布连线的最小结构，用于识别编辑、内容和参考图片输入。 */
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

/** 与图片 Provider 一致的可作为编辑原图的连线句柄。 */
const IMAGE_SOURCE_HANDLES = new Set([IMAGE_EDIT_HANDLE, 'input:content', 'input:referenceImage']);

/**
 * 校验图片编辑节点的模型能力与来源资产身份。
 *
 * 仅处理图片生成节点。有图片提及、编辑来源或图片入边时检查编辑能力，
 * 普通文生图不触发编辑检查；原图的权限与版本仍由运行资产冻结流程验证。
 *
 * @param input 目标节点、画布节点与边、已冻结提及、模型和请求 ID。
 * @returns 编辑诊断、可选目录限制和原图身份，不读取媒体内容。
 */
export function checkImageEditCapabilities(input: {
  nodes: readonly ImageEditCapabilityNode[];
  edges: readonly ImageEditCapabilityEdge[];
  targetNodeId: string;
  modelAlias: string;
  model?: ImageEditCapabilityModel;
  mentions?: readonly FrozenPromptMention[];
  requestId: string;
}): ImageEditCapabilityCheck {
  const target = input.nodes.find((node) => node.id === input.targetNodeId);
  if (!target || target.data.mediaType !== 'image' || target.data.mode !== 'generate') {
    return { issues: [] };
  }

  const parsedSource = imageEditSourceSchema.safeParse(target.data.imageEditSource);
  const source = parsedSource.success ? parsedSource.data : undefined;
  const incomingEditEdge = input.edges.find(
    (edge) =>
      edge.targetNodeId === input.targetNodeId &&
      edge.targetHandle === IMAGE_EDIT_HANDLE &&
      (!source || edge.sourceNodeId === source.sourceNodeId),
  );
  const hasImageInput = input.edges.some(
    (edge) =>
      edge.targetNodeId === input.targetNodeId &&
      IMAGE_SOURCE_HANDLES.has(edge.targetHandle) &&
      input.nodes.some((node) => node.id === edge.sourceNodeId && node.data.mediaType === 'image'),
  );
  const hasImageMention = input.mentions?.some((mention) => mention.mediaType === 'image');
  if (!source && !incomingEditEdge && !hasImageInput && !hasImageMention) return { issues: [] };

  const issues: ImageEditCapabilityDiagnostic[] = [];
  const capability = resolveImageEditCapability(input.model);
  const frozenCapability = toFrozenCapability(capability);
  if (capability.unsupported) {
    issues.push(
      diagnostic(input, source, {
        code: 'IMAGE_EDIT_CAPABILITY_UNSUPPORTED',
        reason: 'capability_unsupported',
        message: `模型 ${input.modelAlias} 已明确声明不支持图片编辑`,
      }),
    );
  }

  if (source && !incomingEditEdge) {
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

/** 合并目录限制并区分编辑能力未知与明确禁用。 */
function resolveImageEditCapability(
  model: ImageEditCapabilityModel | undefined,
): ReturnType<typeof imageEditCapability> {
  const capabilities = mergeCapabilityRecords(model?.capabilities, model?.limitations);
  return imageEditCapability({ capabilities });
}

/** 显式 capabilities 优先于 limitations；无声明时不生成默认限制。 */
function mergeCapabilityRecords(
  capabilities: Record<string, unknown> | undefined,
  limitations: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!capabilities && !limitations) return undefined;
  // limitations 先展开，显式 capabilities 覆盖；与资源提及预检保持同一优先级。
  return { ...(limitations ?? {}), ...(capabilities ?? {}) };
}

/** 仅冻结已声明的编辑限制，未知能力保持缺省以兼容旧模型目录。 */
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

/** 生成不含媒体内容和凭据的节点级诊断。 */
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

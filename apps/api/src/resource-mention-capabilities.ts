import {
  nodeModes,
  type FrozenPromptMention,
  type MediaType,
  type NodeMode,
} from '@multimodal-canvas/domain';

/** 模型目录中与资源提及相关的能力字段。 */
export type ResourceMentionCapabilities = {
  mediaTypes?: readonly MediaType[];
  mentionMediaTypes?: readonly MediaType[];
  semanticRoles?: readonly string[];
  maxMentions?: number;
  supportsMixedMentions?: boolean;
  modes?: readonly NodeMode[];
};

/** 能力预检返回的单项诊断。诊断只包含资源身份，不包含媒体内容或 URL。 */
export type ResourceMentionCapabilityDiagnostic = {
  code:
    | 'RESOURCE_MENTION_CAPABILITY_UNKNOWN'
    | 'RESOURCE_MENTION_MEDIA_UNSUPPORTED'
    | 'RESOURCE_MENTION_ROLE_UNSUPPORTED'
    | 'RESOURCE_MENTION_COUNT_EXCEEDED'
    | 'RESOURCE_MENTION_MIXED_UNSUPPORTED'
    | 'RESOURCE_MENTION_MODE_UNSUPPORTED';
  message: string;
  requestId: string;
  nodeId: string;
  mentionId: string;
  assetId: string;
  mediaType: MediaType;
  semanticRole?: string;
  modelAlias: string;
  reason:
    | 'capability_unknown'
    | 'media_unsupported'
    | 'role_unsupported'
    | 'count_exceeded'
    | 'mixed_unsupported'
    | 'mode_unsupported';
};

/** 能力预检结果；Mock 预览允许未知能力，但会显式标记为模拟路径。 */
export type ResourceMentionCapabilityCheck = {
  issues: ResourceMentionCapabilityDiagnostic[];
  simulated: boolean;
};

/** 输入节点的最小结构，避免能力模块依赖 Fastify 或完整画布对象。 */
export type ResourceMentionCapabilityNode = {
  id: string;
  data: {
    mediaType: MediaType;
    mode: NodeMode;
  };
};

/** 输入模型的最小结构，兼容不同模型目录实现。 */
export type ResourceMentionCapabilityModel = {
  mediaTypes?: readonly MediaType[];
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
};

/**
 * 按节点媒体类型、模式、模型和提及组合执行资源能力预检。
 *
 * 图片生成的图片提及交给兼容编辑接口，缺失能力字段不阻断；其他真实
 * Provider 提及仍需要能力声明。所有已声明限制继续生效，不读取资产或发起请求。
 * @param input 节点模式、模型目录、已冻结提及及是否为 Mock 预览。
 * @returns 不含媒体内容的逐项诊断与模拟路径标记。
 */
export function checkResourceMentionCapabilities(input: {
  node: ResourceMentionCapabilityNode;
  modelAlias: string;
  model?: ResourceMentionCapabilityModel;
  mentions: readonly FrozenPromptMention[];
  requestId: string;
  allowMockPreview: boolean;
}): ResourceMentionCapabilityCheck {
  if (input.mentions.length === 0) return { issues: [], simulated: false };

  const modelCapabilities = mergeCapabilityRecords(
    input.model?.mediaTypes ? { mediaTypes: input.model.mediaTypes } : undefined,
    input.model?.capabilities,
    input.model?.limitations,
  );
  const imageGeneration =
    input.node.data.mediaType === 'image' && input.node.data.mode === 'generate';
  const parsed = parseCapabilities(modelCapabilities, imageGeneration);
  // 只要调用方明确处于 Mock/预览路径，就把未声明字段视为“模拟未知”；
  // 已明确声明的不支持媒体、角色或数量限制仍然继续校验。
  const simulated = input.allowMockPreview;
  const issues: ResourceMentionCapabilityDiagnostic[] = [];
  /** 图片编辑只吸收图片提及，其他媒体仍需按原有能力边界校验。 */
  const compatibleImageMention = (mention: FrozenPromptMention): boolean =>
    imageGeneration && mention.mediaType === 'image';

  if (imageGeneration && !simulated) {
    for (const mention of input.mentions) {
      if (mention.mediaType === 'image') continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
          reason: 'media_unsupported',
          message: `图片生成暂不支持 ${mention.mediaType} 类型资源提及`,
        }),
      );
    }
  }

  if (!input.model || !modelCapabilities || !hasAnyCapabilityDeclaration(parsed)) {
    if (!simulated) {
      for (const mention of input.mentions) {
        if (compatibleImageMention(mention)) continue;
        issues.push(
          diagnostic(input, mention, {
            code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
            reason: 'capability_unknown',
            message: `模型 ${input.modelAlias} 未声明节点 ${input.node.id} 的资源提及能力`,
          }),
        );
      }
    }
    return { issues, simulated };
  }

  const nodeMode = parsed.modes;
  if (nodeMode && !nodeMode.includes(input.node.data.mode)) {
    for (const mention of input.mentions) {
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_MODE_UNSUPPORTED',
          reason: 'mode_unsupported',
          message: `模型 ${input.modelAlias} 不支持 ${input.node.data.mode} 模式下的资源提及`,
        }),
      );
    }
  } else if (!nodeMode && !simulated && input.node.data.mode !== 'generate') {
    // 旧目录可以省略 modes；非生成操作的 Provider 语义不同，仍要求显式声明。
    for (const mention of input.mentions) {
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
          reason: 'capability_unknown',
          message: `模型 ${input.modelAlias} 未声明 ${input.node.data.mode} 模式的资源提及能力`,
        }),
      );
    }
  }

  if (parsed.mentionMediaTypes) {
    for (const mention of input.mentions) {
      if (parsed.mentionMediaTypes.includes(mention.mediaType)) continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
          reason: 'media_unsupported',
          message: `模型 ${input.modelAlias} 不支持 ${mention.mediaType} 类型资源提及`,
        }),
      );
    }
  } else if (!simulated) {
    for (const mention of input.mentions) {
      if (compatibleImageMention(mention)) continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
          reason: 'capability_unknown',
          message: `模型 ${input.modelAlias} 未声明可引用的资源媒体类型`,
        }),
      );
    }
  }

  if (parsed.semanticRoles) {
    for (const mention of input.mentions) {
      if (!mention.semanticRole || parsed.semanticRoles.includes(mention.semanticRole)) continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_ROLE_UNSUPPORTED',
          reason: 'role_unsupported',
          message: `模型 ${input.modelAlias} 不支持语义角色 ${mention.semanticRole}`,
        }),
      );
    }
  } else if (!simulated && input.mentions.some((mention) => mention.semanticRole)) {
    for (const mention of input.mentions) {
      if (!mention.semanticRole || compatibleImageMention(mention)) continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
          reason: 'capability_unknown',
          message: `模型 ${input.modelAlias} 未声明语义角色能力`,
        }),
      );
    }
  }

  if (parsed.maxMentions !== undefined && input.mentions.length > parsed.maxMentions) {
    for (const mention of input.mentions.slice(parsed.maxMentions)) {
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_COUNT_EXCEEDED',
          reason: 'count_exceeded',
          message: `模型 ${input.modelAlias} 最多支持 ${parsed.maxMentions} 个资源提及`,
        }),
      );
    }
  } else if (!simulated && parsed.maxMentions === undefined) {
    // 图片编辑由适配器校验输入数量；其他接口多次提及仍要求目录声明上限。
    if (input.mentions.length > 1) {
      for (const mention of input.mentions) {
        if (compatibleImageMention(mention)) continue;
        issues.push(
          diagnostic(input, mention, {
            code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
            reason: 'capability_unknown',
            message: `模型 ${input.modelAlias} 未声明资源提及数量上限`,
          }),
        );
      }
    }
  }

  const distinctMediaTypes = new Set(input.mentions.map((mention) => mention.mediaType));
  if (distinctMediaTypes.size > 1) {
    if (parsed.supportsMixedMentions === false) {
      for (const mention of input.mentions) {
        issues.push(
          diagnostic(input, mention, {
            code: 'RESOURCE_MENTION_MIXED_UNSUPPORTED',
            reason: 'mixed_unsupported',
            message: `模型 ${input.modelAlias} 不支持混合媒体资源提及`,
          }),
        );
      }
    } else if (parsed.supportsMixedMentions === undefined && !simulated) {
      for (const mention of input.mentions) {
        issues.push(
          diagnostic(input, mention, {
            code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
            reason: 'capability_unknown',
            message: `模型 ${input.modelAlias} 未声明混合媒体资源提及能力`,
          }),
        );
      }
    }
  }

  return { issues: deduplicateDiagnostics(issues), simulated };
}

/** 为单个资源生成不含内容或 URL 的稳定诊断。 */
function diagnostic(
  input: Parameters<typeof checkResourceMentionCapabilities>[0],
  mention: FrozenPromptMention,
  details: Pick<ResourceMentionCapabilityDiagnostic, 'code' | 'reason' | 'message'>,
): ResourceMentionCapabilityDiagnostic {
  return {
    ...details,
    requestId: input.requestId,
    nodeId: input.node.id,
    mentionId: mention.mentionId,
    assetId: mention.assetId,
    mediaType: mention.mediaType,
    ...(mention.semanticRole ? { semanticRole: mention.semanticRole } : {}),
    modelAlias: input.modelAlias,
  };
}

/** 合并模型目录字段，显式能力覆盖 limitations，节点输出类型保持目录值。 */
function mergeCapabilityRecords(
  mediaTypes: Record<string, unknown> | undefined,
  capabilities: Record<string, unknown> | undefined,
  limitations: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!mediaTypes && !capabilities && !limitations) return undefined;
  return { ...(limitations ?? {}), ...(capabilities ?? {}), ...(mediaTypes ?? {}) };
}

/** 解析能力字段别名；仅图片兼容路径把显式空值视为禁用，其他媒体保持旧解析语义。 */
function parseCapabilities(
  value: Record<string, unknown> | undefined,
  imageGeneration: boolean,
): ResourceMentionCapabilities {
  if (!value) return {};
  return {
    mediaTypes: readMediaTypes(value, ['mediaTypes', 'media_types']),
    mentionMediaTypes: readMediaTypes(
      value,
      [
        'mentionMediaTypes',
        'mention_media_types',
        'supportedMentionMediaTypes',
        'supported_mention_media_types',
        'referenceMediaTypes',
        'reference_media_types',
      ],
      imageGeneration,
    ),
    semanticRoles: readStrings(
      value,
      ['semanticRoles', 'semantic_roles', 'mentionSemanticRoles', 'mention_semantic_roles'],
      imageGeneration,
    ),
    maxMentions: readMentionLimit(
      value,
      ['maxMentions', 'max_mentions', 'maxReferences'],
      imageGeneration,
    ),
    supportsMixedMentions: readBoolean(value, [
      'supportsMixedMentions',
      'supports_mixed_mentions',
      'mixedMentions',
      'mixed_mentions',
    ]),
    modes: readModes(value, ['modes', 'supportedModes', 'supported_modes'], imageGeneration),
  };
}

/** 判断目录是否提供任何可用能力字段。 */
function hasAnyCapabilityDeclaration(value: ResourceMentionCapabilities): boolean {
  return Boolean(
    value.mediaTypes ||
    value.mentionMediaTypes ||
    value.semanticRoles ||
    value.maxMentions !== undefined ||
    value.supportsMixedMentions !== undefined ||
    value.modes,
  );
}

/** 读取媒体列表；preserveEmpty 为 true 时保留显式空数组的禁用语义。 */
function readMediaTypes(
  record: Record<string, unknown>,
  keys: readonly string[],
  preserveEmpty = false,
): MediaType[] | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const values = raw
      .filter((item): item is MediaType =>
        ['text', 'image', 'audio', 'video'].includes(String(item).toLowerCase()),
      )
      .map((item) => String(item).toLowerCase() as MediaType);
    return values.length > 0 || (preserveEmpty && raw.length === 0)
      ? [...new Set(values)]
      : undefined;
  }
  return undefined;
}

/** 读取字符串声明；图片路径保留显式空数组，其他媒体仍将空值视为缺省。 */
function readStrings(
  record: Record<string, unknown>,
  keys: readonly string[],
  preserveEmpty = false,
): string[] | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const values = raw.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    return values.length > 0 || (preserveEmpty && raw.length === 0)
      ? [...new Set(values.map((item) => item.trim()))]
      : undefined;
  }
  return undefined;
}

/** 过滤已识别的节点模式，保留显式空模式列表。 */
function readModes(
  record: Record<string, unknown>,
  keys: readonly string[],
  preserveEmpty: boolean,
): NodeMode[] | undefined {
  const values = readStrings(record, keys, preserveEmpty);
  if (!values) return undefined;
  const modes = values.filter((value): value is NodeMode =>
    (nodeModes as readonly string[]).includes(value),
  );
  return modes.length > 0 || values.length === 0 ? [...new Set(modes)] : undefined;
}

/** 读取资源数量上限；图片路径中的零表示明确禁用资源输入。 */
function readMentionLimit(
  record: Record<string, unknown>,
  keys: readonly string[],
  allowZero: boolean,
): number | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= (allowZero ? 0 : 1))
      return raw;
  }
  return undefined;
}

/** 读取布尔声明，不把缺省值推断成支持或禁用。 */
function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean;
  }
  return undefined;
}

/** 按错误、节点、提及和消息去重，保留首个诊断顺序。 */
function deduplicateDiagnostics(
  issues: readonly ResourceMentionCapabilityDiagnostic[],
): ResourceMentionCapabilityDiagnostic[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.nodeId}\0${issue.mentionId}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

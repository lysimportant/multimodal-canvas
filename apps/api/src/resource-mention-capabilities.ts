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

/** 能力预检诊断只含资源身份；UNKNOWN 保留以兼容旧响应类型，新预检不再生成。 */
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

/** 能力预检结果；缺省声明不阻断，Mock 请求仍显式标记为模拟路径。 */
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
 * 缺少能力字段不推断为不支持；仅检查明确声明的限制及图片接口映射边界。
 * 各 Provider 继续校验实际输入，不在此读取资产或发起请求。
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
  const parsed = parseCapabilities(modelCapabilities);
  const simulated = input.allowMockPreview;
  const issues: ResourceMentionCapabilityDiagnostic[] = [];
  if (imageGeneration && !simulated) {
    for (const mention of input.mentions) {
      if (mention.mediaType === 'image') continue;
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
          reason: 'media_unsupported',
          message: `当前项目的图片生成适配器尚未接通 ${mention.mediaType} 类型资源提及`,
        }),
      );
    }
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
  }

  const distinctMediaTypes = new Set(input.mentions.map((mention) => mention.mediaType));
  if (distinctMediaTypes.size > 1 && parsed.supportsMixedMentions === false) {
    for (const mention of input.mentions) {
      issues.push(
        diagnostic(input, mention, {
          code: 'RESOURCE_MENTION_MIXED_UNSUPPORTED',
          reason: 'mixed_unsupported',
          message: `模型 ${input.modelAlias} 不支持混合媒体资源提及`,
        }),
      );
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

/** 解析可选声明及其别名，显式空列表与零上限仍表示禁用。 */
function parseCapabilities(
  value: Record<string, unknown> | undefined,
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
      true,
    ),
    semanticRoles: readStrings(value, [
      'semanticRoles',
      'semantic_roles',
      'mentionSemanticRoles',
      'mention_semantic_roles',
    ]),
    maxMentions: readMentionLimit(value, ['maxMentions', 'max_mentions', 'maxReferences']),
    supportsMixedMentions: readBoolean(value, [
      'supportsMixedMentions',
      'supports_mixed_mentions',
      'mixedMentions',
      'mixed_mentions',
    ]),
    modes: readModes(value, ['modes', 'supportedModes', 'supported_modes']),
  };
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

/** 读取字符串声明，保留显式空数组的禁用语义。 */
function readStrings(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const values = raw.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    return values.length > 0 || raw.length === 0
      ? [...new Set(values.map((item) => item.trim()))]
      : undefined;
  }
  return undefined;
}

/** 过滤已识别的节点模式，保留显式空模式列表。 */
function readModes(
  record: Record<string, unknown>,
  keys: readonly string[],
): NodeMode[] | undefined {
  const values = readStrings(record, keys);
  if (!values) return undefined;
  const modes = values.filter((value): value is NodeMode =>
    (nodeModes as readonly string[]).includes(value),
  );
  return modes.length > 0 || values.length === 0 ? [...new Set(modes)] : undefined;
}

/** 读取资源数量上限；零表示明确禁用资源输入。 */
function readMentionLimit(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
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

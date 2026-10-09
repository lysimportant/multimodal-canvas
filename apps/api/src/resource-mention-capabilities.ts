import {
  nodeModes,
  type FrozenPromptMention,
  type MediaType,
  type NodeMode,
} from '@multimodal-canvas/domain';

/** 模型目录中仍参与资源提及预检的模式、角色与组合限制。 */
export type ResourceMentionCapabilities = {
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

/** 能力预检结果；媒体目录不决定输入受理，Mock 请求显式标记为模拟路径。 */
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
  /** 节点输出媒体类型，不作为资源输入的白名单。 */
  mediaTypes?: readonly MediaType[];
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
};

/**
 * 按节点媒体类型、模式、模型和提及组合执行资源能力预检。
 *
 * 媒体目录可能只描述默认输入，不能据此拒绝资源提及；媒体由实际适配器判断。
 * 缺省声明不阻断，模式、角色、数量及混合限制仍按明确声明校验。
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
  return { issues: [], simulated: input.allowMockPreview && input.mentions.length > 0 };
}

/** 为单个资源生成不含内容或 URL 的稳定诊断。 */

/** 合并预检限制，capabilities 中的显式值覆盖 limitations。 */

/** 仅解析模式、角色与组合限制；对应空列表与零上限仍表示禁用。 */

/** 读取字符串声明，保留显式空数组的禁用语义。 */

/** 过滤已识别的节点模式，保留显式空模式列表。 */

/** 读取资源数量上限；零表示明确禁用资源输入。 */

/** 读取布尔声明，不把缺省值推断成支持或禁用。 */

/** 按错误、节点、提及和消息去重，保留首个诊断顺序。 */

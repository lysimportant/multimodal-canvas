// 55b8035390a2993d8ebabdaa161cf6b49eafa507
import { z } from 'zod';
import { videoRecreationConfigSchema, parseVideoRecreationTemplate } from './video-recreation.js';
import { moonVideoContractForModel } from './moon-video-contract.js';
import { yuanliuVideoContractForModel } from './yuanliu-video-contract.js';
import { image2proVideoContractForModel } from './image2pro-video-contract.js';
export * from './video-recreation.js';
export * from './moon-video-contract.js';
export * from './image2pro-video-contract.js';
export * from './yuanliu-video-contract.js';
export * from './prompt-skills.js';
export * from './newapi-contracts.js';
export * from './generation-concurrency.js';
export * from './image-output-parameters.js';
export const mediaTypes = ['text', 'image', 'audio', 'video'];
/** 画布节点模式。历史 `transform` 读取时归一为 `generate`，产品不再区分转换节点。 */
export const nodeModes = ['source', 'generate'];
/** 视频生成节点的一次运行模式。节点本身不是模式，一次运行只选一种。 */
export const videoModes = ['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference', 'video_edit', 'video_extend'];
/** 已落地的视频模式；具体模型能否选择由 videoModeCapability 决定。 */
export const implementedVideoModes = ['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference', 'video_edit', 'video_extend'];
export const videoModeSchema = z.enum(videoModes);
/** 视频模式的中文名称，供画布选择器和摘要复用。 */
export const videoModeLabels = {
  text_to_video: '文生视频',
  first_frame: '首帧',
  first_last_frame: '首尾帧',
  omni_reference: '全能参考',
  video_edit: '视频编辑',
  video_extend: '视频延长'
};
/** 视频模式的短说明，解释该模式吸收哪些输入。 */
export const videoModeDescriptions = {
  text_to_video: '只使用提示词生成新视频，不连接图片、视频或音频参考',
  first_frame: '用一张图固定起始画面，再按提示词生成',
  first_last_frame: '分别固定起始画面和结束画面',
  omni_reference: '用参考图、参考视频或参考音频融合生成，不固定首尾帧',
  video_edit: '用参考素材和提示词编辑一段已有视频',
  video_extend: '用参考素材和提示词延长一段已有视频'
};
/**
 * 把已废弃的转换模式读成生成模式，保证旧画布仍能打开。
 * @param value 节点 mode 原始值。
 * @returns 归一后的值；无法识别时原样返回交给 schema 校验。
 */
export function normalizeNodeMode(value) {
  return value === 'transform' ? 'generate' : value;
}
export const portRoles = ['prompt', 'negativePrompt', 'content', 'style', 'character', 'referenceImage', 'firstFrame', 'lastFrame', 'audioTrack', 'transcript', 'mask',
/**
 * 图片编辑流程的专用原图输入角色。由“修改图片”入口显式写入，
 * 只接受图片上游，不靠连接顺序推断编辑意图。
 */
'imageEdit'];
export const assetStatuses = ['ready', 'archived'];
export const mediaTypeSchema = z.enum(mediaTypes);
export const modelSelectionSchema = z.object({
  modelAlias: z.string().trim().min(1),
  /** 本人分组的服务端凭据引用；精确模型名和引用共同确定调用身份。 */
  credentialId: z.string().trim().min(1).optional()
});
export const nodeModeSchema = z.preprocess(normalizeNodeMode, z.enum(nodeModes));
export const portRoleSchema = z.enum(portRoles);
export const assetStatusSchema = z.enum(assetStatuses);
export const runStatuses = ['draft', 'queued', 'preparing', 'running', 'processing', 'succeeded', 'failed', 'cancel_requested', 'cancelled'];
export const runStatusSchema = z.enum(runStatuses);
export const providerJobStatuses = ['queued', 'submitted', 'running', 'succeeded', 'failed', 'cancelled'];
export const providerJobStatusSchema = z.enum(providerJobStatuses);
/** Lifecycle state for one frozen canvas node inside a queued DAG run. */
export const workflowNodeStatuses = ['pending', 'running', 'succeeded', 'failed', 'cancelled'];
export const workflowNodeStatusSchema = z.enum(workflowNodeStatuses);
export const providerJobSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  platformJobId: z.string().min(1).optional(),
  status: providerJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  payload: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export const runResultAssetSchema = z.object({
  assetId: z.string().min(1),
  version: z.number().int().positive().optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
});
export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: mediaTypeSchema,
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** 资源索引返回的当前最高版本；旧资源可能暂时没有该字段。 */
  latestVersion: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: assetStatusSchema,
  contentUrl: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(64)).default([]),
  metadata: z.record(z.unknown()).optional(),
  archivedAt: z.string().datetime().optional()
});
/**
 * 提示词中提及资源的通用绑定信息。
 * 未识别的普通字段会被保留，便于后续语义角色扩展；凭据、临时 URL 和
 * 本地路径等敏感字段在领域解析边界直接丢弃，避免进入持久化文档。
 */
const mentionBindingObjectSchema = z.object({
  entityName: z.string().trim().min(1).max(160).optional(),
  semanticRole: z.string().trim().min(1).max(160).optional(),
  scope: z.enum(['local', 'node', 'scene']).optional()
}).passthrough();
export const mentionBindingSchema = z.preprocess(value => sanitizeMentionBindingValue(value), mentionBindingObjectSchema);
/** 在绑定的前向兼容字段中移除凭据、URL 和本地路径。 */
function sanitizeMentionBindingValue(value, key) {
  if (key && isSensitiveMentionKey(key)) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return looksLikeLocalPath(value) ? undefined : value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return value.map(item => sanitizeMentionBindingValue(item)).filter(item => item !== undefined);
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeMentionBindingValue(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}
function isSensitiveMentionKey(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
  return /(?:^|_)(?:api_key|access_token|refresh_token|authorization|password|secret(?:_key)?|credential(?:s|_id|_version)?|signed_url|presigned_url)(?:_|$)/.test(normalized) || /(?:url|uri)$/.test(normalized) || /(?:^|_)(?:local_?path|file_?path|path)(?:_|$)/.test(normalized);
}
function looksLikeLocalPath(value) {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|file:)/.test(value.trim());
}
/** 资源提及块。assetVersion 用于用户明确选择某个历史版本的场景。 */
export const promptMentionSchema = z.object({
  type: z.literal('mention'),
  mentionId: z.string().trim().min(1).max(160),
  assetId: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(512),
  mediaType: mediaTypeSchema,
  assetVersion: z.number().int().positive().optional(),
  /** 独立内联引用标记，不占用普通正文；缺省为旧版名称绑定。 */
  inline: z.literal(true).optional(),
  /** 导入时资源不可访问会保留身份并标记为不可执行占位。 */
  placeholder: z.boolean().optional(),
  placeholderReason: z.enum(['not_found', 'forbidden', 'archived', 'version_missing', 'mime_mismatch', 'size_exceeded']).optional(),
  semanticRole: z.string().trim().min(1).max(160).optional(),
  entityName: z.string().trim().min(1).max(160).optional(),
  scope: z.enum(['local', 'node', 'scene']).optional(),
  binding: mentionBindingSchema.optional()
})
// 提及块只允许协议字段；Worker 的临时内容会在解析器完成 schema
// 校验后以内存字段注入，避免 URL、凭据或本地路径进入持久化数据。
.strip();
/** 普通文字块，允许为空以表达空提示词文档。 */
export const promptTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(20_000)
}).strip();
export const promptBlockSchema = z.discriminatedUnion('type', [promptTextBlockSchema, promptMentionSchema]);
/**
 * 版本化提示词文档。块顺序就是文字和资源提及的渲染顺序。
 * 文档必须至少包含一个块；提及 ID 只要求在当前文档内唯一。
 */
export const promptDocumentSchema = z.object({
  version: z.literal(1),
  blocks: z.array(promptBlockSchema).min(1).max(2_000)
}).strip().superRefine((document, context) => {
  const mentionIds = new Set();
  let textLength = 0;
  document.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      textLength += block.text.length;
      return;
    }
    if (mentionIds.has(block.mentionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate prompt mention id: ${block.mentionId}`,
        path: ['blocks', index, 'mentionId']
      });
    }
    mentionIds.add(block.mentionId);
    if (block.placeholderReason && block.placeholder !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'placeholderReason requires placeholder: true',
        path: ['blocks', index, 'placeholder']
      });
    }
  });
  if (textLength > 20_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'prompt document text exceeds the 20000-character limit',
      path: ['blocks']
    });
  }
});
/**
 * 将结构化提示词渲染为兼容旧 Provider 的纯文本。
 * 资源身份不会依赖显示名；渲染仅用于旧接口或预览输出。
 */
/**
 * 资源在提示词中的显示名。优先用用户命名，否则去掉文件名后缀。
 * @param mention 提示词资源提及。
 */
export function mentionDisplayName(mention) {
  const named = mention.entityName?.trim() || mention.binding?.entityName?.trim();
  if (named) return named;
  return defaultResourceDisplayName(mention.label);
}
/**
 * 从文件名得到默认可读名。
 * 普通文件会去掉常见后缀；去掉后如果只剩过短或纯数字/符号，则保留原文件名。
 * 这样 `2.mp4` 不会变成 `2`，避免在提示词里输入数字就被当成资源引用。
 * @param fileName 资源文件名或标签。
 */
export function defaultResourceDisplayName(fileName) {
  const base = fileName.trim();
  if (!base) return '资源';
  const stripped = base.replace(/\.[A-Za-z0-9]{1,8}$/u, '');
  const stem = (stripped || base).trim();
  if (!stem || stem.length < 2 || /^[\d._-]+$/u.test(stem)) {
    return base.slice(0, 160);
  }
  return stem.slice(0, 160);
}
/**
 * 在已占用名字中生成不重复的显示名。
 * @param fileName 原始文件名。
 * @param taken 本节点已占用的名字。
 */
export function uniqueResourceDisplayName(fileName, taken) {
  const names = new Set(taken);
  const root = defaultResourceDisplayName(fileName);
  if (!names.has(root)) return root;
  let index = 2;
  while (names.has(`${root}${index}`)) index += 1;
  return `${root}${index}`;
}
/**
 * 将结构化提示词渲染为兼容旧 Provider 的纯文本。
 * 资源身份不依赖显示名；渲染使用绑定后的名字，不再加 @ 前缀。
 * @param document 结构化提示词文档。
 * @returns 按块顺序拼接的纯文本。
 */
export function renderPromptDocument(document) {
  const parsed = promptDocumentSchema.parse(document);
  return parsed.blocks.map(block => block.type === 'text' ? block.text : block.inline ? '' : mentionDisplayName(block)).join('');
}
export function getEffectivePromptDocument(input) {
  if (input.promptDocument !== undefined) return promptDocumentSchema.parse(input.promptDocument);
  return {
    version: 1,
    blocks: [{
      type: 'text',
      text: input.prompt ?? ''
    }]
  };
}
/** 已写入运行快照的图片编辑限制；旧快照缺省图片上限时按实际模型解析。 */
export const frozenImageEditCapabilitySchema = z.object({
  declared: z.literal(true),
  mimeTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  sizes: z.array(z.string().trim().min(1)).min(1).optional(),
  parameters: z.array(z.string().trim().min(1)).min(1).optional(),
  /** 单次编辑允许的图片张数；旧快照缺省时按模型默认值解析。 */
  maxImages: z.number().int().positive().optional()
}).strip();
/** 已写入运行快照的、带不可变资产版本的资源提及。 */
export const frozenPromptMentionSchema = z.object({
  /** 节点 ID 在旧快照中可省略；新快照始终写入。 */
  nodeId: z.string().trim().min(1).optional(),
  mentionId: z.string().trim().min(1).max(160),
  assetId: z.string().trim().min(1).max(512),
  assetVersion: z.number().int().positive(),
  mediaType: mediaTypeSchema,
  /** 视频或音频资产选中版本的探测时长；缺省表示该版本没有可信时长。 */
  durationSeconds: z.number().finite().positive().optional(),
  label: z.string().trim().min(1).max(512),
  blockOrder: z.number().int().nonnegative(),
  semanticRole: z.string().trim().min(1).max(160).optional(),
  entityName: z.string().trim().min(1).max(160).optional(),
  scope: z.enum(['local', 'node', 'scene']).optional(),
  binding: mentionBindingSchema.optional()
}).strip();
/** 视频成功归档后的末帧完成动作。 */
export const videoCompletionActions = ['none', 'preview_final_frame', 'create_asset', 'append_image_node', 'fill_designated_image_node'];
export const videoCompletionActionSchema = z.enum(videoCompletionActions);
/** 末帧提取策略版本；变更提取算法时递增，以形成新的幂等身份。 */
export const VIDEO_FINAL_FRAME_POLICY_VERSION = 1;
/** 节点上命名后的参考资源。id 稳定，name 仅作显示与输入别名。 */
export const nodeResourceRefSchema = z.object({
  id: z.string().trim().min(1).max(160),
  assetId: z.string().trim().min(1).max(512),
  mediaType: mediaTypeSchema,
  name: z.string().trim().min(1).max(160),
  assetVersion: z.number().int().positive().optional(),
  /** 独立添加的资料；即使正文没有引用标记，也作为节点的生成输入。 */
  attached: z.boolean().optional()
});
/**
 * 把独立资料投影为执行用提及，保留保存的正文和已有提及身份。
 * @param input 节点文字、结构化文档及独立资料列表；旧别名不自动变成输入。
 * @returns 供权限校验、版本冻结和执行快照共用的文档；不修改 input。
 * @throws 文档或合并后的提及数量超出协议限制时拒绝。
 */
export function getExecutionPromptDocument(input) {
  const attached = input.resourceRefs?.filter(reference => reference.attached) ?? [];
  if (attached.length === 0) return input.promptDocument;
  const document = getEffectivePromptDocument(input);
  const ids = new Set(document.blocks.flatMap(block => block.type === 'mention' ? [block.mentionId] : []));
  const identities = new Set(document.blocks.flatMap(block => block.type === 'mention' ? [promptResourceIdentity(block.assetId, block.assetVersion)] : []));
  const blocks = [...document.blocks];
  for (const [index, reference] of attached.entries()) {
    const key = promptResourceIdentity(reference.assetId, reference.assetVersion);
    if (identities.has(key)) continue;
    identities.add(key);
    let mentionId = `attached_${index}`;
    while (ids.has(mentionId)) mentionId += '_';
    ids.add(mentionId);
    blocks.push({
      type: 'mention',
      mentionId,
      inline: true,
      assetId: reference.assetId,
      assetVersion: reference.assetVersion,
      mediaType: reference.mediaType,
      label: reference.name,
      entityName: reference.name
    });
  }
  return promptDocumentSchema.parse({
    ...document,
    blocks
  });
}
/** 生成提示词资料的稳定身份键；版本缺省与显式版本保持不同语义。 */
function promptResourceIdentity(assetId, assetVersion) {
  return JSON.stringify([assetId, assetVersion]);
}
/**
 * 图片编辑节点上冻结的来源图引用。
 *
 * `sourceNodeId` 与 `assetId` 由“修改图片”入口显式写入，编辑节点据此知道自己
 * 在修改哪一张图。`version` 只在创建时已知（例如来源是生成结果）才写入；从上传
 * 资源发起时留空，由 API 在排队前解析并冻结到运行快照的不可变版本里，绝不使用
 * 未版本化的最新 URL。
 */
export const imageEditSourceSchema = z.object({
  sourceNodeId: z.string().trim().min(1).max(160),
  assetId: z.string().trim().min(1).max(512),
  version: z.number().int().positive().optional(),
  /** 来源资产是上传资源还是某个生成结果；旧画布缺省按上传资源处理。 */
  sourceKind: z.enum(['asset', 'result']).optional()
}).strip();
/** 读取节点上的图片编辑来源；字段缺失或非法时返回 undefined。 */
export function imageEditSourceOf(data) {
  const parsed = imageEditSourceSchema.safeParse(data?.imageEditSource);
  return parsed.success ? parsed.data : undefined;
}
/** 生成说明记录的 schema 版本；结构变化时必须递增，供旧记录显式降级。 */
export const REQUEST_PROMPT_SCHEMA_VERSION = 1;
/** 请求文本块的格式版本，区分纯文本与有序角色消息。 */
export const requestPromptFormats = ['plain', 'messages'];
export const requestPromptFormatSchema = z.enum(requestPromptFormats);
/**
 * 本次请求真正发送出去的一条文本内容。
 *
 * `role` 与 `name` 只反映供应商消息契约里实际存在的字段，不是前端为了显示而
 * 补的角色；纯文本请求使用 `plain` 格式并省略 `role`。
 */
export const requestPromptPartSchema = z.object({
  /** 文本在本格式中的发送顺序，最小为 0，同一记录内必须唯一。 */
  order: z.number().int().nonnegative(),
  role: z.string().trim().min(1).max(64).optional(),
  /** Chat Completions 的 `name` 字段，用于保留画布上的输入身份。 */
  name: z.string().trim().min(1).max(160).optional(),
  text: z.string().max(200_000)
});
/**
 * 参考资源的身份与用途。只保存资产身份、版本、角色和顺序；
 * 不保存 base64、临时签名 URL 或任何媒体二进制。
 */
export const requestPromptResourceSchema = z.object({
  assetId: z.string().trim().min(1).max(512).optional(),
  assetVersion: z.number().int().positive().optional(),
  /** 冻结时记录的安全显示名；不用于资源寻址或授权。 */
  name: z.string().trim().min(1).max(160).optional(),
  role: portRoleSchema,
  sortOrder: z.number().int().nonnegative(),
  mediaType: mediaTypeSchema.optional()
});
/** 发送请求前后的状态；不确定状态不得触发自动重发。 */
export const requestPromptSendStatuses = ['pending', 'sent', 'failed', 'unknown'];
export const requestPromptSendStatusSchema = z.enum(requestPromptSendStatuses);
/**
 * 一次已提交请求最终发送的提示词快照。
 *
 * 记录身份是 `runId + nodeId + attempt + requestIdentity`：一个 DAG 内每个实际
 * 执行的节点各留存一份，绝不把目标节点的提示词附给上游结果。结果身份
 * （`assetId + assetVersion`）在归档完成后由 Worker 补写；缺失表示该请求没有
 * 产出可展示的资产版本，而不是回退到节点上当前编辑框的内容。
 */
export const requestPromptRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  runId: z.string().min(1).max(512),
  nodeId: z.string().min(1).max(160),
  attempt: z.number().int().positive(),
  /** 同一 attempt 内可能发生多次请求；身份由 Provider 请求路径与序号组成。 */
  requestIdentity: z.string().trim().min(1).max(200),
  provider: z.string().min(1).max(64),
  modelAlias: z.string().min(1).max(512),
  credentialId: z.string().min(1).max(512).optional(),
  credentialVersion: z.number().int().positive().optional(),
  mediaType: mediaTypeSchema,
  format: requestPromptFormatSchema,
  /** 按实际发送顺序排列的文本块；纯图片 prompt 只有一项。 */
  parts: z.array(requestPromptPartSchema),
  /** 真正发送出去的负向内容；未发送时留空，不回填节点上的编辑值。 */
  negativeText: z.string().max(20_000).optional(),
  resources: z.array(requestPromptResourceSchema),
  sendStatus: requestPromptSendStatusSchema,
  createdAt: z.string().datetime(),
  /** 归档完成后写入的结果身份。 */
  assetId: z.string().min(1).max(512).optional(),
  assetVersion: z.number().int().positive().optional(),
  /** 生成方式与状态；用户修改摘要不会改写真实请求文本。 */
  summary: z.string().max(2_000).optional(),
  summarySource: z.enum(['manual', 'local', 'model']).optional()
});
/** 记录身份键，用于去重和按节点读取，不包含任何提示词内容。 */
export function requestPromptRecordKey(record) {
  return `${record.runId}\0${record.nodeId}\0${record.attempt}\0${record.requestIdentity}`;
}
/** 多条消息结果复制时使用的稳定角色分隔前缀。 */
export function requestPromptPartPrefix(part) {
  if (!part.role) return '';
  return part.name ? `[${part.role}:${part.name}] ` : `[${part.role}] `;
}
/**
 * 渲染可复制的完整提示词文本。多消息结果保留角色与顺序，纯文本请求
 * 只返回实际发送的字符串，不额外拼接标签。
 *
 * @param record 已持久化的请求提示词记录。
 * @returns 可直接写入剪贴板的文本。
 */
export function renderRequestPromptText(record) {
  const ordered = [...record.parts].sort((left, right) => left.order - right.order);
  if (record.format === 'plain') return ordered.map(part => part.text).join('\n');
  return ordered.map(part => `${requestPromptPartPrefix(part)}${part.text}`).join('\n');
}
/** 请求提示词记录的数据来源；历史运行没有留存记录时显式区分。 */
export const requestPromptOrigins = ['request', 'input-snapshot', 'none'];
/** 一次节点执行的生命周期时间记录，所有时间戳为服务端 UTC。 */
export const nodeTimingSchema = z.object({
  nodeId: z.string().min(1).max(160),
  /** 本节点进入待执行状态的时刻，包含依赖等待。 */
  queuedAt: z.string().datetime().optional(),
  /** 本节点真正开始执行的时刻；写入后不因轮询或 Worker 重启重置。 */
  startedAt: z.string().datetime().optional(),
  /** 终态时刻，只写入一次；取消与失败同样有终态。 */
  finishedAt: z.string().datetime().optional(),
  /** 终态性质，决定界面如何描述本次耗时。 */
  outcome: z.enum(['succeeded', 'failed', 'cancelled']).optional(),
  /** 发起供应商请求的时刻，用于拆出请求阶段耗时。 */
  requestStartedAt: z.string().datetime().optional(),
  /** 取得可用结果的时刻。 */
  requestFinishedAt: z.string().datetime().optional()
});
/**
 * 计算一个节点本次执行的耗时。
 *
 * 口径为 `finishedAt - startedAt`，包含本节点准备输入、供应商处理、轮询及结果
 * 归档；未执行完成时按服务端已记录的开始时间返回运行中的递增基准。缺少时间戳
 * 时返回 `unrecorded`，时间顺序异常时返回 `invalid`，不返回 0 秒或推测值。
 *
 * @param timing 该节点的生命周期时间记录。
 * @param now 当前服务端时间，单位毫秒；仅用于计算运行中的已用时间。
 * @returns 耗时可用性或具体毫秒数。
 */
export function nodeTimingDuration(timing, now) {
  const started = parseTimingInstant(timing.startedAt);
  const finished = parseTimingInstant(timing.finishedAt);
  if (started !== undefined && finished !== undefined) {
    if (finished < started) return {
      availability: 'invalid',
      reason: 'out-of-order'
    };
    return {
      availability: 'recorded',
      milliseconds: finished - started
    };
  }
  if (finished !== undefined && started === undefined) return {
    availability: 'unrecorded'
  };
  if (started === undefined) return {
    availability: 'unrecorded'
  };
  if (started > now) return {
    availability: 'invalid',
    reason: 'future'
  };
  return {
    availability: 'running',
    milliseconds: now - started,
    since: 'startedAt'
  };
}
/**
 * 格式化节点耗时，统一使用秒并至多保留一位小数，不转为分或小时。
 *
 * @param milliseconds 非负毫秒数。
 * @returns 例如 `12.4秒`、`120秒`；无效或负数输入返回空字符串。
 */
export function formatNodeDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  return `${Number((milliseconds / 1000).toFixed(1))}秒`;
}
function parseTimingInstant(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * 判断节点是否已有可回显的资产或生成结果。
 * 上传来源和生成结果都算；空节点没有回显。
 * @param node 待检查的节点或其 data。
 * @returns 存在 resultAsset.assetId，或同时存在 assetId 与 contentUrl 时为 true。
 */
export function nodeHasEcho(node) {
  const data = 'data' in node ? node.data : node;
  return Boolean(data.resultAsset?.assetId || data.assetId && data.contentUrl);
}
/**
 * 判断节点是否是可作为“修改图片”来源的图片节点：必须是图片，且已有可回显的资产。
 * 来源节点本身和已有生成结果的节点都算，但不含没有图片内容的空节点。
 * @param node 待检查的图片节点。
 * @returns 图片节点且已有回显时为 true。
 */
export function isImageEditSourceNode(node) {
  if (node.data.mediaType !== 'image') return false;
  return nodeHasEcho(node);
}
/** GPT Image 编辑接口单次输入最多 16 张图片；兼容模型也不超过此本地上限。 */
export const IMAGE_EDIT_MAX_IMAGES = 16;
/**
 * 解析图片编辑输入上限，显式目录限制优先于模型族默认值。
 * @param modelAlias 实际供应商模型 ID；GPT Image 官方族默认 16 张，其它模型默认 1 张。
 * @param capability 可选的已声明上限；更小值生效，更大值收窄到 16 张。
 * @returns 单次允许的图片张数，范围为 1 至 16。
 * @throws RangeError 显式 maxImages 不是有限正整数。
 */
export function resolveImageEditMaxImages(modelAlias, capability) {
  return Number.POSITIVE_INFINITY;
}
/** 目录中可用于解析图片编辑能力的字段名，兼容供应商的 snake_case 别名。 */
const imageEditCapabilityKeys = ['imageEdit', 'image_edit', 'supportsImageEdit'];
/** 读取目录中的非空字符串列表，忽略无效项。 */
function readStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}
/** 判断能力字段是否包含支持编辑的布尔值或结构化约束。 */
function isImageEditDeclaration(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value;
  // 显式 false 表示供应商确认不支持；只有显式 true 或结构化声明才算支持。
  if (record.supported === false || record.supports === false) return false;
  return record.supported === true || record.supports === true || Object.keys(record).length > 0;
}
/**
 * 从模型目录项解析图片编辑能力，不把字段缺失当成明确禁用。
 * @param model 模型目录项或节点上的模型描述。
 * @returns 声明状态、明确禁用标记及可选输入限制；不发起请求。
 */
export function imageEditCapability(model) {
  const capabilities = model?.capabilities;
  if (!capabilities) return {
    declared: false
  };
  for (const key of imageEditCapabilityKeys) {
    const value = capabilities[key];
    if (value === undefined || value === null) continue;
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    if (value === false || record?.supported === false || record?.supports === false) {
      return {
        declared: false,
        unsupported: true
      };
    }
    if (!isImageEditDeclaration(value)) return {
      declared: false
    };
    const mimeTypes = readStringArray(record?.mimeTypes ?? record?.mime_types);
    const sizes = readStringArray(record?.sizes);
    const parameters = readStringArray(record?.parameters ?? record?.fields);
    const hasMaxImages = Boolean(record && (Object.hasOwn(record, 'maxImages') || Object.hasOwn(record, 'max_images')));
    const maxImages = record ? Object.hasOwn(record, 'maxImages') ? record.maxImages : record.max_images : undefined;
    const validMaxImages = typeof maxImages === 'number' && Number.isInteger(maxImages) && maxImages > 0;
    return {
      declared: true,
      ...(mimeTypes ? {
        mimeTypes
      } : {}),
      ...(sizes ? {
        sizes
      } : {}),
      ...(parameters ? {
        parameters
      } : {}),
      ...(hasMaxImages ? validMaxImages ? {
        maxImages
      } : {
        invalidMaxImages: true
      } : {})
    };
  }
  return {
    declared: false
  };
}
/** 图片编辑被明确禁用或输入不符合约束时的稳定错误码，前端与 API 共用。 */
export const IMAGE_EDIT_UNSUPPORTED_CODE = 'IMAGE_EDIT_UNSUPPORTED';
/** 单次节点批量生成的产品上限；每份输出分别执行，不代表 Provider 的批量能力。 */
export const GENERATION_COUNT_MAX = 20;
/** 未显式设置数量的历史节点始终只生成一份，避免修改偏好扩大已有任务。 */
export const DEFAULT_GENERATION_COUNT = 1;
/** 判断生成数量是否为 1 至产品上限之间的整数，不截断或四舍五入用户输入。 */
export function isValidGenerationCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= DEFAULT_GENERATION_COUNT && value <= GENERATION_COUNT_MAX;
}
/**
 * 读取节点的单次生成数量；旧节点缺省为 1，非法显式值不得启动生成。
 * @param data 节点数据，数量是本地任务编排字段，不发送给 Provider。
 * @returns 本次操作应生成的份数，范围为 1 至 20。
 * @throws RangeError 显式数量不是范围内的整数。
 */
export function getNodeGenerationCount(data) {
  if (data.generationCount === undefined) return DEFAULT_GENERATION_COUNT;
  if (!isValidGenerationCount(data.generationCount)) {
    throw new RangeError(`生成数量必须为 1 至 ${GENERATION_COUNT_MAX} 的整数`);
  }
  return data.generationCount;
}
export const nodeDataSchema = z.object({
  label: z.string().min(1),
  /** 节点实例首次创建时间（UTC ISO 8601）；复制的新节点重新记录，历史缺失不补写。 */
  createdAt: z.string().datetime().optional(),
  mediaType: mediaTypeSchema,
  mode: nodeModeSchema,
  /** Whether this node contributes inputs to downstream runs. Omitted means enabled for legacy canvases. */
  enabled: z.boolean().optional(),
  /** Downstream output is no longer derived from the current upstream inputs. */
  stale: z.boolean().optional(),
  /** 手动上传或编辑的资产优先作为下游输入；仅明确重新生成本节点时执行模型。 */
  manualOutput: z.boolean().optional(),
  /** 明确重新生成的运行 ID；界面只允许该运行成功后替换手动输出，失败仍保留资产。 */
  manualOutputRunId: z.string().trim().min(1).optional(),
  prompt: z.string().trim().max(20_000).optional(),
  /** 版本化提示词文档；存在时它是唯一执行来源，旧 prompt 仅作兼容字段。 */
  promptDocument: promptDocumentSchema.optional(),
  /** 节点选中的提示词技能；仅显式优化时使用，普通生成不自动执行。 */
  promptSkillId: z.string().trim().min(1).max(80).optional(),
  /**
   * 节点参考资源池。名字绑定到 assetId，提示词用名字引用；
   * 与画布连线和提示词提及共用同一份身份，避免按顺序互换角色。
   */
  resourceRefs: z.array(nodeResourceRefSchema).optional(),
  /**
   * 与节点一同保存的媒体生成参数，例如图片尺寸/清晰度和视频分辨率/时长。
   * 参数由对应 Provider 按已支持的字段映射，未配置时沿用模型默认值。
   */
  parameters: z.record(z.unknown()).optional(),
  /** 单次操作生成的份数，缺省为 1；仅用于任务编排，不写入 Provider 参数。 */
  generationCount: z.number().int().min(1).max(GENERATION_COUNT_MAX).optional(),
  /** 批量结果所属卡牌组，仅用于画布展示编排，不参与 Provider 参数或生成数量计算。 */
  generationBatch: z.object({
    /** 同一批生成结果共享的非空分组标识。 */
    id: z.string().min(1),
    /** 批次起始节点标识，用于关联画布上的卡牌组。 */
    rootNodeId: z.string().min(1),
    /** 结果在批次内的零起始序号。 */
    index: z.number().int().min(0)
  }).optional(),
  /** 批量卡牌组是否展开；缺省由画布采用收起状态，仅用于展示编排。 */
  generationBatchExpanded: z.boolean().optional(),
  /**
   * 模型支持的推理强度标识。不同模型的能力名称可能不同（例如
   * `low`、`high`、`xhigh` 或 `max`），因此只校验为非空字符串。
   */
  inferenceStrength: z.string().trim().min(1).optional(),
  modelAlias: z.string().trim().min(1).optional(),
  /** 本人分组模型的服务端凭据引用；实际生成前必须验证归属和版本。 */
  credentialId: z.string().trim().min(1).optional(),
  assetId: z.string().min(1).optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  /**
   * 视频成功后的末帧派生动作。缺省或旧节点视为 none，不回补历史任务。
   */
  completionAction: videoCompletionActionSchema.optional(),
  /** 仅 fill_designated_image_node 使用；必须指向仍为空的图片节点。 */
  completionTargetNodeId: z.string().trim().min(1).optional(),
  /**
   * 视频生成模式。缺省表示旧画布：端口保持全量兼容，运行时按连线推断。
   * 新视频生成节点会写入显式值，一次运行只使用一种模式。
   */
  videoMode: videoModeSchema.optional(),
  /**
   * 图片编辑语义。由“修改图片”入口写入的版本化来源引用；缺省表示普通图片
   * 生成节点（旧画布不会被自动推断成编辑节点）。
   */
  imageEditSource: imageEditSourceSchema.optional(),
  /** 整条短视频复刻专属工作流；保持普通video媒体与Provider合同。 */
  videoRecreation: videoRecreationConfigSchema.optional(),
  /** 未选择来源的短视频复刻草稿；冻结来源后移除，不为旧节点补默认值。 */
  videoRecreationDraft: z.literal(true).optional()
});
/** Legacy canvases omit this field; only an explicit false disables a node. */
export function isCanvasNodeEnabled(node) {
  return node.data.enabled !== false;
}
/** 画布节点合同；空复刻草稿仅能保存在尚未冻结来源的视频生成节点。 */
export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: mediaTypeSchema,
  position: z.object({
    x: z.number(),
    y: z.number()
  }),
  /** User-resizable dimensions. React Flow keeps these on the node itself. */
  width: z.number().finite().positive().max(10_000).optional(),
  height: z.number().finite().positive().max(10_000).optional(),
  data: nodeDataSchema
}).superRefine((node, context) => {
  if (!node.data.videoRecreationDraft) return;
  if (node.type !== 'video' || node.data.mediaType !== 'video' || node.data.mode !== 'generate') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '短视频复刻草稿必须是视频生成节点',
      path: ['data', 'videoRecreationDraft']
    });
  }
  if (node.data.videoRecreation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '复刻来源已冻结，请移除空草稿标记',
      path: ['data', 'videoRecreationDraft']
    });
  }
});
export const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  sourceHandle: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetHandle: z.string().min(1),
  order: z.number().int().nonnegative()
});
/** 组区域允许的最小边长，单位为画布像素。 */
export const CANVAS_GROUP_MIN_SIZE = 120;
/** 组区域允许的最大边长，单位为画布像素。 */
export const CANVAS_GROUP_MAX_SIZE = 10_000;
/** 单个组允许的成员数量上限；超出时规范化阶段会截断而不是写出非法文档。 */
export const CANVAS_GROUP_NODE_LIMIT = 500;
/**
 * 画布布局区域。
 *
 * 组只表达画布布局，不是第五种媒体类型：它不进入运行 DAG，没有输入输出端口，
 * 也不出现在模型选择或资源生成请求中。`nodeIds` 是成员节点身份，节点本身仍以
 * 画布绝对坐标持久化，视图层转换到组内相对坐标只发生在渲染边界。
 */
export const canvasGroupSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite()
  }),
  width: z.number().finite().min(CANVAS_GROUP_MIN_SIZE).max(CANVAS_GROUP_MAX_SIZE),
  height: z.number().finite().min(CANVAS_GROUP_MIN_SIZE).max(CANVAS_GROUP_MAX_SIZE),
  /** 成员节点 ID；一个节点最多属于一个组，首版禁止嵌套与循环归属。 */
  nodeIds: z.array(z.string().min(1)).max(CANVAS_GROUP_NODE_LIMIT)
});
export const canvasDocumentSchema = z.object({
  revision: z.number().int().nonnegative(),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  /** 旧画布缺省按空组列表读取；不写入组字段时不改变既有内容。 */
  groups: z.array(canvasGroupSchema).optional()
}).superRefine((document, context) => {
  const nodeIds = new Set();
  const nodesById = new Map();
  document.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate node id: ${node.id}`,
        path: ['nodes', index, 'id']
      });
    }
    nodeIds.add(node.id);
    nodesById.set(node.id, node);
  });
  const edgesBySource = new Map();
  const edgeIds = new Set();
  document.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate edge id: ${edge.id}`,
        path: ['edges', index, 'id']
      });
    }
    edgeIds.add(edge.id);
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!source || !target) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edge references a missing node',
        path: ['edges', index]
      });
      return;
    }
    if (source.id === target.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'self-referential edges are not allowed',
        path: ['edges', index]
      });
    }
    if (!isPortConnectionAllowed(source, edge.sourceHandle, target, edge.targetHandle)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `incompatible connection: ${edge.sourceHandle} -> ${edge.targetHandle}`,
        path: ['edges', index]
      });
    }
    const sourceEdges = edgesBySource.get(source.id) ?? [];
    sourceEdges.push(target.id);
    edgesBySource.set(source.id, sourceEdges);
  });
  const visiting = new Set();
  const visited = new Set();
  const visit = nodeId => {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const targetId of edgesBySource.get(nodeId) ?? []) {
      if (!visit(targetId)) return false;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  };
  for (const nodeId of nodeIds) {
    if (!visit(nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'canvas graph must be acyclic',
        path: ['edges']
      });
      break;
    }
  }
  // 组只校验布局归属：成员必须存在且只能属于一个组。组不参与连通性、
  // 端口或环检测，因此这里不做任何图结构推断。
  const groupIds = new Set();
  const memberGroupId = new Map();
  document.groups?.forEach((group, index) => {
    if (groupIds.has(group.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate group id: ${group.id}`,
        path: ['groups', index, 'id']
      });
    }
    groupIds.add(group.id);
    const members = new Set();
    group.nodeIds.forEach((nodeId, memberIndex) => {
      if (members.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate group member: ${nodeId}`,
          path: ['groups', index, 'nodeIds', memberIndex]
        });
      }
      members.add(nodeId);
      if (!nodeIds.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'group references a missing node',
          path: ['groups', index, 'nodeIds', memberIndex]
        });
        return;
      }
      const existing = memberGroupId.get(nodeId);
      if (existing !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `node ${nodeId} already belongs to group ${existing}`,
          path: ['groups', index, 'nodeIds', memberIndex]
        });
        return;
      }
      memberGroupId.set(nodeId, group.id);
    });
  });
});
/** 单条冻结连线输入；可选版本用于水合后保留来源身份，旧快照仍从冻结 URL 解析。 */
export const runInputSnapshotSchema = z.object({
  nodeId: z.string().min(1),
  role: portRoleSchema,
  sortOrder: z.number().int().nonnegative(),
  sourceAssetId: z.string().min(1).optional(),
  /** 已冻结的资产版本，必须与来源资产 URL 对应；缺省不表示使用最新版。 */
  sourceAssetVersion: z.number().int().positive().optional(),
  /** 已冻结视频或音频版本的探测时长；不得从当前资产元数据回填。 */
  sourceDurationSeconds: z.number().finite().positive().optional(),
  snapshot: canvasNodeSchema
});
/** 上游权威授权事实；无密钥，所有字段冻结后用于受理时的版本校验。 */
export const newApiExecutionAuthoritySchema = z.object({
  issuer: z.string().url(),
  externalUserId: z.string().min(1),
  instanceId: z.string().min(1),
  grantId: z.string().min(1),
  tokenId: z.string().min(1),
  credentialRevision: z.string().min(1),
  group: z.string().min(1).refine(value => value !== '神秘分组'),
  permissionRevision: z.string().min(1),
  autoGroups: z.array(z.string().min(1).refine(value => value !== '神秘分组'))
});
/** 本人凭据的不可变版本；newApi 仅供内部生成校验，不能由客户端授予权限。 */
export const runCredentialReferenceSchema = z.object({
  credentialId: z.string().min(1),
  credentialVersion: z.number().int().positive(),
  newApi: newApiExecutionAuthoritySchema.optional()
});
/** 每个节点的中性执行合同；费用由 New API 处理，不含 Canvas 商品或报价。 */
export const runExecutionBindingSchema = z.object({
  credentialId: z.string().min(1),
  credentialVersion: z.number().int().positive(),
  modelAlias: z.string().min(1),
  mediaType: z.enum(['text', 'image', 'audio', 'video']),
  contract: z.string().min(1),
  authority: newApiExecutionAuthoritySchema
});
/** 独立资源分析的冻结身份；自动任务按项目、资产和版本去重，不属于画布节点。 */
export const reversePromptSourceSchema = z.object({
  assetId: z.string().min(1).max(512),
  assetVersion: z.number().int().positive(),
  automatic: z.boolean(),
  /** 专属视频复刻分析与普通反推隔离，缺省保持旧行为。 */
  purpose: z.literal('video_recreation').optional()
});
/** 反推得到的描述，不代表恢复出的原始生成请求；长度限制以字符数计。 */
export const reversePromptResultSchema = z.object({
  summary: z.string().trim().min(1).max(2_000),
  prompt: z.string().trim().min(1).max(20_000)
});
/**
 * 解析模型返回的反推 JSON，兼容单个 Markdown JSON 围栏。
 * @param text Provider 返回的完整文字输出。
 * @returns 已验证且去除多余字段的摘要和详细提示词。
 * @throws JSON、字段或长度不正确时抛出固定错误，不把供应商原文写入错误日志。
 */
export function parseReversePromptOutput(text, purpose) {
  try {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    const result = reversePromptResultSchema.parse(JSON.parse(fenced?.[1] ?? trimmed));
    if (purpose === 'video_recreation') parseVideoRecreationTemplate(result.prompt);
    return result;
  } catch {
    throw new Error('反推结果格式无效：模型必须返回包含 summary 和 prompt 的 JSON 对象');
  }
}
/** 冻结执行输入与图关系；保留未执行草稿，但执行目标及启用上游须先绑定完整来源。 */
export const runSnapshotSchema = z.object({
  projectId: z.string().min(1),
  canvasRevision: z.number().int().nonnegative(),
  targetNodeId: z.string().min(1),
  modelAlias: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  credentialVersion: z.number().int().positive().optional(),
  /**
   * Immutable credential reference for each provider-backed workflow node.
   * Omitted legacy snapshots continue to use the root credential reference.
   */
  nodeCredentialReferences: z.record(runCredentialReferenceSchema).optional(),
  /** New API 本人分组的持久授权快照，由 API 冻结并由 Worker 复核。 */
  executionBindings: z.record(runExecutionBindingSchema).optional(),
  parameters: z.record(z.unknown()),
  submittedAt: z.string().datetime(),
  nodes: z.array(canvasNodeSchema).min(1),
  edges: z.array(canvasEdgeSchema),
  inputs: z.array(runInputSnapshotSchema),
  /** 按节点保存已冻结的内联提及；旧快照可省略该字段。 */
  promptMentions: z.array(frozenPromptMentionSchema).optional(),
  /** 运行目标的图片编辑限制，兼容未按节点存储能力的旧快照。 */
  imageEditCapability: frozenImageEditCapabilitySchema.optional(),
  /** 按执行节点冻结的图片编辑限制，避免不同模型的输入约束相互覆盖。 */
  nodeImageEditCapabilities: z.record(frozenImageEditCapabilitySchema).optional(),
  /** 独立反推任务标记；缺省保持普通生成和归档行为，不传入供应商参数。 */
  reversePrompt: reversePromptSourceSchema.optional(),
  /** 独立 Skill 优化的来源与版本；冻结原始文档用于恢复资源提及。 */
  promptOptimization: z.object({
    nodeId: z.string().min(1),
    skillId: z.string().min(1).max(80),
    skillVersion: z.string().min(1),
    /** 冻结实际执行的技能规则；后续编辑或删除不改变历史任务。 */
    instruction: z.string().min(1).max(12_000).optional(),
    input: promptDocumentSchema
  }).optional()
}).superRefine((snapshot, context) => {
  // Run snapshots can come from a persisted queue payload or a worker
  // restart, so validate the graph again instead of trusting the API's
  // earlier canvas validation. This prevents malformed edges or cycles from
  // reaching a provider when a queue/database boundary is compromised.
  const documentResult = canvasDocumentSchema.safeParse({
    revision: snapshot.canvasRevision,
    nodes: snapshot.nodes,
    edges: snapshot.edges
  });
  if (!documentResult.success) {
    for (const issue of documentResult.error.issues) {
      if (issue.path[0] === 'revision') continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path
      });
    }
  }
  const nodeIds = new Set(snapshot.nodes.map(node => node.id));
  // 快照可保留未执行草稿；目标及启用上游不能将空来源提交给 Provider。
  if (snapshot.nodes.some(node => node.data.videoRecreationDraft)) {
    const nodesById = new Map(snapshot.nodes.map(node => [node.id, node]));
    const visited = new Set();
    const pending = [snapshot.targetNodeId];
    while (pending.length > 0) {
      const nodeId = pending.pop();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = nodesById.get(nodeId);
      if (!node || node.id !== snapshot.targetNodeId && node.data.enabled === false) continue;
      if (node.data.videoRecreationDraft) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '请先选择或上传完整参考视频，再分析或生成复刻视频',
          path: ['nodes', snapshot.nodes.indexOf(node), 'data', 'videoRecreationDraft']
        });
      }
      for (const edge of snapshot.edges) {
        if (edge.targetNodeId === nodeId) pending.push(edge.sourceNodeId);
      }
    }
  }
  if (snapshot.promptOptimization) {
    const target = snapshot.nodes[0];
    if (snapshot.reversePrompt || snapshot.nodes.length !== 1 || snapshot.edges.length !== 0 || snapshot.inputs.length !== 0 || (snapshot.promptMentions ?? []).some(mention => mention.nodeId !== undefined && mention.nodeId !== target?.id) || target?.id !== 'prompt_skill_optimization' || snapshot.targetNodeId !== target.id || target.data.mediaType !== 'text' || target.data.mode !== 'generate') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Skill 优化必须是无媒体输出的独立文字任务',
        path: ['promptOptimization']
      });
    }
  }
  if (snapshot.reversePrompt) {
    const target = snapshot.nodes.find(node => node.id === snapshot.targetNodeId);
    const mention = snapshot.promptMentions?.[0];
    if (snapshot.nodes.length !== 1 || snapshot.edges.length !== 0 || snapshot.inputs.length !== 0 || target?.data.mediaType !== 'text' || target.data.mode !== 'generate' || snapshot.promptMentions?.length !== 1 || mention?.assetId !== snapshot.reversePrompt.assetId || mention.assetVersion !== snapshot.reversePrompt.assetVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '反推任务必须是引用指定资源版本的独立文字分析',
        path: ['reversePrompt']
      });
    }
  }
  for (const nodeId of Object.keys(snapshot.nodeImageEditCapabilities ?? {})) {
    const node = snapshot.nodes.find(candidate => candidate.id === nodeId);
    if (!node || node.data.mediaType !== 'image' || node.data.mode !== 'generate') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '图片编辑限制必须关联快照中的图片生成节点',
        path: ['nodeImageEditCapabilities', nodeId]
      });
    }
  }
  for (const [nodeId, reference] of Object.entries(snapshot.nodeCredentialReferences ?? {})) {
    if (!nodeIds.has(nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'node credential references a missing node',
        path: ['nodeCredentialReferences', nodeId]
      });
    }
    if (nodeId === snapshot.targetNodeId && (snapshot.credentialId && snapshot.credentialId !== reference.credentialId || snapshot.credentialVersion && snapshot.credentialVersion !== reference.credentialVersion)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'target credential reference does not match the run credential',
        path: ['nodeCredentialReferences', nodeId]
      });
    }
  }
  snapshot.inputs.forEach((input, index) => {
    if (!nodeIds.has(input.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run input references a missing node',
        path: ['inputs', index, 'nodeId']
      });
    }
    if (input.snapshot.id !== input.nodeId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run input snapshot id does not match nodeId',
        path: ['inputs', index, 'snapshot', 'id']
      });
    }
  });
  const mentionKeys = new Set();
  const lastMentionOrderByNode = new Map();
  snapshot.promptMentions?.forEach((mention, index) => {
    if (mention.nodeId && !nodeIds.has(mention.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt mention references a missing snapshot node',
        path: ['promptMentions', index, 'nodeId']
      });
    }
    const key = `${mention.nodeId ?? ''}\0${mention.mentionId}`;
    if (mentionKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate frozen prompt mention: ${mention.mentionId}`,
        path: ['promptMentions', index, 'mentionId']
      });
    }
    mentionKeys.add(key);
    const orderNodeId = mention.nodeId ?? snapshot.targetNodeId;
    const previousOrder = lastMentionOrderByNode.get(orderNodeId);
    if (previousOrder !== undefined && mention.blockOrder < previousOrder) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frozen prompt mentions must be ordered by blockOrder per node',
        path: ['promptMentions', index, 'blockOrder']
      });
    }
    lastMentionOrderByNode.set(orderNodeId, mention.blockOrder);
  });
  if (!snapshot.nodes.some(node => node.id === snapshot.targetNodeId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'run target node is missing from snapshot',
      path: ['targetNodeId']
    });
  }
});
/**
 * Returns the canonical JSON identity for an immutable run snapshot.
 * Submission time is execution metadata rather than request identity, so it
 * is deliberately excluded. Object keys are sorted recursively while array
 * order remains significant.
 */
export function canonicalRunSnapshotJson(snapshot) {
  const {
    submittedAt: _submittedAt,
    ...stableSnapshot
  } = runSnapshotSchema.parse(snapshot);
  return JSON.stringify(canonicalJsonValue(stableSnapshot));
}
/**
 * Returns the versioned material hashed by API and Worker run identity checks.
 * Keeping the namespace beside the canonicalizer prevents the two processes
 * from silently drifting to different digest inputs.
 */
export function runSnapshotFingerprintMaterial(snapshot) {
  return `multimodal-canvas:run-snapshot:v2:${canonicalRunSnapshotJson(snapshot)}`;
}
function canonicalJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : canonicalJsonValue(item));
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalJsonValue(item)]));
}
export const videoFinalFrameStatuses = ['skipped', 'pending', 'processing', 'ready', 'failed', 'conflict'];
export const videoFinalFrameStatusSchema = z.enum(videoFinalFrameStatuses);
export const runResultFinalFrameSchema = z.object({
  status: videoFinalFrameStatusSchema,
  action: videoCompletionActionSchema,
  actionId: z.string().min(1),
  policyVersion: z.number().int().positive(),
  previewUrl: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  assetVersion: z.number().int().positive().optional(),
  nodeId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  message: z.string().min(1).optional()
});
export const runResultSchema = z.object({
  provider: z.string().min(1),
  summary: z.string().min(1),
  targetNodeId: z.string().min(1),
  mediaType: mediaTypeSchema,
  inputCount: z.number().int().nonnegative(),
  /** 明确标记结果来自不证明真实供应商能力的 Mock/预览路径。 */
  simulated: z.boolean().optional(),
  asset: runResultAssetSchema.optional(),
  providerJob: providerJobSchema.optional(),
  /** Mock/预览可回显已解析的冻结提及；不包含媒体内容或临时 URL。 */
  promptMentions: z.array(frozenPromptMentionSchema).optional(),
  /** 视频末帧派生结果。缺省表示未执行或动作为 none。失败不得否定视频成功。 */
  finalFrame: runResultFinalFrameSchema.optional(),
  /** 独立反推的结构化结果；存入 Run，不创建资源版本或冒充真实提示词。 */
  reversePrompt: reversePromptResultSchema.optional(),
  /** Skill 优化只保存候选提示词，不创建图片、文本资产或覆盖用户节点。 */
  promptOptimization: z.object({
    promptDocument: promptDocumentSchema
  }).optional()
});
/**
 * Durable execution state for one node of the immutable run snapshot. The
 * source graph itself remains in `snapshot`; this only records lifecycle
 * data needed to resume a BullMQ job without re-running completed work.
 */
export const workflowNodeStateSchema = z.object({
  nodeId: z.string().min(1),
  status: workflowNodeStatusSchema,
  providerJob: providerJobSchema.optional(),
  result: runResultSchema.optional()
}).superRefine((state, context) => {
  if (state.status === 'succeeded' && !state.result) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'succeeded workflow node requires a result',
      path: ['result']
    });
  }
});
export const workflowStateSchema = z.object({
  nodes: z.array(workflowNodeStateSchema)
}).superRefine((state, context) => {
  const nodeIds = new Set();
  state.nodes.forEach((node, index) => {
    if (nodeIds.has(node.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate workflow node state: ${node.nodeId}`,
        path: ['nodes', index, 'nodeId']
      });
    }
    nodeIds.add(node.nodeId);
  });
});
export const runRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  targetNodeId: z.string().min(1),
  status: runStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempt: z.number().int().positive(),
  provider: z.string().min(1),
  modelAlias: z.string().min(1),
  snapshot: runSnapshotSchema,
  result: runResultSchema.optional(),
  providerJob: providerJobSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  error: z.string().min(1).optional(),
  retryOf: z.string().min(1).optional(),
  /**
   * 按节点记录的本次执行生命周期时间。旧运行记录缺省为空，
   * 界面显示“未记录”，不根据 createdAt/updatedAt 反推。
   */
  nodeTimings: z.record(nodeTimingSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export const runJobDataSchema = z.object({
  runId: z.string().min(1),
  userId: z.string().min(1).optional(),
  snapshot: runSnapshotSchema,
  attempt: z.number().int().positive(),
  provider: z.enum(['mock', 'newapi']).default('mock'),
  retryOf: z.string().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  providerJob: providerJobSchema.optional(),
  workflowState: workflowStateSchema.optional(),
  cancelRequested: z.boolean().default(false),
  /** 只查询已有上游任务，不允许创建新的 Provider 请求。 */
  retrieveOnly: z.boolean().optional()
}).superRefine((job, context) => {
  if (job.snapshot.promptOptimization && (job.retryOf || job.attempt !== 1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Skill 优化请通过原提交身份查询，不能使用普通运行重试',
      path: ['attempt']
    });
  }
  if (job.snapshot.reversePrompt && (job.retryOf || job.attempt !== 1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '反推任务只允许明确新建，不能通过普通运行重试再次调用',
      path: ['attempt']
    });
  }
  const nodesById = new Map(job.snapshot.nodes.map(node => [node.id, node]));
  job.workflowState?.nodes.forEach((state, index) => {
    const node = nodesById.get(state.nodeId);
    if (!node) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workflow state references a missing snapshot node',
        path: ['workflowState', 'nodes', index, 'nodeId']
      });
      return;
    }
    if (state.result?.targetNodeId !== undefined && state.result.targetNodeId !== node.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workflow result target does not match its node state',
        path: ['workflowState', 'nodes', index, 'result', 'targetNodeId']
      });
    }
    if (state.result?.mediaType !== undefined && state.result.mediaType !== node.data.mediaType) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workflow result media type does not match its node state',
        path: ['workflowState', 'nodes', index, 'result', 'mediaType']
      });
    }
  });
});
export const runJobResultSchema = z.object({
  status: z.enum(['succeeded', 'cancelled']),
  progress: z.number().int().min(0).max(100),
  result: runResultSchema.optional(),
  providerJob: providerJobSchema.optional()
});
const runStatusTransitions = {
  draft: ['queued'],
  queued: ['preparing', 'cancel_requested', 'cancelled'],
  preparing: ['running', 'cancel_requested'],
  running: ['processing', 'cancel_requested'],
  processing: ['succeeded', 'failed', 'cancel_requested'],
  succeeded: [],
  failed: [],
  cancel_requested: ['cancelled'],
  cancelled: []
};
export function canTransitionRunStatus(from, to) {
  return from === to || runStatusTransitions[from].includes(to);
}
const targetRoleMediaTypes = {
  prompt: ['text'],
  negativePrompt: ['text'],
  content: ['text', 'image', 'audio', 'video'],
  style: ['image'],
  character: ['image'],
  referenceImage: ['image'],
  firstFrame: ['image'],
  lastFrame: ['image'],
  audioTrack: ['audio'],
  transcript: ['audio'],
  mask: ['image'],
  imageEdit: ['image']
};
const targetNodePortRoles = {
  text: ['prompt', 'negativePrompt', 'content', 'transcript'],
  image: ['prompt', 'negativePrompt', 'content', 'style', 'character', 'referenceImage', 'firstFrame', 'lastFrame', 'mask',
  // 排在最后：可见锚点仍按原顺序分配，编辑原图只增加一个语义输入口。
  'imageEdit'],
  audio: ['prompt', 'negativePrompt', 'content', 'audioTrack', 'transcript'],
  video: ['prompt', 'negativePrompt', 'content', 'style', 'character', 'referenceImage', 'firstFrame', 'lastFrame', 'audioTrack', 'transcript', 'mask']
};
/** Returns the input roles exposed by a target node's media type. */
export function targetPortRolesForMediaType(mediaType) {
  return [...targetNodePortRoles[mediaType]];
}
/**
 * 从模型 ID 推断视频家族。未命中时返回 unknown，真实字段仍 fail-closed。
 * @param modelAlias 运行快照或节点上的模型 ID。
 */
export function videoFamilyForModel(modelAlias) {
  const exactId = (modelAlias ?? '').trim();
  if (!exactId) return 'unknown';
  if (image2proVideoContractForModel(exactId)) return 'image2pro';
  if (yuanliuVideoContractForModel(exactId)) return 'yuanliu';
  if (exactId === 'minimax-h3') return 'moon-minimax-h3';
  if (exactId === 'MiniMax-H3') return 'minimax-h3';
  const id = exactId.toLowerCase();
  if (id.startsWith('grok-imagine-video-1.5')) return 'grok-imagine-video-1.5';
  if (/^grok[-_]?imagine/.test(id)) return 'grok-imagine-video';
  if (id === 'wan3.0-video' || id === 'wan3.0-video-prime') return 'wan3';
  if (id === 'doubao-seedance-2-5-260628') return 'seedance-2.5';
  if (id === 'doubao-seedance-2-0-260128' || id === 'doubao-seedance-2-0-fast-260128' || id === 'doubao-seedance-2-0-mini-260615' || id === 'seedance-2-0-official' || id === 'seedance-2-0-fast-official' || id === 'seedance-2-0-mini-official') {
    return 'seedance-2';
  }
  if (id.includes('wan')) return 'wan';
  const moonContract = moonVideoContractForModel(exactId);
  if (moonContract) return moonContract.family;
  return 'unknown';
}
const textToVideoRoles = ['prompt'];
const textToVideoWithNegativeRoles = ['prompt', 'negativePrompt'];
const firstFrameRoles = ['prompt', 'firstFrame'];
const firstFrameWithNegativeRoles = ['prompt', 'negativePrompt', 'firstFrame'];
const firstLastFrameRoles = ['prompt', 'firstFrame', 'lastFrame'];
const firstLastFrameWithNegativeRoles = ['prompt', 'negativePrompt', 'firstFrame', 'lastFrame'];
const omniReferenceRoles = ['prompt', 'referenceImage', 'content', 'audioTrack', 'character', 'style'];
const omniReferenceWithNegativeRoles = ['prompt', 'negativePrompt', 'referenceImage', 'content', 'audioTrack', 'character', 'style'];
const grokOmniReferenceRoles = ['prompt', 'referenceImage', 'character', 'style'];
const referenceRoleMediaTypes = {
  referenceImage: ['image'],
  character: ['image'],
  style: ['image'],
  content: ['video'],
  audioTrack: ['audio']
};
const referenceRepeatableRoles = ['referenceImage', 'character', 'style', 'content', 'audioTrack'];
/**
 * 返回指定模式在该模型上的能力。画布可按 selectable 展示；真实请求看 livePost。
 * @param mode 节点上的视频模式。
 * @param modelAlias 运行快照或节点上的模型 ID。
 */
export function videoModeCapability(mode, modelAlias) {
  return {
    selectable: true,
    livePost: true,
    roles: targetNodePortRoles.video,
    repeatableRoles: targetNodePortRoles.video,
    roleMediaTypes: Object.fromEntries(portRoles.map(role => [role, mediaTypes]))
  };
}
/**
 * 返回某个视频模式允许的输入角色。
 * @param mode 视频模式。
 * @param modelAlias 可选模型 ID，用于收窄全能参考的媒体。
 */
export function targetPortRolesForVideoMode(mode, modelAlias) {
  return [...videoModeCapability(mode, modelAlias).roles];
}
/**
 * 按节点当前模式返回可连接角色。旧视频节点没有 videoMode 时保持全量端口。
 * @param node 目标画布节点。
 */
export function targetPortRolesForNode(node) {
  if (node.data.mode === 'source') return [];
  if (node.data.mediaType !== 'video' || !node.data.videoMode) {
    return targetPortRolesForMediaType(node.data.mediaType);
  }
  return targetPortRolesForVideoMode(node.data.videoMode, node.data.modelAlias);
}
/**
 * 判断该模式是否已在本阶段落地。
 * @param mode 视频模式。
 */
export function isImplementedVideoMode(mode) {
  return implementedVideoModes.includes(mode);
}
/**
 * 从已连接角色推断旧画布的视频模式，供选择器回显；不写入节点。
 * @param roles 当前连到该节点的输入角色。
 */
export function inferVideoModeFromRoles(roles) {
  const set = new Set(roles);
  if (set.has('character') || set.has('style') || set.has('referenceImage') || set.has('audioTrack') || set.has('transcript') || set.has('mask') || set.has('content')) {
    return 'omni_reference';
  }
  if (set.has('lastFrame')) return 'first_last_frame';
  if (set.has('firstFrame')) return 'first_frame';
  return 'text_to_video';
}
/**
 * 返回节点应展示的视频模式：显式值优先，否则按连线推断。
 * @param data 节点 data。
 * @param connectedRoles 当前连到该节点的输入角色。
 */
export function displayVideoMode(data, connectedRoles = []) {
  return data?.videoMode ?? inferVideoModeFromRoles(connectedRoles);
}
export function isPortConnectionAllowed(source, sourceHandle, target, targetHandle) {
  // Source nodes are terminal references. They expose an output only and
  // cannot receive workflow inputs.
  if (target.data.mode === 'source') return false;
  const sourceMediaType = sourceHandle.startsWith('output:') ? sourceHandle.slice('output:'.length) : undefined;
  const targetRole = targetHandle.startsWith('input:') ? targetHandle.slice('input:'.length) : undefined;
  if (sourceMediaType !== source.data.mediaType || !targetRole) return false;
  if (!portRoles.includes(targetRole)) return false;
  const allowedRoles = targetPortRolesForNode(target);
  if (!allowedRoles.includes(targetRole)) return false;
  // 编辑原图只属于图片生成节点；来源节点通过 mediaType 收窄，
  // 模式收窄避免把编辑语义挂到来源节点上。
  if (targetRole === 'imageEdit' && target.data.mode !== 'generate') return false;
  const capability = target.data.mediaType === 'video' && target.data.videoMode ? videoModeCapability(target.data.videoMode, target.data.modelAlias) : undefined;
  const allowedMedia = capability?.roleMediaTypes?.[targetRole] ?? targetRoleMediaTypes[targetRole];
  return allowedMedia.includes(source.data.mediaType);
}
/** 视频规范输入中基数为 0..1 的角色。 */
export const videoSingletonInputRoles = ['prompt', 'negativePrompt', 'firstFrame', 'lastFrame'];
/** 视频规范输入中可重复且必须保序的角色。 */
export const videoRepeatableInputRoles = ['character', 'style', 'referenceImage'];
/** 图片落到视频节点主体时可供选择的角色。旧画布未写 videoMode 时仍可弹出。 */
export const videoImageInputRoles = ['firstFrame', 'lastFrame', 'character', 'style', 'referenceImage'];
/**
 * 返回当前视频模式下，图片落到节点主体时可选的角色。
 * 显式模式不再把角色/风格当成独立入口；首尾帧只选首帧或尾帧。
 * @param videoMode 节点上的显式模式；缺省表示旧画布。
 */
export function videoImageRolesForMode(videoMode) {
  if (videoMode === 'first_frame') return ['firstFrame'];
  if (videoMode === 'first_last_frame') return ['firstFrame', 'lastFrame'];
  if (videoMode === 'omni_reference' || videoMode === 'video_edit' || videoMode === 'video_extend') {
    return ['referenceImage'];
  }
  if (videoMode === 'text_to_video') return [];
  return ['firstFrame', 'lastFrame', 'referenceImage'];
}
/**
 * 返回节点已选择的视频模式；提示词资源提及不会隐式改写用户的模式选择。
 * @param videoMode 节点上的显式视频模式。
 * @param hasPromptResourceMentions 保留兼容的提示词提及参数，不参与模式推断。
 */
export function videoModeForPromptMentions(videoMode, hasPromptResourceMentions) {
  void hasPromptResourceMentions;
  return videoMode;
}
/**
 * 提示词里的资源提及在当前视频模式下可吸收的输入角色。
 * 全能参考、编辑和延长把图/视频/音频收成参考素材，而不是走聊天多模态提及合同。
 * @param mediaType 提及的媒体类型。
 * @param videoMode 节点上的显式视频模式。
 * @param modelAlias 用于按能力矩阵收窄 Grok 只收图片等约束。
 */
export function videoInputRoleForPromptMention(mediaType, videoMode, modelAlias) {
  return mediaType === 'image' ? 'referenceImage' : mediaType === 'audio' ? 'audioTrack' : mediaType === 'video' ? 'content' : 'prompt';
}
/**
 * 返回视频节点提示词中不能被当前模式吸收、仍需单独失败的资源提及。
 * @param node 目标视频节点的媒体、模式和模型。
 * @param mentions 该节点上的冻结资源提及。
 */
export function unabsorbedVideoPromptMentions(node, mentions, modelAlias = node.modelAlias) {
  if (node.mediaType !== 'video' || node.mode === 'source') return [...mentions];
  return mentions.filter(mention => !videoInputRoleForPromptMention(mention.mediaType, node.videoMode, modelAlias));
}
/**
 * 视频节点无法吸收提示词资源提及时的说明，避免误用聊天提及能力文案。
 * @param mentionMediaType 提及媒体。
 * @param videoMode 当前视频模式。
 * @param modelAlias 模型 ID。
 */
export function unabsorbedVideoPromptMentionMessage(mentionMediaType, videoMode, modelAlias) {
  if (videoMode === 'omni_reference' || videoMode === 'video_edit' || videoMode === 'video_extend') {
    return `当前项目尚未接通模型 ${modelAlias ?? 'unknown-model'} 的${videoModeLabels[videoMode]}${mentionMediaType === 'image' ? '图片' : mentionMediaType === 'video' ? '视频' : mentionMediaType === 'audio' ? '音频' : mentionMediaType}提及映射`;
  }
  const modeLabel = videoMode ? videoModeLabels[videoMode] : '全能参考';
  return `视频模式「${modeLabel}」不能使用提示词资源提及。请把素材加到当前节点的资源条，或确认已选择全能参考`;
}
/** 未知模型默认只允许 prompt 和至多一张首帧。 */
export const confirmedLiveVideoInputRoles = ['prompt', 'firstFrame'];
/** grok-imagine-video-1.5 官方参考图上限。 */
export const GROK_IMAGINE_VIDEO_15_MAX_REFERENCE_IMAGES = 7;
/** grok-imagine-video-1.5 已文档化的真实输入角色。 */
export const grokImagineVideo15InputRoles = ['prompt', 'firstFrame', 'lastFrame', 'character', 'style', 'referenceImage'];
/** H3、Wan3 与 Seedance 2.x 已确认的参考输入角色。 */
export const referenceVideoInputRoles = ['prompt', 'firstFrame', 'lastFrame', 'character', 'style', 'referenceImage', 'content', 'audioTrack'];
/** Wan3 在通用参考角色之外还支持负向提示词。 */
export const wan3VideoInputRoles = [...referenceVideoInputRoles, 'negativePrompt'];
/**
 * 判断模型是否属于 grok-imagine-video-1.5 系列，含 1.5.1 与按次别名。
 * @param modelAlias 运行快照中的模型 ID。
 */
export function isGrokImagineVideo15(modelAlias) {
  return videoFamilyForModel(modelAlias) === 'grok-imagine-video-1.5';
}
/**
 * 返回该模型当前允许发真实 POST 的输入角色。
 * @param modelAlias 运行快照中的模型 ID。
 */
export function confirmedVideoInputRolesForModel(modelAlias) {
  const yuanliuContract = yuanliuVideoContractForModel(modelAlias);
  if (yuanliuContract) return yuanliuContract.confirmedInputRoles;
  const image2proContract = image2proVideoContractForModel(modelAlias);
  if (image2proContract) return image2proContract.confirmedInputRoles;
  const moonContract = moonVideoContractForModel(modelAlias);
  if (moonContract) return moonContract.confirmedInputRoles;
  const family = videoFamilyForModel(modelAlias);
  if (family === 'grok-imagine-video-1.5') return grokImagineVideo15InputRoles;
  if (family === 'wan3') return wan3VideoInputRoles;
  if (family === 'moon-minimax-h3' || family === 'minimax-h3' || family === 'seedance-2' || family === 'seedance-2.5') {
    return referenceVideoInputRoles;
  }
  return confirmedLiveVideoInputRoles;
}
/** 视频生成场景。用于预检和摘要；显式 videoMode 存在时由模式决定，不再靠连线猜测。 */
export const videoOperationTypes = ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_guided', 'omni_reference'];
/**
 * 把显式视频模式映射为预检摘要使用的场景标识。
 * @param mode 节点上的视频模式。
 */
export function videoModeToOperation(mode) {
  if (mode === 'first_frame') return 'image_to_video';
  if (mode === 'first_last_frame') return 'first_last_frame';
  if (mode === 'omni_reference' || mode === 'video_edit' || mode === 'video_extend') {
    return 'omni_reference';
  }
  return 'text_to_video';
}
/**
 * 按 sortOrder 与原始下标稳定排序运行输入。
 * @param inputs 快照中的输入列表。
 * @returns 排序后的新数组，不修改原列表。
 */
export function orderedRunInputs(inputs) {
  return inputs.map((input, index) => ({
    input,
    index
  })).sort((left, right) => left.input.sortOrder - right.input.sortOrder || left.index - right.index).map(({
    input
  }) => input);
}
function emptyVideoInputSet() {
  return {
    character: [],
    style: [],
    referenceImage: [],
    content: [],
    audioTrack: [],
    transcript: [],
    mask: []
  };
}
function videoCardinalityIssue(role) {
  return {
    code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
    role,
    message: `New API video 不支持该输入角色的多个值：${role}`
  };
}
function videoUnsupportedRoleIssue(role) {
  return {
    code: 'UNSUPPORTED_INPUT_ROLE',
    role,
    message: `New API video 不支持该输入角色：${role}`
  };
}
/**
 * 把画布/快照输入收成规范 VideoInputSet。
 * 文本 content 兼容映射为 prompt；参考、编辑和延长模式下，图片 content 收成参考图、音频 content 收成参考音频。
 * 其他模式里图片 content 仍兼容映射为首帧，视频 content 留在 content 列表。
 * @param inputs 已冻结的运行输入。
 * @param videoMode 显式视频模式；缺省保持旧画布兼容映射。
 * @returns 规范集合与收集阶段发现的基数问题。
 */
export function collectVideoInputSet(inputs, videoMode) {
  const inputSet = emptyVideoInputSet();
  const issues = [];
  const referenceMode = videoMode === 'omni_reference' || videoMode === 'video_edit' || videoMode === 'video_extend';
  const assignSingleton = (role, input) => {
    if (inputSet[role]) {
      issues.push(videoCardinalityIssue(role));
      return;
    }
    inputSet[role] = input;
  };
  for (const input of orderedRunInputs(inputs)) {
    if (input.role === 'prompt' || input.role === 'content' && input.snapshot.data.mediaType === 'text') {
      assignSingleton('prompt', input);
      continue;
    }
    if (input.role === 'negativePrompt') {
      assignSingleton('negativePrompt', input);
      continue;
    }
    if (input.role === 'lastFrame') {
      assignSingleton('lastFrame', input);
      continue;
    }
    if (referenceMode && input.role === 'content' && input.snapshot.data.mediaType === 'image') {
      inputSet.referenceImage.push(input);
      continue;
    }
    if (referenceMode && input.role === 'content' && input.snapshot.data.mediaType === 'audio') {
      inputSet.audioTrack.push(input);
      continue;
    }
    if (input.role === 'firstFrame' || input.role === 'content' && input.snapshot.data.mediaType === 'image') {
      assignSingleton('firstFrame', input);
      continue;
    }
    if (input.role === 'character' || input.role === 'style' || input.role === 'referenceImage') {
      inputSet[input.role].push(input);
      continue;
    }
    if (input.role === 'content') {
      inputSet.content.push(input);
      continue;
    }
    if (input.role === 'audioTrack' || input.role === 'transcript' || input.role === 'mask') {
      inputSet[input.role].push(input);
      continue;
    }
    issues.push(videoUnsupportedRoleIssue(input.role));
  }
  return {
    inputSet,
    issues
  };
}
/**
 * 根据规范输入推断视频生成场景。旧画布未写 videoMode 时使用。
 * @param inputSet 已收集的规范输入。
 * @returns 用于摘要和预检的场景标识。
 */
export function inferVideoOperation(inputSet) {
  const hasVideoOrAudio = inputSet.content.length > 0 || inputSet.audioTrack.length > 0 || inputSet.transcript.length > 0;
  const referenceCount = Number(inputSet.character.length > 0) + Number(inputSet.style.length > 0) + Number(inputSet.referenceImage.length > 0);
  if (hasVideoOrAudio || referenceCount > 0 && (inputSet.firstFrame || inputSet.lastFrame)) {
    return 'omni_reference';
  }
  if (inputSet.character.length || inputSet.style.length || inputSet.referenceImage.length) {
    return 'reference_guided';
  }
  if (inputSet.lastFrame) return 'first_last_frame';
  if (inputSet.firstFrame) return 'image_to_video';
  return 'text_to_video';
}
/** 将单值或多值角色统一为输入列表，供模式必填与媒体类型校验使用。 */
/** 按已确认的官方模型限制检查参考数量和纯音频组合，向预检结果追加错误。 */
/**
 * 对视频规范输入做权威预检。
 * 显式 videoMode 按模式互斥检查；旧画布未写模式时沿用角色白名单。
 * @param inputs 已冻结的运行输入。
 * @param options 模型、参数和可选的显式视频模式。
 * @returns 场景、规范集合和请求前必须处理的问题。
 */
export function precheckVideoGenerationInputs(inputs, options = {}) {
  const collectionMode = !options.videoMode && (image2proVideoContractForModel(options.modelAlias) || yuanliuVideoContractForModel(options.modelAlias)) ? 'omni_reference' : options.videoMode;
  const {
    inputSet
  } = collectVideoInputSet(inputs, collectionMode);
  return {
    operation: options.videoMode ? videoModeToOperation(options.videoMode) : inferVideoOperation(inputSet),
    inputSet,
    issues: []
  };
}
/**
 * 读取视频节点的完成动作；缺省旧节点视为 none。
 * @param data 节点 data。
 * @returns 规范化后的完成动作。
 */
export function resolveVideoCompletionAction(data) {
  return data?.completionAction ?? 'none';
}
/**
 * 为一次视频运行构造稳定的末帧动作身份。
 * @param input 运行、源节点、动作和可选目标。
 * @returns 非空 actionId。
 */
export function videoFinalFrameActionId(input) {
  return ['final-frame',, input.runId, input.sourceNodeId, input.action, input.targetNodeId ?? 'none'].join(':');
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJ6IiwidmlkZW9SZWNyZWF0aW9uQ29uZmlnU2NoZW1hIiwicGFyc2VWaWRlb1JlY3JlYXRpb25UZW1wbGF0ZSIsIm1vb25WaWRlb0NvbnRyYWN0Rm9yTW9kZWwiLCJ5dWFubGl1VmlkZW9Db250cmFjdEZvck1vZGVsIiwiaW1hZ2UycHJvVmlkZW9Db250cmFjdEZvck1vZGVsIiwibWVkaWFUeXBlcyIsIm5vZGVNb2RlcyIsInZpZGVvTW9kZXMiLCJpbXBsZW1lbnRlZFZpZGVvTW9kZXMiLCJ2aWRlb01vZGVTY2hlbWEiLCJlbnVtIiwidmlkZW9Nb2RlTGFiZWxzIiwidGV4dF90b192aWRlbyIsImZpcnN0X2ZyYW1lIiwiZmlyc3RfbGFzdF9mcmFtZSIsIm9tbmlfcmVmZXJlbmNlIiwidmlkZW9fZWRpdCIsInZpZGVvX2V4dGVuZCIsInZpZGVvTW9kZURlc2NyaXB0aW9ucyIsIm5vcm1hbGl6ZU5vZGVNb2RlIiwidmFsdWUiLCJwb3J0Um9sZXMiLCJhc3NldFN0YXR1c2VzIiwibWVkaWFUeXBlU2NoZW1hIiwibW9kZWxTZWxlY3Rpb25TY2hlbWEiLCJvYmplY3QiLCJtb2RlbEFsaWFzIiwic3RyaW5nIiwidHJpbSIsIm1pbiIsImNyZWRlbnRpYWxJZCIsIm9wdGlvbmFsIiwibm9kZU1vZGVTY2hlbWEiLCJwcmVwcm9jZXNzIiwicG9ydFJvbGVTY2hlbWEiLCJhc3NldFN0YXR1c1NjaGVtYSIsInJ1blN0YXR1c2VzIiwicnVuU3RhdHVzU2NoZW1hIiwicHJvdmlkZXJKb2JTdGF0dXNlcyIsInByb3ZpZGVySm9iU3RhdHVzU2NoZW1hIiwid29ya2Zsb3dOb2RlU3RhdHVzZXMiLCJ3b3JrZmxvd05vZGVTdGF0dXNTY2hlbWEiLCJwcm92aWRlckpvYlNjaGVtYSIsImlkIiwicHJvdmlkZXIiLCJwbGF0Zm9ybUpvYklkIiwic3RhdHVzIiwicHJvZ3Jlc3MiLCJudW1iZXIiLCJpbnQiLCJtYXgiLCJwYXlsb2FkIiwicmVjb3JkIiwidW5rbm93biIsImNyZWF0ZWRBdCIsImRhdGV0aW1lIiwidXBkYXRlZEF0IiwicnVuUmVzdWx0QXNzZXRTY2hlbWEiLCJhc3NldElkIiwidmVyc2lvbiIsInBvc2l0aXZlIiwiY29udGVudFVybCIsIm1pbWVUeXBlIiwic2l6ZUJ5dGVzIiwibm9ubmVnYXRpdmUiLCJzaGEyNTYiLCJyZWdleCIsImFzc2V0U2NoZW1hIiwibmFtZSIsIm1lZGlhVHlwZSIsImxhdGVzdFZlcnNpb24iLCJ0YWdzIiwiYXJyYXkiLCJkZWZhdWx0IiwibWV0YWRhdGEiLCJhcmNoaXZlZEF0IiwibWVudGlvbkJpbmRpbmdPYmplY3RTY2hlbWEiLCJlbnRpdHlOYW1lIiwic2VtYW50aWNSb2xlIiwic2NvcGUiLCJwYXNzdGhyb3VnaCIsIm1lbnRpb25CaW5kaW5nU2NoZW1hIiwic2FuaXRpemVNZW50aW9uQmluZGluZ1ZhbHVlIiwia2V5IiwiaXNTZW5zaXRpdmVNZW50aW9uS2V5IiwidW5kZWZpbmVkIiwibG9va3NMaWtlTG9jYWxQYXRoIiwiQXJyYXkiLCJpc0FycmF5IiwibWFwIiwiaXRlbSIsImZpbHRlciIsIm91dHB1dCIsImNoaWxkS2V5IiwiY2hpbGRWYWx1ZSIsIk9iamVjdCIsImVudHJpZXMiLCJzYW5pdGl6ZWQiLCJub3JtYWxpemVkIiwicmVwbGFjZSIsInRvTG93ZXJDYXNlIiwidGVzdCIsInByb21wdE1lbnRpb25TY2hlbWEiLCJ0eXBlIiwibGl0ZXJhbCIsIm1lbnRpb25JZCIsImxhYmVsIiwiYXNzZXRWZXJzaW9uIiwiaW5saW5lIiwicGxhY2Vob2xkZXIiLCJib29sZWFuIiwicGxhY2Vob2xkZXJSZWFzb24iLCJiaW5kaW5nIiwic3RyaXAiLCJwcm9tcHRUZXh0QmxvY2tTY2hlbWEiLCJ0ZXh0IiwicHJvbXB0QmxvY2tTY2hlbWEiLCJkaXNjcmltaW5hdGVkVW5pb24iLCJwcm9tcHREb2N1bWVudFNjaGVtYSIsImJsb2NrcyIsInN1cGVyUmVmaW5lIiwiZG9jdW1lbnQiLCJjb250ZXh0IiwibWVudGlvbklkcyIsIlNldCIsInRleHRMZW5ndGgiLCJmb3JFYWNoIiwiYmxvY2siLCJpbmRleCIsImxlbmd0aCIsImhhcyIsImFkZElzc3VlIiwiY29kZSIsIlpvZElzc3VlQ29kZSIsImN1c3RvbSIsIm1lc3NhZ2UiLCJwYXRoIiwiYWRkIiwibWVudGlvbkRpc3BsYXlOYW1lIiwibWVudGlvbiIsIm5hbWVkIiwiZGVmYXVsdFJlc291cmNlRGlzcGxheU5hbWUiLCJmaWxlTmFtZSIsImJhc2UiLCJzdHJpcHBlZCIsInN0ZW0iLCJzbGljZSIsInVuaXF1ZVJlc291cmNlRGlzcGxheU5hbWUiLCJ0YWtlbiIsIm5hbWVzIiwicm9vdCIsInJlbmRlclByb21wdERvY3VtZW50IiwicGFyc2VkIiwicGFyc2UiLCJqb2luIiwiZ2V0RWZmZWN0aXZlUHJvbXB0RG9jdW1lbnQiLCJpbnB1dCIsInByb21wdERvY3VtZW50IiwicHJvbXB0IiwiZnJvemVuSW1hZ2VFZGl0Q2FwYWJpbGl0eVNjaGVtYSIsImRlY2xhcmVkIiwibWltZVR5cGVzIiwic2l6ZXMiLCJwYXJhbWV0ZXJzIiwibWF4SW1hZ2VzIiwiZnJvemVuUHJvbXB0TWVudGlvblNjaGVtYSIsIm5vZGVJZCIsImR1cmF0aW9uU2Vjb25kcyIsImZpbml0ZSIsImJsb2NrT3JkZXIiLCJ2aWRlb0NvbXBsZXRpb25BY3Rpb25zIiwidmlkZW9Db21wbGV0aW9uQWN0aW9uU2NoZW1hIiwiVklERU9fRklOQUxfRlJBTUVfUE9MSUNZX1ZFUlNJT04iLCJub2RlUmVzb3VyY2VSZWZTY2hlbWEiLCJhdHRhY2hlZCIsImdldEV4ZWN1dGlvblByb21wdERvY3VtZW50IiwicmVzb3VyY2VSZWZzIiwicmVmZXJlbmNlIiwiaWRzIiwiZmxhdE1hcCIsImlkZW50aXRpZXMiLCJwcm9tcHRSZXNvdXJjZUlkZW50aXR5IiwicHVzaCIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbWFnZUVkaXRTb3VyY2VTY2hlbWEiLCJzb3VyY2VOb2RlSWQiLCJzb3VyY2VLaW5kIiwiaW1hZ2VFZGl0U291cmNlT2YiLCJkYXRhIiwic2FmZVBhcnNlIiwiaW1hZ2VFZGl0U291cmNlIiwic3VjY2VzcyIsIlJFUVVFU1RfUFJPTVBUX1NDSEVNQV9WRVJTSU9OIiwicmVxdWVzdFByb21wdEZvcm1hdHMiLCJyZXF1ZXN0UHJvbXB0Rm9ybWF0U2NoZW1hIiwicmVxdWVzdFByb21wdFBhcnRTY2hlbWEiLCJvcmRlciIsInJvbGUiLCJyZXF1ZXN0UHJvbXB0UmVzb3VyY2VTY2hlbWEiLCJzb3J0T3JkZXIiLCJyZXF1ZXN0UHJvbXB0U2VuZFN0YXR1c2VzIiwicmVxdWVzdFByb21wdFNlbmRTdGF0dXNTY2hlbWEiLCJyZXF1ZXN0UHJvbXB0UmVjb3JkU2NoZW1hIiwic2NoZW1hVmVyc2lvbiIsInJ1bklkIiwiYXR0ZW1wdCIsInJlcXVlc3RJZGVudGl0eSIsImNyZWRlbnRpYWxWZXJzaW9uIiwiZm9ybWF0IiwicGFydHMiLCJuZWdhdGl2ZVRleHQiLCJyZXNvdXJjZXMiLCJzZW5kU3RhdHVzIiwic3VtbWFyeSIsInN1bW1hcnlTb3VyY2UiLCJyZXF1ZXN0UHJvbXB0UmVjb3JkS2V5IiwicmVxdWVzdFByb21wdFBhcnRQcmVmaXgiLCJwYXJ0IiwicmVuZGVyUmVxdWVzdFByb21wdFRleHQiLCJvcmRlcmVkIiwic29ydCIsImxlZnQiLCJyaWdodCIsInJlcXVlc3RQcm9tcHRPcmlnaW5zIiwibm9kZVRpbWluZ1NjaGVtYSIsInF1ZXVlZEF0Iiwic3RhcnRlZEF0IiwiZmluaXNoZWRBdCIsIm91dGNvbWUiLCJyZXF1ZXN0U3RhcnRlZEF0IiwicmVxdWVzdEZpbmlzaGVkQXQiLCJub2RlVGltaW5nRHVyYXRpb24iLCJ0aW1pbmciLCJub3ciLCJzdGFydGVkIiwicGFyc2VUaW1pbmdJbnN0YW50IiwiZmluaXNoZWQiLCJhdmFpbGFiaWxpdHkiLCJyZWFzb24iLCJtaWxsaXNlY29uZHMiLCJzaW5jZSIsImZvcm1hdE5vZGVEdXJhdGlvbiIsIk51bWJlciIsImlzRmluaXRlIiwidG9GaXhlZCIsIkRhdGUiLCJub2RlSGFzRWNobyIsIm5vZGUiLCJCb29sZWFuIiwicmVzdWx0QXNzZXQiLCJpc0ltYWdlRWRpdFNvdXJjZU5vZGUiLCJJTUFHRV9FRElUX01BWF9JTUFHRVMiLCJyZXNvbHZlSW1hZ2VFZGl0TWF4SW1hZ2VzIiwiY2FwYWJpbGl0eSIsIlBPU0lUSVZFX0lORklOSVRZIiwiaW1hZ2VFZGl0Q2FwYWJpbGl0eUtleXMiLCJyZWFkU3RyaW5nQXJyYXkiLCJ2YWx1ZXMiLCJpc0ltYWdlRWRpdERlY2xhcmF0aW9uIiwic3VwcG9ydGVkIiwic3VwcG9ydHMiLCJrZXlzIiwiaW1hZ2VFZGl0Q2FwYWJpbGl0eSIsIm1vZGVsIiwiY2FwYWJpbGl0aWVzIiwidW5zdXBwb3J0ZWQiLCJtaW1lX3R5cGVzIiwiZmllbGRzIiwiaGFzTWF4SW1hZ2VzIiwiaGFzT3duIiwibWF4X2ltYWdlcyIsInZhbGlkTWF4SW1hZ2VzIiwiaXNJbnRlZ2VyIiwiaW52YWxpZE1heEltYWdlcyIsIklNQUdFX0VESVRfVU5TVVBQT1JURURfQ09ERSIsIkdFTkVSQVRJT05fQ09VTlRfTUFYIiwiREVGQVVMVF9HRU5FUkFUSU9OX0NPVU5UIiwiaXNWYWxpZEdlbmVyYXRpb25Db3VudCIsImdldE5vZGVHZW5lcmF0aW9uQ291bnQiLCJnZW5lcmF0aW9uQ291bnQiLCJSYW5nZUVycm9yIiwibm9kZURhdGFTY2hlbWEiLCJtb2RlIiwiZW5hYmxlZCIsInN0YWxlIiwibWFudWFsT3V0cHV0IiwibWFudWFsT3V0cHV0UnVuSWQiLCJwcm9tcHRTa2lsbElkIiwiZ2VuZXJhdGlvbkJhdGNoIiwicm9vdE5vZGVJZCIsImdlbmVyYXRpb25CYXRjaEV4cGFuZGVkIiwiaW5mZXJlbmNlU3RyZW5ndGgiLCJjb21wbGV0aW9uQWN0aW9uIiwiY29tcGxldGlvblRhcmdldE5vZGVJZCIsInZpZGVvTW9kZSIsInZpZGVvUmVjcmVhdGlvbiIsInZpZGVvUmVjcmVhdGlvbkRyYWZ0IiwiaXNDYW52YXNOb2RlRW5hYmxlZCIsImNhbnZhc05vZGVTY2hlbWEiLCJwb3NpdGlvbiIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJjYW52YXNFZGdlU2NoZW1hIiwic291cmNlSGFuZGxlIiwidGFyZ2V0Tm9kZUlkIiwidGFyZ2V0SGFuZGxlIiwiQ0FOVkFTX0dST1VQX01JTl9TSVpFIiwiQ0FOVkFTX0dST1VQX01BWF9TSVpFIiwiQ0FOVkFTX0dST1VQX05PREVfTElNSVQiLCJjYW52YXNHcm91cFNjaGVtYSIsIm5vZGVJZHMiLCJjYW52YXNEb2N1bWVudFNjaGVtYSIsInJldmlzaW9uIiwibm9kZXMiLCJlZGdlcyIsImdyb3VwcyIsIm5vZGVzQnlJZCIsIk1hcCIsInNldCIsImVkZ2VzQnlTb3VyY2UiLCJlZGdlSWRzIiwiZWRnZSIsInNvdXJjZSIsImdldCIsInRhcmdldCIsImlzUG9ydENvbm5lY3Rpb25BbGxvd2VkIiwic291cmNlRWRnZXMiLCJ2aXNpdGluZyIsInZpc2l0ZWQiLCJ2aXNpdCIsInRhcmdldElkIiwiZGVsZXRlIiwiZ3JvdXBJZHMiLCJtZW1iZXJHcm91cElkIiwiZ3JvdXAiLCJtZW1iZXJzIiwibWVtYmVySW5kZXgiLCJleGlzdGluZyIsInJ1bklucHV0U25hcHNob3RTY2hlbWEiLCJzb3VyY2VBc3NldElkIiwic291cmNlQXNzZXRWZXJzaW9uIiwic291cmNlRHVyYXRpb25TZWNvbmRzIiwic25hcHNob3QiLCJuZXdBcGlFeGVjdXRpb25BdXRob3JpdHlTY2hlbWEiLCJpc3N1ZXIiLCJ1cmwiLCJleHRlcm5hbFVzZXJJZCIsImluc3RhbmNlSWQiLCJncmFudElkIiwidG9rZW5JZCIsImNyZWRlbnRpYWxSZXZpc2lvbiIsInJlZmluZSIsInBlcm1pc3Npb25SZXZpc2lvbiIsImF1dG9Hcm91cHMiLCJydW5DcmVkZW50aWFsUmVmZXJlbmNlU2NoZW1hIiwibmV3QXBpIiwicnVuRXhlY3V0aW9uQmluZGluZ1NjaGVtYSIsImNvbnRyYWN0IiwiYXV0aG9yaXR5IiwicmV2ZXJzZVByb21wdFNvdXJjZVNjaGVtYSIsImF1dG9tYXRpYyIsInB1cnBvc2UiLCJyZXZlcnNlUHJvbXB0UmVzdWx0U2NoZW1hIiwicGFyc2VSZXZlcnNlUHJvbXB0T3V0cHV0IiwidHJpbW1lZCIsImZlbmNlZCIsImV4ZWMiLCJyZXN1bHQiLCJFcnJvciIsInJ1blNuYXBzaG90U2NoZW1hIiwicHJvamVjdElkIiwiY2FudmFzUmV2aXNpb24iLCJub2RlQ3JlZGVudGlhbFJlZmVyZW5jZXMiLCJleGVjdXRpb25CaW5kaW5ncyIsInN1Ym1pdHRlZEF0IiwiaW5wdXRzIiwicHJvbXB0TWVudGlvbnMiLCJub2RlSW1hZ2VFZGl0Q2FwYWJpbGl0aWVzIiwicmV2ZXJzZVByb21wdCIsInByb21wdE9wdGltaXphdGlvbiIsInNraWxsSWQiLCJza2lsbFZlcnNpb24iLCJpbnN0cnVjdGlvbiIsImRvY3VtZW50UmVzdWx0IiwiaXNzdWUiLCJlcnJvciIsImlzc3VlcyIsInNvbWUiLCJwZW5kaW5nIiwicG9wIiwiaW5kZXhPZiIsImZpbmQiLCJjYW5kaWRhdGUiLCJtZW50aW9uS2V5cyIsImxhc3RNZW50aW9uT3JkZXJCeU5vZGUiLCJvcmRlck5vZGVJZCIsInByZXZpb3VzT3JkZXIiLCJjYW5vbmljYWxSdW5TbmFwc2hvdEpzb24iLCJfc3VibWl0dGVkQXQiLCJzdGFibGVTbmFwc2hvdCIsImNhbm9uaWNhbEpzb25WYWx1ZSIsInJ1blNuYXBzaG90RmluZ2VycHJpbnRNYXRlcmlhbCIsImZyb21FbnRyaWVzIiwidmlkZW9GaW5hbEZyYW1lU3RhdHVzZXMiLCJ2aWRlb0ZpbmFsRnJhbWVTdGF0dXNTY2hlbWEiLCJydW5SZXN1bHRGaW5hbEZyYW1lU2NoZW1hIiwiYWN0aW9uIiwiYWN0aW9uSWQiLCJwb2xpY3lWZXJzaW9uIiwicHJldmlld1VybCIsImVycm9yQ29kZSIsInJ1blJlc3VsdFNjaGVtYSIsImlucHV0Q291bnQiLCJzaW11bGF0ZWQiLCJhc3NldCIsInByb3ZpZGVySm9iIiwiZmluYWxGcmFtZSIsIndvcmtmbG93Tm9kZVN0YXRlU2NoZW1hIiwic3RhdGUiLCJ3b3JrZmxvd1N0YXRlU2NoZW1hIiwicnVuUmVjb3JkU2NoZW1hIiwidXNlcklkIiwiaWRlbXBvdGVuY3lLZXkiLCJyZXRyeU9mIiwibm9kZVRpbWluZ3MiLCJydW5Kb2JEYXRhU2NoZW1hIiwid29ya2Zsb3dTdGF0ZSIsImNhbmNlbFJlcXVlc3RlZCIsInJldHJpZXZlT25seSIsImpvYiIsInJ1bkpvYlJlc3VsdFNjaGVtYSIsInJ1blN0YXR1c1RyYW5zaXRpb25zIiwiZHJhZnQiLCJxdWV1ZWQiLCJwcmVwYXJpbmciLCJydW5uaW5nIiwicHJvY2Vzc2luZyIsInN1Y2NlZWRlZCIsImZhaWxlZCIsImNhbmNlbF9yZXF1ZXN0ZWQiLCJjYW5jZWxsZWQiLCJjYW5UcmFuc2l0aW9uUnVuU3RhdHVzIiwiZnJvbSIsInRvIiwiaW5jbHVkZXMiLCJ0YXJnZXRSb2xlTWVkaWFUeXBlcyIsIm5lZ2F0aXZlUHJvbXB0IiwiY29udGVudCIsInN0eWxlIiwiY2hhcmFjdGVyIiwicmVmZXJlbmNlSW1hZ2UiLCJmaXJzdEZyYW1lIiwibGFzdEZyYW1lIiwiYXVkaW9UcmFjayIsInRyYW5zY3JpcHQiLCJtYXNrIiwiaW1hZ2VFZGl0IiwidGFyZ2V0Tm9kZVBvcnRSb2xlcyIsImltYWdlIiwiYXVkaW8iLCJ2aWRlbyIsInRhcmdldFBvcnRSb2xlc0Zvck1lZGlhVHlwZSIsInZpZGVvRmFtaWx5Rm9yTW9kZWwiLCJleGFjdElkIiwic3RhcnRzV2l0aCIsIm1vb25Db250cmFjdCIsImZhbWlseSIsInRleHRUb1ZpZGVvUm9sZXMiLCJ0ZXh0VG9WaWRlb1dpdGhOZWdhdGl2ZVJvbGVzIiwiZmlyc3RGcmFtZVJvbGVzIiwiZmlyc3RGcmFtZVdpdGhOZWdhdGl2ZVJvbGVzIiwiZmlyc3RMYXN0RnJhbWVSb2xlcyIsImZpcnN0TGFzdEZyYW1lV2l0aE5lZ2F0aXZlUm9sZXMiLCJvbW5pUmVmZXJlbmNlUm9sZXMiLCJvbW5pUmVmZXJlbmNlV2l0aE5lZ2F0aXZlUm9sZXMiLCJncm9rT21uaVJlZmVyZW5jZVJvbGVzIiwicmVmZXJlbmNlUm9sZU1lZGlhVHlwZXMiLCJyZWZlcmVuY2VSZXBlYXRhYmxlUm9sZXMiLCJ2aWRlb01vZGVDYXBhYmlsaXR5Iiwic2VsZWN0YWJsZSIsImxpdmVQb3N0Iiwicm9sZXMiLCJyZXBlYXRhYmxlUm9sZXMiLCJyb2xlTWVkaWFUeXBlcyIsInRhcmdldFBvcnRSb2xlc0ZvclZpZGVvTW9kZSIsInRhcmdldFBvcnRSb2xlc0Zvck5vZGUiLCJpc0ltcGxlbWVudGVkVmlkZW9Nb2RlIiwiaW5mZXJWaWRlb01vZGVGcm9tUm9sZXMiLCJkaXNwbGF5VmlkZW9Nb2RlIiwiY29ubmVjdGVkUm9sZXMiLCJzb3VyY2VNZWRpYVR5cGUiLCJ0YXJnZXRSb2xlIiwiYWxsb3dlZFJvbGVzIiwiYWxsb3dlZE1lZGlhIiwidmlkZW9TaW5nbGV0b25JbnB1dFJvbGVzIiwidmlkZW9SZXBlYXRhYmxlSW5wdXRSb2xlcyIsInZpZGVvSW1hZ2VJbnB1dFJvbGVzIiwidmlkZW9JbWFnZVJvbGVzRm9yTW9kZSIsInZpZGVvTW9kZUZvclByb21wdE1lbnRpb25zIiwiaGFzUHJvbXB0UmVzb3VyY2VNZW50aW9ucyIsInZpZGVvSW5wdXRSb2xlRm9yUHJvbXB0TWVudGlvbiIsInVuYWJzb3JiZWRWaWRlb1Byb21wdE1lbnRpb25zIiwibWVudGlvbnMiLCJ1bmFic29yYmVkVmlkZW9Qcm9tcHRNZW50aW9uTWVzc2FnZSIsIm1lbnRpb25NZWRpYVR5cGUiLCJtb2RlTGFiZWwiLCJjb25maXJtZWRMaXZlVmlkZW9JbnB1dFJvbGVzIiwiR1JPS19JTUFHSU5FX1ZJREVPXzE1X01BWF9SRUZFUkVOQ0VfSU1BR0VTIiwiZ3Jva0ltYWdpbmVWaWRlbzE1SW5wdXRSb2xlcyIsInJlZmVyZW5jZVZpZGVvSW5wdXRSb2xlcyIsIndhbjNWaWRlb0lucHV0Um9sZXMiLCJpc0dyb2tJbWFnaW5lVmlkZW8xNSIsImNvbmZpcm1lZFZpZGVvSW5wdXRSb2xlc0Zvck1vZGVsIiwieXVhbmxpdUNvbnRyYWN0IiwiY29uZmlybWVkSW5wdXRSb2xlcyIsImltYWdlMnByb0NvbnRyYWN0IiwidmlkZW9PcGVyYXRpb25UeXBlcyIsInZpZGVvTW9kZVRvT3BlcmF0aW9uIiwib3JkZXJlZFJ1bklucHV0cyIsImVtcHR5VmlkZW9JbnB1dFNldCIsInZpZGVvQ2FyZGluYWxpdHlJc3N1ZSIsInZpZGVvVW5zdXBwb3J0ZWRSb2xlSXNzdWUiLCJjb2xsZWN0VmlkZW9JbnB1dFNldCIsImlucHV0U2V0IiwicmVmZXJlbmNlTW9kZSIsImFzc2lnblNpbmdsZXRvbiIsImluZmVyVmlkZW9PcGVyYXRpb24iLCJoYXNWaWRlb09yQXVkaW8iLCJyZWZlcmVuY2VDb3VudCIsInByZWNoZWNrVmlkZW9HZW5lcmF0aW9uSW5wdXRzIiwib3B0aW9ucyIsImNvbGxlY3Rpb25Nb2RlIiwib3BlcmF0aW9uIiwicmVzb2x2ZVZpZGVvQ29tcGxldGlvbkFjdGlvbiIsInZpZGVvRmluYWxGcmFtZUFjdGlvbklkIl0sInNvdXJjZXMiOlsiaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5pbXBvcnQgeyB2aWRlb1JlY3JlYXRpb25Db25maWdTY2hlbWEsIHBhcnNlVmlkZW9SZWNyZWF0aW9uVGVtcGxhdGUgfSBmcm9tICcuL3ZpZGVvLXJlY3JlYXRpb24uanMnO1xuaW1wb3J0IHsgbW9vblZpZGVvQ29udHJhY3RGb3JNb2RlbCB9IGZyb20gJy4vbW9vbi12aWRlby1jb250cmFjdC5qcyc7XG5pbXBvcnQgeyB5dWFubGl1VmlkZW9Db250cmFjdEZvck1vZGVsLCB9IGZyb20gJy4veXVhbmxpdS12aWRlby1jb250cmFjdC5qcyc7XG5pbXBvcnQgeyBpbWFnZTJwcm9WaWRlb0NvbnRyYWN0Rm9yTW9kZWwsIH0gZnJvbSAnLi9pbWFnZTJwcm8tdmlkZW8tY29udHJhY3QuanMnO1xuZXhwb3J0ICogZnJvbSAnLi92aWRlby1yZWNyZWF0aW9uLmpzJztcbmV4cG9ydCAqIGZyb20gJy4vbW9vbi12aWRlby1jb250cmFjdC5qcyc7XG5leHBvcnQgKiBmcm9tICcuL2ltYWdlMnByby12aWRlby1jb250cmFjdC5qcyc7XG5leHBvcnQgKiBmcm9tICcuL3l1YW5saXUtdmlkZW8tY29udHJhY3QuanMnO1xuZXhwb3J0ICogZnJvbSAnLi9wcm9tcHQtc2tpbGxzLmpzJztcbmV4cG9ydCAqIGZyb20gJy4vbmV3YXBpLWNvbnRyYWN0cy5qcyc7XG5leHBvcnQgKiBmcm9tICcuL2dlbmVyYXRpb24tY29uY3VycmVuY3kuanMnO1xuZXhwb3J0ICogZnJvbSAnLi9pbWFnZS1vdXRwdXQtcGFyYW1ldGVycy5qcyc7XG5leHBvcnQgY29uc3QgbWVkaWFUeXBlcyA9IFsndGV4dCcsICdpbWFnZScsICdhdWRpbycsICd2aWRlbyddO1xuLyoqIOeUu+W4g+iKgueCueaooeW8j+OAguWOhuWPsiBgdHJhbnNmb3JtYCDor7vlj5bml7blvZLkuIDkuLogYGdlbmVyYXRlYO+8jOS6p+WTgeS4jeWGjeWMuuWIhui9rOaNouiKgueCueOAgiAqL1xuZXhwb3J0IGNvbnN0IG5vZGVNb2RlcyA9IFsnc291cmNlJywgJ2dlbmVyYXRlJ107XG4vKiog6KeG6aKR55Sf5oiQ6IqC54K555qE5LiA5qyh6L+Q6KGM5qih5byP44CC6IqC54K55pys6Lqr5LiN5piv5qih5byP77yM5LiA5qyh6L+Q6KGM5Y+q6YCJ5LiA56eN44CCICovXG5leHBvcnQgY29uc3QgdmlkZW9Nb2RlcyA9IFtcbiAgICAndGV4dF90b192aWRlbycsXG4gICAgJ2ZpcnN0X2ZyYW1lJyxcbiAgICAnZmlyc3RfbGFzdF9mcmFtZScsXG4gICAgJ29tbmlfcmVmZXJlbmNlJyxcbiAgICAndmlkZW9fZWRpdCcsXG4gICAgJ3ZpZGVvX2V4dGVuZCcsXG5dO1xuLyoqIOW3suiQveWcsOeahOinhumikeaooeW8j++8m+WFt+S9k+aooeWei+iDveWQpumAieaLqeeUsSB2aWRlb01vZGVDYXBhYmlsaXR5IOWGs+WumuOAgiAqL1xuZXhwb3J0IGNvbnN0IGltcGxlbWVudGVkVmlkZW9Nb2RlcyA9IFtcbiAgICAndGV4dF90b192aWRlbycsXG4gICAgJ2ZpcnN0X2ZyYW1lJyxcbiAgICAnZmlyc3RfbGFzdF9mcmFtZScsXG4gICAgJ29tbmlfcmVmZXJlbmNlJyxcbiAgICAndmlkZW9fZWRpdCcsXG4gICAgJ3ZpZGVvX2V4dGVuZCcsXG5dO1xuZXhwb3J0IGNvbnN0IHZpZGVvTW9kZVNjaGVtYSA9IHouZW51bSh2aWRlb01vZGVzKTtcbi8qKiDop4bpopHmqKHlvI/nmoTkuK3mloflkI3np7DvvIzkvpvnlLvluIPpgInmi6nlmajlkozmkZjopoHlpI3nlKjjgIIgKi9cbmV4cG9ydCBjb25zdCB2aWRlb01vZGVMYWJlbHMgPSB7XG4gICAgdGV4dF90b192aWRlbzogJ+aWh+eUn+inhumikScsXG4gICAgZmlyc3RfZnJhbWU6ICfpppbluKcnLFxuICAgIGZpcnN0X2xhc3RfZnJhbWU6ICfpppblsL7luKcnLFxuICAgIG9tbmlfcmVmZXJlbmNlOiAn5YWo6IO95Y+C6ICDJyxcbiAgICB2aWRlb19lZGl0OiAn6KeG6aKR57yW6L6RJyxcbiAgICB2aWRlb19leHRlbmQ6ICfop4bpopHlu7bplb8nLFxufTtcbi8qKiDop4bpopHmqKHlvI/nmoTnn63or7TmmI7vvIzop6Pph4ror6XmqKHlvI/lkLjmlLblk6rkupvovpPlhaXjgIIgKi9cbmV4cG9ydCBjb25zdCB2aWRlb01vZGVEZXNjcmlwdGlvbnMgPSB7XG4gICAgdGV4dF90b192aWRlbzogJ+WPquS9v+eUqOaPkOekuuivjeeUn+aIkOaWsOinhumike+8jOS4jei/nuaOpeWbvueJh+OAgeinhumikeaIlumfs+mikeWPguiAgycsXG4gICAgZmlyc3RfZnJhbWU6ICfnlKjkuIDlvKDlm77lm7rlrprotbflp4vnlLvpnaLvvIzlho3mjInmj5DnpLror43nlJ/miJAnLFxuICAgIGZpcnN0X2xhc3RfZnJhbWU6ICfliIbliKvlm7rlrprotbflp4vnlLvpnaLlkoznu5PmnZ/nlLvpnaInLFxuICAgIG9tbmlfcmVmZXJlbmNlOiAn55So5Y+C6ICD5Zu+44CB5Y+C6ICD6KeG6aKR5oiW5Y+C6ICD6Z+z6aKR6J6N5ZCI55Sf5oiQ77yM5LiN5Zu65a6a6aaW5bC+5binJyxcbiAgICB2aWRlb19lZGl0OiAn55So5Y+C6ICD57Sg5p2Q5ZKM5o+Q56S66K+N57yW6L6R5LiA5q615bey5pyJ6KeG6aKRJyxcbiAgICB2aWRlb19leHRlbmQ6ICfnlKjlj4LogIPntKDmnZDlkozmj5DnpLror43lu7bplb/kuIDmrrXlt7LmnInop4bpopEnLFxufTtcbi8qKlxuICog5oqK5bey5bqf5byD55qE6L2s5o2i5qih5byP6K+75oiQ55Sf5oiQ5qih5byP77yM5L+d6K+B5pen55S75biD5LuN6IO95omT5byA44CCXG4gKiBAcGFyYW0gdmFsdWUg6IqC54K5IG1vZGUg5Y6f5aeL5YC844CCXG4gKiBAcmV0dXJucyDlvZLkuIDlkI7nmoTlgLzvvJvml6Dms5Xor4bliKvml7bljp/moLfov5Tlm57kuqTnu5kgc2NoZW1hIOagoemqjOOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplTm9kZU1vZGUodmFsdWUpIHtcbiAgICByZXR1cm4gdmFsdWUgPT09ICd0cmFuc2Zvcm0nID8gJ2dlbmVyYXRlJyA6IHZhbHVlO1xufVxuZXhwb3J0IGNvbnN0IHBvcnRSb2xlcyA9IFtcbiAgICAncHJvbXB0JyxcbiAgICAnbmVnYXRpdmVQcm9tcHQnLFxuICAgICdjb250ZW50JyxcbiAgICAnc3R5bGUnLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdyZWZlcmVuY2VJbWFnZScsXG4gICAgJ2ZpcnN0RnJhbWUnLFxuICAgICdsYXN0RnJhbWUnLFxuICAgICdhdWRpb1RyYWNrJyxcbiAgICAndHJhbnNjcmlwdCcsXG4gICAgJ21hc2snLFxuICAgIC8qKlxuICAgICAqIOWbvueJh+e8lui+kea1geeoi+eahOS4k+eUqOWOn+Wbvui+k+WFpeinkuiJsuOAgueUseKAnOS/ruaUueWbvueJh+KAneWFpeWPo+aYvuW8j+WGmeWFpe+8jFxuICAgICAqIOWPquaOpeWPl+WbvueJh+S4iua4uO+8jOS4jemdoOi/nuaOpemhuuW6j+aOqOaWree8lui+keaEj+WbvuOAglxuICAgICAqL1xuICAgICdpbWFnZUVkaXQnLFxuXTtcbmV4cG9ydCBjb25zdCBhc3NldFN0YXR1c2VzID0gWydyZWFkeScsICdhcmNoaXZlZCddO1xuZXhwb3J0IGNvbnN0IG1lZGlhVHlwZVNjaGVtYSA9IHouZW51bShtZWRpYVR5cGVzKTtcbmV4cG9ydCBjb25zdCBtb2RlbFNlbGVjdGlvblNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBtb2RlbEFsaWFzOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSksXG4gICAgLyoqIOacrOS6uuWIhue7hOeahOacjeWKoeerr+WHreaNruW8leeUqO+8m+eyvuehruaooeWei+WQjeWSjOW8leeUqOWFseWQjOehruWumuiwg+eUqOi6q+S7veOAgiAqL1xuICAgIGNyZWRlbnRpYWxJZDogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm9wdGlvbmFsKCksXG59KTtcbmV4cG9ydCBjb25zdCBub2RlTW9kZVNjaGVtYSA9IHoucHJlcHJvY2Vzcyhub3JtYWxpemVOb2RlTW9kZSwgei5lbnVtKG5vZGVNb2RlcykpO1xuZXhwb3J0IGNvbnN0IHBvcnRSb2xlU2NoZW1hID0gei5lbnVtKHBvcnRSb2xlcyk7XG5leHBvcnQgY29uc3QgYXNzZXRTdGF0dXNTY2hlbWEgPSB6LmVudW0oYXNzZXRTdGF0dXNlcyk7XG5leHBvcnQgY29uc3QgcnVuU3RhdHVzZXMgPSBbXG4gICAgJ2RyYWZ0JyxcbiAgICAncXVldWVkJyxcbiAgICAncHJlcGFyaW5nJyxcbiAgICAncnVubmluZycsXG4gICAgJ3Byb2Nlc3NpbmcnLFxuICAgICdzdWNjZWVkZWQnLFxuICAgICdmYWlsZWQnLFxuICAgICdjYW5jZWxfcmVxdWVzdGVkJyxcbiAgICAnY2FuY2VsbGVkJyxcbl07XG5leHBvcnQgY29uc3QgcnVuU3RhdHVzU2NoZW1hID0gei5lbnVtKHJ1blN0YXR1c2VzKTtcbmV4cG9ydCBjb25zdCBwcm92aWRlckpvYlN0YXR1c2VzID0gW1xuICAgICdxdWV1ZWQnLFxuICAgICdzdWJtaXR0ZWQnLFxuICAgICdydW5uaW5nJyxcbiAgICAnc3VjY2VlZGVkJyxcbiAgICAnZmFpbGVkJyxcbiAgICAnY2FuY2VsbGVkJyxcbl07XG5leHBvcnQgY29uc3QgcHJvdmlkZXJKb2JTdGF0dXNTY2hlbWEgPSB6LmVudW0ocHJvdmlkZXJKb2JTdGF0dXNlcyk7XG4vKiogTGlmZWN5Y2xlIHN0YXRlIGZvciBvbmUgZnJvemVuIGNhbnZhcyBub2RlIGluc2lkZSBhIHF1ZXVlZCBEQUcgcnVuLiAqL1xuZXhwb3J0IGNvbnN0IHdvcmtmbG93Tm9kZVN0YXR1c2VzID0gW1xuICAgICdwZW5kaW5nJyxcbiAgICAncnVubmluZycsXG4gICAgJ3N1Y2NlZWRlZCcsXG4gICAgJ2ZhaWxlZCcsXG4gICAgJ2NhbmNlbGxlZCcsXG5dO1xuZXhwb3J0IGNvbnN0IHdvcmtmbG93Tm9kZVN0YXR1c1NjaGVtYSA9IHouZW51bSh3b3JrZmxvd05vZGVTdGF0dXNlcyk7XG5leHBvcnQgY29uc3QgcHJvdmlkZXJKb2JTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHByb3ZpZGVyOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBwbGF0Zm9ybUpvYklkOiB6LnN0cmluZygpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIHN0YXR1czogcHJvdmlkZXJKb2JTdGF0dXNTY2hlbWEsXG4gICAgcHJvZ3Jlc3M6IHoubnVtYmVyKCkuaW50KCkubWluKDApLm1heCgxMDApLFxuICAgIHBheWxvYWQ6IHoucmVjb3JkKHoudW5rbm93bigpKS5vcHRpb25hbCgpLFxuICAgIGNyZWF0ZWRBdDogei5zdHJpbmcoKS5kYXRldGltZSgpLFxuICAgIHVwZGF0ZWRBdDogei5zdHJpbmcoKS5kYXRldGltZSgpLFxufSk7XG5leHBvcnQgY29uc3QgcnVuUmVzdWx0QXNzZXRTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgYXNzZXRJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgdmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgY29udGVudFVybDogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBtaW1lVHlwZTogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBzaXplQnl0ZXM6IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKS5vcHRpb25hbCgpLFxuICAgIHNoYTI1NjogelxuICAgICAgICAuc3RyaW5nKClcbiAgICAgICAgLnJlZ2V4KC9eW2EtZjAtOV17NjR9JC9pKVxuICAgICAgICAub3B0aW9uYWwoKSxcbn0pO1xuZXhwb3J0IGNvbnN0IGFzc2V0U2NoZW1hID0gei5vYmplY3Qoe1xuICAgIGlkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBuYW1lOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBtZWRpYVR5cGU6IG1lZGlhVHlwZVNjaGVtYSxcbiAgICBtaW1lVHlwZTogei5zdHJpbmcoKS5taW4oMSksXG4gICAgc2l6ZUJ5dGVzOiB6Lm51bWJlcigpLmludCgpLm5vbm5lZ2F0aXZlKCksXG4gICAgLyoqIOi1hOa6kOe0ouW8lei/lOWbnueahOW9k+WJjeacgOmrmOeJiOacrO+8m+aXp+i1hOa6kOWPr+iDveaaguaXtuayoeacieivpeWtl+auteOAgiAqL1xuICAgIGxhdGVzdFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5vcHRpb25hbCgpLFxuICAgIHNoYTI1NjogelxuICAgICAgICAuc3RyaW5nKClcbiAgICAgICAgLnJlZ2V4KC9eW2EtZjAtOV17NjR9JC8pXG4gICAgICAgIC5vcHRpb25hbCgpLFxuICAgIHN0YXR1czogYXNzZXRTdGF0dXNTY2hlbWEsXG4gICAgY29udGVudFVybDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgdGFnczogei5hcnJheSh6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDY0KSkuZGVmYXVsdChbXSksXG4gICAgbWV0YWRhdGE6IHoucmVjb3JkKHoudW5rbm93bigpKS5vcHRpb25hbCgpLFxuICAgIGFyY2hpdmVkQXQ6IHouc3RyaW5nKCkuZGF0ZXRpbWUoKS5vcHRpb25hbCgpLFxufSk7XG4vKipcbiAqIOaPkOekuuivjeS4reaPkOWPiui1hOa6kOeahOmAmueUqOe7keWumuS/oeaBr+OAglxuICog5pyq6K+G5Yir55qE5pmu6YCa5a2X5q615Lya6KKr5L+d55WZ77yM5L6/5LqO5ZCO57ut6K+t5LmJ6KeS6Imy5omp5bGV77yb5Yet5o2u44CB5Li05pe2IFVSTCDlkoxcbiAqIOacrOWcsOi3r+W+hOetieaVj+aEn+Wtl+auteWcqOmihuWfn+ino+aekOi+ueeVjOebtOaOpeS4ouW8g++8jOmBv+WFjei/m+WFpeaMgeS5heWMluaWh+aho+OAglxuICovXG5jb25zdCBtZW50aW9uQmluZGluZ09iamVjdFNjaGVtYSA9IHpcbiAgICAub2JqZWN0KHtcbiAgICBlbnRpdHlOYW1lOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCkub3B0aW9uYWwoKSxcbiAgICBzZW1hbnRpY1JvbGU6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKS5vcHRpb25hbCgpLFxuICAgIHNjb3BlOiB6LmVudW0oWydsb2NhbCcsICdub2RlJywgJ3NjZW5lJ10pLm9wdGlvbmFsKCksXG59KVxuICAgIC5wYXNzdGhyb3VnaCgpO1xuZXhwb3J0IGNvbnN0IG1lbnRpb25CaW5kaW5nU2NoZW1hID0gei5wcmVwcm9jZXNzKCh2YWx1ZSkgPT4gc2FuaXRpemVNZW50aW9uQmluZGluZ1ZhbHVlKHZhbHVlKSwgbWVudGlvbkJpbmRpbmdPYmplY3RTY2hlbWEpO1xuLyoqIOWcqOe7keWumueahOWJjeWQkeWFvOWuueWtl+auteS4reenu+mZpOWHreaNruOAgVVSTCDlkozmnKzlnLDot6/lvoTjgIIgKi9cbmZ1bmN0aW9uIHNhbml0aXplTWVudGlvbkJpbmRpbmdWYWx1ZSh2YWx1ZSwga2V5KSB7XG4gICAgaWYgKGtleSAmJiBpc1NlbnNpdGl2ZU1lbnRpb25LZXkoa2V5KSlcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZClcbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKVxuICAgICAgICByZXR1cm4gbG9va3NMaWtlTG9jYWxQYXRoKHZhbHVlKSA/IHVuZGVmaW5lZCA6IHZhbHVlO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKVxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgICAgICAgLm1hcCgoaXRlbSkgPT4gc2FuaXRpemVNZW50aW9uQmluZGluZ1ZhbHVlKGl0ZW0pKVxuICAgICAgICAgICAgLmZpbHRlcigoaXRlbSkgPT4gaXRlbSAhPT0gdW5kZWZpbmVkKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3Qgb3V0cHV0ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgW2NoaWxkS2V5LCBjaGlsZFZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGNvbnN0IHNhbml0aXplZCA9IHNhbml0aXplTWVudGlvbkJpbmRpbmdWYWx1ZShjaGlsZFZhbHVlLCBjaGlsZEtleSk7XG4gICAgICAgICAgICBpZiAoc2FuaXRpemVkICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICAgICAgb3V0cHV0W2NoaWxkS2V5XSA9IHNhbml0aXplZDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb3V0cHV0O1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuZnVuY3Rpb24gaXNTZW5zaXRpdmVNZW50aW9uS2V5KGtleSkge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBrZXlcbiAgICAgICAgLnJlcGxhY2UoLyhbYS16MC05XSkoW0EtWl0pL2csICckMV8kMicpXG4gICAgICAgIC5yZXBsYWNlKC9bLVxcc10rL2csICdfJylcbiAgICAgICAgLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuICgvKD86XnxfKSg/OmFwaV9rZXl8YWNjZXNzX3Rva2VufHJlZnJlc2hfdG9rZW58YXV0aG9yaXphdGlvbnxwYXNzd29yZHxzZWNyZXQoPzpfa2V5KT98Y3JlZGVudGlhbCg/OnN8X2lkfF92ZXJzaW9uKT98c2lnbmVkX3VybHxwcmVzaWduZWRfdXJsKSg/Ol98JCkvLnRlc3Qobm9ybWFsaXplZCkgfHxcbiAgICAgICAgLyg/OnVybHx1cmkpJC8udGVzdChub3JtYWxpemVkKSB8fFxuICAgICAgICAvKD86XnxfKSg/OmxvY2FsXz9wYXRofGZpbGVfP3BhdGh8cGF0aCkoPzpffCQpLy50ZXN0KG5vcm1hbGl6ZWQpKTtcbn1cbmZ1bmN0aW9uIGxvb2tzTGlrZUxvY2FsUGF0aCh2YWx1ZSkge1xuICAgIHJldHVybiAvXig/OlthLXpBLVpdOltcXFxcL118XFxcXFxcXFx8ZmlsZTopLy50ZXN0KHZhbHVlLnRyaW0oKSk7XG59XG4vKiog6LWE5rqQ5o+Q5Y+K5Z2X44CCYXNzZXRWZXJzaW9uIOeUqOS6jueUqOaIt+aYjuehrumAieaLqeafkOS4quWOhuWPsueJiOacrOeahOWcuuaZr+OAgiAqL1xuZXhwb3J0IGNvbnN0IHByb21wdE1lbnRpb25TY2hlbWEgPSB6XG4gICAgLm9iamVjdCh7XG4gICAgdHlwZTogei5saXRlcmFsKCdtZW50aW9uJyksXG4gICAgbWVudGlvbklkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCksXG4gICAgYXNzZXRJZDogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm1heCg1MTIpLFxuICAgIGxhYmVsOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDUxMiksXG4gICAgbWVkaWFUeXBlOiBtZWRpYVR5cGVTY2hlbWEsXG4gICAgYXNzZXRWZXJzaW9uOiB6Lm51bWJlcigpLmludCgpLnBvc2l0aXZlKCkub3B0aW9uYWwoKSxcbiAgICAvKiog54us56uL5YaF6IGU5byV55So5qCH6K6w77yM5LiN5Y2g55So5pmu6YCa5q2j5paH77yb57y655yB5Li65pen54mI5ZCN56ew57uR5a6a44CCICovXG4gICAgaW5saW5lOiB6LmxpdGVyYWwodHJ1ZSkub3B0aW9uYWwoKSxcbiAgICAvKiog5a+85YWl5pe26LWE5rqQ5LiN5Y+v6K6/6Zeu5Lya5L+d55WZ6Lqr5Lu95bm25qCH6K6w5Li65LiN5Y+v5omn6KGM5Y2g5L2N44CCICovXG4gICAgcGxhY2Vob2xkZXI6IHouYm9vbGVhbigpLm9wdGlvbmFsKCksXG4gICAgcGxhY2Vob2xkZXJSZWFzb246IHpcbiAgICAgICAgLmVudW0oW1xuICAgICAgICAnbm90X2ZvdW5kJyxcbiAgICAgICAgJ2ZvcmJpZGRlbicsXG4gICAgICAgICdhcmNoaXZlZCcsXG4gICAgICAgICd2ZXJzaW9uX21pc3NpbmcnLFxuICAgICAgICAnbWltZV9taXNtYXRjaCcsXG4gICAgICAgICdzaXplX2V4Y2VlZGVkJyxcbiAgICBdKVxuICAgICAgICAub3B0aW9uYWwoKSxcbiAgICBzZW1hbnRpY1JvbGU6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKS5vcHRpb25hbCgpLFxuICAgIGVudGl0eU5hbWU6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKS5vcHRpb25hbCgpLFxuICAgIHNjb3BlOiB6LmVudW0oWydsb2NhbCcsICdub2RlJywgJ3NjZW5lJ10pLm9wdGlvbmFsKCksXG4gICAgYmluZGluZzogbWVudGlvbkJpbmRpbmdTY2hlbWEub3B0aW9uYWwoKSxcbn0pXG4gICAgLy8g5o+Q5Y+K5Z2X5Y+q5YWB6K645Y2P6K6u5a2X5q6177ybV29ya2VyIOeahOS4tOaXtuWGheWuueS8muWcqOino+aekOWZqOWujOaIkCBzY2hlbWFcbiAgICAvLyDmoKHpqozlkI7ku6XlhoXlrZjlrZfmrrXms6jlhaXvvIzpgb/lhY0gVVJM44CB5Yet5o2u5oiW5pys5Zyw6Lev5b6E6L+b5YWl5oyB5LmF5YyW5pWw5o2u44CCXG4gICAgLnN0cmlwKCk7XG4vKiog5pmu6YCa5paH5a2X5Z2X77yM5YWB6K645Li656m65Lul6KGo6L6+56m65o+Q56S66K+N5paH5qGj44CCICovXG5leHBvcnQgY29uc3QgcHJvbXB0VGV4dEJsb2NrU2NoZW1hID0gelxuICAgIC5vYmplY3Qoe1xuICAgIHR5cGU6IHoubGl0ZXJhbCgndGV4dCcpLFxuICAgIHRleHQ6IHouc3RyaW5nKCkubWF4KDIwXzAwMCksXG59KVxuICAgIC5zdHJpcCgpO1xuZXhwb3J0IGNvbnN0IHByb21wdEJsb2NrU2NoZW1hID0gei5kaXNjcmltaW5hdGVkVW5pb24oJ3R5cGUnLCBbXG4gICAgcHJvbXB0VGV4dEJsb2NrU2NoZW1hLFxuICAgIHByb21wdE1lbnRpb25TY2hlbWEsXG5dKTtcbi8qKlxuICog54mI5pys5YyW5o+Q56S66K+N5paH5qGj44CC5Z2X6aG65bqP5bCx5piv5paH5a2X5ZKM6LWE5rqQ5o+Q5Y+K55qE5riy5p+T6aG65bqP44CCXG4gKiDmlofmoaPlv4Xpobvoh7PlsJHljIXlkKvkuIDkuKrlnZfvvJvmj5Dlj4ogSUQg5Y+q6KaB5rGC5Zyo5b2T5YmN5paH5qGj5YaF5ZSv5LiA44CCXG4gKi9cbmV4cG9ydCBjb25zdCBwcm9tcHREb2N1bWVudFNjaGVtYSA9IHpcbiAgICAub2JqZWN0KHtcbiAgICB2ZXJzaW9uOiB6LmxpdGVyYWwoMSksXG4gICAgYmxvY2tzOiB6LmFycmF5KHByb21wdEJsb2NrU2NoZW1hKS5taW4oMSkubWF4KDJfMDAwKSxcbn0pXG4gICAgLnN0cmlwKClcbiAgICAuc3VwZXJSZWZpbmUoKGRvY3VtZW50LCBjb250ZXh0KSA9PiB7XG4gICAgY29uc3QgbWVudGlvbklkcyA9IG5ldyBTZXQoKTtcbiAgICBsZXQgdGV4dExlbmd0aCA9IDA7XG4gICAgZG9jdW1lbnQuYmxvY2tzLmZvckVhY2goKGJsb2NrLCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAoYmxvY2sudHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICB0ZXh0TGVuZ3RoICs9IGJsb2NrLnRleHQubGVuZ3RoO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZW50aW9uSWRzLmhhcyhibG9jay5tZW50aW9uSWQpKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYGR1cGxpY2F0ZSBwcm9tcHQgbWVudGlvbiBpZDogJHtibG9jay5tZW50aW9uSWR9YCxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ2Jsb2NrcycsIGluZGV4LCAnbWVudGlvbklkJ10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBtZW50aW9uSWRzLmFkZChibG9jay5tZW50aW9uSWQpO1xuICAgICAgICBpZiAoYmxvY2sucGxhY2Vob2xkZXJSZWFzb24gJiYgYmxvY2sucGxhY2Vob2xkZXIgIT09IHRydWUpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAncGxhY2Vob2xkZXJSZWFzb24gcmVxdWlyZXMgcGxhY2Vob2xkZXI6IHRydWUnLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsnYmxvY2tzJywgaW5kZXgsICdwbGFjZWhvbGRlciddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAodGV4dExlbmd0aCA+IDIwXzAwMCkge1xuICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdwcm9tcHQgZG9jdW1lbnQgdGV4dCBleGNlZWRzIHRoZSAyMDAwMC1jaGFyYWN0ZXIgbGltaXQnLFxuICAgICAgICAgICAgcGF0aDogWydibG9ja3MnXSxcbiAgICAgICAgfSk7XG4gICAgfVxufSk7XG4vKipcbiAqIOWwhue7k+aehOWMluaPkOekuuivjea4suafk+S4uuWFvOWuueaXpyBQcm92aWRlciDnmoTnuq/mlofmnKzjgIJcbiAqIOi1hOa6kOi6q+S7veS4jeS8muS+nei1luaYvuekuuWQje+8m+a4suafk+S7heeUqOS6juaXp+aOpeWPo+aIlumihOiniOi+k+WHuuOAglxuICovXG4vKipcbiAqIOi1hOa6kOWcqOaPkOekuuivjeS4reeahOaYvuekuuWQjeOAguS8mOWFiOeUqOeUqOaIt+WRveWQje+8jOWQpuWImeWOu+aOieaWh+S7tuWQjeWQjue8gOOAglxuICogQHBhcmFtIG1lbnRpb24g5o+Q56S66K+N6LWE5rqQ5o+Q5Y+K44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZW50aW9uRGlzcGxheU5hbWUobWVudGlvbikge1xuICAgIGNvbnN0IG5hbWVkID0gbWVudGlvbi5lbnRpdHlOYW1lPy50cmltKCkgfHwgbWVudGlvbi5iaW5kaW5nPy5lbnRpdHlOYW1lPy50cmltKCk7XG4gICAgaWYgKG5hbWVkKVxuICAgICAgICByZXR1cm4gbmFtZWQ7XG4gICAgcmV0dXJuIGRlZmF1bHRSZXNvdXJjZURpc3BsYXlOYW1lKG1lbnRpb24ubGFiZWwpO1xufVxuLyoqXG4gKiDku47mlofku7blkI3lvpfliLDpu5jorqTlj6/or7vlkI3jgIJcbiAqIOaZrumAmuaWh+S7tuS8muWOu+aOieW4uOingeWQjue8gO+8m+WOu+aOieWQjuWmguaenOWPquWJqei/h+efreaIlue6r+aVsOWtly/nrKblj7fvvIzliJnkv53nlZnljp/mlofku7blkI3jgIJcbiAqIOi/meagtyBgMi5tcDRgIOS4jeS8muWPmOaIkCBgMmDvvIzpgb/lhY3lnKjmj5DnpLror43ph4zovpPlhaXmlbDlrZflsLHooqvlvZPmiJDotYTmupDlvJXnlKjjgIJcbiAqIEBwYXJhbSBmaWxlTmFtZSDotYTmupDmlofku7blkI3miJbmoIfnrb7jgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRSZXNvdXJjZURpc3BsYXlOYW1lKGZpbGVOYW1lKSB7XG4gICAgY29uc3QgYmFzZSA9IGZpbGVOYW1lLnRyaW0oKTtcbiAgICBpZiAoIWJhc2UpXG4gICAgICAgIHJldHVybiAn6LWE5rqQJztcbiAgICBjb25zdCBzdHJpcHBlZCA9IGJhc2UucmVwbGFjZSgvXFwuW0EtWmEtejAtOV17MSw4fSQvdSwgJycpO1xuICAgIGNvbnN0IHN0ZW0gPSAoc3RyaXBwZWQgfHwgYmFzZSkudHJpbSgpO1xuICAgIGlmICghc3RlbSB8fCBzdGVtLmxlbmd0aCA8IDIgfHwgL15bXFxkLl8tXSskL3UudGVzdChzdGVtKSkge1xuICAgICAgICByZXR1cm4gYmFzZS5zbGljZSgwLCAxNjApO1xuICAgIH1cbiAgICByZXR1cm4gc3RlbS5zbGljZSgwLCAxNjApO1xufVxuLyoqXG4gKiDlnKjlt7LljaDnlKjlkI3lrZfkuK3nlJ/miJDkuI3ph43lpI3nmoTmmL7npLrlkI3jgIJcbiAqIEBwYXJhbSBmaWxlTmFtZSDljp/lp4vmlofku7blkI3jgIJcbiAqIEBwYXJhbSB0YWtlbiDmnKzoioLngrnlt7LljaDnlKjnmoTlkI3lrZfjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuaXF1ZVJlc291cmNlRGlzcGxheU5hbWUoZmlsZU5hbWUsIHRha2VuKSB7XG4gICAgY29uc3QgbmFtZXMgPSBuZXcgU2V0KHRha2VuKTtcbiAgICBjb25zdCByb290ID0gZGVmYXVsdFJlc291cmNlRGlzcGxheU5hbWUoZmlsZU5hbWUpO1xuICAgIGlmICghbmFtZXMuaGFzKHJvb3QpKVxuICAgICAgICByZXR1cm4gcm9vdDtcbiAgICBsZXQgaW5kZXggPSAyO1xuICAgIHdoaWxlIChuYW1lcy5oYXMoYCR7cm9vdH0ke2luZGV4fWApKVxuICAgICAgICBpbmRleCArPSAxO1xuICAgIHJldHVybiBgJHtyb290fSR7aW5kZXh9YDtcbn1cbi8qKlxuICog5bCG57uT5p6E5YyW5o+Q56S66K+N5riy5p+T5Li65YW85a655penIFByb3ZpZGVyIOeahOe6r+aWh+acrOOAglxuICog6LWE5rqQ6Lqr5Lu95LiN5L6d6LWW5pi+56S65ZCN77yb5riy5p+T5L2/55So57uR5a6a5ZCO55qE5ZCN5a2X77yM5LiN5YaN5YqgIEAg5YmN57yA44CCXG4gKiBAcGFyYW0gZG9jdW1lbnQg57uT5p6E5YyW5o+Q56S66K+N5paH5qGj44CCXG4gKiBAcmV0dXJucyDmjInlnZfpobrluo/mi7zmjqXnmoTnuq/mlofmnKzjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclByb21wdERvY3VtZW50KGRvY3VtZW50KSB7XG4gICAgY29uc3QgcGFyc2VkID0gcHJvbXB0RG9jdW1lbnRTY2hlbWEucGFyc2UoZG9jdW1lbnQpO1xuICAgIHJldHVybiBwYXJzZWQuYmxvY2tzXG4gICAgICAgIC5tYXAoKGJsb2NrKSA9PiBibG9jay50eXBlID09PSAndGV4dCcgPyBibG9jay50ZXh0IDogYmxvY2suaW5saW5lID8gJycgOiBtZW50aW9uRGlzcGxheU5hbWUoYmxvY2spKVxuICAgICAgICAuam9pbignJyk7XG59XG5leHBvcnQgZnVuY3Rpb24gZ2V0RWZmZWN0aXZlUHJvbXB0RG9jdW1lbnQoaW5wdXQpIHtcbiAgICBpZiAoaW5wdXQucHJvbXB0RG9jdW1lbnQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgcmV0dXJuIHByb21wdERvY3VtZW50U2NoZW1hLnBhcnNlKGlucHV0LnByb21wdERvY3VtZW50KTtcbiAgICByZXR1cm4ge1xuICAgICAgICB2ZXJzaW9uOiAxLFxuICAgICAgICBibG9ja3M6IFt7IHR5cGU6ICd0ZXh0JywgdGV4dDogaW5wdXQucHJvbXB0ID8/ICcnIH1dLFxuICAgIH07XG59XG4vKiog5bey5YaZ5YWl6L+Q6KGM5b+r54Wn55qE5Zu+54mH57yW6L6R6ZmQ5Yi277yb5pen5b+r54Wn57y655yB5Zu+54mH5LiK6ZmQ5pe25oyJ5a6e6ZmF5qih5Z6L6Kej5p6Q44CCICovXG5leHBvcnQgY29uc3QgZnJvemVuSW1hZ2VFZGl0Q2FwYWJpbGl0eVNjaGVtYSA9IHpcbiAgICAub2JqZWN0KHtcbiAgICBkZWNsYXJlZDogei5saXRlcmFsKHRydWUpLFxuICAgIG1pbWVUeXBlczogei5hcnJheSh6LnN0cmluZygpLnRyaW0oKS5taW4oMSkpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIHNpemVzOiB6LmFycmF5KHouc3RyaW5nKCkudHJpbSgpLm1pbigxKSkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgcGFyYW1ldGVyczogei5hcnJheSh6LnN0cmluZygpLnRyaW0oKS5taW4oMSkpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIC8qKiDljZXmrKHnvJbovpHlhYHorrjnmoTlm77niYflvKDmlbDvvJvml6flv6vnhafnvLrnnIHml7bmjInmqKHlnovpu5jorqTlgLzop6PmnpDjgIIgKi9cbiAgICBtYXhJbWFnZXM6IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5vcHRpb25hbCgpLFxufSlcbiAgICAuc3RyaXAoKTtcbi8qKiDlt7LlhpnlhaXov5DooYzlv6vnhafnmoTjgIHluKbkuI3lj6/lj5jotYTkuqfniYjmnKznmoTotYTmupDmj5Dlj4rjgIIgKi9cbmV4cG9ydCBjb25zdCBmcm96ZW5Qcm9tcHRNZW50aW9uU2NoZW1hID0gelxuICAgIC5vYmplY3Qoe1xuICAgIC8qKiDoioLngrkgSUQg5Zyo5pen5b+r54Wn5Lit5Y+v55yB55Wl77yb5paw5b+r54Wn5aeL57uI5YaZ5YWl44CCICovXG4gICAgbm9kZUlkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBtZW50aW9uSWQ6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKSxcbiAgICBhc3NldElkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDUxMiksXG4gICAgYXNzZXRWZXJzaW9uOiB6Lm51bWJlcigpLmludCgpLnBvc2l0aXZlKCksXG4gICAgbWVkaWFUeXBlOiBtZWRpYVR5cGVTY2hlbWEsXG4gICAgLyoqIOinhumikeaIlumfs+mikei1hOS6p+mAieS4reeJiOacrOeahOaOoua1i+aXtumVv++8m+e8uuecgeihqOekuuivpeeJiOacrOayoeacieWPr+S/oeaXtumVv+OAgiAqL1xuICAgIGR1cmF0aW9uU2Vjb25kczogei5udW1iZXIoKS5maW5pdGUoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgbGFiZWw6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoNTEyKSxcbiAgICBibG9ja09yZGVyOiB6Lm51bWJlcigpLmludCgpLm5vbm5lZ2F0aXZlKCksXG4gICAgc2VtYW50aWNSb2xlOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCkub3B0aW9uYWwoKSxcbiAgICBlbnRpdHlOYW1lOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCkub3B0aW9uYWwoKSxcbiAgICBzY29wZTogei5lbnVtKFsnbG9jYWwnLCAnbm9kZScsICdzY2VuZSddKS5vcHRpb25hbCgpLFxuICAgIGJpbmRpbmc6IG1lbnRpb25CaW5kaW5nU2NoZW1hLm9wdGlvbmFsKCksXG59KVxuICAgIC5zdHJpcCgpO1xuLyoqIOinhumikeaIkOWKn+W9kuaho+WQjueahOacq+W4p+WujOaIkOWKqOS9nOOAgiAqL1xuZXhwb3J0IGNvbnN0IHZpZGVvQ29tcGxldGlvbkFjdGlvbnMgPSBbXG4gICAgJ25vbmUnLFxuICAgICdwcmV2aWV3X2ZpbmFsX2ZyYW1lJyxcbiAgICAnY3JlYXRlX2Fzc2V0JyxcbiAgICAnYXBwZW5kX2ltYWdlX25vZGUnLFxuICAgICdmaWxsX2Rlc2lnbmF0ZWRfaW1hZ2Vfbm9kZScsXG5dO1xuZXhwb3J0IGNvbnN0IHZpZGVvQ29tcGxldGlvbkFjdGlvblNjaGVtYSA9IHouZW51bSh2aWRlb0NvbXBsZXRpb25BY3Rpb25zKTtcbi8qKiDmnKvluKfmj5Dlj5bnrZbnlaXniYjmnKzvvJvlj5jmm7Tmj5Dlj5bnrpfms5Xml7bpgJLlop7vvIzku6XlvaLmiJDmlrDnmoTluYLnrYnouqvku73jgIIgKi9cbmV4cG9ydCBjb25zdCBWSURFT19GSU5BTF9GUkFNRV9QT0xJQ1lfVkVSU0lPTiA9IDE7XG4vKiog6IqC54K55LiK5ZG95ZCN5ZCO55qE5Y+C6ICD6LWE5rqQ44CCaWQg56iz5a6a77yMbmFtZSDku4XkvZzmmL7npLrkuI7ovpPlhaXliKvlkI3jgIIgKi9cbmV4cG9ydCBjb25zdCBub2RlUmVzb3VyY2VSZWZTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaWQ6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKSxcbiAgICBhc3NldElkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDUxMiksXG4gICAgbWVkaWFUeXBlOiBtZWRpYVR5cGVTY2hlbWEsXG4gICAgbmFtZTogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm1heCgxNjApLFxuICAgIGFzc2V0VmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgLyoqIOeLrOeri+a3u+WKoOeahOi1hOaWme+8m+WNs+S9v+ato+aWh+ayoeacieW8leeUqOagh+iusO+8jOS5n+S9nOS4uuiKgueCueeahOeUn+aIkOi+k+WFpeOAgiAqL1xuICAgIGF0dGFjaGVkOiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxufSk7XG4vKipcbiAqIOaKiueLrOeri+i1hOaWmeaKleW9seS4uuaJp+ihjOeUqOaPkOWPiu+8jOS/neeVmeS/neWtmOeahOato+aWh+WSjOW3suacieaPkOWPiui6q+S7veOAglxuICogQHBhcmFtIGlucHV0IOiKgueCueaWh+Wtl+OAgee7k+aehOWMluaWh+aho+WPiueLrOeri+i1hOaWmeWIl+ihqO+8m+aXp+WIq+WQjeS4jeiHquWKqOWPmOaIkOi+k+WFpeOAglxuICogQHJldHVybnMg5L6b5p2D6ZmQ5qCh6aqM44CB54mI5pys5Ya757uT5ZKM5omn6KGM5b+r54Wn5YWx55So55qE5paH5qGj77yb5LiN5L+u5pS5IGlucHV044CCXG4gKiBAdGhyb3dzIOaWh+aho+aIluWQiOW5tuWQjueahOaPkOWPiuaVsOmHj+i2heWHuuWNj+iurumZkOWItuaXtuaLkue7neOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RXhlY3V0aW9uUHJvbXB0RG9jdW1lbnQoaW5wdXQpIHtcbiAgICBjb25zdCBhdHRhY2hlZCA9IGlucHV0LnJlc291cmNlUmVmcz8uZmlsdGVyKChyZWZlcmVuY2UpID0+IHJlZmVyZW5jZS5hdHRhY2hlZCkgPz8gW107XG4gICAgaWYgKGF0dGFjaGVkLmxlbmd0aCA9PT0gMClcbiAgICAgICAgcmV0dXJuIGlucHV0LnByb21wdERvY3VtZW50O1xuICAgIGNvbnN0IGRvY3VtZW50ID0gZ2V0RWZmZWN0aXZlUHJvbXB0RG9jdW1lbnQoaW5wdXQpO1xuICAgIGNvbnN0IGlkcyA9IG5ldyBTZXQoZG9jdW1lbnQuYmxvY2tzLmZsYXRNYXAoKGJsb2NrKSA9PiAoYmxvY2sudHlwZSA9PT0gJ21lbnRpb24nID8gW2Jsb2NrLm1lbnRpb25JZF0gOiBbXSkpKTtcbiAgICBjb25zdCBpZGVudGl0aWVzID0gbmV3IFNldChkb2N1bWVudC5ibG9ja3MuZmxhdE1hcCgoYmxvY2spID0+IGJsb2NrLnR5cGUgPT09ICdtZW50aW9uJyA/IFtwcm9tcHRSZXNvdXJjZUlkZW50aXR5KGJsb2NrLmFzc2V0SWQsIGJsb2NrLmFzc2V0VmVyc2lvbildIDogW10pKTtcbiAgICBjb25zdCBibG9ja3MgPSBbLi4uZG9jdW1lbnQuYmxvY2tzXTtcbiAgICBmb3IgKGNvbnN0IFtpbmRleCwgcmVmZXJlbmNlXSBvZiBhdHRhY2hlZC5lbnRyaWVzKCkpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gcHJvbXB0UmVzb3VyY2VJZGVudGl0eShyZWZlcmVuY2UuYXNzZXRJZCwgcmVmZXJlbmNlLmFzc2V0VmVyc2lvbik7XG4gICAgICAgIGlmIChpZGVudGl0aWVzLmhhcyhrZXkpKVxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIGlkZW50aXRpZXMuYWRkKGtleSk7XG4gICAgICAgIGxldCBtZW50aW9uSWQgPSBgYXR0YWNoZWRfJHtpbmRleH1gO1xuICAgICAgICB3aGlsZSAoaWRzLmhhcyhtZW50aW9uSWQpKVxuICAgICAgICAgICAgbWVudGlvbklkICs9ICdfJztcbiAgICAgICAgaWRzLmFkZChtZW50aW9uSWQpO1xuICAgICAgICBibG9ja3MucHVzaCh7XG4gICAgICAgICAgICB0eXBlOiAnbWVudGlvbicsXG4gICAgICAgICAgICBtZW50aW9uSWQsXG4gICAgICAgICAgICBpbmxpbmU6IHRydWUsXG4gICAgICAgICAgICBhc3NldElkOiByZWZlcmVuY2UuYXNzZXRJZCxcbiAgICAgICAgICAgIGFzc2V0VmVyc2lvbjogcmVmZXJlbmNlLmFzc2V0VmVyc2lvbixcbiAgICAgICAgICAgIG1lZGlhVHlwZTogcmVmZXJlbmNlLm1lZGlhVHlwZSxcbiAgICAgICAgICAgIGxhYmVsOiByZWZlcmVuY2UubmFtZSxcbiAgICAgICAgICAgIGVudGl0eU5hbWU6IHJlZmVyZW5jZS5uYW1lLFxuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHByb21wdERvY3VtZW50U2NoZW1hLnBhcnNlKHsgLi4uZG9jdW1lbnQsIGJsb2NrcyB9KTtcbn1cbi8qKiDnlJ/miJDmj5DnpLror43otYTmlpnnmoTnqLPlrprouqvku73plK7vvJvniYjmnKznvLrnnIHkuI7mmL7lvI/niYjmnKzkv53mjIHkuI3lkIzor63kuYnjgIIgKi9cbmZ1bmN0aW9uIHByb21wdFJlc291cmNlSWRlbnRpdHkoYXNzZXRJZCwgYXNzZXRWZXJzaW9uKSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFthc3NldElkLCBhc3NldFZlcnNpb25dKTtcbn1cbi8qKlxuICog5Zu+54mH57yW6L6R6IqC54K55LiK5Ya757uT55qE5p2l5rqQ5Zu+5byV55So44CCXG4gKlxuICogYHNvdXJjZU5vZGVJZGAg5LiOIGBhc3NldElkYCDnlLHigJzkv67mlLnlm77niYfigJ3lhaXlj6PmmL7lvI/lhpnlhaXvvIznvJbovpHoioLngrnmja7mraTnn6XpgZPoh6rlt7FcbiAqIOWcqOS/ruaUueWTquS4gOW8oOWbvuOAgmB2ZXJzaW9uYCDlj6rlnKjliJvlu7rml7blt7Lnn6XvvIjkvovlpoLmnaXmupDmmK/nlJ/miJDnu5PmnpzvvInmiY3lhpnlhaXvvJvku47kuIrkvKBcbiAqIOi1hOa6kOWPkei1t+aXtueVmeepuu+8jOeUsSBBUEkg5Zyo5o6S6Zif5YmN6Kej5p6Q5bm25Ya757uT5Yiw6L+Q6KGM5b+r54Wn55qE5LiN5Y+v5Y+Y54mI5pys6YeM77yM57ud5LiN5L2/55SoXG4gKiDmnKrniYjmnKzljJbnmoTmnIDmlrAgVVJM44CCXG4gKi9cbmV4cG9ydCBjb25zdCBpbWFnZUVkaXRTb3VyY2VTY2hlbWEgPSB6XG4gICAgLm9iamVjdCh7XG4gICAgc291cmNlTm9kZUlkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCksXG4gICAgYXNzZXRJZDogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm1heCg1MTIpLFxuICAgIHZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5vcHRpb25hbCgpLFxuICAgIC8qKiDmnaXmupDotYTkuqfmmK/kuIrkvKDotYTmupDov5jmmK/mn5DkuKrnlJ/miJDnu5PmnpzvvJvml6fnlLvluIPnvLrnnIHmjInkuIrkvKDotYTmupDlpITnkIbjgIIgKi9cbiAgICBzb3VyY2VLaW5kOiB6LmVudW0oWydhc3NldCcsICdyZXN1bHQnXSkub3B0aW9uYWwoKSxcbn0pXG4gICAgLnN0cmlwKCk7XG4vKiog6K+75Y+W6IqC54K55LiK55qE5Zu+54mH57yW6L6R5p2l5rqQ77yb5a2X5q6157y65aSx5oiW6Z2e5rOV5pe26L+U5ZueIHVuZGVmaW5lZOOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGltYWdlRWRpdFNvdXJjZU9mKGRhdGEpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBpbWFnZUVkaXRTb3VyY2VTY2hlbWEuc2FmZVBhcnNlKGRhdGE/LmltYWdlRWRpdFNvdXJjZSk7XG4gICAgcmV0dXJuIHBhcnNlZC5zdWNjZXNzID8gcGFyc2VkLmRhdGEgOiB1bmRlZmluZWQ7XG59XG4vKiog55Sf5oiQ6K+05piO6K6w5b2V55qEIHNjaGVtYSDniYjmnKzvvJvnu5PmnoTlj5jljJbml7blv4XpobvpgJLlop7vvIzkvpvml6forrDlvZXmmL7lvI/pmY3nuqfjgIIgKi9cbmV4cG9ydCBjb25zdCBSRVFVRVNUX1BST01QVF9TQ0hFTUFfVkVSU0lPTiA9IDE7XG4vKiog6K+35rGC5paH5pys5Z2X55qE5qC85byP54mI5pys77yM5Yy65YiG57qv5paH5pys5LiO5pyJ5bqP6KeS6Imy5raI5oGv44CCICovXG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdEZvcm1hdHMgPSBbJ3BsYWluJywgJ21lc3NhZ2VzJ107XG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdEZvcm1hdFNjaGVtYSA9IHouZW51bShyZXF1ZXN0UHJvbXB0Rm9ybWF0cyk7XG4vKipcbiAqIOacrOasoeivt+axguecn+ato+WPkemAgeWHuuWOu+eahOS4gOadoeaWh+acrOWGheWuueOAglxuICpcbiAqIGByb2xlYCDkuI4gYG5hbWVgIOWPquWPjeaYoOS+m+W6lOWVhua2iOaBr+Wlkee6pumHjOWunumZheWtmOWcqOeahOWtl+aute+8jOS4jeaYr+WJjeerr+S4uuS6huaYvuekuuiAjFxuICog6KGl55qE6KeS6Imy77yb57qv5paH5pys6K+35rGC5L2/55SoIGBwbGFpbmAg5qC85byP5bm255yB55WlIGByb2xlYOOAglxuICovXG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdFBhcnRTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgLyoqIOaWh+acrOWcqOacrOagvOW8j+S4reeahOWPkemAgemhuuW6j++8jOacgOWwj+S4uiAw77yM5ZCM5LiA6K6w5b2V5YaF5b+F6aG75ZSv5LiA44CCICovXG4gICAgb3JkZXI6IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKSxcbiAgICByb2xlOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDY0KS5vcHRpb25hbCgpLFxuICAgIC8qKiBDaGF0IENvbXBsZXRpb25zIOeahCBgbmFtZWAg5a2X5q6177yM55So5LqO5L+d55WZ55S75biD5LiK55qE6L6T5YWl6Lqr5Lu944CCICovXG4gICAgbmFtZTogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm1heCgxNjApLm9wdGlvbmFsKCksXG4gICAgdGV4dDogei5zdHJpbmcoKS5tYXgoMjAwXzAwMCksXG59KTtcbi8qKlxuICog5Y+C6ICD6LWE5rqQ55qE6Lqr5Lu95LiO55So6YCU44CC5Y+q5L+d5a2Y6LWE5Lqn6Lqr5Lu944CB54mI5pys44CB6KeS6Imy5ZKM6aG65bqP77ybXG4gKiDkuI3kv53lrZggYmFzZTY044CB5Li05pe2562+5ZCNIFVSTCDmiJbku7vkvZXlqpLkvZPkuozov5vliLbjgIJcbiAqL1xuZXhwb3J0IGNvbnN0IHJlcXVlc3RQcm9tcHRSZXNvdXJjZVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBhc3NldElkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDUxMikub3B0aW9uYWwoKSxcbiAgICBhc3NldFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5vcHRpb25hbCgpLFxuICAgIC8qKiDlhrvnu5Pml7borrDlvZXnmoTlronlhajmmL7npLrlkI3vvJvkuI3nlKjkuo7otYTmupDlr7vlnYDmiJbmjojmnYPjgIIgKi9cbiAgICBuYW1lOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDE2MCkub3B0aW9uYWwoKSxcbiAgICByb2xlOiBwb3J0Um9sZVNjaGVtYSxcbiAgICBzb3J0T3JkZXI6IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKSxcbiAgICBtZWRpYVR5cGU6IG1lZGlhVHlwZVNjaGVtYS5vcHRpb25hbCgpLFxufSk7XG4vKiog5Y+R6YCB6K+35rGC5YmN5ZCO55qE54q25oCB77yb5LiN56Gu5a6a54q25oCB5LiN5b6X6Kem5Y+R6Ieq5Yqo6YeN5Y+R44CCICovXG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdFNlbmRTdGF0dXNlcyA9IFsncGVuZGluZycsICdzZW50JywgJ2ZhaWxlZCcsICd1bmtub3duJ107XG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdFNlbmRTdGF0dXNTY2hlbWEgPSB6LmVudW0ocmVxdWVzdFByb21wdFNlbmRTdGF0dXNlcyk7XG4vKipcbiAqIOS4gOasoeW3suaPkOS6pOivt+axguacgOe7iOWPkemAgeeahOaPkOekuuivjeW/q+eFp+OAglxuICpcbiAqIOiusOW9lei6q+S7veaYryBgcnVuSWQgKyBub2RlSWQgKyBhdHRlbXB0ICsgcmVxdWVzdElkZW50aXR5YO+8muS4gOS4qiBEQUcg5YaF5q+P5Liq5a6e6ZmFXG4gKiDmiafooYznmoToioLngrnlkITnlZnlrZjkuIDku73vvIznu53kuI3miornm67moIfoioLngrnnmoTmj5DnpLror43pmYTnu5nkuIrmuLjnu5PmnpzjgILnu5Pmnpzouqvku71cbiAqIO+8iGBhc3NldElkICsgYXNzZXRWZXJzaW9uYO+8ieWcqOW9kuaho+WujOaIkOWQjueUsSBXb3JrZXIg6KGl5YaZ77yb57y65aSx6KGo56S66K+l6K+35rGC5rKh5pyJXG4gKiDkuqflh7rlj6/lsZXnpLrnmoTotYTkuqfniYjmnKzvvIzogIzkuI3mmK/lm57pgIDliLDoioLngrnkuIrlvZPliY3nvJbovpHmoYbnmoTlhoXlrrnjgIJcbiAqL1xuZXhwb3J0IGNvbnN0IHJlcXVlc3RQcm9tcHRSZWNvcmRTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgc2NoZW1hVmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLFxuICAgIHJ1bklkOiB6LnN0cmluZygpLm1pbigxKS5tYXgoNTEyKSxcbiAgICBub2RlSWQ6IHouc3RyaW5nKCkubWluKDEpLm1heCgxNjApLFxuICAgIGF0dGVtcHQ6IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICAvKiog5ZCM5LiAIGF0dGVtcHQg5YaF5Y+v6IO95Y+R55Sf5aSa5qyh6K+35rGC77yb6Lqr5Lu955SxIFByb3ZpZGVyIOivt+axgui3r+W+hOS4juW6j+WPt+e7hOaIkOOAgiAqL1xuICAgIHJlcXVlc3RJZGVudGl0eTogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm1heCgyMDApLFxuICAgIHByb3ZpZGVyOiB6LnN0cmluZygpLm1pbigxKS5tYXgoNjQpLFxuICAgIG1vZGVsQWxpYXM6IHouc3RyaW5nKCkubWluKDEpLm1heCg1MTIpLFxuICAgIGNyZWRlbnRpYWxJZDogei5zdHJpbmcoKS5taW4oMSkubWF4KDUxMikub3B0aW9uYWwoKSxcbiAgICBjcmVkZW50aWFsVmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgbWVkaWFUeXBlOiBtZWRpYVR5cGVTY2hlbWEsXG4gICAgZm9ybWF0OiByZXF1ZXN0UHJvbXB0Rm9ybWF0U2NoZW1hLFxuICAgIC8qKiDmjInlrp7pmYXlj5HpgIHpobrluo/mjpLliJfnmoTmlofmnKzlnZfvvJvnuq/lm77niYcgcHJvbXB0IOWPquacieS4gOmhueOAgiAqL1xuICAgIHBhcnRzOiB6LmFycmF5KHJlcXVlc3RQcm9tcHRQYXJ0U2NoZW1hKSxcbiAgICAvKiog55yf5q2j5Y+R6YCB5Ye65Y6755qE6LSf5ZCR5YaF5a6577yb5pyq5Y+R6YCB5pe255WZ56m677yM5LiN5Zue5aGr6IqC54K55LiK55qE57yW6L6R5YC844CCICovXG4gICAgbmVnYXRpdmVUZXh0OiB6LnN0cmluZygpLm1heCgyMF8wMDApLm9wdGlvbmFsKCksXG4gICAgcmVzb3VyY2VzOiB6LmFycmF5KHJlcXVlc3RQcm9tcHRSZXNvdXJjZVNjaGVtYSksXG4gICAgc2VuZFN0YXR1czogcmVxdWVzdFByb21wdFNlbmRTdGF0dXNTY2hlbWEsXG4gICAgY3JlYXRlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCksXG4gICAgLyoqIOW9kuaho+WujOaIkOWQjuWGmeWFpeeahOe7k+aenOi6q+S7veOAgiAqL1xuICAgIGFzc2V0SWQ6IHouc3RyaW5nKCkubWluKDEpLm1heCg1MTIpLm9wdGlvbmFsKCksXG4gICAgYXNzZXRWZXJzaW9uOiB6Lm51bWJlcigpLmludCgpLnBvc2l0aXZlKCkub3B0aW9uYWwoKSxcbiAgICAvKiog55Sf5oiQ5pa55byP5LiO54q25oCB77yb55So5oi35L+u5pS55pGY6KaB5LiN5Lya5pS55YaZ55yf5a6e6K+35rGC5paH5pys44CCICovXG4gICAgc3VtbWFyeTogei5zdHJpbmcoKS5tYXgoMl8wMDApLm9wdGlvbmFsKCksXG4gICAgc3VtbWFyeVNvdXJjZTogei5lbnVtKFsnbWFudWFsJywgJ2xvY2FsJywgJ21vZGVsJ10pLm9wdGlvbmFsKCksXG59KTtcbi8qKiDorrDlvZXouqvku73plK7vvIznlKjkuo7ljrvph43lkozmjInoioLngrnor7vlj5bvvIzkuI3ljIXlkKvku7vkvZXmj5DnpLror43lhoXlrrnjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiByZXF1ZXN0UHJvbXB0UmVjb3JkS2V5KHJlY29yZCkge1xuICAgIHJldHVybiBgJHtyZWNvcmQucnVuSWR9XFwwJHtyZWNvcmQubm9kZUlkfVxcMCR7cmVjb3JkLmF0dGVtcHR9XFwwJHtyZWNvcmQucmVxdWVzdElkZW50aXR5fWA7XG59XG4vKiog5aSa5p2h5raI5oGv57uT5p6c5aSN5Yi25pe25L2/55So55qE56iz5a6a6KeS6Imy5YiG6ZqU5YmN57yA44CCICovXG5leHBvcnQgZnVuY3Rpb24gcmVxdWVzdFByb21wdFBhcnRQcmVmaXgocGFydCkge1xuICAgIGlmICghcGFydC5yb2xlKVxuICAgICAgICByZXR1cm4gJyc7XG4gICAgcmV0dXJuIHBhcnQubmFtZSA/IGBbJHtwYXJ0LnJvbGV9OiR7cGFydC5uYW1lfV0gYCA6IGBbJHtwYXJ0LnJvbGV9XSBgO1xufVxuLyoqXG4gKiDmuLLmn5Plj6/lpI3liLbnmoTlrozmlbTmj5DnpLror43mlofmnKzjgILlpJrmtojmga/nu5Pmnpzkv53nlZnop5LoibLkuI7pobrluo/vvIznuq/mlofmnKzor7fmsYJcbiAqIOWPqui/lOWbnuWunumZheWPkemAgeeahOWtl+espuS4su+8jOS4jemineWkluaLvOaOpeagh+etvuOAglxuICpcbiAqIEBwYXJhbSByZWNvcmQg5bey5oyB5LmF5YyW55qE6K+35rGC5o+Q56S66K+N6K6w5b2V44CCXG4gKiBAcmV0dXJucyDlj6/nm7TmjqXlhpnlhaXliarotLTmnb/nmoTmlofmnKzjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclJlcXVlc3RQcm9tcHRUZXh0KHJlY29yZCkge1xuICAgIGNvbnN0IG9yZGVyZWQgPSBbLi4ucmVjb3JkLnBhcnRzXS5zb3J0KChsZWZ0LCByaWdodCkgPT4gbGVmdC5vcmRlciAtIHJpZ2h0Lm9yZGVyKTtcbiAgICBpZiAocmVjb3JkLmZvcm1hdCA9PT0gJ3BsYWluJylcbiAgICAgICAgcmV0dXJuIG9yZGVyZWQubWFwKChwYXJ0KSA9PiBwYXJ0LnRleHQpLmpvaW4oJ1xcbicpO1xuICAgIHJldHVybiBvcmRlcmVkLm1hcCgocGFydCkgPT4gYCR7cmVxdWVzdFByb21wdFBhcnRQcmVmaXgocGFydCl9JHtwYXJ0LnRleHR9YCkuam9pbignXFxuJyk7XG59XG4vKiog6K+35rGC5o+Q56S66K+N6K6w5b2V55qE5pWw5o2u5p2l5rqQ77yb5Y6G5Y+y6L+Q6KGM5rKh5pyJ55WZ5a2Y6K6w5b2V5pe25pi+5byP5Yy65YiG44CCICovXG5leHBvcnQgY29uc3QgcmVxdWVzdFByb21wdE9yaWdpbnMgPSBbJ3JlcXVlc3QnLCAnaW5wdXQtc25hcHNob3QnLCAnbm9uZSddO1xuLyoqIOS4gOasoeiKgueCueaJp+ihjOeahOeUn+WRveWRqOacn+aXtumXtOiusOW9le+8jOaJgOacieaXtumXtOaIs+S4uuacjeWKoeerryBVVEPjgIIgKi9cbmV4cG9ydCBjb25zdCBub2RlVGltaW5nU2NoZW1hID0gei5vYmplY3Qoe1xuICAgIG5vZGVJZDogei5zdHJpbmcoKS5taW4oMSkubWF4KDE2MCksXG4gICAgLyoqIOacrOiKgueCuei/m+WFpeW+heaJp+ihjOeKtuaAgeeahOaXtuWIu++8jOWMheWQq+S+nei1luetieW+heOAgiAqL1xuICAgIHF1ZXVlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCkub3B0aW9uYWwoKSxcbiAgICAvKiog5pys6IqC54K555yf5q2j5byA5aeL5omn6KGM55qE5pe25Yi777yb5YaZ5YWl5ZCO5LiN5Zug6L2u6K+i5oiWIFdvcmtlciDph43lkK/ph43nva7jgIIgKi9cbiAgICBzdGFydGVkQXQ6IHouc3RyaW5nKCkuZGF0ZXRpbWUoKS5vcHRpb25hbCgpLFxuICAgIC8qKiDnu4jmgIHml7bliLvvvIzlj6rlhpnlhaXkuIDmrKHvvJvlj5bmtojkuI7lpLHotKXlkIzmoLfmnInnu4jmgIHjgIIgKi9cbiAgICBmaW5pc2hlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCkub3B0aW9uYWwoKSxcbiAgICAvKiog57uI5oCB5oCn6LSo77yM5Yaz5a6a55WM6Z2i5aaC5L2V5o+P6L+w5pys5qyh6ICX5pe244CCICovXG4gICAgb3V0Y29tZTogei5lbnVtKFsnc3VjY2VlZGVkJywgJ2ZhaWxlZCcsICdjYW5jZWxsZWQnXSkub3B0aW9uYWwoKSxcbiAgICAvKiog5Y+R6LW35L6b5bqU5ZWG6K+35rGC55qE5pe25Yi777yM55So5LqO5ouG5Ye66K+35rGC6Zi25q616ICX5pe244CCICovXG4gICAgcmVxdWVzdFN0YXJ0ZWRBdDogei5zdHJpbmcoKS5kYXRldGltZSgpLm9wdGlvbmFsKCksXG4gICAgLyoqIOWPluW+l+WPr+eUqOe7k+aenOeahOaXtuWIu+OAgiAqL1xuICAgIHJlcXVlc3RGaW5pc2hlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCkub3B0aW9uYWwoKSxcbn0pO1xuLyoqXG4gKiDorqHnrpfkuIDkuKroioLngrnmnKzmrKHmiafooYznmoTogJfml7bjgIJcbiAqXG4gKiDlj6PlvoTkuLogYGZpbmlzaGVkQXQgLSBzdGFydGVkQXRg77yM5YyF5ZCr5pys6IqC54K55YeG5aSH6L6T5YWl44CB5L6b5bqU5ZWG5aSE55CG44CB6L2u6K+i5Y+K57uT5p6cXG4gKiDlvZLmoaPvvJvmnKrmiafooYzlrozmiJDml7bmjInmnI3liqHnq6/lt7LorrDlvZXnmoTlvIDlp4vml7bpl7Tov5Tlm57ov5DooYzkuK3nmoTpgJLlop7ln7rlh4bjgILnvLrlsJHml7bpl7TmiLNcbiAqIOaXtui/lOWbniBgdW5yZWNvcmRlZGDvvIzml7bpl7Tpobrluo/lvILluLjml7bov5Tlm54gYGludmFsaWRg77yM5LiN6L+U5ZueIDAg56eS5oiW5o6o5rWL5YC844CCXG4gKlxuICogQHBhcmFtIHRpbWluZyDor6XoioLngrnnmoTnlJ/lkb3lkajmnJ/ml7bpl7TorrDlvZXjgIJcbiAqIEBwYXJhbSBub3cg5b2T5YmN5pyN5Yqh56uv5pe26Ze077yM5Y2V5L2N5q+r56eS77yb5LuF55So5LqO6K6h566X6L+Q6KGM5Lit55qE5bey55So5pe26Ze044CCXG4gKiBAcmV0dXJucyDogJfml7blj6/nlKjmgKfmiJblhbfkvZPmr6vnp5LmlbDjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vZGVUaW1pbmdEdXJhdGlvbih0aW1pbmcsIG5vdykge1xuICAgIGNvbnN0IHN0YXJ0ZWQgPSBwYXJzZVRpbWluZ0luc3RhbnQodGltaW5nLnN0YXJ0ZWRBdCk7XG4gICAgY29uc3QgZmluaXNoZWQgPSBwYXJzZVRpbWluZ0luc3RhbnQodGltaW5nLmZpbmlzaGVkQXQpO1xuICAgIGlmIChzdGFydGVkICE9PSB1bmRlZmluZWQgJiYgZmluaXNoZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBpZiAoZmluaXNoZWQgPCBzdGFydGVkKVxuICAgICAgICAgICAgcmV0dXJuIHsgYXZhaWxhYmlsaXR5OiAnaW52YWxpZCcsIHJlYXNvbjogJ291dC1vZi1vcmRlcicgfTtcbiAgICAgICAgcmV0dXJuIHsgYXZhaWxhYmlsaXR5OiAncmVjb3JkZWQnLCBtaWxsaXNlY29uZHM6IGZpbmlzaGVkIC0gc3RhcnRlZCB9O1xuICAgIH1cbiAgICBpZiAoZmluaXNoZWQgIT09IHVuZGVmaW5lZCAmJiBzdGFydGVkID09PSB1bmRlZmluZWQpXG4gICAgICAgIHJldHVybiB7IGF2YWlsYWJpbGl0eTogJ3VucmVjb3JkZWQnIH07XG4gICAgaWYgKHN0YXJ0ZWQgPT09IHVuZGVmaW5lZClcbiAgICAgICAgcmV0dXJuIHsgYXZhaWxhYmlsaXR5OiAndW5yZWNvcmRlZCcgfTtcbiAgICBpZiAoc3RhcnRlZCA+IG5vdylcbiAgICAgICAgcmV0dXJuIHsgYXZhaWxhYmlsaXR5OiAnaW52YWxpZCcsIHJlYXNvbjogJ2Z1dHVyZScgfTtcbiAgICByZXR1cm4geyBhdmFpbGFiaWxpdHk6ICdydW5uaW5nJywgbWlsbGlzZWNvbmRzOiBub3cgLSBzdGFydGVkLCBzaW5jZTogJ3N0YXJ0ZWRBdCcgfTtcbn1cbi8qKlxuICog5qC85byP5YyW6IqC54K56ICX5pe277yM57uf5LiA5L2/55So56eS5bm26Iez5aSa5L+d55WZ5LiA5L2N5bCP5pWw77yM5LiN6L2s5Li65YiG5oiW5bCP5pe244CCXG4gKlxuICogQHBhcmFtIG1pbGxpc2Vjb25kcyDpnZ7otJ/mr6vnp5LmlbDjgIJcbiAqIEByZXR1cm5zIOS+i+WmgiBgMTIuNOenkmDjgIFgMTIw56eSYO+8m+aXoOaViOaIlui0n+aVsOi+k+WFpei/lOWbnuepuuWtl+espuS4suOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Tm9kZUR1cmF0aW9uKG1pbGxpc2Vjb25kcykge1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1pbGxpc2Vjb25kcykgfHwgbWlsbGlzZWNvbmRzIDwgMClcbiAgICAgICAgcmV0dXJuICcnO1xuICAgIHJldHVybiBgJHtOdW1iZXIoKG1pbGxpc2Vjb25kcyAvIDEwMDApLnRvRml4ZWQoMSkpfeenkmA7XG59XG5mdW5jdGlvbiBwYXJzZVRpbWluZ0luc3RhbnQodmFsdWUpIHtcbiAgICBpZiAoIXZhbHVlKVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHBhcnNlZCA9IERhdGUucGFyc2UodmFsdWUpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IHVuZGVmaW5lZDtcbn1cbi8qKlxuICog5Yik5pat6IqC54K55piv5ZCm5bey5pyJ5Y+v5Zue5pi+55qE6LWE5Lqn5oiW55Sf5oiQ57uT5p6c44CCXG4gKiDkuIrkvKDmnaXmupDlkoznlJ/miJDnu5Pmnpzpg73nrpfvvJvnqbroioLngrnmsqHmnInlm57mmL7jgIJcbiAqIEBwYXJhbSBub2RlIOW+heajgOafpeeahOiKgueCueaIluWFtiBkYXRh44CCXG4gKiBAcmV0dXJucyDlrZjlnKggcmVzdWx0QXNzZXQuYXNzZXRJZO+8jOaIluWQjOaXtuWtmOWcqCBhc3NldElkIOS4jiBjb250ZW50VXJsIOaXtuS4uiB0cnVl44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub2RlSGFzRWNobyhub2RlKSB7XG4gICAgY29uc3QgZGF0YSA9ICdkYXRhJyBpbiBub2RlID8gbm9kZS5kYXRhIDogbm9kZTtcbiAgICByZXR1cm4gQm9vbGVhbihkYXRhLnJlc3VsdEFzc2V0Py5hc3NldElkIHx8IChkYXRhLmFzc2V0SWQgJiYgZGF0YS5jb250ZW50VXJsKSk7XG59XG4vKipcbiAqIOWIpOaWreiKgueCueaYr+WQpuaYr+WPr+S9nOS4uuKAnOS/ruaUueWbvueJh+KAneadpea6kOeahOWbvueJh+iKgueCue+8muW/hemhu+aYr+WbvueJh++8jOS4lOW3suacieWPr+WbnuaYvueahOi1hOS6p+OAglxuICog5p2l5rqQ6IqC54K55pys6Lqr5ZKM5bey5pyJ55Sf5oiQ57uT5p6c55qE6IqC54K56YO9566X77yM5L2G5LiN5ZCr5rKh5pyJ5Zu+54mH5YaF5a6555qE56m66IqC54K544CCXG4gKiBAcGFyYW0gbm9kZSDlvoXmo4Dmn6XnmoTlm77niYfoioLngrnjgIJcbiAqIEByZXR1cm5zIOWbvueJh+iKgueCueS4lOW3suacieWbnuaYvuaXtuS4uiB0cnVl44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ltYWdlRWRpdFNvdXJjZU5vZGUobm9kZSkge1xuICAgIGlmIChub2RlLmRhdGEubWVkaWFUeXBlICE9PSAnaW1hZ2UnKVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIG5vZGVIYXNFY2hvKG5vZGUpO1xufVxuLyoqIEdQVCBJbWFnZSDnvJbovpHmjqXlj6PljZXmrKHovpPlhaXmnIDlpJogMTYg5byg5Zu+54mH77yb5YW85a655qih5Z6L5Lmf5LiN6LaF6L+H5q2k5pys5Zyw5LiK6ZmQ44CCICovXG5leHBvcnQgY29uc3QgSU1BR0VfRURJVF9NQVhfSU1BR0VTID0gMTY7XG4vKipcbiAqIOino+aekOWbvueJh+e8lui+kei+k+WFpeS4iumZkO+8jOaYvuW8j+ebruW9lemZkOWItuS8mOWFiOS6juaooeWei+aXj+m7mOiupOWAvOOAglxuICogQHBhcmFtIG1vZGVsQWxpYXMg5a6e6ZmF5L6b5bqU5ZWG5qih5Z6LIElE77ybR1BUIEltYWdlIOWumOaWueaXj+m7mOiupCAxNiDlvKDvvIzlhbblroPmqKHlnovpu5jorqQgMSDlvKDjgIJcbiAqIEBwYXJhbSBjYXBhYmlsaXR5IOWPr+mAieeahOW3suWjsOaYjuS4iumZkO+8m+abtOWwj+WAvOeUn+aViO+8jOabtOWkp+WAvOaUtueqhOWIsCAxNiDlvKDjgIJcbiAqIEByZXR1cm5zIOWNleasoeWFgeiuuOeahOWbvueJh+W8oOaVsO+8jOiMg+WbtOS4uiAxIOiHsyAxNuOAglxuICogQHRocm93cyBSYW5nZUVycm9yIOaYvuW8jyBtYXhJbWFnZXMg5LiN5piv5pyJ6ZmQ5q2j5pW05pWw44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW1hZ2VFZGl0TWF4SW1hZ2VzKG1vZGVsQWxpYXMsIGNhcGFiaWxpdHkpIHtcbiAgICByZXR1cm4gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xufVxuLyoqIOebruW9leS4reWPr+eUqOS6juino+aekOWbvueJh+e8lui+keiDveWKm+eahOWtl+auteWQje+8jOWFvOWuueS+m+W6lOWVhueahCBzbmFrZV9jYXNlIOWIq+WQjeOAgiAqL1xuY29uc3QgaW1hZ2VFZGl0Q2FwYWJpbGl0eUtleXMgPSBbJ2ltYWdlRWRpdCcsICdpbWFnZV9lZGl0JywgJ3N1cHBvcnRzSW1hZ2VFZGl0J107XG4vKiog6K+75Y+W55uu5b2V5Lit55qE6Z2e56m65a2X56ym5Liy5YiX6KGo77yM5b+955Wl5peg5pWI6aG544CCICovXG5mdW5jdGlvbiByZWFkU3RyaW5nQXJyYXkodmFsdWUpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHZhbHVlcyA9IHZhbHVlXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pID0+IHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJylcbiAgICAgICAgLm1hcCgoaXRlbSkgPT4gaXRlbS50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgcmV0dXJuIHZhbHVlcy5sZW5ndGggPiAwID8gdmFsdWVzIDogdW5kZWZpbmVkO1xufVxuLyoqIOWIpOaWreiDveWKm+Wtl+auteaYr+WQpuWMheWQq+aUr+aMgee8lui+keeahOW4g+WwlOWAvOaIlue7k+aehOWMlue6puadn+OAgiAqL1xuZnVuY3Rpb24gaXNJbWFnZUVkaXREZWNsYXJhdGlvbih2YWx1ZSkge1xuICAgIGlmICh2YWx1ZSA9PT0gdHJ1ZSlcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcmVjb3JkID0gdmFsdWU7XG4gICAgLy8g5pi+5byPIGZhbHNlIOihqOekuuS+m+W6lOWVhuehruiupOS4jeaUr+aMge+8m+WPquacieaYvuW8jyB0cnVlIOaIlue7k+aehOWMluWjsOaYjuaJjeeul+aUr+aMgeOAglxuICAgIGlmIChyZWNvcmQuc3VwcG9ydGVkID09PSBmYWxzZSB8fCByZWNvcmQuc3VwcG9ydHMgPT09IGZhbHNlKVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHJlY29yZC5zdXBwb3J0ZWQgPT09IHRydWUgfHwgcmVjb3JkLnN1cHBvcnRzID09PSB0cnVlIHx8IE9iamVjdC5rZXlzKHJlY29yZCkubGVuZ3RoID4gMDtcbn1cbi8qKlxuICog5LuO5qih5Z6L55uu5b2V6aG56Kej5p6Q5Zu+54mH57yW6L6R6IO95Yqb77yM5LiN5oqK5a2X5q6157y65aSx5b2T5oiQ5piO56Gu56aB55So44CCXG4gKiBAcGFyYW0gbW9kZWwg5qih5Z6L55uu5b2V6aG55oiW6IqC54K55LiK55qE5qih5Z6L5o+P6L+w44CCXG4gKiBAcmV0dXJucyDlo7DmmI7nirbmgIHjgIHmmI7noa7npoHnlKjmoIforrDlj4rlj6/pgInovpPlhaXpmZDliLbvvJvkuI3lj5Hotbfor7fmsYLjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGltYWdlRWRpdENhcGFiaWxpdHkobW9kZWwpIHtcbiAgICBjb25zdCBjYXBhYmlsaXRpZXMgPSBtb2RlbD8uY2FwYWJpbGl0aWVzO1xuICAgIGlmICghY2FwYWJpbGl0aWVzKVxuICAgICAgICByZXR1cm4geyBkZWNsYXJlZDogZmFsc2UgfTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBpbWFnZUVkaXRDYXBhYmlsaXR5S2V5cykge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNhcGFiaWxpdGllc1trZXldO1xuICAgICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbClcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCByZWNvcmQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHZhbHVlKVxuICAgICAgICAgICAgPyB2YWx1ZVxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gZmFsc2UgfHwgcmVjb3JkPy5zdXBwb3J0ZWQgPT09IGZhbHNlIHx8IHJlY29yZD8uc3VwcG9ydHMgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICByZXR1cm4geyBkZWNsYXJlZDogZmFsc2UsIHVuc3VwcG9ydGVkOiB0cnVlIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpc0ltYWdlRWRpdERlY2xhcmF0aW9uKHZhbHVlKSlcbiAgICAgICAgICAgIHJldHVybiB7IGRlY2xhcmVkOiBmYWxzZSB9O1xuICAgICAgICBjb25zdCBtaW1lVHlwZXMgPSByZWFkU3RyaW5nQXJyYXkocmVjb3JkPy5taW1lVHlwZXMgPz8gcmVjb3JkPy5taW1lX3R5cGVzKTtcbiAgICAgICAgY29uc3Qgc2l6ZXMgPSByZWFkU3RyaW5nQXJyYXkocmVjb3JkPy5zaXplcyk7XG4gICAgICAgIGNvbnN0IHBhcmFtZXRlcnMgPSByZWFkU3RyaW5nQXJyYXkocmVjb3JkPy5wYXJhbWV0ZXJzID8/IHJlY29yZD8uZmllbGRzKTtcbiAgICAgICAgY29uc3QgaGFzTWF4SW1hZ2VzID0gQm9vbGVhbihyZWNvcmQgJiYgKE9iamVjdC5oYXNPd24ocmVjb3JkLCAnbWF4SW1hZ2VzJykgfHwgT2JqZWN0Lmhhc093bihyZWNvcmQsICdtYXhfaW1hZ2VzJykpKTtcbiAgICAgICAgY29uc3QgbWF4SW1hZ2VzID0gcmVjb3JkXG4gICAgICAgICAgICA/IE9iamVjdC5oYXNPd24ocmVjb3JkLCAnbWF4SW1hZ2VzJylcbiAgICAgICAgICAgICAgICA/IHJlY29yZC5tYXhJbWFnZXNcbiAgICAgICAgICAgICAgICA6IHJlY29yZC5tYXhfaW1hZ2VzXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgdmFsaWRNYXhJbWFnZXMgPSB0eXBlb2YgbWF4SW1hZ2VzID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNJbnRlZ2VyKG1heEltYWdlcykgJiYgbWF4SW1hZ2VzID4gMDtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGRlY2xhcmVkOiB0cnVlLFxuICAgICAgICAgICAgLi4uKG1pbWVUeXBlcyA/IHsgbWltZVR5cGVzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4oc2l6ZXMgPyB7IHNpemVzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocGFyYW1ldGVycyA/IHsgcGFyYW1ldGVycyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKGhhc01heEltYWdlc1xuICAgICAgICAgICAgICAgID8gdmFsaWRNYXhJbWFnZXNcbiAgICAgICAgICAgICAgICAgICAgPyB7IG1heEltYWdlcyB9XG4gICAgICAgICAgICAgICAgICAgIDogeyBpbnZhbGlkTWF4SW1hZ2VzOiB0cnVlIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHsgZGVjbGFyZWQ6IGZhbHNlIH07XG59XG4vKiog5Zu+54mH57yW6L6R6KKr5piO56Gu56aB55So5oiW6L6T5YWl5LiN56ym5ZCI57qm5p2f5pe255qE56iz5a6a6ZSZ6K+v56CB77yM5YmN56uv5LiOIEFQSSDlhbHnlKjjgIIgKi9cbmV4cG9ydCBjb25zdCBJTUFHRV9FRElUX1VOU1VQUE9SVEVEX0NPREUgPSAnSU1BR0VfRURJVF9VTlNVUFBPUlRFRCc7XG4vKiog5Y2V5qyh6IqC54K55om56YeP55Sf5oiQ55qE5Lqn5ZOB5LiK6ZmQ77yb5q+P5Lu96L6T5Ye65YiG5Yir5omn6KGM77yM5LiN5Luj6KGoIFByb3ZpZGVyIOeahOaJuemHj+iDveWKm+OAgiAqL1xuZXhwb3J0IGNvbnN0IEdFTkVSQVRJT05fQ09VTlRfTUFYID0gMjA7XG4vKiog5pyq5pi+5byP6K6+572u5pWw6YeP55qE5Y6G5Y+y6IqC54K55aeL57uI5Y+q55Sf5oiQ5LiA5Lu977yM6YG/5YWN5L+u5pS55YGP5aW95omp5aSn5bey5pyJ5Lu75Yqh44CCICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9HRU5FUkFUSU9OX0NPVU5UID0gMTtcbi8qKiDliKTmlq3nlJ/miJDmlbDph4/mmK/lkKbkuLogMSDoh7Pkuqflk4HkuIrpmZDkuYvpl7TnmoTmlbTmlbDvvIzkuI3miKrmlq3miJblm5voiI3kupTlhaXnlKjmiLfovpPlhaXjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkR2VuZXJhdGlvbkNvdW50KHZhbHVlKSB7XG4gICAgcmV0dXJuICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmXG4gICAgICAgIE51bWJlci5pc0ludGVnZXIodmFsdWUpICYmXG4gICAgICAgIHZhbHVlID49IERFRkFVTFRfR0VORVJBVElPTl9DT1VOVCAmJlxuICAgICAgICB2YWx1ZSA8PSBHRU5FUkFUSU9OX0NPVU5UX01BWCk7XG59XG4vKipcbiAqIOivu+WPluiKgueCueeahOWNleasoeeUn+aIkOaVsOmHj++8m+aXp+iKgueCuee8uuecgeS4uiAx77yM6Z2e5rOV5pi+5byP5YC85LiN5b6X5ZCv5Yqo55Sf5oiQ44CCXG4gKiBAcGFyYW0gZGF0YSDoioLngrnmlbDmja7vvIzmlbDph4/mmK/mnKzlnLDku7vliqHnvJbmjpLlrZfmrrXvvIzkuI3lj5HpgIHnu5kgUHJvdmlkZXLjgIJcbiAqIEByZXR1cm5zIOacrOasoeaTjeS9nOW6lOeUn+aIkOeahOS7veaVsO+8jOiMg+WbtOS4uiAxIOiHsyAyMOOAglxuICogQHRocm93cyBSYW5nZUVycm9yIOaYvuW8j+aVsOmHj+S4jeaYr+iMg+WbtOWGheeahOaVtOaVsOOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0Tm9kZUdlbmVyYXRpb25Db3VudChkYXRhKSB7XG4gICAgaWYgKGRhdGEuZ2VuZXJhdGlvbkNvdW50ID09PSB1bmRlZmluZWQpXG4gICAgICAgIHJldHVybiBERUZBVUxUX0dFTkVSQVRJT05fQ09VTlQ7XG4gICAgaWYgKCFpc1ZhbGlkR2VuZXJhdGlvbkNvdW50KGRhdGEuZ2VuZXJhdGlvbkNvdW50KSkge1xuICAgICAgICB0aHJvdyBuZXcgUmFuZ2VFcnJvcihg55Sf5oiQ5pWw6YeP5b+F6aG75Li6IDEg6IezICR7R0VORVJBVElPTl9DT1VOVF9NQVh9IOeahOaVtOaVsGApO1xuICAgIH1cbiAgICByZXR1cm4gZGF0YS5nZW5lcmF0aW9uQ291bnQ7XG59XG5leHBvcnQgY29uc3Qgbm9kZURhdGFTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgbGFiZWw6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIC8qKiDoioLngrnlrp7kvovpppbmrKHliJvlu7rml7bpl7TvvIhVVEMgSVNPIDg2MDHvvInvvJvlpI3liLbnmoTmlrDoioLngrnph43mlrDorrDlvZXvvIzljoblj7LnvLrlpLHkuI3ooaXlhpnjgIIgKi9cbiAgICBjcmVhdGVkQXQ6IHouc3RyaW5nKCkuZGF0ZXRpbWUoKS5vcHRpb25hbCgpLFxuICAgIG1lZGlhVHlwZTogbWVkaWFUeXBlU2NoZW1hLFxuICAgIG1vZGU6IG5vZGVNb2RlU2NoZW1hLFxuICAgIC8qKiBXaGV0aGVyIHRoaXMgbm9kZSBjb250cmlidXRlcyBpbnB1dHMgdG8gZG93bnN0cmVhbSBydW5zLiBPbWl0dGVkIG1lYW5zIGVuYWJsZWQgZm9yIGxlZ2FjeSBjYW52YXNlcy4gKi9cbiAgICBlbmFibGVkOiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxuICAgIC8qKiBEb3duc3RyZWFtIG91dHB1dCBpcyBubyBsb25nZXIgZGVyaXZlZCBmcm9tIHRoZSBjdXJyZW50IHVwc3RyZWFtIGlucHV0cy4gKi9cbiAgICBzdGFsZTogei5ib29sZWFuKCkub3B0aW9uYWwoKSxcbiAgICAvKiog5omL5Yqo5LiK5Lyg5oiW57yW6L6R55qE6LWE5Lqn5LyY5YWI5L2c5Li65LiL5ri46L6T5YWl77yb5LuF5piO56Gu6YeN5paw55Sf5oiQ5pys6IqC54K55pe25omn6KGM5qih5Z6L44CCICovXG4gICAgbWFudWFsT3V0cHV0OiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxuICAgIC8qKiDmmI7noa7ph43mlrDnlJ/miJDnmoTov5DooYwgSUTvvJvnlYzpnaLlj6rlhYHorrjor6Xov5DooYzmiJDlip/lkI7mm7/mjaLmiYvliqjovpPlh7rvvIzlpLHotKXku43kv53nlZnotYTkuqfjgIIgKi9cbiAgICBtYW51YWxPdXRwdXRSdW5JZDogei5zdHJpbmcoKS50cmltKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgcHJvbXB0OiB6LnN0cmluZygpLnRyaW0oKS5tYXgoMjBfMDAwKS5vcHRpb25hbCgpLFxuICAgIC8qKiDniYjmnKzljJbmj5DnpLror43mlofmoaPvvJvlrZjlnKjml7blroPmmK/llK/kuIDmiafooYzmnaXmupDvvIzml6cgcHJvbXB0IOS7heS9nOWFvOWuueWtl+auteOAgiAqL1xuICAgIHByb21wdERvY3VtZW50OiBwcm9tcHREb2N1bWVudFNjaGVtYS5vcHRpb25hbCgpLFxuICAgIC8qKiDoioLngrnpgInkuK3nmoTmj5DnpLror43mioDog73vvJvku4XmmL7lvI/kvJjljJbml7bkvb/nlKjvvIzmma7pgJrnlJ/miJDkuI3oh6rliqjmiafooYzjgIIgKi9cbiAgICBwcm9tcHRTa2lsbElkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDgwKS5vcHRpb25hbCgpLFxuICAgIC8qKlxuICAgICAqIOiKgueCueWPguiAg+i1hOa6kOaxoOOAguWQjeWtl+e7keWumuWIsCBhc3NldElk77yM5o+Q56S66K+N55So5ZCN5a2X5byV55So77ybXG4gICAgICog5LiO55S75biD6L+e57q/5ZKM5o+Q56S66K+N5o+Q5Y+K5YWx55So5ZCM5LiA5Lu96Lqr5Lu977yM6YG/5YWN5oyJ6aG65bqP5LqS5o2i6KeS6Imy44CCXG4gICAgICovXG4gICAgcmVzb3VyY2VSZWZzOiB6LmFycmF5KG5vZGVSZXNvdXJjZVJlZlNjaGVtYSkub3B0aW9uYWwoKSxcbiAgICAvKipcbiAgICAgKiDkuI7oioLngrnkuIDlkIzkv53lrZjnmoTlqpLkvZPnlJ/miJDlj4LmlbDvvIzkvovlpoLlm77niYflsLrlr7gv5riF5pmw5bqm5ZKM6KeG6aKR5YiG6L6o546HL+aXtumVv+OAglxuICAgICAqIOWPguaVsOeUseWvueW6lCBQcm92aWRlciDmjInlt7LmlK/mjIHnmoTlrZfmrrXmmKDlsITvvIzmnKrphY3nva7ml7bmsr/nlKjmqKHlnovpu5jorqTlgLzjgIJcbiAgICAgKi9cbiAgICBwYXJhbWV0ZXJzOiB6LnJlY29yZCh6LnVua25vd24oKSkub3B0aW9uYWwoKSxcbiAgICAvKiog5Y2V5qyh5pON5L2c55Sf5oiQ55qE5Lu95pWw77yM57y655yB5Li6IDHvvJvku4XnlKjkuo7ku7vliqHnvJbmjpLvvIzkuI3lhpnlhaUgUHJvdmlkZXIg5Y+C5pWw44CCICovXG4gICAgZ2VuZXJhdGlvbkNvdW50OiB6Lm51bWJlcigpLmludCgpLm1pbigxKS5tYXgoR0VORVJBVElPTl9DT1VOVF9NQVgpLm9wdGlvbmFsKCksXG4gICAgLyoqIOaJuemHj+e7k+aenOaJgOWxnuWNoeeJjOe7hO+8jOS7heeUqOS6jueUu+W4g+Wxleekuue8luaOku+8jOS4jeWPguS4jiBQcm92aWRlciDlj4LmlbDmiJbnlJ/miJDmlbDph4/orqHnrpfjgIIgKi9cbiAgICBnZW5lcmF0aW9uQmF0Y2g6IHpcbiAgICAgICAgLm9iamVjdCh7XG4gICAgICAgIC8qKiDlkIzkuIDmibnnlJ/miJDnu5PmnpzlhbHkuqvnmoTpnZ7nqbrliIbnu4TmoIfor4bjgIIgKi9cbiAgICAgICAgaWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgICAgICAvKiog5om55qyh6LW35aeL6IqC54K55qCH6K+G77yM55So5LqO5YWz6IGU55S75biD5LiK55qE5Y2h54mM57uE44CCICovXG4gICAgICAgIHJvb3ROb2RlSWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgICAgICAvKiog57uT5p6c5Zyo5om55qyh5YaF55qE6Zu26LW35aeL5bqP5Y+344CCICovXG4gICAgICAgIGluZGV4OiB6Lm51bWJlcigpLmludCgpLm1pbigwKSxcbiAgICB9KVxuICAgICAgICAub3B0aW9uYWwoKSxcbiAgICAvKiog5om56YeP5Y2h54mM57uE5piv5ZCm5bGV5byA77yb57y655yB55Sx55S75biD6YeH55So5pS26LW354q25oCB77yM5LuF55So5LqO5bGV56S657yW5o6S44CCICovXG4gICAgZ2VuZXJhdGlvbkJhdGNoRXhwYW5kZWQ6IHouYm9vbGVhbigpLm9wdGlvbmFsKCksXG4gICAgLyoqXG4gICAgICog5qih5Z6L5pSv5oyB55qE5o6o55CG5by65bqm5qCH6K+G44CC5LiN5ZCM5qih5Z6L55qE6IO95Yqb5ZCN56ew5Y+v6IO95LiN5ZCM77yI5L6L5aaCXG4gICAgICogYGxvd2DjgIFgaGlnaGDjgIFgeGhpZ2hgIOaIliBgbWF4YO+8ie+8jOWboOatpOWPquagoemqjOS4uumdnuepuuWtl+espuS4suOAglxuICAgICAqL1xuICAgIGluZmVyZW5jZVN0cmVuZ3RoOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBtb2RlbEFsaWFzOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICAvKiog5pys5Lq65YiG57uE5qih5Z6L55qE5pyN5Yqh56uv5Yet5o2u5byV55So77yb5a6e6ZmF55Sf5oiQ5YmN5b+F6aG76aqM6K+B5b2S5bGe5ZKM54mI5pys44CCICovXG4gICAgY3JlZGVudGlhbElkOiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBhc3NldElkOiB6LnN0cmluZygpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIGNvbnRlbnRVcmw6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgbWltZVR5cGU6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgLyoqXG4gICAgICog6KeG6aKR5oiQ5Yqf5ZCO55qE5pyr5bin5rS+55Sf5Yqo5L2c44CC57y655yB5oiW5pen6IqC54K56KeG5Li6IG5vbmXvvIzkuI3lm57ooaXljoblj7Lku7vliqHjgIJcbiAgICAgKi9cbiAgICBjb21wbGV0aW9uQWN0aW9uOiB2aWRlb0NvbXBsZXRpb25BY3Rpb25TY2hlbWEub3B0aW9uYWwoKSxcbiAgICAvKiog5LuFIGZpbGxfZGVzaWduYXRlZF9pbWFnZV9ub2RlIOS9v+eUqO+8m+W/hemhu+aMh+WQkeS7jeS4uuepuueahOWbvueJh+iKgueCueOAgiAqL1xuICAgIGNvbXBsZXRpb25UYXJnZXROb2RlSWQ6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIC8qKlxuICAgICAqIOinhumikeeUn+aIkOaooeW8j+OAgue8uuecgeihqOekuuaXp+eUu+W4g++8muerr+WPo+S/neaMgeWFqOmHj+WFvOWuue+8jOi/kOihjOaXtuaMiei/nue6v+aOqOaWreOAglxuICAgICAqIOaWsOinhumikeeUn+aIkOiKgueCueS8muWGmeWFpeaYvuW8j+WAvO+8jOS4gOasoei/kOihjOWPquS9v+eUqOS4gOenjeaooeW8j+OAglxuICAgICAqL1xuICAgIHZpZGVvTW9kZTogdmlkZW9Nb2RlU2NoZW1hLm9wdGlvbmFsKCksXG4gICAgLyoqXG4gICAgICog5Zu+54mH57yW6L6R6K+t5LmJ44CC55Sx4oCc5L+u5pS55Zu+54mH4oCd5YWl5Y+j5YaZ5YWl55qE54mI5pys5YyW5p2l5rqQ5byV55So77yb57y655yB6KGo56S65pmu6YCa5Zu+54mHXG4gICAgICog55Sf5oiQ6IqC54K577yI5pen55S75biD5LiN5Lya6KKr6Ieq5Yqo5o6o5pat5oiQ57yW6L6R6IqC54K577yJ44CCXG4gICAgICovXG4gICAgaW1hZ2VFZGl0U291cmNlOiBpbWFnZUVkaXRTb3VyY2VTY2hlbWEub3B0aW9uYWwoKSxcbiAgICAvKiog5pW05p2h55+t6KeG6aKR5aSN5Yi75LiT5bGe5bel5L2c5rWB77yb5L+d5oyB5pmu6YCadmlkZW/lqpLkvZPkuI5Qcm92aWRlcuWQiOWQjOOAgiAqL1xuICAgIHZpZGVvUmVjcmVhdGlvbjogdmlkZW9SZWNyZWF0aW9uQ29uZmlnU2NoZW1hLm9wdGlvbmFsKCksXG4gICAgLyoqIOacqumAieaLqeadpea6kOeahOefreinhumikeWkjeWIu+iNieeov++8m+WGu+e7k+adpea6kOWQjuenu+mZpO+8jOS4jeS4uuaXp+iKgueCueihpem7mOiupOWAvOOAgiAqL1xuICAgIHZpZGVvUmVjcmVhdGlvbkRyYWZ0OiB6LmxpdGVyYWwodHJ1ZSkub3B0aW9uYWwoKSxcbn0pO1xuLyoqIExlZ2FjeSBjYW52YXNlcyBvbWl0IHRoaXMgZmllbGQ7IG9ubHkgYW4gZXhwbGljaXQgZmFsc2UgZGlzYWJsZXMgYSBub2RlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ2FudmFzTm9kZUVuYWJsZWQobm9kZSkge1xuICAgIHJldHVybiBub2RlLmRhdGEuZW5hYmxlZCAhPT0gZmFsc2U7XG59XG4vKiog55S75biD6IqC54K55ZCI5ZCM77yb56m65aSN5Yi76I2J56i/5LuF6IO95L+d5a2Y5Zyo5bCa5pyq5Ya757uT5p2l5rqQ55qE6KeG6aKR55Sf5oiQ6IqC54K544CCICovXG5leHBvcnQgY29uc3QgY2FudmFzTm9kZVNjaGVtYSA9IHpcbiAgICAub2JqZWN0KHtcbiAgICBpZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgdHlwZTogbWVkaWFUeXBlU2NoZW1hLFxuICAgIHBvc2l0aW9uOiB6Lm9iamVjdCh7IHg6IHoubnVtYmVyKCksIHk6IHoubnVtYmVyKCkgfSksXG4gICAgLyoqIFVzZXItcmVzaXphYmxlIGRpbWVuc2lvbnMuIFJlYWN0IEZsb3cga2VlcHMgdGhlc2Ugb24gdGhlIG5vZGUgaXRzZWxmLiAqL1xuICAgIHdpZHRoOiB6Lm51bWJlcigpLmZpbml0ZSgpLnBvc2l0aXZlKCkubWF4KDEwXzAwMCkub3B0aW9uYWwoKSxcbiAgICBoZWlnaHQ6IHoubnVtYmVyKCkuZmluaXRlKCkucG9zaXRpdmUoKS5tYXgoMTBfMDAwKS5vcHRpb25hbCgpLFxuICAgIGRhdGE6IG5vZGVEYXRhU2NoZW1hLFxufSlcbiAgICAuc3VwZXJSZWZpbmUoKG5vZGUsIGNvbnRleHQpID0+IHtcbiAgICBpZiAoIW5vZGUuZGF0YS52aWRlb1JlY3JlYXRpb25EcmFmdClcbiAgICAgICAgcmV0dXJuO1xuICAgIGlmIChub2RlLnR5cGUgIT09ICd2aWRlbycgfHwgbm9kZS5kYXRhLm1lZGlhVHlwZSAhPT0gJ3ZpZGVvJyB8fCBub2RlLmRhdGEubW9kZSAhPT0gJ2dlbmVyYXRlJykge1xuICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICfnn63op4bpopHlpI3liLvojYnnqL/lv4XpobvmmK/op4bpopHnlJ/miJDoioLngrknLFxuICAgICAgICAgICAgcGF0aDogWydkYXRhJywgJ3ZpZGVvUmVjcmVhdGlvbkRyYWZ0J10sXG4gICAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAobm9kZS5kYXRhLnZpZGVvUmVjcmVhdGlvbikge1xuICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICflpI3liLvmnaXmupDlt7Llhrvnu5PvvIzor7fnp7vpmaTnqbrojYnnqL/moIforrAnLFxuICAgICAgICAgICAgcGF0aDogWydkYXRhJywgJ3ZpZGVvUmVjcmVhdGlvbkRyYWZ0J10sXG4gICAgICAgIH0pO1xuICAgIH1cbn0pO1xuZXhwb3J0IGNvbnN0IGNhbnZhc0VkZ2VTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHNvdXJjZU5vZGVJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgc291cmNlSGFuZGxlOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICB0YXJnZXROb2RlSWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHRhcmdldEhhbmRsZTogei5zdHJpbmcoKS5taW4oMSksXG4gICAgb3JkZXI6IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKSxcbn0pO1xuLyoqIOe7hOWMuuWfn+WFgeiuuOeahOacgOWwj+i+uemVv++8jOWNleS9jeS4uueUu+W4g+WDj+e0oOOAgiAqL1xuZXhwb3J0IGNvbnN0IENBTlZBU19HUk9VUF9NSU5fU0laRSA9IDEyMDtcbi8qKiDnu4TljLrln5/lhYHorrjnmoTmnIDlpKfovrnplb/vvIzljZXkvY3kuLrnlLvluIPlg4/ntKDjgIIgKi9cbmV4cG9ydCBjb25zdCBDQU5WQVNfR1JPVVBfTUFYX1NJWkUgPSAxMF8wMDA7XG4vKiog5Y2V5Liq57uE5YWB6K6455qE5oiQ5ZGY5pWw6YeP5LiK6ZmQ77yb6LaF5Ye65pe26KeE6IyD5YyW6Zi25q615Lya5oiq5pat6ICM5LiN5piv5YaZ5Ye66Z2e5rOV5paH5qGj44CCICovXG5leHBvcnQgY29uc3QgQ0FOVkFTX0dST1VQX05PREVfTElNSVQgPSA1MDA7XG4vKipcbiAqIOeUu+W4g+W4g+WxgOWMuuWfn+OAglxuICpcbiAqIOe7hOWPquihqOi+vueUu+W4g+W4g+WxgO+8jOS4jeaYr+esrOS6lOenjeWqkuS9k+exu+Wei++8muWug+S4jei/m+WFpei/kOihjCBEQUfvvIzmsqHmnInovpPlhaXovpPlh7rnq6/lj6PvvIxcbiAqIOS5n+S4jeWHuueOsOWcqOaooeWei+mAieaLqeaIlui1hOa6kOeUn+aIkOivt+axguS4reOAgmBub2RlSWRzYCDmmK/miJDlkZjoioLngrnouqvku73vvIzoioLngrnmnKzouqvku43ku6VcbiAqIOeUu+W4g+e7neWvueWdkOagh+aMgeS5heWMlu+8jOinhuWbvuWxgui9rOaNouWIsOe7hOWGheebuOWvueWdkOagh+WPquWPkeeUn+WcqOa4suafk+i+ueeVjOOAglxuICovXG5leHBvcnQgY29uc3QgY2FudmFzR3JvdXBTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaWQ6IHouc3RyaW5nKCkubWluKDEpLm1heCgxNjApLFxuICAgIG5hbWU6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMTYwKSxcbiAgICBwb3NpdGlvbjogei5vYmplY3QoeyB4OiB6Lm51bWJlcigpLmZpbml0ZSgpLCB5OiB6Lm51bWJlcigpLmZpbml0ZSgpIH0pLFxuICAgIHdpZHRoOiB6Lm51bWJlcigpLmZpbml0ZSgpLm1pbihDQU5WQVNfR1JPVVBfTUlOX1NJWkUpLm1heChDQU5WQVNfR1JPVVBfTUFYX1NJWkUpLFxuICAgIGhlaWdodDogei5udW1iZXIoKS5maW5pdGUoKS5taW4oQ0FOVkFTX0dST1VQX01JTl9TSVpFKS5tYXgoQ0FOVkFTX0dST1VQX01BWF9TSVpFKSxcbiAgICAvKiog5oiQ5ZGY6IqC54K5IElE77yb5LiA5Liq6IqC54K55pyA5aSa5bGe5LqO5LiA5Liq57uE77yM6aaW54mI56aB5q2i5bWM5aWX5LiO5b6q546v5b2S5bGe44CCICovXG4gICAgbm9kZUlkczogei5hcnJheSh6LnN0cmluZygpLm1pbigxKSkubWF4KENBTlZBU19HUk9VUF9OT0RFX0xJTUlUKSxcbn0pO1xuZXhwb3J0IGNvbnN0IGNhbnZhc0RvY3VtZW50U2NoZW1hID0gelxuICAgIC5vYmplY3Qoe1xuICAgIHJldmlzaW9uOiB6Lm51bWJlcigpLmludCgpLm5vbm5lZ2F0aXZlKCksXG4gICAgbm9kZXM6IHouYXJyYXkoY2FudmFzTm9kZVNjaGVtYSksXG4gICAgZWRnZXM6IHouYXJyYXkoY2FudmFzRWRnZVNjaGVtYSksXG4gICAgLyoqIOaXp+eUu+W4g+e8uuecgeaMieepuue7hOWIl+ihqOivu+WPlu+8m+S4jeWGmeWFpee7hOWtl+auteaXtuS4jeaUueWPmOaXouacieWGheWuueOAgiAqL1xuICAgIGdyb3Vwczogei5hcnJheShjYW52YXNHcm91cFNjaGVtYSkub3B0aW9uYWwoKSxcbn0pXG4gICAgLnN1cGVyUmVmaW5lKChkb2N1bWVudCwgY29udGV4dCkgPT4ge1xuICAgIGNvbnN0IG5vZGVJZHMgPSBuZXcgU2V0KCk7XG4gICAgY29uc3Qgbm9kZXNCeUlkID0gbmV3IE1hcCgpO1xuICAgIGRvY3VtZW50Lm5vZGVzLmZvckVhY2goKG5vZGUsIGluZGV4KSA9PiB7XG4gICAgICAgIGlmIChub2RlSWRzLmhhcyhub2RlLmlkKSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBkdXBsaWNhdGUgbm9kZSBpZDogJHtub2RlLmlkfWAsXG4gICAgICAgICAgICAgICAgcGF0aDogWydub2RlcycsIGluZGV4LCAnaWQnXSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIG5vZGVJZHMuYWRkKG5vZGUuaWQpO1xuICAgICAgICBub2Rlc0J5SWQuc2V0KG5vZGUuaWQsIG5vZGUpO1xuICAgIH0pO1xuICAgIGNvbnN0IGVkZ2VzQnlTb3VyY2UgPSBuZXcgTWFwKCk7XG4gICAgY29uc3QgZWRnZUlkcyA9IG5ldyBTZXQoKTtcbiAgICBkb2N1bWVudC5lZGdlcy5mb3JFYWNoKChlZGdlLCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAoZWRnZUlkcy5oYXMoZWRnZS5pZCkpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBgZHVwbGljYXRlIGVkZ2UgaWQ6ICR7ZWRnZS5pZH1gLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsnZWRnZXMnLCBpbmRleCwgJ2lkJ10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBlZGdlSWRzLmFkZChlZGdlLmlkKTtcbiAgICAgICAgY29uc3Qgc291cmNlID0gbm9kZXNCeUlkLmdldChlZGdlLnNvdXJjZU5vZGVJZCk7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IG5vZGVzQnlJZC5nZXQoZWRnZS50YXJnZXROb2RlSWQpO1xuICAgICAgICBpZiAoIXNvdXJjZSB8fCAhdGFyZ2V0KSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ2VkZ2UgcmVmZXJlbmNlcyBhIG1pc3Npbmcgbm9kZScsXG4gICAgICAgICAgICAgICAgcGF0aDogWydlZGdlcycsIGluZGV4XSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzb3VyY2UuaWQgPT09IHRhcmdldC5pZCkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICdzZWxmLXJlZmVyZW50aWFsIGVkZ2VzIGFyZSBub3QgYWxsb3dlZCcsXG4gICAgICAgICAgICAgICAgcGF0aDogWydlZGdlcycsIGluZGV4XSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaXNQb3J0Q29ubmVjdGlvbkFsbG93ZWQoc291cmNlLCBlZGdlLnNvdXJjZUhhbmRsZSwgdGFyZ2V0LCBlZGdlLnRhcmdldEhhbmRsZSkpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBgaW5jb21wYXRpYmxlIGNvbm5lY3Rpb246ICR7ZWRnZS5zb3VyY2VIYW5kbGV9IC0+ICR7ZWRnZS50YXJnZXRIYW5kbGV9YCxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ2VkZ2VzJywgaW5kZXhdLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc291cmNlRWRnZXMgPSBlZGdlc0J5U291cmNlLmdldChzb3VyY2UuaWQpID8/IFtdO1xuICAgICAgICBzb3VyY2VFZGdlcy5wdXNoKHRhcmdldC5pZCk7XG4gICAgICAgIGVkZ2VzQnlTb3VyY2Uuc2V0KHNvdXJjZS5pZCwgc291cmNlRWRnZXMpO1xuICAgIH0pO1xuICAgIGNvbnN0IHZpc2l0aW5nID0gbmV3IFNldCgpO1xuICAgIGNvbnN0IHZpc2l0ZWQgPSBuZXcgU2V0KCk7XG4gICAgY29uc3QgdmlzaXQgPSAobm9kZUlkKSA9PiB7XG4gICAgICAgIGlmICh2aXNpdGluZy5oYXMobm9kZUlkKSlcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGVJZCkpXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgdmlzaXRpbmcuYWRkKG5vZGVJZCk7XG4gICAgICAgIGZvciAoY29uc3QgdGFyZ2V0SWQgb2YgZWRnZXNCeVNvdXJjZS5nZXQobm9kZUlkKSA/PyBbXSkge1xuICAgICAgICAgICAgaWYgKCF2aXNpdCh0YXJnZXRJZCkpXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHZpc2l0aW5nLmRlbGV0ZShub2RlSWQpO1xuICAgICAgICB2aXNpdGVkLmFkZChub2RlSWQpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9O1xuICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIG5vZGVJZHMpIHtcbiAgICAgICAgaWYgKCF2aXNpdChub2RlSWQpKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ2NhbnZhcyBncmFwaCBtdXN0IGJlIGFjeWNsaWMnLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsnZWRnZXMnXSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8g57uE5Y+q5qCh6aqM5biD5bGA5b2S5bGe77ya5oiQ5ZGY5b+F6aG75a2Y5Zyo5LiU5Y+q6IO95bGe5LqO5LiA5Liq57uE44CC57uE5LiN5Y+C5LiO6L+e6YCa5oCn44CBXG4gICAgLy8g56uv5Y+j5oiW546v5qOA5rWL77yM5Zug5q2k6L+Z6YeM5LiN5YGa5Lu75L2V5Zu+57uT5p6E5o6o5pat44CCXG4gICAgY29uc3QgZ3JvdXBJZHMgPSBuZXcgU2V0KCk7XG4gICAgY29uc3QgbWVtYmVyR3JvdXBJZCA9IG5ldyBNYXAoKTtcbiAgICBkb2N1bWVudC5ncm91cHM/LmZvckVhY2goKGdyb3VwLCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAoZ3JvdXBJZHMuaGFzKGdyb3VwLmlkKSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBkdXBsaWNhdGUgZ3JvdXAgaWQ6ICR7Z3JvdXAuaWR9YCxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ2dyb3VwcycsIGluZGV4LCAnaWQnXSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGdyb3VwSWRzLmFkZChncm91cC5pZCk7XG4gICAgICAgIGNvbnN0IG1lbWJlcnMgPSBuZXcgU2V0KCk7XG4gICAgICAgIGdyb3VwLm5vZGVJZHMuZm9yRWFjaCgobm9kZUlkLCBtZW1iZXJJbmRleCkgPT4ge1xuICAgICAgICAgICAgaWYgKG1lbWJlcnMuaGFzKG5vZGVJZCkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlOiBgZHVwbGljYXRlIGdyb3VwIG1lbWJlcjogJHtub2RlSWR9YCxcbiAgICAgICAgICAgICAgICAgICAgcGF0aDogWydncm91cHMnLCBpbmRleCwgJ25vZGVJZHMnLCBtZW1iZXJJbmRleF0sXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBtZW1iZXJzLmFkZChub2RlSWQpO1xuICAgICAgICAgICAgaWYgKCFub2RlSWRzLmhhcyhub2RlSWQpKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogJ2dyb3VwIHJlZmVyZW5jZXMgYSBtaXNzaW5nIG5vZGUnLFxuICAgICAgICAgICAgICAgICAgICBwYXRoOiBbJ2dyb3VwcycsIGluZGV4LCAnbm9kZUlkcycsIG1lbWJlckluZGV4XSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IG1lbWJlckdyb3VwSWQuZ2V0KG5vZGVJZCk7XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBub2RlICR7bm9kZUlkfSBhbHJlYWR5IGJlbG9uZ3MgdG8gZ3JvdXAgJHtleGlzdGluZ31gLFxuICAgICAgICAgICAgICAgICAgICBwYXRoOiBbJ2dyb3VwcycsIGluZGV4LCAnbm9kZUlkcycsIG1lbWJlckluZGV4XSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBtZW1iZXJHcm91cElkLnNldChub2RlSWQsIGdyb3VwLmlkKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG59KTtcbi8qKiDljZXmnaHlhrvnu5Pov57nur/ovpPlhaXvvJvlj6/pgInniYjmnKznlKjkuo7msLTlkIjlkI7kv53nlZnmnaXmupDouqvku73vvIzml6flv6vnhafku43ku47lhrvnu5MgVVJMIOino+aekOOAgiAqL1xuZXhwb3J0IGNvbnN0IHJ1bklucHV0U25hcHNob3RTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgbm9kZUlkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICByb2xlOiBwb3J0Um9sZVNjaGVtYSxcbiAgICBzb3J0T3JkZXI6IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKSxcbiAgICBzb3VyY2VBc3NldElkOiB6LnN0cmluZygpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIC8qKiDlt7Llhrvnu5PnmoTotYTkuqfniYjmnKzvvIzlv4XpobvkuI7mnaXmupDotYTkuqcgVVJMIOWvueW6lO+8m+e8uuecgeS4jeihqOekuuS9v+eUqOacgOaWsOeJiOOAgiAqL1xuICAgIHNvdXJjZUFzc2V0VmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgLyoqIOW3suWGu+e7k+inhumikeaIlumfs+mikeeJiOacrOeahOaOoua1i+aXtumVv++8m+S4jeW+l+S7juW9k+WJjei1hOS6p+WFg+aVsOaNruWbnuWhq+OAgiAqL1xuICAgIHNvdXJjZUR1cmF0aW9uU2Vjb25kczogei5udW1iZXIoKS5maW5pdGUoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgc25hcHNob3Q6IGNhbnZhc05vZGVTY2hlbWEsXG59KTtcbi8qKiDkuIrmuLjmnYPlqIHmjojmnYPkuovlrp7vvJvml6Dlr4bpkqXvvIzmiYDmnInlrZfmrrXlhrvnu5PlkI7nlKjkuo7lj5fnkIbml7bnmoTniYjmnKzmoKHpqozjgIIgKi9cbmV4cG9ydCBjb25zdCBuZXdBcGlFeGVjdXRpb25BdXRob3JpdHlTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaXNzdWVyOiB6LnN0cmluZygpLnVybCgpLFxuICAgIGV4dGVybmFsVXNlcklkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBpbnN0YW5jZUlkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBncmFudElkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICB0b2tlbklkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBjcmVkZW50aWFsUmV2aXNpb246IHouc3RyaW5nKCkubWluKDEpLFxuICAgIGdyb3VwOiB6XG4gICAgICAgIC5zdHJpbmcoKVxuICAgICAgICAubWluKDEpXG4gICAgICAgIC5yZWZpbmUoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gJ+elnuenmOWIhue7hCcpLFxuICAgIHBlcm1pc3Npb25SZXZpc2lvbjogei5zdHJpbmcoKS5taW4oMSksXG4gICAgYXV0b0dyb3Vwczogei5hcnJheSh6XG4gICAgICAgIC5zdHJpbmcoKVxuICAgICAgICAubWluKDEpXG4gICAgICAgIC5yZWZpbmUoKHZhbHVlKSA9PiB2YWx1ZSAhPT0gJ+elnuenmOWIhue7hCcpKSxcbn0pO1xuLyoqIOacrOS6uuWHreaNrueahOS4jeWPr+WPmOeJiOacrO+8m25ld0FwaSDku4XkvpvlhoXpg6jnlJ/miJDmoKHpqozvvIzkuI3og73nlLHlrqLmiLfnq6/mjojkuojmnYPpmZDjgIIgKi9cbmV4cG9ydCBjb25zdCBydW5DcmVkZW50aWFsUmVmZXJlbmNlU2NoZW1hID0gei5vYmplY3Qoe1xuICAgIGNyZWRlbnRpYWxJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgY3JlZGVudGlhbFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICBuZXdBcGk6IG5ld0FwaUV4ZWN1dGlvbkF1dGhvcml0eVNjaGVtYS5vcHRpb25hbCgpLFxufSk7XG4vKiog5q+P5Liq6IqC54K555qE5Lit5oCn5omn6KGM5ZCI5ZCM77yb6LS555So55SxIE5ldyBBUEkg5aSE55CG77yM5LiN5ZCrIENhbnZhcyDllYblk4HmiJbmiqXku7fjgIIgKi9cbmV4cG9ydCBjb25zdCBydW5FeGVjdXRpb25CaW5kaW5nU2NoZW1hID0gei5vYmplY3Qoe1xuICAgIGNyZWRlbnRpYWxJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgY3JlZGVudGlhbFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICBtb2RlbEFsaWFzOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBtZWRpYVR5cGU6IHouZW51bShbJ3RleHQnLCAnaW1hZ2UnLCAnYXVkaW8nLCAndmlkZW8nXSksXG4gICAgY29udHJhY3Q6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIGF1dGhvcml0eTogbmV3QXBpRXhlY3V0aW9uQXV0aG9yaXR5U2NoZW1hLFxufSk7XG4vKiog54us56uL6LWE5rqQ5YiG5p6Q55qE5Ya757uT6Lqr5Lu977yb6Ieq5Yqo5Lu75Yqh5oyJ6aG555uu44CB6LWE5Lqn5ZKM54mI5pys5Y676YeN77yM5LiN5bGe5LqO55S75biD6IqC54K544CCICovXG5leHBvcnQgY29uc3QgcmV2ZXJzZVByb21wdFNvdXJjZVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBhc3NldElkOiB6LnN0cmluZygpLm1pbigxKS5tYXgoNTEyKSxcbiAgICBhc3NldFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICBhdXRvbWF0aWM6IHouYm9vbGVhbigpLFxuICAgIC8qKiDkuJPlsZ7op4bpopHlpI3liLvliIbmnpDkuI7mma7pgJrlj43mjqjpmpTnprvvvIznvLrnnIHkv53mjIHml6fooYzkuLrjgIIgKi9cbiAgICBwdXJwb3NlOiB6LmxpdGVyYWwoJ3ZpZGVvX3JlY3JlYXRpb24nKS5vcHRpb25hbCgpLFxufSk7XG4vKiog5Y+N5o6o5b6X5Yiw55qE5o+P6L+w77yM5LiN5Luj6KGo5oGi5aSN5Ye655qE5Y6f5aeL55Sf5oiQ6K+35rGC77yb6ZW/5bqm6ZmQ5Yi25Lul5a2X56ym5pWw6K6h44CCICovXG5leHBvcnQgY29uc3QgcmV2ZXJzZVByb21wdFJlc3VsdFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBzdW1tYXJ5OiB6LnN0cmluZygpLnRyaW0oKS5taW4oMSkubWF4KDJfMDAwKSxcbiAgICBwcm9tcHQ6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMjBfMDAwKSxcbn0pO1xuLyoqXG4gKiDop6PmnpDmqKHlnovov5Tlm57nmoTlj43mjqggSlNPTu+8jOWFvOWuueWNleS4qiBNYXJrZG93biBKU09OIOWbtOagj+OAglxuICogQHBhcmFtIHRleHQgUHJvdmlkZXIg6L+U5Zue55qE5a6M5pW05paH5a2X6L6T5Ye644CCXG4gKiBAcmV0dXJucyDlt7Lpqozor4HkuJTljrvpmaTlpJrkvZnlrZfmrrXnmoTmkZjopoHlkozor6bnu4bmj5DnpLror43jgIJcbiAqIEB0aHJvd3MgSlNPTuOAgeWtl+auteaIlumVv+W6puS4jeato+ehruaXtuaKm+WHuuWbuuWumumUmeivr++8jOS4jeaKiuS+m+W6lOWVhuWOn+aWh+WGmeWFpemUmeivr+aXpeW/l+OAglxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZXZlcnNlUHJvbXB0T3V0cHV0KHRleHQsIHB1cnBvc2UpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCk7XG4gICAgICAgIGNvbnN0IGZlbmNlZCA9IC9eYGBgKD86anNvbik/XFxzKlxcbihbXFxzXFxTXSo/KVxcbmBgYCQvaS5leGVjKHRyaW1tZWQpO1xuICAgICAgICBjb25zdCByZXN1bHQgPSByZXZlcnNlUHJvbXB0UmVzdWx0U2NoZW1hLnBhcnNlKEpTT04ucGFyc2UoZmVuY2VkPy5bMV0gPz8gdHJpbW1lZCkpO1xuICAgICAgICBpZiAocHVycG9zZSA9PT0gJ3ZpZGVvX3JlY3JlYXRpb24nKVxuICAgICAgICAgICAgcGFyc2VWaWRlb1JlY3JlYXRpb25UZW1wbGF0ZShyZXN1bHQucHJvbXB0KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG4gICAgY2F0Y2gge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WPjeaOqOe7k+aenOagvOW8j+aXoOaViO+8muaooeWei+W/hemhu+i/lOWbnuWMheWQqyBzdW1tYXJ5IOWSjCBwcm9tcHQg55qEIEpTT04g5a+56LGhJyk7XG4gICAgfVxufVxuLyoqIOWGu+e7k+aJp+ihjOi+k+WFpeS4juWbvuWFs+ezu++8m+S/neeVmeacquaJp+ihjOiNieeov++8jOS9huaJp+ihjOebruagh+WPiuWQr+eUqOS4iua4uOmhu+WFiOe7keWumuWujOaVtOadpea6kOOAgiAqL1xuZXhwb3J0IGNvbnN0IHJ1blNuYXBzaG90U2NoZW1hID0gelxuICAgIC5vYmplY3Qoe1xuICAgIHByb2plY3RJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgY2FudmFzUmV2aXNpb246IHoubnVtYmVyKCkuaW50KCkubm9ubmVnYXRpdmUoKSxcbiAgICB0YXJnZXROb2RlSWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIG1vZGVsQWxpYXM6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIGNyZWRlbnRpYWxJZDogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBjcmVkZW50aWFsVmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLm9wdGlvbmFsKCksXG4gICAgLyoqXG4gICAgICogSW1tdXRhYmxlIGNyZWRlbnRpYWwgcmVmZXJlbmNlIGZvciBlYWNoIHByb3ZpZGVyLWJhY2tlZCB3b3JrZmxvdyBub2RlLlxuICAgICAqIE9taXR0ZWQgbGVnYWN5IHNuYXBzaG90cyBjb250aW51ZSB0byB1c2UgdGhlIHJvb3QgY3JlZGVudGlhbCByZWZlcmVuY2UuXG4gICAgICovXG4gICAgbm9kZUNyZWRlbnRpYWxSZWZlcmVuY2VzOiB6LnJlY29yZChydW5DcmVkZW50aWFsUmVmZXJlbmNlU2NoZW1hKS5vcHRpb25hbCgpLFxuICAgIC8qKiBOZXcgQVBJIOacrOS6uuWIhue7hOeahOaMgeS5heaOiOadg+W/q+eFp++8jOeUsSBBUEkg5Ya757uT5bm255SxIFdvcmtlciDlpI3moLjjgIIgKi9cbiAgICBleGVjdXRpb25CaW5kaW5nczogei5yZWNvcmQocnVuRXhlY3V0aW9uQmluZGluZ1NjaGVtYSkub3B0aW9uYWwoKSxcbiAgICBwYXJhbWV0ZXJzOiB6LnJlY29yZCh6LnVua25vd24oKSksXG4gICAgc3VibWl0dGVkQXQ6IHouc3RyaW5nKCkuZGF0ZXRpbWUoKSxcbiAgICBub2Rlczogei5hcnJheShjYW52YXNOb2RlU2NoZW1hKS5taW4oMSksXG4gICAgZWRnZXM6IHouYXJyYXkoY2FudmFzRWRnZVNjaGVtYSksXG4gICAgaW5wdXRzOiB6LmFycmF5KHJ1bklucHV0U25hcHNob3RTY2hlbWEpLFxuICAgIC8qKiDmjInoioLngrnkv53lrZjlt7Llhrvnu5PnmoTlhoXogZTmj5Dlj4rvvJvml6flv6vnhaflj6/nnIHnlaXor6XlrZfmrrXjgIIgKi9cbiAgICBwcm9tcHRNZW50aW9uczogei5hcnJheShmcm96ZW5Qcm9tcHRNZW50aW9uU2NoZW1hKS5vcHRpb25hbCgpLFxuICAgIC8qKiDov5DooYznm67moIfnmoTlm77niYfnvJbovpHpmZDliLbvvIzlhbzlrrnmnKrmjInoioLngrnlrZjlgqjog73lipvnmoTml6flv6vnhafjgIIgKi9cbiAgICBpbWFnZUVkaXRDYXBhYmlsaXR5OiBmcm96ZW5JbWFnZUVkaXRDYXBhYmlsaXR5U2NoZW1hLm9wdGlvbmFsKCksXG4gICAgLyoqIOaMieaJp+ihjOiKgueCueWGu+e7k+eahOWbvueJh+e8lui+kemZkOWItu+8jOmBv+WFjeS4jeWQjOaooeWei+eahOi+k+WFpee6puadn+ebuOS6kuimhuebluOAgiAqL1xuICAgIG5vZGVJbWFnZUVkaXRDYXBhYmlsaXRpZXM6IHoucmVjb3JkKGZyb3plbkltYWdlRWRpdENhcGFiaWxpdHlTY2hlbWEpLm9wdGlvbmFsKCksXG4gICAgLyoqIOeLrOeri+WPjeaOqOS7u+WKoeagh+iusO+8m+e8uuecgeS/neaMgeaZrumAmueUn+aIkOWSjOW9kuaho+ihjOS4uu+8jOS4jeS8oOWFpeS+m+W6lOWVhuWPguaVsOOAgiAqL1xuICAgIHJldmVyc2VQcm9tcHQ6IHJldmVyc2VQcm9tcHRTb3VyY2VTY2hlbWEub3B0aW9uYWwoKSxcbiAgICAvKiog54us56uLIFNraWxsIOS8mOWMlueahOadpea6kOS4jueJiOacrO+8m+WGu+e7k+WOn+Wni+aWh+aho+eUqOS6juaBouWkjei1hOa6kOaPkOWPiuOAgiAqL1xuICAgIHByb21wdE9wdGltaXphdGlvbjogelxuICAgICAgICAub2JqZWN0KHtcbiAgICAgICAgbm9kZUlkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICAgICAgc2tpbGxJZDogei5zdHJpbmcoKS5taW4oMSkubWF4KDgwKSxcbiAgICAgICAgc2tpbGxWZXJzaW9uOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICAgICAgLyoqIOWGu+e7k+WunumZheaJp+ihjOeahOaKgOiDveinhOWIme+8m+WQjue7ree8lui+keaIluWIoOmZpOS4jeaUueWPmOWOhuWPsuS7u+WKoeOAgiAqL1xuICAgICAgICBpbnN0cnVjdGlvbjogei5zdHJpbmcoKS5taW4oMSkubWF4KDEyXzAwMCkub3B0aW9uYWwoKSxcbiAgICAgICAgaW5wdXQ6IHByb21wdERvY3VtZW50U2NoZW1hLFxuICAgIH0pXG4gICAgICAgIC5vcHRpb25hbCgpLFxufSlcbiAgICAuc3VwZXJSZWZpbmUoKHNuYXBzaG90LCBjb250ZXh0KSA9PiB7XG4gICAgLy8gUnVuIHNuYXBzaG90cyBjYW4gY29tZSBmcm9tIGEgcGVyc2lzdGVkIHF1ZXVlIHBheWxvYWQgb3IgYSB3b3JrZXJcbiAgICAvLyByZXN0YXJ0LCBzbyB2YWxpZGF0ZSB0aGUgZ3JhcGggYWdhaW4gaW5zdGVhZCBvZiB0cnVzdGluZyB0aGUgQVBJJ3NcbiAgICAvLyBlYXJsaWVyIGNhbnZhcyB2YWxpZGF0aW9uLiBUaGlzIHByZXZlbnRzIG1hbGZvcm1lZCBlZGdlcyBvciBjeWNsZXMgZnJvbVxuICAgIC8vIHJlYWNoaW5nIGEgcHJvdmlkZXIgd2hlbiBhIHF1ZXVlL2RhdGFiYXNlIGJvdW5kYXJ5IGlzIGNvbXByb21pc2VkLlxuICAgIGNvbnN0IGRvY3VtZW50UmVzdWx0ID0gY2FudmFzRG9jdW1lbnRTY2hlbWEuc2FmZVBhcnNlKHtcbiAgICAgICAgcmV2aXNpb246IHNuYXBzaG90LmNhbnZhc1JldmlzaW9uLFxuICAgICAgICBub2Rlczogc25hcHNob3Qubm9kZXMsXG4gICAgICAgIGVkZ2VzOiBzbmFwc2hvdC5lZGdlcyxcbiAgICB9KTtcbiAgICBpZiAoIWRvY3VtZW50UmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgICAgZm9yIChjb25zdCBpc3N1ZSBvZiBkb2N1bWVudFJlc3VsdC5lcnJvci5pc3N1ZXMpIHtcbiAgICAgICAgICAgIGlmIChpc3N1ZS5wYXRoWzBdID09PSAncmV2aXNpb24nKVxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGlzc3VlLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgcGF0aDogaXNzdWUucGF0aCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG5vZGVJZHMgPSBuZXcgU2V0KHNuYXBzaG90Lm5vZGVzLm1hcCgobm9kZSkgPT4gbm9kZS5pZCkpO1xuICAgIC8vIOW/q+eFp+WPr+S/neeVmeacquaJp+ihjOiNieeov++8m+ebruagh+WPiuWQr+eUqOS4iua4uOS4jeiDveWwhuepuuadpea6kOaPkOS6pOe7mSBQcm92aWRlcuOAglxuICAgIGlmIChzbmFwc2hvdC5ub2Rlcy5zb21lKChub2RlKSA9PiBub2RlLmRhdGEudmlkZW9SZWNyZWF0aW9uRHJhZnQpKSB7XG4gICAgICAgIGNvbnN0IG5vZGVzQnlJZCA9IG5ldyBNYXAoc25hcHNob3Qubm9kZXMubWFwKChub2RlKSA9PiBbbm9kZS5pZCwgbm9kZV0pKTtcbiAgICAgICAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQoKTtcbiAgICAgICAgY29uc3QgcGVuZGluZyA9IFtzbmFwc2hvdC50YXJnZXROb2RlSWRdO1xuICAgICAgICB3aGlsZSAocGVuZGluZy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBub2RlSWQgPSBwZW5kaW5nLnBvcCgpO1xuICAgICAgICAgICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGVJZCkpXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB2aXNpdGVkLmFkZChub2RlSWQpO1xuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IG5vZGVzQnlJZC5nZXQobm9kZUlkKTtcbiAgICAgICAgICAgIGlmICghbm9kZSB8fCAobm9kZS5pZCAhPT0gc25hcHNob3QudGFyZ2V0Tm9kZUlkICYmIG5vZGUuZGF0YS5lbmFibGVkID09PSBmYWxzZSkpXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICBpZiAobm9kZS5kYXRhLnZpZGVvUmVjcmVhdGlvbkRyYWZ0KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogJ+ivt+WFiOmAieaLqeaIluS4iuS8oOWujOaVtOWPguiAg+inhumike+8jOWGjeWIhuaekOaIlueUn+aIkOWkjeWIu+inhumikScsXG4gICAgICAgICAgICAgICAgICAgIHBhdGg6IFsnbm9kZXMnLCBzbmFwc2hvdC5ub2Rlcy5pbmRleE9mKG5vZGUpLCAnZGF0YScsICd2aWRlb1JlY3JlYXRpb25EcmFmdCddLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm9yIChjb25zdCBlZGdlIG9mIHNuYXBzaG90LmVkZ2VzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVkZ2UudGFyZ2V0Tm9kZUlkID09PSBub2RlSWQpXG4gICAgICAgICAgICAgICAgICAgIHBlbmRpbmcucHVzaChlZGdlLnNvdXJjZU5vZGVJZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKHNuYXBzaG90LnByb21wdE9wdGltaXphdGlvbikge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBzbmFwc2hvdC5ub2Rlc1swXTtcbiAgICAgICAgaWYgKHNuYXBzaG90LnJldmVyc2VQcm9tcHQgfHxcbiAgICAgICAgICAgIHNuYXBzaG90Lm5vZGVzLmxlbmd0aCAhPT0gMSB8fFxuICAgICAgICAgICAgc25hcHNob3QuZWRnZXMubGVuZ3RoICE9PSAwIHx8XG4gICAgICAgICAgICBzbmFwc2hvdC5pbnB1dHMubGVuZ3RoICE9PSAwIHx8XG4gICAgICAgICAgICAoc25hcHNob3QucHJvbXB0TWVudGlvbnMgPz8gW10pLnNvbWUoKG1lbnRpb24pID0+IG1lbnRpb24ubm9kZUlkICE9PSB1bmRlZmluZWQgJiYgbWVudGlvbi5ub2RlSWQgIT09IHRhcmdldD8uaWQpIHx8XG4gICAgICAgICAgICB0YXJnZXQ/LmlkICE9PSAncHJvbXB0X3NraWxsX29wdGltaXphdGlvbicgfHxcbiAgICAgICAgICAgIHNuYXBzaG90LnRhcmdldE5vZGVJZCAhPT0gdGFyZ2V0LmlkIHx8XG4gICAgICAgICAgICB0YXJnZXQuZGF0YS5tZWRpYVR5cGUgIT09ICd0ZXh0JyB8fFxuICAgICAgICAgICAgdGFyZ2V0LmRhdGEubW9kZSAhPT0gJ2dlbmVyYXRlJykge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICdTa2lsbCDkvJjljJblv4XpobvmmK/ml6DlqpLkvZPovpPlh7rnmoTni6znq4vmloflrZfku7vliqEnLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsncHJvbXB0T3B0aW1pemF0aW9uJ10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoc25hcHNob3QucmV2ZXJzZVByb21wdCkge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBzbmFwc2hvdC5ub2Rlcy5maW5kKChub2RlKSA9PiBub2RlLmlkID09PSBzbmFwc2hvdC50YXJnZXROb2RlSWQpO1xuICAgICAgICBjb25zdCBtZW50aW9uID0gc25hcHNob3QucHJvbXB0TWVudGlvbnM/LlswXTtcbiAgICAgICAgaWYgKHNuYXBzaG90Lm5vZGVzLmxlbmd0aCAhPT0gMSB8fFxuICAgICAgICAgICAgc25hcHNob3QuZWRnZXMubGVuZ3RoICE9PSAwIHx8XG4gICAgICAgICAgICBzbmFwc2hvdC5pbnB1dHMubGVuZ3RoICE9PSAwIHx8XG4gICAgICAgICAgICB0YXJnZXQ/LmRhdGEubWVkaWFUeXBlICE9PSAndGV4dCcgfHxcbiAgICAgICAgICAgIHRhcmdldC5kYXRhLm1vZGUgIT09ICdnZW5lcmF0ZScgfHxcbiAgICAgICAgICAgIHNuYXBzaG90LnByb21wdE1lbnRpb25zPy5sZW5ndGggIT09IDEgfHxcbiAgICAgICAgICAgIG1lbnRpb24/LmFzc2V0SWQgIT09IHNuYXBzaG90LnJldmVyc2VQcm9tcHQuYXNzZXRJZCB8fFxuICAgICAgICAgICAgbWVudGlvbi5hc3NldFZlcnNpb24gIT09IHNuYXBzaG90LnJldmVyc2VQcm9tcHQuYXNzZXRWZXJzaW9uKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ+WPjeaOqOS7u+WKoeW/hemhu+aYr+W8leeUqOaMh+Wumui1hOa6kOeJiOacrOeahOeLrOeri+aWh+Wtl+WIhuaekCcsXG4gICAgICAgICAgICAgICAgcGF0aDogWydyZXZlcnNlUHJvbXB0J10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5vZGVJZCBvZiBPYmplY3Qua2V5cyhzbmFwc2hvdC5ub2RlSW1hZ2VFZGl0Q2FwYWJpbGl0aWVzID8/IHt9KSkge1xuICAgICAgICBjb25zdCBub2RlID0gc25hcHNob3Qubm9kZXMuZmluZCgoY2FuZGlkYXRlKSA9PiBjYW5kaWRhdGUuaWQgPT09IG5vZGVJZCk7XG4gICAgICAgIGlmICghbm9kZSB8fCBub2RlLmRhdGEubWVkaWFUeXBlICE9PSAnaW1hZ2UnIHx8IG5vZGUuZGF0YS5tb2RlICE9PSAnZ2VuZXJhdGUnKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ+WbvueJh+e8lui+kemZkOWItuW/hemhu+WFs+iBlOW/q+eFp+S4reeahOWbvueJh+eUn+aIkOiKgueCuScsXG4gICAgICAgICAgICAgICAgcGF0aDogWydub2RlSW1hZ2VFZGl0Q2FwYWJpbGl0aWVzJywgbm9kZUlkXSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgW25vZGVJZCwgcmVmZXJlbmNlXSBvZiBPYmplY3QuZW50cmllcyhzbmFwc2hvdC5ub2RlQ3JlZGVudGlhbFJlZmVyZW5jZXMgPz8ge30pKSB7XG4gICAgICAgIGlmICghbm9kZUlkcy5oYXMobm9kZUlkKSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICdub2RlIGNyZWRlbnRpYWwgcmVmZXJlbmNlcyBhIG1pc3Npbmcgbm9kZScsXG4gICAgICAgICAgICAgICAgcGF0aDogWydub2RlQ3JlZGVudGlhbFJlZmVyZW5jZXMnLCBub2RlSWRdLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG5vZGVJZCA9PT0gc25hcHNob3QudGFyZ2V0Tm9kZUlkICYmXG4gICAgICAgICAgICAoKHNuYXBzaG90LmNyZWRlbnRpYWxJZCAmJiBzbmFwc2hvdC5jcmVkZW50aWFsSWQgIT09IHJlZmVyZW5jZS5jcmVkZW50aWFsSWQpIHx8XG4gICAgICAgICAgICAgICAgKHNuYXBzaG90LmNyZWRlbnRpYWxWZXJzaW9uICYmXG4gICAgICAgICAgICAgICAgICAgIHNuYXBzaG90LmNyZWRlbnRpYWxWZXJzaW9uICE9PSByZWZlcmVuY2UuY3JlZGVudGlhbFZlcnNpb24pKSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICd0YXJnZXQgY3JlZGVudGlhbCByZWZlcmVuY2UgZG9lcyBub3QgbWF0Y2ggdGhlIHJ1biBjcmVkZW50aWFsJyxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ25vZGVDcmVkZW50aWFsUmVmZXJlbmNlcycsIG5vZGVJZF0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBzbmFwc2hvdC5pbnB1dHMuZm9yRWFjaCgoaW5wdXQsIGluZGV4KSA9PiB7XG4gICAgICAgIGlmICghbm9kZUlkcy5oYXMoaW5wdXQubm9kZUlkKSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICdydW4gaW5wdXQgcmVmZXJlbmNlcyBhIG1pc3Npbmcgbm9kZScsXG4gICAgICAgICAgICAgICAgcGF0aDogWydpbnB1dHMnLCBpbmRleCwgJ25vZGVJZCddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlucHV0LnNuYXBzaG90LmlkICE9PSBpbnB1dC5ub2RlSWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAncnVuIGlucHV0IHNuYXBzaG90IGlkIGRvZXMgbm90IG1hdGNoIG5vZGVJZCcsXG4gICAgICAgICAgICAgICAgcGF0aDogWydpbnB1dHMnLCBpbmRleCwgJ3NuYXBzaG90JywgJ2lkJ10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IG1lbnRpb25LZXlzID0gbmV3IFNldCgpO1xuICAgIGNvbnN0IGxhc3RNZW50aW9uT3JkZXJCeU5vZGUgPSBuZXcgTWFwKCk7XG4gICAgc25hcHNob3QucHJvbXB0TWVudGlvbnM/LmZvckVhY2goKG1lbnRpb24sIGluZGV4KSA9PiB7XG4gICAgICAgIGlmIChtZW50aW9uLm5vZGVJZCAmJiAhbm9kZUlkcy5oYXMobWVudGlvbi5ub2RlSWQpKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ3Byb21wdCBtZW50aW9uIHJlZmVyZW5jZXMgYSBtaXNzaW5nIHNuYXBzaG90IG5vZGUnLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsncHJvbXB0TWVudGlvbnMnLCBpbmRleCwgJ25vZGVJZCddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qga2V5ID0gYCR7bWVudGlvbi5ub2RlSWQgPz8gJyd9XFwwJHttZW50aW9uLm1lbnRpb25JZH1gO1xuICAgICAgICBpZiAobWVudGlvbktleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBgZHVwbGljYXRlIGZyb3plbiBwcm9tcHQgbWVudGlvbjogJHttZW50aW9uLm1lbnRpb25JZH1gLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsncHJvbXB0TWVudGlvbnMnLCBpbmRleCwgJ21lbnRpb25JZCddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgbWVudGlvbktleXMuYWRkKGtleSk7XG4gICAgICAgIGNvbnN0IG9yZGVyTm9kZUlkID0gbWVudGlvbi5ub2RlSWQgPz8gc25hcHNob3QudGFyZ2V0Tm9kZUlkO1xuICAgICAgICBjb25zdCBwcmV2aW91c09yZGVyID0gbGFzdE1lbnRpb25PcmRlckJ5Tm9kZS5nZXQob3JkZXJOb2RlSWQpO1xuICAgICAgICBpZiAocHJldmlvdXNPcmRlciAhPT0gdW5kZWZpbmVkICYmIG1lbnRpb24uYmxvY2tPcmRlciA8IHByZXZpb3VzT3JkZXIpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAnZnJvemVuIHByb21wdCBtZW50aW9ucyBtdXN0IGJlIG9yZGVyZWQgYnkgYmxvY2tPcmRlciBwZXIgbm9kZScsXG4gICAgICAgICAgICAgICAgcGF0aDogWydwcm9tcHRNZW50aW9ucycsIGluZGV4LCAnYmxvY2tPcmRlciddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgbGFzdE1lbnRpb25PcmRlckJ5Tm9kZS5zZXQob3JkZXJOb2RlSWQsIG1lbnRpb24uYmxvY2tPcmRlcik7XG4gICAgfSk7XG4gICAgaWYgKCFzbmFwc2hvdC5ub2Rlcy5zb21lKChub2RlKSA9PiBub2RlLmlkID09PSBzbmFwc2hvdC50YXJnZXROb2RlSWQpKSB7XG4gICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgbWVzc2FnZTogJ3J1biB0YXJnZXQgbm9kZSBpcyBtaXNzaW5nIGZyb20gc25hcHNob3QnLFxuICAgICAgICAgICAgcGF0aDogWyd0YXJnZXROb2RlSWQnXSxcbiAgICAgICAgfSk7XG4gICAgfVxufSk7XG4vKipcbiAqIFJldHVybnMgdGhlIGNhbm9uaWNhbCBKU09OIGlkZW50aXR5IGZvciBhbiBpbW11dGFibGUgcnVuIHNuYXBzaG90LlxuICogU3VibWlzc2lvbiB0aW1lIGlzIGV4ZWN1dGlvbiBtZXRhZGF0YSByYXRoZXIgdGhhbiByZXF1ZXN0IGlkZW50aXR5LCBzbyBpdFxuICogaXMgZGVsaWJlcmF0ZWx5IGV4Y2x1ZGVkLiBPYmplY3Qga2V5cyBhcmUgc29ydGVkIHJlY3Vyc2l2ZWx5IHdoaWxlIGFycmF5XG4gKiBvcmRlciByZW1haW5zIHNpZ25pZmljYW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2Fub25pY2FsUnVuU25hcHNob3RKc29uKHNuYXBzaG90KSB7XG4gICAgY29uc3QgeyBzdWJtaXR0ZWRBdDogX3N1Ym1pdHRlZEF0LCAuLi5zdGFibGVTbmFwc2hvdCB9ID0gcnVuU25hcHNob3RTY2hlbWEucGFyc2Uoc25hcHNob3QpO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShjYW5vbmljYWxKc29uVmFsdWUoc3RhYmxlU25hcHNob3QpKTtcbn1cbi8qKlxuICogUmV0dXJucyB0aGUgdmVyc2lvbmVkIG1hdGVyaWFsIGhhc2hlZCBieSBBUEkgYW5kIFdvcmtlciBydW4gaWRlbnRpdHkgY2hlY2tzLlxuICogS2VlcGluZyB0aGUgbmFtZXNwYWNlIGJlc2lkZSB0aGUgY2Fub25pY2FsaXplciBwcmV2ZW50cyB0aGUgdHdvIHByb2Nlc3Nlc1xuICogZnJvbSBzaWxlbnRseSBkcmlmdGluZyB0byBkaWZmZXJlbnQgZGlnZXN0IGlucHV0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1blNuYXBzaG90RmluZ2VycHJpbnRNYXRlcmlhbChzbmFwc2hvdCkge1xuICAgIHJldHVybiBgbXVsdGltb2RhbC1jYW52YXM6cnVuLXNuYXBzaG90OnYyOiR7Y2Fub25pY2FsUnVuU25hcHNob3RKc29uKHNuYXBzaG90KX1gO1xufVxuZnVuY3Rpb24gY2Fub25pY2FsSnNvblZhbHVlKHZhbHVlKSB7XG4gICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJylcbiAgICAgICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IG51bGw7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZS5tYXAoKGl0ZW0pID0+IChpdGVtID09PSB1bmRlZmluZWQgPyBudWxsIDogY2Fub25pY2FsSnNvblZhbHVlKGl0ZW0pKSk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXModmFsdWUpXG4gICAgICAgIC5maWx0ZXIoKFssIGl0ZW1dKSA9PiBpdGVtICE9PSB1bmRlZmluZWQpXG4gICAgICAgIC5zb3J0KChbbGVmdF0sIFtyaWdodF0pID0+IChsZWZ0IDwgcmlnaHQgPyAtMSA6IGxlZnQgPiByaWdodCA/IDEgOiAwKSlcbiAgICAgICAgLm1hcCgoW2tleSwgaXRlbV0pID0+IFtrZXksIGNhbm9uaWNhbEpzb25WYWx1ZShpdGVtKV0pKTtcbn1cbmV4cG9ydCBjb25zdCB2aWRlb0ZpbmFsRnJhbWVTdGF0dXNlcyA9IFtcbiAgICAnc2tpcHBlZCcsXG4gICAgJ3BlbmRpbmcnLFxuICAgICdwcm9jZXNzaW5nJyxcbiAgICAncmVhZHknLFxuICAgICdmYWlsZWQnLFxuICAgICdjb25mbGljdCcsXG5dO1xuZXhwb3J0IGNvbnN0IHZpZGVvRmluYWxGcmFtZVN0YXR1c1NjaGVtYSA9IHouZW51bSh2aWRlb0ZpbmFsRnJhbWVTdGF0dXNlcyk7XG5leHBvcnQgY29uc3QgcnVuUmVzdWx0RmluYWxGcmFtZVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBzdGF0dXM6IHZpZGVvRmluYWxGcmFtZVN0YXR1c1NjaGVtYSxcbiAgICBhY3Rpb246IHZpZGVvQ29tcGxldGlvbkFjdGlvblNjaGVtYSxcbiAgICBhY3Rpb25JZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgcG9saWN5VmVyc2lvbjogei5udW1iZXIoKS5pbnQoKS5wb3NpdGl2ZSgpLFxuICAgIHByZXZpZXdVcmw6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgYXNzZXRJZDogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBhc3NldFZlcnNpb246IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKS5vcHRpb25hbCgpLFxuICAgIG5vZGVJZDogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBlcnJvckNvZGU6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgbWVzc2FnZTogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbn0pO1xuZXhwb3J0IGNvbnN0IHJ1blJlc3VsdFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBwcm92aWRlcjogei5zdHJpbmcoKS5taW4oMSksXG4gICAgc3VtbWFyeTogei5zdHJpbmcoKS5taW4oMSksXG4gICAgdGFyZ2V0Tm9kZUlkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICBtZWRpYVR5cGU6IG1lZGlhVHlwZVNjaGVtYSxcbiAgICBpbnB1dENvdW50OiB6Lm51bWJlcigpLmludCgpLm5vbm5lZ2F0aXZlKCksXG4gICAgLyoqIOaYjuehruagh+iusOe7k+aenOadpeiHquS4jeivgeaYjuecn+WunuS+m+W6lOWVhuiDveWKm+eahCBNb2NrL+mihOiniOi3r+W+hOOAgiAqL1xuICAgIHNpbXVsYXRlZDogei5ib29sZWFuKCkub3B0aW9uYWwoKSxcbiAgICBhc3NldDogcnVuUmVzdWx0QXNzZXRTY2hlbWEub3B0aW9uYWwoKSxcbiAgICBwcm92aWRlckpvYjogcHJvdmlkZXJKb2JTY2hlbWEub3B0aW9uYWwoKSxcbiAgICAvKiogTW9jay/pooTop4jlj6/lm57mmL7lt7Lop6PmnpDnmoTlhrvnu5Pmj5Dlj4rvvJvkuI3ljIXlkKvlqpLkvZPlhoXlrrnmiJbkuLTml7YgVVJM44CCICovXG4gICAgcHJvbXB0TWVudGlvbnM6IHouYXJyYXkoZnJvemVuUHJvbXB0TWVudGlvblNjaGVtYSkub3B0aW9uYWwoKSxcbiAgICAvKiog6KeG6aKR5pyr5bin5rS+55Sf57uT5p6c44CC57y655yB6KGo56S65pyq5omn6KGM5oiW5Yqo5L2c5Li6IG5vbmXjgILlpLHotKXkuI3lvpflkKblrprop4bpopHmiJDlip/jgIIgKi9cbiAgICBmaW5hbEZyYW1lOiBydW5SZXN1bHRGaW5hbEZyYW1lU2NoZW1hLm9wdGlvbmFsKCksXG4gICAgLyoqIOeLrOeri+WPjeaOqOeahOe7k+aehOWMlue7k+aenO+8m+WtmOWFpSBSdW7vvIzkuI3liJvlu7rotYTmupDniYjmnKzmiJblhpLlhYXnnJ/lrp7mj5DnpLror43jgIIgKi9cbiAgICByZXZlcnNlUHJvbXB0OiByZXZlcnNlUHJvbXB0UmVzdWx0U2NoZW1hLm9wdGlvbmFsKCksXG4gICAgLyoqIFNraWxsIOS8mOWMluWPquS/neWtmOWAmemAieaPkOekuuivje+8jOS4jeWIm+W7uuWbvueJh+OAgeaWh+acrOi1hOS6p+aIluimhueblueUqOaIt+iKgueCueOAgiAqL1xuICAgIHByb21wdE9wdGltaXphdGlvbjogei5vYmplY3QoeyBwcm9tcHREb2N1bWVudDogcHJvbXB0RG9jdW1lbnRTY2hlbWEgfSkub3B0aW9uYWwoKSxcbn0pO1xuLyoqXG4gKiBEdXJhYmxlIGV4ZWN1dGlvbiBzdGF0ZSBmb3Igb25lIG5vZGUgb2YgdGhlIGltbXV0YWJsZSBydW4gc25hcHNob3QuIFRoZVxuICogc291cmNlIGdyYXBoIGl0c2VsZiByZW1haW5zIGluIGBzbmFwc2hvdGA7IHRoaXMgb25seSByZWNvcmRzIGxpZmVjeWNsZVxuICogZGF0YSBuZWVkZWQgdG8gcmVzdW1lIGEgQnVsbE1RIGpvYiB3aXRob3V0IHJlLXJ1bm5pbmcgY29tcGxldGVkIHdvcmsuXG4gKi9cbmV4cG9ydCBjb25zdCB3b3JrZmxvd05vZGVTdGF0ZVNjaGVtYSA9IHpcbiAgICAub2JqZWN0KHtcbiAgICBub2RlSWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHN0YXR1czogd29ya2Zsb3dOb2RlU3RhdHVzU2NoZW1hLFxuICAgIHByb3ZpZGVySm9iOiBwcm92aWRlckpvYlNjaGVtYS5vcHRpb25hbCgpLFxuICAgIHJlc3VsdDogcnVuUmVzdWx0U2NoZW1hLm9wdGlvbmFsKCksXG59KVxuICAgIC5zdXBlclJlZmluZSgoc3RhdGUsIGNvbnRleHQpID0+IHtcbiAgICBpZiAoc3RhdGUuc3RhdHVzID09PSAnc3VjY2VlZGVkJyAmJiAhc3RhdGUucmVzdWx0KSB7XG4gICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgbWVzc2FnZTogJ3N1Y2NlZWRlZCB3b3JrZmxvdyBub2RlIHJlcXVpcmVzIGEgcmVzdWx0JyxcbiAgICAgICAgICAgIHBhdGg6IFsncmVzdWx0J10sXG4gICAgICAgIH0pO1xuICAgIH1cbn0pO1xuZXhwb3J0IGNvbnN0IHdvcmtmbG93U3RhdGVTY2hlbWEgPSB6XG4gICAgLm9iamVjdCh7XG4gICAgbm9kZXM6IHouYXJyYXkod29ya2Zsb3dOb2RlU3RhdGVTY2hlbWEpLFxufSlcbiAgICAuc3VwZXJSZWZpbmUoKHN0YXRlLCBjb250ZXh0KSA9PiB7XG4gICAgY29uc3Qgbm9kZUlkcyA9IG5ldyBTZXQoKTtcbiAgICBzdGF0ZS5ub2Rlcy5mb3JFYWNoKChub2RlLCBpbmRleCkgPT4ge1xuICAgICAgICBpZiAobm9kZUlkcy5oYXMobm9kZS5ub2RlSWQpKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZElzc3VlKHtcbiAgICAgICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYGR1cGxpY2F0ZSB3b3JrZmxvdyBub2RlIHN0YXRlOiAke25vZGUubm9kZUlkfWAsXG4gICAgICAgICAgICAgICAgcGF0aDogWydub2RlcycsIGluZGV4LCAnbm9kZUlkJ10sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBub2RlSWRzLmFkZChub2RlLm5vZGVJZCk7XG4gICAgfSk7XG59KTtcbmV4cG9ydCBjb25zdCBydW5SZWNvcmRTY2hlbWEgPSB6Lm9iamVjdCh7XG4gICAgaWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHVzZXJJZDogei5zdHJpbmcoKS5taW4oMSkub3B0aW9uYWwoKSxcbiAgICBwcm9qZWN0SWQ6IHouc3RyaW5nKCkubWluKDEpLFxuICAgIHRhcmdldE5vZGVJZDogei5zdHJpbmcoKS5taW4oMSksXG4gICAgc3RhdHVzOiBydW5TdGF0dXNTY2hlbWEsXG4gICAgcHJvZ3Jlc3M6IHoubnVtYmVyKCkuaW50KCkubWluKDApLm1heCgxMDApLFxuICAgIGF0dGVtcHQ6IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICBwcm92aWRlcjogei5zdHJpbmcoKS5taW4oMSksXG4gICAgbW9kZWxBbGlhczogei5zdHJpbmcoKS5taW4oMSksXG4gICAgc25hcHNob3Q6IHJ1blNuYXBzaG90U2NoZW1hLFxuICAgIHJlc3VsdDogcnVuUmVzdWx0U2NoZW1hLm9wdGlvbmFsKCksXG4gICAgcHJvdmlkZXJKb2I6IHByb3ZpZGVySm9iU2NoZW1hLm9wdGlvbmFsKCksXG4gICAgaWRlbXBvdGVuY3lLZXk6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMjAwKS5vcHRpb25hbCgpLFxuICAgIGVycm9yOiB6LnN0cmluZygpLm1pbigxKS5vcHRpb25hbCgpLFxuICAgIHJldHJ5T2Y6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgLyoqXG4gICAgICog5oyJ6IqC54K56K6w5b2V55qE5pys5qyh5omn6KGM55Sf5ZG95ZGo5pyf5pe26Ze044CC5pen6L+Q6KGM6K6w5b2V57y655yB5Li656m677yMXG4gICAgICog55WM6Z2i5pi+56S64oCc5pyq6K6w5b2V4oCd77yM5LiN5qC55o2uIGNyZWF0ZWRBdC91cGRhdGVkQXQg5Y+N5o6o44CCXG4gICAgICovXG4gICAgbm9kZVRpbWluZ3M6IHoucmVjb3JkKG5vZGVUaW1pbmdTY2hlbWEpLm9wdGlvbmFsKCksXG4gICAgY3JlYXRlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCksXG4gICAgdXBkYXRlZEF0OiB6LnN0cmluZygpLmRhdGV0aW1lKCksXG59KTtcbmV4cG9ydCBjb25zdCBydW5Kb2JEYXRhU2NoZW1hID0gelxuICAgIC5vYmplY3Qoe1xuICAgIHJ1bklkOiB6LnN0cmluZygpLm1pbigxKSxcbiAgICB1c2VySWQ6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgc25hcHNob3Q6IHJ1blNuYXBzaG90U2NoZW1hLFxuICAgIGF0dGVtcHQ6IHoubnVtYmVyKCkuaW50KCkucG9zaXRpdmUoKSxcbiAgICBwcm92aWRlcjogei5lbnVtKFsnbW9jaycsICduZXdhcGknXSkuZGVmYXVsdCgnbW9jaycpLFxuICAgIHJldHJ5T2Y6IHouc3RyaW5nKCkubWluKDEpLm9wdGlvbmFsKCksXG4gICAgaWRlbXBvdGVuY3lLZXk6IHouc3RyaW5nKCkudHJpbSgpLm1pbigxKS5tYXgoMjAwKS5vcHRpb25hbCgpLFxuICAgIHByb3ZpZGVySm9iOiBwcm92aWRlckpvYlNjaGVtYS5vcHRpb25hbCgpLFxuICAgIHdvcmtmbG93U3RhdGU6IHdvcmtmbG93U3RhdGVTY2hlbWEub3B0aW9uYWwoKSxcbiAgICBjYW5jZWxSZXF1ZXN0ZWQ6IHouYm9vbGVhbigpLmRlZmF1bHQoZmFsc2UpLFxuICAgIC8qKiDlj6rmn6Xor6Llt7LmnInkuIrmuLjku7vliqHvvIzkuI3lhYHorrjliJvlu7rmlrDnmoQgUHJvdmlkZXIg6K+35rGC44CCICovXG4gICAgcmV0cmlldmVPbmx5OiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxufSlcbiAgICAuc3VwZXJSZWZpbmUoKGpvYiwgY29udGV4dCkgPT4ge1xuICAgIGlmIChqb2Iuc25hcHNob3QucHJvbXB0T3B0aW1pemF0aW9uICYmIChqb2IucmV0cnlPZiB8fCBqb2IuYXR0ZW1wdCAhPT0gMSkpIHtcbiAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICBtZXNzYWdlOiAnU2tpbGwg5LyY5YyW6K+36YCa6L+H5Y6f5o+Q5Lqk6Lqr5Lu95p+l6K+i77yM5LiN6IO95L2/55So5pmu6YCa6L+Q6KGM6YeN6K+VJyxcbiAgICAgICAgICAgIHBhdGg6IFsnYXR0ZW1wdCddLFxuICAgICAgICB9KTtcbiAgICB9XG4gICAgaWYgKGpvYi5zbmFwc2hvdC5yZXZlcnNlUHJvbXB0ICYmIChqb2IucmV0cnlPZiB8fCBqb2IuYXR0ZW1wdCAhPT0gMSkpIHtcbiAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgICAgICBtZXNzYWdlOiAn5Y+N5o6o5Lu75Yqh5Y+q5YWB6K645piO56Gu5paw5bu677yM5LiN6IO96YCa6L+H5pmu6YCa6L+Q6KGM6YeN6K+V5YaN5qyh6LCD55SoJyxcbiAgICAgICAgICAgIHBhdGg6IFsnYXR0ZW1wdCddLFxuICAgICAgICB9KTtcbiAgICB9XG4gICAgY29uc3Qgbm9kZXNCeUlkID0gbmV3IE1hcChqb2Iuc25hcHNob3Qubm9kZXMubWFwKChub2RlKSA9PiBbbm9kZS5pZCwgbm9kZV0pKTtcbiAgICBqb2Iud29ya2Zsb3dTdGF0ZT8ubm9kZXMuZm9yRWFjaCgoc3RhdGUsIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IG5vZGUgPSBub2Rlc0J5SWQuZ2V0KHN0YXRlLm5vZGVJZCk7XG4gICAgICAgIGlmICghbm9kZSkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICd3b3JrZmxvdyBzdGF0ZSByZWZlcmVuY2VzIGEgbWlzc2luZyBzbmFwc2hvdCBub2RlJyxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ3dvcmtmbG93U3RhdGUnLCAnbm9kZXMnLCBpbmRleCwgJ25vZGVJZCddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHN0YXRlLnJlc3VsdD8udGFyZ2V0Tm9kZUlkICE9PSB1bmRlZmluZWQgJiYgc3RhdGUucmVzdWx0LnRhcmdldE5vZGVJZCAhPT0gbm9kZS5pZCkge1xuICAgICAgICAgICAgY29udGV4dC5hZGRJc3N1ZSh7XG4gICAgICAgICAgICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICd3b3JrZmxvdyByZXN1bHQgdGFyZ2V0IGRvZXMgbm90IG1hdGNoIGl0cyBub2RlIHN0YXRlJyxcbiAgICAgICAgICAgICAgICBwYXRoOiBbJ3dvcmtmbG93U3RhdGUnLCAnbm9kZXMnLCBpbmRleCwgJ3Jlc3VsdCcsICd0YXJnZXROb2RlSWQnXSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzdGF0ZS5yZXN1bHQ/Lm1lZGlhVHlwZSAhPT0gdW5kZWZpbmVkICYmIHN0YXRlLnJlc3VsdC5tZWRpYVR5cGUgIT09IG5vZGUuZGF0YS5tZWRpYVR5cGUpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkSXNzdWUoe1xuICAgICAgICAgICAgICAgIGNvZGU6IHouWm9kSXNzdWVDb2RlLmN1c3RvbSxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAnd29ya2Zsb3cgcmVzdWx0IG1lZGlhIHR5cGUgZG9lcyBub3QgbWF0Y2ggaXRzIG5vZGUgc3RhdGUnLFxuICAgICAgICAgICAgICAgIHBhdGg6IFsnd29ya2Zsb3dTdGF0ZScsICdub2RlcycsIGluZGV4LCAncmVzdWx0JywgJ21lZGlhVHlwZSddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9KTtcbn0pO1xuZXhwb3J0IGNvbnN0IHJ1bkpvYlJlc3VsdFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBzdGF0dXM6IHouZW51bShbJ3N1Y2NlZWRlZCcsICdjYW5jZWxsZWQnXSksXG4gICAgcHJvZ3Jlc3M6IHoubnVtYmVyKCkuaW50KCkubWluKDApLm1heCgxMDApLFxuICAgIHJlc3VsdDogcnVuUmVzdWx0U2NoZW1hLm9wdGlvbmFsKCksXG4gICAgcHJvdmlkZXJKb2I6IHByb3ZpZGVySm9iU2NoZW1hLm9wdGlvbmFsKCksXG59KTtcbmNvbnN0IHJ1blN0YXR1c1RyYW5zaXRpb25zID0ge1xuICAgIGRyYWZ0OiBbJ3F1ZXVlZCddLFxuICAgIHF1ZXVlZDogWydwcmVwYXJpbmcnLCAnY2FuY2VsX3JlcXVlc3RlZCcsICdjYW5jZWxsZWQnXSxcbiAgICBwcmVwYXJpbmc6IFsncnVubmluZycsICdjYW5jZWxfcmVxdWVzdGVkJ10sXG4gICAgcnVubmluZzogWydwcm9jZXNzaW5nJywgJ2NhbmNlbF9yZXF1ZXN0ZWQnXSxcbiAgICBwcm9jZXNzaW5nOiBbJ3N1Y2NlZWRlZCcsICdmYWlsZWQnLCAnY2FuY2VsX3JlcXVlc3RlZCddLFxuICAgIHN1Y2NlZWRlZDogW10sXG4gICAgZmFpbGVkOiBbXSxcbiAgICBjYW5jZWxfcmVxdWVzdGVkOiBbJ2NhbmNlbGxlZCddLFxuICAgIGNhbmNlbGxlZDogW10sXG59O1xuZXhwb3J0IGZ1bmN0aW9uIGNhblRyYW5zaXRpb25SdW5TdGF0dXMoZnJvbSwgdG8pIHtcbiAgICByZXR1cm4gZnJvbSA9PT0gdG8gfHwgcnVuU3RhdHVzVHJhbnNpdGlvbnNbZnJvbV0uaW5jbHVkZXModG8pO1xufVxuY29uc3QgdGFyZ2V0Um9sZU1lZGlhVHlwZXMgPSB7XG4gICAgcHJvbXB0OiBbJ3RleHQnXSxcbiAgICBuZWdhdGl2ZVByb21wdDogWyd0ZXh0J10sXG4gICAgY29udGVudDogWyd0ZXh0JywgJ2ltYWdlJywgJ2F1ZGlvJywgJ3ZpZGVvJ10sXG4gICAgc3R5bGU6IFsnaW1hZ2UnXSxcbiAgICBjaGFyYWN0ZXI6IFsnaW1hZ2UnXSxcbiAgICByZWZlcmVuY2VJbWFnZTogWydpbWFnZSddLFxuICAgIGZpcnN0RnJhbWU6IFsnaW1hZ2UnXSxcbiAgICBsYXN0RnJhbWU6IFsnaW1hZ2UnXSxcbiAgICBhdWRpb1RyYWNrOiBbJ2F1ZGlvJ10sXG4gICAgdHJhbnNjcmlwdDogWydhdWRpbyddLFxuICAgIG1hc2s6IFsnaW1hZ2UnXSxcbiAgICBpbWFnZUVkaXQ6IFsnaW1hZ2UnXSxcbn07XG5jb25zdCB0YXJnZXROb2RlUG9ydFJvbGVzID0ge1xuICAgIHRleHQ6IFsncHJvbXB0JywgJ25lZ2F0aXZlUHJvbXB0JywgJ2NvbnRlbnQnLCAndHJhbnNjcmlwdCddLFxuICAgIGltYWdlOiBbXG4gICAgICAgICdwcm9tcHQnLFxuICAgICAgICAnbmVnYXRpdmVQcm9tcHQnLFxuICAgICAgICAnY29udGVudCcsXG4gICAgICAgICdzdHlsZScsXG4gICAgICAgICdjaGFyYWN0ZXInLFxuICAgICAgICAncmVmZXJlbmNlSW1hZ2UnLFxuICAgICAgICAnZmlyc3RGcmFtZScsXG4gICAgICAgICdsYXN0RnJhbWUnLFxuICAgICAgICAnbWFzaycsXG4gICAgICAgIC8vIOaOkuWcqOacgOWQju+8muWPr+ingemUmueCueS7jeaMieWOn+mhuuW6j+WIhumFje+8jOe8lui+keWOn+WbvuWPquWinuWKoOS4gOS4quivreS5iei+k+WFpeWPo+OAglxuICAgICAgICAnaW1hZ2VFZGl0JyxcbiAgICBdLFxuICAgIGF1ZGlvOiBbJ3Byb21wdCcsICduZWdhdGl2ZVByb21wdCcsICdjb250ZW50JywgJ2F1ZGlvVHJhY2snLCAndHJhbnNjcmlwdCddLFxuICAgIHZpZGVvOiBbXG4gICAgICAgICdwcm9tcHQnLFxuICAgICAgICAnbmVnYXRpdmVQcm9tcHQnLFxuICAgICAgICAnY29udGVudCcsXG4gICAgICAgICdzdHlsZScsXG4gICAgICAgICdjaGFyYWN0ZXInLFxuICAgICAgICAncmVmZXJlbmNlSW1hZ2UnLFxuICAgICAgICAnZmlyc3RGcmFtZScsXG4gICAgICAgICdsYXN0RnJhbWUnLFxuICAgICAgICAnYXVkaW9UcmFjaycsXG4gICAgICAgICd0cmFuc2NyaXB0JyxcbiAgICAgICAgJ21hc2snLFxuICAgIF0sXG59O1xuLyoqIFJldHVybnMgdGhlIGlucHV0IHJvbGVzIGV4cG9zZWQgYnkgYSB0YXJnZXQgbm9kZSdzIG1lZGlhIHR5cGUuICovXG5leHBvcnQgZnVuY3Rpb24gdGFyZ2V0UG9ydFJvbGVzRm9yTWVkaWFUeXBlKG1lZGlhVHlwZSkge1xuICAgIHJldHVybiBbLi4udGFyZ2V0Tm9kZVBvcnRSb2xlc1ttZWRpYVR5cGVdXTtcbn1cbi8qKlxuICog5LuO5qih5Z6LIElEIOaOqOaWreinhumikeWutuaXj+OAguacquWRveS4reaXtui/lOWbniB1bmtub3du77yM55yf5a6e5a2X5q615LuNIGZhaWwtY2xvc2Vk44CCXG4gKiBAcGFyYW0gbW9kZWxBbGlhcyDov5DooYzlv6vnhafmiJboioLngrnkuIrnmoTmqKHlnosgSUTjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZpZGVvRmFtaWx5Rm9yTW9kZWwobW9kZWxBbGlhcykge1xuICAgIGNvbnN0IGV4YWN0SWQgPSAobW9kZWxBbGlhcyA/PyAnJykudHJpbSgpO1xuICAgIGlmICghZXhhY3RJZClcbiAgICAgICAgcmV0dXJuICd1bmtub3duJztcbiAgICBpZiAoaW1hZ2UycHJvVmlkZW9Db250cmFjdEZvck1vZGVsKGV4YWN0SWQpKVxuICAgICAgICByZXR1cm4gJ2ltYWdlMnBybyc7XG4gICAgaWYgKHl1YW5saXVWaWRlb0NvbnRyYWN0Rm9yTW9kZWwoZXhhY3RJZCkpXG4gICAgICAgIHJldHVybiAneXVhbmxpdSc7XG4gICAgaWYgKGV4YWN0SWQgPT09ICdtaW5pbWF4LWgzJylcbiAgICAgICAgcmV0dXJuICdtb29uLW1pbmltYXgtaDMnO1xuICAgIGlmIChleGFjdElkID09PSAnTWluaU1heC1IMycpXG4gICAgICAgIHJldHVybiAnbWluaW1heC1oMyc7XG4gICAgY29uc3QgaWQgPSBleGFjdElkLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKGlkLnN0YXJ0c1dpdGgoJ2dyb2staW1hZ2luZS12aWRlby0xLjUnKSlcbiAgICAgICAgcmV0dXJuICdncm9rLWltYWdpbmUtdmlkZW8tMS41JztcbiAgICBpZiAoL15ncm9rWy1fXT9pbWFnaW5lLy50ZXN0KGlkKSlcbiAgICAgICAgcmV0dXJuICdncm9rLWltYWdpbmUtdmlkZW8nO1xuICAgIGlmIChpZCA9PT0gJ3dhbjMuMC12aWRlbycgfHwgaWQgPT09ICd3YW4zLjAtdmlkZW8tcHJpbWUnKVxuICAgICAgICByZXR1cm4gJ3dhbjMnO1xuICAgIGlmIChpZCA9PT0gJ2RvdWJhby1zZWVkYW5jZS0yLTUtMjYwNjI4JylcbiAgICAgICAgcmV0dXJuICdzZWVkYW5jZS0yLjUnO1xuICAgIGlmIChpZCA9PT0gJ2RvdWJhby1zZWVkYW5jZS0yLTAtMjYwMTI4JyB8fFxuICAgICAgICBpZCA9PT0gJ2RvdWJhby1zZWVkYW5jZS0yLTAtZmFzdC0yNjAxMjgnIHx8XG4gICAgICAgIGlkID09PSAnZG91YmFvLXNlZWRhbmNlLTItMC1taW5pLTI2MDYxNScgfHxcbiAgICAgICAgaWQgPT09ICdzZWVkYW5jZS0yLTAtb2ZmaWNpYWwnIHx8XG4gICAgICAgIGlkID09PSAnc2VlZGFuY2UtMi0wLWZhc3Qtb2ZmaWNpYWwnIHx8XG4gICAgICAgIGlkID09PSAnc2VlZGFuY2UtMi0wLW1pbmktb2ZmaWNpYWwnKSB7XG4gICAgICAgIHJldHVybiAnc2VlZGFuY2UtMic7XG4gICAgfVxuICAgIGlmIChpZC5pbmNsdWRlcygnd2FuJykpXG4gICAgICAgIHJldHVybiAnd2FuJztcbiAgICBjb25zdCBtb29uQ29udHJhY3QgPSBtb29uVmlkZW9Db250cmFjdEZvck1vZGVsKGV4YWN0SWQpO1xuICAgIGlmIChtb29uQ29udHJhY3QpXG4gICAgICAgIHJldHVybiBtb29uQ29udHJhY3QuZmFtaWx5O1xuICAgIHJldHVybiAndW5rbm93bic7XG59XG5jb25zdCB0ZXh0VG9WaWRlb1JvbGVzID0gWydwcm9tcHQnXTtcbmNvbnN0IHRleHRUb1ZpZGVvV2l0aE5lZ2F0aXZlUm9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ25lZ2F0aXZlUHJvbXB0Jyxcbl07XG5jb25zdCBmaXJzdEZyYW1lUm9sZXMgPSBbJ3Byb21wdCcsICdmaXJzdEZyYW1lJ107XG5jb25zdCBmaXJzdEZyYW1lV2l0aE5lZ2F0aXZlUm9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ25lZ2F0aXZlUHJvbXB0JyxcbiAgICAnZmlyc3RGcmFtZScsXG5dO1xuY29uc3QgZmlyc3RMYXN0RnJhbWVSb2xlcyA9IFtcbiAgICAncHJvbXB0JyxcbiAgICAnZmlyc3RGcmFtZScsXG4gICAgJ2xhc3RGcmFtZScsXG5dO1xuY29uc3QgZmlyc3RMYXN0RnJhbWVXaXRoTmVnYXRpdmVSb2xlcyA9IFtcbiAgICAncHJvbXB0JyxcbiAgICAnbmVnYXRpdmVQcm9tcHQnLFxuICAgICdmaXJzdEZyYW1lJyxcbiAgICAnbGFzdEZyYW1lJyxcbl07XG5jb25zdCBvbW5pUmVmZXJlbmNlUm9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ3JlZmVyZW5jZUltYWdlJyxcbiAgICAnY29udGVudCcsXG4gICAgJ2F1ZGlvVHJhY2snLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG5dO1xuY29uc3Qgb21uaVJlZmVyZW5jZVdpdGhOZWdhdGl2ZVJvbGVzID0gW1xuICAgICdwcm9tcHQnLFxuICAgICduZWdhdGl2ZVByb21wdCcsXG4gICAgJ3JlZmVyZW5jZUltYWdlJyxcbiAgICAnY29udGVudCcsXG4gICAgJ2F1ZGlvVHJhY2snLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG5dO1xuY29uc3QgZ3Jva09tbmlSZWZlcmVuY2VSb2xlcyA9IFtcbiAgICAncHJvbXB0JyxcbiAgICAncmVmZXJlbmNlSW1hZ2UnLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG5dO1xuY29uc3QgcmVmZXJlbmNlUm9sZU1lZGlhVHlwZXMgPSB7XG4gICAgcmVmZXJlbmNlSW1hZ2U6IFsnaW1hZ2UnXSxcbiAgICBjaGFyYWN0ZXI6IFsnaW1hZ2UnXSxcbiAgICBzdHlsZTogWydpbWFnZSddLFxuICAgIGNvbnRlbnQ6IFsndmlkZW8nXSxcbiAgICBhdWRpb1RyYWNrOiBbJ2F1ZGlvJ10sXG59O1xuY29uc3QgcmVmZXJlbmNlUmVwZWF0YWJsZVJvbGVzID0gW1xuICAgICdyZWZlcmVuY2VJbWFnZScsXG4gICAgJ2NoYXJhY3RlcicsXG4gICAgJ3N0eWxlJyxcbiAgICAnY29udGVudCcsXG4gICAgJ2F1ZGlvVHJhY2snLFxuXTtcbi8qKlxuICog6L+U5Zue5oyH5a6a5qih5byP5Zyo6K+l5qih5Z6L5LiK55qE6IO95Yqb44CC55S75biD5Y+v5oyJIHNlbGVjdGFibGUg5bGV56S677yb55yf5a6e6K+35rGC55yLIGxpdmVQb3N044CCXG4gKiBAcGFyYW0gbW9kZSDoioLngrnkuIrnmoTop4bpopHmqKHlvI/jgIJcbiAqIEBwYXJhbSBtb2RlbEFsaWFzIOi/kOihjOW/q+eFp+aIluiKgueCueS4iueahOaooeWeiyBJROOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gdmlkZW9Nb2RlQ2FwYWJpbGl0eShtb2RlLCBtb2RlbEFsaWFzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2VsZWN0YWJsZTogdHJ1ZSxcbiAgICAgICAgbGl2ZVBvc3Q6IHRydWUsXG4gICAgICAgIHJvbGVzOiB0YXJnZXROb2RlUG9ydFJvbGVzLnZpZGVvLFxuICAgICAgICByZXBlYXRhYmxlUm9sZXM6IHRhcmdldE5vZGVQb3J0Um9sZXMudmlkZW8sXG4gICAgICAgIHJvbGVNZWRpYVR5cGVzOiBPYmplY3QuZnJvbUVudHJpZXMocG9ydFJvbGVzLm1hcCgocm9sZSkgPT4gW3JvbGUsIG1lZGlhVHlwZXNdKSksXG4gICAgfTtcbn1cbi8qKlxuICog6L+U5Zue5p+Q5Liq6KeG6aKR5qih5byP5YWB6K6455qE6L6T5YWl6KeS6Imy44CCXG4gKiBAcGFyYW0gbW9kZSDop4bpopHmqKHlvI/jgIJcbiAqIEBwYXJhbSBtb2RlbEFsaWFzIOWPr+mAieaooeWeiyBJRO+8jOeUqOS6juaUtueqhOWFqOiDveWPguiAg+eahOWqkuS9k+OAglxuICovXG5leHBvcnQgZnVuY3Rpb24gdGFyZ2V0UG9ydFJvbGVzRm9yVmlkZW9Nb2RlKG1vZGUsIG1vZGVsQWxpYXMpIHtcbiAgICByZXR1cm4gWy4uLnZpZGVvTW9kZUNhcGFiaWxpdHkobW9kZSwgbW9kZWxBbGlhcykucm9sZXNdO1xufVxuLyoqXG4gKiDmjInoioLngrnlvZPliY3mqKHlvI/ov5Tlm57lj6/ov57mjqXop5LoibLjgILml6fop4bpopHoioLngrnmsqHmnIkgdmlkZW9Nb2RlIOaXtuS/neaMgeWFqOmHj+err+WPo+OAglxuICogQHBhcmFtIG5vZGUg55uu5qCH55S75biD6IqC54K544CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YXJnZXRQb3J0Um9sZXNGb3JOb2RlKG5vZGUpIHtcbiAgICBpZiAobm9kZS5kYXRhLm1vZGUgPT09ICdzb3VyY2UnKVxuICAgICAgICByZXR1cm4gW107XG4gICAgaWYgKG5vZGUuZGF0YS5tZWRpYVR5cGUgIT09ICd2aWRlbycgfHwgIW5vZGUuZGF0YS52aWRlb01vZGUpIHtcbiAgICAgICAgcmV0dXJuIHRhcmdldFBvcnRSb2xlc0Zvck1lZGlhVHlwZShub2RlLmRhdGEubWVkaWFUeXBlKTtcbiAgICB9XG4gICAgcmV0dXJuIHRhcmdldFBvcnRSb2xlc0ZvclZpZGVvTW9kZShub2RlLmRhdGEudmlkZW9Nb2RlLCBub2RlLmRhdGEubW9kZWxBbGlhcyk7XG59XG4vKipcbiAqIOWIpOaWreivpeaooeW8j+aYr+WQpuW3suWcqOacrOmYtuauteiQveWcsOOAglxuICogQHBhcmFtIG1vZGUg6KeG6aKR5qih5byP44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ltcGxlbWVudGVkVmlkZW9Nb2RlKG1vZGUpIHtcbiAgICByZXR1cm4gaW1wbGVtZW50ZWRWaWRlb01vZGVzLmluY2x1ZGVzKG1vZGUpO1xufVxuLyoqXG4gKiDku47lt7Lov57mjqXop5LoibLmjqjmlq3ml6fnlLvluIPnmoTop4bpopHmqKHlvI/vvIzkvpvpgInmi6nlmajlm57mmL7vvJvkuI3lhpnlhaXoioLngrnjgIJcbiAqIEBwYXJhbSByb2xlcyDlvZPliY3ov57liLDor6XoioLngrnnmoTovpPlhaXop5LoibLjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluZmVyVmlkZW9Nb2RlRnJvbVJvbGVzKHJvbGVzKSB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChyb2xlcyk7XG4gICAgaWYgKHNldC5oYXMoJ2NoYXJhY3RlcicpIHx8XG4gICAgICAgIHNldC5oYXMoJ3N0eWxlJykgfHxcbiAgICAgICAgc2V0LmhhcygncmVmZXJlbmNlSW1hZ2UnKSB8fFxuICAgICAgICBzZXQuaGFzKCdhdWRpb1RyYWNrJykgfHxcbiAgICAgICAgc2V0LmhhcygndHJhbnNjcmlwdCcpIHx8XG4gICAgICAgIHNldC5oYXMoJ21hc2snKSB8fFxuICAgICAgICBzZXQuaGFzKCdjb250ZW50JykpIHtcbiAgICAgICAgcmV0dXJuICdvbW5pX3JlZmVyZW5jZSc7XG4gICAgfVxuICAgIGlmIChzZXQuaGFzKCdsYXN0RnJhbWUnKSlcbiAgICAgICAgcmV0dXJuICdmaXJzdF9sYXN0X2ZyYW1lJztcbiAgICBpZiAoc2V0LmhhcygnZmlyc3RGcmFtZScpKVxuICAgICAgICByZXR1cm4gJ2ZpcnN0X2ZyYW1lJztcbiAgICByZXR1cm4gJ3RleHRfdG9fdmlkZW8nO1xufVxuLyoqXG4gKiDov5Tlm57oioLngrnlupTlsZXnpLrnmoTop4bpopHmqKHlvI/vvJrmmL7lvI/lgLzkvJjlhYjvvIzlkKbliJnmjInov57nur/mjqjmlq3jgIJcbiAqIEBwYXJhbSBkYXRhIOiKgueCuSBkYXRh44CCXG4gKiBAcGFyYW0gY29ubmVjdGVkUm9sZXMg5b2T5YmN6L+e5Yiw6K+l6IqC54K555qE6L6T5YWl6KeS6Imy44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaXNwbGF5VmlkZW9Nb2RlKGRhdGEsIGNvbm5lY3RlZFJvbGVzID0gW10pIHtcbiAgICByZXR1cm4gZGF0YT8udmlkZW9Nb2RlID8/IGluZmVyVmlkZW9Nb2RlRnJvbVJvbGVzKGNvbm5lY3RlZFJvbGVzKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBpc1BvcnRDb25uZWN0aW9uQWxsb3dlZChzb3VyY2UsIHNvdXJjZUhhbmRsZSwgdGFyZ2V0LCB0YXJnZXRIYW5kbGUpIHtcbiAgICAvLyBTb3VyY2Ugbm9kZXMgYXJlIHRlcm1pbmFsIHJlZmVyZW5jZXMuIFRoZXkgZXhwb3NlIGFuIG91dHB1dCBvbmx5IGFuZFxuICAgIC8vIGNhbm5vdCByZWNlaXZlIHdvcmtmbG93IGlucHV0cy5cbiAgICBpZiAodGFyZ2V0LmRhdGEubW9kZSA9PT0gJ3NvdXJjZScpXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBzb3VyY2VNZWRpYVR5cGUgPSBzb3VyY2VIYW5kbGUuc3RhcnRzV2l0aCgnb3V0cHV0OicpXG4gICAgICAgID8gc291cmNlSGFuZGxlLnNsaWNlKCdvdXRwdXQ6Jy5sZW5ndGgpXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHRhcmdldFJvbGUgPSB0YXJnZXRIYW5kbGUuc3RhcnRzV2l0aCgnaW5wdXQ6JylcbiAgICAgICAgPyB0YXJnZXRIYW5kbGUuc2xpY2UoJ2lucHV0OicubGVuZ3RoKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICBpZiAoc291cmNlTWVkaWFUeXBlICE9PSBzb3VyY2UuZGF0YS5tZWRpYVR5cGUgfHwgIXRhcmdldFJvbGUpXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIXBvcnRSb2xlcy5pbmNsdWRlcyh0YXJnZXRSb2xlKSlcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGFsbG93ZWRSb2xlcyA9IHRhcmdldFBvcnRSb2xlc0Zvck5vZGUodGFyZ2V0KTtcbiAgICBpZiAoIWFsbG93ZWRSb2xlcy5pbmNsdWRlcyh0YXJnZXRSb2xlKSlcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIC8vIOe8lui+keWOn+WbvuWPquWxnuS6juWbvueJh+eUn+aIkOiKgueCue+8m+adpea6kOiKgueCuemAmui/hyBtZWRpYVR5cGUg5pS256qE77yMXG4gICAgLy8g5qih5byP5pS256qE6YG/5YWN5oqK57yW6L6R6K+t5LmJ5oyC5Yiw5p2l5rqQ6IqC54K55LiK44CCXG4gICAgaWYgKHRhcmdldFJvbGUgPT09ICdpbWFnZUVkaXQnICYmIHRhcmdldC5kYXRhLm1vZGUgIT09ICdnZW5lcmF0ZScpXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjYXBhYmlsaXR5ID0gdGFyZ2V0LmRhdGEubWVkaWFUeXBlID09PSAndmlkZW8nICYmIHRhcmdldC5kYXRhLnZpZGVvTW9kZVxuICAgICAgICA/IHZpZGVvTW9kZUNhcGFiaWxpdHkodGFyZ2V0LmRhdGEudmlkZW9Nb2RlLCB0YXJnZXQuZGF0YS5tb2RlbEFsaWFzKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhbGxvd2VkTWVkaWEgPSBjYXBhYmlsaXR5Py5yb2xlTWVkaWFUeXBlcz8uW3RhcmdldFJvbGVdID8/XG4gICAgICAgIHRhcmdldFJvbGVNZWRpYVR5cGVzW3RhcmdldFJvbGVdO1xuICAgIHJldHVybiBhbGxvd2VkTWVkaWEuaW5jbHVkZXMoc291cmNlLmRhdGEubWVkaWFUeXBlKTtcbn1cbi8qKiDop4bpopHop4TojIPovpPlhaXkuK3ln7rmlbDkuLogMC4uMSDnmoTop5LoibLjgIIgKi9cbmV4cG9ydCBjb25zdCB2aWRlb1NpbmdsZXRvbklucHV0Um9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ25lZ2F0aXZlUHJvbXB0JyxcbiAgICAnZmlyc3RGcmFtZScsXG4gICAgJ2xhc3RGcmFtZScsXG5dO1xuLyoqIOinhumikeinhOiMg+i+k+WFpeS4reWPr+mHjeWkjeS4lOW/hemhu+S/neW6j+eahOinkuiJsuOAgiAqL1xuZXhwb3J0IGNvbnN0IHZpZGVvUmVwZWF0YWJsZUlucHV0Um9sZXMgPSBbJ2NoYXJhY3RlcicsICdzdHlsZScsICdyZWZlcmVuY2VJbWFnZSddO1xuLyoqIOWbvueJh+iQveWIsOinhumikeiKgueCueS4u+S9k+aXtuWPr+S+m+mAieaLqeeahOinkuiJsuOAguaXp+eUu+W4g+acquWGmSB2aWRlb01vZGUg5pe25LuN5Y+v5by55Ye644CCICovXG5leHBvcnQgY29uc3QgdmlkZW9JbWFnZUlucHV0Um9sZXMgPSBbXG4gICAgJ2ZpcnN0RnJhbWUnLFxuICAgICdsYXN0RnJhbWUnLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG4gICAgJ3JlZmVyZW5jZUltYWdlJyxcbl07XG4vKipcbiAqIOi/lOWbnuW9k+WJjeinhumikeaooeW8j+S4i++8jOWbvueJh+iQveWIsOiKgueCueS4u+S9k+aXtuWPr+mAieeahOinkuiJsuOAglxuICog5pi+5byP5qih5byP5LiN5YaN5oqK6KeS6ImyL+mjjuagvOW9k+aIkOeLrOeri+WFpeWPo++8m+mmluWwvuW4p+WPqumAiemmluW4p+aIluWwvuW4p+OAglxuICogQHBhcmFtIHZpZGVvTW9kZSDoioLngrnkuIrnmoTmmL7lvI/mqKHlvI/vvJvnvLrnnIHooajnpLrml6fnlLvluIPjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZpZGVvSW1hZ2VSb2xlc0Zvck1vZGUodmlkZW9Nb2RlKSB7XG4gICAgaWYgKHZpZGVvTW9kZSA9PT0gJ2ZpcnN0X2ZyYW1lJylcbiAgICAgICAgcmV0dXJuIFsnZmlyc3RGcmFtZSddO1xuICAgIGlmICh2aWRlb01vZGUgPT09ICdmaXJzdF9sYXN0X2ZyYW1lJylcbiAgICAgICAgcmV0dXJuIFsnZmlyc3RGcmFtZScsICdsYXN0RnJhbWUnXTtcbiAgICBpZiAodmlkZW9Nb2RlID09PSAnb21uaV9yZWZlcmVuY2UnIHx8XG4gICAgICAgIHZpZGVvTW9kZSA9PT0gJ3ZpZGVvX2VkaXQnIHx8XG4gICAgICAgIHZpZGVvTW9kZSA9PT0gJ3ZpZGVvX2V4dGVuZCcpIHtcbiAgICAgICAgcmV0dXJuIFsncmVmZXJlbmNlSW1hZ2UnXTtcbiAgICB9XG4gICAgaWYgKHZpZGVvTW9kZSA9PT0gJ3RleHRfdG9fdmlkZW8nKVxuICAgICAgICByZXR1cm4gW107XG4gICAgcmV0dXJuIFsnZmlyc3RGcmFtZScsICdsYXN0RnJhbWUnLCAncmVmZXJlbmNlSW1hZ2UnXTtcbn1cbi8qKlxuICog6L+U5Zue6IqC54K55bey6YCJ5oup55qE6KeG6aKR5qih5byP77yb5o+Q56S66K+N6LWE5rqQ5o+Q5Y+K5LiN5Lya6ZqQ5byP5pS55YaZ55So5oi355qE5qih5byP6YCJ5oup44CCXG4gKiBAcGFyYW0gdmlkZW9Nb2RlIOiKgueCueS4iueahOaYvuW8j+inhumikeaooeW8j+OAglxuICogQHBhcmFtIGhhc1Byb21wdFJlc291cmNlTWVudGlvbnMg5L+d55WZ5YW85a6555qE5o+Q56S66K+N5o+Q5Y+K5Y+C5pWw77yM5LiN5Y+C5LiO5qih5byP5o6o5pat44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2aWRlb01vZGVGb3JQcm9tcHRNZW50aW9ucyh2aWRlb01vZGUsIGhhc1Byb21wdFJlc291cmNlTWVudGlvbnMpIHtcbiAgICB2b2lkIGhhc1Byb21wdFJlc291cmNlTWVudGlvbnM7XG4gICAgcmV0dXJuIHZpZGVvTW9kZTtcbn1cbi8qKlxuICog5o+Q56S66K+N6YeM55qE6LWE5rqQ5o+Q5Y+K5Zyo5b2T5YmN6KeG6aKR5qih5byP5LiL5Y+v5ZC45pS255qE6L6T5YWl6KeS6Imy44CCXG4gKiDlhajog73lj4LogIPjgIHnvJbovpHlkozlu7bplb/miorlm74v6KeG6aKRL+mfs+mikeaUtuaIkOWPguiAg+e0oOadkO+8jOiAjOS4jeaYr+i1sOiBiuWkqeWkmuaooeaAgeaPkOWPiuWQiOWQjOOAglxuICogQHBhcmFtIG1lZGlhVHlwZSDmj5Dlj4rnmoTlqpLkvZPnsbvlnovjgIJcbiAqIEBwYXJhbSB2aWRlb01vZGUg6IqC54K55LiK55qE5pi+5byP6KeG6aKR5qih5byP44CCXG4gKiBAcGFyYW0gbW9kZWxBbGlhcyDnlKjkuo7mjInog73lipvnn6npmLXmlLbnqoQgR3JvayDlj6rmlLblm77niYfnrYnnuqbmnZ/jgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZpZGVvSW5wdXRSb2xlRm9yUHJvbXB0TWVudGlvbihtZWRpYVR5cGUsIHZpZGVvTW9kZSwgbW9kZWxBbGlhcykge1xuICAgIHJldHVybiBtZWRpYVR5cGUgPT09ICdpbWFnZSdcbiAgICAgICAgPyAncmVmZXJlbmNlSW1hZ2UnXG4gICAgICAgIDogbWVkaWFUeXBlID09PSAnYXVkaW8nXG4gICAgICAgICAgICA/ICdhdWRpb1RyYWNrJ1xuICAgICAgICAgICAgOiBtZWRpYVR5cGUgPT09ICd2aWRlbydcbiAgICAgICAgICAgICAgICA/ICdjb250ZW50J1xuICAgICAgICAgICAgICAgIDogJ3Byb21wdCc7XG59XG4vKipcbiAqIOi/lOWbnuinhumikeiKgueCueaPkOekuuivjeS4reS4jeiDveiiq+W9k+WJjeaooeW8j+WQuOaUtuOAgeS7jemcgOWNleeLrOWksei0peeahOi1hOa6kOaPkOWPiuOAglxuICogQHBhcmFtIG5vZGUg55uu5qCH6KeG6aKR6IqC54K555qE5aqS5L2T44CB5qih5byP5ZKM5qih5Z6L44CCXG4gKiBAcGFyYW0gbWVudGlvbnMg6K+l6IqC54K55LiK55qE5Ya757uT6LWE5rqQ5o+Q5Y+K44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmFic29yYmVkVmlkZW9Qcm9tcHRNZW50aW9ucyhub2RlLCBtZW50aW9ucywgbW9kZWxBbGlhcyA9IG5vZGUubW9kZWxBbGlhcykge1xuICAgIGlmIChub2RlLm1lZGlhVHlwZSAhPT0gJ3ZpZGVvJyB8fCBub2RlLm1vZGUgPT09ICdzb3VyY2UnKVxuICAgICAgICByZXR1cm4gWy4uLm1lbnRpb25zXTtcbiAgICByZXR1cm4gbWVudGlvbnMuZmlsdGVyKChtZW50aW9uKSA9PiAhdmlkZW9JbnB1dFJvbGVGb3JQcm9tcHRNZW50aW9uKG1lbnRpb24ubWVkaWFUeXBlLCBub2RlLnZpZGVvTW9kZSwgbW9kZWxBbGlhcykpO1xufVxuLyoqXG4gKiDop4bpopHoioLngrnml6Dms5XlkLjmlLbmj5DnpLror43otYTmupDmj5Dlj4rml7bnmoTor7TmmI7vvIzpgb/lhY3or6/nlKjogYrlpKnmj5Dlj4rog73lipvmlofmoYjjgIJcbiAqIEBwYXJhbSBtZW50aW9uTWVkaWFUeXBlIOaPkOWPiuWqkuS9k+OAglxuICogQHBhcmFtIHZpZGVvTW9kZSDlvZPliY3op4bpopHmqKHlvI/jgIJcbiAqIEBwYXJhbSBtb2RlbEFsaWFzIOaooeWeiyBJROOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gdW5hYnNvcmJlZFZpZGVvUHJvbXB0TWVudGlvbk1lc3NhZ2UobWVudGlvbk1lZGlhVHlwZSwgdmlkZW9Nb2RlLCBtb2RlbEFsaWFzKSB7XG4gICAgaWYgKHZpZGVvTW9kZSA9PT0gJ29tbmlfcmVmZXJlbmNlJyB8fFxuICAgICAgICB2aWRlb01vZGUgPT09ICd2aWRlb19lZGl0JyB8fFxuICAgICAgICB2aWRlb01vZGUgPT09ICd2aWRlb19leHRlbmQnKSB7XG4gICAgICAgIHJldHVybiBg5b2T5YmN6aG555uu5bCa5pyq5o6l6YCa5qih5Z6LICR7bW9kZWxBbGlhcyA/PyAndW5rbm93bi1tb2RlbCd9IOeahCR7dmlkZW9Nb2RlTGFiZWxzW3ZpZGVvTW9kZV19JHttZW50aW9uTWVkaWFUeXBlID09PSAnaW1hZ2UnID8gJ+WbvueJhycgOiBtZW50aW9uTWVkaWFUeXBlID09PSAndmlkZW8nID8gJ+inhumikScgOiBtZW50aW9uTWVkaWFUeXBlID09PSAnYXVkaW8nID8gJ+mfs+mikScgOiBtZW50aW9uTWVkaWFUeXBlfeaPkOWPiuaYoOWwhGA7XG4gICAgfVxuICAgIGNvbnN0IG1vZGVMYWJlbCA9IHZpZGVvTW9kZSA/IHZpZGVvTW9kZUxhYmVsc1t2aWRlb01vZGVdIDogJ+WFqOiDveWPguiAgyc7XG4gICAgcmV0dXJuIGDop4bpopHmqKHlvI/jgIwke21vZGVMYWJlbH3jgI3kuI3og73kvb/nlKjmj5DnpLror43otYTmupDmj5Dlj4rjgILor7fmiorntKDmnZDliqDliLDlvZPliY3oioLngrnnmoTotYTmupDmnaHvvIzmiJbnoa7orqTlt7LpgInmi6nlhajog73lj4LogINgO1xufVxuLyoqIOacquefpeaooeWei+m7mOiupOWPquWFgeiuuCBwcm9tcHQg5ZKM6Iez5aSa5LiA5byg6aaW5bin44CCICovXG5leHBvcnQgY29uc3QgY29uZmlybWVkTGl2ZVZpZGVvSW5wdXRSb2xlcyA9IFsncHJvbXB0JywgJ2ZpcnN0RnJhbWUnXTtcbi8qKiBncm9rLWltYWdpbmUtdmlkZW8tMS41IOWumOaWueWPguiAg+WbvuS4iumZkOOAgiAqL1xuZXhwb3J0IGNvbnN0IEdST0tfSU1BR0lORV9WSURFT18xNV9NQVhfUkVGRVJFTkNFX0lNQUdFUyA9IDc7XG4vKiogZ3Jvay1pbWFnaW5lLXZpZGVvLTEuNSDlt7LmlofmoaPljJbnmoTnnJ/lrp7ovpPlhaXop5LoibLjgIIgKi9cbmV4cG9ydCBjb25zdCBncm9rSW1hZ2luZVZpZGVvMTVJbnB1dFJvbGVzID0gW1xuICAgICdwcm9tcHQnLFxuICAgICdmaXJzdEZyYW1lJyxcbiAgICAnbGFzdEZyYW1lJyxcbiAgICAnY2hhcmFjdGVyJyxcbiAgICAnc3R5bGUnLFxuICAgICdyZWZlcmVuY2VJbWFnZScsXG5dO1xuLyoqIEgz44CBV2FuMyDkuI4gU2VlZGFuY2UgMi54IOW3suehruiupOeahOWPguiAg+i+k+WFpeinkuiJsuOAgiAqL1xuZXhwb3J0IGNvbnN0IHJlZmVyZW5jZVZpZGVvSW5wdXRSb2xlcyA9IFtcbiAgICAncHJvbXB0JyxcbiAgICAnZmlyc3RGcmFtZScsXG4gICAgJ2xhc3RGcmFtZScsXG4gICAgJ2NoYXJhY3RlcicsXG4gICAgJ3N0eWxlJyxcbiAgICAncmVmZXJlbmNlSW1hZ2UnLFxuICAgICdjb250ZW50JyxcbiAgICAnYXVkaW9UcmFjaycsXG5dO1xuLyoqIFdhbjMg5Zyo6YCa55So5Y+C6ICD6KeS6Imy5LmL5aSW6L+Y5pSv5oyB6LSf5ZCR5o+Q56S66K+N44CCICovXG5leHBvcnQgY29uc3Qgd2FuM1ZpZGVvSW5wdXRSb2xlcyA9IFtcbiAgICAuLi5yZWZlcmVuY2VWaWRlb0lucHV0Um9sZXMsXG4gICAgJ25lZ2F0aXZlUHJvbXB0Jyxcbl07XG4vKipcbiAqIOWIpOaWreaooeWei+aYr+WQpuWxnuS6jiBncm9rLWltYWdpbmUtdmlkZW8tMS41IOezu+WIl++8jOWQqyAxLjUuMSDkuI7mjInmrKHliKvlkI3jgIJcbiAqIEBwYXJhbSBtb2RlbEFsaWFzIOi/kOihjOW/q+eFp+S4reeahOaooeWeiyBJROOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNHcm9rSW1hZ2luZVZpZGVvMTUobW9kZWxBbGlhcykge1xuICAgIHJldHVybiB2aWRlb0ZhbWlseUZvck1vZGVsKG1vZGVsQWxpYXMpID09PSAnZ3Jvay1pbWFnaW5lLXZpZGVvLTEuNSc7XG59XG4vKipcbiAqIOi/lOWbnuivpeaooeWei+W9k+WJjeWFgeiuuOWPkeecn+WuniBQT1NUIOeahOi+k+WFpeinkuiJsuOAglxuICogQHBhcmFtIG1vZGVsQWxpYXMg6L+Q6KGM5b+r54Wn5Lit55qE5qih5Z6LIElE44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb25maXJtZWRWaWRlb0lucHV0Um9sZXNGb3JNb2RlbChtb2RlbEFsaWFzKSB7XG4gICAgY29uc3QgeXVhbmxpdUNvbnRyYWN0ID0geXVhbmxpdVZpZGVvQ29udHJhY3RGb3JNb2RlbChtb2RlbEFsaWFzKTtcbiAgICBpZiAoeXVhbmxpdUNvbnRyYWN0KVxuICAgICAgICByZXR1cm4geXVhbmxpdUNvbnRyYWN0LmNvbmZpcm1lZElucHV0Um9sZXM7XG4gICAgY29uc3QgaW1hZ2UycHJvQ29udHJhY3QgPSBpbWFnZTJwcm9WaWRlb0NvbnRyYWN0Rm9yTW9kZWwobW9kZWxBbGlhcyk7XG4gICAgaWYgKGltYWdlMnByb0NvbnRyYWN0KVxuICAgICAgICByZXR1cm4gaW1hZ2UycHJvQ29udHJhY3QuY29uZmlybWVkSW5wdXRSb2xlcztcbiAgICBjb25zdCBtb29uQ29udHJhY3QgPSBtb29uVmlkZW9Db250cmFjdEZvck1vZGVsKG1vZGVsQWxpYXMpO1xuICAgIGlmIChtb29uQ29udHJhY3QpXG4gICAgICAgIHJldHVybiBtb29uQ29udHJhY3QuY29uZmlybWVkSW5wdXRSb2xlcztcbiAgICBjb25zdCBmYW1pbHkgPSB2aWRlb0ZhbWlseUZvck1vZGVsKG1vZGVsQWxpYXMpO1xuICAgIGlmIChmYW1pbHkgPT09ICdncm9rLWltYWdpbmUtdmlkZW8tMS41JylcbiAgICAgICAgcmV0dXJuIGdyb2tJbWFnaW5lVmlkZW8xNUlucHV0Um9sZXM7XG4gICAgaWYgKGZhbWlseSA9PT0gJ3dhbjMnKVxuICAgICAgICByZXR1cm4gd2FuM1ZpZGVvSW5wdXRSb2xlcztcbiAgICBpZiAoZmFtaWx5ID09PSAnbW9vbi1taW5pbWF4LWgzJyB8fFxuICAgICAgICBmYW1pbHkgPT09ICdtaW5pbWF4LWgzJyB8fFxuICAgICAgICBmYW1pbHkgPT09ICdzZWVkYW5jZS0yJyB8fFxuICAgICAgICBmYW1pbHkgPT09ICdzZWVkYW5jZS0yLjUnKSB7XG4gICAgICAgIHJldHVybiByZWZlcmVuY2VWaWRlb0lucHV0Um9sZXM7XG4gICAgfVxuICAgIHJldHVybiBjb25maXJtZWRMaXZlVmlkZW9JbnB1dFJvbGVzO1xufVxuLyoqIOinhumikeeUn+aIkOWcuuaZr+OAgueUqOS6jumihOajgOWSjOaRmOimge+8m+aYvuW8jyB2aWRlb01vZGUg5a2Y5Zyo5pe255Sx5qih5byP5Yaz5a6a77yM5LiN5YaN6Z2g6L+e57q/54yc5rWL44CCICovXG5leHBvcnQgY29uc3QgdmlkZW9PcGVyYXRpb25UeXBlcyA9IFtcbiAgICAndGV4dF90b192aWRlbycsXG4gICAgJ2ltYWdlX3RvX3ZpZGVvJyxcbiAgICAnZmlyc3RfbGFzdF9mcmFtZScsXG4gICAgJ3JlZmVyZW5jZV9ndWlkZWQnLFxuICAgICdvbW5pX3JlZmVyZW5jZScsXG5dO1xuLyoqXG4gKiDmiormmL7lvI/op4bpopHmqKHlvI/mmKDlsITkuLrpooTmo4DmkZjopoHkvb/nlKjnmoTlnLrmma/moIfor4bjgIJcbiAqIEBwYXJhbSBtb2RlIOiKgueCueS4iueahOinhumikeaooeW8j+OAglxuICovXG5leHBvcnQgZnVuY3Rpb24gdmlkZW9Nb2RlVG9PcGVyYXRpb24obW9kZSkge1xuICAgIGlmIChtb2RlID09PSAnZmlyc3RfZnJhbWUnKVxuICAgICAgICByZXR1cm4gJ2ltYWdlX3RvX3ZpZGVvJztcbiAgICBpZiAobW9kZSA9PT0gJ2ZpcnN0X2xhc3RfZnJhbWUnKVxuICAgICAgICByZXR1cm4gJ2ZpcnN0X2xhc3RfZnJhbWUnO1xuICAgIGlmIChtb2RlID09PSAnb21uaV9yZWZlcmVuY2UnIHx8IG1vZGUgPT09ICd2aWRlb19lZGl0JyB8fCBtb2RlID09PSAndmlkZW9fZXh0ZW5kJykge1xuICAgICAgICByZXR1cm4gJ29tbmlfcmVmZXJlbmNlJztcbiAgICB9XG4gICAgcmV0dXJuICd0ZXh0X3RvX3ZpZGVvJztcbn1cbi8qKlxuICog5oyJIHNvcnRPcmRlciDkuI7ljp/lp4vkuIvmoIfnqLPlrprmjpLluo/ov5DooYzovpPlhaXjgIJcbiAqIEBwYXJhbSBpbnB1dHMg5b+r54Wn5Lit55qE6L6T5YWl5YiX6KGo44CCXG4gKiBAcmV0dXJucyDmjpLluo/lkI7nmoTmlrDmlbDnu4TvvIzkuI3kv67mlLnljp/liJfooajjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyZWRSdW5JbnB1dHMoaW5wdXRzKSB7XG4gICAgcmV0dXJuIGlucHV0c1xuICAgICAgICAubWFwKChpbnB1dCwgaW5kZXgpID0+ICh7IGlucHV0LCBpbmRleCB9KSlcbiAgICAgICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0LmlucHV0LnNvcnRPcmRlciAtIHJpZ2h0LmlucHV0LnNvcnRPcmRlciB8fCBsZWZ0LmluZGV4IC0gcmlnaHQuaW5kZXgpXG4gICAgICAgIC5tYXAoKHsgaW5wdXQgfSkgPT4gaW5wdXQpO1xufVxuZnVuY3Rpb24gZW1wdHlWaWRlb0lucHV0U2V0KCkge1xuICAgIHJldHVybiB7XG4gICAgICAgIGNoYXJhY3RlcjogW10sXG4gICAgICAgIHN0eWxlOiBbXSxcbiAgICAgICAgcmVmZXJlbmNlSW1hZ2U6IFtdLFxuICAgICAgICBjb250ZW50OiBbXSxcbiAgICAgICAgYXVkaW9UcmFjazogW10sXG4gICAgICAgIHRyYW5zY3JpcHQ6IFtdLFxuICAgICAgICBtYXNrOiBbXSxcbiAgICB9O1xufVxuZnVuY3Rpb24gdmlkZW9DYXJkaW5hbGl0eUlzc3VlKHJvbGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb2RlOiAnSU5QVVRfUk9MRV9DQVJESU5BTElUWV9VTlNVUFBPUlRFRCcsXG4gICAgICAgIHJvbGUsXG4gICAgICAgIG1lc3NhZ2U6IGBOZXcgQVBJIHZpZGVvIOS4jeaUr+aMgeivpei+k+WFpeinkuiJsueahOWkmuS4quWAvO+8miR7cm9sZX1gLFxuICAgIH07XG59XG5mdW5jdGlvbiB2aWRlb1Vuc3VwcG9ydGVkUm9sZUlzc3VlKHJvbGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb2RlOiAnVU5TVVBQT1JURURfSU5QVVRfUk9MRScsXG4gICAgICAgIHJvbGUsXG4gICAgICAgIG1lc3NhZ2U6IGBOZXcgQVBJIHZpZGVvIOS4jeaUr+aMgeivpei+k+WFpeinkuiJsu+8miR7cm9sZX1gLFxuICAgIH07XG59XG4vKipcbiAqIOaKiueUu+W4gy/lv6vnhafovpPlhaXmlLbmiJDop4TojIMgVmlkZW9JbnB1dFNldOOAglxuICog5paH5pysIGNvbnRlbnQg5YW85a655pig5bCE5Li6IHByb21wdO+8m+WPguiAg+OAgee8lui+keWSjOW7tumVv+aooeW8j+S4i++8jOWbvueJhyBjb250ZW50IOaUtuaIkOWPguiAg+WbvuOAgemfs+mikSBjb250ZW50IOaUtuaIkOWPguiAg+mfs+mikeOAglxuICog5YW25LuW5qih5byP6YeM5Zu+54mHIGNvbnRlbnQg5LuN5YW85a655pig5bCE5Li66aaW5bin77yM6KeG6aKRIGNvbnRlbnQg55WZ5ZyoIGNvbnRlbnQg5YiX6KGo44CCXG4gKiBAcGFyYW0gaW5wdXRzIOW3suWGu+e7k+eahOi/kOihjOi+k+WFpeOAglxuICogQHBhcmFtIHZpZGVvTW9kZSDmmL7lvI/op4bpopHmqKHlvI/vvJvnvLrnnIHkv53mjIHml6fnlLvluIPlhbzlrrnmmKDlsITjgIJcbiAqIEByZXR1cm5zIOinhOiMg+mbhuWQiOS4juaUtumbhumYtuauteWPkeeOsOeahOWfuuaVsOmXrumimOOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gY29sbGVjdFZpZGVvSW5wdXRTZXQoaW5wdXRzLCB2aWRlb01vZGUpIHtcbiAgICBjb25zdCBpbnB1dFNldCA9IGVtcHR5VmlkZW9JbnB1dFNldCgpO1xuICAgIGNvbnN0IGlzc3VlcyA9IFtdO1xuICAgIGNvbnN0IHJlZmVyZW5jZU1vZGUgPSB2aWRlb01vZGUgPT09ICdvbW5pX3JlZmVyZW5jZScgfHwgdmlkZW9Nb2RlID09PSAndmlkZW9fZWRpdCcgfHwgdmlkZW9Nb2RlID09PSAndmlkZW9fZXh0ZW5kJztcbiAgICBjb25zdCBhc3NpZ25TaW5nbGV0b24gPSAocm9sZSwgaW5wdXQpID0+IHtcbiAgICAgICAgaWYgKGlucHV0U2V0W3JvbGVdKSB7XG4gICAgICAgICAgICBpc3N1ZXMucHVzaCh2aWRlb0NhcmRpbmFsaXR5SXNzdWUocm9sZSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlucHV0U2V0W3JvbGVdID0gaW5wdXQ7XG4gICAgfTtcbiAgICBmb3IgKGNvbnN0IGlucHV0IG9mIG9yZGVyZWRSdW5JbnB1dHMoaW5wdXRzKSkge1xuICAgICAgICBpZiAoaW5wdXQucm9sZSA9PT0gJ3Byb21wdCcgfHxcbiAgICAgICAgICAgIChpbnB1dC5yb2xlID09PSAnY29udGVudCcgJiYgaW5wdXQuc25hcHNob3QuZGF0YS5tZWRpYVR5cGUgPT09ICd0ZXh0JykpIHtcbiAgICAgICAgICAgIGFzc2lnblNpbmdsZXRvbigncHJvbXB0JywgaW5wdXQpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlucHV0LnJvbGUgPT09ICduZWdhdGl2ZVByb21wdCcpIHtcbiAgICAgICAgICAgIGFzc2lnblNpbmdsZXRvbignbmVnYXRpdmVQcm9tcHQnLCBpbnB1dCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW5wdXQucm9sZSA9PT0gJ2xhc3RGcmFtZScpIHtcbiAgICAgICAgICAgIGFzc2lnblNpbmdsZXRvbignbGFzdEZyYW1lJywgaW5wdXQpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlZmVyZW5jZU1vZGUgJiYgaW5wdXQucm9sZSA9PT0gJ2NvbnRlbnQnICYmIGlucHV0LnNuYXBzaG90LmRhdGEubWVkaWFUeXBlID09PSAnaW1hZ2UnKSB7XG4gICAgICAgICAgICBpbnB1dFNldC5yZWZlcmVuY2VJbWFnZS5wdXNoKGlucHV0KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZWZlcmVuY2VNb2RlICYmIGlucHV0LnJvbGUgPT09ICdjb250ZW50JyAmJiBpbnB1dC5zbmFwc2hvdC5kYXRhLm1lZGlhVHlwZSA9PT0gJ2F1ZGlvJykge1xuICAgICAgICAgICAgaW5wdXRTZXQuYXVkaW9UcmFjay5wdXNoKGlucHV0KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpbnB1dC5yb2xlID09PSAnZmlyc3RGcmFtZScgfHxcbiAgICAgICAgICAgIChpbnB1dC5yb2xlID09PSAnY29udGVudCcgJiYgaW5wdXQuc25hcHNob3QuZGF0YS5tZWRpYVR5cGUgPT09ICdpbWFnZScpKSB7XG4gICAgICAgICAgICBhc3NpZ25TaW5nbGV0b24oJ2ZpcnN0RnJhbWUnLCBpbnB1dCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW5wdXQucm9sZSA9PT0gJ2NoYXJhY3RlcicgfHwgaW5wdXQucm9sZSA9PT0gJ3N0eWxlJyB8fCBpbnB1dC5yb2xlID09PSAncmVmZXJlbmNlSW1hZ2UnKSB7XG4gICAgICAgICAgICBpbnB1dFNldFtpbnB1dC5yb2xlXS5wdXNoKGlucHV0KTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpbnB1dC5yb2xlID09PSAnY29udGVudCcpIHtcbiAgICAgICAgICAgIGlucHV0U2V0LmNvbnRlbnQucHVzaChpbnB1dCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW5wdXQucm9sZSA9PT0gJ2F1ZGlvVHJhY2snIHx8IGlucHV0LnJvbGUgPT09ICd0cmFuc2NyaXB0JyB8fCBpbnB1dC5yb2xlID09PSAnbWFzaycpIHtcbiAgICAgICAgICAgIGlucHV0U2V0W2lucHV0LnJvbGVdLnB1c2goaW5wdXQpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaXNzdWVzLnB1c2godmlkZW9VbnN1cHBvcnRlZFJvbGVJc3N1ZShpbnB1dC5yb2xlKSk7XG4gICAgfVxuICAgIHJldHVybiB7IGlucHV0U2V0LCBpc3N1ZXMgfTtcbn1cbi8qKlxuICog5qC55o2u6KeE6IyD6L6T5YWl5o6o5pat6KeG6aKR55Sf5oiQ5Zy65pmv44CC5pen55S75biD5pyq5YaZIHZpZGVvTW9kZSDml7bkvb/nlKjjgIJcbiAqIEBwYXJhbSBpbnB1dFNldCDlt7LmlLbpm4bnmoTop4TojIPovpPlhaXjgIJcbiAqIEByZXR1cm5zIOeUqOS6juaRmOimgeWSjOmihOajgOeahOWcuuaZr+agh+ivhuOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJWaWRlb09wZXJhdGlvbihpbnB1dFNldCkge1xuICAgIGNvbnN0IGhhc1ZpZGVvT3JBdWRpbyA9IGlucHV0U2V0LmNvbnRlbnQubGVuZ3RoID4gMCB8fCBpbnB1dFNldC5hdWRpb1RyYWNrLmxlbmd0aCA+IDAgfHwgaW5wdXRTZXQudHJhbnNjcmlwdC5sZW5ndGggPiAwO1xuICAgIGNvbnN0IHJlZmVyZW5jZUNvdW50ID0gTnVtYmVyKGlucHV0U2V0LmNoYXJhY3Rlci5sZW5ndGggPiAwKSArXG4gICAgICAgIE51bWJlcihpbnB1dFNldC5zdHlsZS5sZW5ndGggPiAwKSArXG4gICAgICAgIE51bWJlcihpbnB1dFNldC5yZWZlcmVuY2VJbWFnZS5sZW5ndGggPiAwKTtcbiAgICBpZiAoaGFzVmlkZW9PckF1ZGlvIHx8IChyZWZlcmVuY2VDb3VudCA+IDAgJiYgKGlucHV0U2V0LmZpcnN0RnJhbWUgfHwgaW5wdXRTZXQubGFzdEZyYW1lKSkpIHtcbiAgICAgICAgcmV0dXJuICdvbW5pX3JlZmVyZW5jZSc7XG4gICAgfVxuICAgIGlmIChpbnB1dFNldC5jaGFyYWN0ZXIubGVuZ3RoIHx8IGlucHV0U2V0LnN0eWxlLmxlbmd0aCB8fCBpbnB1dFNldC5yZWZlcmVuY2VJbWFnZS5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuICdyZWZlcmVuY2VfZ3VpZGVkJztcbiAgICB9XG4gICAgaWYgKGlucHV0U2V0Lmxhc3RGcmFtZSlcbiAgICAgICAgcmV0dXJuICdmaXJzdF9sYXN0X2ZyYW1lJztcbiAgICBpZiAoaW5wdXRTZXQuZmlyc3RGcmFtZSlcbiAgICAgICAgcmV0dXJuICdpbWFnZV90b192aWRlbyc7XG4gICAgcmV0dXJuICd0ZXh0X3RvX3ZpZGVvJztcbn1cbi8qKiDlsIbljZXlgLzmiJblpJrlgLzop5LoibLnu5/kuIDkuLrovpPlhaXliJfooajvvIzkvpvmqKHlvI/lv4XloavkuI7lqpLkvZPnsbvlnovmoKHpqozkvb/nlKjjgIIgKi9cbi8qKiDmjInlt7Lnoa7orqTnmoTlrpjmlrnmqKHlnovpmZDliLbmo4Dmn6Xlj4LogIPmlbDph4/lkoznuq/pn7PpopHnu4TlkIjvvIzlkJHpooTmo4Dnu5Pmnpzov73liqDplJnor6/jgIIgKi9cbi8qKlxuICog5a+56KeG6aKR6KeE6IyD6L6T5YWl5YGa5p2D5aiB6aKE5qOA44CCXG4gKiDmmL7lvI8gdmlkZW9Nb2RlIOaMieaooeW8j+S6kuaWpeajgOafpe+8m+aXp+eUu+W4g+acquWGmeaooeW8j+aXtuayv+eUqOinkuiJsueZveWQjeWNleOAglxuICogQHBhcmFtIGlucHV0cyDlt7Llhrvnu5PnmoTov5DooYzovpPlhaXjgIJcbiAqIEBwYXJhbSBvcHRpb25zIOaooeWei+OAgeWPguaVsOWSjOWPr+mAieeahOaYvuW8j+inhumikeaooeW8j+OAglxuICogQHJldHVybnMg5Zy65pmv44CB6KeE6IyD6ZuG5ZCI5ZKM6K+35rGC5YmN5b+F6aG75aSE55CG55qE6Zeu6aKY44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmVjaGVja1ZpZGVvR2VuZXJhdGlvbklucHV0cyhpbnB1dHMsIG9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IGNvbGxlY3Rpb25Nb2RlID0gIW9wdGlvbnMudmlkZW9Nb2RlICYmXG4gICAgICAgIChpbWFnZTJwcm9WaWRlb0NvbnRyYWN0Rm9yTW9kZWwob3B0aW9ucy5tb2RlbEFsaWFzKSB8fFxuICAgICAgICAgICAgeXVhbmxpdVZpZGVvQ29udHJhY3RGb3JNb2RlbChvcHRpb25zLm1vZGVsQWxpYXMpKVxuICAgICAgICA/ICdvbW5pX3JlZmVyZW5jZSdcbiAgICAgICAgOiBvcHRpb25zLnZpZGVvTW9kZTtcbiAgICBjb25zdCB7IGlucHV0U2V0IH0gPSBjb2xsZWN0VmlkZW9JbnB1dFNldChpbnB1dHMsIGNvbGxlY3Rpb25Nb2RlKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBvcGVyYXRpb246IG9wdGlvbnMudmlkZW9Nb2RlXG4gICAgICAgICAgICA/IHZpZGVvTW9kZVRvT3BlcmF0aW9uKG9wdGlvbnMudmlkZW9Nb2RlKVxuICAgICAgICAgICAgOiBpbmZlclZpZGVvT3BlcmF0aW9uKGlucHV0U2V0KSxcbiAgICAgICAgaW5wdXRTZXQsXG4gICAgICAgIGlzc3VlczogW10sXG4gICAgfTtcbn1cbi8qKlxuICog6K+75Y+W6KeG6aKR6IqC54K555qE5a6M5oiQ5Yqo5L2c77yb57y655yB5pen6IqC54K56KeG5Li6IG5vbmXjgIJcbiAqIEBwYXJhbSBkYXRhIOiKgueCuSBkYXRh44CCXG4gKiBAcmV0dXJucyDop4TojIPljJblkI7nmoTlrozmiJDliqjkvZzjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVWaWRlb0NvbXBsZXRpb25BY3Rpb24oZGF0YSkge1xuICAgIHJldHVybiBkYXRhPy5jb21wbGV0aW9uQWN0aW9uID8/ICdub25lJztcbn1cbi8qKlxuICog5Li65LiA5qyh6KeG6aKR6L+Q6KGM5p6E6YCg56iz5a6a55qE5pyr5bin5Yqo5L2c6Lqr5Lu944CCXG4gKiBAcGFyYW0gaW5wdXQg6L+Q6KGM44CB5rqQ6IqC54K544CB5Yqo5L2c5ZKM5Y+v6YCJ55uu5qCH44CCXG4gKiBAcmV0dXJucyDpnZ7nqbogYWN0aW9uSWTjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZpZGVvRmluYWxGcmFtZUFjdGlvbklkKGlucHV0KSB7XG4gICAgcmV0dXJuIFtcbiAgICAgICAgJ2ZpbmFsLWZyYW1lJyxcbiAgICAgICAgLFxuICAgICAgICBpbnB1dC5ydW5JZCxcbiAgICAgICAgaW5wdXQuc291cmNlTm9kZUlkLFxuICAgICAgICBpbnB1dC5hY3Rpb24sXG4gICAgICAgIGlucHV0LnRhcmdldE5vZGVJZCA/PyAnbm9uZScsXG4gICAgXS5qb2luKCc6Jyk7XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLFNBQVNBLENBQUMsUUFBUSxLQUFLO0FBQ3ZCLFNBQVNDLDJCQUEyQixFQUFFQyw0QkFBNEIsUUFBUSx1QkFBdUI7QUFDakcsU0FBU0MseUJBQXlCLFFBQVEsMEJBQTBCO0FBQ3BFLFNBQVNDLDRCQUE0QixRQUFTLDZCQUE2QjtBQUMzRSxTQUFTQyw4QkFBOEIsUUFBUywrQkFBK0I7QUFDL0UsY0FBYyx1QkFBdUI7QUFDckMsY0FBYywwQkFB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
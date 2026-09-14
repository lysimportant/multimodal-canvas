import { z } from 'zod';

export const mediaTypes = ['text', 'image', 'audio', 'video'] as const;
/** 画布节点模式。历史 `transform` 读取时归一为 `generate`，产品不再区分转换节点。 */
export const nodeModes = ['source', 'generate'] as const;

/** 视频生成节点的一次运行模式。节点本身不是模式，一次运行只选一种。 */
export const videoModes = [
  'text_to_video',
  'first_frame',
  'first_last_frame',
  'omni_reference',
  'video_edit',
  'video_extend',
] as const;

/** 本阶段真正落地的视频模式；编辑和延长只保留枚举与文档。 */
export const implementedVideoModes = [
  'text_to_video',
  'first_frame',
  'first_last_frame',
  'omni_reference',
] as const;

export const videoModeSchema = z.enum(videoModes);
export type VideoMode = (typeof videoModes)[number];

/** 视频模式的中文名称，供画布选择器和摘要复用。 */
export const videoModeLabels: Record<VideoMode, string> = {
  text_to_video: '文生视频',
  first_frame: '首帧',
  first_last_frame: '首尾帧',
  omni_reference: '全能参考',
  video_edit: '视频编辑',
  video_extend: '视频延长',
};

/** 视频模式的短说明，解释该模式吸收哪些输入。 */
export const videoModeDescriptions: Record<VideoMode, string> = {
  text_to_video: '只使用提示词生成新视频，不连接图片、视频或音频参考',
  first_frame: '用一张图固定起始画面，再按提示词生成',
  first_last_frame: '分别固定起始画面和结束画面',
  omni_reference: '用参考图、参考视频或参考音频融合生成，不固定首尾帧',
  video_edit: '按提示词编辑已有视频；本阶段未开放',
  video_extend: '按提示词延长已有视频；本阶段未开放',
};

/**
 * 把已废弃的转换模式读成生成模式，保证旧画布仍能打开。
 * @param value 节点 mode 原始值。
 * @returns 归一后的值；无法识别时原样返回交给 schema 校验。
 */
export function normalizeNodeMode(value: unknown): unknown {
  return value === 'transform' ? 'generate' : value;
}

export const portRoles = [
  'prompt',
  'negativePrompt',
  'content',
  'style',
  'character',
  'referenceImage',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const;
export const assetStatuses = ['ready', 'archived'] as const;

export const mediaTypeSchema = z.enum(mediaTypes);
export const modelSelectionSchema = z.object({
  modelAlias: z.string().trim().min(1),
  credentialId: z.string().trim().min(1).optional(),
});
export const nodeModeSchema = z.preprocess(normalizeNodeMode, z.enum(nodeModes));
export const portRoleSchema = z.enum(portRoles);
export const assetStatusSchema = z.enum(assetStatuses);

export const runStatuses = [
  'draft',
  'queued',
  'preparing',
  'running',
  'processing',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;

export const runStatusSchema = z.enum(runStatuses);

export const providerJobStatuses = [
  'queued',
  'submitted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const providerJobStatusSchema = z.enum(providerJobStatuses);

/** Lifecycle state for one frozen canvas node inside a queued DAG run. */
export const workflowNodeStatuses = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const workflowNodeStatusSchema = z.enum(workflowNodeStatuses);

export const providerJobSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  platformJobId: z.string().min(1).optional(),
  status: providerJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  payload: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runResultAssetSchema = z.object({
  assetId: z.string().min(1),
  version: z.number().int().positive().optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: mediaTypeSchema,
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** 资源索引返回的当前最高版本；旧资源可能暂时没有该字段。 */
  latestVersion: z.number().int().positive().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: assetStatusSchema,
  contentUrl: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(64)).default([]),
  metadata: z.record(z.unknown()).optional(),
  archivedAt: z.string().datetime().optional(),
});

/**
 * 提示词中提及资源的通用绑定信息。
 * 未识别的普通字段会被保留，便于后续语义角色扩展；凭据、临时 URL 和
 * 本地路径等敏感字段在领域解析边界直接丢弃，避免进入持久化文档。
 */
const mentionBindingObjectSchema = z
  .object({
    entityName: z.string().trim().min(1).max(160).optional(),
    semanticRole: z.string().trim().min(1).max(160).optional(),
    scope: z.enum(['local', 'node', 'scene']).optional(),
  })
  .passthrough();

export const mentionBindingSchema = z.preprocess(
  (value) => sanitizeMentionBindingValue(value),
  mentionBindingObjectSchema,
);

/** 在绑定的前向兼容字段中移除凭据、URL 和本地路径。 */
function sanitizeMentionBindingValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveMentionKey(key)) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return looksLikeLocalPath(value) ? undefined : value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMentionBindingValue(item))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeMentionBindingValue(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}

function isSensitiveMentionKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return (
    /(?:^|_)(?:api_key|access_token|refresh_token|authorization|password|secret(?:_key)?|credential(?:s|_id|_version)?|signed_url|presigned_url)(?:_|$)/.test(
      normalized,
    ) ||
    /(?:url|uri)$/.test(normalized) ||
    /(?:^|_)(?:local_?path|file_?path|path)(?:_|$)/.test(normalized)
  );
}

function looksLikeLocalPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|file:)/.test(value.trim());
}

/** 资源提及块。assetVersion 用于用户明确选择某个历史版本的场景。 */
export const promptMentionSchema = z
  .object({
    type: z.literal('mention'),
    mentionId: z.string().trim().min(1).max(160),
    assetId: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(512),
    mediaType: mediaTypeSchema,
    assetVersion: z.number().int().positive().optional(),
    /** 导入时资源不可访问会保留身份并标记为不可执行占位。 */
    placeholder: z.boolean().optional(),
    placeholderReason: z
      .enum([
        'not_found',
        'forbidden',
        'archived',
        'version_missing',
        'mime_mismatch',
        'size_exceeded',
      ])
      .optional(),
    semanticRole: z.string().trim().min(1).max(160).optional(),
    entityName: z.string().trim().min(1).max(160).optional(),
    scope: z.enum(['local', 'node', 'scene']).optional(),
    binding: mentionBindingSchema.optional(),
  })
  // 提及块只允许协议字段；Worker 的临时内容会在解析器完成 schema
  // 校验后以内存字段注入，避免 URL、凭据或本地路径进入持久化数据。
  .strip();

/** 普通文字块，允许为空以表达空提示词文档。 */
export const promptTextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().max(20_000),
  })
  .strip();

export const promptBlockSchema = z.discriminatedUnion('type', [
  promptTextBlockSchema,
  promptMentionSchema,
]);

/**
 * 版本化提示词文档。块顺序就是文字和资源提及的渲染顺序。
 * 文档必须至少包含一个块；提及 ID 只要求在当前文档内唯一。
 */
export const promptDocumentSchema = z
  .object({
    version: z.literal(1),
    blocks: z.array(promptBlockSchema).min(1).max(2_000),
  })
  .strip()
  .superRefine((document, context) => {
    const mentionIds = new Set<string>();
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
          path: ['blocks', index, 'mentionId'],
        });
      }
      mentionIds.add(block.mentionId);
      if (block.placeholderReason && block.placeholder !== true) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'placeholderReason requires placeholder: true',
          path: ['blocks', index, 'placeholder'],
        });
      }
    });
    if (textLength > 20_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt document text exceeds the 20000-character limit',
        path: ['blocks'],
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
export function mentionDisplayName(mention: {
  label: string;
  entityName?: string;
  binding?: { entityName?: string };
}): string {
  const named = mention.entityName?.trim() || mention.binding?.entityName?.trim();
  if (named) return named;
  return defaultResourceDisplayName(mention.label);
}

/**
 * 从文件名得到默认可读名，去掉常见后缀。
 * @param fileName 资源文件名或标签。
 */
export function defaultResourceDisplayName(fileName: string): string {
  const base = fileName.trim();
  if (!base) return '资源';
  const stripped = base.replace(/\.[A-Za-z0-9]{1,8}$/u, '');
  return (stripped || base).slice(0, 160);
}

/**
 * 在已占用名字中生成不重复的显示名。
 * @param fileName 原始文件名。
 * @param taken 本节点已占用的名字。
 */
export function uniqueResourceDisplayName(fileName: string, taken: Iterable<string>): string {
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
export function renderPromptDocument(document: PromptDocument): string {
  const parsed = promptDocumentSchema.parse(document);
  return parsed.blocks
    .map((block) => (block.type === 'text' ? block.text : mentionDisplayName(block)))
    .join('');
}

export function getEffectivePromptDocument(input: {
  prompt?: string;
  promptDocument?: PromptDocument;
}): PromptDocument {
  if (input.promptDocument !== undefined) return promptDocumentSchema.parse(input.promptDocument);
  return {
    version: 1,
    blocks: [{ type: 'text', text: input.prompt ?? '' }],
  };
}

/** 已写入运行快照的、带不可变资产版本的资源提及。 */
export const frozenPromptMentionSchema = z
  .object({
    /** 节点 ID 在旧快照中可省略；新快照始终写入。 */
    nodeId: z.string().trim().min(1).optional(),
    mentionId: z.string().trim().min(1).max(160),
    assetId: z.string().trim().min(1).max(512),
    assetVersion: z.number().int().positive(),
    mediaType: mediaTypeSchema,
    label: z.string().trim().min(1).max(512),
    blockOrder: z.number().int().nonnegative(),
    semanticRole: z.string().trim().min(1).max(160).optional(),
    entityName: z.string().trim().min(1).max(160).optional(),
    scope: z.enum(['local', 'node', 'scene']).optional(),
    binding: mentionBindingSchema.optional(),
  })
  .strip();

/** 视频成功归档后的末帧完成动作。 */
export const videoCompletionActions = [
  'none',
  'preview_final_frame',
  'create_asset',
  'append_image_node',
  'fill_designated_image_node',
] as const;
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
});

export const nodeDataSchema = z.object({
  label: z.string().min(1),
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
  /**
   * 节点参考资源池。名字绑定到 assetId，提示词用名字引用；
   * 与画布连线和提示词提及共用同一份身份，避免按顺序互换角色。
   */
  resourceRefs: z.array(nodeResourceRefSchema).max(40).optional(),
  /**
   * 与节点一同保存的媒体生成参数，例如图片尺寸/清晰度和视频分辨率/时长。
   * 参数由对应 Provider 按已支持的字段映射，未配置时沿用模型默认值。
   */
  parameters: z.record(z.unknown()).optional(),
  /**
   * 模型支持的推理强度标识。不同模型的能力名称可能不同（例如
   * `low`、`high`、`xhigh` 或 `max`），因此只校验为非空字符串。
   */
  inferenceStrength: z.string().trim().min(1).optional(),
  modelAlias: z.string().trim().min(1).optional(),
  /** Credential selected with the model. Omitted keeps legacy active-credential behavior. */
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
});

/** Legacy canvases omit this field; only an explicit false disables a node. */
export function isCanvasNodeEnabled(node: Pick<CanvasNode, 'data'>): boolean {
  return node.data.enabled !== false;
}

export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: mediaTypeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  /** User-resizable dimensions. React Flow keeps these on the node itself. */
  width: z.number().finite().positive().max(10_000).optional(),
  height: z.number().finite().positive().max(10_000).optional(),
  data: nodeDataSchema,
});

export const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  sourceHandle: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetHandle: z.string().min(1),
  order: z.number().int().nonnegative(),
});

export const canvasDocumentSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
  })
  .superRefine((document, context) => {
    const nodeIds = new Set<string>();
    const nodesById = new Map<string, CanvasNode>();

    document.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ['nodes', index, 'id'],
        });
      }
      nodeIds.add(node.id);
      nodesById.set(node.id, node);
    });

    const edgesBySource = new Map<string, string[]>();
    const edgeIds = new Set<string>();
    document.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate edge id: ${edge.id}`,
          path: ['edges', index, 'id'],
        });
      }
      edgeIds.add(edge.id);

      const source = nodesById.get(edge.sourceNodeId);
      const target = nodesById.get(edge.targetNodeId);
      if (!source || !target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'edge references a missing node',
          path: ['edges', index],
        });
        return;
      }
      if (source.id === target.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'self-referential edges are not allowed',
          path: ['edges', index],
        });
      }
      if (!isPortConnectionAllowed(source, edge.sourceHandle, target, edge.targetHandle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `incompatible connection: ${edge.sourceHandle} -> ${edge.targetHandle}`,
          path: ['edges', index],
        });
      }

      const sourceEdges = edgesBySource.get(source.id) ?? [];
      sourceEdges.push(target.id);
      edgesBySource.set(source.id, sourceEdges);
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
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
          path: ['edges'],
        });
        break;
      }
    }
  });

export const runInputSnapshotSchema = z.object({
  nodeId: z.string().min(1),
  role: portRoleSchema,
  sortOrder: z.number().int().nonnegative(),
  sourceAssetId: z.string().min(1).optional(),
  snapshot: canvasNodeSchema,
});

export const runCredentialReferenceSchema = z.object({
  credentialId: z.string().min(1),
  credentialVersion: z.number().int().positive(),
});

export const runSnapshotSchema = z
  .object({
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
    parameters: z.record(z.unknown()),
    submittedAt: z.string().datetime(),
    nodes: z.array(canvasNodeSchema).min(1),
    edges: z.array(canvasEdgeSchema),
    inputs: z.array(runInputSnapshotSchema),
    /** 按节点保存已冻结的内联提及；旧快照可省略该字段。 */
    promptMentions: z.array(frozenPromptMentionSchema).optional(),
  })
  .superRefine((snapshot, context) => {
    // Run snapshots can come from a persisted queue payload or a worker
    // restart, so validate the graph again instead of trusting the API's
    // earlier canvas validation. This prevents malformed edges or cycles from
    // reaching a provider when a queue/database boundary is compromised.
    const documentResult = canvasDocumentSchema.safeParse({
      revision: snapshot.canvasRevision,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    });
    if (!documentResult.success) {
      for (const issue of documentResult.error.issues) {
        if (issue.path[0] === 'revision') continue;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }

    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    for (const [nodeId, reference] of Object.entries(snapshot.nodeCredentialReferences ?? {})) {
      if (!nodeIds.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'node credential references a missing node',
          path: ['nodeCredentialReferences', nodeId],
        });
      }
      if (
        nodeId === snapshot.targetNodeId &&
        ((snapshot.credentialId && snapshot.credentialId !== reference.credentialId) ||
          (snapshot.credentialVersion &&
            snapshot.credentialVersion !== reference.credentialVersion))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'target credential reference does not match the run credential',
          path: ['nodeCredentialReferences', nodeId],
        });
      }
    }
    snapshot.inputs.forEach((input, index) => {
      if (!nodeIds.has(input.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'run input references a missing node',
          path: ['inputs', index, 'nodeId'],
        });
      }
      if (input.snapshot.id !== input.nodeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'run input snapshot id does not match nodeId',
          path: ['inputs', index, 'snapshot', 'id'],
        });
      }
    });

    const mentionKeys = new Set<string>();
    const lastMentionOrderByNode = new Map<string, number>();
    snapshot.promptMentions?.forEach((mention, index) => {
      if (mention.nodeId && !nodeIds.has(mention.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'prompt mention references a missing snapshot node',
          path: ['promptMentions', index, 'nodeId'],
        });
      }
      const key = `${mention.nodeId ?? ''}\0${mention.mentionId}`;
      if (mentionKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate frozen prompt mention: ${mention.mentionId}`,
          path: ['promptMentions', index, 'mentionId'],
        });
      }
      mentionKeys.add(key);
      const orderNodeId = mention.nodeId ?? snapshot.targetNodeId;
      const previousOrder = lastMentionOrderByNode.get(orderNodeId);
      if (previousOrder !== undefined && mention.blockOrder < previousOrder) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'frozen prompt mentions must be ordered by blockOrder per node',
          path: ['promptMentions', index, 'blockOrder'],
        });
      }
      lastMentionOrderByNode.set(orderNodeId, mention.blockOrder);
    });

    if (!snapshot.nodes.some((node) => node.id === snapshot.targetNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run target node is missing from snapshot',
        path: ['targetNodeId'],
      });
    }
  });

/**
 * Returns the canonical JSON identity for an immutable run snapshot.
 * Submission time is execution metadata rather than request identity, so it
 * is deliberately excluded. Object keys are sorted recursively while array
 * order remains significant.
 */
export function canonicalRunSnapshotJson(snapshot: RunSnapshot): string {
  const { submittedAt: _submittedAt, ...stableSnapshot } = runSnapshotSchema.parse(snapshot);
  return JSON.stringify(canonicalJsonValue(stableSnapshot));
}

/**
 * Returns the versioned material hashed by API and Worker run identity checks.
 * Keeping the namespace beside the canonicalizer prevents the two processes
 * from silently drifting to different digest inputs.
 */
export function runSnapshotFingerprintMaterial(snapshot: RunSnapshot): string {
  return `multimodal-canvas:run-snapshot:v2:${canonicalRunSnapshotJson(snapshot)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalJsonValue(item)));
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export const videoFinalFrameStatuses = [
  'skipped',
  'pending',
  'processing',
  'ready',
  'failed',
  'conflict',
] as const;
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
  message: z.string().min(1).optional(),
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
});

/**
 * Durable execution state for one node of the immutable run snapshot. The
 * source graph itself remains in `snapshot`; this only records lifecycle
 * data needed to resume a BullMQ job without re-running completed work.
 */
export const workflowNodeStateSchema = z
  .object({
    nodeId: z.string().min(1),
    status: workflowNodeStatusSchema,
    providerJob: providerJobSchema.optional(),
    result: runResultSchema.optional(),
  })
  .superRefine((state, context) => {
    if (state.status === 'succeeded' && !state.result) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'succeeded workflow node requires a result',
        path: ['result'],
      });
    }
  });

export const workflowStateSchema = z
  .object({
    nodes: z.array(workflowNodeStateSchema),
  })
  .superRefine((state, context) => {
    const nodeIds = new Set<string>();
    state.nodes.forEach((node, index) => {
      if (nodeIds.has(node.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate workflow node state: ${node.nodeId}`,
          path: ['nodes', index, 'nodeId'],
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runJobDataSchema = z
  .object({
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
  })
  .superRefine((job, context) => {
    const nodesById = new Map(job.snapshot.nodes.map((node) => [node.id, node]));
    job.workflowState?.nodes.forEach((state, index) => {
      const node = nodesById.get(state.nodeId);
      if (!node) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow state references a missing snapshot node',
          path: ['workflowState', 'nodes', index, 'nodeId'],
        });
        return;
      }
      if (state.result?.targetNodeId !== undefined && state.result.targetNodeId !== node.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow result target does not match its node state',
          path: ['workflowState', 'nodes', index, 'result', 'targetNodeId'],
        });
      }
      if (state.result?.mediaType !== undefined && state.result.mediaType !== node.data.mediaType) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow result media type does not match its node state',
          path: ['workflowState', 'nodes', index, 'result', 'mediaType'],
        });
      }
    });
  });

export const runJobResultSchema = z.object({
  status: z.enum(['succeeded', 'cancelled']),
  progress: z.number().int().min(0).max(100),
  result: runResultSchema.optional(),
  providerJob: providerJobSchema.optional(),
});

const runStatusTransitions: Record<RunStatus, readonly RunStatus[]> = {
  draft: ['queued'],
  queued: ['preparing', 'cancel_requested', 'cancelled'],
  preparing: ['running', 'cancel_requested'],
  running: ['processing', 'cancel_requested'],
  processing: ['succeeded', 'failed', 'cancel_requested'],
  succeeded: [],
  failed: [],
  cancel_requested: ['cancelled'],
  cancelled: [],
};

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return from === to || runStatusTransitions[from].includes(to);
}

const targetRoleMediaTypes: Record<PortRole, readonly MediaType[]> = {
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
};

const targetNodePortRoles: Record<MediaType, readonly PortRole[]> = {
  text: ['prompt', 'negativePrompt', 'content', 'transcript'],
  image: [
    'prompt',
    'negativePrompt',
    'content',
    'style',
    'character',
    'referenceImage',
    'firstFrame',
    'lastFrame',
    'mask',
  ],
  audio: ['prompt', 'negativePrompt', 'content', 'audioTrack', 'transcript'],
  video: [
    'prompt',
    'negativePrompt',
    'content',
    'style',
    'character',
    'referenceImage',
    'firstFrame',
    'lastFrame',
    'audioTrack',
    'transcript',
    'mask',
  ],
};

/** Returns the input roles exposed by a target node's media type. */
export function targetPortRolesForMediaType(mediaType: MediaType): PortRole[] {
  return [...targetNodePortRoles[mediaType]];
}

/** 按模型别名识别视频供应商家族，用于能力矩阵而不是写死字段名。 */
export type VideoModelFamily =
  'grok-imagine-video-1.5' | 'grok-imagine-video' | 'minimax-h3' | 'wan' | 'unknown';

/**
 * 从模型 ID 推断视频家族。未命中时返回 unknown，真实字段仍 fail-closed。
 * @param modelAlias 运行快照或节点上的模型 ID。
 */
export function videoFamilyForModel(modelAlias?: string): VideoModelFamily {
  const id = (modelAlias ?? '').trim().toLowerCase();
  if (!id) return 'unknown';
  if (id.startsWith('grok-imagine-video-1.5')) return 'grok-imagine-video-1.5';
  if (/^grok[-_]?imagine/.test(id)) return 'grok-imagine-video';
  if (/^minimax[-_]?h3/.test(id)) return 'minimax-h3';
  if (id.includes('wan')) return 'wan';
  return 'unknown';
}

/** 某个视频模式在指定模型上的画布端口与真实 POST 能力。 */
export type VideoModeCapability = {
  /** 画布是否允许选择该模式。 */
  selectable: boolean;
  /** 是否允许按已取证合同发真实 POST。 */
  livePost: boolean;
  /** 该模式允许连接的输入角色。 */
  roles: readonly PortRole[];
  /** 运行前必须出现的角色。 */
  requiredRoles?: readonly PortRole[];
  /** 可重复且保序的角色。 */
  repeatableRoles?: readonly PortRole[];
  /** 覆盖全局角色媒体约束；缺省沿用 targetRoleMediaTypes。 */
  roleMediaTypes?: Partial<Record<PortRole, readonly MediaType[]>>;
  /** 不可选或不能 POST 时的原因。 */
  reason?: string;
};

const textToVideoRoles = ['prompt', 'negativePrompt'] as const satisfies readonly PortRole[];
const firstFrameRoles = [
  'prompt',
  'negativePrompt',
  'firstFrame',
] as const satisfies readonly PortRole[];
const firstLastFrameRoles = [
  'prompt',
  'negativePrompt',
  'firstFrame',
  'lastFrame',
] as const satisfies readonly PortRole[];
const omniReferenceRoles = [
  'prompt',
  'negativePrompt',
  'referenceImage',
  'content',
  'audioTrack',
  'character',
  'style',
] as const satisfies readonly PortRole[];
const grokOmniReferenceRoles = [
  'prompt',
  'negativePrompt',
  'referenceImage',
  'character',
  'style',
] as const satisfies readonly PortRole[];

function deferredVideoModeCapability(mode: VideoMode): VideoModeCapability {
  return {
    selectable: false,
    livePost: false,
    roles: ['prompt', 'content'],
    reason: `视频模式「${videoModeLabels[mode]}」本阶段未开放`,
  };
}

/**
 * 返回指定模式在该模型上的能力。画布可按 selectable 展示；真实请求看 livePost。
 * @param mode 节点上的视频模式。
 * @param modelAlias 运行快照或节点上的模型 ID。
 */
export function videoModeCapability(mode: VideoMode, modelAlias?: string): VideoModeCapability {
  if (mode === 'video_edit' || mode === 'video_extend') return deferredVideoModeCapability(mode);
  const family = videoFamilyForModel(modelAlias);
  const grok15 = family === 'grok-imagine-video-1.5';
  if (mode === 'text_to_video') {
    return { selectable: true, livePost: true, roles: textToVideoRoles };
  }
  if (mode === 'first_frame') {
    return {
      selectable: true,
      livePost: true,
      roles: firstFrameRoles,
      requiredRoles: ['firstFrame'],
    };
  }
  if (mode === 'first_last_frame') {
    return {
      selectable: true,
      livePost: grok15,
      roles: firstLastFrameRoles,
      requiredRoles: ['firstFrame', 'lastFrame'],
      reason: grok15 ? undefined : '该模型的首尾帧尚未接通 New API 字段映射，不能发起真实请求',
    };
  }
  if (grok15) {
    return {
      selectable: true,
      livePost: true,
      roles: grokOmniReferenceRoles,
      repeatableRoles: ['referenceImage', 'character', 'style'],
      roleMediaTypes: {
        referenceImage: ['image'],
        character: ['image'],
        style: ['image'],
      },
    };
  }
  return {
    selectable: true,
    livePost: false,
    roles: omniReferenceRoles,
    repeatableRoles: ['referenceImage', 'character', 'style', 'content', 'audioTrack'],
    roleMediaTypes: {
      referenceImage: ['image'],
      character: ['image'],
      style: ['image'],
      content: ['video'],
      audioTrack: ['audio'],
    },
    reason: '该模型的全能参考尚未接通 New API 字段映射，不能发起真实请求',
  };
}

/**
 * 返回某个视频模式允许的输入角色。
 * @param mode 视频模式。
 * @param modelAlias 可选模型 ID，用于收窄全能参考的媒体。
 */
export function targetPortRolesForVideoMode(mode: VideoMode, modelAlias?: string): PortRole[] {
  return [...videoModeCapability(mode, modelAlias).roles];
}

/**
 * 按节点当前模式返回可连接角色。旧视频节点没有 videoMode 时保持全量端口。
 * @param node 目标画布节点。
 */
export function targetPortRolesForNode(
  node:
    | Pick<CanvasNode, 'data'>
    | { data: Pick<NodeData, 'mediaType' | 'mode' | 'videoMode' | 'modelAlias'> },
): PortRole[] {
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
export function isImplementedVideoMode(mode: VideoMode): boolean {
  return (implementedVideoModes as readonly VideoMode[]).includes(mode);
}

/**
 * 从已连接角色推断旧画布的视频模式，供选择器回显；不写入节点。
 * @param roles 当前连到该节点的输入角色。
 */
export function inferVideoModeFromRoles(roles: readonly PortRole[]): VideoMode {
  const set = new Set(roles);
  if (
    set.has('character') ||
    set.has('style') ||
    set.has('referenceImage') ||
    set.has('audioTrack') ||
    set.has('transcript') ||
    set.has('mask') ||
    set.has('content')
  ) {
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
export function displayVideoMode(
  data: Pick<NodeData, 'videoMode'> | undefined,
  connectedRoles: readonly PortRole[] = [],
): VideoMode {
  return data?.videoMode ?? inferVideoModeFromRoles(connectedRoles);
}

export function isPortConnectionAllowed(
  source: CanvasNode,
  sourceHandle: string,
  target: CanvasNode,
  targetHandle: string,
): boolean {
  // Source nodes are terminal references. They expose an output only and
  // cannot receive workflow inputs.
  if (target.data.mode === 'source') return false;

  const sourceMediaType = sourceHandle.startsWith('output:')
    ? sourceHandle.slice('output:'.length)
    : undefined;
  const targetRole = targetHandle.startsWith('input:')
    ? targetHandle.slice('input:'.length)
    : undefined;

  if (sourceMediaType !== source.data.mediaType || !targetRole) return false;
  if (!portRoles.includes(targetRole as PortRole)) return false;
  const allowedRoles = targetPortRolesForNode(target);
  if (!allowedRoles.includes(targetRole as PortRole)) return false;
  const capability =
    target.data.mediaType === 'video' && target.data.videoMode
      ? videoModeCapability(target.data.videoMode, target.data.modelAlias)
      : undefined;
  const allowedMedia =
    capability?.roleMediaTypes?.[targetRole as PortRole] ??
    targetRoleMediaTypes[targetRole as PortRole];
  return allowedMedia.includes(source.data.mediaType);
}

export type MediaType = z.infer<typeof mediaTypeSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type NodeMode = z.infer<typeof nodeModeSchema>;
export type PortRole = z.infer<typeof portRoleSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type MentionBinding = z.infer<typeof mentionBindingSchema>;
export type PromptMention = z.infer<typeof promptMentionSchema>;
export type PromptTextBlock = z.infer<typeof promptTextBlockSchema>;
export type PromptBlock = z.infer<typeof promptBlockSchema>;
export type PromptDocument = z.infer<typeof promptDocumentSchema>;
export type FrozenPromptMention = z.infer<typeof frozenPromptMentionSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type NodeData = z.infer<typeof nodeDataSchema>;
export type NodeResourceRef = z.infer<typeof nodeResourceRefSchema>;

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ProviderJobStatus = z.infer<typeof providerJobStatusSchema>;
export type ProviderJob = z.infer<typeof providerJobSchema>;
export type RunResultAsset = z.infer<typeof runResultAssetSchema>;
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;
export type RunCredentialReference = z.infer<typeof runCredentialReferenceSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type WorkflowNodeStatus = z.infer<typeof workflowNodeStatusSchema>;
export type WorkflowNodeState = z.infer<typeof workflowNodeStateSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunJobData = z.infer<typeof runJobDataSchema>;
export type RunJobResult = z.infer<typeof runJobResultSchema>;

/** 视频规范输入中基数为 0..1 的角色。 */
export const videoSingletonInputRoles = [
  'prompt',
  'negativePrompt',
  'firstFrame',
  'lastFrame',
] as const;

/** 视频规范输入中可重复且必须保序的角色。 */
export const videoRepeatableInputRoles = ['character', 'style', 'referenceImage'] as const;

/** 图片落到视频节点主体时可供选择的角色。旧画布未写 videoMode 时仍可弹出。 */
export const videoImageInputRoles = [
  'firstFrame',
  'lastFrame',
  'character',
  'style',
  'referenceImage',
] as const;

/**
 * 返回当前视频模式下，图片落到节点主体时可选的角色。
 * 显式模式不再把角色/风格当成独立入口；首尾帧只选首帧或尾帧。
 * @param videoMode 节点上的显式模式；缺省表示旧画布。
 */
export function videoImageRolesForMode(videoMode?: VideoMode): readonly PortRole[] {
  if (videoMode === 'first_frame') return ['firstFrame'];
  if (videoMode === 'first_last_frame') return ['firstFrame', 'lastFrame'];
  if (videoMode === 'omni_reference') return ['referenceImage'];
  if (videoMode === 'text_to_video' || videoMode === 'video_edit' || videoMode === 'video_extend') {
    return [];
  }
  return ['firstFrame', 'lastFrame', 'referenceImage'];
}

/**
 * 提示词一旦带上资源提及，文生视频按全能参考吸收，避免只加了素材却没切模式。
 * 首帧/首尾帧仍互斥，不会把提示词提及收成参考图。
 * @param videoMode 节点上的显式视频模式。
 * @param hasPromptResourceMentions 提示词是否包含资源提及。
 */
export function videoModeForPromptMentions(
  videoMode: VideoMode | undefined,
  hasPromptResourceMentions: boolean,
): VideoMode | undefined {
  if (!hasPromptResourceMentions) return videoMode;
  if (videoMode === 'text_to_video') return 'omni_reference';
  return videoMode;
}

/**
 * 提示词里的资源提及在当前视频模式下可吸收的输入角色。
 * 全能参考把图/视频/音频收成参考素材，而不是走聊天多模态提及合同。
 * @param mediaType 提及的媒体类型。
 * @param videoMode 节点上的显式视频模式。
 * @param modelAlias 用于按能力矩阵收窄 Grok 只收图片等约束。
 */
export function videoInputRoleForPromptMention(
  mediaType: MediaType,
  videoMode: VideoMode | undefined,
  modelAlias?: string,
): PortRole | undefined {
  const mode = videoModeForPromptMentions(videoMode, true);
  if (mode !== 'omni_reference') return undefined;
  const roles = new Set(videoModeCapability('omni_reference', modelAlias).roles);
  if (mediaType === 'image' && roles.has('referenceImage')) return 'referenceImage';
  if (mediaType === 'video' && roles.has('content')) return 'content';
  if (mediaType === 'audio' && roles.has('audioTrack')) return 'audioTrack';
  return undefined;
}

/**
 * 返回视频节点提示词中不能被当前模式吸收、仍需单独失败的资源提及。
 * @param node 目标视频节点的媒体、模式和模型。
 * @param mentions 该节点上的冻结资源提及。
 */
export function unabsorbedVideoPromptMentions<T extends { mediaType: MediaType }>(
  node: Pick<NodeData, 'mediaType' | 'mode' | 'videoMode' | 'modelAlias'>,
  mentions: readonly T[],
  modelAlias = node.modelAlias,
): T[] {
  if (node.mediaType !== 'video' || node.mode === 'source') return [...mentions];
  return mentions.filter(
    (mention) => !videoInputRoleForPromptMention(mention.mediaType, node.videoMode, modelAlias),
  );
}

/**
 * 视频节点无法吸收提示词资源提及时的说明，避免误用聊天提及能力文案。
 * @param mentionMediaType 提及媒体。
 * @param videoMode 当前视频模式。
 * @param modelAlias 模型 ID。
 */
export function unabsorbedVideoPromptMentionMessage(
  mentionMediaType: MediaType,
  videoMode: VideoMode | undefined,
  modelAlias?: string,
): string {
  if (videoMode === 'omni_reference') {
    return `当前模型的全能参考不能吸收提示词里的${mentionMediaType === 'image' ? '图片' : mentionMediaType === 'video' ? '视频' : mentionMediaType === 'audio' ? '音频' : mentionMediaType}提及`;
  }
  const modeLabel = videoMode ? videoModeLabels[videoMode] : '当前';
  return `视频模式「${modeLabel}」不能使用提示词资源提及。全能参考请把素材连到节点，或切换到全能参考`;
}

/** 未知模型默认只允许 prompt 和至多一张首帧。 */
export const confirmedLiveVideoInputRoles = ['prompt', 'firstFrame'] as const;

/** grok-imagine-video-1.5 官方参考图上限。 */
export const GROK_IMAGINE_VIDEO_15_MAX_REFERENCE_IMAGES = 7;

/** grok-imagine-video-1.5 已文档化的真实输入角色。 */
export const grokImagineVideo15InputRoles = [
  'prompt',
  'firstFrame',
  'lastFrame',
  'character',
  'style',
  'referenceImage',
] as const;

/**
 * 判断模型是否属于 grok-imagine-video-1.5 系列，含 1.5.1 与按次别名。
 * @param modelAlias 运行快照中的模型 ID。
 */
export function isGrokImagineVideo15(modelAlias: string | undefined): boolean {
  return videoFamilyForModel(modelAlias) === 'grok-imagine-video-1.5';
}

/**
 * 返回该模型当前允许发真实 POST 的输入角色。
 * @param modelAlias 运行快照中的模型 ID。
 */
export function confirmedVideoInputRolesForModel(modelAlias?: string): readonly PortRole[] {
  return isGrokImagineVideo15(modelAlias)
    ? grokImagineVideo15InputRoles
    : confirmedLiveVideoInputRoles;
}

/** 视频生成场景。用于预检和摘要；显式 videoMode 存在时由模式决定，不再靠连线猜测。 */
export const videoOperationTypes = [
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_guided',
  'omni_reference',
] as const;

export type VideoSingletonInputRole = (typeof videoSingletonInputRoles)[number];
export type VideoRepeatableInputRole = (typeof videoRepeatableInputRoles)[number];
export type VideoImageInputRole = (typeof videoImageInputRoles)[number];
export type VideoOperationType = (typeof videoOperationTypes)[number];

/**
 * 把显式视频模式映射为预检摘要使用的场景标识。
 * @param mode 节点上的视频模式。
 */
export function videoModeToOperation(mode: VideoMode): VideoOperationType {
  if (mode === 'first_frame') return 'image_to_video';
  if (mode === 'first_last_frame') return 'first_last_frame';
  if (mode === 'omni_reference' || mode === 'video_edit' || mode === 'video_extend') {
    return 'omni_reference';
  }
  return 'text_to_video';
}

/**
 * 视频节点的规范输入集合。
 * 单值角色最多一条；可重复角色按连接顺序保存。
 */
export type VideoInputSet = {
  prompt?: RunInputSnapshot;
  negativePrompt?: RunInputSnapshot;
  firstFrame?: RunInputSnapshot;
  lastFrame?: RunInputSnapshot;
  character: RunInputSnapshot[];
  style: RunInputSnapshot[];
  referenceImage: RunInputSnapshot[];
  content: RunInputSnapshot[];
  audioTrack: RunInputSnapshot[];
  transcript: RunInputSnapshot[];
  mask: RunInputSnapshot[];
};

/** 视频输入预检问题。代码与 Provider 错误码对齐，便于请求前失败。 */
export type VideoGenerationIssue = {
  code:
    | 'UNSUPPORTED_INPUT_ROLE'
    | 'INPUT_ROLE_CARDINALITY_UNSUPPORTED'
    | 'VIDEO_PROMPT_REQUIRED'
    | 'UNSUPPORTED_INPUT_COMBINATION';
  role?: PortRole;
  message: string;
};

/** 视频输入预检结果，含推断场景和规范输入。 */
export type VideoGenerationPrecheck = {
  operation: VideoOperationType;
  inputSet: VideoInputSet;
  issues: VideoGenerationIssue[];
};

/**
 * 按 sortOrder 与原始下标稳定排序运行输入。
 * @param inputs 快照中的输入列表。
 * @returns 排序后的新数组，不修改原列表。
 */
export function orderedRunInputs(inputs: readonly RunInputSnapshot[]): RunInputSnapshot[] {
  return inputs
    .map((input, index) => ({ input, index }))
    .sort((left, right) => left.input.sortOrder - right.input.sortOrder || left.index - right.index)
    .map(({ input }) => input);
}

function emptyVideoInputSet(): VideoInputSet {
  return {
    character: [],
    style: [],
    referenceImage: [],
    content: [],
    audioTrack: [],
    transcript: [],
    mask: [],
  };
}

function videoCardinalityIssue(role: PortRole): VideoGenerationIssue {
  return {
    code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
    role,
    message: `New API video 不支持该输入角色的多个值：${role}`,
  };
}

function videoUnsupportedRoleIssue(role: PortRole): VideoGenerationIssue {
  return {
    code: 'UNSUPPORTED_INPUT_ROLE',
    role,
    message: `New API video 不支持该输入角色：${role}`,
  };
}

function videoCombinationIssue(message: string, role?: PortRole): VideoGenerationIssue {
  return {
    code: 'UNSUPPORTED_INPUT_COMBINATION',
    role,
    message,
  };
}

function omniReferenceCount(inputSet: VideoInputSet): number {
  return (
    inputSet.character.length +
    inputSet.style.length +
    inputSet.referenceImage.length +
    inputSet.content.length +
    inputSet.audioTrack.length
  );
}

/**
 * 把画布/快照输入收成规范 VideoInputSet。
 * 文本 content 兼容映射为 prompt；全能参考下图片 content 收成参考图、音频 content 收成参考音频。
 * 其他模式里图片 content 仍兼容映射为首帧，视频 content 留在 content 列表。
 * @param inputs 已冻结的运行输入。
 * @param videoMode 显式视频模式；缺省保持旧画布兼容映射。
 * @returns 规范集合与收集阶段发现的基数问题。
 */
export function collectVideoInputSet(
  inputs: readonly RunInputSnapshot[],
  videoMode?: VideoMode,
): {
  inputSet: VideoInputSet;
  issues: VideoGenerationIssue[];
} {
  const inputSet = emptyVideoInputSet();
  const issues: VideoGenerationIssue[] = [];
  const omni = videoMode === 'omni_reference';

  const assignSingleton = (role: VideoSingletonInputRole, input: RunInputSnapshot) => {
    if (inputSet[role]) {
      issues.push(videoCardinalityIssue(role));
      return;
    }
    inputSet[role] = input;
  };

  for (const input of orderedRunInputs(inputs)) {
    if (
      input.role === 'prompt' ||
      (input.role === 'content' && input.snapshot.data.mediaType === 'text')
    ) {
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
    if (omni && input.role === 'content' && input.snapshot.data.mediaType === 'image') {
      inputSet.referenceImage.push(input);
      continue;
    }
    if (omni && input.role === 'content' && input.snapshot.data.mediaType === 'audio') {
      inputSet.audioTrack.push(input);
      continue;
    }
    if (
      input.role === 'firstFrame' ||
      (input.role === 'content' && input.snapshot.data.mediaType === 'image')
    ) {
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

  return { inputSet, issues };
}

/**
 * 根据规范输入推断视频生成场景。旧画布未写 videoMode 时使用。
 * @param inputSet 已收集的规范输入。
 * @returns 用于摘要和预检的场景标识。
 */
export function inferVideoOperation(inputSet: VideoInputSet): VideoOperationType {
  const hasVideoOrAudio =
    inputSet.content.length > 0 || inputSet.audioTrack.length > 0 || inputSet.transcript.length > 0;
  const referenceCount =
    Number(inputSet.character.length > 0) +
    Number(inputSet.style.length > 0) +
    Number(inputSet.referenceImage.length > 0);
  if (hasVideoOrAudio || (referenceCount > 0 && (inputSet.firstFrame || inputSet.lastFrame))) {
    return 'omni_reference';
  }
  if (inputSet.character.length || inputSet.style.length || inputSet.referenceImage.length) {
    return 'reference_guided';
  }
  if (inputSet.lastFrame) return 'first_last_frame';
  if (inputSet.firstFrame) return 'image_to_video';
  return 'text_to_video';
}

function presentVideoRoles(inputSet: VideoInputSet): Array<[PortRole, boolean]> {
  return [
    ['negativePrompt', Boolean(inputSet.negativePrompt)],
    ['firstFrame', Boolean(inputSet.firstFrame)],
    ['lastFrame', Boolean(inputSet.lastFrame)],
    ['character', inputSet.character.length > 0],
    ['style', inputSet.style.length > 0],
    ['referenceImage', inputSet.referenceImage.length > 0],
    ['content', inputSet.content.length > 0],
    ['audioTrack', inputSet.audioTrack.length > 0],
    ['transcript', inputSet.transcript.length > 0],
    ['mask', inputSet.mask.length > 0],
  ];
}

function applyGrokImagineVideo15Limits(
  inputSet: VideoInputSet,
  parameters: Record<string, unknown> | undefined,
  issues: VideoGenerationIssue[],
) {
  const referenceCount =
    inputSet.character.length + inputSet.style.length + inputSet.referenceImage.length;
  if (referenceCount > GROK_IMAGINE_VIDEO_15_MAX_REFERENCE_IMAGES) {
    issues.push({
      code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
      role: 'referenceImage',
      message: `New API video 参考图数量超过模型上限 ${GROK_IMAGINE_VIDEO_15_MAX_REFERENCE_IMAGES}`,
    });
  }
  const resolution = String(
    parameters?.resolution ?? parameters?.video_resolution ?? parameters?.videoResolution ?? '',
  ).toLowerCase();
  if ((inputSet.lastFrame || referenceCount > 0) && /(1080|1440|2160|4k)/.test(resolution)) {
    issues.push({
      code: 'UNSUPPORTED_INPUT_COMBINATION',
      message: 'grok-imagine-video-1.5 的参考图或尾帧合同最高 720p',
    });
  }
}

/**
 * 对视频规范输入做权威预检。
 * 显式 videoMode 按模式互斥检查；旧画布未写模式时沿用角色白名单。
 * @param inputs 已冻结的运行输入。
 * @param options 模型、参数和可选的显式视频模式。
 * @returns 场景、规范集合和请求前必须处理的问题。
 */
export function precheckVideoGenerationInputs(
  inputs: readonly RunInputSnapshot[],
  options: {
    modelAlias?: string;
    parameters?: Record<string, unknown>;
    videoMode?: VideoMode;
  } = {},
): VideoGenerationPrecheck {
  const { inputSet, issues } = collectVideoInputSet(inputs, options.videoMode);
  const mode = options.videoMode;

  if (mode) {
    const capability = videoModeCapability(mode, options.modelAlias);
    const allowed = new Set<PortRole>(capability.roles);
    if (!isImplementedVideoMode(mode) || !capability.selectable) {
      issues.push(
        videoCombinationIssue(capability.reason ?? `视频模式「${videoModeLabels[mode]}」未开放`),
      );
    }
    for (const [role, present] of presentVideoRoles(inputSet)) {
      if (present && !allowed.has(role)) issues.push(videoUnsupportedRoleIssue(role));
    }
    for (const role of capability.requiredRoles ?? []) {
      const missing =
        role === 'firstFrame'
          ? !inputSet.firstFrame
          : role === 'lastFrame'
            ? !inputSet.lastFrame
            : false;
      if (missing) {
        issues.push(
          videoCombinationIssue(
            mode === 'first_last_frame'
              ? '首尾帧模式需要同时连接首帧和尾帧'
              : '首帧模式需要连接一张首帧图',
            role,
          ),
        );
      }
    }
    if (mode === 'omni_reference' && omniReferenceCount(inputSet) === 0) {
      issues.push(videoCombinationIssue('全能参考至少需要一张参考图、一段参考视频或一段参考音频'));
    }
    if (
      mode === 'text_to_video' &&
      (inputSet.firstFrame || inputSet.lastFrame || omniReferenceCount(inputSet) > 0)
    ) {
      issues.push(videoCombinationIssue('文生视频不能连接首帧、尾帧或参考素材'));
    }
    if (capability.livePost) {
      const live = new Set<PortRole>(
        confirmedVideoInputRolesForModel(options.modelAlias).filter((role) => allowed.has(role)),
      );
      for (const [role, present] of presentVideoRoles(inputSet)) {
        if (present && allowed.has(role) && !live.has(role))
          issues.push(videoUnsupportedRoleIssue(role));
      }
    } else if (capability.selectable && isImplementedVideoMode(mode) && capability.reason) {
      issues.push(videoCombinationIssue(capability.reason));
    }
  } else {
    const confirmed = new Set<PortRole>(confirmedVideoInputRolesForModel(options.modelAlias));
    for (const [role, present] of presentVideoRoles(inputSet)) {
      if (present && !confirmed.has(role)) issues.push(videoUnsupportedRoleIssue(role));
    }
  }

  if (isGrokImagineVideo15(options.modelAlias)) {
    applyGrokImagineVideo15Limits(inputSet, options.parameters, issues);
  }

  return {
    operation: mode ? videoModeToOperation(mode) : inferVideoOperation(inputSet),
    inputSet,
    issues,
  };
}

export type VideoCompletionAction = z.infer<typeof videoCompletionActionSchema>;
export type VideoFinalFrameStatus = z.infer<typeof videoFinalFrameStatusSchema>;
export type RunResultFinalFrame = z.infer<typeof runResultFinalFrameSchema>;

/**
 * 读取视频节点的完成动作；缺省旧节点视为 none。
 * @param data 节点 data。
 * @returns 规范化后的完成动作。
 */
export function resolveVideoCompletionAction(
  data: Pick<NodeData, 'completionAction'> | undefined,
): VideoCompletionAction {
  return data?.completionAction ?? 'none';
}

/**
 * 为一次视频运行构造稳定的末帧动作身份。
 * @param input 运行、源节点、动作和可选目标。
 * @returns 非空 actionId。
 */
export function videoFinalFrameActionId(input: {
  runId: string;
  sourceNodeId: string;
  action: VideoCompletionAction;
  targetNodeId?: string;
}): string {
  return [
    'final-frame',
    ,
    input.runId,
    input.sourceNodeId,
    input.action,
    input.targetNodeId ?? 'none',
  ].join(':');
}

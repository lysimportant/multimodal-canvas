import { accountOpenApiPaths } from './account-openapi';
import { promptSkillOpenApiPaths } from './prompt-skill-openapi';

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    requestId: { type: 'string', minLength: 1 },
    retryAfterSeconds: { type: 'integer', minimum: 0 },
    issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

/** 全局生成并发与运行时合同一致；只允许管理员设置正安全整数。 */
const generationConcurrencySchema = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
/** 不公开 Redis 地址、队列名称或运行凭据。 */
const generationConcurrencySettingsSchema = {
  type: 'object',
  required: ['concurrency', 'scope'],
  additionalProperties: false,
  properties: {
    concurrency: { ...generationConcurrencySchema, default: 20 },
    scope: { const: 'queue', type: 'string' },
  },
} as const;

const mediaTypeSchema = { type: 'string', enum: ['text', 'image', 'audio', 'video'] } as const;
/** 节点执行模式的公开契约。 */
const nodeModeSchema = { type: 'string', enum: ['source', 'generate'] } as const;
const modelSelectionSchema = {
  type: 'object',
  required: ['modelAlias'],
  properties: {
    modelAlias: { type: 'string', minLength: 1 },
    credentialId: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false,
} as const;
const defaultModelValueSchema = {
  oneOf: [{ type: 'string', minLength: 1 }, modelSelectionSchema],
} as const;
/** 精确资源版本的一次独立分析；文本只表示反推结果，不代表原始生成请求。 */
const reversePromptAnalysisSchema = {
  type: 'object',
  required: [
    'runId',
    'assetId',
    'assetVersion',
    'status',
    'automatic',
    'modelAlias',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    runId: { type: 'string' },
    assetId: { type: 'string' },
    assetVersion: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    automatic: { type: 'boolean' },
    modelAlias: { type: 'string' },
    summary: { type: 'string', maxLength: 2000 },
    prompt: { type: 'string', maxLength: 20000 },
    error: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;
/** 一次独立 Skill 优化；结果只供用户预览采用，不生成资产。 */
const promptOptimizationSchema = {
  type: 'object',
  required: ['runId', 'nodeId', 'skillId', 'skillVersion', 'status', 'modelAlias'],
  properties: {
    runId: { type: 'string' },
    nodeId: { type: 'string' },
    skillId: { type: 'string' },
    skillVersion: { type: 'string' },
    simulated: {
      type: 'boolean',
      description: '明确标识模拟结果；Mock 仅保留原文，不代表模型优化。',
    },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    modelAlias: { type: 'string' },
    promptDocument: { $ref: '#/components/schemas/PromptDocument' },
    error: { type: 'string' },
  },
  additionalProperties: false,
} as const;
const assetSchema = {
  type: 'object',
  required: ['id', 'name', 'mediaType', 'mimeType', 'sizeBytes', 'status', 'contentUrl', 'tags'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    mediaType: mediaTypeSchema,
    mimeType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    latestVersion: {
      type: 'integer',
      minimum: 1,
      description: '资源版本索引中的当前最高版本；历史资源可能没有该字段。',
    },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { type: 'string', enum: ['ready', 'archived'] },
    contentUrl: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', additionalProperties: true },
    archivedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** 内联资源提及的 Provider-neutral 绑定元数据，并保留未知字段以便前向兼容。 */
const mentionBindingSchema = {
  type: 'object',
  properties: {
    entityName: { type: 'string', minLength: 1, maxLength: 160 },
    semanticRole: { type: 'string', minLength: 1, maxLength: 160 },
    scope: { type: 'string', enum: ['local', 'node', 'scene'] },
  },
  // 绑定对象允许保留未知语义字段，以便前向兼容；服务端仍会过滤
  // 凭据、URL 和本地路径形态的敏感字段。
  additionalProperties: true,
} as const;

/** 提示词文档中的结构化资源提及块。 */
const promptMentionSchema = {
  type: 'object',
  required: ['type', 'mentionId', 'assetId', 'label', 'mediaType'],
  properties: {
    type: { type: 'string', const: 'mention' },
    mentionId: { type: 'string', minLength: 1, maxLength: 160 },
    assetId: { type: 'string', minLength: 1, maxLength: 512 },
    label: { type: 'string', minLength: 1, maxLength: 512 },
    mediaType: mediaTypeSchema,
    assetVersion: { type: 'integer', minimum: 1 },
    placeholder: { type: 'boolean' },
    placeholderReason: {
      type: 'string',
      enum: [
        'not_found',
        'forbidden',
        'archived',
        'version_missing',
        'mime_mismatch',
        'size_exceeded',
      ],
    },
    semanticRole: { type: 'string', minLength: 1, maxLength: 160 },
    entityName: { type: 'string', minLength: 1, maxLength: 160 },
    scope: { type: 'string', enum: ['local', 'node', 'scene'] },
    binding: mentionBindingSchema,
  },
  additionalProperties: false,
} as const;

/** 提示词文档中的普通文本块。 */
const promptTextBlockSchema = {
  type: 'object',
  required: ['type', 'text'],
  properties: {
    type: { type: 'string', const: 'text' },
    text: { type: 'string', maxLength: 20_000 },
  },
  additionalProperties: false,
} as const;

/** 提示词文档支持的块联合。 */
const promptBlockSchema = {
  oneOf: [promptTextBlockSchema, promptMentionSchema],
  discriminator: { propertyName: 'type' },
} as const;

/** 版本化提示词文档契约，块顺序即渲染顺序。 */
const promptDocumentSchema = {
  type: 'object',
  required: ['version', 'blocks'],
  properties: {
    version: { type: 'integer', const: 1 },
    blocks: { type: 'array', minItems: 1, maxItems: 2_000, items: promptBlockSchema },
  },
  additionalProperties: false,
  description: '版本化提示词块；提及块保留资源身份，块顺序即渲染顺序。',
} as const;

/** 运行提交时冻结的资源提及元数据。 */
const frozenPromptMentionSchema = {
  type: 'object',
  required: ['mentionId', 'assetId', 'assetVersion', 'mediaType', 'label', 'blockOrder'],
  properties: {
    nodeId: { type: 'string', minLength: 1 },
    mentionId: { type: 'string', minLength: 1, maxLength: 160 },
    assetId: { type: 'string', minLength: 1, maxLength: 512 },
    assetVersion: { type: 'integer', minimum: 1 },
    mediaType: mediaTypeSchema,
    durationSeconds: { type: 'number', exclusiveMinimum: 0 },
    label: { type: 'string', minLength: 1, maxLength: 512 },
    blockOrder: { type: 'integer', minimum: 0 },
    semanticRole: { type: 'string', minLength: 1, maxLength: 160 },
    entityName: { type: 'string', minLength: 1, maxLength: 160 },
    scope: { type: 'string', enum: ['local', 'node', 'scene'] },
    binding: mentionBindingSchema,
  },
  additionalProperties: false,
  description: '运行提交时捕获的不可变资源提及元数据，不包含媒体字节、凭据或签名 URL。',
} as const;

/** 冻结资源提及时可稳定诊断的失败原因。 */
const resourceMentionFailureReasonSchema = {
  type: 'string',
  enum: [
    'not_found',
    'forbidden',
    'archived',
    'version_missing',
    'mime_mismatch',
    'size_exceeded',
    'placeholder',
  ],
} as const;

/** 资源冻结及模型能力预检返回的逐项诊断。 */
const resourceMentionDiagnosticSchema = {
  type: 'object',
  required: [
    'code',
    'message',
    'requestId',
    'nodeId',
    'mentionId',
    'assetId',
    'mediaType',
    'reason',
  ],
  properties: {
    code: {
      type: 'string',
      enum: [
        'RESOURCE_MENTION_NOT_FOUND',
        'RESOURCE_MENTION_FORBIDDEN',
        'RESOURCE_MENTION_ARCHIVED',
        'RESOURCE_MENTION_VERSION_MISSING',
        'RESOURCE_MENTION_MIME_MISMATCH',
        'RESOURCE_MENTION_SIZE_EXCEEDED',
        'RESOURCE_MENTION_PLACEHOLDER',
        'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
        'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
        'RESOURCE_MENTION_ROLE_UNSUPPORTED',
        'RESOURCE_MENTION_COUNT_EXCEEDED',
        'RESOURCE_MENTION_MIXED_UNSUPPORTED',
        'RESOURCE_MENTION_MODE_UNSUPPORTED',
      ],
    },
    message: { type: 'string' },
    requestId: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    mentionId: { type: 'string', minLength: 1 },
    assetId: { type: 'string', minLength: 1 },
    mediaType: mediaTypeSchema,
    semanticRole: { type: 'string', minLength: 1 },
    modelAlias: { type: 'string', minLength: 1 },
    reason: {
      oneOf: [
        resourceMentionFailureReasonSchema,
        {
          type: 'string',
          enum: [
            'capability_unknown',
            'media_unsupported',
            'role_unsupported',
            'count_exceeded',
            'mixed_unsupported',
            'mode_unsupported',
          ],
        },
      ],
    },
  },
  additionalProperties: true,
} as const;

const projectSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    ownerId: {
      type: 'string',
      format: 'uuid',
      description: '实际项目所有者；无主历史项目省略，不按调用者身份补写。',
    },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    archivedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const projectModelDefaultsSchema = {
  type: 'object',
  properties: {
    text: defaultModelValueSchema,
    image: defaultModelValueSchema,
    audio: defaultModelValueSchema,
    video: defaultModelValueSchema,
  },
  additionalProperties: false,
} as const;

/** 本人当前默认分组模型；凭据引用为内部 UUID，不包含 Key。 */
const resolvedModelSelectionSchema = {
  type: 'object',
  required: ['modelAlias', 'credentialId'],
  properties: {
    modelAlias: { type: 'string' },
    credentialId: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false,
} as const;
/** 项目默认值只返回当前用户的分组模型引用。 */
const projectModelDefaultsResponseSchema = {
  type: 'object',
  required: ['defaults'],
  properties: {
    defaults: {
      ...projectModelDefaultsSchema,
      description: '项目默认模型包含当前用户的 credentialId；服务端复核其归属。',
    },
  },
  additionalProperties: false,
} as const;

/** 类型默认模型的局部更新；显式 `null` 清除该媒体类型，省略表示保留。 */
const defaultModelUpdateSchema = {
  type: 'object',
  properties: {
    text: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
    image: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
    audio: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
    video: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
  },
  additionalProperties: false,
} as const;

const nodeSchema = {
  type: 'object',
  required: ['id', 'type', 'position', 'data'],
  properties: {
    id: { type: 'string' },
    type: mediaTypeSchema,
    position: {
      type: 'object',
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
    width: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
    height: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
    data: {
      type: 'object',
      required: ['label', 'mediaType', 'mode'],
      properties: {
        label: { type: 'string' },
        mediaType: mediaTypeSchema,
        mode: nodeModeSchema,
        enabled: { type: 'boolean' },
        stale: { type: 'boolean' },
        prompt: { type: 'string', maxLength: 20000 },
        promptDocument: { $ref: '#/components/schemas/PromptDocument' },
        promptSkillId: { type: 'string', minLength: 1, maxLength: 80 },
        parameters: { type: 'object', additionalProperties: true },
        inferenceStrength: { type: 'string', minLength: 1 },
        assetId: { type: 'string' },
        modelAlias: { type: 'string' },
        credentialId: { type: 'string', format: 'uuid' },
        contentUrl: { type: 'string' },
        mimeType: { type: 'string' },
      },
      additionalProperties: true,
    },
  },
} as const;

const edgeSchema = {
  type: 'object',
  required: ['id', 'sourceNodeId', 'sourceHandle', 'targetNodeId', 'targetHandle', 'order'],
  properties: {
    id: { type: 'string' },
    sourceNodeId: { type: 'string' },
    sourceHandle: { type: 'string' },
    targetNodeId: { type: 'string' },
    targetHandle: { type: 'string' },
    order: { type: 'integer', minimum: 0 },
  },
} as const;

const canvasSchema = {
  type: 'object',
  required: ['revision', 'nodes', 'edges'],
  properties: {
    revision: { type: 'integer', minimum: 0 },
    nodes: { type: 'array', items: nodeSchema },
    edges: { type: 'array', items: edgeSchema },
  },
} as const;

/** 工作流导出中脱敏后的结果引用。 */
const workflowExportResultReferenceSchema = {
  type: 'object',
  required: ['runId', 'targetNodeId', 'mediaType', 'provider', 'modelAlias'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    targetNodeId: { type: 'string', minLength: 1 },
    mediaType: mediaTypeSchema,
    provider: { type: 'string', minLength: 1 },
    modelAlias: { type: 'string', minLength: 1 },
    summary: { type: 'string' },
    asset: {
      type: 'object',
      required: ['assetId'],
      properties: {
        assetId: { type: 'string', minLength: 1 },
        version: { type: 'integer', minimum: 1 },
        mimeType: { type: 'string', minLength: 1 },
        sizeBytes: { type: 'integer', minimum: 0 },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        // 结果归档中的相对路径；导出内容不会携带外部 URL。
        path: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  description: '可移植的结果元数据；资产路径仅允许归档内相对路径，不包含签名或外部 URL。',
} as const;

/** 工作流导入和导出文档共用的顶层字段。 */
const workflowExportProperties = {
  schemaVersion: { type: 'integer', const: 1 },
  exportedAt: { type: 'string', format: 'date-time' },
  project: { $ref: '#/components/schemas/Project' },
  canvas: { $ref: '#/components/schemas/Canvas' },
  modelDefaults: { $ref: '#/components/schemas/ProjectModelDefaults' },
  // 运行记录是已脱敏的不透明元数据，不包含凭据、URL 或媒体字节。
  runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
  results: { type: 'array', items: workflowExportResultReferenceSchema },
} as const;

/** 工作流导出文档必须存在的顶层字段。 */
const workflowExportRequired = [
  'schemaVersion',
  'exportedAt',
  'project',
  'canvas',
  'runs',
  'results',
];

/** 可移植工作流导出文档的公开契约。 */
const workflowExportSchema = {
  type: 'object',
  required: workflowExportRequired,
  properties: workflowExportProperties,
  additionalProperties: false,
  description: '可移植工作流文档，仅包含图元数据和结果引用，不包含凭据、签名 URL 或媒体字节。',
} as const;

/** 工作流导入请求，可选携带画布乐观并发修订号。 */
const workflowImportRequestSchema = {
  type: 'object',
  required: workflowExportRequired,
  properties: {
    ...workflowExportProperties,
    expectedRevision: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
  description:
    '项目导入接口接受的工作流文档；expectedRevision 用于乐观并发控制，画布与默认模型原子保存。跨项目导入分配新节点/边 ID 并返回 nodeIdMap。导入移除源账号凭据和 URL，模型仅保留建议；非占位素材必须可用于目标项目且指定版本存在。runs/results 仅为导出元数据，不恢复历史运行或复制素材。',
} as const;

/** 导入时单个资源提及产生的问题。 */
const workflowImportMentionIssueSchema = {
  type: 'object',
  required: ['code', 'message', 'mentionId', 'assetId', 'mediaType', 'reason'],
  properties: {
    code: {
      type: 'string',
      enum: [
        'RESOURCE_MENTION_IMPORT_NOT_FOUND',
        'RESOURCE_MENTION_IMPORT_FORBIDDEN',
        'RESOURCE_MENTION_IMPORT_ARCHIVED',
        'RESOURCE_MENTION_IMPORT_VERSION_MISSING',
        'RESOURCE_MENTION_IMPORT_MIME_MISMATCH',
        'RESOURCE_MENTION_IMPORT_SIZE_EXCEEDED',
        'RESOURCE_MENTION_IMPORT_PLACEHOLDER',
      ],
    },
    message: { type: 'string', minLength: 1 },
    mentionId: { type: 'string', minLength: 1 },
    assetId: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    mediaType: mediaTypeSchema,
    reason: {
      type: 'string',
      enum: [
        'not_found',
        'forbidden',
        'archived',
        'version_missing',
        'mime_mismatch',
        'size_exceeded',
        'placeholder',
      ],
    },
  },
  additionalProperties: false,
  description: '逐项导入诊断；资产无法解析时以占位形式保留原始资源身份。',
} as const;

/** 模型建议和资源占位分别返回诊断；nodeId 缺省表示项目默认模型。 */
const workflowImportIssueSchema = {
  oneOf: [
    workflowImportMentionIssueSchema,
    {
      type: 'object',
      required: ['code', 'message', 'modelAlias', 'mediaType', 'reason'],
      properties: {
        code: { type: 'string', enum: ['MODEL_SELECTION_REQUIRED'] },
        message: { type: 'string', minLength: 1 },
        modelAlias: { type: 'string', minLength: 1 },
        mediaType: mediaTypeSchema,
        nodeId: { type: 'string', minLength: 1 },
        reason: { type: 'string', enum: ['model_selection_required'] },
      },
      additionalProperties: false,
      description: '保留导入的精确模型建议；用户重新选择本人分组后才可执行。',
    },
  ],
} as const;

/** 工作流导入成功响应。 */
const workflowImportResponseSchema = {
  type: 'object',
  required: ['workflow', 'canvas', 'issues'],
  properties: {
    workflow: { $ref: '#/components/schemas/WorkflowExport' },
    canvas: { $ref: '#/components/schemas/Canvas' },
    modelDefaults: { $ref: '#/components/schemas/ProjectModelDefaults' },
    issues: { type: 'array', items: { $ref: '#/components/schemas/WorkflowImportIssue' } },
    nodeIdMap: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
      description: '源节点 ID 到导入节点 ID 的映射；同项目导入保留 ID。',
    },
  },
  additionalProperties: false,
} as const;

/** 工作流导入失败响应。 */
const workflowImportErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: {
      type: 'string',
      enum: [
        'invalid_schema',
        'unsupported_schema_version',
        'revision_conflict',
        'asset_unavailable',
      ],
    },
    revision: { type: 'integer', minimum: 0 },
    requestId: { type: 'string', minLength: 1 },
    issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

const runSnapshotSchema = {
  type: 'object',
  required: ['canvasRevision', 'inputCount', 'inputs'],
  properties: {
    canvasRevision: { type: 'integer', minimum: 0 },
    inputCount: { type: 'integer', minimum: 0 },
    // Input contents are intentionally omitted from the public run contract.
    inputs: { type: 'array', items: { type: 'null' } },
    promptMentions: {
      type: 'array',
      items: { $ref: '#/components/schemas/FrozenPromptMention' },
      description: '运行提交时捕获的不可变资源提及元数据。',
    },
  },
  additionalProperties: false,
} as const;

const runResultAssetSchema = {
  type: 'object',
  required: ['assetId'],
  properties: {
    assetId: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    mimeType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  additionalProperties: false,
} as const;

const runResultSchema = {
  type: 'object',
  required: ['provider', 'summary', 'targetNodeId', 'mediaType', 'inputCount'],
  properties: {
    provider: { type: 'string' },
    summary: { type: 'string' },
    targetNodeId: { type: 'string' },
    mediaType: mediaTypeSchema,
    inputCount: { type: 'integer', minimum: 0 },
    simulated: {
      type: 'boolean',
      description: '结果是否来自明确标记的 Mock/预览路径。',
    },
    asset: runResultAssetSchema,
    promptOptimization: {
      type: 'object',
      required: ['promptDocument'],
      properties: { promptDocument: { $ref: '#/components/schemas/PromptDocument' } },
      additionalProperties: false,
    },
    promptMentions: {
      type: 'array',
      items: { $ref: '#/components/schemas/FrozenPromptMention' },
      description: '结果可用时回显的冻结资源提及元数据。',
    },
  },
  additionalProperties: false,
} as const;

const runSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'targetNodeId',
    'status',
    'progress',
    'attempt',
    'provider',
    'modelAlias',
    'snapshot',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string' },
    targetNodeId: { type: 'string' },
    status: {
      type: 'string',
      enum: [
        'draft',
        'queued',
        'preparing',
        'running',
        'processing',
        'succeeded',
        'failed',
        'cancel_requested',
        'cancelled',
      ],
    },
    progress: { type: 'integer', minimum: 0, maximum: 100 },
    attempt: { type: 'integer', minimum: 1 },
    provider: { type: 'string' },
    modelAlias: { type: 'string' },
    snapshot: runSnapshotSchema,
    result: runResultSchema,
    error: { type: 'string' },
    retryOf: { type: 'string' },
    /** 按节点记录的服务端 UTC 生命周期时间；旧运行缺省，界面显示“未记录”。 */
    nodeTimings: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['nodeId'],
        properties: {
          nodeId: { type: 'string' },
          queuedAt: { type: 'string', format: 'date-time' },
          startedAt: { type: 'string', format: 'date-time' },
          finishedAt: { type: 'string', format: 'date-time' },
          outcome: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] },
          requestStartedAt: { type: 'string', format: 'date-time' },
          requestFinishedAt: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

/** 请求提示词记录的列表摘要；绝不包含按发送顺序排列的请求正文。 */
const runRequestPromptSummarySchema = {
  type: 'object',
  required: [
    'id',
    'runId',
    'nodeId',
    'attempt',
    'requestIdentity',
    'provider',
    'modelAlias',
    'mediaType',
    'format',
    'sendStatus',
    'partCount',
    'resourceCount',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', description: '请求记录的不透明身份，内存和数据库存储均可返回。' },
    runId: { type: 'string' },
    nodeId: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    requestIdentity: { type: 'string' },
    provider: { type: 'string' },
    modelAlias: { type: 'string' },
    mediaType: { type: 'string', enum: ['text', 'image', 'audio', 'video'] },
    format: { type: 'string', enum: ['plain', 'messages'] },
    sendStatus: { type: 'string', enum: ['pending', 'sent', 'failed', 'unknown'] },
    partCount: { type: 'integer', minimum: 0 },
    resourceCount: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
    assetId: { type: 'string' },
    assetVersion: { type: 'integer', minimum: 1 },
    summary: { type: 'string' },
    summarySource: { type: 'string', enum: ['manual', 'local', 'model'] },
  },
  additionalProperties: false,
} as const;

/** 按需读取的完整请求提示词记录；只保存请求身份与文本，不含原始 HTTP body。 */
const runRequestPromptRecordSchema = {
  type: 'object',
  required: [
    'schemaVersion',
    'runId',
    'nodeId',
    'attempt',
    'requestIdentity',
    'provider',
    'modelAlias',
    'mediaType',
    'format',
    'parts',
    'resources',
    'sendStatus',
    'createdAt',
  ],
  properties: {
    schemaVersion: { type: 'integer', minimum: 1 },
    runId: { type: 'string' },
    nodeId: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    requestIdentity: { type: 'string' },
    provider: { type: 'string' },
    modelAlias: { type: 'string' },
    credentialId: { type: 'string' },
    credentialVersion: { type: 'integer', minimum: 1 },
    mediaType: { type: 'string', enum: ['text', 'image', 'audio', 'video'] },
    format: { type: 'string', enum: ['plain', 'messages'] },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['order', 'text'],
        properties: {
          order: { type: 'integer', minimum: 0 },
          role: { type: 'string' },
          name: { type: 'string' },
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    negativeText: { type: 'string' },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'sortOrder'],
        properties: {
          assetId: { type: 'string' },
          assetVersion: { type: 'integer', minimum: 1 },
          role: { type: 'string' },
          sortOrder: { type: 'integer', minimum: 0 },
          mediaType: { type: 'string', enum: ['text', 'image', 'audio', 'video'] },
        },
        additionalProperties: false,
      },
    },
    sendStatus: { type: 'string', enum: ['pending', 'sent', 'failed', 'unknown'] },
    createdAt: { type: 'string', format: 'date-time' },
    assetId: { type: 'string' },
    assetVersion: { type: 'integer', minimum: 1 },
    summary: { type: 'string' },
    summarySource: { type: 'string', enum: ['manual', 'local', 'model'] },
  },
  additionalProperties: false,
} as const;

const response = (description: string, schema?: unknown) => ({
  description,
  headers: {
    'X-Server-Time': {
      description: '响应发送时的服务端 UTC 时间，用于客户端运行计时校正',
      schema: { type: 'string', format: 'date-time' },
    },
  },
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});

const authUserSchema = {
  type: 'object',
  required: ['id', 'role', 'createdAt', 'updatedAt', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['user', 'admin'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['active', 'pending', 'disabled'] },
    bio: { type: 'string', maxLength: 500 },
    avatarUrl: { type: 'string', maxLength: 2048 },
  },
  additionalProperties: false,
} as const;

const envelope = (key: string, schema: unknown) => ({
  type: 'object',
  required: [key],
  properties: { [key]: schema },
  additionalProperties: false,
});

/** REST/SSE 公开契约；全局受限入口的依赖故障与业务错误分别描述。 */
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Multimodal Canvas API',
    version: '0.1.0',
    description:
      '项目、资源、AI 设置与运行的 REST/SSE API。生产全局限流依赖故障时，New API 登录、SSE 及启用限流的普通 API 返回 503/rate_limit_unavailable，并携带 Retry-After、retryAfterSeconds 和 requestId；额度耗尽仍返回 429。健康检查、Webhook 和已验证的签名资源访问保持独立边界。',
  },
  servers: [{ url: '/' }],
  security: [{ cookieAuth: [] }],
  tags: [
    { name: 'system' },
    { name: 'projects' },
    { name: 'assets' },
    { name: 'runs' },
    { name: 'settings' },
    { name: 'auth' },
    { name: 'webhooks' },
    { name: 'admin', description: '管理员用户、资源与系统管理' },
    { name: 'account', description: '个人资料、安全和资源' },
  ],
  paths: {
    ...accountOpenApiPaths(authUserSchema, assetSchema),
    ...promptSkillOpenApiPaths(),
    '/health': { get: { tags: ['system'], responses: { '200': response('Healthy') } } },
    '/documentation': {
      get: { tags: ['system'], responses: { '200': response('OpenAPI document') } },
    },
    '/documentation/json': {
      get: { tags: ['system'], responses: { '200': response('OpenAPI document') } },
    },
    '/v1/auth/me': {
      get: {
        tags: ['auth'],
        responses: {
          '200': response('Current user', envelope('user', authUserSchema)),
          '401': response('Authentication required', errorSchema),
        },
      },
    },
    '/v1/auth/logout': {
      post: {
        tags: ['auth'],
        responses: {
          '200': response('Logged out', {
            type: 'object',
            required: ['loggedOut'],
            properties: { loggedOut: { type: 'boolean', const: true } },
          }),
          '401': response('Authentication required', errorSchema),
        },
      },
    },
    '/v1/auth/logout-all': {
      post: {
        tags: ['auth'],
        responses: {
          '200': response('All sessions logged out', {
            type: 'object',
            required: ['revokedSessions'],
            properties: { revokedSessions: { type: 'integer', minimum: 0 } },
          }),
          '401': response('Authentication required', errorSchema),
        },
      },
    },
    '/v1/projects': {
      get: {
        tags: ['projects'],
        parameters: [
          {
            name: 'includeArchived',
            in: 'query',
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: {
          '200': response(
            'Projects',
            envelope('projects', { type: 'array', items: projectSchema }),
          ),
          '503': { $ref: '#/components/responses/RateLimitUnavailable' },
        },
      },
      post: {
        tags: ['projects'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
              },
            },
          },
        },
        responses: {
          '201': response('Project created', {
            ...envelope('project', projectSchema),
          }),
          '400': response('Invalid request', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}': {
      get: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Project', envelope('project', projectSchema)),
          '404': response('Not found', errorSchema),
        },
      },
      patch: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Project renamed', envelope('project', projectSchema)),
          '400': response('Invalid request', errorSchema),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/archive': {
      post: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Project archived', envelope('project', projectSchema)),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/restore': {
      post: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Project restored', envelope('project', projectSchema)),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/canvas': {
      get: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Canvas document', envelope('canvas', canvasSchema)),
          '404': response('Not found', errorSchema),
        },
      },
      patch: {
        tags: ['projects'],
        description:
          '保存画布；已有分组时必须显式提交 groups，省略时返回 409 incompatible_canvas。空数组表示解除全部分组。',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { allOf: [canvasSchema, { type: 'object', required: ['revision'] }] },
            },
          },
        },
        responses: {
          '200': response('Canvas saved', envelope('canvas', canvasSchema)),
          '400': response('Invalid canvas', errorSchema),
          '404': response('Project not found', errorSchema),
          '409': response('Revision conflict or incompatible canvas groups', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/export/workflow': {
      get: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Portable workflow JSON download',
            headers: {
              'Content-Disposition': { schema: { type: 'string' } },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WorkflowExport' },
              },
            },
          },
          '404': response('Project not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/export/results': {
      get: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Workflow and generated results ZIP download',
            headers: {
              'Content-Disposition': { schema: { type: 'string' } },
            },
            content: {
              'application/zip': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '404': response('Project not found', errorSchema),
          '409': response('Result asset unavailable', errorSchema),
          '413': response('Export limits exceeded', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/import/workflow': {
      post: {
        tags: ['projects'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WorkflowImportRequest' } },
          },
        },
        responses: {
          '200': response('Workflow imported', {
            $ref: '#/components/schemas/WorkflowImportResponse',
          }),
          '400': response('Invalid workflow import', {
            $ref: '#/components/schemas/WorkflowImportError',
          }),
          '404': response('Project not found', errorSchema),
          '409': response('Revision conflict', {
            $ref: '#/components/schemas/WorkflowImportError',
          }),
        },
      },
    },
    '/v1/projects/{projectId}/models/defaults': {
      get: {
        tags: ['projects'],
        description:
          '需要项目访问权限。defaults 返回本人分组和精确模型的引用；失效选择要求重新选择。',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Project model defaults', projectModelDefaultsResponseSchema),
          '404': response('Project not found', errorSchema),
        },
      },
      patch: {
        tags: ['projects'],
        description: '只更新显式提供的媒体类型，响应与 GET 一致；服务端校验分组引用属于当前用户。',
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  text: {
                    oneOf: [
                      { type: 'string', minLength: 1 },
                      modelSelectionSchema,
                      { type: 'null' },
                    ],
                  },
                  image: {
                    oneOf: [
                      { type: 'string', minLength: 1 },
                      modelSelectionSchema,
                      { type: 'null' },
                    ],
                  },
                  audio: {
                    oneOf: [
                      { type: 'string', minLength: 1 },
                      modelSelectionSchema,
                      { type: 'null' },
                    ],
                  },
                  video: {
                    oneOf: [
                      { type: 'string', minLength: 1 },
                      modelSelectionSchema,
                      { type: 'null' },
                    ],
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Project model defaults updated', projectModelDefaultsResponseSchema),
          '400': response('Invalid project model defaults', errorSchema),
          '404': response('Project not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/runs': {
      get: {
        tags: ['runs'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response('Project run history', {
            type: 'object',
            required: ['runs'],
            properties: { runs: { type: 'array', items: runSchema } },
            additionalProperties: false,
          }),
          '404': response('Project not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/events': {
      get: {
        tags: ['runs'],
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': {
            description: 'Server-sent events stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          '404': response('Project not found', errorSchema),
          '503': { $ref: '#/components/responses/RateLimitUnavailable' },
        },
      },
    },
    '/v1/assets': {
      get: {
        tags: ['assets'],
        parameters: [
          { $ref: '#/components/parameters/AssetProjectId' },
          { $ref: '#/components/parameters/AssetStatus' },
          { $ref: '#/components/parameters/AssetQuery' },
          { $ref: '#/components/parameters/AssetMediaType' },
          { $ref: '#/components/parameters/AssetTags' },
          { $ref: '#/components/parameters/AssetPage' },
          { $ref: '#/components/parameters/AssetPageSize' },
        ],
        responses: {
          '200': response('Asset list', {
            type: 'object',
            required: ['assets', 'total', 'page', 'pageSize'],
            properties: {
              assets: { type: 'array', items: { $ref: '#/components/schemas/Asset' } },
              total: { type: 'integer', minimum: 0 },
              page: { type: 'integer', minimum: 1 },
              pageSize: { type: 'integer', minimum: 1, maximum: 200 },
            },
            additionalProperties: false,
          }),
          '400': response('Invalid asset status', errorSchema),
          '404': response('Project not found', errorSchema),
        },
      },
    },
    '/v1/assets/uploads': {
      post: {
        tags: ['assets'],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        responses: {
          '201': response('Asset uploaded', envelope('asset', assetSchema)),
          '400': response('Invalid upload', errorSchema),
          '413': response('File exceeds upload limit', errorSchema),
          '415': response('Unsupported media type', errorSchema),
        },
      },
    },
    '/v1/assets/uploads/init': {
      post: {
        tags: ['assets'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'mimeType', 'sizeBytes', 'sha256'],
                properties: {
                  name: { type: 'string' },
                  mimeType: { type: 'string' },
                  sizeBytes: { type: 'integer', minimum: 1 },
                  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '201': response('Direct upload initialized', {
            $ref: '#/components/schemas/UploadInitialization',
          }),
          '400': response('Invalid request', errorSchema),
          '415': response('Unsupported media type', errorSchema),
        },
      },
    },
    '/v1/assets/uploads/{uploadId}': {
      put: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/UploadId' }],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          '204': response('Upload bytes accepted'),
          '400': response('Integrity validation failed', errorSchema),
          '404': response('Upload not found', errorSchema),
        },
      },
    },
    '/v1/assets/uploads/complete': {
      post: {
        tags: ['assets'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UploadCompletion' } },
          },
        },
        responses: {
          '201': response('Direct upload completed', envelope('asset', assetSchema)),
          '400': response('Integrity validation failed', errorSchema),
          '404': response('Upload not found', errorSchema),
          '409': response('Upload metadata or content is not ready', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}': {
      patch: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/AssetId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Asset updated', envelope('asset', assetSchema)),
          '400': response('Invalid request', errorSchema),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/content': {
      get: {
        tags: ['assets'],
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          {
            name: 'access_token',
            in: 'query',
            required: false,
            description: 'Short-lived token returned by the access URL endpoint',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Asset content',
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/access-url': {
      post: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/AssetId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  expiresInSeconds: { type: 'integer', minimum: 30, maximum: 900 },
                  version: { type: 'integer', minimum: 1 },
                  derivative: {
                    type: 'string',
                    enum: ['thumbnail', 'poster', 'waveform', 'final_frame'],
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Short-lived asset access URL', {
            type: 'object',
            required: ['url', 'expiresAt'],
            properties: {
              url: { type: 'string', format: 'uri-reference' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
            additionalProperties: false,
          }),
          '400': response('Invalid access URL request', errorSchema),
          '404': response('Asset or version not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/versions': {
      get: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/AssetId' }],
        responses: {
          '200': response('Asset version history', {
            type: 'object',
            required: ['versions'],
            properties: {
              versions: { type: 'array', items: { $ref: '#/components/schemas/AssetVersion' } },
            },
            additionalProperties: false,
          }),
          '404': response('Asset not found', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/prompt-optimizations': {
      post: {
        tags: ['runs'],
        summary: '独立优化未保存的提示词，冻结默认文字模型与凭据',
        description: `由本人分组授权执行，Canvas 不报价或扣款。需要项目访问权限。只发送文本与稳定资源占位符，原始文档保存在 Run 快照。相同幂等键复用已提交任务，包括失败结果。输入或显式模型变化返回 409。不会归档资产或修改画布，通用 retry 不适用。`,
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nodeId', 'skillId', 'mediaType', 'promptDocument', 'idempotencyKey'],
                additionalProperties: false,
                properties: {
                  nodeId: { type: 'string', minLength: 1, maxLength: 512 },
                  skillId: { type: 'string', minLength: 1, maxLength: 160 },
                  skillVersion: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 160,
                    description:
                      '选择时的版本；新任务不匹配则返回 409/PROMPT_SKILL_VERSION_CONFLICT，已有任务不匹配返回 409/idempotency_conflict。省略时使用提交时的版本。',
                  },
                  mediaType: mediaTypeSchema,
                  promptDocument: { $ref: '#/components/schemas/PromptDocument' },
                  idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
                  modelAlias: { type: 'string', minLength: 1, maxLength: 160 },
                  credentialId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          '202': response('新建或复用优化任务', envelope('optimization', promptOptimizationSchema)),
          '400': response('输入、Skill、模型或项目归档状态无效', errorSchema),
          '401': response('未认证', errorSchema),
          '404': response('项目或凭据不存在或无权访问', errorSchema),
          '409': response('幂等身份或 Skill 版本冲突', errorSchema),
          '429': response('项目运行配额已满', errorSchema),
          '503': response('暂时无法提交，可使用相同幂等键重试', errorSchema),
        },
      },
    },
    '/v1/projects/{projectId}/prompt-optimizations/{runId}': {
      get: {
        tags: ['runs'],
        summary: '读取项目独立优化结果；查询不会调用模型',
        parameters: [
          { $ref: '#/components/parameters/ProjectId' },
          { $ref: '#/components/parameters/RunId' },
        ],
        responses: {
          '200': response('优化状态与有效结果', envelope('optimization', promptOptimizationSchema)),
          '401': response('未认证', errorSchema),
          '404': response('项目或优化任务不存在或无权访问', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/versions/{version}/reverse-prompts': {
      get: {
        tags: ['assets'],
        summary: '读取指定资源版本的独立反推任务；查询不会调用模型',
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
          {
            name: 'runId',
            in: 'query',
            required: false,
            schema: { type: 'string', minLength: 1 },
            description: '轮询指定分析；省略时返回最近一次分析。',
          },
        ],
        responses: {
          '200': response('分析任务；没有记录时 analysis 为 null', {
            type: 'object',
            required: ['analysis'],
            additionalProperties: false,
            properties: {
              analysis: { anyOf: [reversePromptAnalysisSchema, { type: 'null' }] },
              defaultModel: {
                ...resolvedModelSelectionSchema,
                description: '采用本人文字默认模型和分组引用，未设置或已失效时要求重新选择。',
              },
            },
          }),
          '400': response('项目或版本参数无效', errorSchema),
          '404': response('项目、资源版本或任务不存在或无权访问', errorSchema),
        },
      },
      post: {
        tags: ['assets'],
        summary: '提交独立反推；默认文字模型含凭据，成功结果不归档为新资源',
        description: `由本人分组授权执行，Canvas 不报价或扣款。仅手动发起分析；相同 idempotencyKey 或仍有运行中的分析时复用任务。失败后必须明确新建分析，普通 Run retry 不适用。`,
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                additionalProperties: false,
                properties: {
                  projectId: { type: 'string', minLength: 1, maxLength: 512 },
                  modelAlias: { type: 'string', minLength: 1, maxLength: 160 },
                  credentialId: { type: 'string', format: 'uuid' },
                  idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
                  automatic: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: {
          '202': response(
            '新建或复用的分析任务',
            envelope('analysis', reversePromptAnalysisSchema),
          ),
          '400': response('模型、资源版本、归档、大小或显式能力限制不满足', errorSchema),
          '404': response('项目、资源版本或凭据不存在或无权访问', errorSchema),
          '409': response('幂等身份冲突或分组权限已变化', errorSchema),
          '429': response('项目运行配额已满', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/versions/{version}/request-prompts': {
      get: {
        tags: ['assets'],
        summary: '读取指定资产版本的生成请求记录，不依赖原画布节点',
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': response('完整请求记录与对应节点时间；导入或手动版本的 records 为空', {
            type: 'object',
            required: ['records'],
            properties: {
              records: {
                type: 'array',
                items: {
                  ...runRequestPromptRecordSchema,
                  required: [...runRequestPromptRecordSchema.required, 'id'],
                  properties: {
                    ...runRequestPromptRecordSchema.properties,
                    id: { type: 'string' },
                  },
                },
              },
              timing: { $ref: '#/components/schemas/NodeTiming' },
              inputSnapshot: {
                type: 'object',
                required: ['text', 'nodeId', 'runId'],
                properties: {
                  text: { type: 'string' },
                  nodeId: { type: 'string' },
                  runId: { type: 'string' },
                },
                additionalProperties: false,
                description: '仅有冻结输入时返回，不能标为最终发送文本。',
              },
              nodeTimings: {
                type: 'object',
                additionalProperties: { $ref: '#/components/schemas/NodeTiming' },
              },
            },
            additionalProperties: false,
          }),
          '400': response('资产版本无效', errorSchema),
          '404': response('资产版本不存在或无权访问', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/versions/{version}/request-prompts/{recordId}': {
      patch: {
        tags: ['assets'],
        summary: '保存手动摘要，不修改真实请求文本或结果归属',
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'recordId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['summary'],
                properties: { summary: { type: 'string', maxLength: 2000 } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('已保存摘要', envelope('record', runRequestPromptRecordSchema)),
          '400': response('摘要或版本无效', errorSchema),
          '404': response('资产版本或请求记录不存在或无权访问', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/versions/{version}/content': {
      get: {
        tags: ['assets'],
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          {
            name: 'version',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'access_token',
            in: 'query',
            required: false,
            description: 'Short-lived token returned by the access URL endpoint',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Asset version content',
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          '400': response('Invalid asset version', errorSchema),
          '404': response('Asset version not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/derivatives/{kind}': {
      get: {
        tags: ['assets'],
        parameters: [
          { $ref: '#/components/parameters/AssetId' },
          {
            name: 'kind',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['thumbnail', 'poster', 'waveform', 'final_frame'] },
          },
          {
            name: 'access_token',
            in: 'query',
            required: false,
            description: 'Short-lived token returned by the access URL endpoint',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Generated media derivative',
            content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': response('Derivative not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/archive': {
      post: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/AssetId' }],
        responses: {
          '200': response('Asset archived', envelope('asset', assetSchema)),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/assets/{assetId}/restore': {
      post: {
        tags: ['assets'],
        parameters: [{ $ref: '#/components/parameters/AssetId' }],
        responses: {
          '200': response('Asset restored', envelope('asset', assetSchema)),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/nodes/{nodeId}/runs': {
      post: {
        tags: ['runs'],
        summary: '提交单节点及其工作流执行',
        description: '使用本人分组模型提交持久任务，受理后由 New API 按实际规则计费。',
        parameters: [
          { $ref: '#/components/parameters/NodeId' },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['projectId'],
                properties: {
                  projectId: { type: 'string', minLength: 1 },
                  modelAlias: { type: 'string', minLength: 1, maxLength: 160 },
                  credentialId: { type: 'string', format: 'uuid' },
                  idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
                  parameters: { type: 'object', additionalProperties: true },
                  promptDocument: { $ref: '#/components/schemas/PromptDocument' },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '202': response(
            '已原子受理或复用原任务；队列故障时由持久 outbox 稍后投递',
            envelope('run', runSchema),
          ),
          '400': response('Invalid request', errorSchema),
          '403': response('Credential selection is not permitted', errorSchema),
          '404': response('Not found', errorSchema),
          '409': response('幂等身份或执行快照冲突', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}': {
      get: {
        tags: ['runs'],
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': response('Run status', envelope('run', runSchema)),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}/retry': {
      post: {
        tags: ['runs'],
        summary: '显式重试已确认失败或取消的运行',
        description: `由本人分组授权执行，Canvas 不报价或扣款。按当前本人分组权限重新校验。已发送但结果未知时禁止重试；反推和优化须在各自入口明确新建。队列恢复使用原任务身份。`,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '202': response('已确认的新重试任务，冻结新的授权上限', envelope('run', runSchema)),
          '400': response('无效执行参数', errorSchema),
          '404': response('Not found', errorSchema),
          '409': response('运行不可重试、原请求待核实或执行身份冲突', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}/recover': {
      post: {
        tags: ['runs'],
        summary: '恢复本人丢失队列消息的原任务',
        description:
          '复用原 Run、冻结快照、执行授权和发送身份，不新建重试任务。已完成或取消的任务不再投递，已有队列任务保持原状。发送结果不明时返回 send_requires_review；已受理视频和归档结果由 Worker 按原身份恢复。尚未发送的 DAG 节点仍须通过当前分组权限校验。',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: false } },
          },
        },
        responses: {
          '202': response('原任务状态；恢复后 Run ID 与 attempt 不变', envelope('run', runSchema)),
          '400': response('恢复请求不接受附加参数', errorSchema),
          '403': response('持久执行授权缺失或已撤销', errorSchema),
          '404': response('任务不存在或无权访问', errorSchema),
          '409': response('发送结果不明、快照冲突或执行后端不支持恢复', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}/cancel': {
      post: {
        tags: ['runs'],
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '202': response('Cancellation requested', envelope('run', runSchema)),
          '404': response('Not found', errorSchema),
          '409': response('Run cannot be cancelled', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}/request-prompts': {
      get: {
        tags: ['runs'],
        description: '列出该次运行留存的请求提示词摘要；不返回请求正文。',
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '200': response('Request prompt summaries without prompt text', {
            type: 'object',
            required: ['records'],
            properties: {
              records: {
                type: 'array',
                items: { $ref: '#/components/schemas/RunRequestPromptSummary' },
              },
            },
          }),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/runs/{runId}/request-prompts/{recordId}': {
      get: {
        tags: ['runs'],
        description: '按记录 ID 读取完整请求提示词，权限沿用所属项目的运行读取边界。',
        parameters: [
          { $ref: '#/components/parameters/RunId' },
          {
            name: 'recordId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': response(
            'Full request prompt record',
            envelope('record', runRequestPromptRecordSchema),
          ),
          '404': response('Not found', errorSchema),
        },
      },
    },
    '/v1/admin/generation-concurrency': {
      get: {
        tags: ['settings'],
        description:
          '仅有状态管理员会话可读取已保存的队列全局 Run 并发；普通用户和静态服务令牌无权访问。首次未初始化或配置丢失返回 503 generation_concurrency_unconfigured，不写入或假称已保存默认值。',
        responses: {
          '200': response(
            '当前全局并发',
            envelope('settings', generationConcurrencySettingsSchema),
          ),
          '401': response('需要有效会话', errorSchema),
          '403': response('仅管理员可以访问', errorSchema),
          '503': response('生成队列配置不可用', errorSchema),
        },
      },
      patch: {
        tags: ['settings'],
        description:
          '管理员确认后持久保存正安全整数，也可初始化或恢复缺失的配置；建议初始值 20 而非最大 20。Worker 在后续调度应用上限，满载时扩容需等待在途任务完成；调低不取消已运行任务。失败时先重新读取，不自动重试写入。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['concurrency'],
                additionalProperties: false,
                properties: { concurrency: generationConcurrencySchema },
              },
            },
          },
        },
        responses: {
          '200': response(
            '已持久保存的全局并发',
            envelope('settings', generationConcurrencySettingsSchema),
          ),
          '400': response('必须是正安全整数且无额外字段', errorSchema),
          '401': response('需要有效会话', errorSchema),
          '403': response('仅管理员可以访问', errorSchema),
          '503': response('无法确认配置写入，请重新读取', errorSchema),
        },
      },
    },
    '/v1/settings/ai': {
      get: {
        tags: ['settings'],
        description: '读取本人模型默认与请求超时；Key、上游授权和密文均不返回客户端。',
        responses: {
          '200': response('AI settings without secrets', {
            type: 'object',
            required: ['settings'],
            properties: {
              settings: { $ref: '#/components/schemas/AiSettings' },
            },
            additionalProperties: false,
          }),
          '403': response('Credential access is not permitted', errorSchema),
        },
      },
      patch: {
        tags: ['settings'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AiSettingsPatch' } },
          },
        },
        responses: {
          '200': response('AI settings updated', {
            type: 'object',
            required: ['settings'],
            properties: {
              settings: { $ref: '#/components/schemas/AiSettings' },
            },
            additionalProperties: false,
          }),
          '400': response('Invalid request', errorSchema),
          '403': response('Credential access is not permitted', errorSchema),
          '404': response('Credential not found', errorSchema),
        },
      },
    },
    '/v1/settings/ai/models/refresh': {
      post: {
        tags: ['settings'],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { credentialId: { type: 'string', format: 'uuid' } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Model catalog refreshed', {
            type: 'object',
            properties: {
              models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
            },
          }),
          '400': response('Invalid credential id', errorSchema),
          '403': response('Credential access is not permitted', errorSchema),
          '404': response('Credential not found', errorSchema),
          '502': response('Provider unavailable', errorSchema),
        },
      },
    },
    '/v1/models': {
      get: {
        tags: ['settings'],
        summary: '读取本人分组模型目录',
        description:
          '使用已验证的 New API 身份读取本人全部纳入组；指定 credentialId 时仍须属于本人。同名模型按分组保留，available=false 时不能执行。',
        parameters: [
          { $ref: '#/components/parameters/CredentialIdQuery' },
          { $ref: '#/components/parameters/MediaTypeQuery' },
        ],
        responses: {
          '200': response('Model catalog', {
            type: 'object',
            properties: {
              models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
            },
          }),
          '400': response('Invalid media type', errorSchema),
          '403': response('Authenticated New API account is required', errorSchema),
          '404': response('Credential not found', errorSchema),
        },
      },
    },
    '/v1/webhooks/newapi': {
      post: {
        tags: ['webhooks'],
        security: [],
        parameters: [
          { $ref: '#/components/parameters/NewApiSignature' },
          { $ref: '#/components/parameters/NewApiEventId' },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
          },
        },
        responses: {
          '202': response('Webhook accepted', {
            type: 'object',
            properties: {
              accepted: { type: 'boolean', const: true },
              eventId: { type: 'string' },
              deduplicated: { type: 'boolean' },
              updatedRunId: { type: 'string' },
            },
            required: ['accepted', 'deduplicated', 'eventId'],
            additionalProperties: false,
          }),
          '400': response('Missing event id', errorSchema),
          '401': response('Invalid signature', errorSchema),
          '503': response('Webhook secret is not configured', errorSchema),
        },
      },
    },
  },
  components: {
    responses: {
      RateLimitUnavailable: {
        description: '全局限流服务不可用；未消费本机额度，请按 Retry-After 延迟重试',
        headers: {
          'Retry-After': {
            description: '下一次尝试前应等待的正整数秒数',
            schema: { type: 'integer', minimum: 1 },
          },
        },
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['error', 'code', 'retryAfterSeconds', 'requestId'],
              properties: {
                error: { type: 'string', const: 'rate limit service unavailable' },
                code: { type: 'string', const: 'rate_limit_unavailable' },
                retryAfterSeconds: { type: 'integer', minimum: 1 },
                requestId: { type: 'string', minLength: 1 },
              },
              additionalProperties: false,
            },
          },
        },
      },
    },
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'canvas_session',
        description: 'New API 回调后签发的 HttpOnly 会话；写操作校验同源 Origin/Fetch Metadata',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT or API token',
        description:
          '浏览器使用 New API 回调签发的 HttpOnly 会话；服务端测试可使用含 sid 的会话 JWT。服务 API token 不能进入账户及管理员接口。',
      },
    },
    parameters: {
      ProjectId: {
        name: 'projectId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      AssetId: {
        name: 'assetId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      NodeId: {
        name: 'nodeId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      RunId: {
        name: 'runId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      UploadId: {
        name: 'uploadId',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
      AssetStatus: {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['ready', 'archived'] },
      },
      AssetProjectId: {
        name: 'projectId',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 1 },
        description: '按当前用户可访问的项目筛选；结果同时包含该用户的个人资源。',
      },
      AssetQuery: { name: 'query', in: 'query', required: false, schema: { type: 'string' } },
      AssetMediaType: {
        name: 'mediaType',
        in: 'query',
        required: false,
        schema: mediaTypeSchema,
        description: '按资源媒体类型筛选。',
      },
      AssetTags: {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 1 },
        description: '按标签筛选；支持逗号分隔标签或重复 tags 参数。',
      },
      AssetPage: {
        name: 'page',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, default: 1 },
        description: '结果页码，从 1 开始。',
      },
      AssetPageSize: {
        name: 'pageSize',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        description: '每页资源数量，范围为 1-200。',
      },
      MediaTypeQuery: { name: 'mediaType', in: 'query', required: false, schema: mediaTypeSchema },
      CredentialIdQuery: {
        name: 'credentialId',
        in: 'query',
        required: false,
        schema: { type: 'string', format: 'uuid' },
      },
      NewApiSignature: {
        name: 'x-newapi-signature',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      },
      NewApiEventId: {
        name: 'x-newapi-event-id',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 1 },
      },
    },
    schemas: {
      ModelSelection: modelSelectionSchema,
      ReversePromptAnalysis: reversePromptAnalysisSchema,
      PromptOptimization: promptOptimizationSchema,
      Asset: assetSchema,
      AssetVersion: {
        type: 'object',
        required: ['id', 'assetId', 'version', 'sizeBytes', 'createdAt', 'contentUrl'],
        properties: {
          id: { type: 'string' },
          assetId: { type: 'string' },
          version: { type: 'integer', minimum: 1 },
          sizeBytes: { type: 'integer', minimum: 0 },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          metadata: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' },
          contentUrl: { type: 'string' },
        },
        additionalProperties: false,
      },
      Project: projectSchema,
      Canvas: canvasSchema,
      ProjectModelDefaults: projectModelDefaultsSchema,
      MentionBinding: mentionBindingSchema,
      PromptMention: promptMentionSchema,
      PromptTextBlock: promptTextBlockSchema,
      PromptBlock: promptBlockSchema,
      PromptDocument: promptDocumentSchema,
      FrozenPromptMention: frozenPromptMentionSchema,
      ResourceMentionFailureReason: resourceMentionFailureReasonSchema,
      ResourceMentionDiagnostic: resourceMentionDiagnosticSchema,
      WorkflowExportResultReference: workflowExportResultReferenceSchema,
      WorkflowExport: workflowExportSchema,
      WorkflowImportRequest: workflowImportRequestSchema,
      WorkflowImportIssue: workflowImportIssueSchema,
      WorkflowImportResponse: workflowImportResponseSchema,
      WorkflowImportError: workflowImportErrorSchema,
      Run: runSchema,
      NodeTiming: runSchema.properties.nodeTimings.additionalProperties,
      RunRequestPromptSummary: runRequestPromptSummarySchema,
      RunRequestPromptRecord: runRequestPromptRecordSchema,
      UploadInitialization: {
        type: 'object',
        required: ['uploadId', 'uploadUrl', 'completeUrl', 'expiresAt'],
        properties: {
          uploadId: { type: 'string' },
          uploadUrl: { type: 'string' },
          completeUrl: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },
      UploadCompletion: {
        type: 'object',
        required: ['uploadId', 'name', 'mimeType', 'sizeBytes', 'sha256'],
        properties: {
          uploadId: { type: 'string' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          sizeBytes: { type: 'integer', minimum: 1 },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        additionalProperties: false,
      },
      AiSettings: {
        type: 'object',
        required: ['configured', 'defaultModels', 'timeoutMs', 'updatedAt'],
        properties: {
          configured: { type: 'boolean' },
          defaultModels: {
            type: 'object',
            properties: {
              text: defaultModelValueSchema,
              image: defaultModelValueSchema,
              audio: defaultModelValueSchema,
              video: defaultModelValueSchema,
            },
            additionalProperties: false,
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: 2147483647,
            default: 900000,
            description:
              '节点生成请求超时及默认视频轮询等待预算，单位毫秒；部署 NEW_API_TIMEOUT_MS 优先。',
          },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
      AiCredentialSummary: {
        type: 'object',
        required: ['id', 'group', 'status', 'updatedAt', 'active'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          version: { type: 'integer', minimum: 1 },
          group: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
          updatedAt: { type: 'string', format: 'date-time' },
          active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      AiSettingsPatch: {
        type: 'object',
        properties: {
          defaultModels: defaultModelUpdateSchema,
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: 2147483647,
            description:
              '新开始执行节点的请求超时及视频轮询等待预算，单位毫秒；省略保留现值，显式 900000 恢复默认。',
          },
        },
        additionalProperties: false,
      },
      Model: {
        type: 'object',
        required: ['id', 'name', 'mediaTypes', 'refreshedAt'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          mediaTypes: { type: 'array', items: mediaTypeSchema },
          credentialId: { type: 'string', format: 'uuid' },
          group: { type: 'string' },
          contract: { type: 'string' },
          available: { type: 'boolean' },
          unavailableReason: { type: 'string' },
          capabilities: { type: 'object', additionalProperties: true },
          limitations: { type: 'object', additionalProperties: true },
          price: { type: 'object', additionalProperties: true },
          refreshedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

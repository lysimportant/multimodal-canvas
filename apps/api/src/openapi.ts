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

const mediaTypeSchema = { type: 'string', enum: ['text', 'image', 'audio', 'video'] } as const;
/** 节点执行模式的公开契约。 */
const nodeModeSchema = { type: 'string', enum: ['source', 'generate', 'transform'] } as const;
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
  description: '项目导入接口接受的工作流文档；expectedRevision 用于乐观并发控制。',
} as const;

/** 导入时单个资源提及产生的问题。 */
const workflowImportIssueSchema = {
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

/** 工作流导入成功响应。 */
const workflowImportResponseSchema = {
  type: 'object',
  required: ['workflow', 'canvas', 'issues'],
  properties: {
    workflow: { $ref: '#/components/schemas/WorkflowExport' },
    canvas: { $ref: '#/components/schemas/Canvas' },
    modelDefaults: { $ref: '#/components/schemas/ProjectModelDefaults' },
    issues: { type: 'array', items: { $ref: '#/components/schemas/WorkflowImportIssue' } },
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
      enum: ['invalid_schema', 'unsupported_schema_version', 'revision_conflict'],
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
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

const response = (description: string, schema?: unknown) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});

const authUserSchema = {
  type: 'object',
  required: ['id', 'email', 'role', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['user', 'admin'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

const authTokenSchema = {
  type: 'object',
  required: ['accessToken', 'tokenType', 'expiresIn', 'expiresAt', 'user'],
  properties: {
    accessToken: { type: 'string' },
    tokenType: { type: 'string', enum: ['Bearer'] },
    expiresIn: { type: 'integer', minimum: 60 },
    expiresAt: { type: 'string', format: 'date-time' },
    user: authUserSchema,
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
      '项目、资源、AI 设置与运行的 REST/SSE API。生产全局限流依赖故障时，登录、注册、SSE 及启用限流的普通 API 返回 503/rate_limit_unavailable，并携带 Retry-After、retryAfterSeconds 和 requestId；额度耗尽仍返回 429。健康检查、Webhook 和已验证的签名资源访问保持独立边界。',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'system' },
    { name: 'projects' },
    { name: 'assets' },
    { name: 'runs' },
    { name: 'settings' },
    { name: 'auth' },
    { name: 'webhooks' },
  ],
  paths: {
    '/health': { get: { tags: ['system'], responses: { '200': response('Healthy') } } },
    '/documentation': {
      get: { tags: ['system'], responses: { '200': response('OpenAPI document') } },
    },
    '/documentation/json': {
      get: { tags: ['system'], responses: { '200': response('OpenAPI document') } },
    },
    '/v1/auth/register': {
      post: {
        tags: ['auth'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8, maxLength: 512, writeOnly: true },
                  displayName: { type: 'string', maxLength: 120 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '201': response('Registered', authTokenSchema),
          '400': response('Invalid request', errorSchema),
          '409': response('Email already registered', errorSchema),
          '503': response('认证或全局限流服务不可用；限流故障附带 Retry-After', errorSchema),
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['auth'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', writeOnly: true },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '200': response('Logged in', authTokenSchema),
          '400': response('Invalid request', errorSchema),
          '401': response('Invalid credentials', errorSchema),
          '503': response('认证或全局限流服务不可用；限流故障附带 Retry-After', errorSchema),
        },
      },
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
          '409': response('Revision conflict', errorSchema),
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
        parameters: [{ $ref: '#/components/parameters/ProjectId' }],
        responses: {
          '200': response(
            'Project model defaults',
            envelope('defaults', projectModelDefaultsSchema),
          ),
          '404': response('Project not found', errorSchema),
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
          '200': response(
            'Project model defaults updated',
            envelope('defaults', projectModelDefaultsSchema),
          ),
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
                  derivative: { type: 'string', enum: ['thumbnail', 'poster', 'waveform'] },
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
            schema: { type: 'string', enum: ['thumbnail', 'poster', 'waveform'] },
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
          '202': response('Run queued', envelope('run', runSchema)),
          '400': response('Invalid request', errorSchema),
          '403': response('Credential selection is not permitted', errorSchema),
          '404': response('Not found', errorSchema),
          '409': response('Idempotency conflict', errorSchema),
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
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          '202': response('Retry queued', envelope('run', runSchema)),
          '404': response('Not found', errorSchema),
          '409': response('Run cannot be retried', errorSchema),
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
    '/v1/settings/ai': {
      get: {
        tags: ['settings'],
        responses: {
          '200': response(
            'AI settings without secrets',
            envelope('settings', { $ref: '#/components/schemas/AiSettings' }),
          ),
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
            required: ['settings', 'credentials'],
            properties: {
              settings: { $ref: '#/components/schemas/AiSettings' },
              credentials: {
                type: 'array',
                items: { $ref: '#/components/schemas/AiCredentialSummary' },
              },
            },
            additionalProperties: false,
          }),
          '400': response('Invalid request', errorSchema),
          '403': response('Credential access is not permitted', errorSchema),
          '404': response('Credential not found', errorSchema),
        },
      },
    },
    '/v1/settings/ai/credentials': {
      get: {
        tags: ['settings'],
        responses: {
          '200': response('Saved AI credentials without secrets', {
            type: 'object',
            required: ['credentials'],
            properties: {
              credentials: {
                type: 'array',
                items: { $ref: '#/components/schemas/AiCredentialSummary' },
              },
            },
            additionalProperties: false,
          }),
        },
      },
      delete: {
        tags: ['settings'],
        responses: {
          '200': response('Credentials removed', {
            type: 'object',
            required: ['settings', 'credentials'],
            properties: {
              settings: { $ref: '#/components/schemas/AiSettings' },
              credentials: {
                type: 'array',
                items: { $ref: '#/components/schemas/AiCredentialSummary' },
              },
            },
            additionalProperties: false,
          }),
        },
      },
    },
    '/v1/settings/ai/credentials/{credentialId}/activate': {
      post: {
        tags: ['settings'],
        parameters: [
          {
            name: 'credentialId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': response('Credential activated', {
            type: 'object',
            required: ['settings', 'credentials'],
            properties: {
              settings: { $ref: '#/components/schemas/AiSettings' },
              credentials: {
                type: 'array',
                items: { $ref: '#/components/schemas/AiCredentialSummary' },
              },
            },
            additionalProperties: false,
          }),
          '400': response('Invalid credential id', errorSchema),
          '404': response('Credential not found', errorSchema),
        },
      },
    },
    '/v1/settings/ai/test': {
      post: {
        tags: ['settings'],
        responses: {
          '200': response('Connection result', {
            type: 'object',
            required: ['result'],
            properties: {
              result: {
                type: 'object',
                required: ['ok'],
                properties: {
                  ok: { type: 'boolean' },
                  modelCount: { type: 'integer', minimum: 0 },
                  error: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          }),
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
          '403': response('Credential access is not permitted', errorSchema),
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
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API token' },
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
        required: ['configured', 'baseUrl', 'defaultModels', 'updatedAt'],
        properties: {
          configured: { type: 'boolean' },
          baseUrl: {
            oneOf: [
              { type: 'string', const: '' },
              { type: 'string', format: 'uri' },
            ],
          },
          keyFingerprint: { type: 'string', minLength: 1 },
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
          updatedAt: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
      AiCredentialSummary: {
        type: 'object',
        required: ['id', 'baseUrl', 'keyFingerprint', 'updatedAt', 'active'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          baseUrl: { type: 'string', format: 'uri' },
          keyFingerprint: { type: 'string', minLength: 1 },
          updatedAt: { type: 'string', format: 'date-time' },
          active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      AiSettingsPatch: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', format: 'uri' },
          apiKey: { type: 'string', minLength: 1, writeOnly: true },
          defaultModels: {
            type: 'object',
            properties: {
              text: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
              image: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
              audio: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
              video: { oneOf: [defaultModelValueSchema, { type: 'null' }] },
            },
            additionalProperties: false,
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
          capabilities: { type: 'object', additionalProperties: true },
          limitations: { type: 'object', additionalProperties: true },
          price: { type: 'object', additionalProperties: true },
          refreshedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

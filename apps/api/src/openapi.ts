const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
    issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

const mediaTypeSchema = { type: 'string', enum: ['text', 'image', 'audio', 'video'] } as const;
const assetSchema = {
  type: 'object',
  required: ['id', 'name', 'mediaType', 'mimeType', 'sizeBytes', 'status', 'contentUrl', 'tags'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    mediaType: mediaTypeSchema,
    mimeType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { type: 'string', enum: ['ready', 'archived'] },
    contentUrl: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    archivedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const projectSchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
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
    data: {
      type: 'object',
      required: ['label', 'mediaType', 'mode'],
      properties: {
        label: { type: 'string' },
        mediaType: mediaTypeSchema,
        mode: { type: 'string', enum: ['source', 'generate', 'transform'] },
        assetId: { type: 'string' },
        modelAlias: { type: 'string' },
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
    snapshot: { type: 'object', additionalProperties: true },
    result: { type: 'object', additionalProperties: true },
    providerJob: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
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

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Multimodal Canvas API',
    version: '0.1.0',
    description: 'REST and SSE API for projects, assets, AI settings, and runs.',
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
          '503': response('Authentication unavailable', errorSchema),
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
          '503': response('Authentication unavailable', errorSchema),
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
        responses: {
          '200': response(
            'Projects',
            envelope('projects', { type: 'array', items: projectSchema }),
          ),
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
        },
      },
    },
    '/v1/assets': {
      get: {
        tags: ['assets'],
        parameters: [
          { $ref: '#/components/parameters/AssetStatus' },
          { $ref: '#/components/parameters/AssetQuery' },
        ],
        responses: {
          '200': response('Asset list', {
            type: 'object',
            required: ['assets'],
            properties: { assets: { type: 'array', items: assetSchema } },
          }),
          '400': response('Invalid asset status', errorSchema),
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
                  idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
                  parameters: { type: 'object', additionalProperties: true },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          '202': response('Run queued', envelope('run', runSchema)),
          '400': response('Invalid request', errorSchema),
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
          '200': response(
            'AI settings updated',
            envelope('settings', { $ref: '#/components/schemas/AiSettings' }),
          ),
          '400': response('Invalid request', errorSchema),
        },
      },
    },
    '/v1/settings/ai/credentials': {
      delete: {
        tags: ['settings'],
        responses: {
          '200': response(
            'Credentials removed',
            envelope('settings', { $ref: '#/components/schemas/AiSettings' }),
          ),
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
        responses: {
          '200': response('Model catalog refreshed', {
            type: 'object',
            properties: {
              models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
            },
          }),
          '502': response('Provider unavailable', errorSchema),
        },
      },
    },
    '/v1/models': {
      get: {
        tags: ['settings'],
        parameters: [{ $ref: '#/components/parameters/MediaTypeQuery' }],
        responses: {
          '200': response('Model catalog', {
            type: 'object',
            properties: {
              models: { type: 'array', items: { $ref: '#/components/schemas/Model' } },
            },
          }),
          '400': response('Invalid media type', errorSchema),
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
      AssetQuery: { name: 'query', in: 'query', required: false, schema: { type: 'string' } },
      MediaTypeQuery: { name: 'mediaType', in: 'query', required: false, schema: mediaTypeSchema },
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
              text: { type: 'string', minLength: 1 },
              image: { type: 'string', minLength: 1 },
              audio: { type: 'string', minLength: 1 },
              video: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
          updatedAt: { type: 'string', format: 'date-time' },
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
              text: { type: ['string', 'null'], minLength: 1 },
              image: { type: ['string', 'null'], minLength: 1 },
              audio: { type: ['string', 'null'], minLength: 1 },
              video: { type: ['string', 'null'], minLength: 1 },
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
          capabilities: { type: 'object', additionalProperties: true },
          limitations: { type: 'object', additionalProperties: true },
          price: { type: 'object', additionalProperties: true },
          refreshedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

/** 邮件验证响应不包含验证码，accepted 仅表示 SMTP 接收。 */
export const verificationResponseSchema = {
  type: 'object',
  required: ['verificationRequired', 'email', 'delivery'],
  properties: {
    verificationRequired: { type: 'boolean', const: true },
    email: { type: 'string', format: 'email' },
    delivery: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['pending', 'accepted', 'failed'] },
      },
    },
  },
} as const;

/** 为后台和账户接口生成完整路由索引；业务 JSON 字段白名单由相同文档说明。 */
export function accountOpenApiPaths(user: unknown, token: unknown, asset: unknown) {
  const string = { type: 'string' };
  const email = { type: 'string', format: 'email' };
  const password = {
    type: 'string',
    minLength: 8,
    maxLength: 512,
    writeOnly: true,
    description: '至少 8 个字符且 UTF-8 编码不超过 512 字节',
  };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } };
  const paging = [
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    {
      name: 'pageSize',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    },
  ];
  const profile = {
    displayName: { type: 'string', minLength: 1, maxLength: 120 },
    bio: { type: 'string', maxLength: 500 },
    avatarUrl: {
      type: 'string',
      maxLength: 2048,
      description: 'HTTPS 头像地址、已上传资源路径或空字符串',
    },
  };
  const baseAsset = asset as { required?: string[]; properties?: Record<string, unknown> };
  const managementAsset = {
    ...baseAsset,
    type: 'object',
    required: [
      ...(baseAsset.required ?? []),
      'ownerId',
      'projectId',
      'createdAt',
      'updatedAt',
      'source',
    ],
    properties: {
      ...(baseAsset.properties ?? {}),
      ownerId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      source: { type: 'string', enum: ['upload', 'generated'] },
    },
  };
  /** 创建明确白名单的请求体或响应对象。 */
  const object = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  /** 请求体始终使用 JSON，不在 URL 放置密码和验证码。 */
  const body = (properties: Record<string, unknown>, required: string[] = []) => ({
    required: true,
    content: { 'application/json': { schema: object(properties, required) } },
  });
  /** 统一认证、验证、重复提交、限流和基础设施失败的公开响应。 */
  const operation = (
    summary: string,
    schema: unknown = { type: 'object' },
    status = '200',
    publicRoute = false,
  ) => ({
    tags: [summary.startsWith('管理员') ? 'admin' : 'account'],
    summary,
    ...(publicRoute ? { security: [] } : {}),
    responses: {
      [status]: { description: summary, content: { 'application/json': { schema } } },
      '400': { description: '输入或验证码不符合要求' },
      '401': { description: '需有效账户会话' },
      '403': { description: '权限不足或账户禁用' },
      '404': { description: '对象不存在或无权访问' },
      '409': { description: '邮箱重复、初始化已完成或最后管理员保护' },
      '429': { description: '超过请求频率或 60 秒重发间隔' },
      '503': { description: '邮件、持久化或账户服务未配置或暂不可用' },
    },
  });
  /** 列表响应保留当前分页和已授权结果总数。 */
  const page = (key: string, item: unknown) =>
    object(
      {
        [key]: { type: 'array', items: item },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
      },
      [key, 'page', 'pageSize', 'total'],
    );
  /** 管理员和普通用户复用资源字段，管理员请求必须指定单个用户组。 */
  const resources = (admin: boolean) => ({
    get: {
      ...operation(
        admin ? '管理员按单个用户分组列出资源' : '列出自己的资源',
        page('assets', managementAsset),
      ),
      parameters: [
        ...paging,
        ...['query', 'projectId', 'mediaType', 'status', 'source', 'tags'].map((name) => ({
          name,
          in: 'query',
          schema: string,
        })),
        ...(admin
          ? [
              {
                name: 'ownerId',
                in: 'query',
                required: true,
                description: '用户 ID；历史待归属组为 unassigned',
                schema: string,
              },
            ]
          : []),
      ],
    },
  });
  const resourceDetail = {
    parameters: [id],
    get: operation(
      '查看已授权资源及版本',
      object(
        {
          asset: managementAsset,
          versions: {
            type: 'array',
            items: { type: 'object', description: '版本元数据，不包含对象存储 contentKey' },
          },
          project: { type: 'object' },
        },
        ['asset', 'versions'],
      ),
    ),
    patch: {
      ...operation('编辑已授权资源并记录审计', object({ asset: managementAsset }, ['asset'])),
      requestBody: body({
        name: { type: 'string', minLength: 1, maxLength: 240 },
        tags: {
          type: 'array',
          maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 64 },
        },
        status: { type: 'string', enum: ['ready', 'archived'] },
      }),
    },
  };
  const resourceContent = {
    parameters: [id],
    get: {
      ...operation('鉴权后读取资源字节，支持单段 Range'),
      parameters: [
        { name: 'version', in: 'query', schema: { type: 'integer', minimum: 1 } },
        {
          name: 'derivative',
          in: 'query',
          schema: { type: 'string', enum: ['thumbnail', 'poster', 'waveform'] },
        },
        { name: 'Range', in: 'header', schema: string },
      ],
      responses: {
        '200': {
          description: '完整资源字节',
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        '206': { description: '部分内容' },
        '401': { description: '未认证' },
        '403': { description: '仅管理员' },
        '404': { description: '资源不存在或不可访问' },
        '416': { description: '字节范围无效' },
      },
    },
  };
  return {
    '/v1/admin/bootstrap': {
      get: operation(
        '查询永久初始化状态；已有管理员不会再次开放',
        object(
          {
            initialized: { type: 'boolean' },
            mailConfigured: { type: 'boolean' },
            setupTokenRequired: { type: 'boolean' },
          },
          ['initialized', 'mailConfigured', 'setupTokenRequired'],
        ),
        '200',
        true,
      ),
    },
    '/v1/admin/bootstrap/request': {
      post: {
        ...operation(
          '管理员首次初始化发送邮箱验证码；无部署凭据仅允许回环来源',
          verificationResponseSchema,
          '202',
          true,
        ),
        requestBody: body(
          {
            email,
            password,
            displayName: profile.displayName,
            setupToken: { type: 'string', writeOnly: true, maxLength: 1024 },
          },
          ['email', 'password'],
        ),
      },
    },
    '/v1/auth/verify': {
      post: {
        ...operation('原子消费验证码并签发会话；email 用途要求本人登录', token, '200', true),
        requestBody: body(
          {
            email,
            code: { type: 'string', pattern: '^\\d{6}$', writeOnly: true },
            purpose: {
              type: 'string',
              enum: ['bootstrap', 'register', 'invite', 'email', 'reset'],
            },
            password,
          },
          ['email', 'code', 'purpose'],
        ),
      },
    },
    '/v1/auth/verification/resend': {
      post: {
        ...operation(
          '60 秒后重发注册、邀请或初始化验证码',
          verificationResponseSchema,
          '202',
          true,
        ),
        requestBody: body(
          { email, purpose: { type: 'string', enum: ['bootstrap', 'register', 'invite'] } },
          ['email', 'purpose'],
        ),
      },
    },
    '/v1/auth/refresh': {
      post: operation('有效会话续期；七天绝对期限不延长，业务请求不自动重放', token),
    },
    '/v1/account/profile': {
      get: operation('查看个人资料', object({ user }, ['user'])),
      patch: {
        ...operation('保存个人资料', object({ user }, ['user'])),
        requestBody: body(profile),
      },
    },
    '/v1/account/password': {
      post: {
        ...operation('修改密码并撤销旧会话，返回新会话', token),
        requestBody: body(
          { currentPassword: { ...string, writeOnly: true }, newPassword: password },
          ['currentPassword', 'newPassword'],
        ),
      },
    },
    '/v1/account/email/request': {
      post: {
        ...operation('申请邮箱绑定，验证完成前保留旧邮箱', verificationResponseSchema, '202'),
        requestBody: body({ email, currentPassword: { ...string, writeOnly: true } }, [
          'email',
          'currentPassword',
        ]),
      },
    },
    '/v1/account/sessions': {
      get: operation(
        '查看自己的有效登录会话',
        object(
          {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: string,
                  current: { type: 'boolean' },
                  createdAt: string,
                  lastUsedAt: string,
                  expiresAt: string,
                },
              },
            },
          },
          ['sessions'],
        ),
      ),
    },
    '/v1/account/sessions/{id}': {
      parameters: [id],
      delete: operation(
        '撤销指定自己的登录会话',
        object({ revoked: { type: 'boolean', const: true } }, ['revoked']),
      ),
    },
    '/v1/account/sessions/revoke-others': {
      post: operation(
        '保留当前会话并退出其他会话',
        object({ revokedSessions: { type: 'integer' } }, ['revokedSessions']),
      ),
    },
    '/v1/admin/users': {
      get: {
        ...operation('管理员搜索和筛选用户', page('users', user)),
        parameters: [
          ...paging,
          ...['query', 'status'].map((name) => ({ name, in: 'query', schema: string })),
        ],
      },
      post: {
        ...operation(
          '管理员创建待激活普通用户并发送邮件',
          { allOf: [verificationResponseSchema, { type: 'object', properties: { user } }] },
          '202',
        ),
        requestBody: body({ email, displayName: profile.displayName, bio: profile.bio }, ['email']),
      },
    },
    '/v1/admin/users/{id}': {
      parameters: [id],
      get: operation(
        '管理员查看用户资料、项目和用量',
        object(
          {
            user,
            projects: { type: 'array', items: { type: 'object' } },
            stats: object({
              resourceCount: { type: 'integer' },
              storageBytes: { type: 'integer' },
              runCount: { type: 'integer' },
            }),
          },
          ['user', 'projects', 'stats'],
        ),
      ),
      patch: {
        ...operation(
          '管理员编辑资料及禁用恢复；禁止禁用最后一位管理员',
          object({ user }, ['user']),
        ),
        requestBody: body({ ...profile, status: { type: 'string', enum: ['active', 'disabled'] } }),
      },
    },
    '/v1/admin/users/{id}/invite': {
      parameters: [id],
      post: operation('管理员重发用户激活邀请', verificationResponseSchema, '202'),
    },
    '/v1/admin/users/{id}/password-reset': {
      parameters: [id],
      post: operation('管理员发起邮件密码重置', verificationResponseSchema, '202'),
    },
    '/v1/admin/users/{id}/email': {
      parameters: [id],
      post: {
        ...operation(
          '管理员申请用户邮箱验证，不能跳过所有权验证',
          verificationResponseSchema,
          '202',
        ),
        requestBody: body({ email, currentPassword: { ...string, writeOnly: true } }, ['email']),
      },
    },
    '/v1/admin/resource-groups': {
      get: operation(
        '管理员按用户展示资源分组，包含历史待归属组',
        object(
          {
            groups: {
              type: 'array',
              items: object({
                ownerId: { type: ['string', 'null'] },
                user: { anyOf: [user, { type: 'null' }] },
                resourceCount: { type: 'integer' },
                storageBytes: { type: 'integer' },
              }),
            },
          },
          ['groups'],
        ),
      ),
    },
    '/v1/admin/resources': resources(true),
    '/v1/account/resources': resources(false),
    '/v1/admin/resources/{id}': resourceDetail,
    '/v1/account/resources/{id}': resourceDetail,
    '/v1/admin/resources/{id}/content': resourceContent,
    '/v1/account/resources/{id}/content': resourceContent,
    '/v1/admin/runs': {
      get: {
        ...operation(
          '管理员查看跨用户运行任务，不自动重试收费请求',
          page('runs', { type: 'object' }),
        ),
        parameters: [
          ...paging,
          ...['ownerId', 'projectId', 'status'].map((name) => ({
            name,
            in: 'query',
            schema: string,
          })),
        ],
      },
    },
    '/v1/account/runs': {
      get: {
        ...operation('查看自己的运行任务', page('runs', { type: 'object' })),
        parameters: [
          ...paging,
          ...['projectId', 'status'].map((name) => ({ name, in: 'query', schema: string })),
        ],
      },
    },
    '/v1/admin/audit': {
      get: {
        ...operation('管理员查询不可修改的脱敏操作审计', page('events', { type: 'object' })),
        parameters: [
          ...paging,
          ...['query', 'ownerId'].map((name) => ({ name, in: 'query', schema: string })),
        ],
      },
    },
    '/v1/admin/overview': { get: operation('管理员查看真实账户、资源、运行及邮件统计') },
    '/v1/admin/system': { get: operation('管理员查看存储、队列和脱敏 SMTP 配置与投递状态') },
  };
}

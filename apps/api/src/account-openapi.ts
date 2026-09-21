/** 为后台和账户接口生成完整路由索引；业务 JSON 字段白名单由相同文档说明。 */
export function accountOpenApiPaths(user: unknown, asset: unknown) {
  const string = { type: 'string' };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } };
  const paging = [
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    {
      name: 'pageSize',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    },
  ];
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
    '/v1/auth/newapi/start': {
      get: {
        summary: '开始五分钟的一次性 New API 授权',
        tags: ['auth'],
        security: [],
        parameters: [
          {
            name: 'next',
            in: 'query',
            schema: { type: 'string', maxLength: 2048 },
            description: '登录后的站内路径，服务端白名单过滤',
          },
          {
            name: 'prompt',
            in: 'query',
            schema: { type: 'string', enum: ['select_account'] },
            description: '显式换号时提示上游选择账号；GET 不退出或撤销当前账号',
          },
        ],
        responses: {
          '302': { description: '设置登录事务 Cookie 并跳转固定 New API 登录站点' },
          '400': { description: '返回路径或账号选择参数无效' },
          '503': { description: '账号服务不可用' },
        },
      },
    },
    '/v1/auth/newapi/callback': {
      get: {
        summary: '消费浏览器绑定的 state 和 PKCE 授权码',
        tags: ['auth'],
        security: [],
        parameters: [
          { name: 'state', in: 'query', required: true, schema: string },
          {
            name: 'code',
            in: 'query',
            schema: string,
            description: '登录成功时的一次性码，与 error 二选一',
          },
          {
            name: 'error',
            in: 'query',
            schema: { type: 'string', enum: ['access_denied'] },
            description: '取消登录，与 code 二选一',
          },
        ],
        responses: {
          '302': {
            description: '成功后设置 HttpOnly 会话；取消时清除登录事务 Cookie 并返回站内登录页',
          },
          '400': { description: '参数无效、过期、重放或浏览器绑定不匹配' },
        },
      },
    },
    '/v1/account/newapi': { get: operation('读取本人授权和全部纳入分组状态；不含 Key 或尾号') },
    '/v1/account/newapi/sync': {
      post: operation('用原操作身份同步本人全部纳入组，单组失败不影响成功组'),
    },
    '/v1/account/newapi/revoke': {
      post: operation(
        '持久撤销本地会话和执行授权，远端故障保留撤销恢复意图',
        object({ revoked: { type: 'boolean', const: true } }, ['revoked']),
      ),
    },
    '/v1/admin/resource-owners/{id}': {
      parameters: [id],
      get: operation(
        '管理员读取资源主人与项目统计',
        object(
          {
            user,
            projects: { type: 'array', items: { type: 'object' } },
            stats: { type: 'object' },
          },
          ['user', 'projects', 'stats'],
        ),
      ),
    },
    '/v1/auth/refresh': {
      post: operation(
        '上游复核后轮换 HttpOnly Cookie；绝对期限不延长，业务请求不重放',
        object({ user, expiresAt: { type: 'string', format: 'date-time' } }, ['user', 'expiresAt']),
      ),
    },
    '/v1/account/profile': {
      get: operation('查看个人资料', object({ user }, ['user'])),
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
    '/v1/admin/overview': { get: operation('管理员查看资源、运行与身份统计') },
    '/v1/admin/system': { get: operation('管理员查看存储、队列与服务状态') },
  };
}

/** Skill 响应包含服务端补全的内置标记、启用状态与当前修订号。 */
export const promptSkillSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'category',
    'description',
    'instruction',
    'version',
    'builtin',
    'enabled',
    'revision',
  ],
  properties: {
    id: { type: 'string', description: '内置目录 ID 或服务器生成的 custom_UUID' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    category: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 2_000 },
    instruction: {
      type: 'string',
      minLength: 1,
      maxLength: 12_000,
      description: '保留用户原文；不允许全空白',
    },
    version: { type: 'string', description: '内置定义版本，或自定义项的 1.0.<revision-1>' },
    builtin: { type: 'boolean' },
    enabled: { type: 'boolean' },
    revision: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
  },
} as const;

/** 不接受 id、ownerId、builtin、version，复制内置项时只提交这些定义字段。 */
const writableFields = {
  name: promptSkillSchema.properties.name,
  category: promptSkillSchema.properties.category,
  description: promptSkillSchema.properties.description,
  instruction: promptSkillSchema.properties.instruction,
  enabled: { type: 'boolean', default: true },
};
/** 业务错误可携带当前修订号，但不暴露其他用户记录或指令。 */
const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    revision: promptSkillSchema.properties.revision,
  },
};

/** 返回可展开到主文档 paths 的片段；认证沿用 bearerAuth 并要求真实用户归属。 */
export function promptSkillOpenApiPaths() {
  /** 包装标准 JSON 响应；204 删除响应不使用此包装。 */
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  /** 接口均为用户私有；仅认证关闭的开发环境可使用本地共享身份。 */
  const operation = (summary: string) => ({
    tags: ['prompt-skills'],
    summary,
    security: [{ bearerAuth: [] }],
    description: '以已认证用户为归属，跨项目与节点共用；服务令牌没有用户身份时不可访问。',
  });
  /** 输入错误、只读内置项和并发冲突均有明确 HTTP 状态。 */
  const errors = {
    '400': { description: '输入字段或修订号无效', content: json(errorSchema) },
    '401': { description: '需要已认证用户身份', content: json(errorSchema) },
    '403': {
      description: '服务令牌缺少用户身份，或试图修改内置 Skill 定义',
      content: json(errorSchema),
    },
    '404': { description: 'Skill 不存在或不属于当前用户', content: json(errorSchema) },
    '409': { description: '修订号冲突，请重新读取后重试', content: json(errorSchema) },
    '500': { description: '持久化失败，变更未提交', content: json(errorSchema) },
  };
  /** 单条写入响应中的身份和修订号由服务器返回。 */
  const skillResponse = {
    type: 'object',
    required: ['skill'],
    additionalProperties: false,
    properties: { skill: promptSkillSchema },
  };
  /** 自定义项允许更新定义；内置项只允许 enabled 和 revision。 */
  const updateProperties = {
    ...writableFields,
    enabled: { type: 'boolean' },
    revision: { type: 'integer', minimum: 1, maximum: 2_147_483_646 },
  };
  return {
    '/v1/prompt-skills': {
      get: {
        ...operation('列出用户 Skill 库，包含禁用项'),
        responses: {
          '200': {
            description: '内置定义与该用户启用状态、自定义项合并后的列表',
            content: json({
              type: 'object',
              required: ['skills'],
              additionalProperties: false,
              properties: { skills: { type: 'array', items: promptSkillSchema } },
            }),
          },
          '401': errors['401'],
          '403': errors['403'],
          '500': errors['500'],
        },
      },
      post: {
        ...operation('新建自定义 Skill，或复制内置定义'),
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            additionalProperties: false,
            required: ['name', 'category', 'description', 'instruction'],
            properties: writableFields,
          }),
        },
        responses: {
          '201': { description: '已创建，revision 为 1', content: json(skillResponse) },
          '400': errors['400'],
          '401': errors['401'],
          '403': errors['403'],
          '500': errors['500'],
        },
      },
    },
    '/v1/prompt-skills/{skillId}': {
      parameters: [
        {
          name: 'skillId',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 160 },
        },
      ],
      patch: {
        ...operation('按修订号更新自定义 Skill 或内置项启用状态'),
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            additionalProperties: false,
            minProperties: 2,
            required: ['revision'],
            properties: updateProperties,
            description:
              '内置项仅接受 enabled 和 revision；至少一个可写字段，自定义项每次成功更新递增修订号及版本。',
          }),
        },
        responses: {
          '200': { description: '已更新，返回新修订号', content: json(skillResponse) },
          ...errors,
        },
      },
      delete: {
        ...operation('按修订号删除自定义 Skill'),
        parameters: [
          {
            name: 'revision',
            in: 'query',
            required: true,
            schema: promptSkillSchema.properties.revision,
          },
        ],
        responses: {
          '204': { description: '已删除，无响应体；原 ID 不可通过更新恢复' },
          ...errors,
        },
      },
    },
  };
}

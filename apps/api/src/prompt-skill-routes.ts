import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PromptSkillStoreError,
  type CreatePromptSkillInput,
  type PromptSkillStore,
  type UpdatePromptSkillInput,
} from './prompt-skill-store';

/** 认证由 app 的既有 middleware 执行；回调必须拒绝没有用户身份的服务令牌。 */
export type PromptSkillRoutesOptions = {
  store: PromptSkillStore;
  /** 仅认证关闭的本地环境可返回 __local__，不得从请求体、查询或路径读取 ownerId。 */
  ownerId: (request: FastifyRequest) => string;
};

/** 删除必须携带规范十进制修订号，拒绝省略、零、负数、重复和非整数。 */
const deleteQuerySchema = z
  .object({
    revision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().max(2_147_483_647)),
  })
  .strict();
/** 标识只作为当前用户库的精确查找键，不允许空标识。 */
const paramsSchema = z.object({ skillId: z.string().min(1).max(160) }).strict();

/** 注册用户共享 Skill CRUD；错误不输出指令，未知基础设施故障交给 app 的错误边界。 */
export function registerPromptSkillRoutes(
  app: FastifyInstance,
  options: PromptSkillRoutesOptions,
): void {
  /** 统一返回业务状态码并保留当前修订号，方便客户端处理并发更新。 */
  const handler =
    (operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try {
        return await operation(request, reply);
      } catch (error) {
        if (error instanceof z.ZodError)
          return reply.code(400).send({ code: 'invalid_input', error: 'Skill 输入字段不符合要求' });
        if (error instanceof PromptSkillStoreError)
          return reply.code(error.statusCode).send({
            code: error.code,
            error: error.message,
            ...(error.revision === undefined ? {} : { revision: error.revision }),
          });
        throw error;
      }
    };

  app.get(
    '/v1/prompt-skills',
    handler(async (request) => ({
      skills: await options.store.list(options.ownerId(request)),
    })),
  );
  app.post(
    '/v1/prompt-skills',
    handler(async (request, reply) => {
      const skill = await options.store.create(
        options.ownerId(request),
        request.body as CreatePromptSkillInput,
      );
      return reply.code(201).send({ skill });
    }),
  );
  app.patch(
    '/v1/prompt-skills/:skillId',
    handler(async (request) => {
      const ownerId = options.ownerId(request);
      const { skillId } = paramsSchema.parse(request.params);
      return {
        skill: await options.store.update(ownerId, skillId, request.body as UpdatePromptSkillInput),
      };
    }),
  );
  app.delete(
    '/v1/prompt-skills/:skillId',
    handler(async (request, reply) => {
      const ownerId = options.ownerId(request);
      const { skillId } = paramsSchema.parse(request.params);
      const { revision } = deleteQuerySchema.parse(request.query);
      await options.store.delete(ownerId, skillId, revision);
      return reply.code(204).send();
    }),
  );
}

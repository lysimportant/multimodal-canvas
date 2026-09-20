import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { CredentialEncryptionError } from '@multimodal-canvas/credential-crypto';
import type { AuthenticatedSession } from './auth-service';
import { NewApiSquareError, type PrismaNewApiSquare } from './newapi-square';

/** 广场读操作需登录，配置/草稿/写回需真实管理员会话；服务令牌不能代替用户授权。 */
export function registerNewApiSquareRoutes(
  app: FastifyInstance,
  options: {
    square?: PrismaNewApiSquare;
    sessions: WeakMap<object, AuthenticatedSession>;
  },
): void {
  /** 固定错误响应不返回上游正文、请求值或凭据。 */
  const handler =
    (
      admin: boolean,
      operation: (
        service: PrismaNewApiSquare,
        request: FastifyRequest,
        reply: FastifyReply,
        actorId: string,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      const session = options.sessions.get(request);
      if (!session) return reply.code(401).send({ code: 'session_required', error: '请先登录' });
      if (admin && session.user.role !== 'admin')
        return reply.code(403).send({ code: 'admin_required', error: '仅管理员可以操作' });
      if (!options.square)
        return reply.code(503).send({ code: 'square_unavailable', error: '请先配置持久数据库' });
      try {
        return await operation(options.square, request, reply, session.user.id);
      } catch (error) {
        if (error instanceof CredentialEncryptionError)
          return reply.code(503).send({
            code: 'authorization_unavailable',
            error: '管理授权无法解密，请检查服务端密钥或重新授权',
          });
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code)
        )
          return reply
            .code(409)
            .send({ code: 'draft_conflict', error: '来源或草稿已被修改，请刷新后重试' });
        if (error instanceof NewApiSquareError)
          return reply.code(error.status).send({ code: error.code, error: error.message });
        if (error instanceof z.ZodError)
          return reply
            .code(400)
            .send({ code: 'invalid_square_data', error: '输入或上游价格格式无效，现有数据已保留' });
        throw error;
      }
    };
  app.get(
    '/v1/model-marketplace/newapi',
    handler(false, async (service) => service.published()),
  );
  app.get(
    '/v1/admin/model-marketplace/newapi',
    handler(true, async (service) => service.admin()),
  );
  app.put(
    '/v1/admin/model-marketplace/newapi',
    handler(true, async (service, request) => service.configure(request.body)),
  );
  app.post(
    '/v1/admin/model-marketplace/newapi/sync',
    handler(true, async (service, request) => {
      const { sourceRevision } = z
        .object({ sourceRevision: z.number().int().positive() })
        .strict()
        .parse(request.body);
      return service.sync(sourceRevision);
    }),
  );
  app.get(
    '/v1/admin/model-marketplace/newapi/price',
    handler(true, async (service, request) => {
      const { modelName } = z
        .object({ modelName: z.string().min(1).max(512) })
        .strict()
        .parse(request.query);
      return service.edit(modelName);
    }),
  );
  app.put(
    '/v1/admin/model-marketplace/newapi/price',
    handler(true, async (service, request, _reply, actorId) =>
      service.saveDraft(request.body, actorId),
    ),
  );
  app.delete(
    '/v1/admin/model-marketplace/newapi/price',
    handler(true, async (service, request) => {
      const { modelName, revision, sourceRevision } = z
        .object({
          modelName: z.string().min(1).max(512),
          revision: z.coerce.number().int().positive(),
          sourceRevision: z.coerce.number().int().positive(),
        })
        .strict()
        .parse(request.query);
      return service.discard(modelName, revision, sourceRevision);
    }),
  );
}

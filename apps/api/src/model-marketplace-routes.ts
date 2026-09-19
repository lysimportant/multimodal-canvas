import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthenticatedSession } from './auth-service';
import {
  ModelMarketplaceError,
  marketplaceListSchema,
  type ModelMarketplace,
} from './model-marketplace';

/** 模型路由只信任应用认证层验证过的真实账户会话。 */
export type ModelMarketplaceRoutesOptions = {
  marketplace?: ModelMarketplace;
  sessions: WeakMap<object, AuthenticatedSession>;
};
/** UUID 路径验证在进入 Prisma 前执行，避免数据库转换错误泄露到客户端。 */
const modelPathSchema = z.object({ id: z.string().uuid() }).strict();
/** 版本列表固定按单个商品分页，不允许无界导出全部定价。 */
const versionListSchema = marketplaceListSchema.pick({ page: true, pageSize: true }).strict();
/** 同步连接由管理员明确指定，不回退到另一条活动连接。 */
const syncSchema = z.object({ credentialId: z.string().uuid() }).strict();

/**
 * 注册公开商品目录与管理员模型、绑定、价格和候选同步路由。
 * 公开表示不含内部信息；读取仍需登录，管理写入必须来自真实管理员会话。
 */
export function registerModelMarketplaceRoutes(
  app: FastifyInstance,
  options: ModelMarketplaceRoutesOptions,
): void {
  /** 统一业务错误响应，输入错误不包含原始敏感请求字段。 */
  const handler =
    (operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try {
        return await operation(request, reply);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            code: 'invalid_input',
            error: '输入字段不符合要求',
            issues: error.issues.map(({ path, message }) => ({ path, message })),
          });
        }
        if (error instanceof ModelMarketplaceError) {
          return reply.code(error.status).send({ code: error.code, error: error.message });
        }
        throw error;
      }
    };
  /** 服务令牌、匿名模式和未核验 JWT 角色均不具有后台权限。 */
  const session = (request: FastifyRequest, admin = false) => {
    const current = options.sessions.get(request);
    if (!current) throw new ModelMarketplaceError('authentication_required', '请先登录', 401);
    if (admin && current.user.role !== 'admin')
      throw new ModelMarketplaceError('admin_required', '仅管理员可以访问', 403);
    return current;
  };
  /** 缺少持久化账务数据库时明确不可用，不能隐式退回临时商品库。 */
  const service = () => {
    if (!options.marketplace)
      throw new ModelMarketplaceError('marketplace_unavailable', '平台模型服务尚未配置', 503);
    return options.marketplace;
  };

  app.get(
    '/v1/model-marketplace',
    handler(async (request) => {
      session(request);
      const query = marketplaceListSchema.omit({ status: true }).strict().parse(request.query);
      return service().listPublished(query);
    }),
  );
  app.get(
    '/v1/admin/model-marketplace/models',
    handler(async (request) => {
      session(request, true);
      return service().listAdmin(marketplaceListSchema.parse(request.query));
    }),
  );
  app.post(
    '/v1/admin/model-marketplace/models',
    handler(async (request, reply) => {
      const current = session(request, true);
      const model = await service().createModel(request.body, current.user.id);
      return reply.code(201).send({ model });
    }),
  );
  app.get(
    '/v1/admin/model-marketplace/models/:id',
    handler(async (request) => {
      session(request, true);
      const { id } = modelPathSchema.parse(request.params);
      return { model: await service().getAdmin(id) };
    }),
  );
  app.patch(
    '/v1/admin/model-marketplace/models/:id',
    handler(async (request) => {
      session(request, true);
      const { id } = modelPathSchema.parse(request.params);
      return { model: await service().updateModel(id, request.body) };
    }),
  );
  app.get(
    '/v1/admin/model-marketplace/models/:id/bindings',
    handler(async (request) => {
      session(request, true);
      const { id } = modelPathSchema.parse(request.params);
      const { page, pageSize } = versionListSchema.parse(request.query);
      return service().listBindings(id, page, pageSize);
    }),
  );
  app.post(
    '/v1/admin/model-marketplace/models/:id/bindings',
    handler(async (request, reply) => {
      const current = session(request, true);
      const { id } = modelPathSchema.parse(request.params);
      return reply
        .code(201)
        .send({ binding: await service().createBinding(id, request.body, current.user.id) });
    }),
  );
  app.get(
    '/v1/admin/pricing-versions',
    handler(async (request) => {
      session(request, true);
      const { platformModelId, page, pageSize } = versionListSchema
        .extend({ platformModelId: z.string().uuid() })
        .strict()
        .parse(request.query);
      return service().listPricing(platformModelId, page, pageSize);
    }),
  );
  app.post(
    '/v1/admin/pricing-versions',
    handler(async (request, reply) => {
      const current = session(request, true);
      return reply
        .code(201)
        .send({ pricing: await service().createPricing(request.body, current.user.id) });
    }),
  );
  app.get(
    '/v1/admin/model-marketplace/sync',
    handler(async (request) => {
      session(request, true);
      const { credentialId } = syncSchema.parse(request.query);
      return { sync: await service().getSync(credentialId) };
    }),
  );
  app.post(
    '/v1/admin/model-marketplace/sync',
    handler(async (request) => {
      const current = session(request, true);
      const { credentialId } = syncSchema.parse(request.body);
      return { sync: await service().sync(credentialId, current.user.id) };
    }),
  );
}

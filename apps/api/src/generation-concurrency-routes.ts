import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { updateGenerationConcurrencySchema } from '@multimodal-canvas/domain';
import { sanitizeExceptionForObservability } from '@multimodal-canvas/observability';
import type { AuthenticatedSession } from './auth-service';
import type { GenerationConcurrencyStore } from './generation-concurrency';

/** 部署级生成并发只接受服务端验证的管理员会话，不开放匿名或静态服务令牌入口。 */
export type GenerationConcurrencyRoutesOptions = {
  sessions: WeakMap<object, AuthenticatedSession>;
  store?: GenerationConcurrencyStore;
};

/**
 * 注册队列并发读写接口；普通用户为 403，无会话为 401，配置缺失或存储不可用为 503。
 * @param app 复用现有认证钩子的 API 实例。
 * @param options 可信会话和实际 BullMQ 配置存储；缺少存储时禁止假保存。
 */
export function registerGenerationConcurrencyRoutes(
  app: FastifyInstance,
  options: GenerationConcurrencyRoutesOptions,
): void {
  /** 角色来自当前有状态会话，不能由请求体或未经验证的 JWT 声明提权。 */
  const authorize = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const session = options.sessions.get(request);
    if (!session) {
      reply.code(401).send({ code: 'authentication_required', error: '请先登录' });
      return false;
    }
    if (session.user.role !== 'admin') {
      reply.code(403).send({ code: 'admin_required', error: '仅管理员可以管理全局生成并发' });
      return false;
    }
    return true;
  };
  /** 不把基础设施地址、认证信息或底层异常写进响应。 */
  const unavailable = (reply: FastifyReply) =>
    reply.code(503).send({
      code: 'generation_concurrency_unavailable',
      error: '生成队列配置暂不可用，请重新读取当前值后再试',
    });

  app.get('/v1/admin/generation-concurrency', async (request, reply) => {
    if (!authorize(request, reply)) return;
    if (!options.store) return unavailable(reply);
    try {
      const settings = await options.store.get();
      if (settings === null)
        return reply.code(503).send({
          code: 'generation_concurrency_unconfigured',
          error: '生成队列尚未初始化或配置已丢失，请管理员确认上限后重新保存',
        });
      return { settings };
    } catch (error) {
      request.log.warn(
        {
          code: 'generation_concurrency_read_failed',
          err: sanitizeExceptionForObservability(error),
        },
        '读取生成并发失败',
      );
      return unavailable(reply);
    }
  });

  app.patch('/v1/admin/generation-concurrency', async (request, reply) => {
    if (!authorize(request, reply)) return;
    const input = updateGenerationConcurrencySchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({
        code: 'invalid_generation_concurrency',
        error: '生成并发必须是可精确表示的正整数',
      });
    if (!options.store) return unavailable(reply);
    try {
      return { settings: await options.store.update(input.data.concurrency) };
    } catch (error) {
      request.log.warn(
        {
          code: 'generation_concurrency_write_failed',
          err: sanitizeExceptionForObservability(error),
        },
        '保存生成并发失败',
      );
      return unavailable(reply);
    }
  });
}

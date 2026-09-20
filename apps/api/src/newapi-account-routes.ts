import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NewApiAccountError } from './newapi-account-client';
import { NewApiAccountService } from './newapi-account-service';
import type { AuthenticatedSession } from './auth-service';

/** HttpOnly 会话名，仅同源 API 读取，浏览器脚本不会接触 bearer。 */
export const NEWAPI_SESSION_COOKIE = 'canvas_session';
/** 一次性浏览器登录事务绑定 Cookie。 */
const LOGIN_COOKIE = 'canvas_login';

/** 只解析所需 Cookie，不接受重复同名值以避免代理歧义。 */
export function requestCookie(request: FastifyRequest, name: string): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  try {
    return decodeURIComponent(values[0]!.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

/** 固定 Path/SameSite，生产 HTTPS 使用 Secure；不将令牌放进跳转 URL。 */
export function sessionCookie(
  name: string,
  value: string,
  seconds: number,
  secure: boolean,
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${secure ? '; Secure' : ''}`;
}

/** 注册唯一登录与本人分组同步；旧账号/手工凭据入口由 app 的退役边界拒绝。 */
export function registerNewApiAccountRoutes(
  app: FastifyInstance,
  service: NewApiAccountService,
  sessions: WeakMap<object, AuthenticatedSession>,
): void {
  const secure = new URL(service.options.client.options.redirectUri).protocol === 'https:';
  const userId = (request: FastifyRequest) => {
    const session = sessions.get(request);
    if (!session)
      throw new NewApiAccountError('authentication_required', '请先使用 New API 登录', 401);
    return session.user.id;
  };
  app.get('/v1/auth/newapi/start', async (request, reply) => {
    const query = z.object({ next: z.string().max(2048).optional() }).parse(request.query);
    const result = await service.start(query.next);
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('set-cookie', sessionCookie(LOGIN_COOKIE, result.browser, 300, secure))
      .redirect(result.url);
  });
  app.get('/v1/auth/newapi/callback', async (request, reply) => {
    const query = z
      .object({ state: z.string().min(1).max(128), code: z.string().min(1).max(4096) })
      .safeParse(request.query);
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (!query.success)
      return reply
        .code(400)
        .send({ code: 'invalid_login', error: '授权已取消或返回无效，请重新登录' });
    const result = await service.callback(
      query.data.state,
      query.data.code,
      requestCookie(request, LOGIN_COOKIE) ?? '',
    );
    const previous = requestCookie(request, NEWAPI_SESSION_COOKIE);
    if (previous) await service.options.auth.logout(previous);
    return reply
      .header('set-cookie', [
        sessionCookie(LOGIN_COOKIE, '', 0, secure),
        sessionCookie(
          NEWAPI_SESSION_COOKIE,
          result.accessToken,
          (Date.parse(result.refreshExpiresAt) - Date.now()) / 1000,
          secure,
        ),
      ])
      .redirect(new URL(result.returnPath, service.options.webUrl).toString());
  });
  app.get('/v1/account/newapi', async (request) => service.status(userId(request)));
  app.post('/v1/account/newapi/sync', async (request) => service.synchronize(userId(request)));
  app.post('/v1/account/newapi/revoke', async (request, reply) => {
    await service.revoke(userId(request));
    return reply
      .header('set-cookie', sessionCookie(NEWAPI_SESSION_COOKIE, '', 0, secure))
      .send({ revoked: true });
  });
  app.post('/v1/auth/refresh', async (request, reply) => {
    const id = userId(request);
    await service.synchronize(id);
    const result = await service.options.auth.refresh(
      requestCookie(request, NEWAPI_SESSION_COOKIE) ?? '',
    );
    return reply
      .header(
        'set-cookie',
        sessionCookie(
          NEWAPI_SESSION_COOKIE,
          result.accessToken,
          (Date.parse(result.refreshExpiresAt) - Date.now()) / 1000,
          secure,
        ),
      )
      .send({ user: result.user, expiresAt: result.expiresAt });
  });
}

/** 旧写入口明确失效；在鉴权后也不能重新建钱包、写价格或新增独立账号。 */
export function isRetiredNewApiRoute(path: string, method: string): boolean {
  if (
    /^\/v1\/(?:billing|marketplace|models\/marketplace|admin\/(?:billing|models|newapi|users|bootstrap)|auth\/(?:register|login|verify|verification|password)|account\/(?:password|email))(?=\/|$)/.test(
      path,
    )
  )
    return true;
  if (path === '/v1/settings/ai' && method === 'DELETE') return true;
  return (
    /^\/v1\/settings\/ai\/(?:test$|credentials(?:\/[^/]+(?:\/(?:activate|defaults))?)?$)/.test(
      path,
    ) && method !== 'GET'
  );
}

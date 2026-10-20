import { isIP } from 'node:net';
import fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { AgentAccessService, type AgentConnection } from './agent-access';

export type LocalAgentConnection = AgentConnection & { mcpUrl: string };
type LocalEntry = {
  userId: string;
  token: string;
  connection: LocalAgentConnection;
  listener: FastifyInstance;
  timer: ReturnType<typeof setTimeout>;
};

function loopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function hasProxyHeaders(request: FastifyRequest): boolean {
  return Object.keys(request.headers).some(
    (name) => name === 'forwarded' || name.startsWith('x-forwarded-'),
  );
}

/** 不依赖 trustProxy/request.ip，只有直接访问本机 API 才可管理免令牌监听器。 */
export function localAgentAvailability(
  app: FastifyInstance,
  request: FastifyRequest,
): { available: boolean; reason?: string } {
  const host = request.headers.host;
  let localHost = false;
  if (host && /^(\[[\da-f:]+\]|[^:/?#@\s]+)(:\d{1,5})?$/i.test(host)) {
    try {
      const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
      localHost = hostname === 'localhost' || loopback(hostname);
    } catch {
      // 无效 Host 不能创建本地连接。
    }
  }
  if (
    !app.server.listening ||
    !loopback(request.raw.socket.remoteAddress) ||
    !localHost ||
    hasProxyHeaders(request)
  )
    return {
      available: false,
      reason: 'local_api_required',
    };
  return { available: true };
}

export class LocalAgentConnectionLimitError extends Error {}

/** 每个端口只代表一个已登录用户的项目。浏览器、代理和局域网均不能访问。 */
export class LocalAgentConnections {
  private readonly entries = new Map<string, LocalEntry>();
  private readonly pending = new Map<string, number>();
  private readonly creating = new Set<Promise<LocalAgentConnection>>();
  private readonly removing = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly app: FastifyInstance,
    private readonly access: AgentAccessService,
  ) {}

  async list(userId: string, projectId: string): Promise<LocalAgentConnection[]> {
    const entries = [...this.entries.values()].filter(
      (entry) => entry.userId === userId && entry.connection.projectId === projectId,
    );
    const result: LocalAgentConnection[] = [];
    for (const entry of entries) {
      if (await this.access.verify(entry.token)) result.push({ ...entry.connection });
      else await this.remove(entry.connection.id);
    }
    return result;
  }

  create(input: Parameters<AgentAccessService['issue']>[0]): Promise<LocalAgentConnection> {
    const operation = this.start(input);
    this.creating.add(operation);
    void operation.then(
      () => this.creating.delete(operation),
      () => this.creating.delete(operation),
    );
    return operation;
  }

  private async start(
    input: Parameters<AgentAccessService['issue']>[0],
  ): Promise<LocalAgentConnection> {
    if (this.closing) throw new Error('Local MCP service is closing');
    const key = JSON.stringify([input.userId, input.projectId]);
    const pendingCount = [...this.pending.values()].reduce((sum, count) => sum + count, 0);
    const projectCount = [...this.entries.values()].filter(
      (entry) => entry.userId === input.userId && entry.connection.projectId === input.projectId,
    ).length;
    if (
      this.entries.size + pendingCount >= 100 ||
      projectCount + (this.pending.get(key) ?? 0) >= 20
    )
      throw new LocalAgentConnectionLimitError('Local MCP connection limit reached');
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    let issued: Awaited<ReturnType<AgentAccessService['issue']>> | undefined;
    const listener = fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 30_000 });
    listener.setErrorHandler<FastifyError>((error, _request, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
        return reply.code(413).send({ code: 'request_too_large', error: 'MCP 请求上限为1MiB' });
      if (
        error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
        error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
      )
        return reply.code(400).send({ code: 'invalid_json', error: '请求不是有效的 JSON' });
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
        return reply
          .code(error.statusCode)
          .send({ code: 'invalid_request', error: 'MCP 请求无效' });
      this.app.log.warn({ code: 'local_mcp_request_failed' }, '处理本地 Agent 请求失败');
      return reply
        .code(503)
        .send({ code: 'local_mcp_unavailable', error: '本地 MCP 服务暂不可用' });
    });
    let authority = '';
    try {
      issued = await this.access.issue(input);
      const { token, connection } = issued;
      listener.addHook('onRequest', async (request, reply) => {
        if (
          request.headers.host !== authority ||
          !loopback(request.raw.socket.remoteAddress) ||
          hasProxyHeaders(request) ||
          // Node/Undici 自动添加 mode:cors；浏览器还会携带 Origin 或其他 Fetch Metadata。
          Object.keys(request.headers).some(
            (name) =>
              name === 'origin' ||
              (name.startsWith('sec-fetch-') &&
                !(name === 'sec-fetch-mode' && request.headers[name] === 'cors')),
          )
        )
          return reply
            .code(403)
            .send({ code: 'local_origin_rejected', error: '仅允许本机 Agent 直接连接' });
        if (!(await this.access.verify(token))) {
          reply.raw.once('finish', () => {
            void this.remove(connection.id).catch(() => {
              this.app.log.warn({ code: 'local_mcp_cleanup_failed' }, '清理失效本地连接失败');
            });
          });
          return reply
            .code(401)
            .send({ code: 'local_connection_expired', error: '本地 Agent 连接已失效，请重新创建' });
        }
      });
      listener.route({
        method: ['GET', 'POST', 'DELETE'],
        url: '/mcp',
        handler: async (request, reply) => {
          const result = await this.app.inject({
            method: request.method as 'GET' | 'POST' | 'DELETE',
            url: `/v1/projects/${encodeURIComponent(input.projectId)}/mcp`,
            headers: {
              authorization: `Bearer ${token}`,
              ...(request.headers.accept ? { accept: request.headers.accept } : {}),
              ...(typeof request.headers['mcp-protocol-version'] === 'string'
                ? { 'mcp-protocol-version': request.headers['mcp-protocol-version'] }
                : {}),
              ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }),
          });
          for (const name of ['content-type', 'allow', 'retry-after']) {
            const value = result.headers[name];
            if (value !== undefined) reply.header(name, value);
          }
          return reply
            .header('cache-control', 'no-store')
            .code(result.statusCode)
            .send(result.body);
        },
      });
      const address = await listener.listen({ host: '127.0.0.1', port: 0 });
      authority = new URL(address).host;
      if (this.closing) throw new Error('Local MCP service is closing');
      const local = { ...connection, mcpUrl: `${address}/mcp` };
      const timer = setTimeout(
        () => {
          void this.remove(connection.id).catch(() => {
            this.app.log.warn({ code: 'local_mcp_cleanup_failed' }, '清理到期本地连接失败');
          });
        },
        Math.max(0, Date.parse(connection.expiresAt) - Date.now()),
      );
      timer.unref();
      this.entries.set(connection.id, {
        userId: input.userId,
        token,
        connection: local,
        listener,
        timer,
      });
      return { ...local };
    } catch (error) {
      await Promise.allSettled([
        listener.close(),
        ...(issued
          ? [this.access.revoke(input.userId, input.projectId, issued.connection.id)]
          : []),
      ]);
      throw error;
    } finally {
      const count = (this.pending.get(key) ?? 1) - 1;
      if (count) this.pending.set(key, count);
      else this.pending.delete(key);
    }
  }

  async revoke(userId: string, projectId: string, id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.userId !== userId || entry.connection.projectId !== projectId) return false;
    await this.remove(id);
    return true;
  }

  private remove(id: string): Promise<void> {
    const existing = this.removing.get(id);
    if (existing) return existing;
    const operation = this.stop(id);
    this.removing.set(id, operation);
    void operation.then(
      () => this.removing.delete(id),
      () => this.removing.delete(id),
    );
    return operation;
  }

  private async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    // 先停监听，即使存储暂不可用也不会留下仍能访问的免令牌端口。
    const results = await Promise.allSettled([
      entry.listener.close(),
      this.access.revoke(entry.userId, entry.connection.projectId, id),
    ]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Local MCP cleanup failed');
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.creating]);
    await Promise.all([
      ...[...this.entries.keys()].map((id) => this.remove(id)),
      ...this.removing.values(),
    ]);
  }
}

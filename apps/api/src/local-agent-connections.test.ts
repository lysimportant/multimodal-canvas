import { Server } from 'node:http';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentAccessService } from './agent-access';
import { MemoryAuthStore } from './auth-store';
import {
  LocalAgentConnections,
  LocalAgentConnectionLimitError,
  localAgentAvailability,
} from './local-agent-connections';

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const store = new MemoryAuthStore();
  cleanup.push(() => store.close());
  const user = await store.createUser({ email: 'local-mcp-lifecycle@example.test', role: 'user' });
  const access = new AgentAccessService({ store, secret: 'synthetic-local-mcp-secret' });
  const app = fastify({ logger: false });
  app.post('/v1/projects/:projectId/mcp', async (request, reply) => {
    const verified = await access.verify(request.headers.authorization!.slice('Bearer '.length));
    if (!verified) return reply.code(401).send({ error: 'invalid connection' });
    return { projectId: verified.claims.projectId };
  });
  const service = new LocalAgentConnections(app, access);
  app.addHook('onClose', async () => service.close());
  cleanup.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const input = {
    userId: user.id,
    projectId: 'synthetic-lifecycle-project',
    allowGeneration: false,
    expiresInHours: 1,
    authorizedUntil: new Date(Date.now() + 3_600_000),
  };
  return { app, store, user, access, service, input };
}

describe('本地 Agent 监听器生命周期与资源边界', () => {
  it('API尚未监听时不可创建本地连接，不能只靠注入的Host和peer伪装', async () => {
    const app: FastifyInstance = fastify();
    cleanup.push(() => app.close());
    app.get('/probe', async (request) => localAgentAvailability(app, request));
    const result = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { host: '127.0.0.1:3000' },
      remoteAddress: '127.0.0.1',
    });
    expect(result.json()).toEqual({ available: false, reason: 'local_api_required' });
  });

  it('到期定时器关闭随机端口并撤销内部授权', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const connection = await f.service.create(f.input);
    expect(await f.access.list(f.user.id, f.input.projectId)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_001);
    vi.useRealTimers();
    expect(await f.service.list(f.user.id, f.input.projectId)).toEqual([]);
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
    await expect(fetch(connection.mcpUrl)).rejects.toThrow();
  });

  it('并发创建也遵守每项目20个监听器上限，撤销后可以重新创建', async () => {
    const f = await fixture();
    const pending = Array.from({ length: 20 }, () => f.service.create(f.input));
    await expect(f.service.create(f.input)).rejects.toBeInstanceOf(LocalAgentConnectionLimitError);
    const connections = await Promise.all(pending);
    expect(await f.service.list(f.user.id, f.input.projectId)).toHaveLength(20);
    expect(new Set(connections.map((connection) => connection.mcpUrl)).size).toBe(20);
    await f.service.revoke(f.user.id, f.input.projectId, connections[0]!.id);
    const replacement = await f.service.create(f.input);
    expect(replacement.id).not.toBe(connections[0]!.id);
    expect(await f.access.list(f.user.id, f.input.projectId)).toHaveLength(20);
  });

  it('监听失败撤销刚签发的内部授权，失败不占用后续创建名额', async () => {
    const f = await fixture();
    vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(() => {
      throw new Error('synthetic bind failure');
    });
    await expect(f.service.create(f.input)).rejects.toThrow('synthetic bind failure');
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
    expect(await f.service.list(f.user.id, f.input.projectId)).toEqual([]);
    vi.restoreAllMocks();
    const connection = await f.service.create(f.input);
    const result = await fetch(connection.mcpUrl, { method: 'POST' });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ projectId: f.input.projectId });
  });

  it('请求大小限制为1MiB，异常请求不会转入主服务', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    const result = await fetch(connection.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(1024 * 1024) }),
    });
    expect(result.status).toBe(413);
  });

  it('关闭等待尚在创建的连接，清理中途签发的授权', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.access.issue.bind(f.access);
    vi.spyOn(f.access, 'issue').mockImplementation(async (input) => {
      await gate;
      return issue(input);
    });
    const pending = f.service.create(f.input);
    const rejected = expect(pending).rejects.toThrow('Local MCP service is closing');
    const closing = f.service.close();
    release();
    await Promise.all([rejected, closing]);
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
    await expect(f.service.create(f.input)).rejects.toThrow('Local MCP service is closing');
  });

  it.each(['verify', 'inject'] as const)(
    '%s未知异常返回固定文案，不把内部异常写进客户端响应',
    async (source) => {
      const f = await fixture();
      const connection = await f.service.create(f.input);
      const sensitive = new Error('synthetic-sensitive-marker');
      if (source === 'verify') vi.spyOn(f.access, 'verify').mockRejectedValueOnce(sensitive);
      else
        vi.spyOn(f.app, 'inject').mockImplementationOnce(() => {
          throw sensitive;
        });
      const result = await fetch(connection.mcpUrl, { method: 'POST' });
      expect(result.status).toBe(503);
      const body = await result.text();
      expect(body).not.toContain('synthetic-sensitive-marker');
      expect(JSON.parse(body)).toMatchObject({ code: 'local_mcp_unavailable' });
    },
  );
});

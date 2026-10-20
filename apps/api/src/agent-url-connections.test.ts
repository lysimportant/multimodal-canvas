import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentAccessService } from './agent-access';
import { AgentUrlConnections, AgentUrlConnectionLimitError } from './agent-url-connections';
import { MemoryAuthStore } from './auth-store';

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const store = new MemoryAuthStore();
  cleanup.push(() => store.close());
  const user = await store.createUser({ email: 'url-owner@example.test', role: 'user' });
  const other = await store.createUser({ email: 'url-other@example.test', role: 'user' });
  const access = new AgentAccessService({ store, secret: 'synthetic-url-mcp-secret' });
  const service = new AgentUrlConnections(access);
  cleanup.push(() => service.close());
  const input = {
    userId: user.id,
    projectId: 'synthetic/url project',
    expiresInHours: 1,
    authorizedUntil: new Date(Date.now() + 3_600_000),
  };
  const keyOf = (path: string) =>
    new URL(path, 'https://synthetic.example.test').searchParams.get('connection')!;
  return { store, user, other, access, service, input, keyOf };
}

describe('服务器 MCP 连接地址注册表', () => {
  it('仅返回项目相对地址和43字符随机键，内部授权不出现在公开数据中', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    expect(connection.mcpPath).toMatch(
      /^\/v1\/projects\/synthetic%2Furl%20project\/mcp\?connection=[A-Za-z0-9_-]{43}$/,
    );
    expect(connection.allowGeneration).toBe(true);
    const token = await f.service.resolve(f.input.projectId, f.keyOf(connection.mcpPath));
    expect(token).toMatch(/^cva1\./);
    expect((await f.access.verify(token!))?.claims.projectId).toBe(f.input.projectId);
    const listed = await f.service.list(f.user.id, f.input.projectId);
    expect(listed).toEqual([connection]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(connection).not.toHaveProperty('token');
    connection.mcpPath = '/synthetic-mutated';
    expect((await f.service.list(f.user.id, f.input.projectId))[0]!.mcpPath).not.toBe(
      connection.mcpPath,
    );
  });

  it('用户和项目隔离，错误键无效；仅所属用户项目可撤销', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    const key = f.keyOf(connection.mcpPath);
    for (const invalid of ['', 'x'.repeat(43), `${key}&extra=1`, key.slice(0, -1)])
      await expect(f.service.resolve(f.input.projectId, invalid)).resolves.toBeUndefined();
    await expect(f.service.resolve('other-project', key)).resolves.toBeUndefined();
    await expect(f.service.list(f.other.id, f.input.projectId)).resolves.toEqual([]);
    await expect(f.service.list(f.user.id, 'other-project')).resolves.toEqual([]);
    await expect(f.service.revoke(f.other.id, f.input.projectId, connection.id)).resolves.toBe(
      false,
    );
    await expect(f.service.revoke(f.user.id, 'other-project', connection.id)).resolves.toBe(false);
    await expect(f.service.resolve(f.input.projectId, key)).resolves.toBeDefined();
    await expect(f.service.revoke(f.user.id, f.input.projectId, connection.id)).resolves.toBe(true);
    await expect(f.service.resolve(f.input.projectId, key)).resolves.toBeUndefined();
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
  });

  it.each(['disabled', 'revoked'] as const)('%s后校验立即失效并删除映射', async (state) => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    if (state === 'disabled') await f.store.updateUser(f.user.id, { status: 'disabled' });
    else await f.access.revoke(f.user.id, f.input.projectId, connection.id);
    await expect(
      f.service.resolve(f.input.projectId, f.keyOf(connection.mcpPath)),
    ).resolves.toBeUndefined();
    expect(await f.service.revoke(f.user.id, f.input.projectId, connection.id)).toBe(false);
    expect(await f.service.list(f.user.id, f.input.projectId)).toEqual([]);
  });

  it('到期定时器清理映射和内部授权，显式false权限保持', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const connection = await f.service.create({ ...f.input, allowGeneration: false });
    expect(connection.allowGeneration).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_001);
    vi.useRealTimers();
    expect(await f.service.list(f.user.id, f.input.projectId)).toEqual([]);
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
    await expect(
      f.service.resolve(f.input.projectId, f.keyOf(connection.mcpPath)),
    ).resolves.toBeUndefined();
  });

  it('并发创建限制每项目20个，撤销后可补位', async () => {
    const f = await fixture();
    const pending = Array.from({ length: 20 }, () => f.service.create(f.input));
    await expect(f.service.create(f.input)).rejects.toBeInstanceOf(AgentUrlConnectionLimitError);
    const connections = await Promise.all(pending);
    expect(new Set(connections.map((connection) => f.keyOf(connection.mcpPath))).size).toBe(20);
    await f.service.revoke(f.user.id, f.input.projectId, connections[0]!.id);
    await expect(f.service.create(f.input)).resolves.toBeDefined();
    expect(await f.service.list(f.user.id, f.input.projectId)).toHaveLength(20);
  });

  it('创建失败会释放预留名额；关闭等待创建并撤销中途签发的授权', async () => {
    const f = await fixture();
    vi.spyOn(f.access, 'issue').mockRejectedValueOnce(new Error('synthetic-create-failure'));
    await expect(f.service.create(f.input)).rejects.toThrow('synthetic-create-failure');
    const existing = await f.service.create(f.input);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issue = f.access.issue.bind(f.access);
    vi.spyOn(f.access, 'issue').mockImplementation(async (input) => {
      await gate;
      return issue(input);
    });
    const creating = f.service.create(f.input);
    const rejected = expect(creating).rejects.toThrow('Agent URL connections are closing');
    const closing = f.service.close();
    release();
    await Promise.all([rejected, closing]);
    expect(await f.access.list(f.user.id, f.input.projectId)).toEqual([]);
    await expect(
      f.service.resolve(f.input.projectId, f.keyOf(existing.mcpPath)),
    ).resolves.toBeUndefined();
    await expect(f.service.create(f.input)).rejects.toThrow('Agent URL connections are closing');
  });
});

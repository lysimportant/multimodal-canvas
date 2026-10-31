import { afterEach, describe, expect, it } from 'vitest';
import { AgentAccessConnectionLimitError, AgentAccessService } from './agent-access';
import { AgentUrlConnections } from './agent-url-connections';
import { MemoryAuthStore } from './auth-store';

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const SECRET = 'synthetic-url-mcp-secret';

async function fixture() {
  const store = new MemoryAuthStore();
  cleanup.push(() => store.close());
  const user = await store.createUser({ email: 'url-owner@example.test', role: 'user' });
  const other = await store.createUser({ email: 'url-other@example.test', role: 'user' });
  const access = new AgentAccessService({ store, secret: SECRET });
  const service = new AgentUrlConnections(access);
  const input = { userId: user.id, projectId: 'synthetic/url project' };
  const keyOf = (path: string) =>
    new URL(path, 'https://synthetic.example.test').searchParams.get('connection')!;
  return { store, user, other, access, service, input, keyOf };
}

describe('服务器 MCP 连接地址', () => {
  it('默认长期有效，仅返回项目相对地址和签名键，内部授权不出现在公开数据中', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    expect(connection.mcpPath).toMatch(
      /^\/v1\/projects\/synthetic%2Furl%20project\/mcp\?connection=[\da-f-]{36}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(connection.expiresAt).toBeNull();
    expect(connection.allowGeneration).toBe(true);
    const token = await f.service.resolve(f.input.projectId, f.keyOf(connection.mcpPath));
    expect(token).toMatch(/^cva1\./);
    expect((await f.access.verify(token!))?.claims.projectId).toBe(f.input.projectId);
    const listed = await f.service.list(f.user.id, f.input.projectId);
    expect(listed).toEqual([connection]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(connection).not.toHaveProperty('token');
  });

  it('API 重启后同一密钥和存储下原地址继续可用，更换密钥后失效', async () => {
    const f = await fixture();
    const connection = await f.service.create({ ...f.input, allowGeneration: false });
    const key = f.keyOf(connection.mcpPath);
    const restarted = new AgentUrlConnections(
      new AgentAccessService({ store: f.store, secret: SECRET }),
    );
    expect(await restarted.list(f.user.id, f.input.projectId)).toEqual([connection]);
    const token = await restarted.resolve(f.input.projectId, key);
    expect(token).toBe(await f.service.resolve(f.input.projectId, key));
    const verified = await f.access.verify(token!);
    expect(verified?.claims.allowGeneration).toBe(false);
    const rotated = new AgentUrlConnections(
      new AgentAccessService({ store: f.store, secret: 'synthetic-rotated-secret' }),
    );
    await expect(rotated.resolve(f.input.projectId, key)).resolves.toBeUndefined();
  });

  it('用户和项目隔离，错误键无效；仅所属用户项目可撤销', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    const key = f.keyOf(connection.mcpPath);
    const [id, signature] = key.split('.') as [string, string];
    const forged = `${id}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    for (const invalid of ['', 'x'.repeat(43), `${key}&extra=1`, key.slice(0, -1), forged, id])
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

  it('账号停用后地址无法通过校验', async () => {
    const f = await fixture();
    const connection = await f.service.create(f.input);
    const token = await f.service.resolve(f.input.projectId, f.keyOf(connection.mcpPath));
    await f.store.updateUser(f.user.id, { status: 'disabled' });
    await expect(f.access.verify(token!)).resolves.toBeUndefined();
  });

  it('显式限时连接到期后地址失效', async () => {
    const f = await fixture();
    let now = Date.now();
    const access = new AgentAccessService({ store: f.store, secret: SECRET, now: () => now });
    const service = new AgentUrlConnections(access);
    const connection = await service.create({ ...f.input, expiresInHours: 1 });
    expect(Date.parse(connection.expiresAt!)).toBe(now + 3_600_000);
    const key = f.keyOf(connection.mcpPath);
    await expect(service.resolve(f.input.projectId, key)).resolves.toBeDefined();
    now += 3_600_001;
    await expect(service.resolve(f.input.projectId, key)).resolves.toBeUndefined();
    expect(await service.list(f.user.id, f.input.projectId)).toEqual([]);
  });

  it('并发创建限制每项目20个，撤销后可补位', async () => {
    const f = await fixture();
    const pending = Array.from({ length: 20 }, () => f.service.create(f.input));
    await expect(f.service.create(f.input)).rejects.toBeInstanceOf(AgentAccessConnectionLimitError);
    const connections = await Promise.all(pending);
    expect(new Set(connections.map((connection) => f.keyOf(connection.mcpPath))).size).toBe(20);
    await f.service.revoke(f.user.id, f.input.projectId, connections[0]!.id);
    await expect(f.service.create(f.input)).resolves.toBeDefined();
    expect(await f.service.list(f.user.id, f.input.projectId)).toHaveLength(20);
  });
});

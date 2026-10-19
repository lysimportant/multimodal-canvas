import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAccessService, AGENT_TOKEN_PREFIX, type AgentAccessClaims } from './agent-access';
import { authenticateBearer, verifyHs256Jwt } from './auth';
import { AuthService } from './auth-service';
import { MemoryAuthStore } from './auth-store';

const HOUR = 3_600_000;
const secret = 'synthetic-agent-access-signing-secret';
const stores: MemoryAuthStore[] = [];

/** 使用独立内存存储与可推进时钟，不读取环境凭据，也不访问网络或数据库。 */
async function fixture() {
  const clock = { now: Date.UTC(2026, 9, 18, 0, 0, 0) };
  const now = () => clock.now;
  const store = new MemoryAuthStore();
  stores.push(store);
  const user = await store.createUser({ email: 'agent-owner@example.test', role: 'user' });
  const other = await store.createUser({ email: 'other-owner@example.test', role: 'user' });
  const service = new AgentAccessService({ store, secret, now });
  const auth = new AuthService({ store, jwtSecret: secret, now });
  const input = {
    userId: user.id,
    projectId: 'project-alpha',
    allowGeneration: false,
    expiresInHours: 8,
    authorizedUntil: new Date(clock.now + 24 * HOUR),
  };
  return { clock, now, store, user, other, service, auth, input };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

/** 仅解码合成令牌，篡改测试始终保留原签名，不伪造真实用户材料。 */
function decodedClaims(token: string): AgentAccessClaims {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

describe('项目 MCP 专用访问令牌', () => {
  it.each([false, true])(
    '签发并校验绑定用户、项目和 allowGeneration=%s，存储只含用途隔离哈希',
    async (allowGeneration) => {
      const f = await fixture();
      const issued = await f.service.issue({ ...f.input, allowGeneration });
      expect(issued.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
      const expiresAt = f.clock.now + 8 * HOUR;
      const verified = await f.service.verify(issued.token);
      expect(verified).toMatchObject({
        claims: {
          id: issued.connection.id,
          userId: f.user.id,
          projectId: f.input.projectId,
          allowGeneration,
          expiresAt,
        },
        session: {
          user: { id: f.user.id, role: 'user' },
          claims: { sub: f.user.id, sid: issued.connection.id, exp: expiresAt / 1000 },
        },
      });
      const stored = await f.store.findSession(issued.connection.id);
      expect(stored).toMatchObject({
        userId: f.user.id,
        expiresAt: new Date(expiresAt),
        absoluteExpiresAt: new Date(expiresAt),
      });
      const projectHash = createHash('sha256').update(f.input.projectId).digest('hex');
      const hash = createHash('sha256').update(issued.token).digest('hex');
      expect(stored!.tokenHash).toBe(
        `mcp:v1:${projectHash}:${allowGeneration ? '1' : '0'}:${hash}`,
      );
      expect(stored).not.toHaveProperty('token');
      expect(JSON.stringify(stored)).not.toContain(issued.token);
      expect(JSON.stringify(issued.connection)).not.toContain(issued.token);
      expect(issued.connection).not.toHaveProperty('tokenHash');
    },
  );

  it('即使共用签名密钥也与普通登录 JWT 双向隔离，不能登录或续期', async () => {
    const f = await fixture();
    const login = await f.auth.issueToken(f.user);
    const agent = await f.service.issue(f.input);
    expect(
      authenticateBearer(`Bearer ${login.accessToken}`, { jwtSecret: secret, now: f.now }),
    ).toMatchObject({ ok: true });
    expect(authenticateBearer(`Bearer ${agent.token}`, { jwtSecret: secret, now: f.now })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyHs256Jwt(agent.token, secret, f.now, true)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyHs256Jwt(agent.token, secret, f.now, false)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(f.auth.verifyAccessToken(agent.token)).rejects.toMatchObject({
      code: 'invalid_token',
    });
    await expect(f.auth.refresh(agent.token)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(f.service.verify(login.accessToken)).resolves.toBeUndefined();
  });

  it('用户、项目、生成权限、到期和会话 ID 任一篡改均失败，签名用途不能替换', async () => {
    const f = await fixture();
    const issued = await f.service.issue(f.input);
    const claims = decodedClaims(issued.token);
    const signature = issued.token.split('.')[2]!;
    const patches: Partial<AgentAccessClaims>[] = [
      { userId: f.other.id },
      { projectId: 'project-beta' },
      { allowGeneration: true },
      { expiresAt: claims.expiresAt + HOUR },
      { id: randomUUID() },
    ];
    for (const patch of patches) {
      const payload = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url');
      await expect(
        f.service.verify(`${AGENT_TOKEN_PREFIX}${payload}.${signature}`),
      ).resolves.toBeUndefined();
    }
    const payload = issued.token.split('.')[1]!;
    const wrongPurpose = createHmac('sha256', secret).update(payload).digest('base64url');
    await expect(
      f.service.verify(`${AGENT_TOKEN_PREFIX}${payload}.${wrongPurpose}`),
    ).resolves.toBeUndefined();
    for (const invalid of [
      '',
      'not-a-token',
      `${issued.token}.extra`,
      `${AGENT_TOKEN_PREFIX}${'a'.repeat(4096)}`,
    ])
      await expect(f.service.verify(invalid)).resolves.toBeUndefined();
    await expect(f.service.verify(issued.token)).resolves.toBeDefined();
  });

  it('有效签名也必须对应当前存储记录，不能在空存储或另一签名密钥下使用', async () => {
    const f = await fixture();
    const issued = await f.service.issue(f.input);
    const isolated = await fixture();
    await expect(isolated.service.verify(issued.token)).resolves.toBeUndefined();
    const rotated = new AgentAccessService({
      store: f.store,
      secret: 'synthetic-rotated-secret',
      now: f.now,
    });
    await expect(rotated.verify(issued.token)).resolves.toBeUndefined();
  });

  it('8 小时默认申请受 authorizedUntil 限制，并在到期边界立即失效', async () => {
    const f = await fixture();
    const authorizedUntil = new Date(f.clock.now + 3 * HOUR);
    const issued = await f.service.issue({ ...f.input, authorizedUntil });
    expect(issued.connection.expiresAt).toBe(authorizedUntil.toISOString());
    expect(decodedClaims(issued.token).expiresAt).toBe(authorizedUntil.getTime());
    f.clock.now = authorizedUntil.getTime() - 1;
    await expect(f.service.verify(issued.token)).resolves.toBeDefined();
    f.clock.now += 1;
    await expect(f.service.verify(issued.token)).resolves.toBeUndefined();
    await expect(f.service.list(f.user.id, f.input.projectId)).resolves.toEqual([]);
  });

  it.each([0, -1, 1.5, 25, Number.NaN, Number.POSITIVE_INFINITY])(
    '拒绝非法授权时长 %s，且不创建会话',
    async (expiresInHours) => {
      const f = await fixture();
      await expect(f.service.issue({ ...f.input, expiresInHours })).rejects.toThrow();
      await expect(f.store.listSessions(f.user.id)).resolves.toEqual([]);
    },
  );

  it('拒绝已过期、恰好到期或无效的上游授权，以及缺失的签名密钥', async () => {
    const f = await fixture();
    for (const authorizedUntil of [
      new Date(f.clock.now - 1),
      new Date(f.clock.now),
      new Date(Number.NaN),
    ])
      await expect(f.service.issue({ ...f.input, authorizedUntil })).rejects.toThrow();
    const unconfigured = new AgentAccessService({ store: f.store, secret: ' ', now: f.now });
    await expect(unconfigured.issue(f.input)).rejects.toThrow();
    await expect(f.store.listSessions(f.user.id)).resolves.toEqual([]);
  });

  it.each(['disabled', 'pending'] as const)(
    '账号变成 %s 后立即拒绝已有令牌和新签发',
    async (status) => {
      const f = await fixture();
      const issued = await f.service.issue(f.input);
      await f.store.updateUser(f.user.id, { status });
      await expect(f.service.verify(issued.token)).resolves.toBeUndefined();
      await expect(f.service.issue(f.input)).rejects.toThrow();
      await expect(f.service.issue({ ...f.input, userId: randomUUID() })).rejects.toThrow();
      expect(await f.store.listSessions(f.user.id)).toHaveLength(1);
    },
  );

  it('撤销仅允许同用户同项目，不能撤销另一项目、另一用户或普通登录会话', async () => {
    const f = await fixture();
    const issued = await f.service.issue(f.input);
    const sibling = await f.service.issue(f.input);
    const login = await f.auth.issueToken(f.user);
    const loginSession = await f.auth.verifyAccessToken(login.accessToken);
    await expect(
      f.service.revoke(f.other.id, f.input.projectId, issued.connection.id),
    ).resolves.toBe(false);
    await expect(f.service.revoke(f.user.id, 'project-beta', issued.connection.id)).resolves.toBe(
      false,
    );
    await expect(
      f.service.revoke(f.user.id, f.input.projectId, loginSession.session.id),
    ).resolves.toBe(false);
    await expect(f.service.revoke(f.user.id, f.input.projectId, randomUUID())).resolves.toBe(false);
    await expect(f.service.verify(issued.token)).resolves.toBeDefined();
    await expect(
      f.service.revoke(f.user.id, f.input.projectId, issued.connection.id),
    ).resolves.toBe(true);
    await expect(f.service.verify(issued.token)).resolves.toBeUndefined();
    await expect(f.service.verify(sibling.token)).resolves.toBeDefined();
    await expect(f.auth.verifyAccessToken(login.accessToken)).resolves.toBeDefined();
  });

  it('logoutAll 同时撤销该用户所有项目令牌与登录会话，不影响其他用户', async () => {
    const f = await fixture();
    const first = await f.service.issue(f.input);
    const second = await f.service.issue({
      ...f.input,
      projectId: 'project-beta',
      allowGeneration: true,
    });
    const other = await f.service.issue({ ...f.input, userId: f.other.id });
    const login = await f.auth.issueToken(f.user);
    expect(await f.auth.logoutAll(f.user.id)).toBe(3);
    await expect(f.service.verify(first.token)).resolves.toBeUndefined();
    await expect(f.service.verify(second.token)).resolves.toBeUndefined();
    await expect(f.auth.verifyAccessToken(login.accessToken)).rejects.toMatchObject({
      code: 'session_revoked',
    });
    await expect(f.service.verify(other.token)).resolves.toBeDefined();
  });

  it('列表按用户和项目隔离，排除撤销、过期和普通会话，公开字段不含令牌或哈希', async () => {
    const f = await fixture();
    const active = await f.service.issue(f.input);
    await f.service.issue({ ...f.input, expiresInHours: 1 });
    const revoked = await f.service.issue(f.input);
    const otherProject = await f.service.issue({
      ...f.input,
      projectId: 'project-beta',
      allowGeneration: true,
    });
    const otherUser = await f.service.issue({ ...f.input, userId: f.other.id });
    await f.auth.issueToken(f.user);
    await f.service.revoke(f.user.id, f.input.projectId, revoked.connection.id);
    f.clock.now += HOUR;
    const list = await f.service.list(f.user.id, f.input.projectId);
    expect(list).toEqual([active.connection]);
    await expect(f.service.list(f.user.id, 'project-beta')).resolves.toEqual([
      otherProject.connection,
    ]);
    await expect(f.service.list(f.other.id, f.input.projectId)).resolves.toEqual([
      otherUser.connection,
    ]);
    expect(Object.keys(list[0]!).sort()).toEqual([
      'allowGeneration',
      'createdAt',
      'expiresAt',
      'id',
      'projectId',
    ]);
    expect(JSON.stringify(list)).not.toContain(active.token);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });
});

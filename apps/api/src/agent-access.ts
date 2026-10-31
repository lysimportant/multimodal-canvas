import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { AuthSessionRecord, AuthStore } from './auth-store';
import { toPublicUser, type AuthenticatedSession } from './auth-service';

export const AGENT_TOKEN_PREFIX = 'cva1.';
const claimsSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    projectId: z.string().min(1).max(512),
    allowGeneration: z.boolean(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type AgentAccessClaims = z.infer<typeof claimsSchema>;
export type AgentConnection = {
  id: string;
  projectId: string;
  allowGeneration: boolean;
  createdAt: string;
  /** null 表示长期有效，停止、账号停用或撤销全部会话前一直可用。 */
  expiresAt: string | null;
};
type IssueInput = {
  userId: string;
  projectId: string;
  allowGeneration?: boolean;
  /** 省略时长期有效；兼容旧客户端显式申请 1–24 小时。 */
  expiresInHours?: number;
  /** 仅限时连接受当前登录授权期限约束。 */
  authorizedUntil?: Date;
};
export class AgentAccessConnectionLimitError extends Error {}

/** 长期连接的存储到期时间；会话表要求非空到期时间。 */
const PERMANENT_EXPIRES_AT = Date.UTC(9999, 11, 31);
const URL_KEY_PATTERN =
  /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.([A-Za-z0-9_-]{43})$/;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const storagePrefix = (projectId: string) => `mcp:v1:${digest(projectId)}:`;
const tokenHash = (claims: AgentAccessClaims, token: string) =>
  `${storagePrefix(claims.projectId)}${claims.allowGeneration ? '1' : '0'}:${digest(token)}`;

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 项目专用 MCP 授权复用可撤销会话存储，令牌哈希使用独立用途前缀。
 * 不改变普通登录 JWT 合同；MCP 令牌不能作为登录凭据使用或续期。
 */
export class AgentAccessService {
  private readonly issuanceQueues = new Map<string, Promise<void>>();
  private readonly issued = new Map<string, number>();
  private pendingIssues = 0;
  constructor(private readonly options: { store: AuthStore; secret: string; now?: () => number }) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }
  private sign(payload: string) {
    return createHmac('sha256', this.options.secret)
      .update(`canvas-agent-access:v1:${payload}`)
      .digest('base64url');
  }

  private urlSignature(projectId: string, id: string) {
    return createHmac('sha256', this.options.secret)
      .update(`canvas-agent-url:v1:${projectId}:${id}`)
      .digest('base64url');
  }
  private tokenOf(claims: AgentAccessClaims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${AGENT_TOKEN_PREFIX}${payload}.${this.sign(payload)}`;
  }

  issue(input: IssueInput): Promise<{ token: string; connection: AgentConnection }> {
    const key = JSON.stringify([input.userId, input.projectId]);
    const previous = this.issuanceQueues.get(key) ?? Promise.resolve();
    const operation = previous.then(() => this.issueScoped(input));
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.issuanceQueues.set(key, settled);
    void settled.then(() => {
      if (this.issuanceQueues.get(key) === settled) this.issuanceQueues.delete(key);
    });
    return operation;
  }

  private async issueScoped(
    input: IssueInput,
  ): Promise<{ token: string; connection: AgentConnection }> {
    if (!this.options.secret.trim()) throw new Error('Agent access signing key is unavailable');
    if (
      input.expiresInHours !== undefined &&
      (!Number.isInteger(input.expiresInHours) ||
        input.expiresInHours < 1 ||
        input.expiresInHours > 24)
    )
      throw new Error('Agent connection lifetime must be between 1 and 24 hours');
    for (const [id, expiry] of this.issued) if (expiry <= this.now()) this.issued.delete(id);
    if (this.issued.size + this.pendingIssues >= 100) {
      const activeUsers = new Map<string, Promise<boolean>>();
      await Promise.all(
        [...this.issued.keys()].map(async (id) => {
          const session = await this.options.store.findSession(id);
          if (!session || session.revokedAt || session.expiresAt.getTime() <= this.now()) {
            this.issued.delete(id);
            return;
          }
          let active = activeUsers.get(session.userId);
          if (!active) {
            active = this.options.store
              .findUserById(session.userId)
              .then((user) => user?.status === 'active');
            activeUsers.set(session.userId, active);
          }
          if (!(await active)) this.issued.delete(id);
        }),
      );
    }
    if (this.issued.size + this.pendingIssues >= 100)
      throw new AgentAccessConnectionLimitError('Agent connection limit reached');
    this.pendingIssues += 1;
    try {
      const user = await this.options.store.findUserById(input.userId);
      if (!user || user.status !== 'active') throw new Error('Active user required');
      if ((await this.list(input.userId, input.projectId)).length >= 20)
        throw new AgentAccessConnectionLimitError('Project agent connection limit reached');
      const expiresAt =
        input.expiresInHours === undefined
          ? PERMANENT_EXPIRES_AT
          : Math.min(
              this.now() + input.expiresInHours * 3_600_000,
              input.authorizedUntil?.getTime() ?? Number.POSITIVE_INFINITY,
            );
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
        throw new Error('Authorization has expired');
      const claims = claimsSchema.parse({
        id: randomUUID(),
        userId: input.userId,
        projectId: input.projectId,
        allowGeneration: input.allowGeneration === undefined ? true : input.allowGeneration,
        expiresAt,
      });
      const token = this.tokenOf(claims);
      const session = await this.options.store.createSession({
        id: claims.id,
        userId: claims.userId,
        tokenHash: tokenHash(claims, token),
        expiresAt: new Date(expiresAt),
        absoluteExpiresAt: new Date(expiresAt),
      });
      this.issued.set(session.id, expiresAt);
      return { token, connection: this.summary(session, claims.projectId, claims.allowGeneration) };
    } finally {
      this.pendingIssues -= 1;
    }
  }

  async verify(
    token: string,
  ): Promise<{ claims: AgentAccessClaims; session: AuthenticatedSession } | undefined> {
    if (token.length > 4096 || !token.startsWith(AGENT_TOKEN_PREFIX)) return undefined;
    const parts = token.split('.');
    if (parts.length !== 3 || !equal(parts[2]!, this.sign(parts[1]!))) return undefined;
    let claims: AgentAccessClaims;
    try {
      claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
    } catch {
      return undefined;
    }
    if (claims.expiresAt <= this.now()) {
      this.issued.delete(claims.id);
      return undefined;
    }
    const session = await this.options.store.findSession(claims.id);
    if (
      !session ||
      session.userId !== claims.userId ||
      session.revokedAt ||
      session.expiresAt.getTime() <= this.now() ||
      !equal(session.tokenHash, tokenHash(claims, token))
    ) {
      this.issued.delete(claims.id);
      return undefined;
    }
    const user = await this.options.store.findUserById(claims.userId);
    if (!user || user.status !== 'active') {
      this.issued.delete(claims.id);
      return undefined;
    }
    await this.options.store.touchSession(session.id, new Date(this.now()));
    return {
      claims,
      session: {
        user: toPublicUser(user),
        session,
        claims: {
          sub: user.id,
          sid: session.id,
          role: user.role,
          exp: Math.floor(claims.expiresAt / 1000),
        },
      },
    };
  }

  /** 服务器地址键由连接 ID 签名派生，不含内部令牌；API 重启或重新部署后保持不变。 */
  urlKey(projectId: string, id: string): string {
    return `${id}.${this.urlSignature(projectId, id)}`;
  }

  /** 由地址键还原同一连接的内部令牌；账号状态等完整校验仍由 verify 执行。 */
  async resolveUrlKey(projectId: string, key: string): Promise<string | undefined> {
    const match = URL_KEY_PATTERN.exec(key);
    if (!match || !equal(match[2]!, this.urlSignature(projectId, match[1]!))) return undefined;
    const session = await this.options.store.findSession(match[1]!);
    const prefix = storagePrefix(projectId);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= this.now() ||
      !session.tokenHash.startsWith(prefix)
    )
      return undefined;
    const claims = claimsSchema.safeParse({
      id: session.id,
      userId: session.userId,
      projectId,
      allowGeneration: session.tokenHash.slice(prefix.length, prefix.length + 1) === '1',
      expiresAt: session.expiresAt.getTime(),
    });
    if (!claims.success) return undefined;
    const token = this.tokenOf(claims.data);
    return equal(session.tokenHash, tokenHash(claims.data, token)) ? token : undefined;
  }

  async list(userId: string, projectId: string): Promise<AgentConnection[]> {
    const prefix = storagePrefix(projectId);
    return (await this.options.store.listSessions(userId))
      .filter(
        (session) =>
          !session.revokedAt &&
          session.expiresAt.getTime() > this.now() &&
          session.tokenHash.startsWith(prefix),
      )
      .map((session) =>
        this.summary(
          session,
          projectId,
          session.tokenHash.slice(prefix.length, prefix.length + 1) === '1',
        ),
      );
  }

  async revoke(userId: string, projectId: string, id: string): Promise<boolean> {
    const session = await this.options.store.findSession(id);
    if (
      !session ||
      session.userId !== userId ||
      !session.tokenHash.startsWith(storagePrefix(projectId))
    )
      return false;
    await this.options.store.revokeSession(id, new Date(this.now()));
    this.issued.delete(id);
    return true;
  }

  private summary(
    session: AuthSessionRecord,
    projectId: string,
    allowGeneration: boolean,
  ): AgentConnection {
    return {
      id: session.id,
      projectId,
      allowGeneration,
      createdAt: session.createdAt.toISOString(),
      expiresAt:
        session.expiresAt.getTime() >= PERMANENT_EXPIRES_AT
          ? null
          : session.expiresAt.toISOString(),
    };
  }
}

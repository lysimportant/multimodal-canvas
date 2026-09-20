import { Prisma, PrismaClient, type UserRole as PrismaUserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { AuthRole } from './auth';

/** PostgreSQL 主键格式校验，避免无效路径 ID 触发底层 UUID 转换异常。 */
const USER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthUserRecord = {
  id: string;
  /** 外部身份允许无邮箱；资源归属始终由内部 UUID 决定。 */
  email?: string;
  displayName?: string;
  role: AuthRole;
  /** 内部资源账号仅跟随已验证身份启用或禁用。 */
  status: 'active' | 'pending' | 'disabled';
  bio?: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AuthSessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  lastUsedAt?: Date;
  absoluteExpiresAt?: Date;
};

export type CreateAuthUserInput = {
  email: string;
  displayName?: string;
  role?: AuthRole;
  status?: AuthUserRecord['status'];
  bio?: string;
  avatarUrl?: string;
};

export type CreateAuthSessionInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt?: Date;
};
/** 不含敏感原值的账户或资源操作审计。 */
export type AccountAuditRecord = {
  id: string;
  actorId?: string;
  ownerId?: string;
  targetId?: string;
  action: string;
  summary: string;
  createdAt: Date;
};
/** 可由账户服务更新的字段；角色不开放给通用 PATCH。 */
export type UpdateAuthUserInput = Partial<
  Pick<AuthUserRecord, 'email' | 'displayName' | 'status' | 'bio' | 'avatarUrl'>
>;

/** 本地文件存储使用版本化快照，日期和 Map 由标准 V8 序列化保留。 */
export type AuthStoreSnapshot = {
  version: 1;
  users: Map<string, AuthUserRecord>;
  sessions: Map<string, AuthSessionRecord>;
  audit: AccountAuditRecord[];
};

export type AuthStore = {
  createUser(input: CreateAuthUserInput): Promise<AuthUserRecord>;
  findUserByEmail(email: string): Promise<AuthUserRecord | undefined>;
  findUserById(id: string): Promise<AuthUserRecord | undefined>;
  createSession(input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  findSession(id: string): Promise<AuthSessionRecord | undefined>;
  touchSession(id: string, lastUsedAt: Date): Promise<void>;
  revokeSession(id: string, revokedAt: Date): Promise<void>;
  revokeAllSessions(userId: string, revokedAt: Date): Promise<number>;
  /** 串行化敏感写入；同一事务中的会话撤销和用户更改原子完成。 */
  transaction<T>(operation: (store: AuthStore) => Promise<T>): Promise<T>;
  listUsers(): Promise<AuthUserRecord[]>;
  updateUser(id: string, input: UpdateAuthUserInput): Promise<AuthUserRecord>;
  listSessions(userId: string): Promise<AuthSessionRecord[]>;
  appendAudit(event: AccountAuditRecord): Promise<void>;
  listAudit(): Promise<AccountAuditRecord[]>;
  close?(): Promise<void>;
};

export class AuthStoreError extends Error {
  constructor(
    public readonly code: 'email_taken' | 'invalid_user' | 'invalid_session',
    message: string,
  ) {
    super(message);
  }
}

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, AuthUserRecord>();
  private readonly userIdsByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, AuthSessionRecord>();
  /** 所有读取、写入与事务共享队列，防止异步请求读取未提交数据或覆盖回滚结果。 */
  private transactionTail: Promise<unknown> = Promise.resolve();
  /** 仅当前仍有效的异步调用链可以重入；已结束事务派生的延迟任务必须重新排队。 */
  private readonly executionContext = new AsyncLocalStorage<{ active: boolean }>();
  private audit: AccountAuditRecord[] = [];

  /** 串行执行完整存储操作，事务内的嵌套调用可重入，操作失败不会阻塞后续请求。 */
  protected async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.executionContext.getStore()?.active) return operation();
    const pending = this.transactionTail.then(() => {
      const context = { active: true };
      return this.executionContext.run(context, async () => {
        try {
          return await operation();
        } finally {
          context.active = false;
        }
      });
    });
    this.transactionTail = pending.catch(() => undefined);
    return pending;
  }

  /** 导出受保护的深拷贝，供开发环境本地持久化适配器使用。 */
  protected snapshot(): AuthStoreSnapshot {
    return structuredClone({
      version: 1,
      users: this.usersById,
      sessions: this.sessions,
      audit: this.audit,
    });
  }
  /** 恢复经过版本检查的内部快照，不将解析失败误当成新安装。 */
  protected restore(snapshot: AuthStoreSnapshot): void {
    if (
      snapshot.version !== 1 ||
      !(snapshot.users instanceof Map) ||
      !(snapshot.sessions instanceof Map) ||
      !Array.isArray(snapshot.audit)
    )
      throw new Error('账户存储格式损坏或版本不兼容');
    this.usersById.clear();
    this.userIdsByEmail.clear();
    this.sessions.clear();
    for (const [id, user] of snapshot.users) {
      this.usersById.set(id, user);
      if (user.email) this.userIdsByEmail.set(user.email, id);
    }
    for (const [id, session] of snapshot.sessions) this.sessions.set(id, session);
    this.audit = snapshot.audit;
  }

  async createUser(input: CreateAuthUserInput): Promise<AuthUserRecord> {
    return this.runExclusive(() => {
      const email = normalizeEmail(input.email);
      if (this.userIdsByEmail.has(email))
        throw new AuthStoreError('email_taken', 'email is already registered');
      const now = new Date();
      const user: AuthUserRecord = {
        id: randomUUID(),
        email,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        role: input.role ?? 'user',
        status: input.status ?? 'active',
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        createdAt: now,
        updatedAt: now,
      };
      this.usersById.set(user.id, user);
      this.userIdsByEmail.set(email, user.id);
      return cloneUser(user);
    });
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    return this.runExclusive(() => {
      const id = this.userIdsByEmail.get(normalizeEmail(email));
      return id ? this.findUserById(id) : undefined;
    });
  }

  async findUserById(id: string): Promise<AuthUserRecord | undefined> {
    return this.runExclusive(() => {
      const user = this.usersById.get(id);
      return user ? cloneUser(user) : undefined;
    });
  }

  async createSession(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    return this.runExclusive(() => {
      if (!this.usersById.has(input.userId))
        throw new AuthStoreError('invalid_user', 'user not found');
      if (this.sessions.has(input.id))
        throw new AuthStoreError('invalid_session', 'session already exists');
      const session: AuthSessionRecord = {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: new Date(input.expiresAt),
        createdAt: new Date(),
        ...(input.absoluteExpiresAt ? { absoluteExpiresAt: input.absoluteExpiresAt } : {}),
      };
      this.sessions.set(session.id, session);
      return cloneSession(session);
    });
  }

  async findSession(id: string): Promise<AuthSessionRecord | undefined> {
    return this.runExclusive(() => {
      const session = this.sessions.get(id);
      return session ? cloneSession(session) : undefined;
    });
  }

  async touchSession(id: string, lastUsedAt: Date): Promise<void> {
    await this.runExclusive(() => {
      const session = this.sessions.get(id);
      if (session) session.lastUsedAt = new Date(lastUsedAt);
    });
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    await this.runExclusive(() => {
      const session = this.sessions.get(id);
      if (session && !session.revokedAt) session.revokedAt = new Date(revokedAt);
    });
  }

  async revokeAllSessions(userId: string, revokedAt: Date): Promise<number> {
    return this.runExclusive(() => {
      let count = 0;
      for (const session of this.sessions.values()) {
        if (session.userId === userId && !session.revokedAt) {
          session.revokedAt = new Date(revokedAt);
          count += 1;
        }
      }
      return count;
    });
  }

  async close(): Promise<void> {
    await this.runExclusive(() => {
      this.usersById.clear();
      this.userIdsByEmail.clear();
      this.sessions.clear();
    });
  }

  /** 串行执行并在异常时还原快照，模拟数据库的回滚边界。 */
  async transaction<T>(operation: (store: AuthStore) => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const snapshot = structuredClone({
        users: this.usersById,
        emails: this.userIdsByEmail,
        sessions: this.sessions,
        audit: this.audit,
      });
      try {
        return await operation(this);
      } catch (error) {
        this.usersById.clear();
        for (const [key, value] of snapshot.users) this.usersById.set(key, value);
        this.userIdsByEmail.clear();
        for (const [key, value] of snapshot.emails) this.userIdsByEmail.set(key, value);
        this.sessions.clear();
        for (const [key, value] of snapshot.sessions) this.sessions.set(key, value);
        this.audit = snapshot.audit;
        throw error;
      }
    });
  }
  /** 返回账户副本，供服务端按业务筛选及分页。 */
  async listUsers(): Promise<AuthUserRecord[]> {
    return this.runExclusive(() => [...this.usersById.values()].map(cloneUser));
  }
  /** 更新账户白名单字段；邮箱唯一性与数据库实现一致。 */
  async updateUser(id: string, input: UpdateAuthUserInput): Promise<AuthUserRecord> {
    return this.runExclusive(() => {
      const user = this.usersById.get(id);
      if (!user) throw new AuthStoreError('invalid_user', 'user not found');
      const email = input.email ? normalizeEmail(input.email) : user.email;
      const existingId = email ? this.userIdsByEmail.get(email) : undefined;
      if (existingId && existingId !== id)
        throw new AuthStoreError('email_taken', 'email is already registered');
      if (user.email) this.userIdsByEmail.delete(user.email);
      if (email) this.userIdsByEmail.set(email, id);
      const next = { ...user, ...input, email, updatedAt: new Date() };
      this.usersById.set(id, next);
      return cloneUser(next);
    });
  }
  /** 返回指定用户的全部会话，公开接口负责隐藏令牌摘要。 */
  async listSessions(userId: string): Promise<AuthSessionRecord[]> {
    return this.runExclusive(() =>
      [...this.sessions.values()].filter((session) => session.userId === userId).map(cloneSession),
    );
  }
  /** 追加审计，调用方不能更新或删除既有记录。 */
  async appendAudit(event: AccountAuditRecord): Promise<void> {
    await this.runExclusive(() => {
      this.audit.push(structuredClone(event));
    });
  }
  /** 返回按时间倒序的审计记录。 */
  async listAudit(): Promise<AccountAuditRecord[]> {
    return this.runExclusive(() =>
      [...this.audit].reverse().map((entry) => structuredClone(entry)),
    );
  }
}

export class PrismaAuthStore implements AuthStore {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  async createUser(input: CreateAuthUserInput): Promise<AuthUserRecord> {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: normalizeEmail(input.email),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          role: input.role === 'admin' ? 'ADMIN' : 'USER',
          status: input.status ?? 'active',
          bio: input.bio,
          avatarUrl: input.avatarUrl,
        },
      });
      return mapUser(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthStoreError('email_taken', 'email is already registered');
      }
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const user = await this.prisma.user.findFirst({ where: { email: normalizeEmail(email) } });
    return user ? mapUser(user) : undefined;
  }

  async findUserById(id: string): Promise<AuthUserRecord | undefined> {
    if (!USER_UUID_PATTERN.test(id)) return undefined;
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? mapUser(user) : undefined;
  }

  async createSession(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
    const session = await this.prisma.authSession.create({
      data: {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
      },
    });
    return mapSession(session);
  }

  async findSession(id: string): Promise<AuthSessionRecord | undefined> {
    if (!USER_UUID_PATTERN.test(id)) return undefined;
    const session = await this.prisma.authSession.findUnique({ where: { id } });
    return session ? mapSession(session) : undefined;
  }

  async touchSession(id: string, lastUsedAt: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id, revokedAt: null },
      data: { lastUsedAt },
    });
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllSessions(userId: string, revokedAt: Date): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async close(): Promise<void> {
    if ('$disconnect' in this.prisma) await this.prisma.$disconnect();
  }

  /** PostgreSQL 事务锁跨 API 进程串行化账户状态变更，避免初始化和验证并发消费。 */
  async transaction<T>(operation: (store: AuthStore) => Promise<T>): Promise<T> {
    if (!('$transaction' in this.prisma)) return operation(this);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260906, 1200)`;
        return operation(new PrismaAuthStore(tx));
      },
      { timeout: 15000 },
    );
  }
  /** 列出账户元数据，密码摘要只留在服务内部。 */
  async listUsers(): Promise<AuthUserRecord[]> {
    return (
      await this.prisma.user.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })
    ).map(mapUser);
  }
  /** 更新白名单字段，并将唯一约束错误转换为稳定业务错误。 */
  async updateUser(id: string, input: UpdateAuthUserInput): Promise<AuthUserRecord> {
    try {
      return mapUser(
        await this.prisma.user.update({
          where: { id },
          data: { ...input, ...(input.email ? { email: normalizeEmail(input.email) } : {}) },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AuthStoreError('email_taken', 'email is already registered');
      throw error;
    }
  }
  /** 返回用户会话记录用于撤销与安全页面。 */
  async listSessions(userId: string): Promise<AuthSessionRecord[]> {
    return (
      await this.prisma.authSession.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    ).map(mapSession);
  }
  /** 保存不可变操作记录。 */
  async appendAudit(event: AccountAuditRecord): Promise<void> {
    await this.prisma.accountAudit.create({ data: { ...event, updatedAt: event.createdAt } });
  }
  /** 返回审计记录，外部接口仍需管理员身份与分页。 */
  async listAudit(): Promise<AccountAuditRecord[]> {
    return (
      await this.prisma.accountAudit.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10000,
      })
    ).map((row) => ({
      ...row,
      actorId: row.actorId ?? undefined,
      ownerId: row.ownerId ?? undefined,
      targetId: row.targetId ?? undefined,
    }));
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapUser(user: {
  id: string;
  email: string | null;
  displayName: string | null;
  role: PrismaUserRole;
  status?: string;
  bio?: string | null;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AuthUserRecord {
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role === 'ADMIN' ? 'admin' : 'user',
    status:
      user.status === 'disabled' ? 'disabled' : user.status === 'pending' ? 'pending' : 'active',
    ...(user.bio ? { bio: user.bio } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function mapSession(session: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  absoluteExpiresAt?: Date | null;
}): AuthSessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    tokenHash: session.tokenHash,
    expiresAt: session.expiresAt,
    ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
    createdAt: session.createdAt,
    ...(session.lastUsedAt ? { lastUsedAt: session.lastUsedAt } : {}),
    ...(session.absoluteExpiresAt ? { absoluteExpiresAt: session.absoluteExpiresAt } : {}),
  };
}

function cloneUser(user: AuthUserRecord): AuthUserRecord {
  return { ...user, ...(user.displayName ? { displayName: user.displayName } : {}) };
}

function cloneSession(session: AuthSessionRecord): AuthSessionRecord {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    createdAt: new Date(session.createdAt),
    ...(session.revokedAt ? { revokedAt: new Date(session.revokedAt) } : {}),
    ...(session.lastUsedAt ? { lastUsedAt: new Date(session.lastUsedAt) } : {}),
  };
}

function isUniqueViolation(value: unknown): value is Prisma.PrismaClientKnownRequestError {
  return value instanceof Prisma.PrismaClientKnownRequestError && value.code === 'P2002';
}

import { Prisma, PrismaClient, type UserRole as PrismaUserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { AuthRole } from './auth';

/** PostgreSQL 主键格式校验，避免无效路径 ID 触发底层 UUID 转换异常。 */
const USER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthUserRecord = {
  id: string;
  email: string;
  displayName?: string;
  passwordHash?: string;
  role: AuthRole;
  /** 存量账户默认 active，新增待验证账户为 pending。 */
  status: 'active' | 'pending' | 'disabled';
  bio?: string;
  avatarUrl?: string;
  emailVerifiedAt?: Date;
  verificationRequired?: boolean;
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
  passwordHash: string;
  displayName?: string;
  role?: AuthRole;
  status?: AuthUserRecord['status'];
  bio?: string;
  avatarUrl?: string;
  emailVerifiedAt?: Date;
};

export type CreateAuthSessionInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt?: Date;
};

/** 邮箱验证用途；不同用途的验证码不能交叉消费。 */
export type VerificationPurpose = 'bootstrap' | 'register' | 'invite' | 'email' | 'reset';
/** 一次性邮件挑战，payload 仅包含经服务端校验的待提交账户字段。 */
export type EmailChallengeRecord = {
  id: string;
  email: string;
  purpose: VerificationPurpose;
  userId?: string;
  codeHash: string;
  payload: Record<string, string>;
  attempts: number;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
};
/** 仅记录 SMTP 接收与失败，不代表收件箱送达。 */
export type EmailDeliveryRecord = {
  id: string;
  to: string;
  purpose: string;
  status: 'pending' | 'accepted' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
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
  Pick<
    AuthUserRecord,
    'email' | 'displayName' | 'passwordHash' | 'status' | 'bio' | 'avatarUrl' | 'emailVerifiedAt'
  >
>;

/** 本地文件存储使用版本化快照，日期和 Map 由标准 V8 序列化保留。 */
export type AuthStoreSnapshot = {
  version: 1;
  users: Map<string, AuthUserRecord>;
  sessions: Map<string, AuthSessionRecord>;
  initialized: boolean;
  challenges: Map<string, EmailChallengeRecord>;
  deliveries: Map<string, EmailDeliveryRecord>;
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
  /** 串行化敏感写入；同一事务中的初始化、验证消费和用户更改原子完成。 */
  transaction<T>(operation: (store: AuthStore) => Promise<T>): Promise<T>;
  listUsers(): Promise<AuthUserRecord[]>;
  updateUser(id: string, input: UpdateAuthUserInput): Promise<AuthUserRecord>;
  listSessions(userId: string): Promise<AuthSessionRecord[]>;
  bootstrapInitialized(): Promise<boolean>;
  markBootstrapInitialized(): Promise<void>;
  findChallenge(
    email: string,
    purpose: VerificationPurpose,
  ): Promise<EmailChallengeRecord | undefined>;
  saveChallenge(challenge: EmailChallengeRecord): Promise<void>;
  /** 身份敏感变更后撤销旧挑战，避免旧重置或换绑邮件恢复已撤销权限。 */
  invalidateChallenges(
    userId: string,
    consumedAt: Date,
    purpose?: VerificationPurpose,
  ): Promise<void>;
  saveDelivery(delivery: EmailDeliveryRecord): Promise<void>;
  listDeliveries(): Promise<EmailDeliveryRecord[]>;
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
  private initialized = false;
  private challenges = new Map<string, EmailChallengeRecord>();
  private deliveries = new Map<string, EmailDeliveryRecord>();
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
      initialized: this.initialized,
      challenges: this.challenges,
      deliveries: this.deliveries,
      audit: this.audit,
    });
  }
  /** 恢复经过版本检查的内部快照，不将解析失败误当成新安装。 */
  protected restore(snapshot: AuthStoreSnapshot): void {
    if (
      snapshot.version !== 1 ||
      !(snapshot.users instanceof Map) ||
      !(snapshot.sessions instanceof Map) ||
      !(snapshot.challenges instanceof Map) ||
      !(snapshot.deliveries instanceof Map) ||
      !Array.isArray(snapshot.audit)
    )
      throw new Error('账户存储格式损坏或版本不兼容');
    this.usersById.clear();
    this.userIdsByEmail.clear();
    this.sessions.clear();
    for (const [id, user] of snapshot.users) {
      this.usersById.set(id, user);
      this.userIdsByEmail.set(user.email, id);
    }
    for (const [id, session] of snapshot.sessions) this.sessions.set(id, session);
    this.initialized = snapshot.initialized;
    this.challenges = snapshot.challenges;
    this.deliveries = snapshot.deliveries;
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
        passwordHash: input.passwordHash,
        role: input.role ?? 'user',
        status: input.status ?? 'active',
        verificationRequired: input.status === 'pending',
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        ...(input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
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
        initialized: this.initialized,
        challenges: this.challenges,
        deliveries: this.deliveries,
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
        this.initialized = snapshot.initialized;
        this.challenges = snapshot.challenges;
        this.deliveries = snapshot.deliveries;
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
      const existingId = this.userIdsByEmail.get(email);
      if (existingId && existingId !== id)
        throw new AuthStoreError('email_taken', 'email is already registered');
      this.userIdsByEmail.delete(user.email);
      this.userIdsByEmail.set(email, id);
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
  /** 兼容已存在管理员的旧部署，并持久保留已初始化状态。 */
  async bootstrapInitialized(): Promise<boolean> {
    return this.runExclusive(() => {
      this.initialized ||= [...this.usersById.values()].some((user) => user.role === 'admin');
      return this.initialized;
    });
  }
  /** 仅在账户事务中调用，完成后不会因管理员被禁用而重新开放。 */
  async markBootstrapInitialized(): Promise<void> {
    await this.runExclusive(() => {
      this.initialized = true;
    });
  }
  /** 查找用途绑定的最新验证挑战。 */
  async findChallenge(
    email: string,
    purpose: VerificationPurpose,
  ): Promise<EmailChallengeRecord | undefined> {
    return this.runExclusive(() => {
      const value = this.challenges.get(`${email}:${purpose}`);
      return value ? structuredClone(value) : undefined;
    });
  }
  /** 替换最新挑战，重发自动使旧验证码失效。 */
  async saveChallenge(challenge: EmailChallengeRecord): Promise<void> {
    await this.runExclusive(() => {
      this.challenges.set(`${challenge.email}:${challenge.purpose}`, structuredClone(challenge));
    });
  }
  /** 按用户和用途撤销挑战，不保存或读取验证码明文。 */
  async invalidateChallenges(
    userId: string,
    consumedAt: Date,
    purpose?: VerificationPurpose,
  ): Promise<void> {
    await this.runExclusive(() => {
      for (const challenge of this.challenges.values())
        if (
          challenge.userId === userId &&
          (!purpose || challenge.purpose === purpose) &&
          !challenge.consumedAt
        )
          challenge.consumedAt = consumedAt;
    });
  }
  /** 保存不含邮件正文和验证码的投递状态。 */
  async saveDelivery(delivery: EmailDeliveryRecord): Promise<void> {
    await this.runExclusive(() => {
      this.deliveries.set(delivery.id, structuredClone(delivery));
    });
  }
  /** 返回最近的投递记录，避免管理页面无限增长。 */
  async listDeliveries(): Promise<EmailDeliveryRecord[]> {
    return this.runExclusive(() =>
      [...this.deliveries.values()]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 100)
        .map((entry) => structuredClone(entry)),
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
          passwordHash: input.passwordHash,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          role: input.role === 'admin' ? 'ADMIN' : 'USER',
          status: input.status ?? 'active',
          verificationRequired: input.status === 'pending',
          bio: input.bio,
          avatarUrl: input.avatarUrl,
          emailVerifiedAt: input.emailVerifiedAt,
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
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
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
  /** 首次兼容读取旧管理员后写入永久标记。 */
  async bootstrapInitialized(): Promise<boolean> {
    if (await this.prisma.adminBootstrap.findUnique({ where: { id: 'singleton' } })) return true;
    if (!(await this.prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } })))
      return false;
    await this.markBootstrapInitialized();
    return true;
  }
  /** 事务内幂等写入完成标记。 */
  async markBootstrapInitialized(): Promise<void> {
    await this.prisma.adminBootstrap.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  }
  /** 查找最新的邮件挑战，只返回内部用途数据。 */
  async findChallenge(
    email: string,
    purpose: VerificationPurpose,
  ): Promise<EmailChallengeRecord | undefined> {
    const row = await this.prisma.emailChallenge.findUnique({
      where: { email_purpose: { email, purpose } },
    });
    return row
      ? {
          ...row,
          purpose: row.purpose as VerificationPurpose,
          userId: row.userId ?? undefined,
          consumedAt: row.consumedAt ?? undefined,
          payload: row.payload as Record<string, string>,
        }
      : undefined;
  }
  /** 覆盖同用途挑战；消费和用户激活在同一事务中提交。 */
  async saveChallenge(challenge: EmailChallengeRecord): Promise<void> {
    const data = {
      ...challenge,
      userId: challenge.userId ?? null,
      consumedAt: challenge.consumedAt ?? null,
      updatedAt: new Date(),
    };
    await this.prisma.emailChallenge.upsert({
      where: { email_purpose: { email: challenge.email, purpose: challenge.purpose } },
      create: data,
      update: data,
    });
  }
  /** 与密码/邮箱/禁用修改共享事务，使旧挑战立即失效。 */
  async invalidateChallenges(
    userId: string,
    consumedAt: Date,
    purpose?: VerificationPurpose,
  ): Promise<void> {
    await this.prisma.emailChallenge.updateMany({
      where: { userId, ...(purpose ? { purpose } : {}), consumedAt: null },
      data: { consumedAt },
    });
  }
  /** 持久化邮件状态，失败诊断必须由调用方预先脱敏。 */
  async saveDelivery(delivery: EmailDeliveryRecord): Promise<void> {
    await this.prisma.emailDelivery.upsert({
      where: { id: delivery.id },
      create: delivery,
      update: delivery,
    });
  }
  /** 最近一百封的 SMTP 结果，不包含邮件正文。 */
  async listDeliveries(): Promise<EmailDeliveryRecord[]> {
    return (
      await this.prisma.emailDelivery.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
    ).map((row) => ({
      ...row,
      status: row.status as EmailDeliveryRecord['status'],
      error: row.error ?? undefined,
    }));
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
  email: string;
  displayName: string | null;
  passwordHash: string | null;
  role: PrismaUserRole;
  status?: string;
  bio?: string | null;
  avatarUrl?: string | null;
  emailVerifiedAt?: Date | null;
  verificationRequired?: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
    role: user.role === 'ADMIN' ? 'admin' : 'user',
    status:
      user.status === 'disabled' ? 'disabled' : user.status === 'pending' ? 'pending' : 'active',
    verificationRequired: user.verificationRequired ?? false,
    ...(user.bio ? { bio: user.bio } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.emailVerifiedAt ? { emailVerifiedAt: user.emailVerifiedAt } : {}),
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

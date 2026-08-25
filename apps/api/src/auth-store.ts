import { Prisma, PrismaClient, type UserRole as PrismaUserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { AuthRole } from './auth';

export type AuthUserRecord = {
  id: string;
  email: string;
  displayName?: string;
  passwordHash?: string;
  role: AuthRole;
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
};

export type CreateAuthUserInput = {
  email: string;
  passwordHash: string;
  displayName?: string;
  role?: AuthRole;
};

export type CreateAuthSessionInput = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
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

  async createUser(input: CreateAuthUserInput): Promise<AuthUserRecord> {
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
      createdAt: now,
      updatedAt: now,
    };
    this.usersById.set(user.id, user);
    this.userIdsByEmail.set(email, user.id);
    return cloneUser(user);
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const id = this.userIdsByEmail.get(normalizeEmail(email));
    return id ? this.findUserById(id) : undefined;
  }

  async findUserById(id: string): Promise<AuthUserRecord | undefined> {
    const user = this.usersById.get(id);
    return user ? cloneUser(user) : undefined;
  }

  async createSession(input: CreateAuthSessionInput): Promise<AuthSessionRecord> {
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
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  async findSession(id: string): Promise<AuthSessionRecord | undefined> {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  async touchSession(id: string, lastUsedAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.lastUsedAt = new Date(lastUsedAt);
  }

  async revokeSession(id: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !session.revokedAt) session.revokedAt = new Date(revokedAt);
  }

  async revokeAllSessions(userId: string, revokedAt: Date): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = new Date(revokedAt);
        count += 1;
      }
    }
    return count;
  }

  async close(): Promise<void> {
    this.usersById.clear();
    this.userIdsByEmail.clear();
    this.sessions.clear();
  }
}

export class PrismaAuthStore implements AuthStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createUser(input: CreateAuthUserInput): Promise<AuthUserRecord> {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: normalizeEmail(input.email),
          passwordHash: input.passwordHash,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          role: input.role === 'admin' ? 'ADMIN' : 'USER',
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
      },
    });
    return mapSession(session);
  }

  async findSession(id: string): Promise<AuthSessionRecord | undefined> {
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
    await this.prisma.$disconnect();
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
  createdAt: Date;
  updatedAt: Date;
}): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
    role: user.role === 'ADMIN' ? 'admin' : 'user',
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
}): AuthSessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    tokenHash: session.tokenHash,
    expiresAt: session.expiresAt,
    ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
    createdAt: session.createdAt,
    ...(session.lastUsedAt ? { lastUsedAt: session.lastUsedAt } : {}),
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

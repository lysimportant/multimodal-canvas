import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { MediaType } from '@multimodal-canvas/domain';

import type { BlobStore } from './assets';

export const DIRECT_UPLOAD_TTL_MS = 15 * 60 * 1000;

export type UploadSessionInput = {
  name: string;
  mimeType: string;
  mediaType: Exclude<MediaType | undefined, undefined>;
  sizeBytes: number;
  sha256: string;
  tags: string[];
  ownerId?: string;
};

export type UploadSessionScope = {
  ownerId?: string;
};

export type UploadSession = UploadSessionInput & {
  uploadId: string;
  createdAt: number;
  expiresAt: number;
  content?: Buffer;
};

/** Storage boundary for resumable/direct upload metadata and bytes. */
export interface UploadSessionStore {
  create(input: UploadSessionInput): Promise<UploadSession>;
  get(uploadId: string, scope?: UploadSessionScope): Promise<UploadSession | undefined>;
  putContent(uploadId: string, content: Buffer, scope?: UploadSessionScope): Promise<void>;
  getContent(uploadId: string, scope?: UploadSessionScope): Promise<Buffer | undefined>;
  delete(uploadId: string, scope?: UploadSessionScope): Promise<void>;
  /** Returns an external PUT URL when storage supports presigning. */
  getUploadUrl(uploadId: string, scope?: UploadSessionScope): Promise<string | undefined>;
  close?(): Promise<void> | void;
}

/** Volatile implementation used by tests and development without PostgreSQL. */
export class MemoryUploadSessionStore implements UploadSessionStore {
  private readonly sessions = new Map<string, UploadSession>();

  constructor(
    private readonly options: {
      now?: () => number;
      uploadUrl?: (uploadId: string) => string;
    } = {},
  ) {}

  async create(input: UploadSessionInput): Promise<UploadSession> {
    const now = this.options.now?.() ?? Date.now();
    const session: UploadSession = {
      ...input,
      tags: [...input.tags],
      uploadId: `upload_${randomUUID()}`,
      createdAt: now,
      expiresAt: now + DIRECT_UPLOAD_TTL_MS,
    };
    this.sessions.set(session.uploadId, session);
    return cloneSession(session);
  }

  async get(uploadId: string, scope: UploadSessionScope = {}): Promise<UploadSession | undefined> {
    const session = this.sessions.get(uploadId);
    return session && matchesScope(session, scope) ? cloneSession(session) : undefined;
  }

  async putContent(
    uploadId: string,
    content: Buffer,
    scope: UploadSessionScope = {},
  ): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session || !matchesScope(session, scope)) throw new Error('upload session not found');
    session.content = Buffer.from(content);
  }

  async getContent(uploadId: string, scope: UploadSessionScope = {}): Promise<Buffer | undefined> {
    const session = this.sessions.get(uploadId);
    return session && matchesScope(session, scope) && session.content
      ? Buffer.from(session.content)
      : undefined;
  }

  async delete(uploadId: string, scope: UploadSessionScope = {}): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (session && matchesScope(session, scope)) this.sessions.delete(uploadId);
  }

  async getUploadUrl(
    uploadId: string,
    scope: UploadSessionScope = {},
  ): Promise<string | undefined> {
    if (!(await this.get(uploadId, scope))) return undefined;
    return this.options.uploadUrl?.(uploadId);
  }

  close(): void {
    this.sessions.clear();
  }
}

export type PrismaUploadSessionStoreOptions = {
  blobStore: BlobStore;
  keyPrefix?: string;
  uploadUrlForKey?: (contentKey: string, session: UploadSession) => Promise<string>;
  now?: () => number;
};

/** PostgreSQL-backed upload metadata with bytes stored behind BlobStore. */
export class PrismaUploadSessionStore implements UploadSessionStore {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PrismaUploadSessionStoreOptions,
  ) {
    this.keyPrefix = trimPrefix(options.keyPrefix ?? 'uploads');
    this.now = options.now ?? Date.now;
  }

  async create(input: UploadSessionInput): Promise<UploadSession> {
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + DIRECT_UPLOAD_TTL_MS);
    const uploadId = `upload_${randomUUID()}`;
    const contentKey = `${this.keyPrefix}/${uploadId}`;
    const row = await this.prisma.uploadSession.create({
      data: {
        uploadId,
        name: input.name,
        mimeType: input.mimeType,
        mediaType: input.mediaType.toUpperCase() as 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO',
        sizeBytes: BigInt(input.sizeBytes),
        sha256: input.sha256,
        tags: [...input.tags],
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        contentKey,
        createdAt,
        expiresAt,
      },
    });
    return mapRow(row);
  }

  async get(uploadId: string, scope: UploadSessionScope = {}): Promise<UploadSession | undefined> {
    const row = await this.prisma.uploadSession.findFirst({
      where: { uploadId, ...scopeWhere(scope) },
    });
    return row ? mapRow(row) : undefined;
  }

  async putContent(
    uploadId: string,
    content: Buffer,
    scope: UploadSessionScope = {},
  ): Promise<void> {
    const row = await this.prisma.uploadSession.findUnique({
      where: { uploadId },
      select: { contentKey: true },
    });
    const session = await this.get(uploadId, scope);
    if (!row || !session) throw new Error('upload session not found');
    await this.options.blobStore.put(row.contentKey, content);
  }

  async getContent(uploadId: string, scope: UploadSessionScope = {}): Promise<Buffer | undefined> {
    const row = await this.prisma.uploadSession.findFirst({
      where: { uploadId, ...scopeWhere(scope) },
      select: { contentKey: true },
    });
    return row ? this.options.blobStore.get(row.contentKey) : undefined;
  }

  async delete(uploadId: string, scope: UploadSessionScope = {}): Promise<void> {
    const session = await this.get(uploadId, scope);
    if (!session) return;
    const row = await this.prisma.uploadSession.findUnique({
      where: { uploadId },
      select: { contentKey: true },
    });
    if (!row) return;
    await this.prisma.uploadSession.delete({ where: { uploadId } });
    await this.options.blobStore.delete(row.contentKey).catch(() => undefined);
  }

  async getUploadUrl(
    uploadId: string,
    scope: UploadSessionScope = {},
  ): Promise<string | undefined> {
    if (!this.options.uploadUrlForKey) return undefined;
    const session = await this.get(uploadId, scope);
    if (!session) return undefined;
    const row = await this.prisma.uploadSession.findUnique({
      where: { uploadId },
      select: { contentKey: true },
    });
    return row ? this.options.uploadUrlForKey(row.contentKey, session) : undefined;
  }
}

function mapRow(row: {
  uploadId: string;
  name: string;
  mimeType: string;
  mediaType: string;
  sizeBytes: bigint;
  sha256: string;
  tags: string[];
  createdAt: Date;
  expiresAt: Date;
  ownerId?: string | null;
}): UploadSession {
  return {
    uploadId: row.uploadId,
    name: row.name,
    mimeType: row.mimeType,
    mediaType: row.mediaType.toLowerCase() as UploadSession['mediaType'],
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    tags: [...row.tags],
    ...(row.ownerId ? { ownerId: row.ownerId } : {}),
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

function matchesScope(session: UploadSession, scope: UploadSessionScope): boolean {
  return !scope.ownerId || session.ownerId === scope.ownerId;
}

function scopeWhere(scope: UploadSessionScope): { ownerId?: string } {
  return scope.ownerId ? { ownerId: scope.ownerId } : {};
}

function cloneSession(session: UploadSession): UploadSession {
  return {
    ...session,
    tags: [...session.tags],
    ...(session.content ? { content: Buffer.from(session.content) } : {}),
  };
}

function trimPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error('invalid upload key prefix');
  }
  return normalized;
}

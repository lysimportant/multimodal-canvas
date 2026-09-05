import { createHash } from 'node:crypto';
import {
  createCredentialEncryptionKeyringFromEnvironment,
  type CredentialEncryptionKeyring,
} from '@multimodal-canvas/credential-crypto';
import { PrismaClient, type Prisma, type RunStatus as PrismaRunStatus } from '@prisma/client';
import {
  providerJobSchema,
  type ProviderJob,
  type RunResult,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';
import type { RunPersistence, WorkerCredentialReference, WorkerProviderCredentials } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Worker-side Prisma adapter. API creates the row; worker only reconciles lifecycle state. */
export class WorkerPrismaRunPersistence implements RunPersistence {
  private readonly credentialKeyring?: CredentialEncryptionKeyring;

  constructor(
    private readonly prisma: PrismaClient,
    encryptionSecret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
  ) {
    // The API and Worker must share this secret. Never derive a process-local
    // fallback: queued snapshots must remain resumable across restarts.
    if (encryptionSecret?.trim()) {
      this.credentialKeyring = createCredentialEncryptionKeyringFromEnvironment({
        ...process.env,
        AI_CREDENTIAL_ENCRYPTION_KEY: encryptionSecret,
      });
    }
  }

  async close() {
    await this.prisma.$disconnect();
  }

  /**
   * 按冻结 ID/版本解析凭据，缺少完整引用时返回 undefined。
   * 重加密保留业务时间及版本，并通过 CAS 避免覆盖其他实例；解密、写回或并发
   * 冲突均显式失败，不返回未完成持久化的凭据，也不回退到当前活动 Key。
   */
  async getProviderCredentials(
    reference: WorkerCredentialReference,
  ): Promise<WorkerProviderCredentials | undefined> {
    if (
      !reference.credentialId ||
      !UUID_PATTERN.test(reference.credentialId) ||
      !Number.isInteger(reference.credentialVersion) ||
      (reference.credentialVersion ?? 0) < 1
    ) {
      return undefined;
    }
    if (!this.credentialKeyring) {
      throw new Error(
        'AI_CREDENTIAL_ENCRYPTION_KEY is required to resolve a run credential snapshot',
      );
    }
    const credential = await this.prisma.aiCredential.findFirst({
      where: {
        id: reference.credentialId,
        version: reference.credentialVersion,
        projectId: null,
      },
      select: { baseUrl: true, encryptedApiKey: true, encryptionKeyId: true, updatedAt: true },
    });
    if (!credential) return undefined;
    const decrypted = this.credentialKeyring.decrypt(
      credential.encryptedApiKey,
      credential.encryptionKeyId ?? undefined,
    );
    if (decrypted.needsReencryption) {
      if (typeof this.prisma.aiCredential.update !== 'function') {
        throw new Error('AI credential rotation requires a durable credential update method');
      }
      const rotated = this.credentialKeyring.encrypt(decrypted.plaintext);
      try {
        await this.prisma.aiCredential.update({
          where: {
            id: reference.credentialId,
            version: reference.credentialVersion,
            encryptedApiKey: credential.encryptedApiKey,
            encryptionKeyId: credential.encryptionKeyId ?? null,
            updatedAt: credential.updatedAt,
          },
          data: {
            encryptedApiKey: rotated,
            encryptionKeyId: this.credentialKeyring.currentKeyId,
            updatedAt: credential.updatedAt,
          },
        });
      } catch {
        throw new Error('AI credential rotation could not be persisted');
      }
    }
    return { baseUrl: credential.baseUrl, apiKey: decrypted.plaintext };
  }

  async ensureRun(input: {
    runId: string;
    snapshot: RunSnapshot;
    status?: RunStatus;
    attempt?: number;
    provider?: string;
    providerJob?: ProviderJob;
  }) {
    const runId = databaseRunId(input.runId);
    const inputRows = input.snapshot.inputs.map((runInput) => ({
      nodeId: runInput.nodeId,
      role: runInput.role,
      sortOrder: runInput.sortOrder,
      ...(runInput.sourceAssetId && UUID_PATTERN.test(runInput.sourceAssetId)
        ? { sourceAssetId: runInput.sourceAssetId }
        : {}),
      snapshot: runInput.snapshot as Prisma.InputJsonValue,
    }));
    return this.prisma.run.upsert({
      where: { id: runId },
      create: {
        id: runId,
        projectId: input.snapshot.projectId,
        status: toPrismaStatus(input.status ?? 'queued'),
        modelAlias: input.snapshot.modelAlias,
        ...(input.snapshot.credentialId && UUID_PATTERN.test(input.snapshot.credentialId)
          ? { credentialId: input.snapshot.credentialId }
          : {}),
        ...(input.snapshot.credentialVersion
          ? { credentialVersion: input.snapshot.credentialVersion }
          : {}),
        snapshot: input.snapshot as Prisma.InputJsonValue,
        parameters: input.snapshot.parameters as Prisma.InputJsonValue,
        // `attempt` is managed by the API snapshot and is not part of the
        // generated Prisma create input in older migrations. It is reconciled
        // by the API persistence adapter when available.
        ...(inputRows.length > 0 ? { inputs: { create: inputRows } } : {}),
      },
      update: { status: toPrismaStatus(input.status ?? 'queued') },
    });
  }

  async updateRun(input: {
    runId: string;
    status: RunStatus;
    providerJob?: ProviderJob;
    result?: RunResult;
    error?: string;
  }) {
    return this.prisma.run.update({
      where: { id: databaseRunId(input.runId) },
      data: {
        status: toPrismaStatus(input.status),
        ...(input.result ? { result: input.result as Prisma.InputJsonValue } : {}),
        ...(input.error ? { error: { message: input.error } as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async upsertProviderJob(input: { runId: string; providerJob: ProviderJob }) {
    const providerJob = input.providerJob;
    const id = stableProviderJobId(providerJob.provider, providerJob.id);
    const create = {
      id,
      runId: databaseRunId(input.runId),
      provider: providerJob.provider,
      ...(providerJob.platformJobId ? { platformJobId: providerJob.platformJobId } : {}),
      status: providerJob.status,
      progress: providerJob.progress,
      ...(providerJob.payload ? { payload: providerJob.payload as Prisma.InputJsonValue } : {}),
      createdAt: new Date(providerJob.createdAt),
      updatedAt: new Date(providerJob.updatedAt),
    };
    const update = {
      runId: databaseRunId(input.runId),
      status: providerJob.status,
      progress: providerJob.progress,
      ...(providerJob.platformJobId ? { platformJobId: providerJob.platformJobId } : {}),
      ...(providerJob.payload ? { payload: providerJob.payload as Prisma.InputJsonValue } : {}),
      updatedAt: new Date(providerJob.updatedAt),
    };
    try {
      return await this.prisma.providerJob.upsert({ where: { id }, create, update });
    } catch (error) {
      if (!providerJob.platformJobId || !isPrismaUniqueConstraintError(error)) throw error;
      return this.prisma.providerJob.upsert({
        where: {
          provider_platformJobId: {
            provider: providerJob.provider,
            platformJobId: providerJob.platformJobId,
          },
        },
        create,
        update,
      });
    }
  }

  /**
   * Find a durable asynchronous task that a retry can resume. The lookup is
   * intentionally scoped to the predecessor run and only returns rows with a
   * platform identity; local queued records must never be mistaken for a
   * provider task.
   */
  async findProviderJobByRunId(runId: string): Promise<ProviderJob | undefined> {
    const row = await this.prisma.providerJob.findFirst({
      where: {
        runId: databaseRunId(runId),
        platformJobId: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row?.platformJobId) return undefined;
    const parsed = providerJobSchema.safeParse({
      id: `provider_job_${runId}`,
      provider: row.provider,
      platformJobId: row.platformJobId,
      status: String(row.status).toLowerCase(),
      progress: row.progress,
      ...(row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? { payload: row.payload }
        : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Returns every durable workflow task for a previous DAG attempt. This also
   * includes synchronous completions without a platform identity because their
   * sanitized payload contains the archived result needed to skip regeneration.
   */
  async findProviderJobsByRunId(runId: string): Promise<ProviderJob[]> {
    const rows = await this.prisma.providerJob.findMany({
      where: { runId: databaseRunId(runId) },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.flatMap((row) => {
      const parsed = providerJobSchema.safeParse({
        id: `provider_job_${runId}`,
        provider: row.provider,
        ...(row.platformJobId ? { platformJobId: row.platformJobId } : {}),
        status: String(row.status).toLowerCase(),
        progress: row.progress,
        ...(row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? { payload: row.payload }
          : {}),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
      return parsed.success ? [parsed.data] : [];
    });
  }

  async recordUsage(input: {
    runId?: string;
    userId?: string;
    providerJobId?: string;
    eventId?: string;
    kind?: string;
    amount: number | string;
    currency?: string;
    metadata?: Record<string, unknown>;
  }) {
    const runId = input.runId ? databaseRunId(input.runId) : undefined;
    const linkedRun =
      !input.userId && runId
        ? await this.prisma.run.findUnique({ where: { id: runId }, select: { userId: true } })
        : undefined;
    const metadata = input.metadata;
    const providerJobId = normalizeUsageIdentity(input.providerJobId ?? metadata?.providerJobId);
    const eventId = normalizeUsageIdentity(input.eventId ?? metadata?.eventId);
    const kind = normalizeUsageKind(input.kind ?? metadata?.kind);
    const idempotencyKey = stableUsageLedgerIdempotencyKey({ providerJobId, eventId, kind });
    const data = {
      ...(runId ? { runId } : {}),
      ...(input.userId && UUID_PATTERN.test(input.userId)
        ? { userId: input.userId }
        : linkedRun?.userId
          ? { userId: linkedRun.userId }
          : {}),
      ...(providerJobId ? { providerJobId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(kind ? { kind } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      amount: String(input.amount),
      currency: (input.currency ?? 'USD').toUpperCase(),
      ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
    };

    if (!idempotencyKey) {
      return this.prisma.usageLedger.create({ data });
    }

    return this.prisma.usageLedger.upsert({
      where: { idempotencyKey },
      create: {
        id: stableUsageLedgerId(idempotencyKey),
        ...data,
      },
      update: {},
    });
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export function createWorkerPrismaPersistence(): WorkerPrismaRunPersistence | undefined {
  if (!process.env.DATABASE_URL) return undefined;
  return new WorkerPrismaRunPersistence(new PrismaClient());
}

export const createWorkerPersistenceFromEnvironment = createWorkerPrismaPersistence;

function toPrismaStatus(status: RunStatus): PrismaRunStatus {
  return status.toUpperCase() as PrismaRunStatus;
}

export function databaseRunId(runId: string): string {
  if (UUID_PATTERN.test(runId)) return runId;
  const digest = createHash('sha256').update(`multimodal-canvas:run:${runId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function stableProviderJobId(provider: string, providerJobId: string): string {
  const digest = createHash('sha256')
    .update(`multimodal-canvas:provider-job:${provider}:${providerJobId}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

type UsageIdentity = {
  providerJobId?: string;
  eventId?: string;
  kind?: string;
};

export function stableUsageLedgerIdempotencyKey(identity: UsageIdentity): string | undefined {
  const providerJobId = normalizeUsageIdentity(identity.providerJobId);
  const eventId = normalizeUsageIdentity(identity.eventId);
  const kind = normalizeUsageKind(identity.kind) ?? '';
  const source = providerJobId
    ? `providerJobId:${providerJobId}`
    : eventId
      ? `eventId:${eventId}`
      : undefined;
  if (!source) return undefined;

  return createHash('sha256')
    .update(`multimodal-canvas:usage-ledger:v1:${source}\u0000kind:${kind}`)
    .digest('hex');
}

export function stableUsageLedgerId(idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`multimodal-canvas:usage-ledger-id:${idempotencyKey}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function normalizeUsageIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUsageKind(value: unknown): string | undefined {
  const normalized = normalizeUsageIdentity(value);
  return normalized?.toLowerCase();
}

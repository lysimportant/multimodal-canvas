import { createHash } from 'node:crypto';
import { PrismaClient, type Prisma, type RunStatus as PrismaRunStatus } from '@prisma/client';
import type { ProviderJob, RunResult, RunSnapshot, RunStatus } from '@multimodal-canvas/domain';
import type { RunPersistence } from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Worker-side Prisma adapter. API creates the row; worker only reconciles lifecycle state. */
export class WorkerPrismaRunPersistence implements RunPersistence {
  constructor(private readonly prisma: PrismaClient) {}

  async close() {
    await this.prisma.$disconnect();
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
    return this.prisma.providerJob.upsert({
      where: { id },
      create: {
        id,
        runId: databaseRunId(input.runId),
        provider: providerJob.provider,
        ...(providerJob.platformJobId ? { platformJobId: providerJob.platformJobId } : {}),
        status: providerJob.status,
        progress: providerJob.progress,
        ...(providerJob.payload ? { payload: providerJob.payload as Prisma.InputJsonValue } : {}),
        createdAt: new Date(providerJob.createdAt),
        updatedAt: new Date(providerJob.updatedAt),
      },
      update: {
        status: providerJob.status,
        progress: providerJob.progress,
        ...(providerJob.platformJobId ? { platformJobId: providerJob.platformJobId } : {}),
        ...(providerJob.payload ? { payload: providerJob.payload as Prisma.InputJsonValue } : {}),
        updatedAt: new Date(providerJob.updatedAt),
      },
    });
  }

  async recordUsage(input: {
    runId?: string;
    userId?: string;
    amount: number | string;
    currency?: string;
    metadata?: Record<string, unknown>;
  }) {
    const runId = input.runId ? databaseRunId(input.runId) : undefined;
    const linkedRun =
      !input.userId && runId
        ? await this.prisma.run.findUnique({ where: { id: runId }, select: { userId: true } })
        : undefined;
    return this.prisma.usageLedger.create({
      data: {
        ...(runId ? { runId } : {}),
        ...(input.userId && UUID_PATTERN.test(input.userId)
          ? { userId: input.userId }
          : linkedRun?.userId
            ? { userId: linkedRun.userId }
            : {}),
        amount: String(input.amount),
        currency: (input.currency ?? 'USD').toUpperCase(),
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }
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

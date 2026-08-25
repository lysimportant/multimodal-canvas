import { createHash } from 'node:crypto';

import type { ProviderJob, RunResult, RunSnapshot, RunStatus } from '@multimodal-canvas/domain';
import { Prisma, PrismaClient, type RunStatus as PrismaRunStatus } from '@prisma/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT_PATTERN = /^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type RunPersistenceErrorCode =
  'invalid_uuid' | 'invalid_amount' | 'invalid_currency' | 'invalid_run';

export class RunPersistenceError extends Error {
  constructor(
    public readonly code: RunPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ProviderJobPersistenceInput = {
  /** Database Run.id, not the BullMQ/API run identifier. */
  runId: string;
  providerJob: ProviderJob;
};

export type EnsureRunPersistenceInput = {
  /** BullMQ/API identifier. It is deterministically mapped to a DB UUID. */
  runId: string;
  snapshot: RunSnapshot;
  status?: RunStatus;
  attempt?: number;
  provider?: string;
  userId?: string;
  retryOf?: string;
  idempotencyKey?: string;
  cost?: string | number;
  costCurrency?: string;
  providerJob?: ProviderJob;
  error?: string;
};

export type UpdateRunPersistenceInput = {
  /** BullMQ/API identifier. It is deterministically mapped to a DB UUID. */
  runId: string;
  status: RunStatus;
  providerJob?: ProviderJob;
  result?: RunResult;
  error?: string;
};

export type UsageLedgerPersistenceInput = {
  /** Optional database Run.id, not the BullMQ/API run identifier. */
  runId?: string;
  /** Optional database User.id. */
  userId?: string;
  amount: number | string;
  currency?: string;
  metadata?: Record<string, unknown>;
};

type PersistenceClient = Pick<PrismaClient, 'run' | 'providerJob' | 'usageLedger'>;

/**
 * Minimal persistence boundary for provider jobs and usage records.
 *
 * BullMQ identifiers are intentionally not coerced into UUIDs. Callers must
 * resolve the API run identifier to the database Run.id before persisting a
 * provider job or usage entry.
 */
export class PrismaRunPersistence {
  constructor(private readonly prisma: PersistenceClient) {}

  /**
   * Create the immutable run snapshot and its ordered input rows before the
   * BullMQ job is published. Repeated calls only update mutable lifecycle
   * fields, so retries and worker restarts cannot duplicate RunInput records.
   */
  async ensureRun(input: EnsureRunPersistenceInput) {
    const runId = databaseRunId(input.runId);
    const snapshot = input.snapshot;
    const projectId = requireUuid(snapshot.projectId, 'projectId');
    const userId = input.userId ? requireUuid(input.userId, 'userId') : undefined;
    const credentialId = snapshot.credentialId
      ? requireUuid(snapshot.credentialId, 'credentialId')
      : undefined;
    const status = toPrismaRunStatus(input.status ?? 'queued');
    const provider = input.provider ?? input.providerJob?.provider ?? 'mock';
    const attempt = input.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RunPersistenceError('invalid_run', 'run attempt must be a positive integer');
    }
    const cost = input.cost === undefined ? undefined : normalizeAmount(input.cost);
    const costCurrency = input.costCurrency ? normalizeCurrency(input.costCurrency) : undefined;

    const inputRows = snapshot.inputs.map((runInput) => ({
      nodeId: runInput.nodeId,
      role: runInput.role,
      sortOrder: runInput.sortOrder,
      ...(runInput.sourceAssetId
        ? { sourceAssetId: requireUuid(runInput.sourceAssetId, 'sourceAssetId') }
        : {}),
      snapshot: runInput.snapshot as Prisma.InputJsonValue,
    }));
    const data = {
      projectId,
      ...(userId ? { userId } : {}),
      status,
      modelAlias: snapshot.modelAlias,
      ...(credentialId ? { credentialId } : {}),
      ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
      snapshot: snapshot as Prisma.InputJsonValue,
      parameters: snapshot.parameters as Prisma.InputJsonValue,
      attempt,
      ...(cost !== undefined ? { cost } : {}),
      ...(costCurrency ? { costCurrency } : {}),
      ...(input.retryOf ? { retryOf: databaseRunId(input.retryOf) } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.error ? { error: { message: input.error } as Prisma.InputJsonValue } : {}),
      ...(inputRows.length > 0 ? { inputs: { create: inputRows } } : {}),
    };

    return this.prisma.run.upsert({
      where: { id: runId },
      create: { id: runId, ...data },
      update: {
        status,
        attempt,
        ...(cost !== undefined ? { cost } : {}),
        ...(costCurrency ? { costCurrency } : {}),
        ...(input.retryOf ? { retryOf: databaseRunId(input.retryOf) } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.error ? { error: { message: input.error } as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async updateRun(input: UpdateRunPersistenceInput) {
    const runId = databaseRunId(input.runId);
    const status = toPrismaRunStatus(input.status);
    const error = input.error
      ? ({ message: input.error } as Prisma.InputJsonValue)
      : input.status === 'failed'
        ? ({ message: 'run failed' } as Prisma.InputJsonValue)
        : undefined;
    return this.prisma.run.update({
      where: { id: runId },
      data: {
        status,
        ...(input.result ? { result: input.result as Prisma.InputJsonValue } : {}),
        ...(error ? { error } : {}),
      },
    });
  }

  async upsertProviderJob(input: ProviderJobPersistenceInput) {
    const runId = requireUuid(input.runId, 'runId');
    const providerJob = input.providerJob;
    const id = stableProviderJobId(providerJob.provider, providerJob.id);
    const createdAt = parseDate(providerJob.createdAt, 'createdAt');
    const updatedAt = parseDate(providerJob.updatedAt, 'updatedAt');
    const data = {
      runId,
      provider: providerJob.provider,
      ...(providerJob.platformJobId ? { platformJobId: providerJob.platformJobId } : {}),
      status: providerJob.status,
      progress: providerJob.progress,
      ...(providerJob.payload ? { payload: providerJob.payload as Prisma.InputJsonValue } : {}),
      createdAt,
      updatedAt,
    };

    return this.prisma.providerJob.upsert({
      where: { id },
      create: { id, ...data },
      update: {
        runId: data.runId,
        provider: data.provider,
        ...(data.platformJobId !== undefined ? { platformJobId: data.platformJobId } : {}),
        status: data.status,
        progress: data.progress,
        ...(data.payload !== undefined ? { payload: data.payload } : {}),
        updatedAt: data.updatedAt,
      },
    });
  }

  async recordUsage(input: UsageLedgerPersistenceInput) {
    const runId = input.runId ? requireUuid(input.runId, 'runId') : undefined;
    const explicitUserId = input.userId ? requireUuid(input.userId, 'userId') : undefined;
    const linkedRun =
      !explicitUserId && runId && typeof this.prisma.run.findUnique === 'function'
        ? await this.prisma.run.findUnique({ where: { id: runId }, select: { userId: true } })
        : undefined;
    const userId = explicitUserId ?? linkedRun?.userId ?? undefined;
    const amount = normalizeAmount(input.amount);
    const currency = normalizeCurrency(input.currency);

    return this.prisma.usageLedger.create({
      data: {
        ...(runId ? { runId } : {}),
        ...(userId ? { userId } : {}),
        amount,
        currency,
        ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }
}

export function isPrismaUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function requireUuid(
  value: string,
  field: 'runId' | 'userId' | 'projectId' | 'sourceAssetId' | 'credentialId',
): string {
  if (!isPrismaUuid(value)) {
    throw new RunPersistenceError(
      'invalid_uuid',
      `${field} must be a database UUID; resolve the BullMQ run identifier before persistence`,
    );
  }
  return value;
}

/** Stable UUID for a BullMQ/API run identifier. */
export function databaseRunId(externalRunId: string): string {
  if (isPrismaUuid(externalRunId)) return externalRunId;
  const digest = createHash('sha256')
    .update(`multimodal-canvas:run:${externalRunId}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function toPrismaRunStatus(status: RunStatus): PrismaRunStatus {
  return status.toUpperCase() as PrismaRunStatus;
}

function normalizeAmount(value: number | string): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!AMOUNT_PATTERN.test(raw)) {
    throw new RunPersistenceError(
      'invalid_amount',
      'usage amount must fit Decimal(18,6) and use a plain decimal string',
    );
  }
  return raw;
}

function normalizeCurrency(value: string | undefined): string {
  const currency = (value ?? 'USD').trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RunPersistenceError('invalid_currency', 'usage currency must be a 3-letter code');
  }
  return currency;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`provider job ${field} is invalid`);
  return date;
}

/** Stable UUID primary key for one provider + external provider-job identity. */
export function stableProviderJobId(provider: string, providerJobId: string): string {
  const digest = createHash('sha256')
    .update(`multimodal-canvas:provider-job:${provider}:${providerJobId}`)
    .digest('hex');
  const hex = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return hex;
}

import { createHash } from 'node:crypto';

import {
  providerJobSchema,
  runRecordSchema,
  runResultSchema,
  runSnapshotSchema,
  type ProviderJob,
  type RunRecord,
  type RunResult,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';
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
  /** Provider's stable job identifier, when the provider reports one. */
  providerJobId?: string;
  /** Provider webhook/event identifier, when the provider reports one. */
  eventId?: string;
  /** Usage event kind (for example, generation or completion). */
  kind?: string;
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

  /** Restore one durable run when its BullMQ job has already expired. */
  async getRun(externalRunId: string): Promise<RunRecord | undefined> {
    const row = await this.prisma.run.findUnique({
      where: { id: databaseRunId(externalRunId) },
      include: { providerJobs: { orderBy: { updatedAt: 'desc' }, take: 1 } },
    });
    return row ? persistedRunToRecord(row, externalRunId) : undefined;
  }

  /** List durable project history, including archived generation results. */
  async listRunsByProject(projectId: string): Promise<RunRecord[]> {
    const rows = await this.prisma.run.findMany({
      where: { projectId: requireUuid(projectId, 'projectId') },
      include: { providerJobs: { orderBy: { updatedAt: 'desc' }, take: 1 } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.flatMap((row) => {
      const record = persistedRunToRecord(row);
      return record ? [record] : [];
    });
  }

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

    const create = { id, ...data };
    const update = {
      runId: data.runId,
      provider: data.provider,
      ...(data.platformJobId !== undefined ? { platformJobId: data.platformJobId } : {}),
      status: data.status,
      progress: data.progress,
      ...(data.payload !== undefined ? { payload: data.payload } : {}),
      updatedAt: data.updatedAt,
    };
    try {
      // A provider callback first enriches the local queued row. Looking up by
      // the local identity prevents a second INSERT with the same primary key.
      return await this.prisma.providerJob.upsert({ where: { id }, create, update });
    } catch (error) {
      if (!providerJob.platformJobId || !isPrismaUniqueConstraintError(error)) throw error;
      // A retry has a new local identity but may intentionally inherit an
      // existing external task. Reassociate that one durable platform row.
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
    const metadata = input.metadata;
    const providerJobId = normalizeUsageIdentity(input.providerJobId ?? metadata?.providerJobId);
    const eventId = normalizeUsageIdentity(input.eventId ?? metadata?.eventId);
    const kind = normalizeUsageKind(input.kind ?? metadata?.kind);
    const idempotencyKey = stableUsageLedgerIdempotencyKey({ providerJobId, eventId, kind });
    const data = {
      ...(runId ? { runId } : {}),
      ...(userId ? { userId } : {}),
      ...(providerJobId ? { providerJobId } : {}),
      ...(eventId ? { eventId } : {}),
      ...(kind ? { kind } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      amount,
      currency,
      ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
    };

    // Legacy callers that do not provide a provider/event identity retain the
    // append-only create behavior. Identified usage is immutable and uses a
    // unique key so provider retries cannot create a second charge.
    if (!idempotencyKey) {
      return this.prisma.usageLedger.create({ data });
    }

    return this.prisma.usageLedger.upsert({
      where: { idempotencyKey },
      create: {
        id: stableUsageLedgerId(idempotencyKey),
        ...data,
      },
      // A duplicate provider event must return the original immutable ledger
      // row, even if a retry carries different usage values.
      update: {},
    });
  }
}

function persistedRunToRecord(row: unknown, externalRunId?: string): RunRecord | undefined {
  if (!isRecord(row)) return undefined;
  const snapshot = runSnapshotSchema.safeParse(row.snapshot);
  if (!snapshot.success) return undefined;
  const status = persistedRunStatus(row.status);
  if (!status) return undefined;
  const result = row.result == null ? undefined : runResultSchema.safeParse(row.result);
  const providerJobRow = Array.isArray(row.providerJobs) ? row.providerJobs[0] : undefined;
  const providerJob = persistedProviderJob(providerJobRow);
  const createdAt = toIsoDate(row.createdAt);
  const updatedAt = toIsoDate(row.updatedAt);
  if (!createdAt || !updatedAt) return undefined;
  const error = persistedError(row.error);
  const progress = providerJob?.progress ?? (isTerminalRunStatus(status) ? 100 : 0);
  const candidate = {
    id: externalRunId ?? row.id,
    ...(typeof row.userId === 'string' ? { userId: row.userId } : {}),
    projectId: snapshot.data.projectId,
    targetNodeId: snapshot.data.targetNodeId,
    status,
    progress,
    attempt: row.attempt,
    provider:
      providerJob?.provider ?? (result?.success ? result.data.provider : undefined) ?? 'mock',
    modelAlias: snapshot.data.modelAlias,
    snapshot: snapshot.data,
    ...(result?.success ? { result: result.data } : {}),
    ...(providerJob ? { providerJob } : {}),
    ...(typeof row.idempotencyKey === 'string' && row.idempotencyKey
      ? { idempotencyKey: row.idempotencyKey }
      : {}),
    ...(error ? { error } : {}),
    ...(typeof row.retryOf === 'string' ? { retryOf: row.retryOf } : {}),
    createdAt,
    updatedAt,
  };
  const parsed = runRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function persistedProviderJob(value: unknown): ProviderJob | undefined {
  if (!isRecord(value)) return undefined;
  const createdAt = toIsoDate(value.createdAt);
  const updatedAt = toIsoDate(value.updatedAt);
  if (!createdAt || !updatedAt) return undefined;
  const parsed = providerJobSchema.safeParse({
    id: value.id,
    provider: value.provider,
    status: value.status,
    progress: value.progress,
    ...(typeof value.platformJobId === 'string' ? { platformJobId: value.platformJobId } : {}),
    ...(isRecord(value.payload) ? { payload: value.payload } : {}),
    createdAt,
    updatedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function persistedRunStatus(value: unknown): RunStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return [
    'draft',
    'queued',
    'preparing',
    'running',
    'processing',
    'succeeded',
    'failed',
    'cancel_requested',
    'cancelled',
  ].includes(normalized)
    ? (normalized as RunStatus)
    : undefined;
}

function persistedError(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  return typeof value.message === 'string' && value.message.trim() ? value.message : undefined;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function toIsoDate(value: unknown): string | undefined {
  const date =
    value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
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

type UsageIdentity = {
  providerJobId?: string;
  eventId?: string;
  kind?: string;
};

/**
 * Returns a stable, opaque unique key for a provider usage event.
 *
 * Provider job identity wins over event identity because a single provider
 * job may be delivered through more than one transport. Event identity is a
 * fallback for providers that do not expose a durable job id. The kind keeps
 * separately billable event types independent while still allowing an id
 * without a kind for legacy integrations.
 */
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

/** Stable UUID primary key used for identified usage rows. */
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

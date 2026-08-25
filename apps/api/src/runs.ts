import { createHash, randomUUID } from 'node:crypto';
import { Job, Queue, type ConnectionOptions } from 'bullmq';
import {
  canTransitionRunStatus,
  portRoleSchema,
  runJobDataSchema,
  runJobResultSchema,
  runSnapshotSchema,
  type CanvasDocument,
  type RunJobData,
  type ProviderJob,
  type RunRecord,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';
import type { PrismaRunPersistence } from './run-persistence';

export const RUN_QUEUE_NAME = 'multimodal-canvas-runs';
export type RunProviderName = 'mock' | 'newapi';
export type RunCreateOptions = {
  idempotencyKey?: string;
  userId?: string;
  estimatedCost?: { amount: string | number; currency: string };
};

export class RunServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_target' | 'invalid_state' | 'idempotency_conflict',
    message: string,
  ) {
    super(message);
  }
}

export interface RunService {
  create(snapshot: RunSnapshot, options?: RunCreateOptions): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | undefined>;
  listByProject(projectId: string): Promise<RunRecord[]>;
  retry(runId: string): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
  close(): Promise<void>;
}

export function createRunSnapshot(
  projectId: string,
  canvas: CanvasDocument,
  targetNodeId: string,
  options: {
    modelAlias?: string;
    parameters?: Record<string, unknown>;
    credentialId?: string;
    credentialVersion?: number;
  } = {},
): RunSnapshot {
  const target = canvas.nodes.find((node) => node.id === targetNodeId);
  if (!target) throw new RunServiceError('invalid_target', 'run target node not found');
  if (target.data.mode === 'source') {
    throw new RunServiceError('invalid_target', 'source nodes cannot be run directly');
  }

  const includedNodeIds = new Set([targetNodeId]);
  const pendingNodeIds = [targetNodeId];
  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.pop();
    if (!nodeId) continue;
    for (const edge of canvas.edges) {
      if (edge.targetNodeId !== nodeId || includedNodeIds.has(edge.sourceNodeId)) continue;
      includedNodeIds.add(edge.sourceNodeId);
      pendingNodeIds.push(edge.sourceNodeId);
    }
  }

  const nodes = canvas.nodes.filter((node) => includedNodeIds.has(node.id));
  const edges = canvas.edges.filter(
    (edge) => includedNodeIds.has(edge.sourceNodeId) && includedNodeIds.has(edge.targetNodeId),
  );
  const inputs = canvas.edges
    .filter((edge) => edge.targetNodeId === targetNodeId)
    .sort((left, right) => left.order - right.order)
    .map((edge) => {
      const source = canvas.nodes.find((node) => node.id === edge.sourceNodeId);
      if (!source) throw new RunServiceError('invalid_target', 'run input node not found');
      return {
        nodeId: source.id,
        role: portRoleSchema.parse(edge.targetHandle.slice('input:'.length)),
        sortOrder: edge.order,
        sourceAssetId: source.data.assetId,
        snapshot: source,
      };
    });

  return runSnapshotSchema.parse({
    projectId,
    canvasRevision: canvas.revision,
    targetNodeId,
    modelAlias: options.modelAlias ?? target.data.modelAlias ?? `mock-${target.data.mediaType}`,
    ...(options.credentialId ? { credentialId: options.credentialId } : {}),
    ...(options.credentialVersion ? { credentialVersion: options.credentialVersion } : {}),
    parameters: options.parameters ?? {},
    submittedAt: new Date().toISOString(),
    nodes,
    edges,
    inputs,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createProviderJob(runId: string, provider: RunProviderName, now: string): ProviderJob {
  return {
    id: `provider_job_${runId}`,
    provider,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function createQueuedRun(
  snapshot: RunSnapshot,
  attempt: number,
  retryOf?: string,
  provider: RunProviderName = 'mock',
  idempotencyKey?: string,
): RunRecord {
  const now = new Date().toISOString();
  const id = `run_${randomUUID()}`;
  return {
    id,
    projectId: snapshot.projectId,
    targetNodeId: snapshot.targetNodeId,
    status: 'queued',
    progress: 0,
    attempt,
    provider,
    modelAlias: snapshot.modelAlias,
    snapshot: clone(snapshot),
    providerJob: createProviderJob(id, provider, now),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(retryOf ? { retryOf } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryRunService implements RunService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stepDelayMs: number;
  private readonly providerName: RunProviderName;
  private readonly idempotency = new Map<string, { runId: string; fingerprint: string }>();

  constructor(options: { stepDelayMs?: number; providerName?: RunProviderName } = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 20;
    this.providerName = options.providerName ?? 'mock';
  }

  async create(snapshot: RunSnapshot, options: RunCreateOptions = {}): Promise<RunRecord> {
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.idempotency.get(idempotencyMapKey(snapshot.projectId, idempotencyKey));
      if (existing) {
        if (existing.fingerprint !== snapshotFingerprint(snapshot)) {
          throw new RunServiceError(
            'idempotency_conflict',
            'idempotency key was already used for a different run request',
          );
        }
        const existingRun = this.runs.get(existing.runId);
        if (existingRun) return clone(existingRun);
      }
    }
    const run = createQueuedRun(snapshot, 1, undefined, this.providerName, idempotencyKey);
    this.runs.set(run.id, run);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyMapKey(snapshot.projectId, idempotencyKey), {
        runId: run.id,
        fingerprint: snapshotFingerprint(snapshot),
      });
    }
    this.schedule(run.id);
    return clone(run);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async listByProject(projectId: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async retry(runId: string): Promise<RunRecord> {
    const previous = this.require(runId);
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new RunServiceError('invalid_state', 'only failed or cancelled runs can be retried');
    }
    const run = createQueuedRun(
      previous.snapshot,
      previous.attempt + 1,
      previous.id,
      previous.provider === 'newapi' ? 'newapi' : 'mock',
    );
    this.runs.set(run.id, run);
    this.schedule(run.id);
    return clone(run);
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = this.require(runId);
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      throw new RunServiceError('invalid_state', 'completed runs cannot be cancelled');
    }
    this.transition(run, 'cancel_requested', run.progress);
    this.schedule(run.id, true);
    return clone(run);
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private require(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new RunServiceError('not_found', 'run not found');
    return run;
  }

  private schedule(runId: string, immediate = false) {
    const existing = this.timers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        this.timers.delete(runId);
        void this.execute(runId);
      },
      immediate ? 0 : this.stepDelayMs,
    );
    this.timers.set(runId, timer);
  }

  private async execute(runId: string) {
    const run = this.runs.get(runId);
    if (
      !run ||
      run.status === 'succeeded' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      return;
    }
    if (isCancellationRequested(run)) {
      this.transition(run, 'cancelled', run.progress);
      return;
    }

    const stages: Array<[RunStatus, number]> = [
      ['preparing', 10],
      ['running', 45],
      ['processing', 80],
    ];
    for (const [status, progress] of stages) {
      if (isCancellationRequested(run)) {
        this.transition(run, 'cancelled', run.progress);
        return;
      }
      this.transition(run, status, progress);
      await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
    }
    if (isCancellationRequested(run)) {
      this.transition(run, 'cancelled', run.progress);
      return;
    }
    this.transition(run, 'succeeded', 100, {
      provider: run.provider,
      summary: `Mock Provider 已完成 ${run.snapshot.targetNodeId}`,
      targetNodeId: run.snapshot.targetNodeId,
      mediaType: run.snapshot.nodes.find((node) => node.id === run.snapshot.targetNodeId)!.data
        .mediaType,
      inputCount: run.snapshot.inputs.length,
    });
  }

  private transition(
    run: RunRecord,
    status: RunStatus,
    progress: number,
    result?: RunRecord['result'],
  ) {
    if (!canTransitionRunStatus(run.status, status)) {
      throw new RunServiceError(
        'invalid_state',
        `cannot transition run from ${run.status} to ${status}`,
      );
    }
    run.status = status;
    run.progress = progress;
    run.updatedAt = new Date().toISOString();
    if (run.providerJob) {
      run.providerJob = {
        ...run.providerJob,
        status:
          status === 'succeeded'
            ? 'succeeded'
            : status === 'failed'
              ? 'failed'
              : status === 'cancelled'
                ? 'cancelled'
                : status === 'queued'
                  ? 'queued'
                  : 'running',
        progress,
        updatedAt: run.updatedAt,
      };
    }
    if (result) run.result = result;
  }
}

type RunProgress = {
  status: RunStatus;
  progress: number;
  updatedAt: string;
};

export class BullMqRunService implements RunService {
  private readonly queue: Queue<RunJobData>;
  private readonly providerName: RunProviderName;
  private readonly persistence?: Pick<PrismaRunPersistence, 'ensureRun'>;

  constructor(options: {
    connection: ConnectionOptions;
    queueName?: string;
    providerName?: RunProviderName;
    persistence?: Pick<PrismaRunPersistence, 'ensureRun'>;
  }) {
    this.queue = new Queue<RunJobData>(options.queueName ?? RUN_QUEUE_NAME, {
      connection: options.connection,
    });
    this.providerName = options.providerName ?? 'mock';
    this.persistence = options.persistence;
  }

  async create(snapshot: RunSnapshot, options: RunCreateOptions = {}): Promise<RunRecord> {
    return this.enqueue(
      snapshot,
      1,
      undefined,
      this.providerName,
      normalizeIdempotencyKey(options.idempotencyKey),
      options.userId,
      options.estimatedCost,
    );
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const job = await this.queue.getJob(runId);
    if (!job) return undefined;
    return this.toRunRecord(job);
  }

  async listByProject(projectId: string): Promise<RunRecord[]> {
    const jobs = await this.queue.getJobs(
      ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'],
      0,
      -1,
    );
    const runs = await Promise.all(
      jobs
        .filter((job) => {
          const parsed = runJobDataSchema.safeParse(job.data);
          return parsed.success && parsed.data.snapshot.projectId === projectId;
        })
        .map((job) => this.toRunRecord(job)),
    );
    return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async retry(runId: string): Promise<RunRecord> {
    const previous = await this.get(runId);
    if (!previous) throw new RunServiceError('not_found', 'run not found');
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new RunServiceError('invalid_state', 'only failed or cancelled runs can be retried');
    }
    return this.enqueue(
      previous.snapshot,
      previous.attempt + 1,
      previous.id,
      previous.provider === 'newapi' ? 'newapi' : 'mock',
      undefined,
      undefined,
    );
  }

  async cancel(runId: string): Promise<RunRecord> {
    const job = await this.queue.getJob(runId);
    if (!job) throw new RunServiceError('not_found', 'run not found');
    const current = await this.toRunRecord(job);
    if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      throw new RunServiceError('invalid_state', 'completed runs cannot be cancelled');
    }
    const data = runJobDataSchema.parse(job.data);
    await job.updateData({ ...data, cancelRequested: true });
    await job.updateProgress({
      status: 'cancel_requested',
      progress: current.progress,
      updatedAt: new Date().toISOString(),
    } satisfies RunProgress);
    return this.toRunRecord(job);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async enqueue(
    snapshot: RunSnapshot,
    attempt: number,
    retryOf?: string,
    providerName: RunProviderName = this.providerName,
    idempotencyKey?: string,
    userId?: string,
    estimatedCost?: { amount: string | number; currency: string },
  ) {
    const runId = idempotencyKey
      ? createIdempotentRunId(snapshot.projectId, idempotencyKey)
      : `run_${randomUUID()}`;
    const existing = await this.queue.getJob(runId);
    if (existing) {
      const existingData = runJobDataSchema.parse(existing.data);
      if (snapshotFingerprint(existingData.snapshot) !== snapshotFingerprint(snapshot)) {
        throw new RunServiceError(
          'idempotency_conflict',
          'idempotency key was already used for a different run request',
        );
      }
      await this.persistence?.ensureRun({
        runId,
        snapshot: existingData.snapshot,
        status: 'queued',
        attempt: existingData.attempt,
        provider: existingData.provider,
        retryOf: existingData.retryOf,
        idempotencyKey: existingData.idempotencyKey,
        providerJob: existingData.providerJob,
      });
      return this.toRunRecord(existing);
    }
    const now = new Date().toISOString();
    const data = runJobDataSchema.parse({
      runId,
      snapshot: clone(snapshot),
      attempt,
      provider: providerName,
      ...(userId ? { userId } : {}),
      ...(estimatedCost ? { estimatedCost } : {}),
      retryOf,
      idempotencyKey,
      providerJob: createProviderJob(runId, providerName, now),
      cancelRequested: false,
    });
    // Persist the immutable snapshot before publishing the queue message. If
    // PostgreSQL is unavailable, fail the request instead of creating a job
    // whose run history cannot be recovered after a restart.
    await this.persistence?.ensureRun({
      runId,
      snapshot,
      status: 'queued',
      attempt,
      provider: providerName,
      ...(userId ? { userId } : {}),
      ...(estimatedCost
        ? { cost: estimatedCost.amount, costCurrency: estimatedCost.currency }
        : {}),
      retryOf,
      idempotencyKey,
      providerJob: data.providerJob,
    });
    const job = await this.queue.add('run', data, {
      jobId: runId,
      removeOnComplete: false,
      removeOnFail: false,
    });
    if (idempotencyKey) {
      const persisted = runJobDataSchema.parse(job.data);
      if (snapshotFingerprint(persisted.snapshot) !== snapshotFingerprint(snapshot)) {
        throw new RunServiceError(
          'idempotency_conflict',
          'idempotency key was already used for a different run request',
        );
      }
    }
    return this.toRunRecord(job);
  }

  private async toRunRecord(job: Job<RunJobData>): Promise<RunRecord> {
    const data = runJobDataSchema.parse(job.data);
    const state = await job.getState();
    const progressResult = parseProgress(job.progress);
    const completed =
      state === 'completed' ? runJobResultSchema.safeParse(job.returnvalue) : undefined;
    let status: RunStatus = progressResult?.status ?? 'queued';
    let progress = progressResult?.progress ?? 0;
    let result: RunRecord['result'];
    let error: string | undefined;

    if (state === 'active') status = progressResult?.status ?? 'running';
    if (state === 'completed') {
      if (!completed?.success) {
        // A completed BullMQ job without a valid worker envelope is not a
        // successful run. Reporting success here loses the actual result and
        // makes retries/diagnostics impossible.
        status = 'failed';
        progress = 100;
        error = 'worker returned an invalid run result';
      } else {
        status = completed.data.status;
        progress = completed.data.progress;
        result = completed.data.result;
      }
    }
    if (state === 'failed') {
      status = 'failed';
      error = job.failedReason || 'worker execution failed';
    }
    if (data.cancelRequested && !['succeeded', 'failed', 'cancelled'].includes(status)) {
      status = 'cancel_requested';
    }

    const updatedAt = progressResult?.updatedAt
      ? progressResult.updatedAt
      : new Date(job.finishedOn ?? job.processedOn ?? job.timestamp).toISOString();
    return {
      id: data.runId,
      projectId: data.snapshot.projectId,
      targetNodeId: data.snapshot.targetNodeId,
      status,
      progress,
      attempt: data.attempt,
      provider: data.provider,
      modelAlias: data.snapshot.modelAlias,
      snapshot: clone(data.snapshot),
      ...(result ? { result } : {}),
      ...(completed?.success && completed.data.providerJob
        ? { providerJob: completed.data.providerJob }
        : data.providerJob
          ? { providerJob: data.providerJob }
          : {}),
      ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
      ...(error ? { error } : {}),
      ...(data.retryOf ? { retryOf: data.retryOf } : {}),
      createdAt: new Date(job.timestamp).toISOString(),
      updatedAt,
    };
  }
}

function normalizeIdempotencyKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

function idempotencyMapKey(projectId: string, key: string): string {
  return `${projectId}\0${key}`;
}

function snapshotFingerprint(snapshot: RunSnapshot): string {
  const { submittedAt: _submittedAt, ...stableSnapshot } = snapshot;
  return JSON.stringify(stableSnapshot);
}

export function createIdempotentRunId(projectId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(idempotencyMapKey(projectId, idempotencyKey))
    .digest('hex');
  return `run_idem_${digest}`;
}

function parseProgress(progress: Job<RunJobData>['progress']): RunProgress | undefined {
  if (!progress || typeof progress !== 'object') return undefined;
  const candidate = progress as Partial<RunProgress>;
  if (
    typeof candidate.status !== 'string' ||
    typeof candidate.progress !== 'number' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    status: candidate.status as RunStatus,
    progress: candidate.progress,
    updatedAt: candidate.updatedAt,
  };
}

function isCancellationRequested(run: RunRecord): boolean {
  return run.status === 'cancel_requested';
}

export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.replace('/', '');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { db: Number(database) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export async function isBullMqJobCancelled(
  queue: Queue<RunJobData>,
  jobId: string,
): Promise<boolean> {
  const latest = await Job.fromId<RunJobData>(queue, jobId);
  return latest ? runJobDataSchema.parse(latest.data).cancelRequested : false;
}

import { randomUUID } from 'node:crypto';

import { Job, Queue, type ConnectionOptions } from 'bullmq';
import {
  canTransitionRunStatus,
  portRoleSchema,
  runJobDataSchema,
  runJobResultSchema,
  runSnapshotSchema,
  type CanvasDocument,
  type RunJobData,
  type RunRecord,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';

export const RUN_QUEUE_NAME = 'multimodal-canvas-runs';

export class RunServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_target' | 'invalid_state',
    message: string,
  ) {
    super(message);
  }
}

export interface RunService {
  create(snapshot: RunSnapshot): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | undefined>;
  retry(runId: string): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
  close(): Promise<void>;
}

export function createRunSnapshot(
  projectId: string,
  canvas: CanvasDocument,
  targetNodeId: string,
  options: { modelAlias?: string; parameters?: Record<string, unknown> } = {},
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
    modelAlias: options.modelAlias ?? `mock-${target.data.mediaType}`,
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

function createQueuedRun(snapshot: RunSnapshot, attempt: number, retryOf?: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id: `run_${randomUUID()}`,
    projectId: snapshot.projectId,
    targetNodeId: snapshot.targetNodeId,
    status: 'queued',
    progress: 0,
    attempt,
    provider: 'mock',
    modelAlias: snapshot.modelAlias,
    snapshot: clone(snapshot),
    ...(retryOf ? { retryOf } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryRunService implements RunService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stepDelayMs: number;

  constructor(options: { stepDelayMs?: number } = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 20;
  }

  async create(snapshot: RunSnapshot): Promise<RunRecord> {
    const run = createQueuedRun(snapshot, 1);
    this.runs.set(run.id, run);
    this.schedule(run.id);
    return clone(run);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async retry(runId: string): Promise<RunRecord> {
    const previous = this.require(runId);
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new RunServiceError('invalid_state', 'only failed or cancelled runs can be retried');
    }
    const run = createQueuedRun(previous.snapshot, previous.attempt + 1, previous.id);
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
      provider: 'mock',
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

  constructor(options: { connection: ConnectionOptions; queueName?: string }) {
    this.queue = new Queue<RunJobData>(options.queueName ?? RUN_QUEUE_NAME, {
      connection: options.connection,
    });
  }

  async create(snapshot: RunSnapshot): Promise<RunRecord> {
    return this.enqueue(snapshot, 1);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const job = await this.queue.getJob(runId);
    if (!job) return undefined;
    return this.toRunRecord(job);
  }

  async retry(runId: string): Promise<RunRecord> {
    const previous = await this.get(runId);
    if (!previous) throw new RunServiceError('not_found', 'run not found');
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new RunServiceError('invalid_state', 'only failed or cancelled runs can be retried');
    }
    return this.enqueue(previous.snapshot, previous.attempt + 1, previous.id);
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

  private async enqueue(snapshot: RunSnapshot, attempt: number, retryOf?: string) {
    const runId = `run_${randomUUID()}`;
    const data = runJobDataSchema.parse({
      runId,
      snapshot: clone(snapshot),
      attempt,
      retryOf,
      cancelRequested: false,
    });
    const job = await this.queue.add('run', data, {
      jobId: runId,
      removeOnComplete: false,
      removeOnFail: false,
    });
    return this.toRunRecord(job);
  }

  private async toRunRecord(job: Job<RunJobData>): Promise<RunRecord> {
    const data = runJobDataSchema.parse(job.data);
    const state = await job.getState();
    const progressResult = parseProgress(job.progress);
    let status: RunStatus = progressResult?.status ?? 'queued';
    let progress = progressResult?.progress ?? 0;
    let result: RunRecord['result'];
    let error: string | undefined;

    if (state === 'active') status = progressResult?.status ?? 'running';
    if (state === 'completed') {
      const completed = runJobResultSchema.safeParse(job.returnvalue);
      status = completed.success ? completed.data.status : 'succeeded';
      progress = completed.success ? completed.data.progress : 100;
      result = completed.success ? completed.data.result : undefined;
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
      provider: 'mock',
      modelAlias: data.snapshot.modelAlias,
      snapshot: clone(data.snapshot),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      ...(data.retryOf ? { retryOf: data.retryOf } : {}),
      createdAt: new Date(job.timestamp).toISOString(),
      updatedAt,
    };
  }
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

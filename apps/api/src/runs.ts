import { createHash, randomUUID } from 'node:crypto';
import { Job, Queue, type ConnectionOptions } from 'bullmq';
import {
  canTransitionRunStatus,
  portRoleSchema,
  runJobDataSchema,
  runJobResultSchema,
  providerJobSchema,
  runResultAssetSchema,
  runResultSchema,
  runSnapshotSchema,
  type CanvasDocument,
  type MediaType,
  type RunJobData,
  type RunResult,
  type RunResultAsset,
  type ProviderJob,
  type RunRecord,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';
import type { PrismaRunPersistence } from './run-persistence';

// A tiny 1-second fragmented H.264 MP4 keeps the default provider useful in
// local development without pretending that arbitrary text is a playable
// video. The bytes were generated once with ffmpeg and verified with ffprobe.
const MOCK_VIDEO_MP4_BASE64 =
  'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAv5tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACAXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFIbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABCHN0YmwAAAC8c3RzZAAAAAAAAAABAAAArGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEWTGF2YzYwLjMuMTAwIGxpYm8yNjRydAAAAAAAAAAAAAAY//8AAAAyYXZjQwFkAAv/4QAXZ2QAC6wZGpyEAAADAAQAAAMACjwiEagBAARo7jyA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAw1AAAMNQAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjAuMy4xMDAAAABobW9vZgAAABBtZmhkAAAAAAAAAAEAAABQdHJhZwAAABx0ZmhkAAIAOAAAAAEAAEAAAAAAOgEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAABh0cnVuAAAABQAAAAEAAABwAgAAAAAAAEJtZGF0AAAAF2dkAAusGRqchAAAAwAEAAADAAo8IhGoAAAABGjuPIAAAAATZbgABAAAB3/6eB7n500Yldj/8AAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADGgEBAQAAABBtZnJvAAAAAAAAAEM=';

const MOCK_VIDEO_MP4 = Buffer.from(MOCK_VIDEO_MP4_BASE64, 'base64');

export const RUN_QUEUE_NAME = 'multimodal-canvas-runs';
export type RunProviderName = 'mock' | 'newapi';
export type RunCreateOptions = {
  idempotencyKey?: string;
  userId?: string;
  estimatedCost?: { amount: string | number; currency: string };
};

/**
 * Provider-neutral output that can be archived by the API's local asset
 * adapter. Provider implementations may return a richer output envelope;
 * the memory service only consumes these fields after normalization.
 */
export type RunOutput = {
  content: Buffer;
  mimeType: string;
  format?: string;
};

/** Common output shape accepted from an injected Provider implementation. */
export type RunExecutionOutput = {
  mediaType?: 'text' | 'image' | 'audio' | 'video';
  kind?: string;
  text?: string;
  url?: string;
  base64?: string;
  content?: Buffer;
  mimeType?: string;
  format?: string;
};

export type RunExecution = {
  result: RunResult;
  output?: RunExecutionOutput;
  providerJob?: Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;
};

export type RunProviderJobUpdate = Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;

/**
 * Provider callback normalized by the API webhook boundary. The payload is
 * intentionally provider-neutral; raw webhook fields are retained only as
 * sanitized diagnostics on the local provider-job record.
 */
export type ProviderWebhookUpdate = {
  provider: string;
  platformJobId: string;
  status?: ProviderJob['status'];
  progress?: number;
  payload?: Record<string, unknown>;
  error?: string;
};

export type RunExecutorRequest = {
  snapshot: RunSnapshot;
  /** Existing asynchronous task identity; providers must resume it without POSTing again. */
  providerJob?: RunProviderJobUpdate;
  reportProgress?: (progress: number) => Promise<void> | void;
  /** Called as soon as an asynchronous provider creates or updates a platform task. */
  onProviderJob?: (providerJob: RunProviderJobUpdate) => Promise<void> | void;
};

/**
 * A function or Provider-like object can be injected for local New API runs.
 * Keeping this structural means the API does not need to know provider
 * specific request fields or credentials.
 */
export type RunExecutor =
  | ((request: RunExecutorRequest) => Promise<RunResult | RunExecution>)
  | { execute(request: RunExecutorRequest): Promise<RunResult | RunExecution> };

export type RunResultArchiver = (input: {
  run: Readonly<RunRecord>;
  result: RunResult;
  output?: RunOutput;
}) => Promise<RunResultAsset | undefined>;

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
  /** Apply an asynchronous provider callback when the service owns queue state. */
  applyProviderWebhook?(update: ProviderWebhookUpdate): Promise<RunRecord | undefined>;
  retry(runId: string): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
  close(): Promise<void>;
}

/**
 * Return the enabled upstream closure for a target, including the target
 * itself. Keeping this traversal in the API run module makes model freezing
 * and snapshot construction use the same inclusion rules.
 */
export function getRunSnapshotIncludedNodeIds(
  canvas: CanvasDocument,
  targetNodeId: string,
): ReadonlySet<string> {
  const nodesById = new Map(canvas.nodes.map((node) => [node.id, node]));
  const includedNodeIds = new Set([targetNodeId]);
  const pendingNodeIds = [targetNodeId];

  while (pendingNodeIds.length > 0) {
    const nodeId = pendingNodeIds.pop();
    if (!nodeId) continue;
    for (const edge of canvas.edges) {
      if (edge.targetNodeId !== nodeId || includedNodeIds.has(edge.sourceNodeId)) continue;
      const source = nodesById.get(edge.sourceNodeId);
      if (!source || source.data.enabled === false) continue;
      includedNodeIds.add(edge.sourceNodeId);
      pendingNodeIds.push(edge.sourceNodeId);
    }
  }

  return includedNodeIds;
}

export type FrozenRunAssetRef = {
  assetId: string;
  version: number;
  contentUrl: string;
};

export function createRunSnapshot(
  projectId: string,
  canvas: CanvasDocument,
  targetNodeId: string,
  options: {
    modelAlias?: string;
    parameters?: Record<string, unknown>;
    credentialId?: string;
    credentialVersion?: number;
    /** Final aliases resolved by the API for included non-source nodes. */
    nodeModelAliases?: Readonly<Record<string, string>>;
    /** Immutable asset-version references resolved by the API for included nodes. */
    frozenAssetRefs?: Readonly<Record<string, FrozenRunAssetRef>>;
  } = {},
): RunSnapshot {
  const target = canvas.nodes.find((node) => node.id === targetNodeId);
  if (!target) throw new RunServiceError('invalid_target', 'run target node not found');
  if (target.data.mode === 'source') {
    throw new RunServiceError('invalid_target', 'source nodes cannot be run directly');
  }
  if (target.data.enabled === false) {
    throw new RunServiceError('invalid_target', 'disabled nodes cannot be run');
  }

  const targetModelAlias =
    options.nodeModelAliases?.[targetNodeId] ??
    options.modelAlias ??
    target.data.modelAlias ??
    `mock-${target.data.mediaType}`;
  const includedNodeIds = getRunSnapshotIncludedNodeIds(canvas, targetNodeId);
  const nodes = canvas.nodes
    .filter((node) => includedNodeIds.has(node.id))
    .map((node) => {
      const snapshotNode = clone(node);
      const modelAlias = options.nodeModelAliases?.[node.id];
      if (modelAlias !== undefined) {
        snapshotNode.data = { ...snapshotNode.data, modelAlias };
      }
      const frozenAssetRef = options.frozenAssetRefs?.[node.id];
      if (frozenAssetRef !== undefined) {
        snapshotNode.data = {
          ...snapshotNode.data,
          assetId: frozenAssetRef.assetId,
          contentUrl: frozenAssetRef.contentUrl,
        };
      }
      return snapshotNode;
    });
  const snapshotNodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = canvas.edges.filter(
    (edge) => includedNodeIds.has(edge.sourceNodeId) && includedNodeIds.has(edge.targetNodeId),
  );
  const inputs = canvas.edges
    .filter((edge) => {
      if (edge.targetNodeId !== targetNodeId) return false;
      return canvas.nodes.find((node) => node.id === edge.sourceNodeId)?.data.enabled !== false;
    })
    .sort((left, right) => left.order - right.order)
    .map((edge) => {
      const source = canvas.nodes.find((node) => node.id === edge.sourceNodeId);
      if (!source) throw new RunServiceError('invalid_target', 'run input node not found');
      const snapshotSource = snapshotNodesById.get(source.id) ?? source;
      return {
        nodeId: source.id,
        role: portRoleSchema.parse(edge.targetHandle.slice('input:'.length)),
        sortOrder: edge.order,
        sourceAssetId: snapshotSource.data.assetId,
        snapshot: clone(snapshotSource),
      };
    });

  return runSnapshotSchema.parse({
    projectId,
    canvasRevision: canvas.revision,
    targetNodeId,
    modelAlias: targetModelAlias,
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

function mergeProviderJob(current: ProviderJob, update: RunProviderJobUpdate): ProviderJob {
  const updatedAt = new Date().toISOString();
  return providerJobSchema.parse({
    ...current,
    ...update,
    // The local provider-job row is immutable in identity; only the platform
    // task fields may be supplied by an executor.
    id: current.id,
    provider: current.provider,
    createdAt: current.createdAt,
    status: update.status ?? current.status,
    progress: Math.max(0, Math.min(100, Math.max(current.progress, update.progress ?? 0))),
    updatedAt,
  });
}

function attachProviderErrorToRun(run: RunRecord, error: unknown) {
  if (!run.providerJob || !isRecord(error)) return;
  const platformJobId = typeof error.platformJobId === 'string' ? error.platformJobId.trim() : '';
  const providerPayload = sanitizeProviderPayload(error.providerPayload);
  if (!platformJobId && !providerPayload) return;
  run.providerJob = {
    ...run.providerJob,
    ...(platformJobId ? { platformJobId } : {}),
    ...(providerPayload
      ? { payload: { ...(run.providerJob.payload ?? {}), statusResponse: providerPayload } }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** Keep provider diagnostics useful without exposing credentials or signed URLs. */
function sanitizeProviderPayload(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 2) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (/(url|uri|base64|secret|authorization|api[-_]?key|password|credential|token)/i.test(key)) {
      continue;
    }
    if (typeof raw === 'string') {
      const normalized = raw.trim();
      if (normalized) output[key] = normalized.slice(0, 500);
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      if (typeof raw !== 'number' || Number.isFinite(raw)) output[key] = raw;
    } else if (isRecord(raw)) {
      const nested = sanitizeProviderPayload(raw, depth + 1);
      if (nested) output[key] = nested;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeRunErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'run execution failed';
  return raw
    .replace(
      /(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/https?:\/\/[^\s)]+/gi, '[provider-url-redacted]')
    .slice(0, 2000);
}

function createProviderJob(
  runId: string,
  provider: RunProviderName,
  now: string,
  previous?: ProviderJob,
): ProviderJob {
  const fresh: ProviderJob = {
    id: `provider_job_${runId}`,
    provider,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  // A platform task is externally billable and must survive a retry. Keep
  // only its provider identity/payload while assigning a new local row ID.
  // A confirmed terminal provider failure/cancellation must instead start a
  // new task; a timeout or transport error keeps the identity resumable.
  if (provider !== 'newapi' || !canResumeProviderJob(previous)) return fresh;
  return {
    ...previous,
    id: fresh.id,
    provider,
    status: 'submitted',
    progress: Math.max(0, Math.min(100, previous.progress)),
    createdAt: previous.createdAt,
    updatedAt: now,
  };
}

function canResumeProviderJob(previous: ProviderJob | undefined): previous is ProviderJob {
  if (!previous?.platformJobId) return false;
  if (previous.status !== 'failed' && previous.status !== 'cancelled') return true;
  const payload = previous.payload;
  const statusResponse = isRecord(payload?.statusResponse) ? payload.statusResponse : undefined;
  const providerStatus =
    typeof statusResponse?.providerStatus === 'string'
      ? statusResponse.providerStatus.toLowerCase()
      : typeof payload?.providerStatus === 'string'
        ? payload.providerStatus.toLowerCase()
        : undefined;
  return (
    !providerStatus ||
    !['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(providerStatus)
  );
}

function providerWebhookStatus(update: ProviderWebhookUpdate): ProviderJob['status'] | undefined {
  return update.status;
}

/**
 * Apply a provider callback to a run record while preserving the local run
 * state machine. Webhooks may arrive before the worker has advanced its local
 * lifecycle, so terminal provider states first walk through `processing`.
 */
function applyProviderWebhookToRecord(
  run: RunRecord,
  update: ProviderWebhookUpdate,
): RunRecord | undefined {
  if (
    !run.providerJob ||
    run.providerJob.provider !== update.provider ||
    run.providerJob.platformJobId !== update.platformJobId
  ) {
    return undefined;
  }

  const requestedStatus = providerWebhookStatus(update);
  const currentStatus = run.providerJob.status;
  const terminalProviderStatus = ['succeeded', 'failed', 'cancelled'].includes(currentStatus);
  const status = terminalProviderStatus ? currentStatus : requestedStatus;
  const progress =
    status === 'succeeded' || status === 'failed' || status === 'cancelled' ? 100 : update.progress;
  const payload = sanitizeProviderPayload(update.payload);
  run.providerJob = mergeProviderJob(run.providerJob, {
    provider: update.provider,
    platformJobId: update.platformJobId,
    ...(status ? { status } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(payload ? { payload } : {}),
  });

  if (status) applyProviderRunStatus(run, status);
  if (progress !== undefined) run.progress = Math.max(run.progress, progress);
  if (update.error) run.error = sanitizeRunErrorMessage(new Error(update.error));
  run.updatedAt = new Date().toISOString();
  return run;
}

function applyProviderRunStatus(run: RunRecord, status: ProviderJob['status']) {
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return;

  if (status === 'cancelled') {
    if (run.status !== 'cancel_requested') {
      if (canTransitionRunStatus(run.status, 'cancel_requested')) {
        run.status = 'cancel_requested';
      }
    }
    if (run.status === 'cancel_requested' && canTransitionRunStatus(run.status, 'cancelled')) {
      run.status = 'cancelled';
      run.progress = 100;
    }
    return;
  }

  if (status === 'succeeded' || status === 'failed') {
    advanceRunToProcessing(run);
    if (canTransitionRunStatus(run.status, status)) {
      run.status = status;
      run.progress = 100;
    }
    return;
  }

  if (status === 'running') {
    if (run.status === 'queued' && canTransitionRunStatus(run.status, 'preparing')) {
      run.status = 'preparing';
      run.progress = Math.max(run.progress, 10);
    }
    if (run.status === 'preparing' && canTransitionRunStatus(run.status, 'running')) {
      run.status = 'running';
      run.progress = Math.max(run.progress, 45);
    }
  } else if (status === 'submitted' && run.status === 'queued') {
    // A submitted external task means preparation has started, but the worker
    // may still be waiting to poll it. Keep the local status monotonic.
    if (canTransitionRunStatus(run.status, 'preparing')) {
      run.status = 'preparing';
      run.progress = Math.max(run.progress, 10);
    }
  }
}

function advanceRunToProcessing(run: RunRecord) {
  if (run.status === 'queued' && canTransitionRunStatus(run.status, 'preparing')) {
    run.status = 'preparing';
    run.progress = Math.max(run.progress, 10);
  }
  if (run.status === 'preparing' && canTransitionRunStatus(run.status, 'running')) {
    run.status = 'running';
    run.progress = Math.max(run.progress, 45);
  }
  if (run.status === 'running' && canTransitionRunStatus(run.status, 'processing')) {
    run.status = 'processing';
    run.progress = Math.max(run.progress, 80);
  }
}

function createQueuedRun(
  snapshot: RunSnapshot,
  attempt: number,
  retryOf?: string,
  provider: RunProviderName = 'mock',
  idempotencyKey?: string,
  userId?: string,
  previousProviderJob?: ProviderJob,
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
    ...(userId ? { userId } : {}),
    provider,
    modelAlias: snapshot.modelAlias,
    snapshot: clone(snapshot),
    providerJob: createProviderJob(id, provider, now, previousProviderJob),
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
  private executor: RunExecutor;
  private resultArchiver?: RunResultArchiver;

  constructor(
    options: {
      stepDelayMs?: number;
      providerName?: RunProviderName;
      executor?: RunExecutor;
      resultArchiver?: RunResultArchiver;
    } = {},
  ) {
    this.stepDelayMs = options.stepDelayMs ?? 20;
    this.providerName = options.providerName ?? 'mock';
    this.executor =
      options.executor ??
      (this.providerName === 'mock'
        ? mockRunExecutor
        : () => {
            throw new Error('New API executor is not configured for the memory run service');
          });
    this.resultArchiver = options.resultArchiver;
  }

  /** Allows the API composition root to inject a provider after construction. */
  setExecutor(executor: RunExecutor) {
    this.executor = executor;
  }

  /** Allows the composition root to attach storage after constructing a service. */
  setResultArchiver(resultArchiver: RunResultArchiver | undefined) {
    this.resultArchiver = resultArchiver;
  }

  hasResultArchiver(): boolean {
    return this.resultArchiver !== undefined;
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
    const run = createQueuedRun(
      snapshot,
      1,
      undefined,
      this.providerName,
      idempotencyKey,
      options.userId,
      undefined,
    );
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

  async applyProviderWebhook(update: ProviderWebhookUpdate): Promise<RunRecord | undefined> {
    const run = [...this.runs.values()]
      .filter(
        (candidate) =>
          candidate.providerJob?.provider === update.provider &&
          candidate.providerJob.platformJobId === update.platformJobId,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!run) return undefined;
    applyProviderWebhookToRecord(run, update);
    return clone(run);
  }

  async retry(runId: string): Promise<RunRecord> {
    const previous = this.require(runId);
    if (previous.status !== 'failed' && previous.status !== 'cancelled') {
      throw new RunServiceError('invalid_state', 'only failed or cancelled runs can be retried');
    }
    const idempotencyKey = retryIdempotencyKey(previous.id, previous.attempt + 1);
    const mapKey = idempotencyMapKey(previous.projectId, idempotencyKey);
    const existing = this.idempotency.get(mapKey);
    if (existing) {
      const existingRun = this.runs.get(existing.runId);
      if (existingRun) return clone(existingRun);
    }
    const run = createQueuedRun(
      previous.snapshot,
      previous.attempt + 1,
      previous.id,
      previous.provider === 'newapi' ? 'newapi' : 'mock',
      idempotencyKey,
      previous.userId,
      previous.providerJob,
    );
    this.runs.set(run.id, run);
    this.idempotency.set(mapKey, {
      runId: run.id,
      fingerprint: snapshotFingerprint(previous.snapshot),
    });
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

    try {
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

      const execution = normalizeRunExecution(
        await executeRunExecutor(this.executor, {
          snapshot: clone(run.snapshot),
          providerJob: run.providerJob ? clone(run.providerJob) : undefined,
          reportProgress: (progress) => this.reportProgress(run, progress),
          onProviderJob: (update) => {
            if (!run.providerJob) return;
            run.providerJob = mergeProviderJob(run.providerJob, update);
            run.updatedAt = new Date().toISOString();
          },
        }),
      );
      if (isCancellationRequested(run)) {
        this.transition(run, 'cancelled', run.progress);
        return;
      }
      if (execution.providerJob && run.providerJob) {
        run.providerJob = mergeProviderJob(run.providerJob, execution.providerJob);
      }

      let result = runResultSchema.parse(execution.result);
      const output = normalizeRunOutput(execution.output, result.mediaType);
      const archivedAsset = await this.resultArchiver?.({
        run: clone(run),
        result,
        ...(output ? { output } : {}),
      });
      if (archivedAsset) {
        result = runResultSchema.parse({
          ...result,
          asset: runResultAssetSchema.parse(archivedAsset),
        });
      } else if (!result.asset && output) {
        // Keep direct MemoryRunService consumers useful even when no storage
        // adapter is supplied (the app composition root provides one).
        result = runResultSchema.parse({ ...result, asset: inlineResultAsset(output) });
      } else if (!result.asset) {
        const remoteUrl = safeOutputUrl(execution.output);
        if (remoteUrl) {
          const mediaType = execution.output?.mediaType ?? result.mediaType;
          const mimeType =
            typeof execution.output?.mimeType === 'string'
              ? execution.output.mimeType
              : defaultMimeType(mediaType, execution.output?.format);
          result = runResultSchema.parse({
            ...result,
            asset: remoteResultAsset(remoteUrl, mimeType),
          });
        }
      }
      // Expose the terminal provider job alongside the run-level field so
      // consumers that only persist/read the result envelope retain it.
      if (run.providerJob && !result.providerJob) {
        result = runResultSchema.parse({ ...result, providerJob: run.providerJob });
      }
      this.transition(run, 'succeeded', 100, result);
    } catch (error) {
      if (isCancellationRequested(run)) {
        this.transition(run, 'cancelled', run.progress);
        return;
      }
      this.fail(run, error);
    }
  }

  private reportProgress(run: RunRecord, progress: number) {
    if (!Number.isFinite(progress)) return;
    this.updateProgress(run, Math.max(0, Math.min(100, Math.round(progress))));
  }

  private updateProgress(run: RunRecord, progress: number) {
    run.progress = progress;
    run.updatedAt = new Date().toISOString();
    if (run.providerJob) {
      run.providerJob = { ...run.providerJob, progress, updatedAt: run.updatedAt };
    }
  }

  private fail(run: RunRecord, error: unknown) {
    const message = sanitizeRunErrorMessage(error);
    attachProviderErrorToRun(run, error);
    if (canTransitionRunStatus(run.status, 'failed')) {
      this.transition(run, 'failed', run.progress);
    }
    run.error = message.slice(0, 2000);
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

/**
 * Small deterministic executor used by the in-memory API. It intentionally
 * does not call a model service; the generated bytes make local runs useful
 * for previewing the complete run -> asset -> content URL flow.
 */
async function mockRunExecutor({
  snapshot,
  reportProgress,
}: RunExecutorRequest): Promise<RunExecution> {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  if (!target) throw new Error('run target node is missing from snapshot');
  await reportProgress?.(92);

  const mediaType = target.data.mediaType;
  const label = target.data.label.trim() || 'Untitled output';
  let output: RunExecutionOutput;
  if (mediaType === 'text') {
    const prompt = target.data.prompt?.trim();
    const text = prompt ? `Mock output for ${label}\n${prompt}` : `Mock output for ${label}`;
    output = { mediaType, kind: 'text', text, mimeType: 'text/plain', format: 'txt' };
  } else if (mediaType === 'image') {
    const escaped = escapeXml(label);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#172033"/><text x="32" y="190" fill="#f8fafc" font-family="sans-serif" font-size="32">${escaped}</text></svg>`;
    output = {
      mediaType,
      kind: 'base64',
      base64: Buffer.from(svg, 'utf8').toString('base64'),
      mimeType: 'image/svg+xml',
      format: 'svg',
    };
  } else if (mediaType === 'audio') {
    output = {
      mediaType,
      kind: 'base64',
      base64: createMockWav().toString('base64'),
      mimeType: 'audio/wav',
      format: 'wav',
    };
  } else {
    // Keep local video runs playable. A real video provider replaces this
    // fixture when NewApiVideoProvider is configured.
    output = {
      mediaType,
      kind: 'base64',
      base64: MOCK_VIDEO_MP4.toString('base64'),
      mimeType: 'video/mp4',
      format: 'mp4',
    };
  }

  await reportProgress?.(100);
  return {
    result: {
      provider: 'mock',
      summary: `Mock Provider 已完成 ${target.id}`,
      targetNodeId: target.id,
      mediaType,
      inputCount: snapshot.inputs.length,
    },
    output,
  };
}

function executeRunExecutor(executor: RunExecutor, request: RunExecutorRequest) {
  if (typeof executor === 'function') return executor(request);
  if (executor && typeof executor.execute === 'function') return executor.execute(request);
  throw new Error('run executor is not configured');
}

function normalizeRunExecution(value: RunResult | RunExecution): RunExecution {
  const candidate = value as unknown;
  if (isRecord(candidate) && 'result' in candidate) {
    const parsedResult = runResultSchema.safeParse(candidate.result);
    if (!parsedResult.success) {
      throw new Error(`executor returned an invalid result: ${parsedResult.error.message}`);
    }
    const output = normalizeExecutionOutputEnvelope(candidate.output);
    const providerJob =
      normalizeProviderJob(candidate.providerJob) ?? parsedResult.data.providerJob;
    return {
      result: parsedResult.data,
      ...(output ? { output } : {}),
      ...(providerJob ? { providerJob } : {}),
    };
  }

  const parsedResult = runResultSchema.safeParse(candidate);
  if (!parsedResult.success) {
    throw new Error(`executor returned an invalid result: ${parsedResult.error.message}`);
  }
  return {
    result: parsedResult.data,
    ...(parsedResult.data.providerJob ? { providerJob: parsedResult.data.providerJob } : {}),
  };
}

function normalizeExecutionOutputEnvelope(value: unknown): RunExecutionOutput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { text: value, kind: 'text', mediaType: 'text' };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { content: Buffer.from(value as Uint8Array) };
  }
  if (!isRecord(value)) return undefined;
  return value as RunExecutionOutput;
}

function normalizeProviderJob(value: unknown): RunExecution['providerJob'] | undefined {
  if (!isRecord(value) || typeof value.provider !== 'string' || !value.provider.trim()) {
    return undefined;
  }
  const candidate = {
    provider: value.provider,
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.platformJobId === 'string' ? { platformJobId: value.platformJobId } : {}),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.progress === 'number' ? { progress: value.progress } : {}),
    ...(isRecord(value.payload) ? { payload: value.payload } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
  const complete = providerJobSchema.safeParse(candidate);
  return complete.success
    ? complete.data
    : ({
        provider: value.provider,
        ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(typeof value.platformJobId === 'string' ? { platformJobId: value.platformJobId } : {}),
        ...(typeof value.status === 'string'
          ? { status: value.status as ProviderJob['status'] }
          : {}),
        ...(typeof value.progress === 'number' ? { progress: value.progress } : {}),
      } satisfies RunExecution['providerJob']);
}

function normalizeRunOutput(
  value: RunExecutionOutput | undefined,
  expectedMediaType: MediaType,
): RunOutput | undefined {
  if (value === undefined || value === null) return undefined;
  const record = typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const declaredMediaType = record?.mediaType;
  const mediaType = isMediaType(declaredMediaType) ? declaredMediaType : expectedMediaType;
  if (declaredMediaType !== undefined && !isMediaType(declaredMediaType)) {
    throw new Error('executor returned an invalid output media type');
  }
  if (mediaType !== expectedMediaType) {
    throw new Error(
      `executor output media type ${mediaType} does not match target ${expectedMediaType}`,
    );
  }

  const rawMimeType = typeof record?.mimeType === 'string' ? record.mimeType.trim() : '';
  const mimeType = rawMimeType || defaultMimeType(mediaType, record?.format);
  if (!mimeMatchesMediaType(mimeType, mediaType)) {
    throw new Error(`executor output MIME type ${mimeType} does not match target ${mediaType}`);
  }
  const format = typeof record?.format === 'string' ? record.format : undefined;
  const content = record?.content;
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    const bytes = Buffer.from(content as Uint8Array);
    if (bytes.byteLength === 0) throw new Error('executor returned empty output');
    return { content: bytes, mimeType, ...(format ? { format } : {}) };
  }

  const text = typeof record?.text === 'string' ? record.text : undefined;
  if (text !== undefined || record?.kind === 'text') {
    if (mediaType !== 'text') throw new Error('text output is only valid for text nodes');
    const textValue = text ?? '';
    if (!textValue.trim()) throw new Error('executor returned empty text output');
    return {
      content: Buffer.from(textValue, 'utf8'),
      mimeType,
      ...(format ? { format } : {}),
    };
  }

  const base64 = typeof record?.base64 === 'string' ? record.base64 : undefined;
  if (base64 !== undefined || record?.kind === 'base64') {
    if (base64 === undefined) throw new Error('executor base64 output is missing data');
    const bytes = decodeBase64(base64);
    if (bytes.byteLength === 0) throw new Error('executor returned empty output');
    return { content: bytes, mimeType, ...(format ? { format } : {}) };
  }

  const url = typeof record?.url === 'string' ? record.url.trim() : undefined;
  if (url) {
    const data = parseDataUrl(url);
    if (data) {
      if (!mimeMatchesMediaType(data.mimeType, mediaType)) {
        throw new Error(
          `executor data URL MIME type ${data.mimeType} does not match target ${mediaType}`,
        );
      }
      return {
        content: data.content,
        mimeType: data.mimeType || mimeType,
        ...(format ? { format } : {}),
      };
    }
    // Remote URLs are intentionally not fetched by the API process. The
    // worker/provider archiver owns that operation and can apply its policy.
    if (!isHttpUrl(url)) throw new Error('executor output URL must use http(s) or data scheme');
  }
  return undefined;
}

function inlineResultAsset(output: RunOutput): RunResultAsset {
  const sha256 = createHash('sha256').update(output.content).digest('hex');
  return {
    assetId: `inline_${sha256.slice(0, 24)}`,
    version: 1,
    contentUrl: `data:${output.mimeType};base64,${output.content.toString('base64')}`,
    mimeType: output.mimeType,
    sizeBytes: output.content.byteLength,
    sha256,
  };
}

function remoteResultAsset(url: string, mimeType: string): RunResultAsset {
  return {
    assetId: `remote_${createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
    contentUrl: url,
    mimeType,
  };
}

function safeOutputUrl(output: RunExecutionOutput | undefined): string | undefined {
  const url = typeof output?.url === 'string' ? output.url.trim() : '';
  if (!url || parseDataUrl(url) || !isHttpUrl(url)) return undefined;
  return url;
}

function parseDataUrl(value: string): { mimeType: string; content: Buffer } | undefined {
  const match = /^data:([^;,\s]+)?((?:;[^,]*)?),([\s\S]*)$/i.exec(value);
  if (!match) return undefined;
  const mimeType = match[1]?.trim() || 'application/octet-stream';
  const metadata = match[2] ?? '';
  const payload = match[3] ?? '';
  if (/;base64(?:;|$)/i.test(metadata)) return { mimeType, content: decodeBase64(payload) };
  try {
    return { mimeType, content: Buffer.from(decodeURIComponent(payload), 'utf8') };
  } catch {
    throw new Error('executor returned an invalid data URL');
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('executor returned invalid base64 output');
  }
  return Buffer.from(normalized, 'base64');
}

function defaultMimeType(mediaType: MediaType, format?: unknown): string {
  if (typeof format === 'string') {
    const normalized = format.toLowerCase().replace(/^\./, '');
    if (mediaType === 'image' && normalized === 'svg') return 'image/svg+xml';
    if (mediaType === 'audio' && normalized === 'wav') return 'audio/wav';
    if (mediaType === 'video' && normalized === 'webm') return 'video/webm';
  }
  return mediaType === 'text'
    ? 'text/plain'
    : mediaType === 'image'
      ? 'image/png'
      : mediaType === 'audio'
        ? 'audio/wav'
        : 'video/mp4';
}

function mimeMatchesMediaType(mimeType: string, mediaType: MediaType): boolean {
  const normalized = mimeType.toLowerCase().split(';', 1)[0]?.trim();
  if (normalized === 'application/octet-stream') return true;
  return normalized?.startsWith(`${mediaType}/`) ?? false;
}

function createMockWav(): Buffer {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 8;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMediaType(value: unknown): value is MediaType {
  return value === 'text' || value === 'image' || value === 'audio' || value === 'video';
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
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

  async applyProviderWebhook(update: ProviderWebhookUpdate): Promise<RunRecord | undefined> {
    const jobs = await this.queue.getJobs(
      ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'],
      0,
      -1,
    );
    for (const job of jobs) {
      const data = runJobDataSchema.safeParse(job.data);
      if (!data.success) continue;
      const providerJob = data.data.providerJob;
      if (
        !providerJob ||
        providerJob.provider !== update.provider ||
        providerJob.platformJobId !== update.platformJobId
      ) {
        continue;
      }

      const current = await this.toRunRecord(job);
      const updated = applyProviderWebhookToRecord(current, update);
      if (!updated || !updated.providerJob) return undefined;

      await job.updateData({ ...data.data, providerJob: updated.providerJob });
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') {
        await job.updateProgress({
          status: updated.status,
          progress: updated.progress,
          updatedAt: updated.updatedAt,
        } satisfies RunProgress);
      }
      return updated;
    }
    return undefined;
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
      retryIdempotencyKey(previous.id, previous.attempt + 1),
      previous.userId,
      undefined,
      previous.providerJob,
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
    previousProviderJob?: ProviderJob,
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
      // The original submission already persisted the immutable snapshot.
      // Do not call ensureRun here: doing so would reset a running/completed
      // database record back to `queued` for a harmless repeated request.
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
      providerJob: createProviderJob(runId, providerName, now, previousProviderJob),
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
    let job: Job<RunJobData>;
    try {
      job = await this.queue.add('run', data, {
        jobId: runId,
        removeOnComplete: false,
        removeOnFail: false,
      });
    } catch (error) {
      // Two requests with the same idempotency key can pass the initial read
      // concurrently. BullMQ rejects the second add; recover the already
      // created job and return it as the idempotent result instead of surfacing
      // a spurious 500. Preserve the original error when no job was created.
      if (!idempotencyKey) throw error;
      let concurrent: Job<RunJobData> | undefined;
      try {
        concurrent = await this.queue.getJob(runId);
      } catch {
        throw error;
      }
      if (!concurrent) throw error;
      const concurrentData = runJobDataSchema.parse(concurrent.data);
      if (snapshotFingerprint(concurrentData.snapshot) !== snapshotFingerprint(snapshot)) {
        throw new RunServiceError(
          'idempotency_conflict',
          'idempotency key was already used for a different run request',
        );
      }
      return this.toRunRecord(concurrent);
    }
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
      ...(data.userId ? { userId: data.userId } : {}),
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

function retryIdempotencyKey(runId: string, attempt: number): string {
  const digest = createHash('sha256').update(runId).digest('hex');
  return `retry:${digest}:${attempt}`;
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

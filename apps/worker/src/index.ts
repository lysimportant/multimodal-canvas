import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  runJobDataSchema,
  runResultSchema,
  type ProviderJob,
  type RunResult,
  type RunResultAsset,
  type RunSnapshot,
  type RunJobData,
  type RunJobResult,
  type RunStatus,
} from '@multimodal-canvas/domain';
import {
  MockProvider,
  NewApiProvider,
  NewApiVideoProvider,
  type NewApiProviderRequest,
} from '@multimodal-canvas/providers';
import {
  createNoopWorkerLogger,
  createWorkerLogger,
  serializeWorkerError,
  type WorkerLogger,
} from './logger';
import {
  createEnvironmentObservability,
  type Observability,
  type ObservabilitySpan,
} from '@multimodal-canvas/observability';
import { createWorkerPersistenceFromEnvironment, databaseRunId } from './prisma-persistence';
import { createResultAssetArchiverFromEnvironment } from './result-archiver';
import {
  normalizeProviderOutput,
  providerOutputToArchiveInput,
  type ProviderOutput,
  type ResultAssetArchiveInput,
} from './result-output';

const workerName = 'multimodal-canvas-worker';
const queueName = 'multimodal-canvas-runs';

type WorkerProgress = {
  status: RunStatus;
  progress: number;
  updatedAt: string;
};

export type ProviderExecution = {
  result: RunResult;
  /** Normalized text/image/audio payload returned by a provider. */
  output?: ProviderOutput;
  providerJob?: Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;
  usage?: ProviderUsage;
};

export type ProviderUsage = {
  /** Monetary amount when the provider reports an explicit priced usage. */
  amount?: number | string;
  currency?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export type WorkerCredentialReference = {
  credentialId?: string;
  credentialVersion?: number;
};

export type WorkerProviderCredentials = {
  baseUrl: string;
  apiKey: string;
};

/**
 * Persistence is injected by the process that owns Prisma. The worker keeps
 * this structural boundary so the default BullMQ/Mock setup has no database
 * dependency and can still run in tests or local development.
 */
export type RunPersistence = {
  /** Resolve the exact encrypted credential captured in a run snapshot. */
  getProviderCredentials?(
    reference: WorkerCredentialReference,
  ): Promise<WorkerProviderCredentials | undefined>;
  ensureRun?(input: {
    runId: string;
    snapshot: RunSnapshot;
    status?: RunStatus;
    attempt?: number;
    provider?: string;
    providerJob?: ProviderJob;
    retryOf?: string;
    idempotencyKey?: string;
    error?: string;
  }): Promise<unknown>;
  updateRun?(input: {
    runId: string;
    status: RunStatus;
    providerJob?: ProviderJob;
    result?: RunResult;
    error?: string;
  }): Promise<unknown>;
  upsertProviderJob(input: { runId: string; providerJob: ProviderJob }): Promise<unknown>;
  /** Resolve the last durable provider job for a failed/cancelled retry source. */
  findProviderJobByRunId?(runId: string): Promise<ProviderJob | undefined>;
  recordUsage(input: {
    runId?: string;
    userId?: string;
    providerJobId?: string;
    eventId?: string;
    kind?: string;
    amount: number | string;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  close?(): Promise<void>;
};

type ProviderExecutor = {
  execute(request: NewApiProviderRequest): Promise<RunResult | ProviderExecution>;
};

export type DatabaseRunIdResolver = (
  runId: string,
  snapshot: RunSnapshot,
) => string | undefined | Promise<string | undefined>;

export type ResultAssetArchiver = (input: {
  runId: string;
  userId?: string;
  snapshot: RunSnapshot;
  result: RunResult;
  providerJob: ProviderJob;
  output?: ProviderOutput;
  archiveInput?: ResultAssetArchiveInput;
}) => Promise<RunResultAsset | undefined>;

export function createProviderJobRecord(
  runId: string,
  provider: string,
  status: ProviderJob['status'] = 'queued',
  progress = 0,
  now = new Date().toISOString(),
): ProviderJob {
  return {
    id: `provider_job_${runId}`,
    provider,
    status,
    progress,
    createdAt: now,
    updatedAt: now,
  };
}

/** Whether a failed/cancelled predecessor still has an unknown live task. */
export function canResumeProviderJob(
  providerJob: ProviderJob | undefined,
): providerJob is ProviderJob {
  if (!providerJob?.platformJobId) return false;
  if (providerJob.status !== 'failed' && providerJob.status !== 'cancelled') return true;
  const payload = providerJob.payload;
  const statusResponse =
    payload && typeof payload.statusResponse === 'object' && payload.statusResponse !== null
      ? (payload.statusResponse as Record<string, unknown>)
      : undefined;
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

export function normalizeProviderExecution(
  value: RunResult | ProviderExecution,
): ProviderExecution {
  if ('result' in value && value.result && typeof value.result === 'object') {
    const output =
      'output' in value && value.output !== undefined
        ? normalizeProviderOutput(value.output, value.result.mediaType)
        : undefined;
    return { ...value, ...(output ? { output } : {}) };
  }
  return { result: value as RunResult };
}

export function createRunWorker(options: {
  connection: ConnectionOptions;
  queueName?: string;
  stepDelayMs?: number;
  provider?: ProviderExecutor;
  /** Dedicated asynchronous provider used only when the target media type is video. */
  videoProvider?: ProviderExecutor;
  providerName?: 'mock' | 'newapi';
  resultArchiver?: ResultAssetArchiver;
  persistence?: RunPersistence;
  resolveDatabaseRunId?: DatabaseRunIdResolver;
  onPersistenceError?: (error: unknown) => void;
  logger?: WorkerLogger;
  observability?: Observability;
}) {
  const name = options.queueName ?? queueName;
  const queue = new Queue<RunJobData>(name, { connection: options.connection });
  const logger = options.logger ?? createNoopWorkerLogger();
  const observability =
    options.observability ??
    createEnvironmentObservability({ logger, service: 'multimodal-canvas-worker' });
  const mockProvider = new MockProvider();
  let environmentProviders: { standard: ProviderExecutor; video: ProviderExecutor } | undefined;
  const getNewApiProvider = async (
    video: boolean,
    snapshot: RunSnapshot,
  ): Promise<ProviderExecutor | undefined> => {
    if (options.providerName !== 'newapi') return undefined;
    if (video && options.videoProvider) return options.videoProvider;
    if (options.provider) return options.provider;
    const credentialReference: WorkerCredentialReference = {
      ...(snapshot.credentialId ? { credentialId: snapshot.credentialId } : {}),
      ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
    };
    if (options.persistence) {
      // A persisted worker must never silently fall back to its process
      // environment: that key may have changed after this run was queued.
      if (!options.persistence.getProviderCredentials) {
        throw new Error('persistent New API worker requires a credential snapshot resolver');
      }
      if (!credentialReference.credentialId || !credentialReference.credentialVersion) {
        throw new Error('run snapshot is missing an immutable New API credential reference');
      }
      const credentials = await options.persistence.getProviderCredentials(credentialReference);
      if (!credentials) {
        throw new Error(
          `New API credential snapshot ${credentialReference.credentialId}@${credentialReference.credentialVersion} is unavailable`,
        );
      }
      const providers = createNewApiProviders(credentials);
      return video ? providers.video : providers.standard;
    }
    environmentProviders ??= createNewApiProvidersFromEnvironment();
    return video ? environmentProviders.video : environmentProviders.standard;
  };
  const stepDelayMs = options.stepDelayMs ?? 20;
  const worker = new Worker<RunJobData, RunJobResult>(
    name,
    async (job) => {
      const initialData = runJobDataSchema.parse(job.data);
      const runSpan: ObservabilitySpan = observability.startSpan('run.process', {
        'run.id': initialData.runId,
        'worker.job_id': String(job.id ?? ''),
        'run.provider': initialData.provider,
        'run.attempt': initialData.attempt,
        'service.name': process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas-worker',
      });
      const finishRunSpan = (status: 'ok' | 'error', runStatus: RunStatus) => {
        runSpan.setAttribute('run.status', runStatus);
        runSpan.end(status);
      };
      const runLogger = logger.child({
        runId: initialData.runId,
        bullmqJobId: job.id,
        provider: initialData.provider,
        attempt: initialData.attempt,
      });
      runLogger.info({ status: 'preparing' }, 'run started');
      const databaseRunId = await resolveDatabaseRunId(
        options.resolveDatabaseRunId,
        initialData.runId,
        initialData.snapshot,
        options.onPersistenceError,
      );
      // A retry may be enqueued after the API process has lost its in-memory
      // provider-job envelope. Recover the external task identity from the
      // previous durable run before calling an asynchronous provider. This
      // keeps a retry from issuing a second paid creation request.
      let recoveredProviderJob: ProviderJob | undefined;
      if (initialData.retryOf && !initialData.providerJob?.platformJobId) {
        try {
          // Prefer the predecessor BullMQ job: it is available even when the
          // database adapter is disabled for local development.
          const predecessor = await Job.fromId<RunJobData>(queue, initialData.retryOf);
          const predecessorData = predecessor
            ? runJobDataSchema.safeParse(predecessor.data)
            : undefined;
          const predecessorProviderJob = predecessorData?.success
            ? predecessorData.data.providerJob
            : undefined;
          if (
            canResumeProviderJob(predecessorProviderJob) &&
            predecessorProviderJob.provider === initialData.provider
          ) {
            recoveredProviderJob = predecessorProviderJob;
          }
          if (!recoveredProviderJob && options.persistence?.findProviderJobByRunId) {
            const persistedProviderJob = await options.persistence.findProviderJobByRunId(
              initialData.retryOf,
            );
            if (
              canResumeProviderJob(persistedProviderJob) &&
              persistedProviderJob.provider === initialData.provider
            ) {
              recoveredProviderJob = persistedProviderJob;
            }
          }
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'provider job recovery failed');
          options.onPersistenceError?.(error);
        }
      }
      const persistProviderJob = async (providerJob: ProviderJob) => {
        if (!options.persistence || !databaseRunId) return;
        try {
          await options.persistence.upsertProviderJob({
            runId: databaseRunId,
            providerJob: sanitizeProviderJobRecord(providerJob),
          });
        } catch (error) {
          runLogger.warn(
            { ...serializeWorkerError(error), providerJobStatus: providerJob.status },
            'provider job persistence failed',
          );
          options.onPersistenceError?.(error);
        }
      };
      const persistProviderJobStrict = async (providerJob: ProviderJob) => {
        if (!options.persistence || !databaseRunId) return;
        try {
          await options.persistence.upsertProviderJob({
            runId: databaseRunId,
            providerJob: sanitizeProviderJobRecord(providerJob),
          });
        } catch (error) {
          runLogger.error(
            { ...serializeWorkerError(error), providerJobStatus: providerJob.status },
            'provider job persistence failed',
          );
          options.onPersistenceError?.(error);
          throw error;
        }
      };
      const persistRun = async (
        status: RunStatus,
        providerJob?: ProviderJob,
        result?: RunResult,
        error?: string,
      ) => {
        if (!options.persistence?.updateRun || !databaseRunId) return;
        try {
          await options.persistence.updateRun({
            runId: databaseRunId,
            status,
            ...(providerJob ? { providerJob } : {}),
            ...(result ? { result } : {}),
            ...(error ? { error } : {}),
          });
        } catch (persistenceError) {
          runLogger.warn(
            { ...serializeWorkerError(persistenceError), runStatus: status },
            'run persistence failed',
          );
          options.onPersistenceError?.(persistenceError);
        }
      };
      if (options.persistence?.ensureRun && databaseRunId) {
        try {
          await options.persistence.ensureRun({
            runId: databaseRunId,
            snapshot: initialData.snapshot,
            status: 'queued',
            attempt: initialData.attempt,
            provider: initialData.provider,
            providerJob: initialData.providerJob,
            retryOf: initialData.retryOf,
            idempotencyKey: initialData.idempotencyKey,
          });
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'run snapshot persistence failed');
          options.onPersistenceError?.(error);
        }
      }
      const persistUsage = async (usage: ProviderUsage, providerJob: ProviderJob) => {
        // A provider may report token/media counters without a price. The
        // usage ledger stores money only, so do not invent a zero/estimated
        // charge for metadata-only responses.
        const amount = usage.amount;
        if (!options.persistence || !databaseRunId || amount === undefined) return;
        try {
          await options.persistence.recordUsage({
            runId: databaseRunId,
            amount,
            ...(providerJob.provider === 'newapi'
              ? {
                  providerJobId: providerJob.platformJobId ?? providerJob.id,
                  kind: 'generation',
                }
              : {}),
            ...(usage.currency ? { currency: usage.currency } : {}),
            ...(usage.userId ? { userId: usage.userId } : {}),
            ...(usage.metadata ? { metadata: usage.metadata } : {}),
          });
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'usage persistence failed');
          options.onPersistenceError?.(error);
        }
      };
      const initialProviderJob = sanitizeProviderJobRecord({
        ...(initialData.providerJob ??
          createProviderJobRecord(initialData.runId, initialData.provider)),
        ...(recoveredProviderJob?.platformJobId && !initialData.providerJob?.platformJobId
          ? {
              platformJobId: recoveredProviderJob.platformJobId,
              payload: recoveredProviderJob.payload,
            }
          : {}),
      });
      if (recoveredProviderJob?.platformJobId && !initialData.providerJob?.platformJobId) {
        const data = runJobDataSchema.parse(job.data);
        await job.updateData({ ...data, providerJob: initialProviderJob });
      }
      await persistProviderJob(initialProviderJob);

      const update = async (status: RunStatus, progress: number) => {
        if (await isCancellationRequested(queue, job.id)) {
          return false;
        }
        const data = runJobDataSchema.parse(job.data);
        const updatedAt = new Date().toISOString();
        const providerJob = {
          ...(data.providerJob ?? createProviderJobRecord(data.runId, data.provider)),
          status: status === 'queued' ? ('queued' as const) : ('running' as const),
          progress,
          updatedAt,
        } satisfies ProviderJob;
        await job.updateData({ ...data, providerJob });
        await persistProviderJob(providerJob);
        await persistRun(status, providerJob);
        await job.updateProgress({
          status,
          progress,
          updatedAt,
        } satisfies WorkerProgress);
        runLogger.info({ status, progress }, 'run progress updated');
        return true;
      };

      const markCancelled = async (progress: number): Promise<RunJobResult> => {
        const data = runJobDataSchema.parse(job.data);
        const updatedAt = new Date().toISOString();
        const providerJob = {
          ...(data.providerJob ?? createProviderJobRecord(data.runId, data.provider)),
          status: 'cancelled' as const,
          progress,
          updatedAt,
        } satisfies ProviderJob;
        await job.updateData({ ...data, providerJob });
        await persistProviderJob(providerJob);
        await persistRun('cancelled', providerJob);
        await job.updateProgress({
          status: 'cancelled',
          progress,
          updatedAt,
        } satisfies WorkerProgress);
        runLogger.info({ status: 'cancelled', progress }, 'run cancelled');
        finishRunSpan('ok', 'cancelled');
        return { status: 'cancelled', progress, providerJob };
      };

      for (const [status, progress] of [
        ['preparing', 10],
        ['running', 45],
        ['processing', 80],
      ] as const) {
        if (!(await update(status, progress))) {
          return markCancelled(progress);
        }
        await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
      }

      if (await isCancellationRequested(queue, job.id)) {
        return markCancelled(80);
      }

      const data = runJobDataSchema.parse(job.data);
      const cachedResult = cachedProviderResult(data.providerJob?.payload);
      if (data.providerJob?.status === 'succeeded' && cachedResult) {
        await job.updateProgress({
          status: 'processing',
          progress: 100,
          updatedAt: new Date().toISOString(),
        } satisfies WorkerProgress);
        await persistRun('succeeded', data.providerJob, cachedResult);
        runLogger.info({ status: 'succeeded', progress: 100, cached: true }, 'run succeeded');
        finishRunSpan('ok', 'succeeded');
        return {
          status: 'succeeded',
          progress: 100,
          providerJob: data.providerJob,
          result: {
            ...cachedResult,
            providerJob: data.providerJob,
          },
        };
      }
      const target = data.snapshot.nodes.find((node) => node.id === data.snapshot.targetNodeId);
      let activeProviderJob: ProviderJob = initialProviderJob;
      try {
        const provider =
          data.provider === 'newapi'
            ? await getNewApiProvider(target?.data.mediaType === 'video', data.snapshot)
            : (options.provider ?? mockProvider);
        if (!provider) throw new Error('New API provider is not configured for this worker');
        const now = new Date().toISOString();
        const providerJob = {
          ...(data.providerJob ?? initialProviderJob),
          status: 'running' as const,
          progress: 80,
          updatedAt: now,
        } satisfies ProviderJob;
        activeProviderJob = providerJob;
        await job.updateData({ ...data, providerJob });
        await persistProviderJob(providerJob);
        await persistRun('running', providerJob);
        const execution = normalizeProviderExecution(
          await provider.execute({
            snapshot: data.snapshot,
            providerJob,
            onProviderJob: async (update) => {
              const currentData = runJobDataSchema.parse(job.data);
              const current = currentData.providerJob ?? providerJob;
              const safePayload = update.payload
                ? sanitizeProviderJobPayload(update.payload)
                : undefined;
              const merged: ProviderJob = {
                ...current,
                ...update,
                // Local identity is stable for the run; only the provider's
                // platform ID/status/progress/payload are allowed to change.
                id: current.id,
                provider: current.provider,
                createdAt: current.createdAt,
                status: update.status ?? current.status,
                progress: Math.max(current.progress, update.progress ?? current.progress),
                ...(safePayload ? { payload: safePayload } : {}),
                updatedAt: new Date().toISOString(),
              };
              if (update.payload !== undefined && !safePayload) delete merged.payload;
              activeProviderJob = merged;
              await job.updateData({ ...currentData, providerJob: merged });
              await persistProviderJobStrict(merged);
              await persistRun(
                merged.status === 'failed'
                  ? 'failed'
                  : merged.status === 'cancelled'
                    ? 'cancelled'
                    : 'processing',
                merged,
              );
              // Keep the local object in sync for cancellation/progress paths
              // that run while the provider is polling.
              Object.assign(providerJob, merged);
            },
            reportProgress: async (progress) => {
              const providerProgress = Math.max(0, Math.min(100, Math.round(progress)));
              // Provider polling owns the final processing slice. Keep the
              // public lifecycle monotonic and reserve 100 for archived output.
              const lifecycleProgress = Math.min(
                99,
                80 + Math.round((providerProgress / 100) * 19),
              );
              providerJob.progress = Math.max(providerJob.progress, lifecycleProgress);
              providerJob.updatedAt = new Date().toISOString();
              await job.updateProgress({
                status: 'processing',
                progress: providerJob.progress,
                updatedAt: providerJob.updatedAt,
              } satisfies WorkerProgress);
              await persistProviderJob(providerJob);
              await persistRun('processing', providerJob);
            },
          }),
        );
        // A provider call may outlive a user cancellation request. Check
        // again before archiving or marking the run successful so a late
        // provider response cannot overwrite the cancelled state.
        if (await isCancellationRequested(queue, job.id)) {
          return markCancelled(providerJob.progress);
        }
        const output = execution.output
          ? normalizeProviderOutput(execution.output, execution.result.mediaType)
          : undefined;
        const archiveInput = output
          ? providerOutputToArchiveInput(output, execution.result.mediaType)
          : undefined;
        const rawProviderMetadata: Partial<ProviderJob> = execution.providerJob ?? {};
        const providerMetadata: Partial<ProviderJob> = {
          ...rawProviderMetadata,
          ...(rawProviderMetadata.payload
            ? { payload: sanitizeProviderJobPayload(rawProviderMetadata.payload) }
            : {}),
        };
        const executionProviderJob: ProviderJob = {
          ...providerJob,
          ...providerMetadata,
          id: providerJob.id,
          provider: providerJob.provider,
          status: 'running',
          progress: Math.max(providerJob.progress, providerMetadata.progress ?? 0),
          createdAt: providerJob.createdAt,
          updatedAt: new Date().toISOString(),
        };
        activeProviderJob = executionProviderJob;
        const latestData = runJobDataSchema.parse(job.data);
        await job.updateData({ ...latestData, providerJob: executionProviderJob });
        await persistProviderJob(executionProviderJob);
        await persistRun('processing', executionProviderJob);
        const asset = await options.resultArchiver?.({
          runId: data.runId,
          ...(data.userId ? { userId: data.userId } : {}),
          snapshot: data.snapshot,
          result: execution.result,
          providerJob: executionProviderJob,
          ...(output ? { output } : {}),
          ...(archiveInput ? { archiveInput } : {}),
        });
        if (await isCancellationRequested(queue, job.id)) {
          return markCancelled(executionProviderJob.progress);
        }
        const completedAt = new Date().toISOString();
        const archivedResult = {
          ...execution.result,
          ...(asset ? { asset } : {}),
        } satisfies RunResult;
        const safeArchivedResult = sanitizeProviderJobPayload({ result: archivedResult })?.result;
        const completedProviderJob: ProviderJob = {
          ...executionProviderJob,
          status: 'succeeded',
          progress: 100,
          payload: {
            ...(providerJob.payload ?? {}),
            ...(providerMetadata.payload ?? {}),
            ...(execution.usage?.metadata
              ? (sanitizeProviderJobPayload({ usage: execution.usage.metadata }) ?? {})
              : {}),
            ...(safeArchivedResult ? { result: safeArchivedResult } : {}),
          },
          updatedAt: completedAt,
        };
        const completedData = runJobDataSchema.parse(job.data);
        await job.updateData({ ...completedData, providerJob: completedProviderJob });
        await persistProviderJob(completedProviderJob);
        await persistRun('succeeded', completedProviderJob, archivedResult);
        if (execution.usage) await persistUsage(execution.usage, completedProviderJob);
        runLogger.info({ status: 'succeeded', progress: 100 }, 'run succeeded');
        finishRunSpan('ok', 'succeeded');
        return {
          status: 'succeeded',
          progress: 100,
          providerJob: completedProviderJob,
          result: {
            ...archivedResult,
            providerJob: completedProviderJob,
          },
        };
      } catch (error) {
        const failedAt = new Date().toISOString();
        const failedProviderJob = {
          ...attachProviderErrorMetadata(activeProviderJob, error),
          status: 'failed' as const,
          updatedAt: failedAt,
        };
        const failedData = runJobDataSchema.parse(job.data);
        await job.updateData({ ...failedData, providerJob: failedProviderJob });
        await persistProviderJob(failedProviderJob);
        await persistRun(
          'failed',
          failedProviderJob,
          undefined,
          serializeWorkerError(error).errorMessage,
        );
        runLogger.error({ ...serializeWorkerError(error), status: 'failed' }, 'run failed');
        runSpan.recordException(error);
        observability.captureException(error, {
          component: 'worker',
          'run.id': data.runId,
          'run.provider': data.provider,
        });
        finishRunSpan('error', 'failed');
        throw error;
      }
    },
    { connection: options.connection },
  );

  return { queue, worker };
}

/** Preserve an asynchronous provider identity even when polling or download fails. */
export function attachProviderErrorMetadata(providerJob: ProviderJob, error: unknown): ProviderJob {
  if (!error || typeof error !== 'object') return providerJob;
  const candidate = error as { platformJobId?: unknown; providerPayload?: unknown };
  const platformJobId =
    typeof candidate.platformJobId === 'string' && candidate.platformJobId.trim()
      ? candidate.platformJobId.trim()
      : undefined;
  const providerPayload =
    candidate.providerPayload &&
    typeof candidate.providerPayload === 'object' &&
    !Array.isArray(candidate.providerPayload)
      ? (candidate.providerPayload as Record<string, unknown>)
      : undefined;
  if (!platformJobId && !providerPayload) return providerJob;
  return {
    ...providerJob,
    ...(platformJobId ? { platformJobId } : {}),
    ...(providerPayload
      ? {
          payload: {
            ...(providerJob.payload ?? {}),
            ...(sanitizeProviderJobPayload({ statusResponse: providerPayload }) ?? {}),
          },
        }
      : {}),
  };
}

/**
 * Keep provider-job JSON useful for reconciliation without persisting a raw
 * gateway response. In particular, signed media URLs, data URLs, base64
 * bodies, authorization material, and arbitrary nested response fields are
 * deliberately discarded.
 */
export function sanitizeProviderJobPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  const allowed = new Set([
    'contract',
    'phase',
    'modelAlias',
    'providerStatus',
    'progress',
    'status',
    'code',
    'errorCode',
    'requestId',
    'retryable',
    'attempt',
    'error',
    'statusResponse',
    'usage',
    'result',
  ]);
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (key === 'result') {
      const result = sanitizeProviderResult(raw);
      if (result) output.result = result;
      continue;
    }
    if (key === 'statusResponse') {
      const statusResponse = sanitizeProviderStatusResponse(raw);
      if (statusResponse) output.statusResponse = statusResponse;
      continue;
    }
    if (key === 'usage') {
      const usage = sanitizeProviderUsage(raw);
      if (usage) output.usage = usage;
      continue;
    }
    const scalar = sanitizeProviderScalar(key, raw);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeProviderJobRecord(providerJob: ProviderJob): ProviderJob {
  const payload = sanitizeProviderJobPayload(providerJob.payload);
  return {
    ...providerJob,
    ...(payload ? { payload } : {}),
    ...(providerJob.payload && !payload ? { payload: undefined } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeProviderStatusResponse(value: unknown): Record<string, unknown> | undefined {
  return sanitizeProviderRecord(
    value,
    new Set([
      'status',
      'phase',
      'providerStatus',
      'progress',
      'code',
      'errorCode',
      'requestId',
      'retryable',
      'error',
    ]),
  );
}

function sanitizeProviderUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    // Usage metadata is provider-defined, so retain only scalar counters and
    // identifiers while rejecting URL/body/credential-shaped fields.
    if (/(url|uri|base64|secret|authorization|api[-_]?key|content)/i.test(key)) continue;
    const scalar = sanitizeProviderScalar(key, raw);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeProviderResult(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of ['provider', 'summary', 'targetNodeId', 'mediaType', 'inputCount'] as const) {
    const scalar = sanitizeProviderScalar(key, value[key]);
    if (scalar !== undefined) output[key] = scalar;
  }
  if (isRecord(value.asset)) {
    const asset: Record<string, unknown> = {};
    for (const key of ['assetId', 'version', 'mimeType', 'sizeBytes', 'sha256'] as const) {
      const scalar = sanitizeProviderScalar(key, value.asset[key]);
      if (scalar !== undefined) asset[key] = scalar;
    }
    if (Object.keys(asset).length > 0) output.asset = asset;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeProviderRecord(
  value: unknown,
  allowed: Set<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    const scalar = sanitizeProviderScalar(key, raw);
    if (scalar !== undefined) output[key] = scalar;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function sanitizeProviderScalar(
  key: string,
  value: unknown,
): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (
    /(url|uri|base64|secret|authorization|api[-_]?key)/i.test(key) ||
    /^(?:access|refresh|id)?token$/i.test(key)
  ) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 2000) return undefined;
  if (/(?:https?:|data:|blob:)/i.test(normalized)) return undefined;
  return normalized;
}

async function isCancellationRequested(queue: Queue<RunJobData>, jobId: string | undefined) {
  if (!jobId) return false;
  const job = await Job.fromId<RunJobData>(queue, jobId);
  return job ? runJobDataSchema.parse(job.data).cancelRequested : false;
}

function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
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

if (process.env.NODE_ENV !== 'test' && process.env.RUN_SERVICE !== 'memory') {
  const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const processLogger = createWorkerLogger();
  const processPersistence = createProcessPersistence();
  const processArchiver =
    process.env.WORKER_PROVIDER === 'newapi' ? createResultAssetArchiverFromEnvironment() : {};
  const { worker } = createRunWorker({
    connection,
    providerName: process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock',
    logger: processLogger,
    ...processPersistence,
    ...(processArchiver.resultArchiver ? { resultArchiver: processArchiver.resultArchiver } : {}),
  });
  worker.on('ready', () => processLogger.info({ worker: workerName }, 'worker ready'));
  worker.on('failed', (job, error) => {
    processLogger.error(
      { bullmqJobId: job?.id, ...serializeWorkerError(error) },
      'worker job failed',
    );
  });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    processLogger.info({ signal }, 'worker shutting down');
    await worker.close();
    await processPersistence.close?.();
    await processArchiver.close?.();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * The worker owns its Prisma client in production. Keep the adapter optional
 * so Mock/local development still works without DATABASE_URL.
 */
function createProcessPersistence(): {
  persistence?: RunPersistence;
  resolveDatabaseRunId?: DatabaseRunIdResolver;
  onPersistenceError?: (error: unknown) => never;
  close?: () => Promise<void>;
} {
  const persistence = createWorkerPersistenceFromEnvironment();
  if (!persistence) return {};
  return {
    persistence,
    resolveDatabaseRunId: (runId) => databaseRunId(runId),
    // A production run must not be reported as successful when its durable
    // lifecycle or usage record could not be written.
    onPersistenceError: (error) => {
      throw error;
    },
    close: () => persistence.close?.() ?? Promise.resolve(),
  };
}

function createNewApiProvidersFromEnvironment(): {
  standard: ProviderExecutor;
  video: ProviderExecutor;
} {
  const baseUrl = process.env.NEW_API_BASE_URL;
  const apiKey = process.env.NEW_API_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('WORKER_PROVIDER=newapi requires NEW_API_BASE_URL and NEW_API_API_KEY');
  }
  return createNewApiProviders({ baseUrl, apiKey });
}

function createNewApiProviders(credentials: WorkerProviderCredentials): {
  standard: ProviderExecutor;
  video: ProviderExecutor;
} {
  const { baseUrl, apiKey } = credentials;
  const timeoutMs = Number(process.env.NEW_API_TIMEOUT_MS ?? 120_000);
  const standard = new NewApiProvider({
    baseUrl,
    apiKey,
    timeoutMs,
    requireHttps: process.env.NODE_ENV === 'production',
  });
  const video = new NewApiVideoProvider({
    baseUrl,
    apiKey,
    timeoutMs,
    videoPath: process.env.NEW_API_VIDEO_PATH ?? '/videos',
    ...(process.env.NEW_API_VIDEO_CREATE_PATH
      ? { videoCreatePath: process.env.NEW_API_VIDEO_CREATE_PATH }
      : {}),
    ...(process.env.NEW_API_VIDEO_JOBS_PATH
      ? { videoJobsPath: process.env.NEW_API_VIDEO_JOBS_PATH }
      : {}),
    pollIntervalMs: Number(process.env.NEW_API_VIDEO_POLL_INTERVAL_MS ?? 2_000),
    maxPollAttempts: Number(process.env.NEW_API_VIDEO_MAX_POLL_ATTEMPTS ?? 120),
    maxContentBytes: Number(process.env.NEW_API_VIDEO_MAX_CONTENT_BYTES ?? 50 * 1024 * 1024),
    requireHttps: process.env.NODE_ENV === 'production',
  });
  return { standard, video };
}

function cachedProviderResult(payload: Record<string, unknown> | undefined): RunResult | undefined {
  if (!payload || !('result' in payload)) return undefined;
  const parsed = runResultSchema.safeParse(payload.result);
  return parsed.success ? parsed.data : undefined;
}

const DATABASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveDatabaseRunId(
  resolver: DatabaseRunIdResolver | undefined,
  runId: string,
  snapshot: RunSnapshot,
  onError?: (error: unknown) => void,
): Promise<string | undefined> {
  try {
    const resolved = resolver ? await resolver(runId, snapshot) : runId;
    return resolved && DATABASE_UUID_PATTERN.test(resolved) ? resolved : undefined;
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

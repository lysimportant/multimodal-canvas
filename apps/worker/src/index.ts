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

const workerName = 'multimodal-canvas-worker';
const queueName = 'multimodal-canvas-runs';

type WorkerProgress = {
  status: RunStatus;
  progress: number;
  updatedAt: string;
};

export type ProviderExecution = {
  result: RunResult;
  providerJob?: Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;
  usage?: ProviderUsage;
};

export type ProviderUsage = {
  amount: number | string;
  currency?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Persistence is injected by the process that owns Prisma. The worker keeps
 * this structural boundary so the default BullMQ/Mock setup has no database
 * dependency and can still run in tests or local development.
 */
export type RunPersistence = {
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
  recordUsage(input: {
    runId?: string;
    userId?: string;
    amount: number | string;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  close?(): Promise<void>;
};

export type DatabaseRunIdResolver = (
  runId: string,
  snapshot: RunSnapshot,
) => string | undefined | Promise<string | undefined>;

export type ResultAssetArchiver = (input: {
  runId: string;
  snapshot: RunSnapshot;
  result: RunResult;
  providerJob: ProviderJob;
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

export function normalizeProviderExecution(
  value: RunResult | ProviderExecution,
): ProviderExecution {
  if ('result' in value && value.result && typeof value.result === 'object') return value;
  return { result: value as RunResult };
}

export function createRunWorker(options: {
  connection: ConnectionOptions;
  queueName?: string;
  stepDelayMs?: number;
  provider?: {
    execute(request: NewApiProviderRequest): Promise<RunResult | ProviderExecution>;
  };
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
  const newApiProvider =
    options.providerName === 'newapi'
      ? (options.provider ?? createNewApiProviderFromEnvironment())
      : undefined;
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
      const persistProviderJob = async (providerJob: ProviderJob) => {
        if (!options.persistence || !databaseRunId) return;
        try {
          await options.persistence.upsertProviderJob({ runId: databaseRunId, providerJob });
        } catch (error) {
          runLogger.warn(
            { ...serializeWorkerError(error), providerJobStatus: providerJob.status },
            'provider job persistence failed',
          );
          options.onPersistenceError?.(error);
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
      const persistUsage = async (usage: ProviderUsage) => {
        if (!options.persistence || !databaseRunId) return;
        try {
          await options.persistence.recordUsage({ runId: databaseRunId, ...usage });
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'usage persistence failed');
          options.onPersistenceError?.(error);
        }
      };
      await persistProviderJob(
        initialData.providerJob ?? createProviderJobRecord(initialData.runId, initialData.provider),
      );

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
      const provider =
        data.provider === 'newapi' ? newApiProvider : (options.provider ?? mockProvider);
      if (!provider) throw new Error('New API provider is not configured for this worker');
      const now = new Date().toISOString();
      const providerJob = {
        ...(data.providerJob ?? createProviderJobRecord(data.runId, data.provider)),
        status: 'running' as const,
        progress: 80,
        updatedAt: now,
      } satisfies ProviderJob;
      await job.updateData({ ...data, providerJob });
      await persistProviderJob(providerJob);
      await persistRun('running', providerJob);
      try {
        const execution = normalizeProviderExecution(
          await provider.execute({
            snapshot: data.snapshot,
            reportProgress: async (progress) => {
              providerJob.progress = Math.max(providerJob.progress, progress);
              providerJob.updatedAt = new Date().toISOString();
              await job.updateProgress({
                status: 'processing',
                progress,
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
        const asset = await options.resultArchiver?.({
          runId: data.runId,
          snapshot: data.snapshot,
          result: execution.result,
          providerJob,
        });
        if (await isCancellationRequested(queue, job.id)) {
          return markCancelled(providerJob.progress);
        }
        const completedAt = new Date().toISOString();
        const archivedResult = {
          ...execution.result,
          ...(asset ? { asset } : {}),
        } satisfies RunResult;
        const providerMetadata: Partial<ProviderJob> = execution.providerJob ?? {};
        const completedProviderJob: ProviderJob = {
          ...providerJob,
          ...providerMetadata,
          status: 'succeeded',
          progress: 100,
          payload: {
            ...(providerJob.payload ?? {}),
            ...(providerMetadata.payload ?? {}),
            result: archivedResult,
          },
          updatedAt: completedAt,
        };
        await job.updateData({ ...data, providerJob: completedProviderJob });
        await persistProviderJob(completedProviderJob);
        await persistRun('succeeded', completedProviderJob, archivedResult);
        if (execution.usage) await persistUsage(execution.usage);
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
        await job.updateData({
          ...data,
          providerJob: { ...providerJob, status: 'failed', updatedAt: failedAt },
        });
        const failedProviderJob = {
          ...providerJob,
          status: 'failed' as const,
          updatedAt: failedAt,
        };
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
  const { worker } = createRunWorker({
    connection,
    providerName: process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock',
    logger: processLogger,
    ...processPersistence,
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

function createNewApiProviderFromEnvironment() {
  const baseUrl = process.env.NEW_API_BASE_URL;
  const apiKey = process.env.NEW_API_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('WORKER_PROVIDER=newapi requires NEW_API_BASE_URL and NEW_API_API_KEY');
  }
  return new NewApiProvider({
    baseUrl,
    apiKey,
    timeoutMs: Number(process.env.NEW_API_TIMEOUT_MS ?? 120_000),
  });
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

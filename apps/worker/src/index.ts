import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  requestPromptRecordSchema,
  parseReversePromptOutput,
  reversePromptResultSchema,
  runJobDataSchema,
  runResultSchema,
  frozenPromptMentionSchema,
  type NodeTiming,
  type ProviderJob,
  type RequestPromptRecord,
  type RequestPromptSendStatus,
  type RunResult,
  type RunResultAsset,
  type RunSnapshot,
  type RunJobData,
  type RunJobResult,
  type RunStatus,
  type WorkflowState,
} from '@multimodal-canvas/domain';
import {
  MockProvider,
  NewApiProvider,
  NewApiVideoProvider,
  resolveProviderMentions,
  type NewApiProviderRequest,
  type NewApiVideoContract,
} from '@multimodal-canvas/providers';
import {
  createNoopWorkerLogger,
  createWorkerLogger,
  serializeWorkerError,
  type WorkerLogger,
} from './logger';
import {
  createEnvironmentObservability,
  sanitizeExceptionForObservability,
  type Observability,
  type ObservabilitySpan,
} from '@multimodal-canvas/observability';
import { createWorkerPersistenceFromEnvironment, databaseRunId } from './prisma-persistence';
import { createResultAssetArchiverFromEnvironment } from './result-archiver';
import { mergeNodeTimings } from './node-timings';
import {
  createAssetReferenceResolverFromEnvironment,
  type AssetReferenceResolver,
} from './asset-reference-resolver';
import {
  normalizeProviderOutput,
  providerOutputToArchiveInput,
  type ProviderOutput,
  type ResultAssetArchiveInput,
} from './result-output';
import { shouldStartWorkerProcess } from './startup-config';
import {
  cachedWorkflowResult,
  assertWorkflowModelAliases,
  createInitialWorkflowState,
  createNodeRunSnapshot,
  createWorkflowProviderJobRecord,
  replaceWorkflowNodeState,
  workflowExecutionOrder,
  workflowFinalResult,
  workflowNodeIdFromProviderJob,
  workflowNodeState,
  workflowSnapshotFingerprint,
  workflowSnapshotFingerprintV1,
  WorkflowNodeConfigurationError,
} from './workflow-dag';

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

/** 一次请求记录的身份；与 `requestPromptRecordKey` 的输入一致。 */
export type RequestPromptRecordIdentity = Pick<
  RequestPromptRecord,
  'runId' | 'nodeId' | 'attempt' | 'requestIdentity'
>;

/** 可持久化的请求身份；队列和供应商任务中不携带提示词正文。 */
const requestPromptIdentitySchema = requestPromptRecordSchema.pick({
  runId: true,
  nodeId: true,
  attempt: true,
  requestIdentity: true,
});

/** 请求提示词记录可观测的发送终态；`pending` 由 Provider 在发送前写入。 */
export type ObservableRequestPromptSendStatus = Exclude<RequestPromptSendStatus, 'pending'>;

/** 归档完成后绑定到请求记录上的结果身份。 */
export type RequestPromptResultBinding = {
  assetId: string;
  assetVersion: number;
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
  /** 读取当前平台节点超时（毫秒）；在开始执行节点时读取，不改写冻结凭据。 */
  getProviderTimeoutMs?(): Promise<number | undefined>;
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
    /**
     * 本次执行累计的节点生命周期时间。写入必须单调：同一字段只保留最早时刻，
     * 迟到的重复事件既不能让时间倒退，也不能延长已经结束的耗时。
     */
    nodeTimings?: Record<string, NodeTiming>;
  }): Promise<unknown>;
  upsertProviderJob(input: { runId: string; providerJob: ProviderJob }): Promise<unknown>;
  /**
   * 请求发送前以 `requestPromptRecordKey` 幂等落库最终请求文本。
   *
   * 同一键重放不新增行，也不用旧数据覆盖已落库的状态；结果身份只在归档完成后
   * 通过 `recordRequestPromptOutcome` 补写。写入失败必须让调用方放弃本次请求，
   * 避免出现已计费却无法追溯的结果。
   */
  upsertRequestPromptRecord?(input: { record: RequestPromptRecord }): Promise<unknown>;
  /**
   * 写入本次请求可观测的终态：发送状态，以及归档后的结果身份。
   *
   * 只允许 `pending` → 终态；已落库的终态不会被迟到或重复的事件改写，结果身份
   * 只在缺失时补写一次。`unknown` 表示发送结果不确定，不得据此自动重发创建请求。
   */
  recordRequestPromptOutcome?(input: {
    identity: RequestPromptRecordIdentity;
    sendStatus: ObservableRequestPromptSendStatus;
    assetId?: string;
    assetVersion?: number;
  }): Promise<unknown>;
  /** Resolve the last durable provider job for a failed/cancelled retry source. */
  findProviderJobByRunId?(runId: string): Promise<ProviderJob | undefined>;
  /** Resolve every durable asynchronous task for a DAG retry source. */
  findProviderJobsByRunId?(runId: string): Promise<ProviderJob[]>;
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

export type WorkerProviderRequest = NewApiProviderRequest & {
  /** Worker-local cooperative cancellation; built-in providers are also given an abortable fetch. */
  signal?: AbortSignal;
};

type WorkerCancellationMonitor = {
  controller: AbortController;
  stop: () => void;
};

type ProviderExecutor = {
  execute(request: WorkerProviderRequest): Promise<RunResult | ProviderExecution>;
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
  archiveKey?: string;
  signal?: AbortSignal;
}) => Promise<(RunResultAsset & { finalFrame?: RunResult['finalFrame'] }) | undefined>;

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

/** 网关可能已经收到请求的可重试状态：不构成“明确拒绝”。 */
const RETRYABLE_REJECTION_STATUSES = new Set([408, 425, 429]);

/** 只接受可用的 HTTP 状态码；缺失或非法值按“无法判定”处理。 */
function usableHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * 判定一次已留存请求可观测的发送终态。
 *
 * Provider 调用返回后请求确定为 `sent`；抛错时只有拿到明确证据才判定终态：
 * 携带平台任务 ID 说明创建请求已经送达并成功；只有网关明确拒绝本次请求
 * （4xx，且排除 408/425/429 这类可重试状态）才判定为 `failed`。5xx 与
 * 408/425/429 都可能是网关在 POST 之后才失败，超时、网络中断、本地取消和无法
 * 识别的错误形态同理，一律记为 `unknown`；不确定状态绝不允许触发自动重发创建
 * 请求（本函数只产出诊断状态，没有任何调用方据此重试）。
 *
 * 判定口径镜像 `packages/providers/src/index.ts` 里未导出的
 * `isDefiniteProviderRejection`（providers 包不导出该函数），改动时必须同步。
 * 这里比它更保守一点：不带可用 HTTP 状态码的错误即使携带 `model_not_found`、
 * `invalid_request_error` 之类的代码也不判为失败，因为没有响应证据就无法排除
 * 计费已经发生，而 `unknown` 是唯一不会引发重发的结论。
 *
 * @param error Provider 调用抛出的错误。
 * @returns `sent`、`failed` 或 `unknown`。
 */
export function requestPromptSendStatusForFailure(
  error: unknown,
): ObservableRequestPromptSendStatus {
  if (!isRecord(error)) return 'unknown';
  if (typeof error.platformJobId === 'string' && error.platformJobId.trim()) return 'sent';
  const status = usableHttpStatus(error.status);
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_REJECTION_STATUSES.has(status)
  ) {
    return 'failed';
  }
  return 'unknown';
}

function snapshotForProvider(snapshot: RunSnapshot, provider: string): RunSnapshot {
  if (
    provider !== 'mock' ||
    snapshot.nodeCredentialReferences === undefined ||
    Object.keys(snapshot.nodeCredentialReferences).length > 0
  ) {
    return snapshot;
  }
  const withoutCredentialReferences = { ...snapshot };
  delete withoutCredentialReferences.nodeCredentialReferences;
  return withoutCredentialReferences;
}

export function createRunWorker(options: {
  connection: ConnectionOptions;
  queueName?: string;
  stepDelayMs?: number;
  cancellationPollMs?: number;
  provider?: ProviderExecutor;
  /** Dedicated asynchronous provider used only when the target media type is video. */
  videoProvider?: ProviderExecutor;
  providerName?: 'mock' | 'newapi';
  resultArchiver?: ResultAssetArchiver;
  /** Resolves durable asset IDs to provider-readable values in memory only. */
  assetReferenceResolver?: AssetReferenceResolver;
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
  const getNewApiProvider = async (
    video: boolean,
    snapshot: RunSnapshot,
    cancellationSignal: AbortSignal,
  ): Promise<ProviderExecutor | undefined> => {
    if (options.providerName !== 'newapi') return undefined;
    const credentialReference: WorkerCredentialReference = {
      ...(snapshot.credentialId ? { credentialId: snapshot.credentialId } : {}),
      ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
    };
    let persistedCredentials: WorkerProviderCredentials | undefined;
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
      persistedCredentials = credentials;
    }
    // Credential validation is deliberately before injected providers too:
    // tests and process adapters must not bypass the durable snapshot boundary.
    if (video && options.videoProvider) return options.videoProvider;
    if (options.provider) return options.provider;
    if (persistedCredentials) {
      const configuredTimeout = await options.persistence?.getProviderTimeoutMs?.();
      const providers = createNewApiProviders(
        persistedCredentials,
        cancellationSignal,
        configuredTimeout,
      );
      return video ? providers.video : providers.standard;
    }
    const providers = createNewApiProvidersFromEnvironment(cancellationSignal);
    return video ? providers.video : providers.standard;
  };
  const stepDelayMs = options.stepDelayMs ?? 20;
  const cancellationPollMs = positiveCancellationPollMs(options.cancellationPollMs ?? 100);
  const worker = new Worker<RunJobData, RunJobResult>(
    name,
    async (job) => {
      const initialData = runJobDataSchema.parse(job.data);
      // BullMQ job data is mutable while a provider is running. Detach the
      // submitted workflow snapshot once, then only merge the explicitly
      // mutable lifecycle fields back into it on subsequent reads.
      const immutableData = structuredClone(initialData);
      const executionSnapshot = immutableData.snapshot;
      const readJobData = () => {
        const mutableData: Record<string, unknown> = isRecord(job.data) ? job.data : {};
        return runJobDataSchema.parse({
          ...immutableData,
          workflowState:
            'workflowState' in mutableData
              ? mutableData.workflowState
              : immutableData.workflowState,
          providerJob:
            'providerJob' in mutableData ? mutableData.providerJob : immutableData.providerJob,
          cancelRequested:
            typeof mutableData.cancelRequested === 'boolean'
              ? mutableData.cancelRequested
              : immutableData.cancelRequested,
        });
      };
      const snapshotFingerprints = {
        current: workflowSnapshotFingerprint(executionSnapshot),
        legacy: workflowSnapshotFingerprintV1(executionSnapshot),
      };
      const snapshotFingerprint = snapshotFingerprints.current;
      // The queue payload may contain a stale or cross-provider platform task
      // identity. Only carry it into the immutable workflow state when its
      // provider and snapshot provenance are trusted. A retry must recover a
      // missing identity from the predecessor instead of trusting an
      // unscoped platformJobId supplied on the new job.
      const immutableProviderJob =
        immutableData.providerJob &&
        immutableData.providerJob.provider === initialData.provider &&
        providerJobMatchesSnapshot(
          immutableData.providerJob,
          snapshotFingerprints,
          !initialData.retryOf,
        )
          ? immutableData.providerJob
          : undefined;
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
        executionSnapshot,
        options.onPersistenceError,
      );
      if (options.persistence?.ensureRun && !databaseRunId) {
        // A persistence adapter with run snapshots must resolve a durable ID
        // before any provider work can begin. Never treat resolver failure as
        // an opt-out from the durable idempotency boundary.
        const error = new Error('durable run persistence requires a resolvable database run id');
        runLogger.error(serializeWorkerError(error), 'run snapshot persistence is unavailable');
        options.onPersistenceError?.(error);
        throw error;
      }
      // Retries inherit completed node results and any still-live asynchronous
      // platform tasks from the predecessor. Both sources are immutable: the
      // worker never reads the current canvas while this run is executing.
      let recoveredProviderJob: ProviderJob | undefined;
      let recoveredWorkflowState: WorkflowState | undefined;
      const recoveredWorkflowProviderJobs = new Map<string, ProviderJob>();
      if (initialData.retryOf) {
        try {
          // Prefer the predecessor BullMQ payload because it includes archived
          // intermediate results even when database persistence is disabled.
          const predecessor = await Job.fromId<RunJobData>(queue, initialData.retryOf);
          const predecessorData = predecessor
            ? runJobDataSchema.safeParse(predecessor.data)
            : undefined;
          const predecessorMatchesSnapshot =
            predecessorData?.success &&
            workflowSnapshotsMatch(predecessorData.data.snapshot, executionSnapshot);
          if (predecessorMatchesSnapshot && predecessorData?.success) {
            recoveredWorkflowState = predecessorData.data.workflowState;
            for (const state of recoveredWorkflowState?.nodes ?? []) {
              if (
                state.providerJob?.provider === initialData.provider &&
                providerJobMatchesSnapshot(state.providerJob, snapshotFingerprints, true)
              ) {
                recoveredWorkflowProviderJobs.set(state.nodeId, state.providerJob);
              }
            }
            const predecessorProviderJob = predecessorData.data.providerJob;
            if (
              !immutableProviderJob?.platformJobId &&
              canResumeProviderJob(predecessorProviderJob) &&
              predecessorProviderJob.provider === initialData.provider &&
              providerJobMatchesSnapshot(predecessorProviderJob, snapshotFingerprints, true)
            ) {
              recoveredProviderJob = predecessorProviderJob;
              recoveredWorkflowProviderJobs.set(
                executionSnapshot.targetNodeId,
                predecessorProviderJob,
              );
            }
          } else if (predecessorData?.success) {
            runLogger.warn(
              { retryOf: initialData.retryOf },
              'predecessor workflow snapshot fingerprint does not match retry snapshot',
            );
          }

          if (options.persistence?.findProviderJobsByRunId) {
            const persistedJobs = await options.persistence.findProviderJobsByRunId(
              initialData.retryOf,
            );
            const snapshotNodeIds = new Set(executionSnapshot.nodes.map((node) => node.id));
            for (const persistedJob of persistedJobs) {
              if (persistedJob.provider !== initialData.provider) continue;
              if (!providerJobMatchesSnapshot(persistedJob, snapshotFingerprints)) continue;
              const nodeId =
                workflowNodeIdFromProviderJob(persistedJob) ?? executionSnapshot.targetNodeId;
              if (!snapshotNodeIds.has(nodeId)) continue;
              const queuedCandidate = recoveredWorkflowProviderJobs.get(nodeId);
              if (
                queuedCandidate &&
                (canResumeProviderJob(queuedCandidate) || cachedWorkflowResult(queuedCandidate))
              ) {
                continue;
              }
              recoveredWorkflowProviderJobs.set(nodeId, persistedJob);
            }
            const targetProviderJob = recoveredWorkflowProviderJobs.get(
              executionSnapshot.targetNodeId,
            );
            if (
              !immutableProviderJob?.platformJobId &&
              !recoveredProviderJob &&
              canResumeProviderJob(targetProviderJob)
            ) {
              recoveredProviderJob = targetProviderJob;
            }
          } else if (
            !immutableProviderJob?.platformJobId &&
            !recoveredProviderJob &&
            options.persistence?.findProviderJobByRunId
          ) {
            const persistedProviderJob = await options.persistence.findProviderJobByRunId(
              initialData.retryOf,
            );
            if (
              canResumeProviderJob(persistedProviderJob) &&
              persistedProviderJob.provider === initialData.provider &&
              providerJobMatchesSnapshot(persistedProviderJob, snapshotFingerprints)
            ) {
              recoveredProviderJob = persistedProviderJob;
              recoveredWorkflowProviderJobs.set(
                executionSnapshot.targetNodeId,
                persistedProviderJob,
              );
            }
          }
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'workflow recovery failed');
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
        strict = false,
        nodeTimingsForRun?: Record<string, NodeTiming>,
      ) => {
        if (!options.persistence?.updateRun || !databaseRunId) return;
        try {
          await options.persistence.updateRun({
            runId: databaseRunId,
            status,
            ...(providerJob ? { providerJob } : {}),
            ...(result ? { result } : {}),
            ...(error ? { error } : {}),
            ...(nodeTimingsForRun ? { nodeTimings: nodeTimingsForRun } : {}),
          });
        } catch (persistenceError) {
          runLogger.warn(
            { ...serializeWorkerError(persistenceError), runStatus: status },
            'run persistence failed',
          );
          options.onPersistenceError?.(persistenceError);
          if (strict) throw persistenceError;
        }
      };
      if (options.persistence?.ensureRun && databaseRunId) {
        try {
          await options.persistence.ensureRun({
            runId: databaseRunId,
            snapshot: executionSnapshot,
            status: 'queued',
            attempt: initialData.attempt,
            provider: initialData.provider,
            providerJob: immutableProviderJob,
            retryOf: initialData.retryOf,
            idempotencyKey: initialData.idempotencyKey,
          });
        } catch (error) {
          runLogger.warn(serializeWorkerError(error), 'run snapshot persistence failed');
          options.onPersistenceError?.(error);
          // A durable snapshot is the source of truth for recovery and
          // idempotency. Do not submit a provider request without it.
          throw error;
        }
      }
      const persistUsageStrict = async (
        usage: ProviderUsage,
        providerJob: ProviderJob,
        requestProviderJobId?: string,
      ) => {
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
                  providerJobId:
                    providerJob.platformJobId ?? requestProviderJobId ?? providerJob.id,
                  kind: 'generation',
                }
              : {}),
            ...(usage.currency ? { currency: usage.currency } : {}),
            ...(usage.userId ? { userId: usage.userId } : {}),
            ...(usage.metadata ? { metadata: usage.metadata } : {}),
          });
        } catch (error) {
          runLogger.error(serializeWorkerError(error), 'usage persistence failed');
          options.onPersistenceError?.(error);
          // An explicit provider charge must be durable before the workflow
          // records this node as succeeded. On retry the same provider-job ID
          // becomes the upstream idempotency key and the ledger key.
          throw error;
        }
      };
      /**
       * 请求发送前留存最终请求文本。计费请求必须可追溯：留存失败时放弃发送，
       * 由调用方抛出并让节点失败，而不是产生无法核对的费用。
       */
      const persistRequestPromptRecordStrict = async (record: RequestPromptRecord) => {
        const persistence = options.persistence;
        if (!persistence?.upsertRequestPromptRecord) {
          throw new Error('request prompt persistence is not configured for this worker');
        }
        try {
          await persistence.upsertRequestPromptRecord({ record });
        } catch (error) {
          runLogger.error(
            {
              ...serializeWorkerError(error),
              workflowNodeId: record.nodeId,
              requestIdentity: record.requestIdentity,
            },
            'request prompt persistence failed',
          );
          options.onPersistenceError?.(error);
          throw error;
        }
      };
      /**
       * 写入请求可观测的发送终态。此处只在返回后记录真实状态，不阻止已经发生的
       * 请求；失败时保留 Provider 已写入的 `pending`，表示发送结果尚未确认。
       */
      const recordRequestPromptOutcome = async (
        identity: RequestPromptRecordIdentity,
        sendStatus: ObservableRequestPromptSendStatus,
      ) => {
        const persistence = options.persistence;
        if (!persistence?.recordRequestPromptOutcome) return;
        try {
          await persistence.recordRequestPromptOutcome({ identity, sendStatus });
        } catch (error) {
          runLogger.warn(
            {
              ...serializeWorkerError(error),
              workflowNodeId: identity.nodeId,
              requestIdentity: identity.requestIdentity,
            },
            'request prompt send status persistence failed',
          );
          options.onPersistenceError?.(error);
        }
      };
      /**
       * 归档完成后把结果身份绑定到本次节点执行的请求记录。绑定失败会阻止把
       * 结果标记为成功，避免出现没有生成说明的可展示结果。
       */
      const bindRequestPromptResultStrict = async (
        identity: RequestPromptRecordIdentity,
        binding: RequestPromptResultBinding,
      ) => {
        const persistence = options.persistence;
        if (!persistence?.recordRequestPromptOutcome) return;
        try {
          await persistence.recordRequestPromptOutcome({
            identity,
            sendStatus: 'sent',
            assetId: binding.assetId,
            assetVersion: binding.assetVersion,
          });
        } catch (error) {
          runLogger.error(
            {
              ...serializeWorkerError(error),
              workflowNodeId: identity.nodeId,
              requestIdentity: identity.requestIdentity,
            },
            'request prompt result binding failed',
          );
          options.onPersistenceError?.(error);
          throw error;
        }
      };
      const initialProviderJobBase = sanitizeProviderJobRecord({
        ...(immutableProviderJob ??
          createProviderJobRecord(initialData.runId, initialData.provider)),
        ...(recoveredProviderJob?.platformJobId && !immutableProviderJob?.platformJobId
          ? {
              platformJobId: recoveredProviderJob.platformJobId,
              payload: recoveredProviderJob.payload,
            }
          : {}),
      });
      const initialProviderJob: ProviderJob = {
        ...initialProviderJobBase,
        payload: workflowProviderPayload(
          executionSnapshot.targetNodeId,
          initialProviderJobBase.payload,
          snapshotFingerprint,
        ),
      };
      let workflowState = createInitialWorkflowState(
        executionSnapshot,
        initialProviderJob,
        (initialData.retryOf ? undefined : immutableData.workflowState) ?? recoveredWorkflowState,
      );
      const executionOrder = workflowExecutionOrder(executionSnapshot);
      // 节点进入待执行状态的时刻只在本进程记录，等它真正开始执行时再落库：
      // 从未执行的节点不会留下任何时间条目，界面显示「未记录」。
      const queuedAtByNode = new Map<string, string>();
      /** 反推请求结果不确定时只允许显式新建，队列重放不能再次收费。 */
      const uncertainReversePromptNodes = new Set<string>();
      for (const node of executionOrder) {
        if (node.data.mode === 'source') continue;
        const currentState = workflowNodeState(workflowState, node.id);
        if (
          currentState?.status === 'succeeded' &&
          isCompletedWorkflowResultForNode(currentState.result, node, executionSnapshot)
        ) {
          continue;
        }

        const recoveredForNode = recoveredWorkflowProviderJobs.get(node.id);
        const providerCandidates = [
          currentState?.providerJob,
          recoveredForNode,
          node.id === executionSnapshot.targetNodeId ? initialProviderJob : undefined,
        ].filter(
          (candidate): candidate is ProviderJob =>
            candidate !== undefined &&
            providerJobMatchesSnapshot(candidate, snapshotFingerprints, !initialData.retryOf),
        );
        const cachedCandidate = providerCandidates.find((candidate) =>
          cachedWorkflowResult(candidate),
        );
        // A process may fail while writing the terminal Run row after the
        // provider output and workflow result are already durable. The catch
        // path marks the node failed but intentionally retains that result;
        // replay it instead of issuing another paid request.
        const cachedResult =
          (currentState?.result &&
          currentState.providerJob &&
          providerJobMatchesSnapshot(currentState.providerJob, snapshotFingerprints, false)
            ? currentState.result
            : undefined) ?? cachedWorkflowResult(cachedCandidate);
        const localProviderJob = createWorkflowProviderJobRecord(
          initialData.runId,
          executionSnapshot.targetNodeId,
          node.id,
          initialData.provider,
        );
        const requestProviderJobId = resolveWorkflowRequestProviderJobId({
          retryOf: initialData.retryOf,
          targetNodeId: executionSnapshot.targetNodeId,
          nodeId: node.id,
          provider: initialData.provider,
          current: currentState?.providerJob,
          recovered: recoveredForNode,
          fallback: localProviderJob,
        });
        if (isCompletedWorkflowResultForNode(cachedResult, node, executionSnapshot)) {
          const cachedProviderJob = cachedCandidate ?? currentState?.providerJob;
          for (const identity of cachedResult.asset?.version
            ? storedRequestPromptIdentities(cachedProviderJob, node.id)
            : []) {
            await bindRequestPromptResultStrict(identity, {
              assetId: cachedResult.asset!.assetId,
              assetVersion: cachedResult.asset!.version!,
            });
          }
          const completedProviderJob: ProviderJob = {
            ...localProviderJob,
            ...(cachedProviderJob?.platformJobId
              ? { platformJobId: cachedProviderJob.platformJobId }
              : {}),
            status: 'succeeded',
            progress: 100,
            payload: workflowProviderPayload(
              node.id,
              {
                ...(cachedProviderJob?.payload ?? {}),
                requestProviderJobId,
              },
              snapshotFingerprint,
            ),
            createdAt: cachedProviderJob?.createdAt ?? localProviderJob.createdAt,
            updatedAt: new Date().toISOString(),
          };
          workflowState = replaceWorkflowNodeState(workflowState, {
            nodeId: node.id,
            status: 'succeeded',
            providerJob: completedProviderJob,
            result: cachedResult,
          });
          continue;
        }

        if (
          executionSnapshot.reversePrompt &&
          ((currentState && currentState.status !== 'pending') ||
            providerCandidates.some(
              (candidate) =>
                storedRequestPromptIdentities(candidate, node.id).length > 0 ||
                ['submitted', 'running', 'succeeded', 'failed', 'cancelled'].includes(
                  candidate.status,
                ),
            ))
        ) {
          uncertainReversePromptNodes.add(node.id);
          continue;
        }

        const resumableProviderJob = providerCandidates.find(
          (candidate) =>
            candidate.provider === initialData.provider && canResumeProviderJob(candidate),
        );
        const providerJob: ProviderJob = resumableProviderJob
          ? {
              ...localProviderJob,
              platformJobId: resumableProviderJob.platformJobId,
              status: 'submitted',
              progress: Math.max(localProviderJob.progress, resumableProviderJob.progress),
              payload: workflowProviderPayload(
                node.id,
                {
                  ...(resumableProviderJob.payload ?? {}),
                  requestProviderJobId,
                },
                snapshotFingerprint,
              ),
              createdAt: resumableProviderJob.createdAt,
              updatedAt: new Date().toISOString(),
            }
          : {
              ...localProviderJob,
              payload: workflowProviderPayload(
                node.id,
                { requestProviderJobId },
                snapshotFingerprint,
              ),
            };
        workflowState = replaceWorkflowNodeState(workflowState, {
          nodeId: node.id,
          status: 'pending',
          providerJob,
        });
        queuedAtByNode.set(node.id, new Date().toISOString());
      }
      const targetWorkflowProviderJob =
        workflowNodeState(workflowState, executionSnapshot.targetNodeId)?.providerJob ??
        initialProviderJob;
      const initializedData = readJobData();
      await job.updateData({
        ...initializedData,
        providerJob: targetWorkflowProviderJob,
        workflowState,
      });
      await persistProviderJob(targetWorkflowProviderJob);

      // 本次进程累计的节点生命周期时间：只保留每个字段最早的时刻，重放、轮询和
      // Worker 重启都不会重置开始时间，也不会移动已经写入的终态时间。
      let nodeTimings: Record<string, NodeTiming> = {};
      const recordNodeTiming = (event: NodeTiming) => {
        nodeTimings = mergeNodeTimings(nodeTimings, { [event.nodeId]: event });
      };
      const flushNodeTimings = () =>
        Object.keys(nodeTimings).length > 0 ? nodeTimings : undefined;
      // 本次节点执行已留存的请求记录；结果归档后只绑定这些记录，绝不把目标节点
      // 的提示词附给上游结果。
      let activeRequestPrompts: RequestPromptRecordIdentity[] = [];
      const update = async (status: RunStatus, progress: number) => {
        if (await isCancellationRequested(queue, job.id)) {
          return false;
        }
        const data = readJobData();
        const updatedAt = new Date().toISOString();
        const currentProviderJob =
          data.providerJob ?? createProviderJobRecord(data.runId, data.provider);
        const providerJob: ProviderJob =
          currentProviderJob.status === 'succeeded'
            ? currentProviderJob
            : {
                ...currentProviderJob,
                status: status === 'queued' ? 'queued' : 'running',
                progress,
                payload: workflowProviderPayload(
                  executionSnapshot.targetNodeId,
                  currentProviderJob.payload,
                  snapshotFingerprint,
                ),
                updatedAt,
              };
        let nextWorkflowState = data.workflowState;
        const targetState = nextWorkflowState
          ? workflowNodeState(nextWorkflowState, executionSnapshot.targetNodeId)
          : undefined;
        if (nextWorkflowState && targetState && targetState.status !== 'succeeded') {
          nextWorkflowState = replaceWorkflowNodeState(nextWorkflowState, {
            ...targetState,
            providerJob,
          });
        }
        await job.updateData({
          ...data,
          providerJob,
          ...(nextWorkflowState ? { workflowState: nextWorkflowState } : {}),
        });
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

      const markCancelled = async (
        progress: number,
        activeNodeId?: string,
        activeNodeProviderJob?: ProviderJob,
      ): Promise<RunJobResult> => {
        const data = readJobData();
        const updatedAt = new Date().toISOString();
        const providerJob: ProviderJob = {
          ...(data.providerJob ?? createProviderJobRecord(data.runId, data.provider)),
          status: 'cancelled' as const,
          progress,
          payload: workflowProviderPayload(
            executionSnapshot.targetNodeId,
            data.providerJob?.payload,
            snapshotFingerprint,
          ),
          updatedAt,
        };
        let nextWorkflowState =
          data.workflowState ?? createInitialWorkflowState(executionSnapshot, providerJob);
        // 取消前仍处于执行中的节点必须有取消终态，否则界面会一直按运行中累计时间。
        const cancelledNodeIds = new Set(
          nextWorkflowState.nodes
            .filter((state) => state.status === 'running')
            .map((state) => state.nodeId),
        );
        if (activeNodeId) cancelledNodeIds.add(activeNodeId);
        for (const nodeId of cancelledNodeIds) {
          recordNodeTiming({ nodeId, finishedAt: updatedAt, outcome: 'cancelled' });
        }
        const targetState = workflowNodeState(nextWorkflowState, executionSnapshot.targetNodeId);
        if (targetState) {
          nextWorkflowState = replaceWorkflowNodeState(nextWorkflowState, {
            ...targetState,
            status: 'cancelled',
            providerJob,
          });
        }
        let cancelledActiveProviderJob: ProviderJob | undefined;
        if (activeNodeId && activeNodeId !== executionSnapshot.targetNodeId) {
          const activeState = workflowNodeState(nextWorkflowState, activeNodeId);
          const currentActiveProviderJob =
            activeNodeProviderJob ??
            activeState?.providerJob ??
            createWorkflowProviderJobRecord(
              data.runId,
              executionSnapshot.targetNodeId,
              activeNodeId,
              data.provider,
            );
          cancelledActiveProviderJob = {
            ...currentActiveProviderJob,
            status: 'cancelled',
            progress,
            payload: workflowProviderPayload(
              activeNodeId,
              currentActiveProviderJob.payload,
              snapshotFingerprint,
            ),
            updatedAt,
          };
          nextWorkflowState = replaceWorkflowNodeState(nextWorkflowState, {
            ...(activeState ?? { nodeId: activeNodeId }),
            status: 'cancelled',
            providerJob: cancelledActiveProviderJob,
          });
        }
        await job.updateData({ ...data, providerJob, workflowState: nextWorkflowState });
        if (cancelledActiveProviderJob) await persistProviderJob(cancelledActiveProviderJob);
        await persistProviderJob(providerJob);
        await persistRun('cancelled', providerJob, undefined, undefined, false, flushNodeTimings());
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

      const executionData = readJobData();
      const cancellationMonitor = startCancellationMonitor(queue, job.id, cancellationPollMs);
      const cancellationSignal = cancellationMonitor.controller.signal;
      let activeNodeId: string | undefined;
      let activeProviderJob: ProviderJob | undefined;
      let currentOverallProgress = 80;
      try {
        assertWorkflowModelAliases(executionSnapshot);
        const executableNodes = workflowExecutionOrder(executionSnapshot).filter(
          (node) => node.data.mode !== 'source',
        );
        const providerNodeCount = Math.max(1, executableNodes.length);

        for (let nodeIndex = 0; nodeIndex < executableNodes.length; nodeIndex += 1) {
          const node = executableNodes[nodeIndex];
          if (!node) continue;
          const currentData = readJobData();
          let currentWorkflowState =
            currentData.workflowState ??
            createInitialWorkflowState(executionSnapshot, currentData.providerJob);
          const nodeState = workflowNodeState(currentWorkflowState, node.id);
          if (!nodeState) throw new Error(`workflow state is missing node: ${node.id}`);
          if (await isCancellationRequested(queue, job.id)) {
            return markCancelled(currentOverallProgress, node.id, nodeState.providerJob);
          }
          if (
            nodeState.status === 'succeeded' &&
            isCompletedWorkflowResultForNode(nodeState.result, node, executionSnapshot)
          ) {
            continue;
          }
          if (uncertainReversePromptNodes.has(node.id)) {
            throw new Error('反推请求已发送或发送状态不确定，请在反推提示词窗口明确发起新的分析');
          }

          for (const edge of executionSnapshot.edges.filter(
            (candidate) => candidate.targetNodeId === node.id,
          )) {
            const source = executionSnapshot.nodes.find(
              (candidate) => candidate.id === edge.sourceNodeId,
            );
            if (source?.data.enabled === false) continue;
            if (
              workflowNodeState(currentWorkflowState, edge.sourceNodeId)?.status !== 'succeeded'
            ) {
              throw new Error(
                `workflow dependency ${edge.sourceNodeId} is not ready for ${node.id}`,
              );
            }
          }

          const nodeSnapshot = createNodeRunSnapshot(
            snapshotForProvider(executionSnapshot, currentData.provider),
            currentWorkflowState,
            node.id,
          );
          const nodeStartProgress = Math.min(
            99,
            80 + Math.round((nodeIndex / providerNodeCount) * 19),
          );
          currentOverallProgress = Math.max(currentOverallProgress, nodeStartProgress);
          const localProviderJob = createWorkflowProviderJobRecord(
            currentData.runId,
            executionSnapshot.targetNodeId,
            node.id,
            currentData.provider,
          );
          const existingNodeProviderJob = nodeState.providerJob;
          const now = new Date().toISOString();
          const providerJob: ProviderJob = {
            ...localProviderJob,
            ...(existingNodeProviderJob?.platformJobId
              ? { platformJobId: existingNodeProviderJob.platformJobId }
              : {}),
            status: 'running',
            progress: Math.max(nodeStartProgress, existingNodeProviderJob?.progress ?? 0),
            payload: workflowProviderPayload(
              node.id,
              existingNodeProviderJob?.payload,
              snapshotFingerprint,
            ),
            createdAt: existingNodeProviderJob?.createdAt ?? localProviderJob.createdAt,
            updatedAt: now,
          };
          activeNodeId = node.id;
          activeProviderJob = providerJob;
          // 节点真正开始执行：开始时间只写一次，重放与轮询不会重置它；排队时间
          // 取自节点进入待执行状态的时刻。
          const queuedAt = queuedAtByNode.get(node.id);
          recordNodeTiming({
            nodeId: node.id,
            ...(queuedAt ? { queuedAt } : {}),
            startedAt: now,
          });
          currentWorkflowState = replaceWorkflowNodeState(currentWorkflowState, {
            nodeId: node.id,
            status: 'running',
            providerJob,
          });
          await job.updateData({
            ...currentData,
            workflowState: currentWorkflowState,
            ...(node.id === executionSnapshot.targetNodeId
              ? { providerJob }
              : { providerJob: currentData.providerJob }),
          });
          // This row carries the stable request identity used by synchronous
          // New API calls. Losing it before a paid request would make a retry
          // unable to prove idempotency, so this boundary is fail-closed.
          await persistProviderJobStrict(providerJob);
          await persistRun(
            'processing',
            providerJob,
            undefined,
            undefined,
            false,
            flushNodeTimings(),
          );

          const provider =
            currentData.provider === 'newapi'
              ? await getNewApiProvider(
                  node.data.mediaType === 'video',
                  nodeSnapshot,
                  cancellationSignal,
                )
              : (options.provider ?? mockProvider);
          if (!provider) throw new Error('New API provider is not configured for this worker');
          const providerSnapshot = options.assetReferenceResolver
            ? await options.assetReferenceResolver.resolve(
                withWorkflowAssetVersions(nodeSnapshot, currentWorkflowState),
                currentData.userId ? { userId: currentData.userId } : undefined,
              )
            : nodeSnapshot;
          const resolvedMentions =
            options.assetReferenceResolver && providerSnapshot.promptMentions?.length
              ? resolveProviderMentions(providerSnapshot)
              : undefined;
          const requestProviderJobId = workflowRequestProviderJobId(providerJob);
          const providerRequestJob =
            node.data.mediaType === 'video' || !requestProviderJobId
              ? providerJob
              : { ...providerJob, id: requestProviderJobId };
          activeRequestPrompts = canResumeProviderJob(existingNodeProviderJob)
            ? storedRequestPromptIdentities(existingNodeProviderJob, node.id)
            : [];
          // 有持久化边界时，Provider 必须在真正发送前把最终请求文本交给 Worker
          // 落库；回调抛错会阻止本次请求，避免已计费但无法追溯。没有持久化适配器
          // 的本地运行（未配置 DATABASE_URL，例如 mock 或本地 newapi 调试）不传
          // 该回调，Provider 按其合同跳过记录：这是有意的兼容行为，不是留存失败。
          const captureRequestPrompt = options.persistence
            ? async (record: RequestPromptRecord) => {
                const parsed = requestPromptRecordSchema.safeParse(record);
                if (!parsed.success) {
                  throw new Error(
                    `provider returned an invalid request prompt record for node ${node.id}`,
                  );
                }
                if (
                  parsed.data.nodeId !== node.id ||
                  parsed.data.runId !== currentData.runId ||
                  parsed.data.attempt !== currentData.attempt
                ) {
                  throw new Error(
                    `request prompt record does not belong to workflow node ${node.id}`,
                  );
                }
                await persistRequestPromptRecordStrict(parsed.data);
                activeRequestPrompts.push(requestPromptIdentitySchema.parse(parsed.data));
                // 恢复异步任务时不会再次组装创建请求，因此必须在发送前保存原请求身份。
                const retainedProviderJob: ProviderJob = {
                  ...(activeProviderJob ?? providerJob),
                  payload: workflowProviderPayload(
                    node.id,
                    {
                      ...((activeProviderJob ?? providerJob).payload ?? {}),
                      requestPromptRecords: activeRequestPrompts,
                    },
                    snapshotFingerprint,
                  ),
                };
                activeProviderJob = retainedProviderJob;
                const retainedData = readJobData();
                const retainedWorkflowState = replaceWorkflowNodeState(
                  retainedData.workflowState ?? currentWorkflowState,
                  { nodeId: node.id, status: 'running', providerJob: retainedProviderJob },
                );
                await job.updateData({
                  ...retainedData,
                  workflowState: retainedWorkflowState,
                  ...(node.id === executionSnapshot.targetNodeId
                    ? { providerJob: retainedProviderJob }
                    : {}),
                });
                await persistProviderJobStrict(retainedProviderJob);
                // 提示词落库期间资源可能已撤销；发送前只复核权限与归档，不重复读取内容。
                await options.assetReferenceResolver?.assertAccessible?.(
                  providerSnapshot,
                  currentData.userId ? { userId: currentData.userId } : undefined,
                );
              }
            : undefined;
          recordNodeTiming({ nodeId: node.id, requestStartedAt: new Date().toISOString() });
          await persistRun(
            'processing',
            activeProviderJob ?? providerJob,
            undefined,
            undefined,
            false,
            flushNodeTimings(),
          );
          await options.assetReferenceResolver?.assertAccessible?.(
            providerSnapshot,
            currentData.userId ? { userId: currentData.userId } : undefined,
          );
          const execution = normalizeProviderExecution(
            await executeProviderWithCancellation(
              provider,
              {
                snapshot: providerSnapshot,
                ...(resolvedMentions?.length ? { resolvedMentions } : {}),
                providerJob: providerRequestJob,
                signal: cancellationSignal,
                ...(captureRequestPrompt
                  ? {
                      onRequestPrompt: captureRequestPrompt,
                      runId: currentData.runId,
                      attempt: currentData.attempt,
                    }
                  : {}),
                onProviderJob: async (update) => {
                  if (cancellationSignal.aborted) return;
                  const callbackData = readJobData();
                  let callbackWorkflowState =
                    callbackData.workflowState ??
                    createInitialWorkflowState(executionSnapshot, callbackData.providerJob);
                  const callbackState = workflowNodeState(callbackWorkflowState, node.id);
                  const currentNodeProviderJob = callbackState?.providerJob ?? providerJob;
                  const { payload: rawPayload, ...safeUpdate } = update;
                  const updateProgress =
                    typeof update.progress === 'number' && Number.isFinite(update.progress)
                      ? Math.max(0, Math.min(100, Math.round(update.progress)))
                      : currentNodeProviderJob.progress;
                  const merged: ProviderJob = {
                    ...currentNodeProviderJob,
                    ...safeUpdate,
                    // Local identity belongs to this workflow node; providers
                    // may only change their external task fields.
                    id: currentNodeProviderJob.id,
                    provider: currentNodeProviderJob.provider,
                    createdAt: currentNodeProviderJob.createdAt,
                    status: update.status ?? currentNodeProviderJob.status,
                    progress: Math.max(currentNodeProviderJob.progress, updateProgress),
                    payload: workflowProviderPayload(
                      node.id,
                      rawPayload === undefined
                        ? currentNodeProviderJob.payload
                        : {
                            ...(currentNodeProviderJob.payload ?? {}),
                            ...rawPayload,
                            requestPromptRecords: activeRequestPrompts,
                            ...(workflowRequestProviderJobId(currentNodeProviderJob)
                              ? {
                                  requestProviderJobId:
                                    workflowRequestProviderJobId(currentNodeProviderJob),
                                }
                              : {}),
                          },
                      snapshotFingerprint,
                    ),
                    updatedAt: new Date().toISOString(),
                  };
                  const callbackNodeStatus =
                    merged.status === 'failed'
                      ? 'failed'
                      : merged.status === 'cancelled'
                        ? 'cancelled'
                        : 'running';
                  if (callbackNodeStatus !== 'running') {
                    // 供应商回调已经把节点带到终态：终态时间与标签只在这里写一次。
                    recordNodeTiming({
                      nodeId: node.id,
                      finishedAt: merged.updatedAt,
                      outcome: callbackNodeStatus,
                    });
                  }
                  callbackWorkflowState = replaceWorkflowNodeState(callbackWorkflowState, {
                    nodeId: node.id,
                    status: callbackNodeStatus,
                    providerJob: merged,
                  });
                  activeProviderJob = merged;
                  await job.updateData({
                    ...callbackData,
                    workflowState: callbackWorkflowState,
                    ...(node.id === executionSnapshot.targetNodeId
                      ? { providerJob: merged }
                      : { providerJob: callbackData.providerJob }),
                  });
                  await persistProviderJobStrict(merged);
                  await persistRun(
                    merged.status === 'failed'
                      ? 'failed'
                      : merged.status === 'cancelled'
                        ? 'cancelled'
                        : 'processing',
                    merged,
                    undefined,
                    undefined,
                    false,
                    flushNodeTimings(),
                  );
                  Object.assign(providerJob, merged);
                },
                reportProgress: async (progress) => {
                  if (cancellationSignal.aborted) return;
                  const providerProgress = Math.max(0, Math.min(100, Math.round(progress)));
                  // Divide the final 19% across provider-backed DAG nodes and
                  // reserve 100 until every output has been archived.
                  const lifecycleProgress = Math.min(
                    99,
                    80 +
                      Math.round(((nodeIndex + providerProgress / 100) / providerNodeCount) * 19),
                  );
                  currentOverallProgress = Math.max(currentOverallProgress, lifecycleProgress);
                  const progressData = readJobData();
                  let progressWorkflowState =
                    progressData.workflowState ??
                    createInitialWorkflowState(executionSnapshot, progressData.providerJob);
                  const progressState = workflowNodeState(progressWorkflowState, node.id);
                  const currentNodeProviderJob = progressState?.providerJob ?? providerJob;
                  const progressedProviderJob: ProviderJob = {
                    ...currentNodeProviderJob,
                    progress: Math.max(currentNodeProviderJob.progress, lifecycleProgress),
                    payload: workflowProviderPayload(
                      node.id,
                      currentNodeProviderJob.payload,
                      snapshotFingerprint,
                    ),
                    updatedAt: new Date().toISOString(),
                  };
                  activeProviderJob = progressedProviderJob;
                  Object.assign(providerJob, progressedProviderJob);
                  progressWorkflowState = replaceWorkflowNodeState(progressWorkflowState, {
                    ...(progressState ?? { nodeId: node.id }),
                    status:
                      progressState?.status === 'failed' || progressState?.status === 'cancelled'
                        ? progressState.status
                        : 'running',
                    providerJob: progressedProviderJob,
                  });
                  await job.updateData({
                    ...progressData,
                    workflowState: progressWorkflowState,
                    ...(node.id === executionSnapshot.targetNodeId
                      ? { providerJob: progressedProviderJob }
                      : { providerJob: progressData.providerJob }),
                  });
                  await job.updateProgress({
                    status: 'processing',
                    progress: currentOverallProgress,
                    updatedAt: progressedProviderJob.updatedAt,
                  } satisfies WorkerProgress);
                  await persistProviderJob(progressedProviderJob);
                  await persistRun('processing', progressedProviderJob);
                },
              },
              cancellationSignal,
            ),
          );

          // 供应商调用已经返回：本次请求确定为已发送，请求阶段到此结束。该结论
          // 与随后的取消判断无关，因此先如实写入发送终态。
          for (const prompt of activeRequestPrompts) {
            await recordRequestPromptOutcome(prompt, 'sent');
          }
          recordNodeTiming({ nodeId: node.id, requestFinishedAt: new Date().toISOString() });
          await persistRun(
            'processing',
            activeProviderJob ?? providerJob,
            undefined,
            undefined,
            false,
            flushNodeTimings(),
          );
          // Provider calls can outlive cancellation requests. Never archive a
          // late response over a cancelled workflow.
          if (await isCancellationRequested(queue, job.id)) {
            return markCancelled(currentOverallProgress, node.id, activeProviderJob);
          }
          const executionResult = runResultSchema.parse(execution.result);
          if (
            executionResult.targetNodeId !== node.id ||
            executionResult.mediaType !== node.data.mediaType
          ) {
            throw new Error(`provider returned a result for the wrong workflow node: ${node.id}`);
          }
          const output = execution.output
            ? normalizeProviderOutput(execution.output, executionResult.mediaType)
            : undefined;
          const archiveInput = output
            ? providerOutputToArchiveInput(output, executionResult.mediaType)
            : undefined;
          if (!output || !archiveInput) {
            throw new Error(`provider returned no archivable output for workflow node ${node.id}`);
          }
          const reversePrompt = executionSnapshot.reversePrompt
            ? parseReversePromptOutput(output.kind === 'text' ? output.text : '')
            : undefined;
          if (!reversePrompt && !options.resultArchiver) {
            throw new Error(`result archiver is required for workflow node ${node.id}`);
          }
          const rawProviderMetadata: Partial<ProviderJob> = execution.providerJob ?? {};
          const { payload: rawProviderMetadataPayload, ...providerMetadata } = rawProviderMetadata;
          const safeProviderMetadataPayload = rawProviderMetadataPayload
            ? sanitizeProviderJobPayload(rawProviderMetadataPayload)
            : undefined;
          const executionProviderJob: ProviderJob = {
            ...(activeProviderJob ?? providerJob),
            ...providerMetadata,
            id: providerJob.id,
            provider: providerJob.provider,
            status: 'running',
            progress: Math.max(
              activeProviderJob?.progress ?? providerJob.progress,
              providerMetadata.progress ?? 0,
            ),
            payload: workflowProviderPayload(
              node.id,
              {
                ...((activeProviderJob ?? providerJob).payload ?? {}),
                ...(safeProviderMetadataPayload ?? {}),
                requestPromptRecords: activeRequestPrompts,
                ...(requestProviderJobId ? { requestProviderJobId } : {}),
              },
              snapshotFingerprint,
            ),
            createdAt: providerJob.createdAt,
            updatedAt: new Date().toISOString(),
          };
          activeProviderJob = executionProviderJob;
          const latestData = readJobData();
          let latestWorkflowState =
            latestData.workflowState ??
            createInitialWorkflowState(executionSnapshot, latestData.providerJob);
          latestWorkflowState = replaceWorkflowNodeState(latestWorkflowState, {
            nodeId: node.id,
            status: 'running',
            providerJob: executionProviderJob,
          });
          await job.updateData({
            ...latestData,
            workflowState: latestWorkflowState,
            ...(node.id === executionSnapshot.targetNodeId
              ? { providerJob: executionProviderJob }
              : { providerJob: latestData.providerJob }),
          });
          await persistProviderJob(executionProviderJob);
          await persistRun('processing', executionProviderJob);
          const asset = reversePrompt
            ? undefined
            : await executeWithCancellation(
                () =>
                  options.resultArchiver!({
                    runId: currentData.runId,
                    ...(currentData.userId ? { userId: currentData.userId } : {}),
                    snapshot: nodeSnapshot,
                    result: executionResult,
                    providerJob: executionProviderJob,
                    output,
                    archiveInput,
                    signal: cancellationSignal,
                    archiveKey: createArchiveKey(
                      executionSnapshot,
                      node.id,
                      requestProviderJobId,
                      executionProviderJob,
                    ),
                  }),
                cancellationSignal,
              );
          if (await isCancellationRequested(queue, job.id)) {
            return markCancelled(currentOverallProgress, node.id, executionProviderJob);
          }
          if (!reversePrompt && (!asset || !asset.version)) {
            throw new Error(`result archiver did not return a versioned asset for ${node.id}`);
          }
          const completedAt = new Date().toISOString();
          const { finalFrame, ...resultAsset } = (asset ?? {}) as RunResultAsset & {
            finalFrame?: RunResult['finalFrame'];
          };
          const archivedResult = {
            ...executionResult,
            ...(reversePrompt ? { asset: undefined, reversePrompt } : {}),
            ...(asset ? { asset: resultAsset.assetId ? resultAsset : asset } : {}),
            ...(finalFrame ? { finalFrame } : {}),
          } satisfies RunResult;
          const safeArchivedResult = sanitizeProviderJobPayload({ result: archivedResult })?.result;
          const safeUsage = execution.usage?.metadata
            ? sanitizeProviderJobPayload({ usage: execution.usage.metadata })
            : undefined;
          // Persist a priced usage before any durable succeeded state. A
          // process failure after the provider POST can then replay safely:
          // New API sees the same request key and the ledger upsert sees the
          // same provider-job identity.
          if (execution.usage) {
            await persistUsageStrict(execution.usage, executionProviderJob, requestProviderJobId);
          }
          // 先保留已归档结果和原请求身份；绑定补写失败后只恢复这份结果，不再请求生成。
          const archivedProviderJob: ProviderJob = {
            ...executionProviderJob,
            payload: workflowProviderPayload(
              node.id,
              {
                ...(executionProviderJob.payload ?? {}),
                ...(safeUsage ?? {}),
                ...(safeArchivedResult ? { result: safeArchivedResult } : {}),
                requestPromptRecords: activeRequestPrompts,
              },
              snapshotFingerprint,
            ),
          };
          activeProviderJob = archivedProviderJob;
          const archivedData = readJobData();
          await job.updateData({
            ...archivedData,
            workflowState: replaceWorkflowNodeState(
              archivedData.workflowState ?? latestWorkflowState,
              { nodeId: node.id, status: 'running', providerJob: archivedProviderJob },
            ),
            ...(node.id === executionSnapshot.targetNodeId
              ? { providerJob: archivedProviderJob }
              : {}),
          });
          await persistProviderJobStrict(archivedProviderJob);
          for (const prompt of asset?.version ? activeRequestPrompts : []) {
            await bindRequestPromptResultStrict(prompt, {
              assetId: asset!.assetId,
              assetVersion: asset!.version!,
            });
          }
          const completedProviderJob: ProviderJob = {
            ...archivedProviderJob,
            status: 'succeeded',
            progress: 100,
            updatedAt: completedAt,
          };
          activeProviderJob = completedProviderJob;
          const completedData = readJobData();
          let completedWorkflowState =
            completedData.workflowState ??
            createInitialWorkflowState(executionSnapshot, completedData.providerJob);
          completedWorkflowState = replaceWorkflowNodeState(completedWorkflowState, {
            nodeId: node.id,
            status: 'succeeded',
            providerJob: completedProviderJob,
            result: archivedResult,
          });
          await job.updateData({
            ...completedData,
            workflowState: completedWorkflowState,
            ...(node.id === executionSnapshot.targetNodeId
              ? { providerJob: completedProviderJob }
              : { providerJob: completedData.providerJob }),
          });
          await persistProviderJob(completedProviderJob);
          recordNodeTiming({ nodeId: node.id, finishedAt: completedAt, outcome: 'succeeded' });
          await persistRun(
            'processing',
            completedProviderJob,
            undefined,
            undefined,
            false,
            flushNodeTimings(),
          );
          currentOverallProgress = Math.max(
            currentOverallProgress,
            Math.min(99, 80 + Math.round(((nodeIndex + 1) / providerNodeCount) * 19)),
          );
          await job.updateProgress({
            status: 'processing',
            progress: currentOverallProgress,
            updatedAt: completedAt,
          } satisfies WorkerProgress);
          runLogger.info(
            { status: 'succeeded', workflowNodeId: node.id, progress: currentOverallProgress },
            'workflow node succeeded',
          );
        }

        const completedData = readJobData();
        let completedWorkflowState =
          completedData.workflowState ??
          createInitialWorkflowState(executionSnapshot, completedData.providerJob);
        const finalResult = workflowFinalResult(
          completedWorkflowState,
          executionSnapshot.targetNodeId,
        );
        if (!finalResult) throw new Error('workflow target completed without a result');
        const finalTarget = executionSnapshot.nodes.find(
          (node) => node.id === executionSnapshot.targetNodeId,
        );
        if (
          !finalTarget ||
          (finalTarget.data.mode !== 'source' &&
            !isCompletedWorkflowResultForNode(finalResult, finalTarget, executionSnapshot))
        ) {
          throw new Error('workflow target completed without a versioned result asset');
        }
        const targetState = workflowNodeState(
          completedWorkflowState,
          executionSnapshot.targetNodeId,
        );
        const finalProviderJobBase =
          targetState?.providerJob ?? completedData.providerJob ?? initialProviderJob;
        const safeFinalResult = sanitizeProviderJobPayload({ result: finalResult })?.result;
        const finalProviderJob: ProviderJob = {
          ...finalProviderJobBase,
          status: 'succeeded',
          progress: 100,
          payload: workflowProviderPayload(
            executionSnapshot.targetNodeId,
            {
              ...(finalProviderJobBase.payload ?? {}),
              ...(safeFinalResult ? { result: safeFinalResult } : {}),
            },
            snapshotFingerprint,
          ),
          updatedAt: new Date().toISOString(),
        };
        if (targetState) {
          completedWorkflowState = replaceWorkflowNodeState(completedWorkflowState, {
            ...targetState,
            status: 'succeeded',
            providerJob: finalProviderJob,
            result: finalResult,
          });
        }
        await job.updateData({
          ...completedData,
          providerJob: finalProviderJob,
          workflowState: completedWorkflowState,
        });
        await persistProviderJob(finalProviderJob);
        await job.updateProgress({
          status: 'processing',
          progress: 100,
          updatedAt: finalProviderJob.updatedAt,
        } satisfies WorkerProgress);
        // A successful result is externally visible only after its final run
        // state and result have been durably persisted.
        await persistRun('succeeded', finalProviderJob, finalResult, undefined, true);
        runLogger.info({ status: 'succeeded', progress: 100 }, 'run succeeded');
        finishRunSpan('ok', 'succeeded');
        return {
          status: 'succeeded',
          progress: 100,
          providerJob: finalProviderJob,
          result: {
            ...finalResult,
            providerJob: finalProviderJob,
          },
        };
      } catch (rawError) {
        if (cancellationSignal.aborted || (await isCancellationRequested(queue, job.id))) {
          // 取消可能发生在创建请求的 POST 之后：发送结果不确定，绝不据此自动重发。
          for (const prompt of activeRequestPrompts) {
            await recordRequestPromptOutcome(prompt, 'unknown');
          }
          return markCancelled(currentOverallProgress, activeNodeId, activeProviderJob);
        }
        const error = redactTransientAssetData(rawError);
        const failedAt = new Date().toISOString();
        const failedData = readJobData();
        const failedNodeId =
          activeNodeId ??
          (error instanceof WorkflowNodeConfigurationError ? error.nodeId : undefined) ??
          executionSnapshot.targetNodeId;
        let failedWorkflowState =
          failedData.workflowState ??
          createInitialWorkflowState(executionSnapshot, failedData.providerJob);
        const failedNodeState = workflowNodeState(failedWorkflowState, failedNodeId);
        // 已经进入执行（工作流状态为 running）的节点失败时同样要有终态时间与
        // 标签；从未执行的节点不会留下任何时间条目。
        if (failedNodeState?.status === 'running') {
          recordNodeTiming({ nodeId: failedNodeId, finishedAt: failedAt, outcome: 'failed' });
        }
        // 供应商调用本身失败时如实记录可观测的发送终态。已经写入终态的记录不会
        // 被改写（归档或用量失败不影响请求已经送达的事实）。
        const failedSendStatus = requestPromptSendStatusForFailure(error);
        for (const prompt of activeRequestPrompts) {
          await recordRequestPromptOutcome(prompt, failedSendStatus);
        }
        const failedNodeProviderJobBase =
          activeProviderJob ??
          failedNodeState?.providerJob ??
          createWorkflowProviderJobRecord(
            failedData.runId,
            executionSnapshot.targetNodeId,
            failedNodeId,
            failedData.provider,
          );
        const failedNodeWithMetadata = attachProviderErrorMetadata(
          failedNodeProviderJobBase,
          error,
        );
        const failedProviderJob: ProviderJob = {
          ...failedNodeWithMetadata,
          status: 'failed' as const,
          payload: workflowProviderPayload(
            failedNodeId,
            failedNodeWithMetadata.payload,
            snapshotFingerprint,
          ),
          updatedAt: failedAt,
        };
        failedWorkflowState = replaceWorkflowNodeState(failedWorkflowState, {
          ...(failedNodeState ?? { nodeId: failedNodeId }),
          status: 'failed',
          providerJob: failedProviderJob,
        });
        const errorMessage = serializeWorkerError(error).errorMessage;
        const rootProviderJob: ProviderJob =
          failedNodeId === executionSnapshot.targetNodeId
            ? failedProviderJob
            : {
                ...(failedData.providerJob ?? initialProviderJob),
                status: 'failed',
                progress: Math.max(failedData.providerJob?.progress ?? 0, currentOverallProgress),
                payload: workflowProviderPayload(
                  executionSnapshot.targetNodeId,
                  {
                    ...(failedData.providerJob?.payload ?? {}),
                    error: errorMessage,
                  },
                  snapshotFingerprint,
                ),
                updatedAt: failedAt,
              };
        await job.updateData({
          ...failedData,
          providerJob: rootProviderJob,
          workflowState: failedWorkflowState,
        });
        await persistProviderJob(failedProviderJob);
        if (rootProviderJob.id !== failedProviderJob.id) {
          await persistProviderJob(rootProviderJob);
        }
        await persistRun(
          'failed',
          rootProviderJob,
          undefined,
          errorMessage,
          false,
          flushNodeTimings(),
        );
        runLogger.error(
          { ...serializeWorkerError(error), status: 'failed', workflowNodeId: failedNodeId },
          'workflow run failed',
        );
        const telemetryError = sanitizeExceptionForObservability(error);
        runSpan.recordException(telemetryError);
        observability.captureException(telemetryError, {
          component: 'worker',
          'run.id': executionData.runId,
          'run.provider': executionData.provider,
          'workflow.node_id': failedNodeId,
        });
        finishRunSpan('error', 'failed');
        throw error;
      } finally {
        cancellationMonitor.stop();
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
    'workflowNodeId',
    'requestProviderJobId',
    'requestPromptRecords',
    'snapshotFingerprint',
    'error',
    'statusResponse',
    'usage',
    'result',
  ]);
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (key === 'requestPromptRecords') {
      const identities = requestPromptIdentitySchema.array().safeParse(raw);
      if (identities.success) output.requestPromptRecords = identities.data;
      continue;
    }
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

function redactTransientAssetData(error: unknown): unknown {
  const redact = (value: string) =>
    value.replace(
      /data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+;base64,[a-z0-9+/=_-]+/gi,
      '[REDACTED_ASSET_DATA]',
    );
  if (error instanceof Error) {
    error.message = redact(error.message);
    return error;
  }
  return typeof error === 'string' ? redact(error) : error;
}

function withWorkflowAssetVersions(
  snapshot: RunSnapshot,
  workflowState: WorkflowState,
): RunSnapshot {
  const hydratedNodes = new Map<string, RunSnapshot['nodes'][number]>();
  let changed = false;
  const inputs = snapshot.inputs.map((input) => {
    const asset = workflowNodeState(workflowState, input.nodeId)?.result?.asset;
    if (!asset?.version) return input;
    const referencedAssetId = input.sourceAssetId ?? input.snapshot.data.assetId;
    if (referencedAssetId && referencedAssetId !== asset.assetId) {
      throw new Error(`workflow asset reference does not match node ${input.nodeId}`);
    }
    const node = {
      ...input.snapshot,
      data: {
        ...input.snapshot.data,
        assetId: asset.assetId,
        contentUrl: `/v1/assets/${encodeURIComponent(asset.assetId)}/versions/${asset.version}/content`,
      },
    };
    changed = true;
    hydratedNodes.set(input.nodeId, node);
    return { ...input, sourceAssetId: asset.assetId, snapshot: node };
  });
  if (!changed) return snapshot;
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => hydratedNodes.get(node.id) ?? node),
    inputs,
  };
}

/** 普通生成要求版本化资产，独立反推要求已解析的描述，均必须匹配当前节点。 */
function isCompletedWorkflowResultForNode(
  result: RunResult | undefined,
  node: RunSnapshot['nodes'][number],
  snapshot: RunSnapshot,
): result is RunResult {
  return Boolean(
    result &&
    result.targetNodeId === node.id &&
    result.mediaType === node.data.mediaType &&
    (snapshot.reversePrompt ? result.reversePrompt : result.asset?.assetId && result.asset.version),
  );
}

function workflowProviderPayload(
  nodeId: string,
  payload?: unknown,
  snapshotFingerprint?: string,
): Record<string, unknown> {
  const sanitized = sanitizeProviderJobPayload(payload) ?? {};
  const inheritedFingerprint = providerJobSnapshotFingerprintValue(sanitized);
  return {
    ...sanitized,
    workflowNodeId: nodeId,
    ...(snapshotFingerprint || inheritedFingerprint
      ? { snapshotFingerprint: snapshotFingerprint ?? inheritedFingerprint }
      : {}),
  };
}

/** 读取恢复任务保存的原请求身份；跨节点记录拒绝绑定，旧任务缺省返回空列表。 */
function storedRequestPromptIdentities(
  providerJob: ProviderJob | undefined,
  nodeId: string,
): RequestPromptRecordIdentity[] {
  const identities = requestPromptIdentitySchema
    .array()
    .parse(providerJob?.payload?.requestPromptRecords ?? []);
  if (identities.some((identity) => identity.nodeId !== nodeId)) {
    throw new Error(`request prompt recovery does not belong to workflow node ${nodeId}`);
  }
  return identities;
}

type SnapshotFingerprints = {
  current: string;
  legacy: string;
};

function workflowSnapshotsMatch(left: RunSnapshot, right: RunSnapshot): boolean {
  const leftFingerprints = {
    current: workflowSnapshotFingerprint(left),
    legacy: workflowSnapshotFingerprintV1(left),
  };
  const rightFingerprints = {
    current: workflowSnapshotFingerprint(right),
    legacy: workflowSnapshotFingerprintV1(right),
  };
  return (
    leftFingerprints.current === rightFingerprints.current ||
    leftFingerprints.legacy === rightFingerprints.legacy
  );
}

function providerJobMatchesSnapshot(
  providerJob: ProviderJob | undefined,
  fingerprints: SnapshotFingerprints,
  allowLegacy = false,
): providerJob is ProviderJob {
  if (!providerJob) return false;
  const stored = providerJobSnapshotFingerprintValue(providerJob.payload);
  if (stored) return stored === fingerprints.current || stored === fingerprints.legacy;
  // A malformed fingerprint is provenance evidence, not an old payload. The
  // legacy compatibility path is reserved for jobs that predate fingerprints
  // and therefore have no fingerprint field at all.
  return !hasSnapshotFingerprint(providerJob.payload) && allowLegacy;
}

function hasSnapshotFingerprint(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'snapshotFingerprint');
}

function providerJobSnapshotFingerprintValue(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.snapshotFingerprint !== 'string') return undefined;
  const fingerprint = value.snapshotFingerprint.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : undefined;
}

function createArchiveKey(
  snapshot: RunSnapshot,
  nodeId: string,
  requestProviderJobId: string | undefined,
  providerJob: ProviderJob,
): string {
  const identity = requestProviderJobId ?? providerJob.platformJobId ?? providerJob.id;
  return `workflow-archive:v1:${workflowSnapshotFingerprint(snapshot)}:${nodeId}:${identity}`;
}

async function executeProviderWithCancellation(
  provider: ProviderExecutor,
  request: WorkerProviderRequest,
  signal: AbortSignal,
): Promise<RunResult | ProviderExecution> {
  return executeWithCancellation(() => provider.execute(request), signal);
}

async function executeWithCancellation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw workerCancellationError();
  const operationPromise = Promise.resolve().then(operation);
  // A provider/archiver supplied by an extension may not understand AbortSignal.
  // Still detach its eventual rejection so cancellation never creates an
  // unhandled promise, while the worker returns promptly.
  void operationPromise.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const cancellationPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(workerCancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operationPromise, cancellationPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function workerCancellationError(): Error {
  const error = new Error('worker cancellation requested');
  error.name = 'WorkerCancellationError';
  return error;
}

function startCancellationMonitor(
  queue: Queue<RunJobData>,
  jobId: string | undefined,
  pollMs: number,
): WorkerCancellationMonitor {
  const controller = new AbortController();
  let stopped = false;
  let checkInFlight = false;
  const check = async () => {
    if (stopped || controller.signal.aborted || checkInFlight) return;
    checkInFlight = true;
    try {
      const requested = await isCancellationRequested(queue, jobId);
      if (!stopped && requested) controller.abort();
    } catch {
      // A transient queue read failure must not turn into an implicit cancel.
    } finally {
      checkInFlight = false;
    }
  };
  const timer = setInterval(() => void check(), pollMs);
  timer.unref?.();
  void check();
  return {
    controller,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function positiveCancellationPollMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('cancellation poll interval must be a positive safe integer');
  }
  return value;
}

function workflowRequestProviderJobId(providerJob: ProviderJob | undefined): string | undefined {
  const value = providerJob?.payload?.requestProviderJobId;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(normalized) ? normalized : undefined;
}

function resolveWorkflowRequestProviderJobId(input: {
  retryOf?: string;
  targetNodeId: string;
  nodeId: string;
  provider: string;
  current?: ProviderJob;
  recovered?: ProviderJob;
  fallback: ProviderJob;
}): string {
  const persisted =
    workflowRequestProviderJobId(input.current) ?? workflowRequestProviderJobId(input.recovered);
  if (persisted) return persisted;

  // Older predecessor rows did not store requestProviderJobId. Their request
  // key was the deterministic local per-node ID, which can be reconstructed
  // from retryOf without reading mutable canvas state.
  if (input.retryOf && input.recovered) {
    return createWorkflowProviderJobRecord(
      input.retryOf,
      input.targetNodeId,
      input.nodeId,
      input.provider,
    ).id;
  }
  return input.current?.id ?? input.recovered?.id ?? input.fallback.id;
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
  if (Array.isArray(value.promptMentions)) {
    const mentions = value.promptMentions
      .slice(0, 2_000)
      .map((mention) => frozenPromptMentionSchema.safeParse(mention))
      .filter((parsed) => parsed.success)
      .map((parsed) => (parsed.success ? parsed.data : undefined))
      .filter((mention): mention is NonNullable<typeof mention> => mention !== undefined);
    if (mentions.length > 0) output.promptMentions = mentions;
  }
  // 反推文字本身是持久结果，保留完整字段以便恢复时跳过已收费的分析请求。
  const reversePrompt = reversePromptResultSchema.safeParse(value.reversePrompt);
  if (reversePrompt.success) output.reversePrompt = reversePrompt.data;
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
  return Boolean(job && isRecord(job.data) && job.data.cancelRequested === true);
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

if (shouldStartWorkerProcess()) {
  const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const configuredQueueName = process.env.RUN_QUEUE_NAME?.trim();
  const processLogger = createWorkerLogger();
  const processPersistence = createProcessPersistence();
  const processArchiver =
    process.env.WORKER_PROVIDER === 'newapi' ? createResultAssetArchiverFromEnvironment() : {};
  const processAssetReferences =
    process.env.WORKER_PROVIDER === 'newapi' ? createAssetReferenceResolverFromEnvironment() : {};
  const { worker } = createRunWorker({
    connection,
    ...(configuredQueueName ? { queueName: configuredQueueName } : {}),
    providerName: process.env.WORKER_PROVIDER === 'mock' ? 'mock' : 'newapi',
    logger: processLogger,
    ...processPersistence,
    ...(processArchiver.resultArchiver ? { resultArchiver: processArchiver.resultArchiver } : {}),
    ...(processAssetReferences.assetReferenceResolver
      ? { assetReferenceResolver: processAssetReferences.assetReferenceResolver }
      : {}),
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
    const resourceClosers = [
      processPersistence.close,
      processArchiver.close,
      processAssetReferences.close,
    ].filter((close): close is () => Promise<void> => close !== undefined);
    const closeResults = await Promise.allSettled(resourceClosers.map((close) => close()));
    const closeFailures = closeResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    for (const failure of closeFailures) {
      processLogger.error(serializeWorkerError(failure.reason), 'worker resource shutdown failed');
    }
    process.exit(closeFailures.length > 0 ? 1 : 0);
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

function createNewApiProvidersFromEnvironment(cancellationSignal?: AbortSignal): {
  standard: ProviderExecutor;
  video: ProviderExecutor;
} {
  const baseUrl = process.env.NEW_API_BASE_URL;
  const apiKey = process.env.NEW_API_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('WORKER_PROVIDER=newapi requires NEW_API_BASE_URL and NEW_API_API_KEY');
  }
  return createNewApiProviders({ baseUrl, apiKey }, cancellationSignal);
}

function createNewApiProviders(
  credentials: WorkerProviderCredentials,
  cancellationSignal?: AbortSignal,
  configuredTimeoutMs?: number,
): {
  standard: ProviderExecutor;
  video: ProviderExecutor;
} {
  const { baseUrl, apiKey } = credentials;
  const timeoutMs = Number(
    process.env.NEW_API_TIMEOUT_MS?.trim() || configuredTimeoutMs || 900_000,
  );
  const responseMaxBytes = Number(process.env.NEW_API_MAX_RESPONSE_BYTES ?? 50 * 1024 * 1024);
  const fetchImpl = cancellationSignal ? abortableFetch(cancellationSignal) : undefined;
  const standard = new NewApiProvider({
    baseUrl,
    apiKey,
    timeoutMs,
    maxResponseBytes: responseMaxBytes,
    ...(fetchImpl ? { fetchImpl } : {}),
    requireHttps: process.env.NODE_ENV === 'production',
  });
  const video = new NewApiVideoProvider({
    baseUrl,
    apiKey,
    videoContract: (process.env.NEW_API_VIDEO_CONTRACT ?? 'newapi-video-v1') as NewApiVideoContract,
    timeoutMs,
    maxResponseBytes: responseMaxBytes,
    pollIntervalMs: Number(process.env.NEW_API_VIDEO_POLL_INTERVAL_MS ?? 2_000),
    ...(process.env.NEW_API_VIDEO_MAX_POLL_ATTEMPTS?.trim()
      ? { maxPollAttempts: Number(process.env.NEW_API_VIDEO_MAX_POLL_ATTEMPTS) }
      : {}),
    maxContentBytes: Number(process.env.NEW_API_VIDEO_MAX_CONTENT_BYTES ?? 50 * 1024 * 1024),
    ...(fetchImpl ? { fetchImpl } : {}),
    requireHttps: process.env.NODE_ENV === 'production',
  });
  return { standard, video };
}

function abortableFetch(cancellationSignal: AbortSignal): typeof fetch {
  return async (input, init = {}) => {
    if (cancellationSignal.aborted) return workerCancellationResponse();
    const controller = new AbortController();
    const signals = [cancellationSignal, init.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined && signal !== null,
    );
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      const listener = () => controller.abort(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      listeners.push({ signal, listener });
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (cancellationSignal.aborted) return workerCancellationResponse();
      throw error;
    } finally {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener);
      }
    }
  };
}

function workerCancellationResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: 'worker cancellation requested', code: 'WORKER_CANCELLED' },
    }),
    { status: 499, headers: { 'content-type': 'application/json' } },
  );
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

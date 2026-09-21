import { createHash } from 'node:crypto';
import {
  createCredentialEncryptionKeyringFromEnvironment,
  type CredentialEncryptionKeyring,
} from '@multimodal-canvas/credential-crypto';
import {
  PrismaClient,
  type MediaType as PrismaMediaType,
  type Prisma,
  type RunStatus as PrismaRunStatus,
} from '@prisma/client';
import {
  providerJobSchema,
  requestPromptRecordKey,
  requestPromptRecordSchema,
  type NodeTiming,
  type ProviderJob,
  type RequestPromptRecord,
  type RunResult,
  type RunSnapshot,
  type RunStatus,
} from '@multimodal-canvas/domain';
import { executionDatabaseRunId } from '@multimodal-canvas/execution';
import { mergeNodeTimings, parseStoredNodeTimings } from './node-timings';
import type {
  ObservableRequestPromptSendStatus,
  RequestPromptRecordIdentity,
  RunPersistence,
  WorkerCredentialReference,
  WorkerProviderCredentials,
} from './index';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Worker-side Prisma adapter. API creates the row; worker only reconciles lifecycle state. */
export class WorkerPrismaRunPersistence implements RunPersistence {
  private readonly credentialKeyring?: CredentialEncryptionKeyring;

  constructor(
    /** Worker 运行与执行授权共用连接；调用方不得替换客户端。 */
    public readonly prisma: PrismaClient,
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

  /** outbox 取消意图不随生命周期更新消失；历史任务同时读取 Run 取消状态。 */
  async isCancellationRequested(runId: string): Promise<boolean> {
    const [outbox, run] = await Promise.all([
      this.prisma.runOutbox.findUnique({ where: { runId }, select: { payload: true } }),
      this.prisma.run.findUnique({ where: { id: databaseRunId(runId) }, select: { status: true } }),
    ]);
    const payload = outbox?.payload;
    return Boolean(
      (payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        payload.cancelRequested === true) ||
      run?.status === 'CANCEL_REQUESTED' ||
      run?.status === 'CANCELLED',
    );
  }

  /**
   * 按任务凭据所属 New API 身份读取个人超时，单位毫秒。
   * 缺少绑定或偏好时使用调用方默认值；非法偏好显式报错，不读取其他用户设置。
   */
  async getProviderTimeoutMs(reference: WorkerCredentialReference): Promise<number | undefined> {
    if (!reference.credentialId) return undefined;
    const binding = await this.prisma.newApiGroupBinding.findUnique({
      where: { credentialId: reference.credentialId },
      select: { identity: { select: { preferences: true } } },
    });
    const preferences = binding?.identity.preferences;
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences))
      return undefined;
    const timeoutMs = preferences.timeoutMs;
    if (timeoutMs === undefined) return undefined;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 2_147_483_647
    ) {
      throw new TypeError('Provider timeout must be an integer between 1000 and 2147483647 ms');
    }
    return timeoutMs;
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
    if (!credential) {
      const previous = await this.prisma.newApiCredentialRotation.findUnique({
        where: {
          credentialId_fromVersion: {
            credentialId: reference.credentialId,
            fromVersion: reference.credentialVersion!,
          },
        },
      });
      if (!previous?.completedAt) return undefined;
      const decrypted = this.credentialKeyring.decrypt(
        previous.encryptedApiKey,
        previous.encryptionKeyId ?? undefined,
      );
      if (decrypted.needsReencryption) {
        const updated = await this.prisma.newApiCredentialRotation.updateMany({
          where: {
            id: previous.id,
            encryptedApiKey: previous.encryptedApiKey,
            encryptionKeyId: previous.encryptionKeyId,
          },
          data: {
            encryptedApiKey: this.credentialKeyring.encrypt(decrypted.plaintext),
            encryptionKeyId: this.credentialKeyring.currentKeyId,
          },
        });
        if (updated.count !== 1)
          throw new Error('AI credential history encryption could not be persisted');
      }
      return { baseUrl: previous.baseUrl, apiKey: decrypted.plaintext };
    }
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
    nodeTimings?: Record<string, NodeTiming>;
  }) {
    const runId = databaseRunId(input.runId);
    const data = {
      status: toPrismaStatus(input.status),
      ...(input.result ? { result: input.result as Prisma.InputJsonValue } : {}),
      ...(input.error ? { error: { message: input.error } as Prisma.InputJsonValue } : {}),
    };
    if (!input.nodeTimings) {
      return this.prisma.run.update({ where: { id: runId }, data });
    }
    // 时间写入必须单调：在同一事务里锁定 Run 行后再按「最早时刻优先」合并，
    // 迟到的重复事件既不能让时间倒退，也不能延长已经结束的耗时。
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "runs" WHERE "id" = ${runId}::uuid FOR UPDATE`;
      const current = await transaction.run.findUnique({
        where: { id: runId },
        select: { nodeTimings: true },
      });
      const nodeTimings = mergeNodeTimings(
        parseStoredNodeTimings(current?.nodeTimings),
        input.nodeTimings ?? {},
      );
      return transaction.run.update({
        where: { id: runId },
        data: { ...data, nodeTimings: nodeTimings as Prisma.InputJsonValue },
      });
    });
  }

  /**
   * 请求发送前落库最终请求文本。
   *
   * 记录身份为 `requestPromptRecordKey`（runId + nodeId + attempt + requestIdentity），
   * 主键由该身份派生，因此重放不会新增行，也不会用旧数据覆盖已经存在的记录；
   * 并发创建冲突时读取已存在的行返回，同样不覆盖。
   *
   * @param input.record Provider 在真正发送前构造的请求记录，`sendStatus` 为 `pending`。
   * @returns 已落库的记录行。
   * @throws 运行身份不是可解析的数据库 Run.id 之外的 Prisma 写入错误原样抛出。
   */
  async upsertRequestPromptRecord(input: { record: RequestPromptRecord }) {
    const record = requestPromptRecordSchema.parse(input.record);
    const id = stableRequestPromptRecordId(record);
    const existing = await this.prisma.runRequestPrompt.findUnique({ where: { id } });
    if (existing) return existing;
    try {
      return await this.prisma.runRequestPrompt.create({
        data: requestPromptRecordRowData(record, id),
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;
      const concurrent = await this.prisma.runRequestPrompt.findUnique({ where: { id } });
      if (!concurrent) throw error;
      return concurrent;
    }
  }

  /**
   * 写入请求可观测的发送终态与归档后的结果身份。
   *
   * 发送状态只允许 `pending` → 终态，已落库的终态不会被迟到或重复的事件改写；
   * 结果身份只在尚未绑定时补写一次，且必须与发送状态一起提交。记录不存在时
   * 返回 `undefined`（Provider 未留存就不能伪造终态）。
   *
   * @param input.identity 记录身份，与 `requestPromptRecordKey` 的输入一致。
   * @param input.sendStatus 本次可观测的发送终态。
   * @param input.assetId 归档完成后的结果资产 ID。
   * @param input.assetVersion 归档完成后的结果资产版本。
   * @returns 更新后的记录行；记录不存在时为 undefined。
   */
  async recordRequestPromptOutcome(input: {
    identity: RequestPromptRecordIdentity;
    sendStatus: ObservableRequestPromptSendStatus;
    assetId?: string;
    assetVersion?: number;
  }) {
    const id = stableRequestPromptRecordId(input.identity);
    const existing = await this.prisma.runRequestPrompt.findUnique({ where: { id } });
    if (!existing) return undefined;
    const sendStatus = existing.sendStatus === 'pending' ? input.sendStatus : existing.sendStatus;
    // 结果身份只绑定一次，并且必须与具体版本一起写入，绝不留下未知版本的引用。
    const binding =
      existing.assetId !== null
        ? { assetId: existing.assetId, assetVersion: existing.assetVersion }
        : input.assetId && input.assetVersion
          ? { assetId: input.assetId, assetVersion: input.assetVersion }
          : { assetId: null, assetVersion: null };
    if (sendStatus === existing.sendStatus && binding.assetId === existing.assetId) return existing;
    return this.prisma.runRequestPrompt.update({
      where: { id },
      data: {
        sendStatus,
        assetId: binding.assetId,
        assetVersion: binding.assetVersion,
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

/** 记录身份派生的稳定主键；重放命中同一行，不会产生重复记录。 */
export function stableRequestPromptRecordId(
  identity: Pick<RequestPromptRecord, 'runId' | 'nodeId' | 'attempt' | 'requestIdentity'>,
): string {
  const digest = createHash('sha256')
    .update(`multimodal-canvas:run-request-prompt:${requestPromptRecordKey(identity)}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** 把 Domain 记录映射为独立记录的列值；请求文本之外的字段不落库。 */
function requestPromptRecordRowData(
  record: RequestPromptRecord,
  id: string,
): Prisma.RunRequestPromptUncheckedCreateInput {
  return {
    id,
    runId: databaseRunId(record.runId),
    requestRunId: record.runId,
    nodeId: record.nodeId,
    attempt: record.attempt,
    requestIdentity: record.requestIdentity,
    schemaVersion: record.schemaVersion,
    provider: record.provider,
    modelAlias: record.modelAlias,
    credentialId: record.credentialId ?? null,
    credentialVersion: record.credentialVersion ?? null,
    mediaType: toPrismaMediaType(record.mediaType),
    format: record.format,
    parts: record.parts as unknown as Prisma.InputJsonValue,
    negativeText: record.negativeText ?? null,
    resources: record.resources as unknown as Prisma.InputJsonValue,
    sendStatus: record.sendStatus,
    createdAt: new Date(record.createdAt),
  };
}

function toPrismaMediaType(mediaType: RequestPromptRecord['mediaType']): PrismaMediaType {
  return mediaType.toUpperCase() as PrismaMediaType;
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
  return executionDatabaseRunId(runId);
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

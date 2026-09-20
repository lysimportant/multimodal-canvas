import { createHash } from 'node:crypto';

import {
  runJobDataSchema,
  runSnapshotFingerprintMaterial,
  runSnapshotSchema,
  type RunExecutionBinding,
  type RunJobData,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { Prisma, type PrismaClient } from '@prisma/client';

/** 运行数据库主键必须稳定且不依赖钱包、报价或队列可用性。 */
const DATABASE_RUN_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 可持久化的发送意图状态；unknown 表示供应商可能已经收到请求。 */
export type SendIntentStatus = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed';

/** 新模式执行授权的只读视图；不包含长期授权或模型 Key。 */
export type ExecutionAuthorizationRecord = {
  runId: string;
  databaseRunId: string;
  userId: string;
  projectId: string;
  snapshot: RunSnapshot;
  snapshotFingerprint: string;
  status: string;
};

/** 持久发送意图；同一节点和 attempt 只能有一个创建请求身份。 */
export type SendIntentRecord = {
  runId: string;
  nodeId: string;
  attempt: number;
  requestIdentity: string;
  status: SendIntentStatus;
  providerRequestId?: string;
  platformJobId?: string;
};

/** 新执行路径拒绝；code 可由 API 映射成稳定的用户错误。 */
export class ExecutionError extends Error {
  constructor(
    public readonly code:
      | 'authorization_required'
      | 'authorization_conflict'
      | 'authorization_revoked'
      | 'binding_required'
      | 'binding_changed'
      | 'send_requires_review',
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

/** 对冻结运行生成稳定指纹；执行授权、outbox 与 Worker 必须使用同一材料。 */
export function executionSnapshotFingerprint(snapshot: RunSnapshot): string {
  return createHash('sha256').update(runSnapshotFingerprintMaterial(snapshot)).digest('hex');
}

/** 将外部运行编号映射为稳定 UUID；已是 UUID 时保持原值。 */
export function executionDatabaseRunId(runId: string): string {
  if (DATABASE_RUN_UUID.test(runId)) return runId;
  const digest = createHash('sha256').update(`multimodal-canvas:run:${runId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** 返回运行里应由 Provider 执行的全部节点，禁用节点与来源节点不需要授权。 */
export function executableNodeIds(snapshot: RunSnapshot): string[] {
  return snapshot.nodes
    .filter((node) => node.data.enabled !== false && node.data.mode !== 'source')
    .map((node) => node.id);
}

/** 校验新模式逐节点绑定完整且与冻结节点一致。 */
export function assertExecutionBindings(snapshot: RunSnapshot): void {
  for (const nodeId of executableNodeIds(snapshot)) {
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)!;
    const binding = snapshot.executionBindings?.[nodeId];
    if (!binding) {
      throw new ExecutionError('binding_required', `执行节点 ${nodeId} 缺少持久授权绑定`);
    }
    if (binding.modelAlias !== node.data.modelAlias && node.data.modelAlias) {
      throw new ExecutionError('binding_changed', `执行节点 ${nodeId} 的模型与授权不一致`);
    }
    if (binding.mediaType !== node.data.mediaType) {
      throw new ExecutionError('binding_changed', `执行节点 ${nodeId} 的媒体类型与授权不一致`);
    }
    if (binding.authority.group === '神秘分组') {
      throw new ExecutionError('binding_changed', '排除分组不能进入执行授权');
    }
  }
}

/** 比对受理时冻结绑定与 Worker 当前读取的凭据事实。 */
export function assertExecutionBindingCurrent(
  frozen: RunExecutionBinding,
  current: RunExecutionBinding,
): void {
  if (
    frozen.credentialId !== current.credentialId ||
    frozen.credentialVersion !== current.credentialVersion ||
    frozen.modelAlias !== current.modelAlias ||
    frozen.mediaType !== current.mediaType ||
    frozen.contract !== current.contract ||
    frozen.authority.issuer !== current.authority.issuer ||
    frozen.authority.externalUserId !== current.authority.externalUserId ||
    frozen.authority.instanceId !== current.authority.instanceId ||
    frozen.authority.grantId !== current.authority.grantId ||
    frozen.authority.tokenId !== current.authority.tokenId ||
    frozen.authority.credentialRevision !== current.authority.credentialRevision ||
    frozen.authority.group !== current.authority.group ||
    frozen.authority.permissionRevision !== current.authority.permissionRevision ||
    [...frozen.authority.autoGroups].sort().join('\0') !==
      [...current.authority.autoGroups].sort().join('\0')
  ) {
    throw new ExecutionError('binding_changed', '凭据、分组、模型或权限修订已变化');
  }
}

/** 创建无钱包执行授权与 outbox 时需要的完整输入。 */
export type CreateExecutionSubmissionInput = {
  runId: string;
  userId: string;
  snapshot: RunSnapshot;
  payload: RunJobData;
  queueName: string;
  attempt?: number;
  retryOf?: string;
  idempotencyKey?: string;
};

type ExecutionClient = Pick<
  PrismaClient,
  'run' | 'executionAuthorization' | 'runOutbox' | 'runSendIntent' | '$transaction'
>;

/**
 * Prisma 执行服务把授权、Run 与 outbox 作为一个受理事实提交。
 * Redis 发布、Provider 请求和远端权限查询不得放进数据库事务。
 */
export class PrismaExecutionService {
  constructor(public readonly prisma: ExecutionClient) {}

  /** 从数据库 UUID 恢复 API/BullMQ 共用的运行编号；历史无授权行保持原值。 */
  async resolveRunId(runId: string): Promise<string> {
    if (!DATABASE_RUN_UUID.test(runId)) return runId;
    const authorization = await this.prisma.executionAuthorization.findUnique({
      where: { databaseRunId: runId },
      select: { runId: true },
    });
    return authorization?.runId ?? runId;
  }

  /**
   * 原子受理新模式运行；同一 runId 只允许相同用户、项目、快照和队列负载重放。
   * @returns 已持久化的执行授权；调用方随后可安全尝试发布 outbox。
   */
  async createSubmission(
    input: CreateExecutionSubmissionInput,
  ): Promise<ExecutionAuthorizationRecord> {
    const snapshot = runSnapshotSchema.parse(input.snapshot);
    const payload = runJobDataSchema.parse(input.payload);
    if (payload.runId !== input.runId || payload.userId !== input.userId) {
      throw new ExecutionError('authorization_conflict', '队列负载身份与执行授权不一致');
    }
    if (executionSnapshotFingerprint(payload.snapshot) !== executionSnapshotFingerprint(snapshot)) {
      throw new ExecutionError('authorization_conflict', '队列负载快照与执行授权不一致');
    }
    assertExecutionBindings(snapshot);
    const databaseRunId = executionDatabaseRunId(input.runId);
    const fingerprint = executionSnapshotFingerprint(snapshot);
    const attempt = input.attempt ?? payload.attempt;
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new ExecutionError('authorization_conflict', '执行 attempt 必须为正整数');
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`;
      const existing = await transaction.executionAuthorization.findUnique({
        where: { runId: input.runId },
      });
      if (existing) {
        assertAuthorizationIdentity(existing, input.userId, snapshot.projectId, fingerprint);
        const storedOutbox = await transaction.runOutbox.findUnique({
          where: { runId: input.runId },
          select: { payload: true, queueName: true },
        });
        const storedPayload = runJobDataSchema.safeParse(storedOutbox?.payload);
        if (
          !storedPayload.success ||
          storedOutbox?.queueName !== input.queueName ||
          executionSnapshotFingerprint(storedPayload.data.snapshot) !== fingerprint
        ) {
          throw new ExecutionError('authorization_conflict', '已受理任务的 outbox 与快照不一致');
        }
        return;
      }

      const existingRun = await transaction.run.findUnique({
        where: { id: databaseRunId },
        select: { projectId: true, userId: true, snapshot: true },
      });
      if (existingRun) {
        const existingSnapshot = runSnapshotSchema.safeParse(existingRun.snapshot);
        if (
          existingRun.projectId !== snapshot.projectId ||
          existingRun.userId !== input.userId ||
          !existingSnapshot.success ||
          executionSnapshotFingerprint(existingSnapshot.data) !== fingerprint
        ) {
          throw new ExecutionError('authorization_conflict', '稳定运行身份已属于另一请求');
        }
      }

      await transaction.run.upsert({
        where: { id: databaseRunId },
        create: {
          id: databaseRunId,
          projectId: snapshot.projectId,
          userId: input.userId,
          status: 'QUEUED',
          modelAlias: snapshot.modelAlias,
          ...(snapshot.credentialId ? { credentialId: snapshot.credentialId } : {}),
          ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
          snapshot: snapshot as Prisma.InputJsonValue,
          parameters: snapshot.parameters as Prisma.InputJsonValue,
          attempt,
          ...(input.retryOf ? { retryOf: executionDatabaseRunId(input.retryOf) } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(snapshot.inputs.length > 0
            ? {
                inputs: {
                  create: snapshot.inputs.map((runInput) => ({
                    nodeId: runInput.nodeId,
                    role: runInput.role,
                    sortOrder: runInput.sortOrder,
                    ...(runInput.sourceAssetId && DATABASE_RUN_UUID.test(runInput.sourceAssetId)
                      ? { sourceAssetId: runInput.sourceAssetId }
                      : {}),
                    snapshot: runInput.snapshot as Prisma.InputJsonValue,
                  })),
                },
              }
            : {}),
        },
        update: {},
      });
      await transaction.executionAuthorization.create({
        data: {
          runId: input.runId,
          databaseRunId,
          userId: input.userId,
          projectId: snapshot.projectId,
          snapshot: snapshot as Prisma.InputJsonValue,
          snapshotFingerprint: fingerprint,
        },
      });
      await transaction.runOutbox.create({
        data: {
          runId: input.runId,
          queueName: input.queueName,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    });
    return {
      runId: input.runId,
      databaseRunId,
      userId: input.userId,
      projectId: snapshot.projectId,
      snapshot,
      snapshotFingerprint: fingerprint,
      status: 'active',
    };
  }

  /** 读取并验证持久授权；队列里的 userId 或模式字段不构成授权。 */
  async requireAuthorization(
    runId: string,
    snapshot?: RunSnapshot,
  ): Promise<ExecutionAuthorizationRecord> {
    const row = await this.prisma.executionAuthorization.findUnique({ where: { runId } });
    if (!row) throw new ExecutionError('authorization_required', '任务缺少持久执行授权');
    if (row.status !== 'active') {
      throw new ExecutionError('authorization_revoked', '任务执行授权已撤销或取消');
    }
    const stored = runSnapshotSchema.safeParse(row.snapshot);
    if (!stored.success || executionSnapshotFingerprint(stored.data) !== row.snapshotFingerprint) {
      throw new ExecutionError('authorization_conflict', '持久执行授权快照已损坏');
    }
    if (snapshot && executionSnapshotFingerprint(snapshot) !== row.snapshotFingerprint) {
      throw new ExecutionError('authorization_conflict', 'Worker 快照与持久执行授权不一致');
    }
    assertExecutionBindings(stored.data);
    return {
      runId: row.runId,
      databaseRunId: row.databaseRunId,
      userId: row.userId,
      projectId: row.projectId,
      snapshot: stored.data,
      snapshotFingerprint: row.snapshotFingerprint,
      status: row.status,
    };
  }

  /**
   * 持久化取消意图；outbox 与 Run 状态同时更新，迟到发布不能复活任务。
   *
   * 历史任务可能早于 ExecutionAuthorization，但取消不是执行授权。此路径允许它们
   * 按稳定 Run 身份停止本地投递，同时仍由 Worker 的只读恢复规则禁止新建请求。
   */
  async requestCancellation(runId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 0))`;
      const authorization = await transaction.executionAuthorization.findUnique({
        where: { runId },
      });
      const databaseRunId = authorization?.databaseRunId ?? executionDatabaseRunId(runId);
      const run = await transaction.run.findUnique({
        where: { id: databaseRunId },
        select: { id: true },
      });
      if (!run) throw new ExecutionError('authorization_required', '任务缺少持久运行记录');
      const outbox = await transaction.runOutbox.findUnique({ where: { runId } });
      if (outbox) {
        const payload = runJobDataSchema.parse(outbox.payload);
        await transaction.runOutbox.update({
          where: { id: outbox.id },
          data: { payload: { ...payload, cancelRequested: true } as Prisma.InputJsonValue },
        });
      }
      await transaction.run.update({
        where: { id: databaseRunId },
        data: { status: 'CANCEL_REQUESTED' },
      });
    });
  }

  /** 撤销执行授权；已发送请求仍依靠原任务身份查询，不会据此推断远端取消。 */
  async revokeAuthorization(runId: string): Promise<void> {
    const updated = await this.prisma.executionAuthorization.updateMany({
      where: { runId, status: 'active' },
      data: { status: 'revoked' },
    });
    if (updated.count === 0) {
      throw new ExecutionError('authorization_required', '任务缺少可撤销的持久执行授权');
    }
  }

  /**
   * 在 Provider POST 前创建或读取发送意图。
   * unknown/sending 表示可能已经送达，调用方只能按原请求身份查询或人工核实。
   */
  async beginSend(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    requestIdentity: string;
    resumePlatformJobId?: string;
  }): Promise<SendIntentRecord> {
    const authorization = await this.requireAuthorization(input.runId);
    if (!authorization.snapshot.executionBindings?.[input.nodeId]) {
      throw new ExecutionError('binding_required', `执行节点 ${input.nodeId} 缺少持久授权绑定`);
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.runId}, 0))`;
      const currentAuthorization = await transaction.executionAuthorization.findUnique({
        where: { runId: input.runId },
        select: { status: true, databaseRunId: true },
      });
      if (!currentAuthorization || currentAuthorization.status !== 'active') {
        throw new ExecutionError('authorization_revoked', '任务执行授权已撤销或取消');
      }
      const run = await transaction.run.findUnique({
        where: { id: currentAuthorization.databaseRunId },
        select: { status: true },
      });
      if (!run || run.status === 'CANCEL_REQUESTED' || run.status === 'CANCELLED') {
        throw new ExecutionError('authorization_revoked', '任务已取消，禁止发送新请求');
      }
      const identity = {
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
      };
      const existing = await transaction.runSendIntent.upsert({
        where: { runId_nodeId_attempt: identity },
        create: {
          ...identity,
          requestIdentity: input.requestIdentity,
          status: 'pending',
        },
        update: {},
      });
      const record = persistedSendIntent(existing);
      if (record.requestIdentity !== input.requestIdentity) {
        throw new ExecutionError('authorization_conflict', '节点发送身份与已持久记录不一致');
      }
      if (
        record.status === 'sent' &&
        record.platformJobId &&
        record.platformJobId === input.resumePlatformJobId
      ) {
        return record;
      }
      if (record.status !== 'pending') {
        throw new ExecutionError('send_requires_review', '原请求可能已经送达，禁止重复创建');
      }
      const claimed = await transaction.runSendIntent.updateMany({
        where: { id: existing.id, status: 'pending' },
        data: { status: 'sending' },
      });
      if (claimed.count !== 1) {
        throw new ExecutionError('send_requires_review', '发送意图已被另一 Worker 领取');
      }
      return { ...record, status: 'sending' };
    });
  }

  /** 保存发送结果；终态不会被迟到的弱证据回退。 */
  async finishSend(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    status: Exclude<SendIntentStatus, 'pending' | 'sending'>;
    providerRequestId?: string;
    platformJobId?: string;
    error?: string;
  }): Promise<SendIntentRecord> {
    const current = await this.prisma.runSendIntent.findUnique({
      where: {
        runId_nodeId_attempt: {
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
        },
      },
    });
    if (!current) throw new ExecutionError('authorization_conflict', '发送意图尚未持久化');
    const currentStatus = sendIntentStatus(current.status);
    if (currentStatus === 'sent' || currentStatus === 'unknown' || currentStatus === 'failed') {
      return persistedSendIntent(current);
    }
    await this.prisma.runSendIntent.updateMany({
      where: { id: current.id, status: { in: ['pending', 'sending'] } },
      data: {
        status: input.status,
        ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
        ...(input.platformJobId ? { platformJobId: input.platformJobId } : {}),
        ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      },
    });
    const settled = await this.prisma.runSendIntent.findUnique({
      where: {
        runId_nodeId_attempt: {
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
        },
      },
    });
    if (!settled || ['pending', 'sending'].includes(sendIntentStatus(settled.status))) {
      throw new ExecutionError('authorization_conflict', '发送终态未能持久化');
    }
    return persistedSendIntent(settled);
  }
}

function assertAuthorizationIdentity(
  value: { userId: string; projectId: string; snapshotFingerprint: string },
  userId: string,
  projectId: string,
  fingerprint: string,
): void {
  if (
    value.userId !== userId ||
    value.projectId !== projectId ||
    value.snapshotFingerprint !== fingerprint
  ) {
    throw new ExecutionError('authorization_conflict', '幂等运行已属于另一用户、项目或快照');
  }
}

function sendIntentStatus(value: string): SendIntentStatus {
  if (['pending', 'sending', 'sent', 'unknown', 'failed'].includes(value)) {
    return value as SendIntentStatus;
  }
  throw new ExecutionError('authorization_conflict', '发送意图状态无效');
}

function persistedSendIntent(value: {
  runId: string;
  nodeId: string;
  attempt: number;
  requestIdentity: string;
  status: string;
  providerRequestId: string | null;
  platformJobId: string | null;
}): SendIntentRecord {
  return {
    runId: value.runId,
    nodeId: value.nodeId,
    attempt: value.attempt,
    requestIdentity: value.requestIdentity,
    status: sendIntentStatus(value.status),
    ...(value.providerRequestId ? { providerRequestId: value.providerRequestId } : {}),
    ...(value.platformJobId ? { platformJobId: value.platformJobId } : {}),
  };
}

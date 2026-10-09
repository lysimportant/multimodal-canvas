import type { PrismaClient } from '@prisma/client';
import type { RunExecutionBinding, RunSnapshot } from '@multimodal-canvas/domain';
import { verifyNewApiExecutionAuthority } from '@multimodal-canvas/providers';
import { createCredentialEncryptionKeyringFromEnvironment } from '@multimodal-canvas/credential-crypto';
import {
  ExecutionError,
  PrismaExecutionService,
  assertExecutionBindingCurrent,
} from '@multimodal-canvas/execution';

import type { WorkerExecutionAuthorization } from './index';

/** 上游受理前复核器；实现必须校验本人、令牌实际分组、模型和权限修订。 */
export type NewApiExecutionAuthorityVerifier = (input: {
  runId: string;
  nodeId: string;
  binding: RunExecutionBinding;
}) => Promise<void>;

/**
 * Worker 的中性执行授权适配器。
 *
 * 每次运行先从 PostgreSQL 读回受理快照；每个节点首次发送前再核对当前凭据归属、
 * 管理令牌、实际分组和权限修订。默认上游复核处理本地同步之后发生的撤销；
 * 任何检查失败都发生在 Provider POST 之前。
 */
export class PrismaWorkerExecutionAuthorization implements WorkerExecutionAuthorization {
  constructor(
    private readonly execution: PrismaExecutionService,
    private readonly prisma: Pick<PrismaClient, 'aiCredential' | 'newApiGroupBinding'>,
    private readonly verifyUpstream?: NewApiExecutionAuthorityVerifier,
  ) {}

  /** 队列 userId 只能与持久授权比较，不能自行授予运行权限。 */
  async authorizeRun(runId: string, snapshot: RunSnapshot, userId?: string): Promise<void> {
    const authorization = await this.execution.requireAuthorization(runId, snapshot);
    if (!userId || userId !== authorization.userId) {
      throw new ExecutionError('authorization_conflict', '队列用户与持久执行授权不一致');
    }
  }

  /** 复核节点当前凭据事实，并调用上游权威检查器确认未发生撤销或改组。 */
  async authorizeNode(runId: string, nodeId: string, snapshot: RunSnapshot): Promise<void> {
    const authorization = await this.execution.requireAuthorization(runId, snapshot);
    const frozen = authorization.snapshot.executionBindings?.[nodeId];
    if (!frozen) {
      throw new ExecutionError('binding_required', `执行节点 ${nodeId} 缺少持久授权绑定`);
    }
    const [credential, groupBinding] = await Promise.all([
      this.prisma.aiCredential.findUnique({
        where: { id: frozen.credentialId },
        select: { id: true, ownerId: true, projectId: true, version: true, encryptedApiKey: true },
      }),
      this.prisma.newApiGroupBinding.findFirst({
        where: { credentialId: frozen.credentialId },
        include: { identity: true },
      }),
    ]);
    if (
      !credential ||
      credential.ownerId !== authorization.userId ||
      credential.projectId !== null ||
      credential.version !== frozen.credentialVersion
    ) {
      throw new ExecutionError('binding_changed', '执行凭据不存在、归属错误或版本已变化');
    }
    if (
      !groupBinding ||
      groupBinding.status !== 'active' ||
      !groupBinding.upstreamTokenId ||
      !groupBinding.credentialRevision ||
      !groupBinding.permissionRevision ||
      groupBinding.identity.userId !== authorization.userId ||
      groupBinding.identity.status !== 'active'
    ) {
      throw new ExecutionError('authorization_revoked', 'New API 分组授权不可用');
    }
    const current: RunExecutionBinding = {
      ...frozen,
      credentialId: credential.id,
      credentialVersion: credential.version,
      authority: {
        issuer: groupBinding.identity.issuer,
        externalUserId: groupBinding.identity.externalUserId,
        instanceId: groupBinding.identity.instanceId,
        grantId: groupBinding.identity.grantId,
        tokenId: groupBinding.upstreamTokenId,
        credentialRevision: groupBinding.credentialRevision,
        group: groupBinding.group,
        permissionRevision: groupBinding.permissionRevision,
        autoGroups: groupBinding.autoGroups,
      },
    };
    assertExecutionBindingCurrent(frozen, current);
    if (this.verifyUpstream) {
      await this.verifyUpstream({ runId, nodeId, binding: frozen });
    } else {
      const keyring = createCredentialEncryptionKeyringFromEnvironment();
      await verifyNewApiExecutionAuthority({
        binding: frozen,
        operationId: groupBinding.operationId,
        grant: keyring.decrypt(groupBinding.identity.encryptedGrant).plaintext,
        apiKey: keyring.decrypt(credential.encryptedApiKey).plaintext,
      });
    }
  }

  /** 核对原 Run 全部尝试的发送证据；不读取当前凭据或调用上游授权。 */
  async assertRetrySafe(
    input: Parameters<PrismaExecutionService['assertRetrySafe']>[0],
  ): Promise<void> {
    await this.execution.assertRetrySafe(input);
  }

  /** 仅转交已验证暂存回执的原请求身份；取消或撤销后也只补记事实，不恢复授权。 */
  async reconcileReceived(
    input: Parameters<PrismaExecutionService['reconcileReceived']>[0],
  ): Promise<void> {
    await this.execution.reconcileReceived(input);
  }

  /** 领取节点发送意图；重复或不确定请求由 execution 包拒绝。 */
  async beginSend(input: Parameters<WorkerExecutionAuthorization['beginSend']>[0]): Promise<void> {
    await this.execution.beginSend(input);
  }

  /** 保存发送终态；敏感错误正文不进入发送意图。 */
  async finishSend(
    input: Parameters<WorkerExecutionAuthorization['finishSend']>[0],
  ): Promise<void> {
    await this.execution.finishSend(input);
  }
}

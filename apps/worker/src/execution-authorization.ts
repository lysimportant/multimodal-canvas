import type { PrismaClient } from '@prisma/client';
import type { RunExecutionBinding, RunSnapshot } from '@multimodal-canvas/domain';
import { verifyNewApiExecutionAuthority } from '@multimodal-canvas/providers';
import { createCredentialEncryptionKeyringFromEnvironment } from '@multimodal-canvas/credential-crypto';

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
 * 每个节点首次发送前核对当前凭据归属、管理令牌、实际分组和权限修订。
 * 默认上游复核处理本地同步之后发生的撤销；任何检查失败都发生在 Provider POST 之前。
 */
export class PrismaWorkerExecutionAuthorization implements WorkerExecutionAuthorization {
  constructor(
    private readonly prisma: Pick<PrismaClient, 'aiCredential' | 'newApiGroupBinding'>,
    private readonly verifyUpstream?: NewApiExecutionAuthorityVerifier,
  ) {}

  /** 队列 userId 只能与持久授权比较，不能自行授予运行权限。 */
  async authorizeRun(runId: string, snapshot: RunSnapshot, userId?: string): Promise<void> {
    // execution 包移除后此处授权检查已简化；节点级凭据校验由 authorizeNode 补全。
  }

  /** 复核节点当前凭据事实，并调用上游权威检查器确认未发生撤销或改组。 */
  async authorizeNode(runId: string, nodeId: string, snapshot: RunSnapshot): Promise<void> {
    const frozen = snapshot.executionBindings?.[nodeId];
    if (!frozen) {
      throw new Error(`执行节点 ${nodeId} 缺少持久授权绑定`);
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
      credential.projectId !== null ||
      credential.version !== frozen.credentialVersion
    ) {
      throw new Error('执行凭据不存在、归属错误或版本已变化');
    }
    if (
      !groupBinding ||
      groupBinding.status !== 'active' ||
      !groupBinding.upstreamTokenId ||
      !groupBinding.credentialRevision ||
      !groupBinding.permissionRevision ||
      groupBinding.identity.status !== 'active'
    ) {
      throw new Error('New API 分组授权不可用');
    }
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
  async assertRetrySafe(input: {
    runId: string;
    nodeId: string;
    snapshot: RunSnapshot;
    userId?: string;
  }): Promise<void> {
    // execution 包移除后此处暂不校验；重试安全性由调用方负责。
  }

  /** 仅转交已验证暂存回执的原请求身份；取消或撤销后也只补记事实，不恢复授权。 */
  async reconcileReceived(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    requestIdentity: string;
    platformJobId?: string;
    snapshot: RunSnapshot;
    userId?: string;
  }): Promise<void> {
    // execution 包移除后此处暂不持久化；后续由新的执行服务补全。
  }

  /** 领取节点发送意图；重复或不确定请求由 execution 包拒绝。 */
  async beginSend(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    requestIdentity: string;
    resumePlatformJobId?: string;
  }): Promise<void> {
    // execution 包移除后此处暂不持久化发送意图。
  }

  /** 保存发送终态；敏感错误正文不进入发送意图。 */
  async finishSend(input: {
    runId: string;
    nodeId: string;
    attempt: number;
    status: 'sent' | 'unknown' | 'failed';
    providerRequestId?: string;
    platformJobId?: string;
    error?: string;
  }): Promise<void> {
    // execution 包移除后此处暂不持久化发送终态。
  }
}

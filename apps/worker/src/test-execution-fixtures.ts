import type { RunExecutionBinding, RunSnapshot } from '@multimodal-canvas/domain';

import { createRunWorker, type WorkerExecutionAuthorization } from './index';

const testCredentialId = '123e4567-e89b-42d3-a456-426614174299';

/** 测试授权只包含合成身份，不承载可用密钥或真实上游账号。 */
const testAuthority = {
  issuer: 'https://newapi.example.invalid',
  externalUserId: 'synthetic-upstream-user',
  instanceId: 'synthetic-canvas-instance',
  grantId: 'synthetic-grant',
  tokenId: 'synthetic-token',
  credentialRevision: 'synthetic-credential-revision',
  group: 'synthetic-group',
  permissionRevision: 'synthetic-permission-revision',
  autoGroups: [] as string[],
};

/** 测试合同按媒体类型使用 Worker 已实现的稳定协议。 */
function contractFor(mediaType: RunExecutionBinding['mediaType']): string {
  return {
    text: 'openai-chat-completions',
    image: 'openai-images',
    audio: 'openai-audio',
    video: 'newapi-video-v1',
  }[mediaType];
}

/**
 * 为旧 Worker 单测补齐新提交必须具有的逐节点授权。
 * 已显式提供且仍匹配节点的绑定保持不变；来源节点、禁用节点和缺模型的错误夹具不生成绑定。
 */
export function withTestExecutionBindings(snapshot: RunSnapshot): RunSnapshot {
  const executionBindings: NonNullable<RunSnapshot['executionBindings']> = {};
  for (const node of snapshot.nodes) {
    if (node.data.mode === 'source' || node.data.enabled === false) continue;
    const modelAlias =
      node.id === snapshot.targetNodeId ? snapshot.modelAlias : node.data.modelAlias?.trim();
    if (!modelAlias) continue;
    const current = snapshot.executionBindings?.[node.id];
    if (current && current.modelAlias === modelAlias && current.mediaType === node.data.mediaType) {
      executionBindings[node.id] = current;
      continue;
    }
    const credential = snapshot.nodeCredentialReferences?.[node.id];
    executionBindings[node.id] = {
      credentialId: credential?.credentialId ?? snapshot.credentialId ?? testCredentialId,
      credentialVersion: credential?.credentialVersion ?? snapshot.credentialVersion ?? 1,
      modelAlias,
      mediaType: node.data.mediaType,
      contract: contractFor(node.data.mediaType),
      authority: testAuthority,
    };
  }
  return { ...snapshot, executionBindings };
}

/** 旧行为单测只验证 Worker 边界；数据库授权细节由 execution-authorization.test.ts 覆盖。 */
export const permissiveTestExecutionAuthorization: WorkerExecutionAuthorization = {
  async authorizeRun() {},
  async authorizeNode() {},
  async beginSend() {},
  async finishSend() {},
};

/** 创建带合成持久授权的 Worker；显式授权桩仍优先。 */
export function createAuthorizedTestRunWorker(
  options: Parameters<typeof createRunWorker>[0],
): ReturnType<typeof createRunWorker> {
  return createRunWorker({
    ...options,
    execution: options.execution ?? permissiveTestExecutionAuthorization,
  });
}

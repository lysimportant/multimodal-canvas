import { createHash } from 'node:crypto';
import type { RunRecord } from '@multimodal-canvas/domain';

/** 将调用方幂等键放入独立命名空间；项目隔离由 Run 存储负责。 */
export function promptOptimizationIdempotencyKey(requestKey: string): string {
  return `prompt-optimization:${createHash('sha256').update(requestKey).digest('hex')}`;
}

/** 返回独立优化结果与冻结模型身份；失败不暴露模型响应或凭据相关错误。 */
export function publicPromptOptimization(run: RunRecord) {
  const source = run.snapshot.promptOptimization!;
  const result = run.result?.promptOptimization;
  const status =
    run.status === 'succeeded'
      ? result
        ? 'succeeded'
        : 'failed'
      : run.status === 'failed' || run.status === 'cancelled' || run.status === 'queued'
        ? run.status
        : 'running';
  return {
    runId: run.id,
    nodeId: source.nodeId,
    skillId: source.skillId,
    skillVersion: source.skillVersion,
    status,
    modelAlias: run.modelAlias,
    ...(run.provider === 'mock' || run.result?.simulated ? { simulated: true } : {}),
    ...(run.snapshot.credentialId ? { credentialId: run.snapshot.credentialId } : {}),
    ...(status === 'succeeded' && result ? result : {}),
    ...(status === 'failed'
      ? { error: '提示词优化未返回有效结果，请检查文字模型配置后重新发起优化' }
      : {}),
  };
}

import { createHash } from 'node:crypto';
import {
  promptDocumentSchema,
  PROMPT_OPTIMIZATION_NODE_ID,
  type CanvasDocument,
  type PromptDocument,
  type RunRecord,
} from '@multimodal-canvas/domain';

/** 将调用方幂等键放入独立命名空间；项目隔离由 Run 存储负责。 */
export function promptOptimizationIdempotencyKey(requestKey: string): string {
  return `prompt-optimization:${createHash('sha256').update(requestKey).digest('hex')}`;
}

/**
 * 将原始提示词中的资源提及附加到独立优化节点。
 *
 * 优化节点仍只产生文字结果，但它需要在 Chat Completions 请求中携带
 * 原提示词引用的图片、文本或其它资源。资源身份仍由 API 在排队前冻结，
 * 这里只把已校验的 mention 块放入临时执行画布，不把媒体内容写入快照。
 *
 * @param canvas 独立 Skill 优化临时画布。
 * @param input 用户提交的原始提示词文档。
 * @returns 带有原始资源提及的临时画布；不修改调用方对象。
 * @throws 目标节点或临时提示词文档缺失时抛出错误。
 */
export function attachPromptOptimizationMentions(
  canvas: CanvasDocument,
  input: PromptDocument,
): CanvasDocument {
  const source = promptDocumentSchema.parse(input);
  const mentions = source.blocks.filter((block) => block.type === 'mention');
  if (mentions.length === 0) return canvas;

  let foundTarget = false;
  const nodes = canvas.nodes.map((node) => {
    if (node.id !== PROMPT_OPTIMIZATION_NODE_ID) return node;
    foundTarget = true;
    const promptDocument = node.data.promptDocument;
    if (!promptDocument) throw new Error('Skill 优化节点缺少临时提示词文档');
    return {
      ...node,
      data: {
        ...node.data,
        promptDocument: {
          ...promptDocument,
          blocks: [...promptDocument.blocks, ...mentions],
        },
      },
    };
  });
  if (!foundTarget) throw new Error('Skill 优化节点缺失');
  return { ...canvas, nodes };
}

/** 返回独立优化结果；省略内部凭据和请求正文，保留已脱敏的失败诊断。 */
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
    ...(status === 'succeeded' && result ? result : {}),
    ...(status === 'failed'
      ? {
          error: run.error?.trim() || '提示词优化未返回有效结果，请检查文字模型配置后重新发起优化',
        }
      : {}),
  };
}

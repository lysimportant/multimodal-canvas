import { promptDocumentSchema, type PromptDocument } from '@multimodal-canvas/domain';
import { z } from 'zod';

import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from './auth-client';
import { submitGenerationRequest } from './generation-client';

/** 通过公共解析器保留完整文档约束，避免跨包嵌套 Zod 泛型超出推导深度。 */
const documentSchema = z.unknown().transform((value, context): PromptDocument => {
  const parsed = promptDocumentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({ code: z.ZodIssueCode.custom, message: '提示词文档格式无效' });
  return z.NEVER;
});

/** 执行语义版本由目录提供并随 POST 提交，和工作台 revision 分开冻结。 */
const skillVersionSchema = z.string().min(1).max(160);

/** 提交前冻结的完整请求；项目用于路由，技能版本同时用于服务端前置校验。 */
const optimizationRequestSchema = z.object({
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
  skillId: z.string().min(1),
  skillVersion: skillVersionSchema,
  mediaType: z.enum(['text', 'image', 'audio', 'video']),
  promptDocument: documentSchema,
  idempotencyKey: z.string().min(1),
  modelAlias: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
});

/** 完整优化请求快照，重试必须沿用全部字段和幂等键。 */
export type PromptOptimizationRequest = z.infer<typeof optimizationRequestSchema>;

/** 公开任务状态；credentialId 只兼容旧响应，当前服务端省略。成功文档另行校验提及身份与非空文字。 */
const optimizationSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  skillId: z.string().min(1),
  skillVersion: skillVersionSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  modelAlias: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  promptDocument: documentSchema.optional(),
  error: z.string().optional(),
  simulated: z.boolean().optional(),
});

/** 已验证身份的优化任务，独立于媒体生成任务。 */
export type PromptOptimization = z.infer<typeof optimizationSchema>;

/** 当前标签页的恢复记录；只保存凭据 ID，不保存凭据密钥。 */
const pendingOptimizationSchema = z.object({
  request: optimizationRequestSchema,
  runId: z.string().min(1).optional(),
  model: z
    .object({
      modelAlias: z.string().min(1),
      credentialId: z.string().optional(),
    })
    .optional(),
  draft: documentSchema.optional(),
  result: optimizationSchema.optional(),
  /** POST 发出前写入；重挂载后不能把权限等临时拒绝当作从未创建过任务。 */
  submitted: z.boolean().optional(),
});

/** 未确认提交、轮询任务或尚未应用的预览，可在面板重挂载后恢复。 */
export type PendingPromptOptimization = z.infer<typeof pendingOptimizationSchema>;

/** 网络选项用于中止面板请求及注入测试传输层。 */
type RequestOptions = { signal?: AbortSignal; fetcher?: typeof fetch };

/** HTTP 错误保留状态，调用方只有收到明确拒绝才可以释放幂等键。 */
export class PromptOptimizationRequestError extends Error {
  /** @param status 服务端返回的 HTTP 状态码。 */
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PromptOptimizationRequestError';
  }

  /** 首次提交的明确拒绝；版本冲突保证未创建 Run，其他 409 仍为结果未知。 */
  get rejected(): boolean {
    return (
      [400, 401, 403, 404, 422].includes(this.status) ||
      (this.status === 409 && this.code === 'PROMPT_SKILL_VERSION_CONFLICT')
    );
  }
}

/** 身份已核对的成功终态含无效文档；可释放该请求，但不得自动重新优化。 */
export class PromptOptimizationResultError extends Error {
  /** @param runId 服务端已确认结束的任务身份。 */
  constructor(
    message: string,
    public readonly runId: string,
  ) {
    super(message);
    this.name = 'PromptOptimizationResultError';
  }
}

/**
 * 校验优化或手工编辑后的预览，禁止增加、删除、重排提及或改变身份。
 * @returns 经过公共文档 schema 规范化的副本，不修改原文。
 * @throws 文档为空、超限或提及的版本、绑定、占位等字段发生改变。
 */
export function validateOptimizedPromptDocument(
  document: PromptDocument,
  baseline: PromptDocument,
): PromptDocument {
  const parsed = promptDocumentSchema.parse(document);
  const original = promptDocumentSchema.parse(baseline);
  if (!parsed.blocks.some((block) => block.type === 'text' && block.text.trim()))
    throw new Error('优化结果缺少提示词文字');
  const mentions = original.blocks.filter((block) => block.type === 'mention');
  const actual = parsed.blocks.filter((block) => block.type === 'mention');
  if (
    actual.length !== mentions.length ||
    actual.some((mention, index) => JSON.stringify(mentions[index]) !== JSON.stringify(mention))
  )
    throw new Error('优化结果改变了资源提及，请保留原有资源、版本和绑定');
  return parsed;
}

/** 编码项目路由，不允许项目名称中的斜杠改变请求目标。 */
function optimizationUrl(projectId: string, apiBaseUrl: string): string {
  if (!projectId) throw new Error('请先保存项目');
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/prompt-optimizations`;
}

/** 校验协议、节点、技能版本、任务和精确模型身份，避免串任务结果进入预览。 */
async function readOptimization(
  response: Response,
  request: PromptOptimizationRequest,
  expectedAuthGeneration: number,
  runId?: string,
  model?: PendingPromptOptimization['model'],
): Promise<PromptOptimization> {
  const payload: unknown = await response.json().catch(() => null);
  if (getAuthSessionGeneration() !== expectedAuthGeneration) throw new AuthSessionChangedError();
  if (!response.ok) {
    const error = z.object({ error: z.string(), code: z.string().optional() }).safeParse(payload);
    throw new PromptOptimizationRequestError(
      error.success ? error.data.error : '提示词优化请求失败',
      response.status,
      error.success ? error.data.code : undefined,
    );
  }
  // 先验证身份和终态，再解析文档；文档损坏不能掩盖串任务或未知响应。
  const parsed = z
    .object({ optimization: optimizationSchema.extend({ promptDocument: z.unknown().optional() }) })
    .safeParse(payload);
  if (!parsed.success) throw new Error('提示词优化响应格式无效');
  const result = parsed.data.optimization;
  if (
    result.nodeId !== request.nodeId ||
    result.skillId !== request.skillId ||
    result.skillVersion !== request.skillVersion ||
    (runId !== undefined && result.runId !== runId) ||
    (request.modelAlias !== undefined && result.modelAlias !== request.modelAlias) ||
    (request.credentialId !== undefined && result.credentialId !== request.credentialId) ||
    (model !== undefined &&
      (result.modelAlias !== model.modelAlias || result.credentialId !== model.credentialId))
  )
    throw new Error('提示词优化任务身份不一致');
  if (result.status === 'succeeded') {
    try {
      if (result.promptDocument === undefined) throw new Error('优化结果缺少提示词文档');
      const document = promptDocumentSchema.safeParse(result.promptDocument);
      if (!document.success) throw new Error('优化结果的提示词文档格式无效');
      return {
        ...result,
        promptDocument: validateOptimizedPromptDocument(document.data, request.promptDocument),
      };
    } catch (cause) {
      throw new PromptOptimizationResultError(
        cause instanceof Error ? cause.message : '优化结果无效',
        result.runId,
      );
    }
  }
  const { promptDocument: _document, ...state } = result;
  return state;
}

/**
 * 显式提交一次优化，不自动重发，也不触发媒体生成。
 * @param request 已持久化的请求；省略模型时由服务端选择默认文字模型。
 * @throws HTTP、网络、协议或身份错误；结果未知时须保留此请求用于确认。
 */
export async function submitPromptOptimization(
  request: PromptOptimizationRequest,
  apiBaseUrl: string,
  options: RequestOptions = {},
): Promise<PromptOptimization> {
  const expectedAuthGeneration = getAuthSessionGeneration();
  const parsed = optimizationRequestSchema.parse(request);
  if (parsed.credentialId && !parsed.modelAlias) throw new Error('指定连接时必须同时指定文字模型');
  const { projectId, ...body } = parsed;
  const fetcher =
    options.fetcher ?? ((input, init) => apiFetch(input, init, { expectedAuthGeneration }));
  const response = await submitGenerationRequest(
    apiBaseUrl,
    { path: optimizationUrl(projectId, ''), body },
    { fetcher, signal: options.signal },
  );
  return readOptimization(response, parsed, expectedAuthGeneration);
}

/** 只读轮询指定任务；已解析默认模型时传入其身份，后续响应不得更换连接。 */
export async function fetchPromptOptimization(
  pending: PendingPromptOptimization & { runId: string },
  apiBaseUrl: string,
  options: RequestOptions = {},
): Promise<PromptOptimization> {
  const expectedAuthGeneration = getAuthSessionGeneration();
  const request = optimizationRequestSchema.parse(pending.request);
  if (!pending.runId) throw new Error('优化任务 ID 无效');
  const fetcher =
    options.fetcher ?? ((input, init) => apiFetch(input, init, { expectedAuthGeneration }));
  const response = await fetcher(
    `${optimizationUrl(request.projectId, apiBaseUrl)}/${encodeURIComponent(pending.runId)}`,
    { signal: options.signal },
  );
  return readOptimization(response, request, expectedAuthGeneration, pending.runId, pending.model);
}

/** 用户、服务端、项目和节点共同隔离恢复记录，避免跨账户或部署读取预览。 */
export function pendingPromptOptimizationKey(
  userId: string,
  apiBaseUrl: string,
  projectId: string,
  nodeId: string,
): string {
  return `multimodal-canvas:pending-prompt-optimization:${JSON.stringify([userId, apiBaseUrl, projectId, nodeId])}`;
}

/** 读取完整请求；损坏或受限存储显式报错，禁止静默换键重复提交。 */
export function readPendingPromptOptimization(key: string): PendingPromptOptimization | undefined {
  const stored = sessionStorage.getItem(key);
  if (stored === null) return undefined;
  const parsed = pendingOptimizationSchema.safeParse(JSON.parse(stored));
  if (!parsed.success) throw new Error('待确认优化请求记录无效');
  return parsed.data;
}

/** 发送前保存快照；同步失败时不得发送新请求。 */
export function savePendingPromptOptimization(
  key: string,
  pending: PendingPromptOptimization,
): void {
  sessionStorage.setItem(key, JSON.stringify(pendingOptimizationSchema.parse(pending)));
}

/** 只清除同一幂等键，迟到响应不能删除后来创建的请求。 */
export function clearPendingPromptOptimization(key: string, idempotencyKey: string): void {
  if (readPendingPromptOptimization(key)?.request.idempotencyKey === idempotencyKey)
    sessionStorage.removeItem(key);
}

import { z } from 'zod';

import { apiFetch } from './auth-client';
import type { ModelSelection } from './workspace/contracts';

/** 反推任务的公共响应，与真实请求提示词记录分开读取。 */
const reversePromptAnalysisSchema = z.object({
  runId: z.string().min(1),
  assetId: z.string().min(1),
  assetVersion: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  modelAlias: z.string().min(1),
  credentialId: z.string().optional(),
  summary: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional(),
});

/** 同一资产版本的一次分析；成功必须具有独立的摘要和详细提示词。 */
export type ReversePromptAnalysis = z.infer<typeof reversePromptAnalysisSchema>;

/** 查询同时返回服务端解析的默认模型，普通用户无需读取平台设置或 Key。 */
export type ReversePromptState = {
  analysis: ReversePromptAnalysis | null;
  defaultModel?: ModelSelection;
};

/** 反推请求冻结的项目与资产版本，不接受仅有外部 URL 的输入。 */
export type ReversePromptTarget = {
  projectId: string;
  assetId: string;
  version: number;
};

/** 服务端明确拒绝的请求可调整模型重新提交；网络或 5xx 错误仍视为结果未知。 */
export class ReversePromptRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** 构造精确资产版本路由；无效身份在发送网络请求前拒绝。 */
function reversePromptUrl(target: ReversePromptTarget, apiBaseUrl: string): string {
  if (
    !target.projectId ||
    !target.assetId ||
    !Number.isSafeInteger(target.version) ||
    target.version < 1
  )
    throw new Error('反推资源版本无效');
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/assets/${encodeURIComponent(target.assetId)}/versions/${target.version}/reverse-prompts`;
}

/** 校验响应身份与成功字段；供应商或权限错误保留可读信息，不把空结果当成功。 */
async function readAnalysis(
  response: Response,
  target: ReversePromptTarget,
): Promise<ReversePromptState> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : '反推提示词请求失败';
    throw new ReversePromptRequestError(message, response.status);
  }
  const parsed = z
    .object({
      analysis: reversePromptAnalysisSchema.nullable(),
      defaultModel: z
        .object({ modelAlias: z.string().min(1), credentialId: z.string().optional() })
        .optional(),
    })
    .safeParse(payload);
  if (!parsed.success) throw new Error('反推提示词响应格式无效');
  const analysis = parsed.data.analysis;
  if (analysis && (analysis.assetId !== target.assetId || analysis.assetVersion !== target.version))
    throw new Error('反推结果与资源版本不一致');
  if (analysis?.status === 'succeeded' && (!analysis.summary?.trim() || !analysis.prompt?.trim()))
    throw new Error('反推结果缺少整体摘要或详细提示词');
  return parsed.data;
}

/** 查询已保存的分析；runId 指定后只轮询这次任务，查询不会触发模型调用。 */
export async function fetchReversePrompt(
  target: ReversePromptTarget,
  apiBaseUrl: string,
  options: { runId?: string; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<ReversePromptState> {
  const query = new URLSearchParams({ projectId: target.projectId });
  if (options.runId) query.set('runId', options.runId);
  const response = await (options.fetcher ?? apiFetch)(
    `${reversePromptUrl(target, apiBaseUrl)}?${query}`,
    { signal: options.signal },
  );
  const state = await readAnalysis(response, target);
  const analysis = state.analysis;
  if (options.runId && analysis && analysis.runId !== options.runId)
    throw new Error('反推任务身份不一致');
  return state;
}

/**
 * 提交一次反推，客户端不自动重试；automatic 由服务端按资源版本永久去重。
 * @param options.model 用户显式选择；省略时由服务端解析文字默认模型。
 * @param options.idempotencyKey 手动请求的稳定身份，网络结果未知时沿用相同值。
 * @throws 权限、模型、版本、格式或网络错误；调用方必须显示错误并保留已有说明。
 */
export async function submitReversePrompt(
  target: ReversePromptTarget,
  apiBaseUrl: string,
  options: {
    model?: ModelSelection;
    automatic?: boolean;
    idempotencyKey: string;
    fetcher?: typeof fetch;
  },
): Promise<ReversePromptAnalysis> {
  const response = await (options.fetcher ?? apiFetch)(reversePromptUrl(target, apiBaseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: target.projectId,
      ...options.model,
      automatic: options.automatic ?? false,
      idempotencyKey: options.idempotencyKey,
    }),
  });
  const { analysis } = await readAnalysis(response, target);
  if (!analysis) throw new Error('未返回反推任务');
  return analysis;
}

/** 使用完整模型与凭据身份作为选项值，避免同名模型串用连接。 */
export function reversePromptModelKey(model: ModelSelection): string {
  return JSON.stringify([model.modelAlias, model.credentialId ?? null]);
}

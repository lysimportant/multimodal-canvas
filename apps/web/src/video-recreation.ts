import { z } from 'zod';

import { parseVideoRecreationTemplate } from '@multimodal-canvas/domain';
import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from './auth-client';
import { submitGenerationRequest } from './generation-client';
import type { ModelSelection } from './workspace/contracts';

/** 专属分析响应；用途是身份的一部分，不能接受普通反推结果。 */
const analysisSchema = z.object({
  runId: z.string().min(1),
  assetId: z.string().min(1),
  assetVersion: z.number().int().positive(),
  purpose: z.literal('video_recreation'),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  modelAlias: z.string().min(1),
  credentialId: z.string().optional(),
  summary: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional(),
});

/** 服务端的一次整条视频分析；成功时 prompt 是已验证的模板 JSON。 */
export type VideoRecreationAnalysis = z.infer<typeof analysisSchema>;

/** 只读查询结果及当前账户的默认分析模型，不含凭据内容。 */
export type VideoRecreationState = {
  analysis: VideoRecreationAnalysis | null;
  defaultModel?: ModelSelection;
};

/** 冻结项目、来源资产及正整数版本，不回退到版本 1。 */
export type VideoRecreationTarget = { projectId: string; assetId: string; version: number };

/** HTTP 错误保留状态和服务端原文；网络及未知结果不包装成明确拒绝。 */
export class VideoRecreationRequestError extends Error {
  /** @param status 服务端 HTTP 状态，用于区分明确拒绝与结果未知。 */
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'VideoRecreationRequestError';
  }
}

/** 生成精确版本路由；非法来源在联网前失败。 */
function videoRecreationUrl(target: VideoRecreationTarget, apiBaseUrl: string): string {
  if (
    !target.projectId.trim() ||
    !target.assetId.trim() ||
    !Number.isSafeInteger(target.version) ||
    target.version < 1
  )
    throw new Error('视频来源版本无效，请刷新资源后重试');
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/assets/${encodeURIComponent(target.assetId)}/versions/${target.version}/reverse-prompts`;
}

/** 校验用途、来源和完整成功内容，避免把其他任务或残缺模板当成成功。 */
async function readState(
  response: Response,
  target: VideoRecreationTarget,
): Promise<VideoRecreationState> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : '整条视频分析请求失败';
    throw new VideoRecreationRequestError(message, response.status);
  }
  const parsed = z
    .object({
      analysis: analysisSchema.nullable(),
      defaultModel: z
        .object({ modelAlias: z.string().min(1), credentialId: z.string().optional() })
        .optional(),
    })
    .safeParse(payload);
  if (!parsed.success) throw new Error('视频复刻分析响应格式或用途无效');
  const { analysis } = parsed.data;
  if (analysis && (analysis.assetId !== target.assetId || analysis.assetVersion !== target.version))
    throw new Error('视频复刻分析与来源版本不一致');
  if (analysis?.status === 'succeeded') {
    if (!analysis.summary?.trim() || !analysis.prompt?.trim())
      throw new Error('视频复刻分析缺少摘要或完整模板');
    parseVideoRecreationTemplate(analysis.prompt);
  }
  return parsed.data;
}

/**
 * 只读查询专属分析；提供 runId 后不接受其他任务，永不触发模型调用。
 * @param options 可取消信号、冻结任务身份与测试传输层。
 * @throws HTTP、模板或身份错误；账户代次变化时拒绝迟到正文。
 */
export async function fetchVideoRecreation(
  target: VideoRecreationTarget,
  apiBaseUrl: string,
  options: { runId?: string; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<VideoRecreationState> {
  const generation = getAuthSessionGeneration();
  const query = new URLSearchParams({ projectId: target.projectId, purpose: 'video_recreation' });
  if (options.runId) query.set('runId', options.runId);
  try {
    const fetcher =
      options.fetcher ??
      ((input, init) => apiFetch(input, init, { expectedAuthGeneration: generation }));
    const response = await fetcher(`${videoRecreationUrl(target, apiBaseUrl)}?${query}`, {
      signal: options.signal,
    });
    const state = await readState(response, target);
    if (options.runId && state.analysis && state.analysis.runId !== options.runId)
      throw new Error('视频复刻分析任务身份不一致');
    return state;
  } finally {
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  }
}

/**
 * 显式提交一次整条视频分析，无自动重试；调用前必须持久化请求身份。
 * @param options.idempotencyKey 结果未知时必须沿用的稳定键。
 * @param options.model 冻结的模型及凭据身份；确认请求不能替换模型。
 * @throws HTTP、网络、模板或账户错误；网络失败不表示任务未创建。
 */
export async function submitVideoRecreation(
  target: VideoRecreationTarget,
  apiBaseUrl: string,
  options: {
    idempotencyKey: string;
    model?: ModelSelection;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<VideoRecreationAnalysis> {
  if (!options.idempotencyKey.trim()) throw new Error('视频复刻分析缺少稳定请求身份');
  const generation = getAuthSessionGeneration();
  try {
    const response = await submitGenerationRequest(
      apiBaseUrl,
      {
        path: videoRecreationUrl(target, ''),
        body: {
          projectId: target.projectId,
          purpose: 'video_recreation',
          automatic: false,
          idempotencyKey: options.idempotencyKey,
          ...options.model,
        },
      },
      { signal: options.signal, fetcher: options.fetcher },
    );
    const { analysis } = await readState(response, target);
    if (!analysis) throw new Error('未返回视频复刻分析任务');
    if (
      options.model &&
      (analysis.modelAlias !== options.model.modelAlias ||
        analysis.credentialId !== options.model.credentialId)
    )
      throw new Error('视频复刻分析的分组模型身份不一致');
    return analysis;
  } finally {
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  }
}

/** 使用模型和凭据共同标识选项，不混用同名模型的不同连接。 */
export function videoRecreationModelKey(model: ModelSelection): string {
  return JSON.stringify([model.modelAlias, model.credentialId ?? null]);
}

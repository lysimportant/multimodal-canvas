import {
  generationConcurrencySettingsSchema,
  updateGenerationConcurrencySchema,
  type GenerationConcurrencySettings,
} from '@multimodal-canvas/domain';
import { apiFetch } from './auth-client';
import { API_BASE_URL } from './workspace/contracts';

/** 管理员队列配置接口；沿用 HttpOnly 会话和账号切换取消机制。 */
const endpoint = API_BASE_URL + '/v1/admin/generation-concurrency';

/** 服务端明确确认配置不存在；允许管理员确认初始值后保存，不代表网络故障。 */
export class GenerationConcurrencyUnconfiguredError extends Error {
  /** 缺失状态不携带默认配置，调用方不得将候选值展示为已保存。 */
  constructor() {
    super('生成队列尚未初始化或配置已丢失，请确认并发数量后保存');
    this.name = 'GenerationConcurrencyUnconfiguredError';
  }
}

/** 校验服务端响应；鉴权、网络及结构错误均不得被当作已保存。 */
async function readResponse(response: Response): Promise<GenerationConcurrencySettings> {
  const body = (await response.json().catch(() => undefined)) as
    { settings?: unknown; error?: string; code?: string } | undefined;
  if (!response.ok) {
    if (response.status === 503 && body?.code === 'generation_concurrency_unconfigured')
      throw new GenerationConcurrencyUnconfiguredError();
    throw new Error(body?.error ?? '生成并发配置请求失败，请重新读取后再试');
  }
  const parsed = generationConcurrencySettingsSchema.safeParse(body?.settings);
  if (!parsed.success) throw new Error('生成并发配置响应无效，请重新读取后再试');
  return parsed.data;
}

/**
 * 读取已保存的队列全局并发；signal 仅取消本次读取，不影响任何生成任务。
 * @throws GenerationConcurrencyUnconfiguredError 配置不存在；其它失败不开放初始化入口。
 */
export async function loadGenerationConcurrency(
  signal?: AbortSignal,
): Promise<GenerationConcurrencySettings> {
  return readResponse(await apiFetch(endpoint, { signal }));
}

/**
 * 保存管理员指定的正安全整数；不自动重试不确定的写入。
 * @param concurrency 同一部署所有生成 Worker 共享的 Run 上限。
 * @param signal 页面卸载或换号时取消等待，不撤销已经持久化的配置。
 * @returns 服务端确认的已保存值；失败后调用方应先重新读取实际配置。
 */
export async function saveGenerationConcurrency(
  concurrency: number,
  signal?: AbortSignal,
): Promise<GenerationConcurrencySettings> {
  const input = updateGenerationConcurrencySchema.parse({ concurrency });
  return readResponse(
    await apiFetch(endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    }),
  );
}

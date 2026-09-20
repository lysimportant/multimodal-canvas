import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from './auth-client';

/** 待提交的生成类请求；请求体必须已经冻结，不能在发送前重新读取画布。 */
export type GenerationRequest = { path: string; body: Record<string, unknown> };

/** 带账号代次的冻结请求，账号切换后不得继续发送或接纳响应。 */
export type PreparedGenerationRequest = GenerationRequest & { authGeneration: number };

/**
 * 冻结一组请求并绑定当前账号代次。
 *
 * @param requests 已完成输入校验的业务请求。
 * @param signal 页面生命周期取消信号。
 * @returns 与输入顺序一致的深拷贝请求。
 * @throws AuthSessionChangedError 账号切换，或 AbortError 页面已取消。
 */
export function prepareGenerationRequests(
  requests: GenerationRequest[],
  signal?: AbortSignal,
): PreparedGenerationRequest[] {
  if (!requests.length) throw new Error('没有需要提交的生成任务');
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  const authGeneration = getAuthSessionGeneration();
  return structuredClone(requests).map((request) => ({ ...request, authGeneration }));
}

/**
 * 直接提交一次生成类请求；费用由 New API 按所选分组模型处理。
 *
 * @param apiBaseUrl Canvas API 地址。
 * @param request 业务路径与冻结请求体。
 * @param options 可取消信号与测试传输层。
 * @returns 原始 HTTP 响应，由业务层校验响应合同。
 * @throws AuthSessionChangedError 请求期间账号发生切换。
 */
export async function submitGenerationRequest(
  apiBaseUrl: string,
  request: GenerationRequest,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<Response> {
  const prepared = prepareGenerationRequests([request], options.signal)[0]!;
  const fetcher =
    options.fetcher ??
    ((input, init) => apiFetch(input, init, { expectedAuthGeneration: prepared.authGeneration }));
  const response = await fetcher(`${apiBaseUrl.replace(/\/$/, '')}${prepared.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify(prepared.body),
  });
  if (prepared.authGeneration !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  return response;
}

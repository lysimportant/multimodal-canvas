/** 后台及个人资源工作台的请求与数据契约；所有权限由服务端验证。 */
import { apiFetch } from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';

/** 资源归属所需的公开用户资料；New API 身份可能不提供邮箱。 */
export type ManagedUser = {
  id: string;
  email?: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  role: 'user' | 'admin';
  status: string;
  createdAt: string;
  updatedAt?: string;
};

/** 统一请求错误，保留 HTTP 状态以区分权限、校验和临时故障。 */
export class ManagementError extends Error {
  /** 服务端返回的 HTTP 状态码。 */
  readonly status: number;

  /** 创建可显示给用户的请求错误。 */
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManagementError';
    this.status = status;
  }
}

/**
 * 请求管理 API，自动注入会话并保留明确的服务端错误。
 * @param path /v1 下的接口路径，不允许外部地址。
 * @param options 请求方法、JSON 数据、取消信号及匿名验证标记。
 * @returns 已解析 JSON，204 返回 undefined。
 * @throws ManagementError 服务端拒绝或返回了不可解析的数据。
 */
export async function managementRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; public?: boolean } = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('无效的接口路径');
  const response = await apiFetch(
    `${API_BASE_URL.replace(/\/$/, '')}/v1${path}`,
    {
      method: options.method ?? 'GET',
      credentials: 'include',
      ...(options.body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }
        : {}),
      signal: options.signal,
    },
    { skipUnauthorized: options.public },
  );
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
    throw new ManagementError(
      typeof error === 'string' ? error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  if (payload === null)
    throw new ManagementError('服务返回了无法解析的数据，请重试', response.status);
  return payload as T;
}

/** 编码列表筛选参数，省略空值，不把凭据加入 URL。 */
export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 将任意请求异常转换为本地可理解的反馈，网络错误不会假装成功。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

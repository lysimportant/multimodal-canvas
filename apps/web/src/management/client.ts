/** 后台及个人中心的请求与数据契约；所有权限由服务端验证。 */
import {
  apiFetch,
  getAuthSessionGeneration,
  persistAuthSession,
  readAuthSession,
  type AuthTokenResponse,
  type AuthUser,
  type StoredAuthSession,
} from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';

/** 初始化状态由服务端持久化，不能由浏览器本地状态推断。 */
export type BootstrapStatus = {
  initialized: boolean;
  mailConfigured: boolean;
  setupTokenRequired: boolean;
};

/** 用户业务资料；不包含密码哈希、会话令牌及邮件凭据。 */
export type ManagedUser = {
  id: string;
  email: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  role: 'user' | 'admin';
  status: string;
  emailVerifiedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
};

/** 邮件投递结果，区分已入队和失败；不回显验证码。 */
export type DeliveryResult = {
  email?: string;
  verificationRequired?: boolean;
  delivery: { status: string; id: string };
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

/** 验证邮箱并保存会话；路由取消抛 AbortError，迟到响应不提交，失败不清除当前身份。 */
export async function verifyAccount(
  input: {
    email: string;
    code: string;
    purpose: 'bootstrap' | 'invite' | 'register' | 'reset' | 'email';
    password?: string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<StoredAuthSession> {
  if (options.signal?.aborted) throw new DOMException('验证请求已取消', 'AbortError');
  const generation = getAuthSessionGeneration();
  /** 提交前可取消，提交引发的页面卸载不得把成功结果重新判为取消。 */
  let committed = false;
  let cancellation: DOMException | undefined;
  let rejectCancellation!: (error: DOMException) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => {
    if (committed || cancellation) return;
    cancellation = new DOMException('验证请求已取消', 'AbortError');
    rejectCancellation(cancellation);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) onAbort();
    const request = (async () => {
      if (cancellation) throw cancellation;
      const response = await managementRequest<AuthTokenResponse>('/auth/verify', {
        method: 'POST',
        body: input,
        public: true,
        signal: options.signal,
      });
      if (options.signal?.aborted)
        throw cancellation ?? new DOMException('验证请求已取消', 'AbortError');
      committed = true;
      return persistManagementSession(response, generation);
    })();
    return await Promise.race([request, cancelled]);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** 请求发出后身份发生变化时拒绝旧响应，避免重新登录或退出被晚到结果覆盖。 */
export function persistManagementSession(
  response: AuthTokenResponse,
  requestGeneration: number,
): StoredAuthSession {
  if (getAuthSessionGeneration() !== requestGeneration) {
    throw new ManagementError('账户状态已改变，请在当前账户中重新操作', 409);
  }
  return persistAuthSession(response);
}

/** 只将已保存的资料合并回同一用户的当前会话，不接管后来登录的账户。 */
export function updateStoredUser(user: ManagedUser): StoredAuthSession {
  const session = readAuthSession();
  if (!session || session.user.id !== user.id) {
    throw new ManagementError('账户状态已改变，请在当前账户中重新操作', 409);
  }
  return persistAuthSession({
    ...session,
    tokenType: 'Bearer',
    expiresIn: Math.max(0, (Date.parse(session.expiresAt) - Date.now()) / 1000),
    user: { ...session.user, ...user, displayName: user.displayName ?? undefined } as AuthUser,
  });
}

/** 将任意请求异常转换为本地可理解的反馈，网络错误不会假装成功。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

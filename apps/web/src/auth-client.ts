import { synchronizeServerClock } from './server-clock';

/** 当前会话可公开的用户资料；不包含密码、验证码或密钥。 */
export type AuthUser = {
  id: string;
  email: string;
  displayName?: string;
  role: 'user' | 'admin';
  createdAt: string;
  avatarUrl?: string | null;
  bio?: string | null;
  emailVerifiedAt?: string | null;
  status?: 'active' | 'pending' | 'disabled';
};

export type AuthTokenResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
  user: AuthUser;
};

export type StoredAuthSession = Pick<AuthTokenResponse, 'accessToken' | 'expiresAt' | 'user'>;

const STORAGE_KEY = 'multimodal-canvas:auth-session';
/** 到期前这么久就开始续期，避免后台标签冻住 30 秒定时器后错过刷新窗口。 */
const AUTH_REFRESH_LEAD_MS = 5 * 60 * 1000;
/** 同一标签页的会话通知；身份变化时由应用清除前一用户缓存。 */
const sessionListeners = new Set<(session: StoredAuthSession | null) => void>();
/** 登录/退出意图代次，阻止早先认证响应覆盖后来选择的账户。 */
let authGeneration = 0;
/** 返回当前认证意图代次，异步账户操作提交结果前必须确认代次未改变。 */
export function getAuthSessionGeneration(): number {
  return authGeneration;
}
/** 单个会话最多有一个续期请求，防止并发轮换令牌。 */
let refreshRequest: { token: string; promise: Promise<StoredAuthSession | null> } | null = null;
let unauthorizedHandler: (() => void) | undefined;

function storage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isAuthSession(value: unknown): value is StoredAuthSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.accessToken === 'string' &&
    session.accessToken.length > 0 &&
    typeof session.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(session.expiresAt)) &&
    Boolean(session.user) &&
    typeof session.user === 'object'
  );
}

function isSessionUnexpired(session: StoredAuthSession): boolean {
  return Date.parse(session.expiresAt) > Date.now();
}

/**
 * 读取本地保存的会话，访问令牌过期也保留。
 * 后台标签页冻住后续期必须还能拿到旧令牌；损坏数据仍会丢弃。
 */
export function readStoredAuthSession(): StoredAuthSession | null {
  if (memorySession && isAuthSession(memorySession)) return memorySession;
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAuthSession(parsed)) {
      clearAuthSession();
      return null;
    }
    memorySession = parsed;
    return parsed;
  } catch {
    clearAuthSession();
    return null;
  }
}

/** 读取尚未过期的会话；过期令牌不算当前登录，但不会立刻清掉本地存储。 */
export function readAuthSession(): StoredAuthSession | null {
  const session = readStoredAuthSession();
  if (!session || !isSessionUnexpired(session)) return null;
  return session;
}

/** 持久化已验证的会话并通知页面；存储受限时保留当前标签内存会话。 */
export function persistAuthSession(
  response: AuthTokenResponse,
  options: { renewal?: boolean } = {},
): StoredAuthSession {
  const session: StoredAuthSession = {
    accessToken: response.accessToken,
    expiresAt: response.expiresAt,
    user: response.user,
  };
  const store = storage();
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be disabled (for example in private browsing). Keep the
    // in-memory token available through the module fallback below.
  }
  if (
    memorySession?.user.id !== session.user.id ||
    memorySession?.user.role !== session.user.role ||
    (!options.renewal && (memorySession?.accessToken ?? null) !== session.accessToken)
  )
    authGeneration++;
  memorySession = session;
  sessionListeners.forEach((listener) => listener(session));
  return session;
}

let memorySession: StoredAuthSession | null = null;

/** 清除当前浏览器会话并通知订阅者；不修改后端用户数据。 */
export function clearAuthSession(): void {
  authGeneration++;
  memorySession = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; the in-memory session is still cleared.
  }
  sessionListeners.forEach((listener) => listener(null));
}

/** 同步当前标签与其他标签的登录、退出及账户资料变化，返回清理函数。 */
export function subscribeAuthSession(
  listener: (session: StoredAuthSession | null) => void,
): () => void {
  sessionListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    authGeneration++;
    memorySession = null;
    listener(readStoredAuthSession());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    sessionListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function getAuthToken(): string | undefined {
  const session = readStoredAuthSession();
  if (!session || !isSessionUnexpired(session)) return undefined;
  return session.accessToken;
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = undefined;
  };
}

/** 仅让发起请求时的会话失效；旧请求的 401 不得注销后来登录的新账户。 */
export function notifyUnauthorized(expectedToken?: string | null): void {
  const currentToken = memorySession?.accessToken ?? readStoredAuthSession()?.accessToken ?? null;
  if (expectedToken !== undefined && expectedToken !== currentToken) return;
  clearAuthSession();
  unauthorizedHandler?.();
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function authApiBaseUrl(input: RequestInfo | URL): string {
  try {
    return new URL(requestHref(input), window.location.href).origin;
  } catch {
    return '';
  }
}

/** 为应用请求添加会话头；401 只清理对应会话，网络错误与 403 保留登录，不重放写请求。 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { skipUnauthorized?: boolean } = {},
): Promise<Response> {
  const href = requestHref(input);
  if (
    !getAuthToken() &&
    readStoredAuthSession() &&
    !/\/v1\/auth\/refresh\/?$/.test(href.split('?')[0] ?? '')
  ) {
    const baseUrl = authApiBaseUrl(input);
    if (baseUrl) await refreshAuthSession(baseUrl).catch(() => null);
  }
  const requestInit = withAuthHeaders(init);
  const authorization = new Headers(requestInit.headers).get('authorization');
  const requestToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  const requestStartedAt = performance.now();
  const response = await fetch(input, requestInit);
  synchronizeServerClock(response.headers?.get('x-server-time') ?? null, requestStartedAt);
  if (response.status === 401 && !options.skipUnauthorized) {
    notifyUnauthorized(requestToken);
  }
  return response;
}

/** 表示账户尚需邮箱验证，调用者应切换验证页而非当作登录成功。 */
export class EmailVerificationRequired extends Error {
  constructor(
    public readonly email: string,
    message = '请验证邮箱后继续',
    public readonly deliveryFailed = false,
  ) {
    super(message);
    this.name = 'EmailVerificationRequired';
  }
}

/** 发送认证请求；外部取消抛 AbortError，十秒超时抛 TimeoutError，迟到结果不提交会话。 */
async function authRequest(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<StoredAuthSession> {
  if (options.signal?.aborted) throw abortError(options.signal, '认证请求已取消');
  const generation = ++authGeneration;
  const controller = new AbortController();
  /** 首次中断原因固定不变，避免取消被晚到的超时覆盖；提交会话后不再接受取消。 */
  let interruption: Error | undefined;
  let committed = false;
  let rejectInterruption!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const interrupt = (error: Error) => {
    if (committed || interruption) return;
    interruption = error;
    controller.abort(error);
    rejectInterruption(error);
  };
  const onAbort = () => interrupt(abortError(options.signal, '认证请求已取消'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    const error = new Error('认证请求超时，请检查连接后重试');
    error.name = 'TimeoutError';
    interrupt(error);
  }, 10_000);
  try {
    if (options.signal?.aborted) onAbort();
    const request = (async () => {
      if (interruption) throw interruption;
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (interruption) throw interruption;
      const payload = (await response.json().catch(() => ({}))) as Partial<AuthTokenResponse> & {
        error?: string;
        code?: string;
        delivery?: { status?: string };
      };
      if (interruption) throw interruption;
      if (options.signal?.aborted) throw abortError(options.signal, '认证请求已取消');
      if (generation !== authGeneration) throw new Error('账户状态已改变，请重新操作');
      if (response.status === 202 || payload.code === 'email_verification_required') {
        throw new EmailVerificationRequired(
          String(body.email ?? ''),
          payload.error,
          payload.delivery?.status === 'failed',
        );
      }
      if (!response.ok || typeof payload.accessToken !== 'string' || !payload.user)
        throw new Error(payload.error ?? '认证请求失败');
      committed = true;
      return persistAuthSession(payload as AuthTokenResponse);
    })();
    return await Promise.race([request, interrupted]);
  } catch (error) {
    if (interruption) throw interruption;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** 登录并保存最新有效会话；旧两参数调用保持兼容，取消或超时不会清除已有身份。 */
export function login(
  baseUrl: string,
  input: { email: string; password: string },
  options: { signal?: AbortSignal } = {},
): Promise<StoredAuthSession> {
  return authRequest(baseUrl, '/v1/auth/login', input, options);
}

/** 注册并按服务端结果进入验证或保存会话；支持路由离开时取消且不接纳迟到响应。 */
export function register(
  baseUrl: string,
  input: { email: string; password: string; displayName?: string },
  options: { signal?: AbortSignal } = {},
): Promise<StoredAuthSession> {
  return authRequest(baseUrl, '/v1/auth/register', input, options);
}

/** 撤销当前会话并退出本地；请求失败时抛错供界面说明服务端撤销未确认。 */
export async function logout(baseUrl: string): Promise<void> {
  const token = getAuthToken();
  clearAuthSession();
  try {
    if (token) {
      const response = await apiFetch(
        `${baseUrl.replace(/\/$/, '')}/v1/auth/logout`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        { skipUnauthorized: true },
      );
      if (!response.ok && response.status !== 401) throw new Error('服务端会话撤销未确认');
    }
  } finally {
    if ((memorySession?.accessToken ?? readAuthSession()?.accessToken) === token)
      clearAuthSession();
  }
}

/** 使用当前本地会话续期，访问令牌刚过期也会尝试；并发请求复用一次刷新。 */
export async function refreshAuthSession(baseUrl: string): Promise<StoredAuthSession | null> {
  const session = readStoredAuthSession();
  const userId = session?.user.id;
  const token = session?.accessToken;
  if (!token) return null;
  if (refreshRequest?.token === token) return refreshRequest.promise;
  const generation = authGeneration;
  const promise = (async () => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/auth/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (
      generation !== authGeneration ||
      (memorySession?.accessToken ?? readStoredAuthSession()?.accessToken) !== token
    )
      return readAuthSession();
    if (response.status === 401) {
      notifyUnauthorized(token);
      return null;
    }
    if (!response.ok) throw new Error(`会话续期失败（${response.status}）`);
    const payload = (await response.json()) as AuthTokenResponse;
    if (
      generation !== authGeneration ||
      (memorySession?.accessToken ?? readStoredAuthSession()?.accessToken) !== token
    )
      return readAuthSession();
    if (!isAuthSession(payload) || payload.user.id !== userId) throw new Error('会话续期响应无效');
    return persistAuthSession(payload, { renewal: true });
  })();
  refreshRequest = { token, promise };
  try {
    return await promise;
  } finally {
    if (refreshRequest?.promise === promise) refreshRequest = null;
  }
}

/** 每 30 秒、焦点恢复、标签页重新可见时检查续期；到期前五分钟刷新。 */
export function maintainAuthSession(baseUrl: string, onError: (error: Error) => void): () => void {
  let active = true;
  const check = () => {
    const session = readStoredAuthSession();
    if (!session) return;
    if (Date.parse(session.expiresAt) - Date.now() > AUTH_REFRESH_LEAD_MS) return;
    void refreshAuthSession(baseUrl).catch((error: unknown) => {
      if (active) onError(error instanceof Error ? error : new Error('会话续期失败'));
    });
  };
  const onVisibility = () => {
    check();
  };
  const interval = window.setInterval(check, 30_000);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', onVisibility);
  check();
  return () => {
    active = false;
    window.clearInterval(interval);
    window.removeEventListener('focus', check);
    window.removeEventListener('pageshow', check);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export type AuthEventHandler = (eventName: string, data: string) => void;

export type AuthEventStreamOptions = {
  /** Delay before the first reconnect attempt. Defaults to 500ms. */
  initialReconnectDelayMs?: number;
  /** Maximum reconnect delay. Defaults to 10s. */
  maxReconnectDelayMs?: number;
  /** Number of reconnect attempts after the initial connection. Defaults to unlimited. */
  maxReconnectAttempts?: number;
};

const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_DEDUPLICATED_EVENTS = 256;

type RetryableEventStreamError = Error & { retryable?: boolean };

/** 构造统一 AbortError；认证可指定文案，事件流沿用默认取消提示。 */
function abortError(signal?: AbortSignal, message = '事件流已取消'): Error {
  const reason = signal?.reason;
  if (
    typeof DOMException !== 'undefined' &&
    reason instanceof DOMException &&
    reason.name === 'AbortError'
  ) {
    return reason;
  }
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function reconnectDelay(value: number | undefined, fallback: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, value);
}

function waitForReconnectDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createEventEmitter(onEvent: AuthEventHandler): AuthEventHandler {
  // The API sends a current run snapshot whenever a client reconnects. Keep a
  // small bounded set so the same snapshot is not delivered twice when a
  // disconnect happens immediately after the server writes it.
  const seen = new Set<string>();
  return (eventName, data) => {
    const key = `${eventName}\u0000${data}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > MAX_DEDUPLICATED_EVENTS) {
      const oldest = seen.values().next().value;
      if (typeof oldest === 'string') seen.delete(oldest);
    }
    onEvent(eventName, data);
  };
}

async function consumeAuthEventStream(
  response: Response,
  onEvent: AuthEventHandler,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) onEvent(eventName, dataLines.join('\n'));
    eventName = 'message';
    dataLines = [];
  };
  const processLine = (line: string) => {
    if (!line) {
      flush();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'event') eventName = value || 'message';
    if (field === 'data') dataLines.push(value);
  };
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const chunk = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    if (buffer) processLine(buffer);
    flush();
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
  return true;
}

/**
 * Opens an authenticated SSE stream without putting credentials in the URL.
 *
 * A dropped stream is reopened serially with bounded exponential backoff. The
 * caller can stop both an active reader and a pending reconnect delay with the
 * supplied AbortSignal. The optional settings are primarily useful for tests
 * and hosts with a different retry budget; existing callers can keep using the
 * original three-argument form.
 */
export async function openAuthEventStream(
  input: RequestInfo | URL,
  onEvent: AuthEventHandler,
  signal?: AbortSignal,
  options: AuthEventStreamOptions = {},
): Promise<void> {
  const initialDelay = reconnectDelay(options.initialReconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
  const maximumDelay = reconnectDelay(
    options.maxReconnectDelayMs,
    DEFAULT_MAX_RECONNECT_DELAY_MS,
    initialDelay,
  );
  const maximumAttempts =
    options.maxReconnectAttempts === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(reconnectDelay(options.maxReconnectAttempts, 0)));
  const emitEvent = createEventEmitter(onEvent);
  let attempts = 0;
  let delayMs = initialDelay;

  while (true) {
    if (signal?.aborted) throw abortError(signal);

    try {
      const response = await apiFetch(input, {
        headers: { accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok) {
        const error = new Error(
          `事件流连接失败（${response.status}）`,
        ) as RetryableEventStreamError;
        // Retry transient gateway/rate-limit responses, while preserving the
        // previous one-shot rejection behavior for auth and project errors.
        error.retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw error;
      }

      // A successful response without a body means this runtime cannot expose
      // an SSE reader. Let the REST run polling fallback take over.
      if (!(await consumeAuthEventStream(response, emitEvent, signal))) return;
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError(signal);
      if ((error as RetryableEventStreamError)?.retryable === false) throw error;
      if (attempts >= maximumAttempts) throw error;
    }

    if (signal?.aborted) throw abortError(signal);
    if (attempts >= maximumAttempts) return;
    attempts += 1;
    await waitForReconnectDelay(delayMs, signal);
    delayMs = Math.min(maximumDelay, Math.max(initialDelay, delayMs * 2));
  }
}

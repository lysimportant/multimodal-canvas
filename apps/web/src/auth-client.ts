import { synchronizeServerClock } from './server-clock';

/** 当前会话可公开的用户资料；不包含密码、验证码或密钥。 */
export type AuthUser = {
  id: string;
  /** New API 资料可能没有邮箱；资源归属只使用不可变用户 ID。 */
  email?: string;
  displayName?: string;
  role: 'user' | 'admin';
  createdAt: string;
  avatarUrl?: string | null;
  bio?: string | null;
  status?: 'active' | 'pending' | 'disabled';
};

export type AuthTokenResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
  user: AuthUser;
};

/** 浏览器仅缓存当前公开用户；认证凭证由 HttpOnly Cookie 保存。 */
export type StoredAuthSession = {
  user: AuthUser;
  /** 兼容切换期间的旧响应；新版 Web 不再持久化或主动发送此令牌。 */
  accessToken?: string;
  expiresAt?: string;
};

const STORAGE_KEY = 'multimodal-canvas:auth-session';
/** 同一标签页的会话通知；身份变化时由应用清除前一用户缓存。 */
const sessionListeners = new Set<(session: StoredAuthSession | null) => void>();
/** 登录/退出意图代次，阻止早先认证响应覆盖后来选择的账户。 */
let authGeneration = 0;
/** 账号变化时立即中断尚未返回响应头的请求，业务层同时拒绝迟到正文。 */
const inFlightRequests = new Set<AbortController>();
/** 返回当前认证意图代次，异步账户操作提交结果前必须确认代次未改变。 */
export function getAuthSessionGeneration(): number {
  return authGeneration;
}
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
  return Boolean(session.user) && typeof session.user === 'object';
}

function isSessionUnexpired(session: StoredAuthSession): boolean {
  return session.expiresAt ? Date.parse(session.expiresAt) > Date.now() : true;
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
    const session: StoredAuthSession = {
      user: parsed.user,
      ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    };
    store.setItem(STORAGE_KEY, JSON.stringify(session));
    memorySession = session;
    return session;
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
  response: AuthTokenResponse | StoredAuthSession | { user: AuthUser },
  options: { renewal?: boolean } = {},
): StoredAuthSession {
  const session: StoredAuthSession = {
    user: response.user,
    ...('expiresAt' in response && response.expiresAt ? { expiresAt: response.expiresAt } : {}),
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
    !options.renewal
  ) {
    authGeneration++;
    for (const controller of inFlightRequests) controller.abort(new AuthSessionChangedError());
  }
  memorySession = session;
  sessionListeners.forEach((listener) => listener(session));
  return session;
}

let memorySession: StoredAuthSession | null = null;

/** 清除当前浏览器会话并通知订阅者；不修改后端用户数据。 */
export function clearAuthSession(): void {
  authGeneration++;
  for (const controller of inFlightRequests) controller.abort(new AuthSessionChangedError());
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
    const previous = memorySession;
    memorySession = null;
    const current = readStoredAuthSession();
    if (
      previous?.user.id !== current?.user.id ||
      previous?.user.role !== current?.user.role ||
      !current
    ) {
      authGeneration++;
      for (const controller of inFlightRequests) controller.abort(new AuthSessionChangedError());
    }
    listener(current);
  };
  window.addEventListener('storage', onStorage);
  return () => {
    sessionListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function getAuthToken(): string | undefined {
  return undefined;
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
  if (expectedToken !== undefined && expectedToken !== null && expectedToken !== currentToken)
    return;
  clearAuthSession();
  unauthorizedHandler?.();
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  return { ...init, headers, credentials: init?.credentials ?? 'include' };
}

/** 请求所属账户已改变；调用方不得把该请求重放到当前账户或接纳旧响应。 */
export class AuthSessionChangedError extends Error {
  /** 不包含账户资料或令牌；消息可直接展示。 */
  constructor() {
    super('账户状态已改变，请重新操作');
    this.name = 'AuthSessionChangedError';
  }
}

/**
 * 为应用请求添加会话头；401 只清理对应会话，网络错误与 403 保留登录，不重放写请求。
 * @param options 省略身份代次时保持默认行为；指定后在续期前后及响应返回时校验。
 * @throws AuthSessionChangedError 指定的身份代次已失效，禁止发送或返回旧账户请求。
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: {
    skipUnauthorized?: boolean;
    /** 发起操作时的 getAuthSessionGeneration()；正常令牌续期不改变此代次。 */
    expectedAuthGeneration?: number;
  } = {},
): Promise<Response> {
  const generation = options.expectedAuthGeneration ?? getAuthSessionGeneration();
  /** 同步校验与发送之间不等待，防止续期期间切换账户后使用新账户令牌。 */
  function assertRequestSession() {
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  }
  assertRequestSession();
  const cached = readStoredAuthSession();
  if (
    cached?.expiresAt &&
    Date.parse(cached.expiresAt) - Date.now() < 60_000 &&
    !options.skipUnauthorized
  ) {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
      window.location.href,
    );
    const prefix = url.pathname.indexOf('/v1/');
    if (prefix >= 0 && !url.pathname.includes('/auth/')) {
      await refreshAuthSession(`${url.origin}${url.pathname.slice(0, prefix)}`);
      assertRequestSession();
    }
  }
  const requestInit = withAuthHeaders(init);
  const authorization = new Headers(requestInit.headers).get('authorization');
  const requestToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  const requestStartedAt = performance.now();
  const controller = new AbortController();
  inFlightRequests.add(controller);
  let response: Response;
  try {
    response = await fetch(input, {
      ...requestInit,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  } catch (error) {
    assertRequestSession();
    throw error;
  } finally {
    inFlightRequests.delete(controller);
  }
  assertRequestSession();
  synchronizeServerClock(response.headers?.get('x-server-time') ?? null, requestStartedAt);
  if (response.status === 401 && !options.skipUnauthorized) {
    notifyUnauthorized(requestToken);
  }
  return response;
}

/**
 * 读取 Cookie 所属的当前用户；401 表示匿名，其他失败保留上下文。
 *
 * @param baseUrl Canvas API 地址。
 * @returns 当前用户，未登录时返回 null。
 * @throws 网络错误或非 401 HTTP 错误。
 */
export async function fetchCurrentSession(baseUrl: string): Promise<StoredAuthSession | null> {
  const generation = getAuthSessionGeneration();
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/auth/me`, {
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  });
  if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  if (response.status === 401) {
    return refreshAuthSession(baseUrl);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    user?: AuthUser;
    expiresAt?: string;
    error?: string;
  };
  if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  if (!response.ok || !payload.user) throw new Error(payload.error ?? '登录状态加载失败');
  return persistAuthSession(
    { user: payload.user, expiresAt: payload.expiresAt },
    { renewal: true },
  );
}

/**
 * 跳转 New API 登录入口；`next` 仅允许由服务端继续校验的站内路径。
 *
 * @param baseUrl Canvas API 地址。
 * @param next 登录完成后的站内返回路径。
 * @param prompt 显式换号时展示 New API 账号选择；跳转本身不会撤销当前授权。
 */
export function startNewApiLogin(
  baseUrl: string,
  next = '/workspace',
  prompt?: 'select_account',
): void {
  const params = new URLSearchParams({ next });
  if (prompt) params.set('prompt', prompt);
  window.location.assign(`${baseUrl.replace(/\/$/, '')}/v1/auth/newapi/start?${params}`);
}

/** 退出当前 Canvas 会话并通知其他标签页清理缓存。 */
export async function logout(baseUrl: string): Promise<void> {
  const userId = readAuthSession()?.user.id;
  clearAuthSession();
  try {
    if (userId) {
      const response = await apiFetch(
        `${baseUrl.replace(/\/$/, '')}/v1/auth/logout`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
        },
        { skipUnauthorized: true },
      );
      if (!response.ok && response.status !== 401) throw new Error('服务端会话撤销未确认');
    }
  } finally {
    if ((memorySession?.user.id ?? readAuthSession()?.user.id) === userId) clearAuthSession();
  }
}

/** 同一标签页合并续期；令牌始终只存在 HttpOnly Cookie。 */
let pendingRefresh: Promise<StoredAuthSession | null> | undefined;

/** 上游复核成功才续期；不重发业务请求，身份变化后拒绝迟到的结果。 */
export async function refreshAuthSession(baseUrl: string): Promise<StoredAuthSession | null> {
  if (pendingRefresh) return pendingRefresh;
  const generation = getAuthSessionGeneration();
  const before = readStoredAuthSession();
  /** 同源标签共享 HttpOnly Cookie，必须串行轮换，避免旧 Cookie 的 401 清掉新会话。 */
  const renew = async (): Promise<StoredAuthSession | null> => {
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
    let stored: unknown = null;
    try {
      const raw = storage()?.getItem(STORAGE_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      // 存储被禁用时仍可通过服务端 Cookie 校验当前会话。
    }
    if (isAuthSession(stored) && before && stored.user.id !== before.user.id)
      throw new AuthSessionChangedError();
    if (
      isAuthSession(stored) &&
      stored.user.id === before?.user.id &&
      stored.expiresAt !== before?.expiresAt &&
      stored.expiresAt &&
      Date.parse(stored.expiresAt) > Date.now() + 60_000
    ) {
      return persistAuthSession(stored, { renewal: true });
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(10_000),
    });
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
    if (response.status === 401) {
      // 不支持 Web Locks 的环境也只重读当前 Cookie，绝不重发生成或其它业务写请求。
      const restored = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/auth/me`, {
        credentials: 'include',
        signal: AbortSignal.timeout(10_000),
      });
      if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
      if (restored.ok) {
        const current = (await restored.json()) as StoredAuthSession;
        if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
        if (!isAuthSession(current)) throw new Error('登录状态加载失败');
        return persistAuthSession(current, { renewal: true });
      }
      if (restored.status !== 401) throw new Error('会话续期暂不可用');
      clearAuthSession();
      return null;
    }
    const payload = (await response.json()) as {
      user?: AuthUser;
      expiresAt?: string;
      error?: string;
    };
    if (generation !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
    if (!response.ok || !payload.user) throw new Error(payload.error ?? '会话续期失败');
    return persistAuthSession(
      { user: payload.user, expiresAt: payload.expiresAt },
      { renewal: true },
    );
  };
  pendingRefresh =
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks
          .request('multimodal-canvas:session-refresh', renew)
          .then((session) => session)
      : renew();
  try {
    return await pendingRefresh;
  } finally {
    pendingRefresh = undefined;
  }
}

/** Cookie 会话由服务端控制；焦点恢复时只重读用户，确保账号切换及时生效。 */
export function maintainAuthSession(baseUrl: string, onError: (error: Error) => void): () => void {
  let active = true;
  const check = () => {
    const expiresAt = readStoredAuthSession()?.expiresAt;
    const restore =
      expiresAt && Date.parse(expiresAt) - Date.now() < 120_000
        ? refreshAuthSession(baseUrl)
        : fetchCurrentSession(baseUrl);
    void restore.catch((error: unknown) => {
      if (active) onError(error instanceof Error ? error : new Error('会话续期失败'));
    });
  };
  const onVisibility = () => {
    check();
  };
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', onVisibility);
  const interval = window.setInterval(check, 60_000);
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

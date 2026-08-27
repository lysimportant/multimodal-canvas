export type AuthUser = {
  id: string;
  email: string;
  displayName?: string;
  role: 'user' | 'admin';
  createdAt: string;
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

/** Reads the persisted session, discarding expired or malformed values. */
export function readAuthSession(): StoredAuthSession | null {
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
    if (!isAuthSession(parsed) || Date.parse(parsed.expiresAt) <= Date.now()) {
      clearAuthSession();
      return null;
    }
    return parsed;
  } catch {
    clearAuthSession();
    return null;
  }
}

export function persistAuthSession(response: AuthTokenResponse): StoredAuthSession {
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
  memorySession = session;
  return session;
}

let memorySession: StoredAuthSession | null = null;

export function clearAuthSession(): void {
  memorySession = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; the in-memory session is still cleared.
  }
}

export function getAuthToken(): string | undefined {
  const session = memorySession ?? readAuthSession();
  if (!session) return undefined;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    clearAuthSession();
    return undefined;
  }
  memorySession = session;
  return session.accessToken;
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = undefined;
  };
}

/** Clears the local session and notifies the app after a non-fetch request gets a 401. */
export function notifyUnauthorized(): void {
  clearAuthSession();
  unauthorizedHandler?.();
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** Fetches this application's API and injects the current user's Bearer token. */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { skipUnauthorized?: boolean } = {},
): Promise<Response> {
  const response = await fetch(input, withAuthHeaders(init));
  if (response.status === 401 && !options.skipUnauthorized) {
    notifyUnauthorized();
  }
  return response;
}

async function authRequest(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<StoredAuthSession> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<AuthTokenResponse> & {
    error?: string;
  };
  if (!response.ok || typeof payload.accessToken !== 'string' || !payload.user) {
    throw new Error(payload.error ?? '认证请求失败');
  }
  return persistAuthSession(payload as AuthTokenResponse);
}

export function login(
  baseUrl: string,
  input: { email: string; password: string },
): Promise<StoredAuthSession> {
  return authRequest(baseUrl, '/v1/auth/login', input);
}

export function register(
  baseUrl: string,
  input: { email: string; password: string; displayName?: string },
): Promise<StoredAuthSession> {
  return authRequest(baseUrl, '/v1/auth/register', input);
}

export async function logout(baseUrl: string): Promise<void> {
  const token = getAuthToken();
  try {
    if (token) {
      await apiFetch(
        `${baseUrl.replace(/\/$/, '')}/v1/auth/logout`,
        { method: 'POST' },
        { skipUnauthorized: true },
      );
    }
  } finally {
    clearAuthSession();
  }
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

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (
    typeof DOMException !== 'undefined' &&
    reason instanceof DOMException &&
    reason.name === 'AbortError'
  ) {
    return reason;
  }
  if (typeof DOMException !== 'undefined') {
    return new DOMException('事件流已取消', 'AbortError');
  }
  const error = new Error('事件流已取消');
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

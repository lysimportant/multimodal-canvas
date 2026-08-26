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

/**
 * Opens an authenticated SSE stream without putting credentials in the URL.
 * The returned cleanup function aborts the underlying fetch.
 */
export async function openAuthEventStream(
  input: RequestInfo | URL,
  onEvent: AuthEventHandler,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch(input, {
    headers: { accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) throw new Error(`事件流连接失败（${response.status}）`);
  if (!response.body) return;

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

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) {
          flush();
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
        if (field === 'event') eventName = value || 'message';
        if (field === 'data') dataLines.push(value);
      }
    }
    if (buffer) {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
      flush();
    }
  } finally {
    reader.releaseLock();
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  clearAuthSession,
  getAuthToken,
  openAuthEventStream,
  persistAuthSession,
  readAuthSession,
  setUnauthorizedHandler,
  type AuthTokenResponse,
} from './auth-client';

const response: AuthTokenResponse = {
  accessToken: 'jwt-test-token',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  user: {
    id: 'user-1',
    email: 'user@example.com',
    role: 'user',
    createdAt: new Date().toISOString(),
  },
};

function streamResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function pendingStreamResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('auth-client', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setUnauthorizedHandler(undefined);
    clearAuthSession();
  });

  it('persists and restores a non-expired session without exposing the password', () => {
    persistAuthSession(response);
    expect(getAuthToken()).toBe('jwt-test-token');
    expect(readAuthSession()).toMatchObject({
      accessToken: 'jwt-test-token',
      user: { email: 'user@example.com' },
    });
    expect(localStorage.getItem('multimodal-canvas:auth-session')).not.toContain('password');
  });

  it('adds a Bearer header and clears the session on 401', async () => {
    persistAuthSession(response);
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 }),
      );

    const result = await apiFetch('http://localhost:3000/v1/projects');
    expect(result.status).toBe(401);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = fetcher.mock.calls[0]?.[1]?.headers;
    expect(new Headers(headers).get('authorization')).toBe('Bearer jwt-test-token');
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBeUndefined();
  });

  it('does not notify the app for an intentionally skipped 401', async () => {
    persistAuthSession(response);
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));

    await apiFetch(
      'http://localhost:3000/v1/auth/logout',
      { method: 'POST' },
      { skipUnauthorized: true },
    );
    expect(unauthorized).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe('jwt-test-token');
  });

  it('drops expired sessions', () => {
    persistAuthSession({
      ...response,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(readAuthSession()).toBeNull();
    expect(localStorage.getItem('multimodal-canvas:auth-session')).toBeNull();
  });

  it('reconnects with exponential backoff and suppresses replayed events', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const replayed = 'event: run.updated\ndata: {"id":"run-1","status":"running"}\n\n';
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(streamResponse(replayed))
        .mockResolvedValueOnce(streamResponse(replayed))
        .mockResolvedValueOnce(pendingStreamResponse());
      const events: Array<[string, string]> = [];
      const streamPromise = openAuthEventStream(
        'http://localhost:3000/v1/projects/project-1/events',
        (eventName, data) => events.push([eventName, data]),
        controller.signal,
        { initialReconnectDelayMs: 40, maxReconnectDelayMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(events).toEqual([['run.updated', '{"id":"run-1","status":"running"}']]);

      await vi.advanceTimersByTimeAsync(39);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(1);

      // The second stream closes immediately, so the next retry uses 80ms.
      await vi.advanceTimersByTimeAsync(79);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(3);

      controller.abort();
      await expect(streamPromise).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an active stream and a pending reconnect delay immediately', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamResponse());
      const streamPromise = openAuthEventStream(
        'http://localhost:3000/v1/projects/project-1/events',
        () => undefined,
        controller.signal,
        { initialReconnectDelayMs: 500, maxReconnectDelayMs: 500 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      controller.abort();
      await expect(streamPromise).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

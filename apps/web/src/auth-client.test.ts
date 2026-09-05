import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import {
  apiFetch,
  clearAuthSession,
  getAuthToken,
  notifyUnauthorized,
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

describe('App authentication gate', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    window.history.replaceState(null, '', '/workspace');
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ projects: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
  });

  afterEach(() => {
    cleanup();
    clearAuthSession();
    window.history.replaceState(null, '', '/');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('生产环境首次访问强制登录，不挂载工作区，也不能匿名退出', () => {
    render(createElement(App));

    const dialog = screen.getByRole('dialog', { name: '登录工作区' });
    expect(within(dialog).queryByRole('button', { name: '关闭登录' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '继续匿名使用' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '项目工作台', hidden: true }),
    ).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog.closest('.settings-backdrop')!);

    expect(dialog).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '项目工作台', hidden: true }),
    ).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { development: false, action: 'login' },
    { development: false, action: 'register' },
    { development: true, action: 'login' },
    { development: true, action: 'register' },
  ])('DEV=$development 时保留正常 $action 认证路径', async ({ development, action }) => {
    vi.stubEnv('DEV', development);
    vi.stubEnv('PROD', !development);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, 'http://localhost:3000');
      if (url.pathname === `/v1/auth/${action}`) {
        return new Response(JSON.stringify(response), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/v1/projects') {
        return new Response(JSON.stringify({ projects: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected auth regression request: ${url.pathname}`);
    });
    const user = userEvent.setup();
    render(createElement(App));
    if (development) act(() => notifyUnauthorized());

    if (action === 'register') {
      await user.click(screen.getByRole('button', { name: '创建账户' }));
      await user.type(screen.getByLabelText('显示名称（可选）'), '认证测试');
    }
    await user.type(screen.getByLabelText('邮箱'), response.user.email);
    await user.type(screen.getByLabelText('密码'), 'synthetic-test-password');
    await user.click(screen.getByRole('button', { name: action === 'login' ? '登录' : '注册' }));

    expect(await screen.findByRole('heading', { name: '项目工作台' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(readAuthSession()?.user.id).toBe(response.user.id);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/v1/auth/${action}$`)),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: response.user.email,
          password: 'synthetic-test-password',
          ...(action === 'register' ? { displayName: '认证测试' } : {}),
        }),
      }),
    );
  });

  it('生产环境恢复有效会话，但会话失效后重新阻止匿名访问工作区', async () => {
    persistAuthSession(response);
    render(createElement(App));

    expect(await screen.findByRole('heading', { name: '项目工作台' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => notifyUnauthorized());

    const dialog = screen.getByRole('dialog', { name: '登录工作区' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(dialog.closest('.settings-backdrop')!);
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '关闭登录' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '继续匿名使用' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '项目工作台', hidden: true }),
    ).not.toBeInTheDocument();
    expect(readAuthSession()).toBeNull();
  });

  it.each(['关闭登录', '继续匿名使用', 'backdrop', 'Escape'])(
    '开发环境保留匿名工作区和 %s 退出方式',
    async (dismissal) => {
      vi.stubEnv('DEV', true);
      vi.stubEnv('PROD', false);
      const user = userEvent.setup();
      render(createElement(App));
      expect(await screen.findByRole('heading', { name: '项目工作台' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      act(() => notifyUnauthorized());
      const dialog = screen.getByRole('dialog', { name: '登录工作区' });
      if (dismissal === 'Escape') {
        fireEvent.keyDown(document, { key: 'Escape' });
      } else if (dismissal === 'backdrop') {
        fireEvent.mouseDown(dialog.closest('.settings-backdrop')!);
      } else {
        await user.click(within(dialog).getByRole('button', { name: dismissal }));
      }

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '项目工作台' })).toBeInTheDocument();
      expect(readAuthSession()).toBeNull();
    },
  );
});

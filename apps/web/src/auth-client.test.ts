import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  apiFetch,
  clearAuthSession,
  persistAuthSession,
  readStoredAuthSession,
  readAuthSession,
  refreshAuthSession,
  fetchCurrentSession,
  AuthSessionChangedError,
  openAuthEventStream,
  startNewApiLogin,
} from './auth-client';
const user = {
  id: 'synthetic-user-a',
  displayName: '甲',
  role: 'user' as const,
  createdAt: '2026-09-21T00:00:00Z',
};
const session = { user, expiresAt: '2099-01-01T00:00:00Z' };
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearAuthSession();
});
/** 合成可控响应，用于验证身份切换后迟到结果不会提交。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('New API Cookie 会话', () => {
  it('显式换号仅向固定 Canvas 入口传递账号选择提示，普通登录保持兼容', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    startNewApiLogin('http://localhost:3000/', '/settings', 'select_account');
    const switching = new URL(assign.mock.calls[0][0]);
    expect(switching.pathname).toBe('/v1/auth/newapi/start');
    expect([...switching.searchParams]).toEqual([
      ['next', '/settings'],
      ['prompt', 'select_account'],
    ]);
    startNewApiLogin('http://localhost:3000');
    expect(new URL(assign.mock.calls[1][0]).searchParams.has('prompt')).toBe(false);
  });

  it('保存公开资料与到期时间，丢弃历史访问令牌', () => {
    persistAuthSession({ ...session, accessToken: 'synthetic-obsolete-token' });
    expect(readAuthSession()).toEqual(session);
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-obsolete-token');
  });
  it('无邮箱用户正常恢复，通过 Cookie 发送一次写请求且不注入 bearer', async () => {
    persistAuthSession(session);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await apiFetch('/v1/projects', { method: 'POST' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.credentials).toBe('include');
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
  });
  it('401 写请求只验证会话，不重试业务写入或误清已续期登录', async () => {
    persistAuthSession(session);
    const renewed = { ...session, expiresAt: '2099-02-01T00:00:00Z' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json(renewed));
    vi.stubGlobal('fetch', fetcher);
    expect((await apiFetch('/v1/projects', { method: 'POST' })).status).toBe(401);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/v1/projects',
      'http://localhost:3000/v1/auth/refresh',
    ]);
    expect(readAuthSession()).toEqual(renewed);
  });
  it('业务 401 后续期服务不可用时保留登录，服务端确认失效才清除', async () => {
    persistAuthSession(session);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await apiFetch('/v1/projects')).status).toBe(401);
    expect(readStoredAuthSession()).toEqual(session);
    await expect(apiFetch('/v1/projects')).rejects.toBeInstanceOf(AuthSessionChangedError);
    expect(readAuthSession()).toBeNull();
  });
  it('旧业务请求的迟到 401 不清除同一账户已续期的 Cookie', async () => {
    persistAuthSession(session);
    const delayed = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(delayed.promise);
    vi.stubGlobal('fetch', fetcher);
    const request = apiFetch('/v1/projects');
    const renewed = { ...session, expiresAt: '2099-02-01T00:00:00Z' };
    persistAuthSession(renewed, { renewal: true });
    delayed.resolve(new Response('{}', { status: 401 }));
    expect((await request).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readAuthSession()).toEqual(renewed);
  });
  it('换号中断旧请求，旧响应不清除新账号', async () => {
    persistAuthSession(session);
    const delayed = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(delayed.promise);
    vi.stubGlobal('fetch', fetcher);
    const request = apiFetch('/v1/projects');
    const rejected = expect(request).rejects.toBeInstanceOf(AuthSessionChangedError);
    persistAuthSession({ ...session, user: { ...user, id: 'synthetic-user-b' } });
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    delayed.resolve(new Response('{}', { status: 401 }));
    await rejected;
    expect(readAuthSession()?.user.id).toBe('synthetic-user-b');
  });
  it('恢复过期 Cookie 时先验证上游再续期，浏览器不接收令牌', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json(session));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchCurrentSession('http://localhost:3000')).toEqual(session);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:3000/v1/auth/me',
      'http://localhost:3000/v1/auth/refresh',
    ]);
    expect(fetcher.mock.calls[1]![1]?.method).toBe('POST');
  });
  it('并发页面恢复共享一次校验，身份切换后不复用旧请求', async () => {
    const firstResponse = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(
        Response.json({ ...session, user: { ...user, id: 'synthetic-user-b' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const first = fetchCurrentSession('http://localhost:3000/');
    expect(fetchCurrentSession('http://localhost:3000')).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    persistAuthSession({ ...session, user: { ...user, id: 'synthetic-user-b' } });
    const second = fetchCurrentSession('http://localhost:3000');
    expect(second).not.toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    firstResponse.resolve(Response.json(session));
    await expect(first).rejects.toBeInstanceOf(AuthSessionChangedError);
    expect((await second)?.user.id).toBe('synthetic-user-b');
    expect(readAuthSession()?.user.id).toBe('synthetic-user-b');
  });
  it('会话校验失败后允许重新检查，不缓存旧错误', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json(session));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchCurrentSession('http://localhost:3000')).rejects.toThrow('offline');
    expect(await fetchCurrentSession('http://localhost:3000')).toEqual(session);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('恢复会话及 401 续期不沿用 10 秒的单次请求预算', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchCurrentSession('http://localhost:3000')).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:3000/v1/auth/me',
      'http://localhost:3000/v1/auth/refresh',
      'http://localhost:3000/v1/auth/me',
    ]);
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      180_000, 180_000, 180_000,
    ]);
  });
  it('续期错误保留尚有效的作品会话，同一标签合并并发续期', async () => {
    persistAuthSession(session);
    const delayed = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(delayed.promise);
    vi.stubGlobal('fetch', fetcher);
    const a = refreshAuthSession(''),
      b = refreshAuthSession('');
    const rejected = Promise.all([expect(a).rejects.toThrow(), expect(b).rejects.toThrow()]);
    delayed.resolve(new Response('{}', { status: 503 }));
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readStoredAuthSession()).toEqual(session);
  });
  it('等待其它标签完成续期后复用公开状态，不重复轮换 Cookie', async () => {
    const initial = { user, expiresAt: '2020-01-01T00:00:00Z' };
    persistAuthSession(initial);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const request = vi.fn(async (_name: string, callback: () => unknown) => {
      localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify(session));
      return callback();
    });
    vi.stubGlobal('navigator', { locks: { request } });
    expect(await refreshAuthSession('')).toEqual(session);
    expect(request).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('并发 Cookie 轮换的迟到 401 只重读当前会话，不注销已更新身份', async () => {
    persistAuthSession(session);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json(session));
    vi.stubGlobal('fetch', fetcher);
    expect(await refreshAuthSession('')).toEqual(session);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/v1/auth/refresh', '/v1/auth/me']);
    expect(readAuthSession()).toEqual(session);
  });
});

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

    // 第二次事件流立即结束，下一次重连等待时间应翻倍为 80ms。
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

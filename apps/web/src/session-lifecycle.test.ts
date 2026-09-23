import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  clearAuthSession,
  getAuthToken,
  getAuthSessionGeneration,
  fetchCurrentSession,
  readAuthSession,
  logout,
  maintainAuthSession,
  persistAuthSession,
  refreshAuthSession,
  setUnauthorizedHandler,
  subscribeAuthSession,
  type AuthTokenResponse,
} from './auth-client';

/** 生成不包含真实信息的测试令牌响应，便于区分先后登录会话。 */
function session(id: string): AuthTokenResponse {
  return {
    accessToken: `synthetic-session-${id}`,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    user: { id, email: `${id}@example.test`, role: 'user', createdAt: '2026-01-01T00:00:00Z' },
  };
}

beforeEach(() => {
  localStorage.clear();
  clearAuthSession();
  setUnauthorizedHandler(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearAuthSession();
  setUnauthorizedHandler(undefined);
});

describe('会话隔离与恢复', () => {
  it('未临期的登录不会每分钟做上游目录同步', () => {
    persistAuthSession(session('a'));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const stop = maintainAuthSession('http://localhost:3000', vi.fn());
    expect(fetcher).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    expect(fetcher).not.toHaveBeenCalled();
    stop();
  });
  it('旧登录成功响应不能覆盖新账户，已退出的认证意图不能复活', async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetchCurrentSession('http://localhost:3000');
    persistAuthSession(session('b'));
    finish(Response.json(session('a')));
    await expect(pending).rejects.toThrow('账户状态已改变');
    expect(readAuthSession()?.user.id).toBe('b');
  });

  it('临近到期进入页面会立即续期，不等待首次30秒轮询', async () => {
    persistAuthSession({ ...session('a'), expiresAt: new Date(Date.now() + 10_000).toISOString() });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ ...session('a'), accessToken: 'synthetic-initial-renewal' }),
      );
    const stop = maintainAuthSession('http://localhost:3000', vi.fn());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(Date.parse(readAuthSession()!.expiresAt!)).toBeGreaterThan(Date.now() + 60_000),
    );
    stop();
  });

  it('标签页重新可见时会续期临近到期的会话', async () => {
    persistAuthSession({ ...session('a'), expiresAt: new Date(Date.now() + 10_000).toISOString() });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ ...session('a'), accessToken: 'synthetic-initial-renewal' }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...session('a'), accessToken: 'synthetic-visible-renewal' }),
      );
    const stop = maintainAuthSession('http://localhost:3000', vi.fn());
    await vi.waitFor(() =>
      expect(Date.parse(readAuthSession()!.expiresAt!)).toBeGreaterThan(Date.now() + 60_000),
    );
    persistAuthSession({
      ...session('a'),
      accessToken: 'synthetic-initial-renewal',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    stop();
  });

  it('过期访问令牌仍会尝试续期', async () => {
    persistAuthSession({ ...session('a'), expiresAt: new Date(Date.now() - 1_000).toISOString() });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        ...session('a'),
        accessToken: 'synthetic-expired-renewal',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    );
    const stop = maintainAuthSession('http://localhost:3000', vi.fn());
    await vi.waitFor(() =>
      expect(Date.parse(readAuthSession()!.expiresAt!)).toBeGreaterThan(Date.now()),
    );
    stop();
  });

  it('A 的晚到 401 不清除新登录 B 的身份', async () => {
    persistAuthSession(session('a'));
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const pending = apiFetch('/v1/projects');
    persistAuthSession(session('b'));
    finish(new Response('{}', { status: 401 }));
    await expect(pending).rejects.toThrow('账户状态已改变');
    expect(readAuthSession()?.user.id).toBe('b');
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('网络失败和403均保留当前登录，不重放写请求', async () => {
    persistAuthSession(session('a'));
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(apiFetch('/v1/projects', { method: 'POST' })).rejects.toThrow('offline');
    expect((await apiFetch('/v1/projects', { method: 'POST' })).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readAuthSession()?.user.id).toBe('a');
  });

  it('同一会话并发续期只发一次，退出后晚到续期不能重新登录', async () => {
    persistAuthSession(session('a'));
    let finish!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = refreshAuthSession('http://localhost:3000');
    const second = refreshAuthSession('http://localhost:3000');
    expect(fetcher).toHaveBeenCalledTimes(1);
    clearAuthSession();
    finish(Response.json({ ...session('a'), accessToken: 'synthetic-refreshed-a' }));
    await expect(first).rejects.toThrow('账户状态已改变');
    await expect(second).rejects.toThrow('账户状态已改变');
    expect(getAuthToken()).toBeUndefined();
  });

  it('续期保留用户身份并仅持久化公开资料', async () => {
    persistAuthSession(session('a'));
    const generation = getAuthSessionGeneration();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ ...session('a'), accessToken: 'synthetic-refreshed-a' }),
    );
    const renewed = await refreshAuthSession('http://localhost:3000');
    expect(renewed?.user.id).toBe('a');
    expect(getAuthToken()).toBeUndefined();
    expect(getAuthSessionGeneration()).toBe(generation);
  });

  it('续期响应体晚到不能覆盖同一令牌的新角色', async () => {
    const administrator = session('a');
    administrator.user.role = 'admin';
    persistAuthSession(administrator);
    let finishBody!: (value: AuthTokenResponse) => void;
    const response = Response.json({});
    const readBody = vi.spyOn(response, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBody = resolve;
        }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const pending = refreshAuthSession('http://localhost:3000');
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    const downgraded = persistAuthSession({
      ...administrator,
      user: { ...administrator.user, role: 'user' },
    });
    finishBody({ ...administrator, accessToken: 'synthetic-late-admin-renewal' });
    await expect(pending).rejects.toThrow('账户状态已改变');
    expect(readAuthSession()).toEqual(downgraded);
  });

  it('续期在途时主动退出，等待轮换结束后才撤销最新 Cookie', async () => {
    persistAuthSession(session('a'));
    let finishRefresh!: (response: Response) => void;
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ loggedOut: true }));
    const refreshing = refreshAuthSession('http://localhost:3000');
    const leaving = logout('http://localhost:3000');
    expect(fetcher).toHaveBeenCalledTimes(1);
    finishRefresh(Response.json(session('a')));
    await expect(refreshing).rejects.toThrow('账户状态已改变');
    await leaving;
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:3000/v1/auth/refresh',
      'http://localhost:3000/v1/auth/logout',
    ]);
    expect(readAuthSession()).toBeNull();
  });

  it('过期访问令牌的用户主动退出仍向服务端撤销 Cookie', async () => {
    persistAuthSession({ ...session('a'), expiresAt: new Date(Date.now() - 1000).toISOString() });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ loggedOut: true }));
    await logout('http://localhost:3000');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:3000/v1/auth/logout');
    expect(readAuthSession()).toBeNull();
  });

  it('显式退出立即清本地，服务端失败可见且不清之后登录的会话', async () => {
    persistAuthSession(session('a'));
    let fail!: (error: Error) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const pending = logout('http://localhost:3000');
    expect(getAuthToken()).toBeUndefined();
    persistAuthSession(session('b'));
    fail(new Error('offline'));
    await expect(pending).rejects.toThrow('账户状态已改变');
    expect(readAuthSession()?.user.id).toBe('b');
  });

  it('其他标签退出会同步清内存令牌', () => {
    persistAuthSession(session('a'));
    const listener = vi.fn();
    const stop = subscribeAuthSession(listener);
    localStorage.removeItem('multimodal-canvas:auth-session');
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'multimodal-canvas:auth-session', newValue: null }),
    );
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(getAuthToken()).toBeUndefined();
    stop();
  });
});

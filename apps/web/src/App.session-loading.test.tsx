import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 仅替换设置业务面板；保留 App、路由、会话客户端和 Ant Design 的真实行为。 */
vi.mock('./workspace/SettingsPanel', () => ({
  SettingsPanel: () => <section aria-label="已认证设置面板" />,
}));

import { App } from './App';
import * as auth from './auth-client';
import { buildAuthPagePath } from './routing/auth-navigation';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';

/** 只使用公开合成账户；不包含令牌，也不访问真实认证服务。 */
const session: auth.StoredAuthSession = {
  user: {
    id: 'session-loading-user',
    displayName: '等待页测试用户',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  expiresAt: '2099-01-01T00:00:00.000Z',
};

/** 可显式结束的模拟响应，用于验证认证完成前后的真实渲染边界。 */
function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((resolveResponse, rejectResponse) => {
    resolve = resolveResponse;
    reject = rejectResponse;
  });
  return { promise, resolve, reject };
}

/** 读取 fetch 输入的路径；兼容客户端使用字符串、URL 或 Request 的形式。 */
function requestPath(input: RequestInfo | URL) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(url, window.location.origin).pathname;
}

/** 将会话响应交由各测试控制，其余请求仅允许已认证路由的项目列表读取。 */
function installApi(handleAuth: (pathname: string, init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const pathname = requestPath(input);
    if (pathname.startsWith('/v1/auth/')) return handleAuth(pathname, init);
    if (pathname === '/v1/projects') return Promise.resolve(Response.json({ projects: [] }));
    throw new Error(`未声明的测试请求：${init?.method ?? 'GET'} ${pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/settings');
  window.localStorage.clear();
  auth.clearAuthSession();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
});

afterEach(() => {
  cleanup();
  auth.clearAuthSession();
  window.localStorage.clear();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App 会话恢复反馈', () => {
  it('慢请求期间不开放私有设置，10 秒只更换说明，成功后撤下等待页', async () => {
    auth.persistAuthSession(session);
    useWorkspacePreferences.setState({ canvasTheme: 'dark' });
    const response = deferredResponse();
    const fetcher = installApi(() => response.promise);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    render(<App />);

    expect(screen.getByRole('status')).toHaveTextContent('正在恢复登录状态');
    expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(fetcher.mock.calls.map(([input]) => requestPath(input))).toEqual(['/v1/auth/me']);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe('include');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
    expect(timeout).toHaveBeenCalledWith(180_000);

    await act(async () => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('status')).toHaveTextContent('登录状态恢复耗时较长');
    expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(auth.readStoredAuthSession()).toEqual(session);

    await act(async () => response.resolve(Response.json(session)));
    expect(screen.getByRole('region', { name: '已认证设置面板' })).toBeInTheDocument();
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.queryByText(/登录状态恢复耗时较长/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(auth.readStoredAuthSession()).toEqual(session);
  });

  it('快速成功时卸载等待页并清除未触发的 10 秒提示', async () => {
    const response = deferredResponse();
    installApi(() => response.promise);
    const timer = vi.spyOn(window, 'setTimeout');
    const clearTimer = vi.spyOn(window, 'clearTimeout');
    render(<App />);
    const hintIndex = timer.mock.calls.findIndex(([, delay]) => delay === 10_000);
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    const hintTimer = timer.mock.results[hintIndex].value;

    await act(async () => response.resolve(Response.json(session)));
    expect(screen.getByRole('region', { name: '已认证设置面板' })).toBeInTheDocument();
    expect(clearTimer).toHaveBeenCalledWith(hintTimer);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText(/登录状态恢复耗时较长/)).not.toBeInTheDocument();
  });

  it.each(['http', 'network', 'timeout'] as const)(
    '%s 失败后撤下等待页，沿用原错误提示和未认证路由限制',
    async (failure) => {
      const response = deferredResponse();
      const fetcher = installApi(() => response.promise);
      render(<App />);
      expect(screen.getByRole('status')).toHaveTextContent('正在恢复登录状态');

      await act(async () => {
        if (failure === 'http')
          response.resolve(Response.json({ error: '会话服务暂不可用' }, { status: 503 }));
        else if (failure === 'network') response.reject(new TypeError('网络连接失败'));
        else response.reject(new DOMException('The operation timed out', 'TimeoutError'));
      });

      expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        `${failure === 'http' ? '会话服务暂不可用' : failure === 'network' ? '网络连接失败' : 'Canvas API 会话校验超时'}，当前内容已保留，请检查 Canvas API 连接。`,
      );
      expect(screen.getByRole('heading', { name: '请先登录' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
      expect(auth.readStoredAuthSession()).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(window.location.pathname).toBe('/settings');
    },
  );

  it('暂时网络失败不清除已有会话，继续使用原有保留内容策略', async () => {
    auth.persistAuthSession(session);
    const response = deferredResponse();
    installApi(() => response.promise);
    render(<App />);
    await act(async () => response.reject(new TypeError('网络连接失败')));
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('当前内容已保留');
    expect(auth.readStoredAuthSession()).toEqual(session);
    expect(screen.getByRole('region', { name: '已认证设置面板' })).toBeInTheDocument();
  });

  it('首次 401 的续期仍显示等待页，续期成功后不误退出已有账号', async () => {
    auth.persistAuthSession(session);
    const renewal = deferredResponse();
    const fetcher = installApi((pathname) =>
      pathname === '/v1/auth/me'
        ? Promise.resolve(Response.json({}, { status: 401 }))
        : renewal.promise,
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await act(async () => {
      render(<App />);
    });
    expect(fetcher.mock.calls.map(([input]) => requestPath(input))).toEqual([
      '/v1/auth/me',
      '/v1/auth/refresh',
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('正在恢复登录状态');
    expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
    expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([180_000, 180_000]);
    await act(async () => renewal.resolve(Response.json(session)));
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '已认证设置面板' })).toBeInTheDocument();
    expect(auth.readStoredAuthSession()).toEqual(session);
    expect(window.location.pathname).toBe('/settings');
  });

  it('服务端三次确认 401 后保留既有清会话及私有页登录跳转行为', async () => {
    auth.persistAuthSession(session);
    const response = deferredResponse();
    const fetcher = installApi(() => response.promise);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    render(<App />);
    await act(async () => response.resolve(Response.json({}, { status: 401 })));
    expect(fetcher.mock.calls.map(([input]) => requestPath(input))).toEqual([
      '/v1/auth/me',
      '/v1/auth/refresh',
      '/v1/auth/me',
    ]);
    expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([180_000, 180_000, 180_000]);
    expect(auth.readStoredAuthSession()).toBeNull();
    expect(window.location.pathname + window.location.search).toBe(buildAuthPagePath('/settings'));
    expect(screen.getByRole('heading', { name: '使用 New API 登录' })).toBeInTheDocument();
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('公开工作台确认未登录后不强制跳转，也不读取私有项目', async () => {
    window.history.replaceState(null, '', '/workspace');
    const response = deferredResponse();
    const fetcher = installApi(() => response.promise);
    render(<App />);
    await act(async () => response.resolve(Response.json({}, { status: 401 })));
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '项目工作台' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/workspace');
    expect(fetcher.mock.calls.every(([input]) => requestPath(input).startsWith('/v1/auth/'))).toBe(
      true,
    );
  });

  it('等待中卸载 App 会清理提示，迟到响应不会重新挂载页面', async () => {
    const response = deferredResponse();
    installApi(() => response.promise);
    const timer = vi.spyOn(window, 'setTimeout');
    const clearTimer = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(<App />);
    const hintIndex = timer.mock.calls.findIndex(([, delay]) => delay === 10_000);
    expect(hintIndex).toBeGreaterThanOrEqual(0);
    const hintTimer = timer.mock.results[hintIndex].value;
    unmount();
    expect(clearTimer).toHaveBeenCalledWith(hintTimer);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      response.resolve(Response.json(session));
    });
    expect(screen.queryByText('正在恢复登录状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '已认证设置面板' })).not.toBeInTheDocument();
  });
});

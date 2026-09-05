import '@testing-library/jest-dom/vitest';

import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
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
import { projectQueryKeys } from './query/projects';
import { navigateApp } from './routing';

/** 仅用于本地模拟请求的合成会话，不包含真实账户或凭据。 */
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

/** 将给定事件片段编码为会正常结束的模拟 SSE 响应。 */
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

/** 模拟保持连接的 SSE 响应，由调用方取消请求。 */
function pendingStreamResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** 构造模拟 API 的 JSON 响应，不发起真实网络请求。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 通过标准 URL 解析器统一提取 fetch 各种输入形式的路径。 */
function requestPath(input: RequestInfo | URL): string {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(rawUrl, 'http://localhost:3000').pathname;
}

/** 返回指定方法的项目集合请求，区分读取列表与有副作用的创建操作。 */
function projectRequests(method: 'GET' | 'POST') {
  return vi.mocked(globalThis.fetch).mock.calls.filter(([input, init]) => {
    const requestMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return requestPath(input) === '/v1/projects' && requestMethod.toUpperCase() === method;
  });
}

/** 在当前认证弹窗提交合成账户；注册时同时填写可选显示名称。 */
async function submitAuthentication(
  user: ReturnType<typeof userEvent.setup>,
  action: 'login' | 'register' = 'login',
  email = response.user.email,
) {
  const dialog = screen.getByRole('dialog', { name: '登录工作区' });
  if (action === 'register') {
    await user.click(within(dialog).getByRole('button', { name: '创建账户' }));
    await user.type(within(dialog).getByLabelText('显示名称（可选）'), '认证测试');
  }
  await user.type(within(dialog).getByLabelText('邮箱'), email);
  await user.type(within(dialog).getByLabelText('密码'), 'synthetic-test-password');
  await user.click(
    within(dialog).getByRole('button', { name: action === 'login' ? '登录' : '注册' }),
  );
}

/** 校验匿名工作台为空态，且不会因禁用查询而永久加载或禁用创建入口。 */
function expectAnonymousWorkspace() {
  expect(screen.getByRole('heading', { name: '项目工作台' })).toBeVisible();
  expect(screen.getByText('还没有项目')).toBeVisible();
  expect(screen.queryByText('正在加载项目')).not.toBeInTheDocument();
  expect(screen.queryByText('正在读取项目')).not.toBeInTheDocument();
  expect(screen.queryByText('项目列表加载失败')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  for (const trigger of screen.getAllByRole('button', { name: '新建项目' })) {
    expect(trigger).toBeEnabled();
  }
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
});

describe.each([{ development: false }, { development: true }])(
  'App 按需认证（DEV=$development）',
  ({ development }) => {
    beforeEach(() => {
      localStorage.clear();
      clearAuthSession();
      window.history.replaceState(null, '', '/workspace');
      vi.stubEnv('DEV', development);
      vi.stubEnv('PROD', !development);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const path = requestPath(input);
        const method = init?.method ?? 'GET';
        if (path === '/v1/projects' && method === 'GET') return jsonResponse({ projects: [] });
        if ((path === '/v1/auth/login' || path === '/v1/auth/register') && method === 'POST') {
          return jsonResponse(response);
        }
        throw new Error(`未预期的认证回归请求：${method} ${path}`);
      });
    });

    afterEach(() => {
      cleanup();
      setUnauthorizedHandler(undefined);
      clearAuthSession();
      localStorage.clear();
      window.history.replaceState(null, '', '/');
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('匿名首页无需登录，可进入工作台且不读取私有项目列表', async () => {
      window.history.replaceState(null, '', '/');
      const user = userEvent.setup();
      render(createElement(App));

      expect(screen.getByRole('heading', { name: 'Multimodal Canvas' })).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(globalThis.fetch).not.toHaveBeenCalled();

      await user.click(screen.getByRole('link', { name: /进入工作台/ }));

      expect(window.location.pathname).toBe('/workspace');
      expectAnonymousWorkspace();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([0, 1])('匿名工作台的新建入口 %i 只弹登录，不发送项目 POST', async (triggerIndex) => {
      const user = userEvent.setup();
      render(createElement(App));

      expectAnonymousWorkspace();
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[triggerIndex]!);

      expect(screen.getByRole('dialog', { name: '登录工作区' })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
      expect(projectRequests('POST')).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each(['关闭登录', '继续匿名使用', 'backdrop', 'Escape'])(
      '%s 可取消登录并将焦点恢复至新建入口',
      async (dismissal) => {
        const user = userEvent.setup();
        render(createElement(App));
        const trigger = screen.getAllByRole('button', { name: '新建项目' })[0]!;

        await user.click(trigger);
        const dialog = screen.getByRole('dialog', { name: '登录工作区' });
        expect(within(dialog).getByLabelText('邮箱')).toHaveFocus();
        if (dismissal === 'Escape') {
          await user.keyboard('{Escape}');
        } else if (dismissal === 'backdrop') {
          fireEvent.mouseDown(dialog.closest('.settings-backdrop')!);
        } else {
          await user.click(within(dialog).getByRole('button', { name: dismissal }));
        }

        expectAnonymousWorkspace();
        await waitFor(() => expect(trigger).toHaveFocus());
        expect(readAuthSession()).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it.each(['login', 'register'] as const)(
      '%s 成功续接新建表单，不自动创建项目',
      async (action) => {
        const user = userEvent.setup();
        render(createElement(App));
        await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);

        await submitAuthentication(user, action);

        const createDialog = await screen.findByRole('dialog', { name: '新建项目' });
        expect(screen.queryByRole('dialog', { name: '登录工作区' })).not.toBeInTheDocument();
        expect(within(createDialog).getByLabelText('项目名称')).toHaveValue('未命名项目');
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
        await waitFor(() => expect(projectRequests('GET')).toHaveLength(1));
        expect(new Headers(projectRequests('GET')[0]?.[1]?.headers).get('authorization')).toBe(
          `Bearer ${response.accessToken}`,
        );
        expect(projectRequests('POST')).toHaveLength(0);

        await user.click(within(createDialog).getByRole('button', { name: '取消' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(projectRequests('POST')).toHaveLength(0);
        await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
        expect(screen.getByRole('dialog', { name: '新建项目' })).toBeVisible();
        expect(screen.queryByRole('dialog', { name: '登录工作区' })).not.toBeInTheDocument();
        expect(projectRequests('POST')).toHaveLength(0);
      },
    );

    it('认证失败保留登录表单，取消后仍可匿名浏览', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        jsonResponse({ error: 'invalid email or password' }, 401),
      );
      const user = userEvent.setup();
      render(createElement(App));
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);

      await submitAuthentication(user);

      const dialog = screen.getByRole('dialog', { name: '登录工作区' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('邮箱或密码不正确');
      expect(readAuthSession()).toBeNull();
      expect(projectRequests('POST')).toHaveLength(0);
      await user.click(within(dialog).getByRole('button', { name: '关闭登录' }));
      expectAnonymousWorkspace();
    });

    it('恢复有效会话后直接打开创建表单，不重复要求认证', async () => {
      persistAuthSession(response);
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByText('还没有项目');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);

      expect(screen.getByRole('dialog', { name: '新建项目' })).toBeVisible();
      expect(projectRequests('GET')).toHaveLength(1);
      expect(projectRequests('POST')).toHaveLength(0);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['/workspace', '/projects/private-project'])(
      '进入 %s 时丢弃已过期会话，不请求私有数据或自动弹登录',
      (pathname) => {
        persistAuthSession({ ...response, expiresAt: new Date(Date.now() - 1_000).toISOString() });
        window.history.replaceState(null, '', pathname);
        render(createElement(App));

        if (pathname === '/workspace') expectAnonymousWorkspace();
        else expect(screen.getByRole('heading', { name: '请先登录' })).toBeVisible();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(readAuthSession()).toBeNull();
        expect(getAuthToken()).toBeUndefined();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it('浏览期间会话过期时，新建入口重新检查有效期并提示登录', async () => {
      persistAuthSession(response);
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByText('还没有项目');
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(response.expiresAt) + 1);

      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);

      expect(screen.getByRole('dialog', { name: '登录工作区' })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
      expect(getAuthToken()).toBeUndefined();
      expect(projectRequests('POST')).toHaveLength(0);
      expect(projectRequests('GET')).toHaveLength(1);
      await user.keyboard('{Escape}');
      expectAnonymousWorkspace();
    });

    it('填写创建表单期间会话过期，提交前先认证且不发送过期项目 POST', async () => {
      persistAuthSession(response);
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByText('还没有项目');
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
      const createDialog = screen.getByRole('dialog', { name: '新建项目' });
      await user.clear(within(createDialog).getByLabelText('项目名称'));
      await user.type(within(createDialog).getByLabelText('项目名称'), '过期后继续编辑');
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(response.expiresAt) + 1);

      await user.click(within(createDialog).getByRole('button', { name: '创建项目' }));

      expect(screen.getByRole('dialog', { name: '登录工作区' })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
      expect(getAuthToken()).toBeUndefined();
      expect(projectRequests('POST')).toHaveLength(0);
      now.mockRestore();
      await submitAuthentication(user);
      const resumedDialog = await screen.findByRole('dialog', { name: '新建项目' });
      expect(within(resumedDialog).getByLabelText('项目名称')).toHaveValue('过期后继续编辑');
      expect(projectRequests('POST')).toHaveLength(0);
    });

    it.each(['/projects/private-project', '/settings', '/settings?project=private-project'])(
      '匿名进入 %s 只显示登录状态，取消登录或返回工作台均不请求私有数据',
      async (pathname) => {
        window.history.replaceState(null, '', pathname);
        const user = userEvent.setup();
        render(createElement(App));

        expect(screen.getByRole('heading', { name: '请先登录' })).toBeVisible();
        expect(screen.queryByRole('application')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        const trigger = screen.getByRole('button', { name: '登录' });
        await user.click(trigger);
        expect(screen.getByRole('dialog', { name: '登录工作区' })).toBeVisible();
        await user.keyboard('{Escape}');
        expect(screen.getByRole('heading', { name: '请先登录' })).toBeVisible();
        expect(trigger).toHaveFocus();
        expect(globalThis.fetch).not.toHaveBeenCalled();

        await user.click(screen.getByRole('link', { name: '返回工作台' }));
        expect(window.location.pathname).toBe('/workspace');
        expectAnonymousWorkspace();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it('取消新建登录后清除续接操作，随后私有路由登录不会误开创建表单', async () => {
      const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        if (requestPath(input) === '/v1/projects/private-project') {
          return jsonResponse({ error: 'project not found' }, 404);
        }
        return defaultFetch(input, init);
      });
      const user = userEvent.setup();
      render(createElement(App));
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
      await user.keyboard('{Escape}');
      act(() => navigateApp('/projects/private-project'));
      await user.click(screen.getByRole('button', { name: '登录' }));

      await submitAuthentication(user);

      expect(await screen.findByRole('heading', { name: '项目不存在' })).toBeVisible();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(projectRequests('POST')).toHaveLength(0);
    });

    it('公共列表 401 清空旧账户缓存且不弹登录，新账户读取期间也不回显旧项目', async () => {
      const oldProject = {
        id: 'old-user-project',
        name: '旧账户私有项目',
        createdAt: response.user.createdAt,
        updatedAt: response.user.createdAt,
      };
      const newProject = { ...oldProject, id: 'new-user-project', name: '新账户私有项目' };
      const nextSession: AuthTokenResponse = {
        ...response,
        accessToken: 'synthetic-next-user-token',
        user: { ...response.user, id: 'user-2', email: 'next@example.com' },
      };
      /** 保持新账户的列表请求未完成，以检查加载过程中是否泄漏旧缓存。 */
      let completeNextProjects!: (value: Response) => void;
      const nextProjectsResponse = new Promise<Response>((resolve) => {
        completeNextProjects = resolve;
      });
      /** 首次读取成功，后续模拟旧会话被服务端撤销。 */
      let oldSessionRevoked = false;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const path = requestPath(input);
        if (path === '/v1/auth/login' && init?.method === 'POST') return jsonResponse(nextSession);
        if (path === '/v1/projects' && (init?.method ?? 'GET') === 'GET') {
          const authorization = new Headers(init?.headers).get('authorization');
          if (authorization === `Bearer ${nextSession.accessToken}`) return nextProjectsResponse;
          if (authorization === `Bearer ${response.accessToken}`) {
            return oldSessionRevoked
              ? jsonResponse({ error: 'authentication required' }, 401)
              : jsonResponse({ projects: [oldProject] });
          }
        }
        throw new Error(`未预期的账户隔离请求：${init?.method ?? 'GET'} ${path}`);
      });
      persistAuthSession(response);
      const mount = vi.spyOn(QueryClient.prototype, 'mount');
      const user = userEvent.setup();
      render(createElement(App));
      expect(await screen.findByRole('link', { name: oldProject.name })).toBeVisible();
      // 观察实际挂载的 QueryClient，不替换生产 Provider 或查询实现。
      const queryClient = mount.mock.contexts[0] as QueryClient;
      expect(queryClient).toBeInstanceOf(QueryClient);
      expect(queryClient.getQueryData(projectQueryKeys.list())).toEqual([oldProject]);
      queryClient.setQueryData(projectQueryKeys.detail(oldProject.id), oldProject);
      oldSessionRevoked = true;

      await act(async () => {
        await queryClient.refetchQueries({ queryKey: projectQueryKeys.list() });
      });

      expectAnonymousWorkspace();
      expect(readAuthSession()).toBeNull();
      expect(getAuthToken()).toBeUndefined();
      expect(screen.queryByText(oldProject.name)).not.toBeInTheDocument();
      expect(queryClient.getQueryData(projectQueryKeys.list())).toBeUndefined();
      expect(queryClient.getQueryData(projectQueryKeys.detail(oldProject.id))).toBeUndefined();
      expect(projectRequests('GET')).toHaveLength(2);
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
      await submitAuthentication(user, 'login', nextSession.user.email);

      const createDialog = await screen.findByRole('dialog', { name: '新建项目' });
      await waitFor(() => expect(projectRequests('GET')).toHaveLength(3));
      expect(readAuthSession()?.user.id).toBe(nextSession.user.id);
      expect(screen.queryByText(oldProject.name)).not.toBeInTheDocument();
      expect(queryClient.getQueryData(projectQueryKeys.list())).toBeUndefined();
      expect(new Headers(projectRequests('GET')[2]?.[1]?.headers).get('authorization')).toBe(
        `Bearer ${nextSession.accessToken}`,
      );
      expect(projectRequests('POST')).toHaveLength(0);
      await act(async () => completeNextProjects(jsonResponse({ projects: [newProject] })));
      expect(await screen.findByRole('link', { name: newProject.name })).toBeVisible();
      expect(queryClient.getQueryData(projectQueryKeys.list())).toEqual([newProject]);
      await user.click(within(createDialog).getByRole('button', { name: '取消' }));
      expect(screen.queryByText(oldProject.name)).not.toBeInTheDocument();
      expect(projectRequests('POST')).toHaveLength(0);
    });

    it.each(['/projects/private-project', '/settings?project=private-project'])(
      '已认证的 %s 返回 401 后可关闭登录并返回公共工作台',
      async (pathname) => {
        const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
        vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
          if (requestPath(input) === '/v1/projects/private-project') {
            return jsonResponse({ error: 'authentication required' }, 401);
          }
          return defaultFetch(input, init);
        });
        persistAuthSession(response);
        window.history.replaceState(null, '', pathname);
        const user = userEvent.setup();
        render(createElement(App));

        expect(await screen.findByRole('dialog', { name: '登录工作区' })).toBeVisible();
        expect(readAuthSession()).toBeNull();
        await user.keyboard('{Escape}');
        expect(screen.getByRole('heading', { name: '请先登录' })).toBeVisible();
        const requestsBeforeLeaving = vi.mocked(globalThis.fetch).mock.calls.length;
        await user.click(screen.getByRole('link', { name: '返回工作台' }));
        expectAnonymousWorkspace();
        expect(globalThis.fetch).toHaveBeenCalledTimes(requestsBeforeLeaving);
        expect(projectRequests('POST')).toHaveLength(0);
      },
    );

    it('创建 POST 返回 401 时明确请求登录，认证成功只恢复表单而不重放 POST', async () => {
      const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        if (requestPath(input) === '/v1/projects' && init?.method === 'POST') {
          return jsonResponse({ error: 'authentication required' }, 401);
        }
        return defaultFetch(input, init);
      });
      persistAuthSession(response);
      const user = userEvent.setup();
      render(createElement(App));
      await screen.findByText('还没有项目');
      await user.click(screen.getAllByRole('button', { name: '新建项目' })[0]!);
      const createDialog = screen.getByRole('dialog', { name: '新建项目' });
      await user.clear(within(createDialog).getByLabelText('项目名称'));
      await user.type(within(createDialog).getByLabelText('项目名称'), '重新认证后手动创建');

      await user.click(within(createDialog).getByRole('button', { name: '创建项目' }));

      expect(await screen.findByRole('dialog', { name: '登录工作区' })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
      expect(readAuthSession()).toBeNull();
      expect(projectRequests('POST')).toHaveLength(1);
      expect(JSON.parse(String(projectRequests('POST')[0]?.[1]?.body))).toEqual({
        name: '重新认证后手动创建',
      });
      await submitAuthentication(user);

      const resumedDialog = await screen.findByRole('dialog', { name: '新建项目' });
      expect(within(resumedDialog).getByLabelText('项目名称')).toHaveValue('重新认证后手动创建');
      expect(projectRequests('POST')).toHaveLength(1);
      await user.click(within(resumedDialog).getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(projectRequests('POST')).toHaveLength(1);
    });
  },
);

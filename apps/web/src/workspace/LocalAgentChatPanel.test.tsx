import '@testing-library/jest-dom/vitest';
import { ConfigProvider } from 'antd';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  let listener: ((session: null) => void) | undefined;
  return {
    apiFetch: vi.fn(),
    getAuthSessionGeneration: vi.fn(() => 7),
    subscribeAuthSession: vi.fn((next: (session: null) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    changeSession: () => listener?.(null),
  };
});
vi.mock('../auth-client', () => auth);
const configuration = vi.hoisted(() => ({ apiBaseUrl: 'http://localhost:3000' }));
vi.mock('./contracts', () => ({
  get API_BASE_URL() {
    return configuration.apiBaseUrl;
  },
}));

import { LocalAgentChatPanel } from './LocalAgentChatPanel';

const projectId = 'project / one';
const baseUrl = 'http://localhost:3000';
const localBase = 'http://127.0.0.1:17871';
const urlConnectionsEndpoint = `${baseUrl}/v1/projects/project%20%2F%20one/agent-url-connections`;
const signature = 'synthetic-project-connection-key'.padEnd(43, '_');
const connectionKey = `0f8fad5b-d9cb-469f-a165-70867728950e.${signature}`;
const mcpPath = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=${connectionKey}`;
const STORAGE_KEY = 'canvas-agent-local-connection';

/** 拦截浏览器对本机桥接服务的 fetch。 */
const localFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function mount(open = true, saveCanvas = vi.fn<() => Promise<void>>().mockResolvedValue()) {
  const onClose = vi.fn();
  const view = render(
    <LocalAgentChatPanel
      projectId={projectId}
      open={open}
      onClose={onClose}
      saveCanvas={saveCanvas}
    />,
    {
      wrapper: ({ children }) => (
        <ConfigProvider button={{ autoInsertSpace: false }} theme={{ token: { motion: false } }}>
          {children}
        </ConfigProvider>
      ),
    },
  );
  return { ...view, onClose, saveCanvas };
}

function urlConnectionsResponse(key = connectionKey) {
  return Response.json({
    available: true,
    connections: [
      {
        id: 'conn-one',
        projectId,
        allowGeneration: true,
        createdAt: '2026-10-18T00:00:00.000Z',
        expiresAt: null,
        mcpPath: mcpPath.replace(connectionKey, key),
      },
    ],
  });
}

/** Build a minimal ReadableStream that emits the given SSE lines and then closes. */
function sseStream(...lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

type LocalRoutes = {
  health?: () => Response | Promise<Response>;
  session?: (init?: RequestInit) => Response | Promise<Response>;
  events?: () => Response | Promise<Response>;
  prompt?: () => Response | Promise<Response>;
  cancel?: () => Response | Promise<Response>;
  remove?: () => Response | Promise<Response>;
};

function routeLocal(routes: LocalRoutes = {}) {
  localFetch.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === `${localBase}/health`) {
      return routes.health?.() ?? Response.json({ ok: true, agent: 'claude' });
    }
    if (url === `${localBase}/sessions` && method === 'POST') {
      return routes.session?.(init) ?? Response.json({ sessionId: 'sess-abc' }, { status: 201 });
    }
    if (url === `${localBase}/sessions/sess-abc/events`) {
      return routes.events?.() ?? new Response(sseStream(), { status: 200 });
    }
    if (url === `${localBase}/sessions/sess-abc/prompt` && method === 'POST') {
      return routes.prompt?.() ?? new Response(null, { status: 202 });
    }
    if (url === `${localBase}/sessions/sess-abc/cancel` && method === 'POST') {
      return routes.cancel?.() ?? new Response(null, { status: 204 });
    }
    if (url === `${localBase}/sessions/sess-abc` && method === 'DELETE') {
      return routes.remove?.() ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected local request: ${method} ${url}`);
  });
}

async function connectWith(user: ReturnType<typeof userEvent.setup>) {
  const tokenInput = screen.getByLabelText('连接令牌') as HTMLInputElement;
  if (!tokenInput.value) await user.type(tokenInput, 'test-token');
  await user.click(screen.getByRole('button', { name: '连接' }));
  await screen.findByRole('textbox', { name: '输入消息' });
}

function sessionCallInit() {
  const call = localFetch.mock.calls.find(
    ([input, init]) => String(input) === `${localBase}/sessions` && init?.method === 'POST',
  );
  return call?.[1];
}

beforeEach(() => {
  auth.getAuthSessionGeneration.mockReturnValue(7);
  configuration.apiBaseUrl = 'http://localhost:3000';
  window.localStorage.clear();
  vi.stubGlobal('fetch', localFetch);
});

afterEach(() => {
  cleanup();
  auth.apiFetch.mockReset();
  auth.subscribeAuthSession.mockClear();
  localFetch.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LocalAgentChatPanel（直连本地 Agent）', () => {
  it('关闭时不请求；打开后展示默认本地地址与空令牌', () => {
    const view = mount(false);
    expect(auth.apiFetch).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
    view.rerender(
      <LocalAgentChatPanel
        projectId={projectId}
        open
        onClose={view.onClose}
        saveCanvas={view.saveCanvas}
      />,
    );
    expect(screen.getByLabelText('本地地址')).toHaveValue(localBase);
    expect(screen.getByLabelText('连接令牌')).toHaveValue('');
    expect(auth.apiFetch).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it('回填本地保存过的地址与令牌', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ url: 'http://127.0.0.1:19000', token: 'stored-token' }),
    );
    mount();
    expect(screen.getByLabelText('本地地址')).toHaveValue('http://127.0.0.1:19000');
    expect(screen.getByLabelText('连接令牌')).toHaveValue('stored-token');
  });

  it('未填令牌时提示，且不发起任何请求', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(screen.getByText('请先填入桥接程序启动时打印的连接令牌')).toBeVisible();
    expect(localFetch).not.toHaveBeenCalled();
    expect(auth.apiFetch).not.toHaveBeenCalled();
  });

  it('连接流程：探活 → 复用画布连接 → 建立本地会话', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal();
    mount();
    await connectWith(user);

    expect(localFetch.mock.calls[0]?.[0]).toBe(`${localBase}/health`);
    expect(JSON.parse(String(sessionCallInit()?.body))).toEqual({
      projectId,
      mcpUrl: `${baseUrl}${mcpPath}`,
    });
    expect(sessionCallInit()?.headers).toMatchObject({
      authorization: 'Bearer test-token',
    });
    expect(await screen.findByText('已连接本机 Agent')).toBeVisible();
  });

  it('把连接信息写入本地存储，健康检查里的 Agent 名称会被展示', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal({ health: () => Response.json({ ok: true, agent: 'codex' }) });
    mount();
    await user.type(screen.getByLabelText('连接令牌'), 'local-secret');
    await connectWith(user);
    expect(await screen.findByText(/已连接本机 Agent/)).toBeVisible();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ url: localBase, token: 'local-secret' }),
    );
  });

  it('没有活跃画布连接时自动创建并使用返回的 mcpPath', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(Response.json({ available: true, connections: [] }))
      .mockResolvedValueOnce(
        Response.json({ connection: { id: 'conn-new', mcpPath } }, { status: 201 }),
      );
    routeLocal();
    mount();
    await connectWith(user);

    expect(auth.apiFetch.mock.calls[0]?.[0]).toBe(urlConnectionsEndpoint);
    expect(auth.apiFetch.mock.calls[1]?.[0]).toBe(urlConnectionsEndpoint);
    expect(auth.apiFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(sessionCallInit()?.body))).toEqual({
      projectId,
      mcpUrl: `${baseUrl}${mcpPath}`,
    });
  });

  it('画布连接数达到上限时给出可操作提示', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(Response.json({ available: true, connections: [] }))
      .mockResolvedValueOnce(Response.json({ code: 'connection_limit' }, { status: 409 }));
    routeLocal();
    mount();
    await user.type(screen.getByLabelText('连接令牌'), 'local-secret');
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(
      await screen.findByText('画布连接数已达上限，请先在 Agent 连接面板删除旧连接'),
    ).toBeVisible();
    expect(sessionCallInit()).toBeUndefined();
  });

  it('本地服务未启动时提示检查桥接程序', async () => {
    const user = userEvent.setup();
    localFetch.mockRejectedValue(new TypeError('fetch failed'));
    mount();
    await user.type(screen.getByLabelText('连接令牌'), 'local-secret');
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(
      await screen.findByText('无法连接本地 Agent 服务，请确认桥接程序已在本机运行'),
    ).toBeVisible();
    expect(auth.apiFetch).not.toHaveBeenCalled();
  });

  it('本地令牌错误时提示核对 Connect token', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal({ session: () => Response.json({ error: 'unauthorized' }, { status: 401 }) });
    mount();
    await user.type(screen.getByLabelText('连接令牌'), 'wrong-token');
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(
      await screen.findByText('连接令牌无效，请核对桥接程序启动时打印的 Connect token'),
    ).toBeVisible();
  });

  it('发送前调用 saveCanvas，然后 POST 本机 prompt，SSE 事件更新消息列表', async () => {
    const user = userEvent.setup();
    const sseDeferred = deferred<Response>();
    const saveCanvas = vi.fn<() => Promise<void>>().mockResolvedValue();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal({ events: () => sseDeferred.promise });
    mount(true, saveCanvas);
    await connectWith(user);

    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'hello agent');
    await user.keyboard('{Enter}');

    expect(saveCanvas).toHaveBeenCalledOnce();
    const promptCall = localFetch.mock.calls.find(([input]) =>
      String(input).endsWith('/sessions/sess-abc/prompt'),
    );
    expect(promptCall?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(promptCall?.[1]?.body))).toEqual({
      messages: [{ role: 'user', content: 'hello agent' }],
    });

    const chunkEvent = `data: ${JSON.stringify({ type: 'agent_message_chunk', text: 'Hi there' })}\n\n`;
    const doneEvent = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
    await act(async () =>
      sseDeferred.resolve(new Response(sseStream(chunkEvent, doneEvent), { status: 200 })),
    );
    expect(await screen.findByText('Hi there')).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument(),
    );
  });

  it('发送失败时显示提示', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal({ prompt: () => Response.json({ error: 'boom' }, { status: 500 }) });
    mount();
    await connectWith(user);
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'test prompt');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('发送失败，请重试')).toBeVisible();
  });

  it('tool_call 事件在消息列表中渲染工具名', async () => {
    const user = userEvent.setup();
    const sseDeferred = deferred<Response>();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal({ events: () => sseDeferred.promise });
    mount();
    await connectWith(user);
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'do something');
    await user.keyboard('{Enter}');
    const toolEvent = `data: ${JSON.stringify({ type: 'tool_call', name: 'create_node' })}\n\n`;
    await act(async () => sseDeferred.resolve(new Response(sseStream(toolEvent), { status: 200 })));
    expect(await screen.findByText(/create_node/)).toBeVisible();
  });

  it('流式输出期间点停止按钮 POST 本机 cancel', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal();
    mount();
    await connectWith(user);
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'go');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: '停止' }));
    const cancelCall = localFetch.mock.calls.find(([input]) =>
      String(input).endsWith('/sessions/sess-abc/cancel'),
    );
    expect(cancelCall?.[1]?.method).toBe('POST');
    expect(cancelCall?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-token',
    });
  });

  it('断开后删除本机会话并回到启动界面', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal();
    mount();
    await connectWith(user);
    await user.click(screen.getByRole('button', { name: '断开' }));
    expect(await screen.findByRole('button', { name: '连接' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '输入消息' })).not.toBeInTheDocument();
    const removeCall = localFetch.mock.calls.find(
      ([input, init]) =>
        String(input) === `${localBase}/sessions/sess-abc` && init?.method === 'DELETE',
    );
    expect(removeCall).toBeTruthy();
  });

  it('账户变化时重置会话与消息', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    routeLocal();
    mount();
    await connectWith(user);
    act(() => {
      auth.getAuthSessionGeneration.mockReturnValue(8);
      auth.changeSession();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: '输入消息' })).not.toBeInTheDocument();
  });
});

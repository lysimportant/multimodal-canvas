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
const urlConnectionsEndpoint = `${baseUrl}/v1/projects/project%20%2F%20one/agent-url-connections`;
const signature = 'synthetic-project-connection-key'.padEnd(43, '_');
const connectionKey = `0f8fad5b-d9cb-469f-a165-70867728950e.${signature}`;
const mcpPath = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=${connectionKey}`;

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

beforeEach(() => {
  auth.getAuthSessionGeneration.mockReturnValue(7);
  configuration.apiBaseUrl = 'http://localhost:3000';
});

afterEach(() => {
  cleanup();
  auth.apiFetch.mockReset();
  auth.subscribeAuthSession.mockClear();
  vi.restoreAllMocks();
});

describe('LocalAgentChatPanel', () => {
  it('关闭时不请求；打开后加载 URL 连接并展示桥接命令', async () => {
    const pending = deferred<Response>();
    auth.apiFetch.mockReturnValue(pending.promise);
    const view = mount(false);
    expect(auth.apiFetch).not.toHaveBeenCalled();
    view.rerender(
      <LocalAgentChatPanel
        projectId={projectId}
        open
        onClose={view.onClose}
        saveCanvas={view.saveCanvas}
      />,
    );
    await act(async () => pending.resolve(urlConnectionsResponse()));
    expect(await screen.findByRole('textbox', { name: '桥接程序启动命令' })).toHaveValue(
      `node canvas-bridge.js --api ${baseUrl} --token ${connectionKey} --project ${projectId} --agent claude`,
    );
    expect(auth.apiFetch).toHaveBeenCalledWith(
      urlConnectionsEndpoint,
      expect.objectContaining({}),
      { expectedAuthGeneration: 7 },
    );
  });

  it('同源部署（API 基地址为空）时桥接命令回退到页面来源', async () => {
    configuration.apiBaseUrl = '';
    auth.apiFetch.mockResolvedValueOnce(urlConnectionsResponse());
    mount();
    expect(await screen.findByRole('textbox', { name: '桥接程序启动命令' })).toHaveValue(
      `node canvas-bridge.js --api ${window.location.origin} --token ${connectionKey} --project ${projectId} --agent claude`,
    );
  });

  it('无活跃 URL 连接时展示提示文字而非令牌', async () => {
    auth.apiFetch.mockResolvedValueOnce(Response.json({ available: true, connections: [] }));
    mount();
    expect(await screen.findByRole('textbox', { name: '桥接程序启动命令' })).toHaveValue(
      '（请先在 Agent 连接面板创建一个服务器连接，获取 token）',
    );
  });

  it('URL 连接加载静默失败，命令框显示提示', async () => {
    auth.apiFetch.mockRejectedValueOnce(new Error('network error'));
    mount();
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: '桥接程序启动命令' })).toHaveValue(
      '（请先在 Agent 连接面板创建一个服务器连接，获取 token）',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('点击连接向 /sessions POST，成功后进入聊天界面', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockResolvedValueOnce(new Response(sseStream(), { status: 200 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(auth.apiFetch.mock.calls[1]?.[0]).toBe(`${baseUrl}/v1/agent-bridge/sessions`);
    expect(auth.apiFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    );
    expect(await screen.findByRole('textbox', { name: '输入消息' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '连接' })).not.toBeInTheDocument();
  });

  it('桥接未连接时显示明确错误', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ code: 'bridge_not_connected' }, { status: 409 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByText('桥接程序未连接，请先在本机启动桥接程序后再试')).toBeVisible();
    expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();
  });

  it('发送前调用 saveCanvas，然后 POST prompt，SSE 事件更新消息列表', async () => {
    const user = userEvent.setup();
    const sseDeferred = deferred<Response>();
    const saveCanvas = vi.fn<() => Promise<void>>().mockResolvedValue();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockReturnValueOnce(sseDeferred.promise)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    mount(true, saveCanvas);
    // connect
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });

    // type and send
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'hello agent');
    await user.keyboard('{Enter}');

    expect(saveCanvas).toHaveBeenCalledOnce();
    expect(auth.apiFetch.mock.calls[3]?.[0]).toBe(
      `${baseUrl}/v1/agent-bridge/sessions/sess-abc/prompt`,
    );
    expect(JSON.parse(auth.apiFetch.mock.calls[3]?.[1].body as string)).toEqual({
      messages: [{ role: 'user', content: 'hello agent' }],
    });

    // resolve SSE stream with agent events
    const chunkEvent = `data: ${JSON.stringify({ type: 'agent_message_chunk', text: 'Hi there' })}\n\n`;
    const doneEvent = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
    await act(async () =>
      sseDeferred.resolve(new Response(sseStream(chunkEvent, doneEvent), { status: 200 })),
    );

    expect(await screen.findByText('Hi there')).toBeVisible();
  });

  it('发送失败不清空输入', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockResolvedValueOnce(new Response(sseStream(), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'test prompt');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('发送失败，请重试')).toBeVisible();
  });

  it('streaming 时 tool_call 事件在消息列表中渲染工具名', async () => {
    const sseDeferred = deferred<Response>();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockReturnValueOnce(sseDeferred.promise)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const saveCanvas = vi.fn<() => Promise<void>>().mockResolvedValue();
    mount(true, saveCanvas);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'do something');
    await user.keyboard('{Enter}');
    const toolEvent = `data: ${JSON.stringify({ type: 'tool_call', name: 'create_node' })}\n\n`;
    await act(async () => sseDeferred.resolve(new Response(sseStream(toolEvent), { status: 200 })));
    expect(await screen.findByText(/create_node/)).toBeVisible();
  });

  it('停止按钮 POST cancel', async () => {
    const sseDeferred = deferred<Response>();
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockReturnValueOnce(sseDeferred.promise)
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const saveCanvas = vi.fn<() => Promise<void>>().mockResolvedValue();
    mount(true, saveCanvas);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });
    await user.type(screen.getByRole('textbox', { name: '输入消息' }), 'go');
    await user.keyboard('{Enter}');
    // streaming is active now; resolve SSE with a chunk but no done
    const chunk = `data: ${JSON.stringify({ type: 'agent_message_chunk', text: '...' })}\n\n`;
    await act(async () => sseDeferred.resolve(new Response(sseStream(chunk), { status: 200 })));
    // After prompt is sent, streaming=true so Stop button appears
    await waitFor(() => expect(screen.queryByRole('button', { name: '停止' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(auth.apiFetch).toHaveBeenCalledWith(
      `${baseUrl}/v1/agent-bridge/sessions/sess-abc/cancel`,
      expect.objectContaining({ method: 'POST' }),
      expect.anything(),
    );
  });

  it('断开后回到启动界面', async () => {
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockResolvedValueOnce(new Response(sseStream(), { status: 200 }));
    mount();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });
    await user.click(screen.getByRole('button', { name: '断开' }));
    expect(screen.getByRole('button', { name: '连接' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '输入消息' })).not.toBeInTheDocument();
  });

  it('账户变化时重置 session 和消息', async () => {
    auth.apiFetch
      .mockResolvedValueOnce(urlConnectionsResponse())
      .mockResolvedValueOnce(Response.json({ sessionId: 'sess-abc' }))
      .mockResolvedValueOnce(new Response(sseStream(), { status: 200 }));
    mount();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByRole('textbox', { name: '输入消息' });
    act(() => {
      auth.getAuthSessionGeneration.mockReturnValue(8);
      auth.changeSession();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeInTheDocument());
    expect(screen.queryByRole('textbox', { name: '输入消息' })).not.toBeInTheDocument();
  });
});

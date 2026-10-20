import '@testing-library/jest-dom/vitest';
import { ConfigProvider } from 'antd';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  let listener: (() => void) | undefined;
  return {
    apiFetch: vi.fn(),
    getAuthSessionGeneration: vi.fn(() => 7),
    subscribeAuthSession: vi.fn((next: () => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    changeSession: () => listener?.(),
  };
});
vi.mock('../auth-client', () => auth);
const configuration = vi.hoisted(() => ({ apiBaseUrl: 'http://localhost:3000' }));
vi.mock('./contracts', () => ({
  get API_BASE_URL() {
    return configuration.apiBaseUrl;
  },
}));

import { AgentConnectionPanel } from './AgentConnectionPanel';

const projectId = 'project / one';
const mcpUrl = 'http://127.0.0.1:43210/mcp';
const endpoint = 'http://localhost:3000/v1/projects/project%20%2F%20one/local-agent-connections';
const serverEndpoint =
  'http://localhost:3000/v1/projects/project%20%2F%20one/agent-url-connections';
const connectionKey = 'synthetic-project-connection-key'.padEnd(43, '_');
const mcpPath = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=${connectionKey}`;
const privateError = 'synthetic-private-response';
const connection = {
  id: 'connection-one',
  projectId,
  allowGeneration: true,
  createdAt: '2026-10-18T00:00:00.000Z',
  expiresAt: '2099-10-18T08:00:00.000Z',
  mcpUrl,
};
const serverConnection = { ...connection, mcpPath, mcpUrl: undefined };

function listResponse(connections: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return Response.json({ available: true, connections, ...overrides });
}

function createdResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({ connection, ...overrides });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function mount(open = true, onClose = vi.fn()) {
  const view = render(
    <AgentConnectionPanel projectId={projectId} open={open} onClose={onClose} />,
    {
      wrapper: ({ children }) => (
        <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
      ),
    },
  );
  return { ...view, onClose };
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

describe('Agent 连接面板', () => {
  it('关闭时不请求；打开后显示加载、空态及默认的 8 小时有限授权', async () => {
    const pending = deferred<Response>();
    auth.apiFetch.mockReturnValue(pending.promise);
    const view = mount(false);
    expect(auth.apiFetch).not.toHaveBeenCalled();
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(screen.getByRole('status', { name: '正在加载连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeDisabled();
    await act(async () => pending.resolve(listResponse()));
    expect(screen.getByText('暂无连接')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: '连接有效期（小时）' })).toHaveValue('8');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(auth.apiFetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      { expectedAuthGeneration: 7 },
    );
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('启用连接后直接复制无令牌配置，停止后移除配置', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const persisted = vi.spyOn(Storage.prototype, 'setItem');
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    expect(auth.apiFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expiresInHours: 8 }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(screen.getByText('可编辑并运行任务')).toBeVisible();
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
    await user.click(screen.getByRole('button', { name: '复制服务地址' }));
    expect(writeText).toHaveBeenLastCalledWith(mcpUrl);
    const codex = screen.getByRole('textbox', { name: 'Codex 配置模板' }) as HTMLTextAreaElement;
    expect(codex.value).toBe(`[mcp_servers.canvas]\nurl = "${mcpUrl}"`);
    expect(screen.getByText(/受信任项目的 .codex\/config.toml/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '复制 Codex 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(codex.value);
    await user.click(screen.getByRole('tab', { name: 'DeepSeek Harness' }));
    const harness = screen.getByRole('textbox', {
      name: 'DeepSeek Harness 配置模板',
    }) as HTMLTextAreaElement;
    expect(harness.value).toBe(
      [
        '- insert:',
        '    - id: canvas-mcp',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: canvas',
        '        transport: streamable-http',
        `        url: "${mcpUrl}"`,
      ].join('\n'),
    );
    expect(screen.getByText(/dsh web --patch .\/canvas-mcp.cordis.yml/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '复制 Harness 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(harness.value);
    expect(persisted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '停止连接 connection-one' }));
    expect(auth.apiFetch.mock.calls[2]?.[0]).toBe(`${endpoint}/connection-one`);
    expect(auth.apiFetch.mock.calls[2]?.[1].method).toBe('DELETE');
    expect(screen.getByText('暂无连接')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('连接已停止');
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('仅提交用户选择的有效期，默认支持运行任务且不显示权限开关', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(
        createdResponse({ connection: { ...connection, allowGeneration: true } }),
      );
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const expiry = screen.getByRole('spinbutton', { name: '连接有效期（小时）' });
    await user.clear(expiry);
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeDisabled();
    await user.type(expiry, '24');
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    expect(auth.apiFetch.mock.calls[1]?.[1].body).toBe(JSON.stringify({ expiresInHours: 24 }));
    expect(screen.getByText('可编辑并运行任务')).toBeVisible();
  });

  it('加载失败可重试，复制失败保留可手动选择的配置', async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('synthetic clipboard error'))
      .mockResolvedValue(undefined);
    auth.apiFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(listResponse([connection]));
    mount();
    expect(await screen.findByText('连接操作失败，请重试')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '复制 Codex 配置' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: '复制 Codex 配置' }));
    expect(screen.getByText('复制失败，请选择内容手动复制')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Codex 配置模板' })).toHaveValue(
      `[mcp_servers.canvas]\nurl = "${mcpUrl}"`,
    );
    await user.click(screen.getByRole('button', { name: '复制 Codex 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(`[mcp_servers.canvas]\nurl = "${mcpUrl}"`);
    expect(screen.queryByText('复制失败，请选择内容手动复制')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Codex 配置已复制');
  });

  it('启用和停止失败保留现有连接，不回显任意错误正文', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([connection]))
      .mockRejectedValueOnce(new Error(privateError))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    expect(screen.getByText('启用连接失败，请重试')).toBeVisible();
    expect(document.body.textContent).not.toContain(privateError);
    await user.click(screen.getByRole('button', { name: '停止连接 connection-one' }));
    expect(screen.getByText('当前账户没有管理此项目连接的权限')).toBeVisible();
    expect(screen.getByRole('button', { name: '停止连接 connection-one' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
  });

  it('关闭不停止连接，重新打开后可恢复配置并切换不同连接', async () => {
    const user = userEvent.setup();
    const other = { ...connection, id: 'connection-two', mcpUrl: 'http://127.0.0.1:43211/mcp' };
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(listResponse([connection, other]));
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
    await user.click(screen.getByRole('button', { name: '关闭 Agent 连接' }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    view.rerender(
      <AgentConnectionPanel projectId={projectId} open={false} onClose={view.onClose} />,
    );
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(await screen.findByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
    await user.click(screen.getByRole('button', { name: '查看配置 connection-two' }));
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(other.mcpUrl);
  });

  it('本地不可用时自动使用服务器连接，不回显本地不可用原因', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false, reason: privateError }))
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse({ connection: serverConnection }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '启用服务器连接' })).toBeEnabled(),
    );
    expect(auth.apiFetch.mock.calls[1]?.[0]).toBe(serverEndpoint);
    await user.click(screen.getByRole('button', { name: '启用服务器连接' }));
    expect(auth.apiFetch.mock.calls[2]?.[0]).toBe(serverEndpoint);
    expect(auth.apiFetch.mock.calls[2]?.[1].body).toBe(JSON.stringify({ expiresInHours: 8 }));
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(
      `http://localhost:3000${mcpPath}`,
    );
    expect(
      screen.getByText('服务器地址已包含当前项目的连接凭据，无需额外 Token，请妥善保管。'),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain(privateError);
    await user.click(screen.getByRole('button', { name: '停止连接 connection-one' }));
    expect(auth.apiFetch.mock.calls[3]?.[0]).toBe(`${serverEndpoint}/connection-one`);
    expect(auth.apiFetch.mock.calls[3]?.[1].method).toBe('DELETE');
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('服务器连接重开后恢复配置，可复制 Codex 和 Harness 地址', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockResolvedValueOnce(listResponse([serverConnection]))
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockResolvedValueOnce(listResponse([serverConnection]));
    const view = mount();
    const serverUrl = `http://localhost:3000${mcpPath}`;
    expect(await screen.findByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(serverUrl);
    await user.click(screen.getByRole('button', { name: '关闭 Agent 连接' }));
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);
    view.rerender(
      <AgentConnectionPanel projectId={projectId} open={false} onClose={view.onClose} />,
    );
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(await screen.findByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(serverUrl);
    await user.click(screen.getByRole('button', { name: '复制 Codex 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(`[mcp_servers.canvas]\nurl = "${serverUrl}"`);
    await user.click(screen.getByRole('tab', { name: 'DeepSeek Harness' }));
    const template = screen.getByRole('textbox', {
      name: 'DeepSeek Harness 配置模板',
    }) as HTMLTextAreaElement;
    expect(template.value).toContain(`url: "${serverUrl}"`);
    expect(template.value).not.toContain('headers');
    await user.click(screen.getByRole('button', { name: '复制 Harness 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(template.value);
  });

  it('旧受限连接准确显示权限，停止重建后才显示可运行', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([{ ...connection, allowGeneration: false }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(createdResponse());
    mount();
    expect(await screen.findByText('仅可读取和编辑')).toBeVisible();
    expect(screen.getByText('停止后重新启用可运行任务')).toBeVisible();
    expect(screen.queryByText('可编辑并运行任务')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止连接 connection-one' }));
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    expect(screen.getByText('可编辑并运行任务')).toBeVisible();
    expect(auth.apiFetch.mock.calls[2]?.[1].body).toBe(JSON.stringify({ expiresInHours: 8 }));
  });

  it.each([
    ['https://canvas.example/api', 'https://canvas.example/api'],
    ['https://canvas.example/deployment/api/', 'https://canvas.example/deployment/api'],
    ['/deployment/api', `${window.location.origin}/deployment/api`],
    ['', window.location.origin],
  ])('服务器配置保留可信 API 前缀：%s', async (base, expected) => {
    configuration.apiBaseUrl = base;
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockResolvedValueOnce(listResponse([serverConnection]));
    mount();
    expect(await screen.findByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(
      `${expected}${mcpPath}`,
    );
  });

  it.each([
    `https://outside.invalid${mcpPath}`,
    `//outside.invalid${mcpPath}`,
    `/v1/projects/other-project/mcp?connection=${connectionKey}`,
    `${mcpPath}&extra=value`,
    `${mcpPath}&connection=${connectionKey}`,
    `${mcpPath}#fragment`,
    mcpPath.replace('connection=', 'token='),
    mcpPath.slice(0, -1),
    `${mcpPath}a`,
    mcpPath.replace('/mcp?', '/../mcp?'),
    `http://user:pass@localhost:3000${mcpPath}`,
  ])('拒绝恶意或非当前项目的服务器路径：%s', async (path) => {
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockResolvedValueOnce(listResponse([{ ...serverConnection, mcpPath: path }]));
    mount();
    expect(await screen.findByText('服务器连接地址无效，请重试')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeDisabled();
  });

  it.each([
    'ftp://canvas.example/api',
    'https://user:pass@canvas.example/api',
    'https://canvas.example/api?injected=value',
    'https://canvas.example/api#fragment',
  ])('拒绝不安全 API 根配置生成的服务器地址：%s', async (base) => {
    configuration.apiBaseUrl = base;
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockResolvedValueOnce(listResponse([serverConnection]));
    mount();
    expect(await screen.findByText('服务器连接地址无效，请重试')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('换项目时取消远程回退请求并忽略其迟到配置', async () => {
    const pending = deferred<Response>();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([], { available: false }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(2));
    const signal = auth.apiFetch.mock.calls[1]?.[1].signal as AbortSignal;
    view.rerender(<AgentConnectionPanel projectId="project-two" open onClose={view.onClose} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(listResponse([serverConnection])));
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
  });

  it('不为已过期连接显示可用配置', async () => {
    auth.apiFetch.mockResolvedValueOnce(
      listResponse([{ ...connection, expiresAt: '2020-01-01T00:00:00.000Z' }]),
    );
    mount();
    expect(await screen.findByText('已过期')).toBeVisible();
    expect(screen.getByRole('button', { name: '查看配置 connection-one' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it.each([
    'https://127.0.0.1:43210/mcp',
    'http://localhost:43210/mcp',
    'http://0.0.0.0:43210/mcp',
    'http://127.0.0.1:43210/mcp?token=value',
    'http://127.0.0.1:43210/mcp#fragment',
    'http://user:pass@127.0.0.1:43210/mcp',
    'http://127.0.0.1:0/mcp',
    'http://127.0.0.1:65536/mcp',
    'http://127.0.0.1:43210/mcp/../other',
  ])('拒绝不符合严格本机 MCP 地址的配置：%s', async (address) => {
    auth.apiFetch.mockResolvedValueOnce(listResponse([{ ...connection, mcpUrl: address }]));
    mount();
    expect(await screen.findByText('本地连接地址无效，请重试')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeDisabled();
  });

  it('拒绝跨项目记录及缺少本地可用性的响应', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([{ ...connection, projectId: 'other-project' }]))
      .mockResolvedValueOnce(Response.json({ connections: [] }));
    mount();
    expect(await screen.findByText('连接响应无效，请重试')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('连接响应无效，请重试')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用本地连接' })).toBeDisabled();
  });

  it('换项目时清除配置并忽略旧项目迟到的启用响应', async () => {
    const user = userEvent.setup();
    const body = deferred<unknown>();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => body.promise })
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用本地连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用本地连接' }));
    const signal = auth.apiFetch.mock.calls[1]?.[1].signal as AbortSignal;
    view.rerender(<AgentConnectionPanel projectId="project-two" open onClose={view.onClose} />);
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve({ connection }));
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(auth.apiFetch.mock.calls[2]?.[0]).toContain(
      '/projects/project-two/local-agent-connections',
    );
  });

  it('关闭忽略迟到响应，账户变化也立即清除已有配置', async () => {
    const pending = deferred<Response>();
    auth.apiFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(listResponse([connection]))
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    view.rerender(
      <AgentConnectionPanel projectId={projectId} open={false} onClose={view.onClose} />,
    );
    await act(async () => pending.resolve(listResponse([connection])));
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(await screen.findByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
    act(() => {
      auth.getAuthSessionGeneration.mockReturnValue(8);
      auth.changeSession();
    });
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('严格模式重挂后旧读取不会覆盖新会话', async () => {
    const old = deferred<Response>();
    auth.apiFetch
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(listResponse([], { available: false, reason: 'local_api_required' }))
      .mockResolvedValueOnce(listResponse());
    render(
      <StrictMode>
        <AgentConnectionPanel projectId={projectId} open onClose={vi.fn()} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '启用服务器连接' })).toBeEnabled(),
    );
    await act(async () => old.resolve(listResponse([connection])));
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });
});

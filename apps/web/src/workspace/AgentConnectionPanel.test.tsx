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
const endpoint = 'http://localhost:3000/v1/projects/project%20%2F%20one/agent-url-connections';
const signature = 'synthetic-project-connection-key'.padEnd(43, '_');
const connectionKey = `0f8fad5b-d9cb-469f-a165-70867728950e.${signature}`;
const mcpPath = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=${connectionKey}`;
const mcpUrl = `http://localhost:3000${mcpPath}`;
const privateError = 'synthetic-private-response';
const connection = {
  id: 'connection-one',
  projectId,
  allowGeneration: true,
  createdAt: '2026-10-18T00:00:00.000Z',
  expiresAt: null as string | null,
  mcpPath,
};

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
  it('关闭时不请求；打开后直接读取服务器连接，不探测本地也不要求填写有效期', async () => {
    const pending = deferred<Response>();
    auth.apiFetch.mockReturnValue(pending.promise);
    const view = mount(false);
    expect(auth.apiFetch).not.toHaveBeenCalled();
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(screen.getByRole('status', { name: '正在加载连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeDisabled();
    await act(async () => pending.resolve(listResponse()));
    expect(screen.getByText('暂无连接')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/连接长期有效，画布 API 重启或重新部署后地址不变/)).toBeVisible();
    expect(auth.apiFetch).toHaveBeenCalledOnce();
    expect(auth.apiFetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      { expectedAuthGeneration: 7 },
    );
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('启用长期连接后直接复制无令牌配置，停止后移除配置', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const persisted = vi.spyOn(Storage.prototype, 'setItem');
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用连接' }));
    expect(auth.apiFetch.mock.calls[1]?.[0]).toBe(endpoint);
    expect(auth.apiFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(screen.getByText('可编辑并运行任务')).toBeVisible();
    expect(screen.getByText('长期有效')).toBeVisible();
    expect(screen.queryByText(/到期：/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
    expect(
      screen.getByText('服务器地址已包含当前项目的连接凭据，无需额外 Token，请妥善保管。'),
    ).toBeVisible();
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
    expect(harness.value).not.toContain('headers');
    expect(screen.getByText(/profiles\\desktop\\cordis\.patch\.yml/)).toBeVisible();
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
    await waitFor(() => expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用连接' }));
    expect(screen.getByText('启用连接失败，请重试')).toBeVisible();
    expect(document.body.textContent).not.toContain(privateError);
    await user.click(screen.getByRole('button', { name: '停止连接 connection-one' }));
    expect(screen.getByText('当前账户没有管理此项目连接的权限')).toBeVisible();
    expect(screen.getByRole('button', { name: '停止连接 connection-one' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
  });

  it('关闭不停止连接，重新打开后可恢复配置并切换不同连接', async () => {
    const user = userEvent.setup();
    const otherKey = `7c9e6679-7425-40de-944b-e07fc1f90ae7.${signature}`;
    const other = {
      ...connection,
      id: 'connection-two',
      mcpPath: mcpPath.replace(connectionKey, otherKey),
    };
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(listResponse([connection, other]));
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用连接' }));
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
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(
      `http://localhost:3000${other.mcpPath}`,
    );
  });

  it('服务暂不可用时禁用启用按钮，不回显服务端原因', async () => {
    auth.apiFetch.mockResolvedValueOnce(
      listResponse([], { available: false, reason: privateError }),
    );
    mount();
    expect(await screen.findByText('连接暂不可用，请刷新列表重试')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeDisabled();
    expect(document.body.textContent).not.toContain(privateError);
    expect(auth.apiFetch).toHaveBeenCalledOnce();
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
    await user.click(screen.getByRole('button', { name: '启用连接' }));
    expect(screen.getByText('可编辑并运行任务')).toBeVisible();
    expect(auth.apiFetch.mock.calls[2]?.[1].body).toBe(JSON.stringify({}));
  });

  it.each([
    ['https://canvas.example/api', 'https://canvas.example/api'],
    ['https://canvas.example/deployment/api/', 'https://canvas.example/deployment/api'],
    ['/deployment/api', `${window.location.origin}/deployment/api`],
    ['', window.location.origin],
  ])('服务器配置保留可信 API 前缀：%s', async (base, expected) => {
    configuration.apiBaseUrl = base;
    auth.apiFetch.mockResolvedValueOnce(listResponse([connection]));
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
    mcpPath.replace(connectionKey, signature),
    mcpPath.replace(connectionKey, `${connectionKey.split('.')[0]}`),
    `http://user:pass@localhost:3000${mcpPath}`,
  ])('拒绝恶意或非当前项目的服务器路径：%s', async (path) => {
    auth.apiFetch.mockResolvedValueOnce(listResponse([{ ...connection, mcpPath: path }]));
    mount();
    expect(await screen.findByText('服务器连接地址无效，请重试')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeDisabled();
  });

  it.each([
    'ftp://canvas.example/api',
    'https://user:pass@canvas.example/api',
    'https://canvas.example/api?injected=value',
    'https://canvas.example/api#fragment',
  ])('拒绝不安全 API 根配置生成的服务器地址：%s', async (base) => {
    configuration.apiBaseUrl = base;
    auth.apiFetch.mockResolvedValueOnce(listResponse([connection]));
    mount();
    expect(await screen.findByText('服务器连接地址无效，请重试')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });

  it('换项目时取消读取请求并忽略其迟到配置', async () => {
    const pending = deferred<Response>();
    auth.apiFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(listResponse());
    const view = mount();
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(1));
    const signal = auth.apiFetch.mock.calls[0]?.[1].signal as AbortSignal;
    view.rerender(<AgentConnectionPanel projectId="project-two" open onClose={view.onClose} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(listResponse([connection])));
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
  });

  it('兼容旧限时连接：显示到期时间，已过期连接不显示可用配置', async () => {
    auth.apiFetch.mockResolvedValueOnce(
      listResponse([
        { ...connection, expiresAt: '2020-01-01T00:00:00.000Z' },
        { ...connection, id: 'connection-two', expiresAt: '2099-10-18T08:00:00.000Z' },
      ]),
    );
    mount();
    expect(await screen.findByText('已过期')).toBeVisible();
    expect(screen.getAllByText(/到期：/)).toHaveLength(2);
    expect(screen.queryByText('长期有效')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看配置 connection-one' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '查看配置 connection-two' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(mcpUrl);
  });

  it.each([
    [{ ...connection, projectId: 'other-project' }],
    [{ ...connection, expiresAt: 'never' }],
    [{ ...connection, expiresAt: undefined }],
  ])('拒绝跨项目或到期时间无效的记录：%j', async (item) => {
    auth.apiFetch.mockResolvedValueOnce(listResponse([item]));
    mount();
    expect(await screen.findByText('连接响应无效，请重试')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeDisabled();
  });

  it('拒绝缺少可用性的响应', async () => {
    auth.apiFetch.mockResolvedValueOnce(Response.json({ connections: [] }));
    mount();
    expect(await screen.findByText('连接响应无效，请重试')).toBeVisible();
    expect(screen.getByRole('button', { name: '启用连接' })).toBeDisabled();
  });

  it('换项目时清除配置并忽略旧项目迟到的启用响应', async () => {
    const user = userEvent.setup();
    const body = deferred<unknown>();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => body.promise })
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '启用连接' }));
    const signal = auth.apiFetch.mock.calls[1]?.[1].signal as AbortSignal;
    view.rerender(<AgentConnectionPanel projectId="project-two" open onClose={view.onClose} />);
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve({ connection }));
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(auth.apiFetch.mock.calls[2]?.[0]).toContain(
      '/projects/project-two/agent-url-connections',
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
    auth.apiFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(listResponse());
    render(
      <StrictMode>
        <AgentConnectionPanel projectId={projectId} open onClose={vi.fn()} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '启用连接' })).toBeEnabled());
    await act(async () => old.resolve(listResponse([connection])));
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });
});

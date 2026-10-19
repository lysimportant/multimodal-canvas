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

import { AgentConnectionPanel } from './AgentConnectionPanel';

const projectId = 'project / one';
const mcpPath = '/v1/agent/mcp';
const endpoint = 'http://localhost:3000/v1/projects/project%20%2F%20one/agent-connections';
const syntheticToken = 'synthetic-agent-panel-token';
const connection = {
  id: 'connection-one',
  projectId,
  allowGeneration: false,
  createdAt: '2026-10-18T00:00:00.000Z',
  expiresAt: '2099-10-18T08:00:00.000Z',
};

function listResponse(connections: unknown[] = [], path = mcpPath) {
  return Response.json({ connections, mcpPath: path });
}

function createdResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({ token: syntheticToken, connection, mcpPath, ...overrides });
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
});

afterEach(() => {
  cleanup();
  auth.apiFetch.mockReset();
  auth.subscribeAuthSession.mockClear();
  vi.restoreAllMocks();
});

describe('外部 Agent 连接面板', () => {
  it('关闭时不请求；打开后显示加载、空态及默认的 8 小时有限授权', async () => {
    const pending = deferred<Response>();
    auth.apiFetch.mockReturnValue(pending.promise);
    const view = mount(false);
    expect(auth.apiFetch).not.toHaveBeenCalled();
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    expect(screen.getByRole('status', { name: '正在加载连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeDisabled();
    await act(async () => pending.resolve(listResponse()));
    expect(screen.getByText('暂无连接')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: '连接有效期（小时）' })).toHaveValue('8');
    expect(screen.getByRole('checkbox', { name: '允许发起生成' })).not.toBeChecked();
    expect(auth.apiFetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      { expectedAuthGeneration: 7 },
    );
    expect(screen.getByRole('textbox', { name: 'MCP 服务地址' })).toHaveValue(
      `http://localhost:3000${mcpPath}`,
    );
  });

  it('创建生成权限关闭的连接，令牌仅存内存且模板不嵌入令牌，可复制及撤销', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const persisted = vi.spyOn(Storage.prototype, 'setItem');
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    expect(auth.apiFetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ allowGeneration: false, expiresInHours: 8 }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(screen.getByLabelText('Agent 连接令牌')).toHaveValue(syntheticToken);
    expect(screen.getByText('可读取并编辑')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '复制令牌' }));
    expect(writeText).toHaveBeenLastCalledWith(syntheticToken);
    expect(screen.getByRole('status')).toHaveTextContent('令牌已复制');
    const codex = screen.getByRole('textbox', { name: 'Codex 配置模板' }) as HTMLTextAreaElement;
    expect(codex.value).toContain('[mcp_servers.canvas]');
    expect(codex.value).toContain('bearer_token_env_var = "CANVAS_AGENT_TOKEN"');
    expect(codex.value).not.toContain(syntheticToken);
    await user.click(screen.getByRole('tab', { name: 'DeepSeek Harness' }));
    const harness = screen.getByRole('textbox', {
      name: 'DeepSeek Harness 配置模板',
    }) as HTMLTextAreaElement;
    expect(harness.value).toContain('- insert:\n    - id: canvas-mcp');
    expect(harness.value).toContain(
      "Authorization: !!js '`Bearer ${process.env.CANVAS_AGENT_TOKEN}`'",
    );
    expect(harness.value).not.toContain(syntheticToken);
    await user.click(screen.getByRole('button', { name: '复制 Harness 配置' }));
    expect(writeText).toHaveBeenLastCalledWith(harness.value);
    expect(
      persisted.mock.calls.some((args) =>
        args.some((value) => String(value).includes(syntheticToken)),
      ),
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: '撤销连接 connection-one' }));
    expect(auth.apiFetch.mock.calls[2]?.[0]).toBe(`${endpoint}/connection-one`);
    expect(auth.apiFetch.mock.calls[2]?.[1].method).toBe('DELETE');
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
    expect(screen.getByText('暂无连接')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('连接已撤销');
  });

  it('用户明确选择生成权限和有效期后才提交对应授权', async () => {
    const user = userEvent.setup();
    auth.apiFetch.mockResolvedValueOnce(listResponse()).mockResolvedValueOnce(
      createdResponse({
        connection: { ...connection, allowGeneration: true },
      }),
    );
    mount();
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: '允许发起生成' }));
    const expiry = screen.getByRole('spinbutton', { name: '连接有效期（小时）' });
    await user.clear(expiry);
    expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeDisabled();
    await user.type(expiry, '24');
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    expect(auth.apiFetch.mock.calls[1]?.[1].body).toBe(
      JSON.stringify({ allowGeneration: true, expiresInHours: 24 }),
    );
    expect(screen.getByText('可编辑并生成')).toBeVisible();
  });

  it('加载失败可重试，复制失败保留可手动选择的令牌', async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('synthetic clipboard error'))
      .mockResolvedValue(undefined);
    auth.apiFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse());
    mount();
    expect(await screen.findByText('连接操作失败，请重试')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    await user.click(screen.getByRole('button', { name: '复制令牌' }));
    expect(screen.getByText('复制失败，请选择内容手动复制')).toBeVisible();
    expect(screen.getByLabelText('Agent 连接令牌')).toHaveValue(syntheticToken);
    await user.click(screen.getByRole('button', { name: '复制令牌' }));
    expect(writeText).toHaveBeenLastCalledWith(syntheticToken);
    expect(screen.queryByText('复制失败，请选择内容手动复制')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('令牌已复制');
  });

  it('创建和撤销失败保留现有连接，不回显任意错误正文', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse([connection]))
      .mockRejectedValueOnce(new Error(syntheticToken))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    expect(screen.getByText('创建连接失败，请重试')).toBeVisible();
    expect(document.body.textContent).not.toContain(syntheticToken);
    await user.click(screen.getByRole('button', { name: '撤销连接 connection-one' }));
    expect(screen.getByText('当前账户没有管理此项目连接的权限')).toBeVisible();
    expect(screen.getByRole('button', { name: '撤销连接 connection-one' })).toBeEnabled();
  });

  it('关闭后立即清除令牌，重新打开不会恢复旧令牌', async () => {
    const user = userEvent.setup();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(listResponse([connection]));
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    expect(screen.getByLabelText('Agent 连接令牌')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭 Agent 连接' }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
    view.rerender(
      <AgentConnectionPanel projectId={projectId} open={false} onClose={view.onClose} />,
    );
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '撤销连接 connection-one' })).toBeEnabled(),
    );
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
  });

  it('换项目时清令牌并忽略旧项目迟到的创建响应', async () => {
    const user = userEvent.setup();
    const body = deferred<unknown>();
    auth.apiFetch
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise })
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    const signal = auth.apiFetch.mock.calls[1]?.[1].signal as AbortSignal;
    view.rerender(<AgentConnectionPanel projectId="project-two" open onClose={view.onClose} />);
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve({ token: syntheticToken, connection, mcpPath }));
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(auth.apiFetch.mock.calls[2]?.[0]).toContain('/projects/project-two/agent-connections');
  });

  it('关闭忽略迟到响应，账户变化也立即清除已有令牌', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    auth.apiFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(createdResponse())
      .mockResolvedValueOnce(listResponse());
    const view = mount();
    view.rerender(
      <AgentConnectionPanel projectId={projectId} open={false} onClose={view.onClose} />,
    );
    await act(async () => pending.resolve(listResponse([connection])));
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    view.rerender(<AgentConnectionPanel projectId={projectId} open onClose={view.onClose} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连接令牌' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '创建连接令牌' }));
    expect(screen.getByLabelText('Agent 连接令牌')).toBeInTheDocument();
    act(() => {
      auth.getAuthSessionGeneration.mockReturnValue(8);
      auth.changeSession();
    });
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledTimes(4));
    expect(screen.queryByLabelText('Agent 连接令牌')).not.toBeInTheDocument();
  });

  it('拒绝外部 MCP 地址，严格模式重挂后的旧读取不会覆盖新会话', async () => {
    const old = deferred<Response>();
    auth.apiFetch
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(listResponse([], '//outside.invalid/mcp'));
    render(
      <StrictMode>
        <AgentConnectionPanel projectId={projectId} open onClose={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText('连接地址无效，请重试')).toBeVisible();
    await act(async () => old.resolve(listResponse([connection])));
    expect(screen.queryByText('connection-one')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'MCP 服务地址' })).not.toBeInTheDocument();
  });
});

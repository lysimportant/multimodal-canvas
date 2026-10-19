import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Spin,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';

import { apiFetch, getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import { API_BASE_URL } from './contracts';
import './AgentConnectionPanel.css';

type AgentConnection = {
  id: string;
  projectId: string;
  allowGeneration: boolean;
  createdAt: string;
  expiresAt: string;
};

export type AgentConnectionPanelProps = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

/** 只把本组件的固定提示展示到界面，不回显网络错误或响应正文中的敏感内容。 */
class AgentConnectionError extends Error {}

/** 只接受当前项目的服务端连接记录；不从列表恢复或推断任何令牌。 */
function readConnection(value: unknown, projectId: string): AgentConnection {
  const item = value as Partial<AgentConnection> | null;
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    item.projectId !== projectId ||
    typeof item.allowGeneration !== 'boolean' ||
    typeof item.createdAt !== 'string' ||
    typeof item.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !Number.isFinite(Date.parse(item.expiresAt))
  )
    throw new AgentConnectionError('连接响应无效，请重试');
  return item as AgentConnection;
}

/** MCP 路径始终绑定当前 API 服务，模板不会把授权发送到接口返回的外部地址。 */
function connectionUrl(path: unknown): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
    throw new AgentConnectionError('连接地址无效，请重试');
  const base = new URL(API_BASE_URL, window.location.href);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new AgentConnectionError('连接地址无效，请重试');
  return url.href;
}

function requestError(response: Response): Error {
  return new AgentConnectionError(
    response.status === 401
      ? '登录已失效，请重新登录后操作'
      : response.status === 403
        ? '当前账户没有管理此项目连接的权限'
        : '连接操作失败，请重试',
  );
}

/** 关闭、换项目或换账户时卸载授权会话，令牌不进入浏览器持久存储。 */
export function AgentConnectionPanel({ projectId, open, onClose }: AgentConnectionPanelProps) {
  const [authGeneration, setAuthGeneration] = useState(getAuthSessionGeneration);
  useEffect(() => subscribeAuthSession(() => setAuthGeneration(getAuthSessionGeneration())), []);
  if (!open) return null;
  return (
    <ConnectionSession
      key={`${projectId}:${authGeneration}`}
      projectId={projectId}
      authGeneration={authGeneration}
      onClose={onClose}
    />
  );
}

function ConnectionSession({
  projectId,
  authGeneration,
  onClose,
}: {
  projectId: string;
  authGeneration: number;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [mcpUrl, setMcpUrl] = useState<string>();
  const [token, setToken] = useState<{ value: string; connectionId: string }>();
  const [hours, setHours] = useState<number | null>(8);
  const [allowGeneration, setAllowGeneration] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [closed, setClosed] = useState(false);
  const live = useRef(true);
  const lifecycle = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const endpoint = `${API_BASE_URL.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/agent-connections`;
  const active = (epoch = lifecycle.current) =>
    live.current && epoch === lifecycle.current && getAuthSessionGeneration() === authGeneration;
  const busy = loading || creating || revoking !== undefined;
  const validHours = hours !== null && Number.isInteger(hours) && hours >= 1 && hours <= 24;

  const invalidate = () => {
    live.current = false;
    lifecycle.current += 1;
    for (const request of requests.current) request.abort();
    requests.current.clear();
  };

  const request = async (path: string, init?: RequestInit) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const response = await apiFetch(
        path,
        { ...init, signal: controller.signal },
        {
          expectedAuthGeneration: authGeneration,
        },
      );
      if (!response.ok) throw requestError(response);
      return response.status === 204 ? undefined : await response.json();
    } finally {
      requests.current.delete(controller);
    }
  };

  const load = async () => {
    const epoch = lifecycle.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await request(endpoint);
      if (!active(epoch)) return;
      if (!result || !Array.isArray(result.connections))
        throw new AgentConnectionError('连接响应无效，请重试');
      const items = result.connections.map((item: unknown) => readConnection(item, projectId));
      const url = connectionUrl(result.mcpPath);
      setConnections(items);
      setMcpUrl(url);
    } catch (reason) {
      if (active(epoch))
        setError(reason instanceof AgentConnectionError ? reason.message : '连接加载失败，请重试');
    } finally {
      if (active(epoch)) setLoading(false);
    }
  };

  useEffect(() => {
    live.current = true;
    void load();
    return invalidate;
    // 项目与账户变化由父组件 key 创建全新会话。
  }, []);

  const create = async () => {
    if (busy || !validHours || !active()) return;
    const epoch = lifecycle.current;
    setCreating(true);
    setError(undefined);
    setNotice(undefined);
    setToken(undefined);
    try {
      const result = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowGeneration, expiresInHours: hours }),
      });
      if (!active(epoch)) return;
      if (!result || typeof result.token !== 'string' || !result.token)
        throw new AgentConnectionError('连接响应无效，请重试');
      const connection = readConnection(result.connection, projectId);
      const url = connectionUrl(result.mcpPath);
      setConnections((items) => [connection, ...items.filter((item) => item.id !== connection.id)]);
      setMcpUrl(url);
      setToken({ value: result.token, connectionId: connection.id });
    } catch (reason) {
      if (active(epoch))
        setError(reason instanceof AgentConnectionError ? reason.message : '创建连接失败，请重试');
    } finally {
      if (active(epoch)) setCreating(false);
    }
  };

  const revoke = async (connectionId: string) => {
    if (busy || !active()) return;
    const epoch = lifecycle.current;
    setRevoking(connectionId);
    setError(undefined);
    setNotice(undefined);
    try {
      await request(`${endpoint}/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
      if (!active(epoch)) return;
      setConnections((items) => items.filter((item) => item.id !== connectionId));
      setToken((current) => (current?.connectionId === connectionId ? undefined : current));
      setNotice('连接已撤销');
    } catch (reason) {
      if (active(epoch))
        setError(reason instanceof AgentConnectionError ? reason.message : '撤销连接失败，请重试');
    } finally {
      if (active(epoch)) setRevoking(undefined);
    }
  };

  const copy = async (value: string, label: string) => {
    const epoch = lifecycle.current;
    setError(undefined);
    setNotice(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(value);
      if (active(epoch)) setNotice(`${label}已复制`);
    } catch {
      if (active(epoch)) setError('复制失败，请选择内容手动复制');
    }
  };

  const codexTemplate = mcpUrl
    ? [
        '[mcp_servers.canvas]',
        `url = ${JSON.stringify(mcpUrl)}`,
        'bearer_token_env_var = "CANVAS_AGENT_TOKEN"',
      ].join('\n')
    : '';
  const harnessTemplate = mcpUrl
    ? [
        '- insert:',
        '    - id: canvas-mcp',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: canvas',
        '        transport: streamable-http',
        `        url: ${JSON.stringify(mcpUrl)}`,
        '        headers:',
        "          Authorization: !!js '`Bearer ${process.env.CANVAS_AGENT_TOKEN}`'",
      ].join('\n')
    : '';

  return (
    <Drawer
      open={!closed}
      title="连接外部 Agent"
      placement="right"
      size="min(640px, 100vw)"
      destroyOnHidden
      closable={{ placement: 'end', 'aria-label': '关闭 Agent 连接' }}
      rootClassName="agent-connection-panel"
      onClose={() => {
        invalidate();
        setToken(undefined);
        setNotice(undefined);
        setClosed(true);
        onClose();
      }}
    >
      <div className="agent-connection-content">
        <Typography.Paragraph>
          允许外部 Agent 读取当前项目并编辑画布；发起生成需单独授权。
        </Typography.Paragraph>
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            action={
              <Button onClick={() => void load()} disabled={busy}>
                重新加载
              </Button>
            }
          />
        )}
        {notice && <Alert type="success" showIcon title={<span role="status">{notice}</span>} />}
        <section aria-label="创建 Agent 连接" className="agent-connection-section">
          <Typography.Title level={5}>创建连接</Typography.Title>
          <div className="agent-connection-controls">
            <label className="agent-connection-expiry">
              有效期（小时）
              <InputNumber
                aria-label="连接有效期（小时）"
                min={1}
                max={24}
                precision={0}
                value={hours}
                onChange={setHours}
                disabled={busy}
              />
            </label>
            <Checkbox
              checked={allowGeneration}
              disabled={busy}
              onChange={(event) => setAllowGeneration(event.target.checked)}
            >
              允许发起生成
            </Checkbox>
          </div>
          {!validHours && (
            <Typography.Text type="danger">有效期须为 1 至 24 小时的整数</Typography.Text>
          )}
          <Button
            type="primary"
            loading={creating}
            disabled={busy || !validHours || !mcpUrl}
            onClick={() => void create()}
          >
            创建连接令牌
          </Button>
        </section>
        {token && (
          <section aria-label="本次连接令牌" className="agent-connection-section">
            <Typography.Text strong>连接令牌仅在本次面板中展示</Typography.Text>
            <Typography.Text type="secondary">
              关闭后无法再次查看。将令牌设为 Agent 进程的 CANVAS_AGENT_TOKEN 环境变量。
            </Typography.Text>
            <Input.Password
              aria-label="Agent 连接令牌"
              value={token.value}
              readOnly
              autoComplete="off"
            />
            <Button onClick={() => void copy(token.value, '令牌')}>复制令牌</Button>
          </section>
        )}
        {mcpUrl && (
          <section aria-label="Agent 接入配置" className="agent-connection-section">
            <Typography.Title level={5}>接入配置</Typography.Title>
            <Input aria-label="MCP 服务地址" value={mcpUrl} readOnly />
            <Button onClick={() => void copy(mcpUrl, '服务地址')}>复制服务地址</Button>
            <Typography.Text type="secondary">
              模板通过环境变量读取令牌，不包含令牌本身。
            </Typography.Text>
            <Tabs
              items={[
                {
                  key: 'codex',
                  label: 'Codex',
                  children: (
                    <>
                      <Input.TextArea
                        className="agent-connection-template"
                        aria-label="Codex 配置模板"
                        readOnly
                        value={codexTemplate}
                        rows={4}
                      />
                      <Button onClick={() => void copy(codexTemplate, 'Codex 配置')}>
                        复制 Codex 配置
                      </Button>
                    </>
                  ),
                },
                {
                  key: 'harness',
                  label: 'DeepSeek Harness',
                  children: (
                    <>
                      <Input.TextArea
                        className="agent-connection-template"
                        aria-label="DeepSeek Harness 配置模板"
                        readOnly
                        value={harnessTemplate}
                        rows={10}
                      />
                      <Button onClick={() => void copy(harnessTemplate, 'Harness 配置')}>
                        复制 Harness 配置
                      </Button>
                    </>
                  ),
                },
              ]}
            />
          </section>
        )}
        <section aria-label="已授权 Agent 连接" className="agent-connection-section">
          <div className="agent-connection-heading">
            <Typography.Title level={5}>已授权连接</Typography.Title>
            <Button disabled={busy} onClick={() => void load()}>
              刷新列表
            </Button>
          </div>
          {loading ? (
            <div role="status" aria-label="正在加载连接">
              <Spin /> 正在加载连接…
            </div>
          ) : connections.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接" />
          ) : (
            <ul className="agent-connection-list">
              {connections.map((connection) => (
                <li key={connection.id}>
                  <div className="agent-connection-record">
                    <Typography.Text strong>{connection.id}</Typography.Text>
                    <div>
                      <Tag color={connection.allowGeneration ? 'orange' : 'blue'}>
                        {connection.allowGeneration ? '可编辑并生成' : '可读取并编辑'}
                      </Tag>
                      {Date.parse(connection.expiresAt) <= Date.now() && <Tag>已过期</Tag>}
                    </div>
                    <Typography.Text type="secondary">
                      创建：{new Date(connection.createdAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      到期：{new Date(connection.expiresAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                  </div>
                  <Button
                    danger
                    aria-label={`撤销连接 ${connection.id}`}
                    loading={revoking === connection.id}
                    disabled={busy}
                    onClick={() => void revoke(connection.id)}
                  >
                    撤销
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}

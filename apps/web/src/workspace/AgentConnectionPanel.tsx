import {
  Alert,
  Button,
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
  mcpUrl: string;
};

export type AgentConnectionPanelProps = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

/** 只把本组件的固定提示展示到界面，不回显网络错误或响应正文中的敏感内容。 */
class AgentConnectionError extends Error {}

type ConnectionMode = 'local' | 'server';

/** 服务端地址只接受当前项目路径及单个连接键；部署前缀来自受信任的 API 配置。 */
function serverConnectionUrl(path: unknown, projectId: string): string {
  const prefix = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=`;
  if (
    typeof path !== 'string' ||
    !path.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{43}$/.test(path.slice(prefix.length))
  )
    throw new AgentConnectionError('服务器连接地址无效，请重试');
  let base: URL;
  try {
    base = new URL(API_BASE_URL || '/', window.location.origin);
  } catch {
    throw new AgentConnectionError('服务器连接地址无效，请重试');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new AgentConnectionError('服务器连接地址无效，请重试');
  return `${base.origin}${base.pathname.replace(/\/$/, '')}${path}`;
}

/** 只接受当前项目的本机回环地址或服务器相对路径，不信任任意 URL。 */
function readConnection(value: unknown, projectId: string, mode: ConnectionMode): AgentConnection {
  const item = value as (Partial<AgentConnection> & { mcpPath?: unknown }) | null;
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
  if (mode === 'server')
    return { ...item, mcpUrl: serverConnectionUrl(item.mcpPath, projectId) } as AgentConnection;
  const address =
    typeof item.mcpUrl === 'string' &&
    /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/mcp$/.exec(item.mcpUrl);
  if (!address || Number(address[1]) > 65535)
    throw new AgentConnectionError('本地连接地址无效，请重试');
  return item as AgentConnection;
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

/** 关闭、换项目或换账户时卸载界面会话；关闭面板不会停止已启用的连接。 */
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
  const [selectedId, setSelectedId] = useState<string>();
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<ConnectionMode>('local');
  const [hours, setHours] = useState<number | null>(8);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [closed, setClosed] = useState(false);
  const live = useRef(true);
  const lifecycle = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const projectEndpoint = `${API_BASE_URL.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}`;
  const endpoint = `${projectEndpoint}/${mode === 'local' ? 'local-agent-connections' : 'agent-url-connections'}`;
  const modeLabel = mode === 'local' ? '本地' : '服务器';
  const active = (epoch = lifecycle.current) =>
    live.current && epoch === lifecycle.current && getAuthSessionGeneration() === authGeneration;
  const busy = loading || creating || revoking !== undefined;
  const validHours = hours !== null && Number.isInteger(hours) && hours >= 1 && hours <= 24;
  const selected = connections.find(
    (connection) => connection.id === selectedId && Date.parse(connection.expiresAt) > Date.now(),
  );
  const mcpUrl = available ? selected?.mcpUrl : undefined;

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
      let result = await request(`${projectEndpoint}/local-agent-connections`);
      if (!active(epoch)) return;
      if (!result || typeof result.available !== 'boolean' || !Array.isArray(result.connections))
        throw new AgentConnectionError('连接响应无效，请重试');
      let nextMode: ConnectionMode = 'local';
      if (!result.available) {
        nextMode = 'server';
        result = await request(`${projectEndpoint}/agent-url-connections`);
        if (!active(epoch)) return;
        if (!result || typeof result.available !== 'boolean' || !Array.isArray(result.connections))
          throw new AgentConnectionError('连接响应无效，请重试');
      }
      const items = result.connections.map((item: unknown) =>
        readConnection(item, projectId, nextMode),
      );
      setConnections(items);
      setAvailable(result.available);
      setMode(nextMode);
      setSelectedId((current) =>
        items.some(
          (item: AgentConnection) => item.id === current && Date.parse(item.expiresAt) > Date.now(),
        )
          ? current
          : items.find((item: AgentConnection) => Date.parse(item.expiresAt) > Date.now())?.id,
      );
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
    if (busy || !available || !validHours || !active()) return;
    const epoch = lifecycle.current;
    setCreating(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInHours: hours }),
      });
      if (!active(epoch)) return;
      if (!result) throw new AgentConnectionError('连接响应无效，请重试');
      const connection = readConnection(result.connection, projectId, mode);
      setConnections((items) => [connection, ...items.filter((item) => item.id !== connection.id)]);
      setSelectedId(connection.id);
      setNotice(`${modeLabel}连接已启用`);
    } catch (reason) {
      if (active(epoch))
        setError(reason instanceof AgentConnectionError ? reason.message : '启用连接失败，请重试');
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
      setSelectedId((current) =>
        current === connectionId
          ? connections.find(
              (item) => item.id !== connectionId && Date.parse(item.expiresAt) > Date.now(),
            )?.id
          : current,
      );
      setNotice('连接已停止');
    } catch (reason) {
      if (active(epoch))
        setError(reason instanceof AgentConnectionError ? reason.message : '停止连接失败，请重试');
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
    ? ['[mcp_servers.canvas]', `url = ${JSON.stringify(mcpUrl)}`].join('\n')
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
        setNotice(undefined);
        setClosed(true);
        onClose();
      }}
    >
      <div className="agent-connection-content">
        <Typography.Paragraph>
          连接 Codex、DeepSeek Harness 等 Agent
          后，即可创建节点、连线、调整参数、运行和取消当前画布任务，无需额外令牌。
        </Typography.Paragraph>
        {!loading && !available && !error && (
          <Alert type="info" showIcon title="连接暂不可用，请刷新列表重试" />
        )}
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
        <section aria-label={`启用${modeLabel} Agent 连接`} className="agent-connection-section">
          <Typography.Title level={5}>{modeLabel}连接</Typography.Title>
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
                disabled={busy || !available}
              />
            </label>
          </div>
          {!validHours && (
            <Typography.Text type="danger">有效期须为 1 至 24 小时的整数</Typography.Text>
          )}
          <Button
            type="primary"
            loading={creating}
            disabled={busy || !validHours || !available}
            onClick={() => void create()}
          >
            启用{modeLabel}连接
          </Button>
          <Typography.Text type="secondary">
            关闭面板后连接继续有效；停止连接或有效期结束后失效。画布 API
            重启后需重新启用并更新配置。
          </Typography.Text>
        </section>
        {mcpUrl && (
          <section aria-label="Agent 接入配置" className="agent-connection-section">
            <Typography.Title level={5}>接入配置</Typography.Title>
            {mode === 'server' && (
              <Alert
                type="info"
                showIcon
                title="服务器地址已包含当前项目的连接凭据，无需额外 Token，请妥善保管。"
              />
            )}
            <Input aria-label="MCP 服务地址" value={mcpUrl} readOnly />
            <Button onClick={() => void copy(mcpUrl, '服务地址')}>复制服务地址</Button>
            <Tabs
              items={[
                {
                  key: 'codex',
                  label: 'Codex',
                  children: (
                    <>
                      <Typography.Paragraph>
                        将配置加入受信任项目的 .codex/config.toml，然后在 Codex 中重新加载 MCP。
                      </Typography.Paragraph>
                      <Input.TextArea
                        className="agent-connection-template"
                        aria-label="Codex 配置模板"
                        readOnly
                        value={codexTemplate}
                        rows={3}
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
                      <Typography.Paragraph>
                        保存为 canvas-mcp.cordis.yml，然后在该目录运行 dsh web --patch
                        ./canvas-mcp.cordis.yml。
                      </Typography.Paragraph>
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
            <Typography.Title level={5}>已启用连接</Typography.Title>
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
                        {connection.allowGeneration ? '可编辑并运行任务' : '仅可读取和编辑'}
                      </Tag>
                      {Date.parse(connection.expiresAt) <= Date.now() && <Tag>已过期</Tag>}
                    </div>
                    {!connection.allowGeneration && (
                      <Typography.Text type="secondary">停止后重新启用可运行任务</Typography.Text>
                    )}
                    <Typography.Text type="secondary">
                      创建：{new Date(connection.createdAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      到期：{new Date(connection.expiresAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                  </div>
                  <div className="agent-connection-actions">
                    <Button
                      aria-label={`查看配置 ${connection.id}`}
                      disabled={busy || Date.parse(connection.expiresAt) <= Date.now()}
                      type={selectedId === connection.id ? 'primary' : 'default'}
                      onClick={() => setSelectedId(connection.id)}
                    >
                      查看配置
                    </Button>
                    <Button
                      danger
                      aria-label={`停止连接 ${connection.id}`}
                      loading={revoking === connection.id}
                      disabled={busy}
                      onClick={() => void revoke(connection.id)}
                    >
                      停止
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}

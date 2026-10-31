import { Alert, Button, Drawer, Empty, Input, Spin, Tabs, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

import { apiFetch, getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import { API_BASE_URL } from './contracts';
import './AgentConnectionPanel.css';

type AgentConnection = {
  id: string;
  projectId: string;
  allowGeneration: boolean;
  createdAt: string;
  /** null 表示长期有效，停止前一直可用。 */
  expiresAt: string | null;
  mcpUrl: string;
};

export type AgentConnectionPanelProps = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

/** 只把本组件的固定提示展示到界面，不回显网络错误或响应正文中的敏感内容。 */
class AgentConnectionError extends Error {}

const isActive = (connection: AgentConnection) =>
  connection.expiresAt === null || Date.parse(connection.expiresAt) > Date.now();

/** 服务端地址只接受当前项目路径及单个连接键；部署前缀来自受信任的 API 配置。 */
function serverConnectionUrl(path: unknown, projectId: string): string {
  const prefix = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=`;
  if (
    typeof path !== 'string' ||
    !path.startsWith(prefix) ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.[A-Za-z0-9_-]{43}$/.test(
      path.slice(prefix.length),
    )
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

/** 只接受当前项目的服务器相对路径，不信任任意 URL。 */
function readConnection(value: unknown, projectId: string): AgentConnection {
  const item = value as (Partial<AgentConnection> & { mcpPath?: unknown }) | null;
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    item.projectId !== projectId ||
    typeof item.allowGeneration !== 'boolean' ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    (item.expiresAt !== null &&
      (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))))
  )
    throw new AgentConnectionError('连接响应无效，请重试');
  return { ...item, mcpUrl: serverConnectionUrl(item.mcpPath, projectId) } as AgentConnection;
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
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [closed, setClosed] = useState(false);
  const live = useRef(true);
  const lifecycle = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const endpoint = `${API_BASE_URL.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/agent-url-connections`;
  const active = (epoch = lifecycle.current) =>
    live.current && epoch === lifecycle.current && getAuthSessionGeneration() === authGeneration;
  const busy = loading || creating || revoking !== undefined;
  const selected = connections.find(
    (connection) => connection.id === selectedId && isActive(connection),
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
      // 直接使用服务器连接地址，不再探测本机监听或预检本地可用性。
      const result = await request(endpoint);
      if (!active(epoch)) return;
      if (!result || typeof result.available !== 'boolean' || !Array.isArray(result.connections))
        throw new AgentConnectionError('连接响应无效，请重试');
      const items: AgentConnection[] = result.connections.map((item: unknown) =>
        readConnection(item, projectId),
      );
      setConnections(items);
      setAvailable(result.available);
      setSelectedId((current) =>
        items.some((item) => item.id === current && isActive(item))
          ? current
          : items.find(isActive)?.id,
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
    if (busy || !available || !active()) return;
    const epoch = lifecycle.current;
    setCreating(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!active(epoch)) return;
      if (!result) throw new AgentConnectionError('连接响应无效，请重试');
      const connection = readConnection(result.connection, projectId);
      setConnections((items) => [connection, ...items.filter((item) => item.id !== connection.id)]);
      setSelectedId(connection.id);
      setNotice('连接已启用');
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
          ? connections.find((item) => item.id !== connectionId && isActive(item))?.id
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

  const bridgeKey = mcpUrl ? (mcpUrl.split('connection=')[1] ?? '') : '';
  const apiBase = mcpUrl
    ? (() => {
        try {
          const u = new URL(mcpUrl);
          return `${u.protocol}//${u.host}`;
        } catch {
          return API_BASE_URL;
        }
      })()
    : '';
  const bridgeTemplate = bridgeKey
    ? `node canvas-bridge.js --api ${apiBase} --token ${bridgeKey} --agent claude`
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
        <section aria-label="启用 Agent 连接" className="agent-connection-section">
          <Typography.Title level={5}>服务器连接</Typography.Title>
          <Button
            type="primary"
            loading={creating}
            disabled={busy || !available}
            onClick={() => void create()}
          >
            启用连接
          </Button>
          <Typography.Text type="secondary">
            连接长期有效，画布 API 重启或重新部署后地址不变，配置一次即可；不再需要时点击“停止”。
          </Typography.Text>
        </section>
        {mcpUrl && (
          <section aria-label="Agent 接入配置" className="agent-connection-section">
            <Typography.Title level={5}>接入配置</Typography.Title>
            <Alert
              type="info"
              showIcon
              title="服务器地址已包含当前项目的连接凭据，无需额外 Token，请妥善保管。"
            />
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
                        将配置加入 DSH 配置档的 cordis.patch.yml（如
                        %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml，已有 canvas-mcp
                        时只替换其中的 url）并重启 DSH；或保存为 canvas-mcp.cordis.yml 后运行 dsh
                        web --patch ./canvas-mcp.cordis.yml。
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
                {
                  key: 'bridge',
                  label: 'Canvas Bridge',
                  children: (
                    <>
                      <Typography.Paragraph>
                        下载桥接程序后在命令行运行，即可在画布「本地 Agent」侧栏与本机 Agent 聊天。
                        Agent 通过画布 MCP 操控当前项目，无需额外令牌。
                      </Typography.Paragraph>
                      <Button
                        onClick={() => {
                          const a = document.createElement('a');
                          a.href = `${API_BASE_URL.replace(/\/$/, '')}/v1/agent-bridge/download`;
                          a.download = 'canvas-bridge.js';
                          a.click();
                        }}
                      >
                        下载桥接程序
                      </Button>
                      <Input.TextArea
                        className="agent-connection-template"
                        aria-label="桥接程序启动命令"
                        readOnly
                        value={bridgeTemplate}
                        rows={3}
                      />
                      <Button onClick={() => void copy(bridgeTemplate, '桥接命令')}>
                        复制启动命令
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
                      {connection.expiresAt === null ? (
                        <Tag color="green">长期有效</Tag>
                      ) : (
                        !isActive(connection) && <Tag>已过期</Tag>
                      )}
                    </div>
                    {!connection.allowGeneration && (
                      <Typography.Text type="secondary">停止后重新启用可运行任务</Typography.Text>
                    )}
                    <Typography.Text type="secondary">
                      创建：{new Date(connection.createdAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                    {connection.expiresAt !== null && (
                      <Typography.Text type="secondary">
                        到期：{new Date(connection.expiresAt).toLocaleString('zh-CN')}
                      </Typography.Text>
                    )}
                  </div>
                  <div className="agent-connection-actions">
                    <Button
                      aria-label={`查看配置 ${connection.id}`}
                      disabled={busy || !isActive(connection)}
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

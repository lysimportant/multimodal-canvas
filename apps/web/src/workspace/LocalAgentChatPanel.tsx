import { Alert, Button, Drawer, Input, Select, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

import { apiFetch, getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import { API_BASE_URL } from './contracts';
import './LocalAgentChatPanel.css';

export type LocalAgentChatPanelProps = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /** 发送提示词前触发画布保存。 */
  saveCanvas: () => Promise<void>;
};

type AgentEvent =
  | { type: 'agent_message_chunk'; text: string }
  | { type: 'agent_thought_chunk'; text: string }
  | { type: 'tool_call'; name: string; status?: string }
  | { type: 'usage_update'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' }
  | { type: 'agent_error'; message: string };

type Message = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  /** Agent 的思考过程（可折叠展示）。 */
  thinking?: string;
  pending?: boolean;
};

type ModelOption = { value: string; name: string; description?: string };

type SessionProfile = {
  sessionId?: string;
  agent?: string;
  models?: ModelOption[];
  currentModel?: string;
};

type UrlConnectionSummary = { mcpPath?: string; expiresAt?: string | null };

type ActiveSession = { base: string; token: string; id: string };

class LocalAgentError extends Error {}

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:17871';
const CONFIG_STORAGE_KEY = 'canvas-agent-local-connection';
const LOCAL_BRIDGE_COMMAND = 'node canvas-bridge.js --local --no-token --agent claude';
const REQUEST_TIMEOUT_MS = 8_000;
/** 建立会话时要顺带启动 Agent（首次可能下载适配器），给更长的超时。 */
const CONNECT_TIMEOUT_MS = 120_000;

function normalizeLocalUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_LOCAL_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function readStoredConfig(): { url: string; token: string } {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return { url: DEFAULT_LOCAL_URL, token: '' };
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
    return {
      url: typeof parsed.url === 'string' && parsed.url ? parsed.url : DEFAULT_LOCAL_URL,
      token: typeof parsed.token === 'string' ? parsed.token : '',
    };
  } catch {
    return { url: DEFAULT_LOCAL_URL, token: '' };
  }
}

function writeStoredConfig(url: string, token: string): void {
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ url, token }));
  } catch {
    // 隐私模式下不可写，忽略。
  }
}

/** 免令牌模式不带 Authorization；桥接启动时配置了令牌则统一用 Bearer。 */
function authorizationHeaders(secret: string): Record<string, string> {
  const trimmed = secret.trim();
  return trimmed ? { authorization: `Bearer ${trimmed}` } : {};
}

/** 访问本机桥接服务：带超时，避免桥接未启动时长时间挂起。 */
async function localFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function errorMessageOf(reason: unknown, fallback: string): string {
  return reason instanceof LocalAgentError ? reason.message : fallback;
}

export function LocalAgentChatPanel({
  projectId,
  open,
  onClose,
  saveCanvas,
}: LocalAgentChatPanelProps) {
  const stored = useRef(readStoredConfig());
  const [closed, setClosed] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionAgent, setSessionAgent] = useState<string | undefined>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<string | undefined>();
  const [switchingModel, setSwitchingModel] = useState(false);
  const [localUrl, setLocalUrl] = useState(stored.current.url);
  const [token, setToken] = useState(stored.current.token);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const authGeneration = useRef(getAuthSessionGeneration());
  const live = useRef(true);
  const sseRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef<ActiveSession | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeAuthSession((_session) => {
      authGeneration.current = getAuthSessionGeneration();
      sseRef.current?.abort();
      sessionRef.current = undefined;
      setSessionId(undefined);
      setSessionAgent(undefined);
      setModels([]);
      setCurrentModel(undefined);
      setMessages([]);
      setStreaming(false);
      setSending(false);
      setError(undefined);
      setNotice(undefined);
    });
    return unsub;
  }, []);

  useEffect(() => {
    live.current = !closed;
  }, [closed]);

  useEffect(() => {
    if (open) {
      setClosed(false);
      setError(undefined);
      setNotice(undefined);
    }
  }, [open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 关闭时中止 SSE。
  useEffect(() => {
    if (!open) sseRef.current?.abort();
  }, [open]);

  const baseUrl = API_BASE_URL.replace(/\/$/, '');
  // 同源部署（VITE_API_BASE_URL 为空）时相对路径可用于请求，但下载地址等需要绝对地址。
  const bridgeApiBaseUrl = baseUrl || window.location.origin;

  const resolveMcpUrl = async (): Promise<string> => {
    const endpoint = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/agent-url-connections`;
    let listed: Response | undefined;
    try {
      listed = await apiFetch(endpoint, {}, { expectedAuthGeneration: authGeneration.current });
    } catch {
      listed = undefined;
    }
    if (listed?.ok) {
      const payload = (await listed.json().catch(() => ({}))) as {
        connections?: UrlConnectionSummary[];
      };
      const active = (payload.connections ?? []).find(
        (connection) =>
          connection.expiresAt === null || Date.parse(connection.expiresAt ?? '') > Date.now(),
      );
      if (active?.mcpPath) return `${bridgeApiBaseUrl}${active.mcpPath}`;
    }
    let created: Response;
    try {
      created = await apiFetch(
        endpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowGeneration: true }),
        },
        { expectedAuthGeneration: authGeneration.current },
      );
    } catch {
      throw new LocalAgentError('无法连接画布服务，请检查网络后重试');
    }
    if (created.status === 409) {
      throw new LocalAgentError('画布连接数已达上限，请先在 Agent 连接面板删除旧连接');
    }
    if (!created.ok) throw new LocalAgentError('无法为当前项目创建画布连接，请稍后重试');
    const payload = (await created.json().catch(() => ({}))) as {
      connection?: { mcpPath?: string };
    };
    const mcpPath = payload.connection?.mcpPath;
    if (!mcpPath) throw new LocalAgentError('画布服务未返回画布连接地址，请稍后重试');
    return `${bridgeApiBaseUrl}${mcpPath}`;
  };

  const startSse = (base: string, sid: string, secret: string) => {
    sseRef.current?.abort();
    const controller = new AbortController();
    sseRef.current = controller;
    let agentMsgId = '';
    /** 把一段内容合并进本轮最后一条 Agent 消息（没有就新建）。 */
    const appendToAgentMessage = (mutate: (message: Message) => Message) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.id === agentMsgId && last.role === 'agent') {
          return [...prev.slice(0, -1), mutate({ ...last, pending: true })];
        }
        agentMsgId = Math.random().toString(36).slice(2);
        return [...prev, mutate({ id: agentMsgId, role: 'agent', content: '', pending: true })];
      });
    };
    void (async () => {
      try {
        const response = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/events`, {
          headers: { ...authorizationHeaders(secret), accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`events ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            let event: AgentEvent;
            try {
              event = JSON.parse(dataLine.slice(5).trim()) as AgentEvent;
            } catch {
              continue;
            }
            if (!live.current) break;
            if (event.type === 'agent_message_chunk') {
              const text = event.text;
              appendToAgentMessage((message) => ({ ...message, content: message.content + text }));
            } else if (event.type === 'agent_thought_chunk') {
              const text = event.text;
              appendToAgentMessage((message) => ({
                ...message,
                thinking: (message.thinking ?? '') + text,
              }));
            } else if (event.type === 'done') {
              setStreaming(false);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'agent') {
                  return [...prev.slice(0, -1), { ...last, pending: false }];
                }
                return prev;
              });
            } else if (event.type === 'agent_error') {
              setStreaming(false);
              setError(event.message ?? 'Agent 出错');
            } else if (event.type === 'tool_call') {
              const name = event.name ?? '';
              setMessages((prev) => [
                ...prev,
                {
                  id: Math.random().toString(36).slice(2),
                  role: 'agent',
                  content: `🔧 ${name}`,
                  pending: false,
                },
              ]);
            }
          }
        }
      } catch {
        // 主动中止或桥接退出时不报错。
      }
    })();
  };

  const connectLocalAgent = async () => {
    if (connecting) return;
    const base = normalizeLocalUrl(localUrl);
    const secret = token.trim();
    setConnecting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      let health: Response;
      try {
        health = await localFetch(`${base}/health`);
      } catch {
        throw new LocalAgentError('无法连接本地 Agent 服务，请确认桥接程序已在本机运行');
      }
      if (!health.ok) throw new LocalAgentError('本地 Agent 服务响应异常，请检查桥接程序');
      const healthBody = (await health.json().catch(() => ({}))) as {
        agent?: string;
        auth?: string;
      };
      // 桥接以 --no-token 启动时只认本机画布页面来源，不需要令牌；旧版本没有 auth 字段，按令牌模式处理。
      const requiresToken = healthBody.auth !== 'none';
      if (requiresToken && !secret) {
        throw new LocalAgentError('请先填入桥接程序启动时打印的连接令牌，或用 --no-token 启动桥接');
      }

      const mcpUrl = await resolveMcpUrl();

      let sessionResponse: Response;
      try {
        sessionResponse = await localFetch(
          `${base}/sessions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authorizationHeaders(secret) },
            body: JSON.stringify({ projectId, mcpUrl }),
          },
          CONNECT_TIMEOUT_MS,
        );
      } catch {
        throw new LocalAgentError('无法连接本地 Agent 服务，请确认桥接程序已在本机运行');
      }
      if (sessionResponse.status === 401) {
        throw new LocalAgentError('连接令牌无效，请核对桥接程序启动时打印的 Connect token');
      }
      if (!sessionResponse.ok) {
        const failure = (await sessionResponse.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
        };
        if (
          failure.code === 'origin_rejected' ||
          failure.code === 'origin_required' ||
          failure.code === 'agent_start_failed'
        ) {
          throw new LocalAgentError(
            failure.error ?? '桥接程序拒绝了当前页面来源，请检查桥接程序的启动方式',
          );
        }
        throw new LocalAgentError('本地 Agent 服务拒绝了连接请求，请稍后重试');
      }
      const payload = (await sessionResponse.json().catch(() => ({}))) as SessionProfile;
      if (!payload.sessionId) {
        throw new LocalAgentError('本地 Agent 服务未返回会话编号，请升级桥接程序');
      }
      if (!live.current) return;
      setLocalUrl(base);
      setToken(secret);
      writeStoredConfig(base, secret);
      sessionRef.current = { base, token: secret, id: payload.sessionId };
      setSessionId(payload.sessionId);
      setSessionAgent(
        typeof payload.agent === 'string'
          ? payload.agent
          : typeof healthBody.agent === 'string'
            ? healthBody.agent
            : undefined,
      );
      setModels(Array.isArray(payload.models) ? payload.models : []);
      setCurrentModel(typeof payload.currentModel === 'string' ? payload.currentModel : undefined);
      startSse(base, payload.sessionId, secret);
      setNotice('已连接本机 Agent');
    } catch (reason) {
      if (live.current) setError(errorMessageOf(reason, '连接失败，请重试'));
    } finally {
      if (live.current) setConnecting(false);
    }
  };

  const sendPrompt = async () => {
    if (sending || streaming || !sessionId || !input.trim()) return;
    const session = sessionRef.current;
    if (!session) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setError(undefined);
    setNotice(undefined);
    const userMsgId = Math.random().toString(36).slice(2);
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', content: text }]);
    try {
      await saveCanvas();
      if (!live.current) return;
      const response = await localFetch(
        `${session.base}/sessions/${encodeURIComponent(session.id)}/prompt`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authorizationHeaders(session.token),
          },
          body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
        },
      );
      if (!response.ok) throw new LocalAgentError('发送失败，请重试');
      setStreaming(true);
    } catch (reason) {
      if (live.current) setError(errorMessageOf(reason, '发送失败，请重试'));
    } finally {
      if (live.current) setSending(false);
    }
  };

  const cancelTask = async () => {
    const session = sessionRef.current;
    if (!session) return;
    setError(undefined);
    try {
      await localFetch(`${session.base}/sessions/${encodeURIComponent(session.id)}/cancel`, {
        method: 'POST',
        headers: { ...authorizationHeaders(session.token) },
      });
      setStreaming(false);
    } catch {
      // 忽略取消失败。
    }
  };

  const changeModel = async (value: string) => {
    const session = sessionRef.current;
    if (!session || switchingModel || value === currentModel) return;
    const previous = currentModel;
    setSwitchingModel(true);
    setCurrentModel(value);
    setError(undefined);
    try {
      const response = await localFetch(
        `${session.base}/sessions/${encodeURIComponent(session.id)}/model`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authorizationHeaders(session.token) },
          body: JSON.stringify({ model: value }),
        },
      );
      if (!response.ok) throw new LocalAgentError('切换模型失败，请重试');
      const payload = (await response.json().catch(() => ({}))) as SessionProfile;
      if (typeof payload.currentModel === 'string') setCurrentModel(payload.currentModel);
      if (Array.isArray(payload.models)) setModels(payload.models);
    } catch (reason) {
      if (live.current) {
        setCurrentModel(previous);
        setError(errorMessageOf(reason, '切换模型失败，请重试'));
      }
    } finally {
      if (live.current) setSwitchingModel(false);
    }
  };

  const disconnect = () => {
    const session = sessionRef.current;
    sseRef.current?.abort();
    sseRef.current = undefined;
    sessionRef.current = undefined;
    setSessionId(undefined);
    setSessionAgent(undefined);
    setModels([]);
    setCurrentModel(undefined);
    setMessages([]);
    setStreaming(false);
    setSending(false);
    setNotice(undefined);
    setError(undefined);
    if (session) {
      void localFetch(`${session.base}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
        headers: { ...authorizationHeaders(session.token) },
      }).catch(() => undefined);
    }
  };

  const canSend = !!sessionId && !sending && !streaming && !!input.trim();

  const downloadBridge = () => {
    const anchor = document.createElement('a');
    anchor.href = `${bridgeApiBaseUrl}/v1/agent-bridge/download`;
    anchor.download = 'canvas-bridge.js';
    anchor.click();
  };

  return (
    <Drawer
      open={open && !closed}
      title="本地 Agent"
      placement="right"
      size="min(480px, 100vw)"
      destroyOnHidden
      closable={{ placement: 'end', 'aria-label': '关闭本地 Agent 聊天' }}
      rootClassName="local-agent-chat-panel"
      onClose={() => {
        disconnect();
        setClosed(true);
        onClose();
      }}
    >
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
      {notice && !error && (
        <Alert
          type="success"
          showIcon
          title={<span role="status">{notice}</span>}
          style={{ marginBottom: 12 }}
        />
      )}

      {!sessionId ? (
        connecting ? (
          <div className="local-agent-starting" role="status">
            <Spin />
            <div>
              <Typography.Text strong>正在启动本机 Agent…</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                首次启动可能需要下载 Agent 适配器，请稍候。
              </Typography.Paragraph>
            </div>
          </div>
        ) : (
          <div className="local-agent-setup">
            <Typography.Paragraph>
              桥接程序运行在你自己电脑上，浏览器直接连它聊天，请求不经过画布服务器。
            </Typography.Paragraph>
            <Typography.Title level={5}>1. 启动桥接程序</Typography.Title>
            <Input.TextArea
              className="local-agent-cmd"
              aria-label="启动命令"
              readOnly
              value={LOCAL_BRIDGE_COMMAND}
              rows={2}
            />
            <div className="local-agent-setup-actions">
              <Button onClick={downloadBridge}>下载桥接程序</Button>
            </div>
            <Typography.Title level={5}>2. 填入连接信息</Typography.Title>
            <label className="local-agent-field">
              <span>本地地址</span>
              <Input
                aria-label="本地地址"
                placeholder={DEFAULT_LOCAL_URL}
                value={localUrl}
                onChange={(event) => setLocalUrl(event.target.value)}
              />
            </label>
            <label className="local-agent-field">
              <span>连接令牌</span>
              <Input.Password
                aria-label="连接令牌"
                placeholder="用 --no-token 启动时可留空"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                上面的命令带 --no-token，通常不用填令牌；只有用 --local-token 启动时才需要。
              </Typography.Text>
            </label>
            <Button
              type="primary"
              loading={connecting}
              disabled={connecting}
              onClick={() => void connectLocalAgent()}
            >
              连接
            </Button>
          </div>
        )
      ) : (
        <div className="local-agent-chat">
          <div className="local-agent-identity">
            <Typography.Text>{`Agent：${sessionAgent ?? '未知'}`}</Typography.Text>
            {models.length > 0 ? (
              <Select
                aria-label="选择模型"
                size="small"
                style={{ minWidth: 150 }}
                value={currentModel}
                loading={switchingModel}
                disabled={switchingModel || sending || streaming}
                options={models.map((model) => ({
                  value: model.value,
                  label: model.name,
                  ...(model.description ? { title: model.description } : {}),
                }))}
                onChange={(value) => void changeModel(value)}
              />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                模型由 Agent 启动参数决定
              </Typography.Text>
            )}
          </div>
          <div className="local-agent-messages" aria-live="polite" aria-label="Agent 聊天记录">
            {messages.length === 0 && (
              <Typography.Text type="secondary">
                输入内容后发送，Agent 将读取并操控当前画布。
              </Typography.Text>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`local-agent-msg local-agent-msg--${msg.role}`}>
                {msg.thinking && (
                  <details className="local-agent-thought">
                    <summary>思考过程</summary>
                    <pre className="local-agent-thought-content">{msg.thinking}</pre>
                  </details>
                )}
                {msg.content && <pre className="local-agent-msg-content">{msg.content}</pre>}
                {msg.pending && <Spin size="small" />}
              </div>
            ))}
            {streaming && messages[messages.length - 1]?.role === 'user' && (
              <div className="local-agent-pending" role="status">
                <Spin size="small" />
                <span>Agent 正在响应…</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className="local-agent-input-row">
            <Input.TextArea
              className="local-agent-input"
              aria-label="输入消息"
              placeholder="发送给 Agent…（Enter 发送，Shift+Enter 换行）"
              value={input}
              disabled={sending || streaming}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) void sendPrompt();
                }
              }}
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
            <div className="local-agent-send-row">
              {streaming ? (
                <Button onClick={() => void cancelTask()}>停止</Button>
              ) : (
                <Button
                  type="primary"
                  disabled={!canSend}
                  loading={sending}
                  onClick={() => void sendPrompt()}
                >
                  发送
                </Button>
              )}
              <Button onClick={disconnect}>断开</Button>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

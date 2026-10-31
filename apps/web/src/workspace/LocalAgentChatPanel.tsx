import { Alert, Button, Drawer, Input, Spin, Typography } from 'antd';
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
  | { type: 'tool_call'; name: string; status?: string }
  | { type: 'usage_update'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' }
  | { type: 'agent_error'; message: string };

type Message = {
  id: string;
  role: 'user' | 'agent';
  content: string;
  pending?: boolean;
};

class LocalAgentError extends Error {}

export function LocalAgentChatPanel({
  projectId,
  open,
  onClose,
  saveCanvas,
}: LocalAgentChatPanelProps) {
  const [closed, setClosed] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [urlKey, setUrlKey] = useState<string | undefined>();
  const authGeneration = useRef(getAuthSessionGeneration());
  const live = useRef(true);
  const sseRef = useRef<AbortController | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 面板打开时加载第一个活跃 URL 连接 key，用于生成桥接启动命令。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(
          `${API_BASE_URL.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}/agent-url-connections`,
          {},
          { expectedAuthGeneration: authGeneration.current },
        );
        if (!response.ok || cancelled) return;
        const result = (await response.json()) as {
          connections?: { mcpPath?: string; expiresAt?: string | null }[];
        };
        if (cancelled) return;
        const active = (result.connections ?? []).find(
          (c) => c.expiresAt === null || Date.parse(c.expiresAt ?? '') > Date.now(),
        );
        if (!active?.mcpPath) return;
        const prefix = `/v1/projects/${encodeURIComponent(projectId)}/mcp?connection=`;
        const key = active.mcpPath.startsWith(prefix)
          ? active.mcpPath.slice(prefix.length)
          : undefined;
        if (key) setUrlKey(key);
      } catch {
        // 静默失败；bridgeCmd 会提示用户先创建连接。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  useEffect(() => {
    const unsub = subscribeAuthSession((_session) => {
      authGeneration.current = getAuthSessionGeneration();
      setSessionId(undefined);
      setMessages([]);
      setError(undefined);
      setNotice(undefined);
      sseRef.current?.abort();
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

  const connectSession = async () => {
    if (connecting || !projectId) return;
    setConnecting(true);
    setError(undefined);
    try {
      const response = await apiFetch(
        `${baseUrl}/v1/agent-bridge/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId }),
        },
        { expectedAuthGeneration: authGeneration.current },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const code = (body as { code?: string }).code;
        if (code === 'bridge_not_connected')
          throw new LocalAgentError('桥接程序未连接，请先在本机启动桥接程序后再试');
        throw new LocalAgentError('连接失败，请重试');
      }
      const { sessionId: sid } = (await response.json()) as { sessionId: string };
      if (!live.current) return;
      setSessionId(sid);
      startSse(sid);
      setNotice('已连接');
    } catch (reason) {
      if (live.current)
        setError(reason instanceof LocalAgentError ? reason.message : '连接失败，请重试');
    } finally {
      if (live.current) setConnecting(false);
    }
  };

  const startSse = (sid: string) => {
    sseRef.current?.abort();
    const controller = new AbortController();
    sseRef.current = controller;
    let agentMsgId = '';
    void (async () => {
      try {
        const response = await apiFetch(
          `${baseUrl}/v1/agent-bridge/sessions/${encodeURIComponent(sid)}/stream`,
          { signal: controller.signal },
          { expectedAuthGeneration: authGeneration.current },
        );
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            let ev: AgentEvent;
            try {
              ev = JSON.parse(dataLine.slice(6));
            } catch {
              continue;
            }
            if (!live.current) break;
            if (ev.type === 'agent_message_chunk') {
              const text = ev.text;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.id === agentMsgId && last.role === 'agent') {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: last.content + text, pending: true },
                  ];
                }
                agentMsgId = Math.random().toString(36).slice(2);
                return [...prev, { id: agentMsgId, role: 'agent', content: text, pending: true }];
              });
            } else if (ev.type === 'done') {
              setStreaming(false);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'agent')
                  return [...prev.slice(0, -1), { ...last, pending: false }];
                return prev;
              });
            } else if (ev.type === 'agent_error') {
              setStreaming(false);
              setError(ev.message ?? 'Agent 出错');
            } else if (ev.type === 'tool_call') {
              const name = ev.name ?? '';
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
        // SSE 中止或网络错误，不报错（用户主动断开属正常）。
      }
    })();
  };

  const sendPrompt = async () => {
    if (sending || streaming || !sessionId || !input.trim()) return;
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
      const response = await apiFetch(
        `${baseUrl}/v1/agent-bridge/sessions/${encodeURIComponent(sessionId)}/prompt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
        },
        { expectedAuthGeneration: authGeneration.current },
      );
      if (!response.ok) throw new LocalAgentError('发送失败，请重试');
      setStreaming(true);
    } catch (reason) {
      if (live.current)
        setError(reason instanceof LocalAgentError ? reason.message : '发送失败，请重试');
    } finally {
      if (live.current) setSending(false);
    }
  };

  const cancelTask = async () => {
    if (!sessionId) return;
    setError(undefined);
    try {
      await apiFetch(
        `${baseUrl}/v1/agent-bridge/sessions/${encodeURIComponent(sessionId)}/cancel`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        { expectedAuthGeneration: authGeneration.current },
      );
      setStreaming(false);
    } catch {
      // 忽略取消失败。
    }
  };

  const disconnect = () => {
    sseRef.current?.abort();
    setSessionId(undefined);
    setMessages([]);
    setStreaming(false);
    setNotice(undefined);
    setError(undefined);
  };

  const canSend = !!sessionId && !sending && !streaming && !!input.trim();

  const downloadBridge = () => {
    const a = document.createElement('a');
    a.href = `${baseUrl}/v1/agent-bridge/download`;
    a.download = 'canvas-bridge.js';
    a.click();
  };

  const bridgeCmd = urlKey
    ? `node canvas-bridge.js --api ${baseUrl} --token ${urlKey} --project ${projectId} --agent claude`
    : '（请先在 Agent 连接面板创建一个服务器连接，获取 token）';

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
        sseRef.current?.abort();
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
        <div className="local-agent-setup">
          <Typography.Paragraph>
            从 Agent 连接面板获取服务地址和连接凭据，下载并运行桥接程序后即可在此聊天。
          </Typography.Paragraph>
          <Typography.Title level={5}>启动命令</Typography.Title>
          <Input.TextArea
            className="local-agent-cmd"
            aria-label="桥接程序启动命令"
            readOnly
            value={bridgeCmd}
            rows={3}
          />
          <div className="local-agent-setup-actions">
            <Button onClick={downloadBridge}>下载桥接程序</Button>
            <Button
              type="primary"
              loading={connecting}
              disabled={connecting}
              onClick={() => void connectSession()}
            >
              连接
            </Button>
          </div>
        </div>
      ) : (
        <div className="local-agent-chat">
          <div className="local-agent-messages" aria-live="polite" aria-label="Agent 聊天记录">
            {messages.length === 0 && (
              <Typography.Text type="secondary">
                输入内容后发送，Agent 将读取并操控当前画布。
              </Typography.Text>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`local-agent-msg local-agent-msg--${msg.role}`}>
                <pre className="local-agent-msg-content">{msg.content}</pre>
                {msg.pending && <Spin size="small" />}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <div className="local-agent-input-row">
            <Input.TextArea
              className="local-agent-input"
              aria-label="输入消息"
              placeholder="发送给 Agent…（Enter 发送，Shift+Enter 换行）"
              value={input}
              disabled={sending || streaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
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

#!/usr/bin/env node
// 测试用最小 ACP Agent：通过 stdio 收发 NDJSON 的 JSON-RPC 消息。
//
// 用途：在 agent-bridge-routes 的端到端用例里替代真实 Agent 进程，
// 验证 canvas-bridge 的握手、会话复用、事件转发、权限自动放行、取消与错误路径。
// 行为由提示词文本触发：包含「取消」的长任务、包含「失败」的错误响应，其余为正常回合。
import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_AGENT_LOG;

/** @type {Map<number, (message: unknown) => void>} */
const pendingPermissions = new Map();
/** @type {{ id: number; sessionId: string } | null} */
let pendingPrompt = null;
let nextId = 1;
let stdinBuffer = '';

function record(direction, message) {
  if (!logPath) {
    return;
  }
  appendFileSync(logPath, `${JSON.stringify({ direction, message })}\n`);
}

function send(message) {
  record('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

function update(sessionId, payload) {
  notify('session/update', { sessionId, update: payload });
}

function chunk(sessionId, text) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

function promptText(blocks) {
  if (!Array.isArray(blocks)) {
    return '';
  }
  return blocks
    .map((block) =>
      block && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .join('');
}

function requestPermission(sessionId) {
  const id = nextId;
  nextId += 1;
  const promise = new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
  });
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: 'call-permission', title: '画布：新建图片节点' },
      options: [
        { optionId: 'allow-1', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'reject-1', name: '拒绝', kind: 'reject_once' },
      ],
    },
  });
  return promise;
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = promptText(params.prompt);
  record('prompt', { sessionId, text });
  if (text.includes('失败')) {
    fail(id, '假 Agent 故意失败');
    return;
  }
  if (text.includes('取消')) {
    pendingPrompt = { id, sessionId };
    chunk(sessionId, '开始长任务…');
    return;
  }
  chunk(sessionId, '你好：');
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: '画布：新建图片节点',
    kind: 'other',
    status: 'pending',
  });
  const outcome = await requestPermission(sessionId);
  const selected =
    outcome && outcome.outcome && outcome.outcome.outcome === 'selected'
      ? outcome.outcome.optionId
      : 'unknown';
  chunk(sessionId, `权限=${selected}`);
  update(sessionId, { sessionUpdate: 'usage_update', used: 12, size: 200000 });
  respond(id, { stopReason: 'end_turn' });
}

function handleCancel(sessionId) {
  const pending = pendingPrompt;
  if (!pending || pending.sessionId !== sessionId) {
    return;
  }
  pendingPrompt = null;
  respond(pending.id, { stopReason: 'cancelled' });
}

function handleMessage(message) {
  record('in', message);
  if (!message || typeof message !== 'object') {
    return;
  }
  if (typeof message.method === 'string') {
    if (message.id === undefined) {
      if (message.method === 'session/cancel') {
        handleCancel(message.params.sessionId);
      }
      return;
    }
    switch (message.method) {
      case 'initialize':
        respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
          agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
        });
        return;
      case 'session/new':
        respond(message.id, { sessionId: 'fake-acp-session-1' });
        return;
      case 'session/prompt':
        void handlePrompt(message.id, message.params);
        return;
      default:
        fail(message.id, `unexpected method: ${message.method}`);
        return;
    }
  }
  const resolver = pendingPermissions.get(message.id);
  if (resolver) {
    pendingPermissions.delete(message.id);
    resolver(message.result);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  stdinBuffer += data;
  let index = stdinBuffer.indexOf('\n');
  while (index >= 0) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`fake-acp-agent: bad line (${String(error)})\n`);
      }
    }
    index = stdinBuffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

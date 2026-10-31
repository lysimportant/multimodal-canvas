/**
 * 测试用的最小 ACP Agent：通过 stdio 跑 NDJSON JSON-RPC。
 *
 * 提示词分支：
 *  - 含「失败」：返回 JSON-RPC 错误，模拟 Agent 崩溃
 *  - 含「取消」：发一条消息后挂起，等 session/cancel 再返回 cancelled
 *  - 其他：回显文案 + tool_call + 请求权限 + usage_update，最后 end_turn
 *
 * 设置 FAKE_AGENT_LOG 时，把每条收发的消息追加写入该文件，便于断言。
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_AGENT_LOG;

function trace(direction, message) {
  if (!logPath) {
    return;
  }
  appendFileSync(logPath, `${JSON.stringify({ direction, message })}\n`);
}

function send(message) {
  trace('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

let nextRequestId = 1000;
const pending = new Map();
let sessionCount = 0;
let promptWaiting = null;

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function chunk(text) {
  notify('session/update', {
    sessionId: currentSessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

let currentSessionId = 'fake-acp-session-1';

function requestPermission(toolCallId, title) {
  const id = nextRequestId++;
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: currentSessionId,
      toolCall: { toolCallId, title },
      options: [
        { optionId: 'allow-1', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
        { optionId: 'reject-1', name: '拒绝', kind: 'reject_once' },
      ],
    },
  });
  return new Promise((resolve) => {
    pending.set(id, resolve);
  });
}

async function handlePrompt(id, params) {
  currentSessionId = params?.sessionId ?? currentSessionId;
  const text = promptText(params);
  if (text.includes('失败')) {
    replyError(id, -32603, '假 Agent 故意失败');
    return;
  }
  if (text.includes('取消')) {
    chunk('开始长任务…');
    await new Promise((resolve) => {
      promptWaiting = () => {
        promptWaiting = null;
        reply(id, { stopReason: 'cancelled' });
        resolve();
      };
    });
    return;
  }
  chunk('你好：');
  notify('session/update', {
    sessionId: currentSessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'fake-tool-1',
      title: '画布：新建图片节点',
    },
  });
  const outcome = await requestPermission('fake-tool-1', '画布：新建图片节点');
  const optionId = outcome?.outcome?.outcome === 'selected' ? outcome.outcome.optionId : 'none';
  chunk(`权限=${optionId}`);
  notify('session/update', {
    sessionId: currentSessionId,
    update: { sessionUpdate: 'usage_update', used: 12, size: 200000 },
  });
  reply(id, { stopReason: 'end_turn' });
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  trace('in', message);
  const { id, method, params } = message;

  if (method === undefined && id !== undefined) {
    const resolver = pending.get(id);
    if (resolver) {
      pending.delete(id);
      resolver(message.result ?? message.error);
    }
    return;
  }

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
      });
      return;
    case 'session/new':
      sessionCount += 1;
      currentSessionId = `fake-acp-session-${sessionCount}`;
      reply(id, { sessionId: currentSessionId });
      return;
    case 'session/prompt':
      void handlePrompt(id, params);
      return;
    case 'session/cancel':
      if (promptWaiting) {
        promptWaiting();
      }
      return;
    default:
      if (id !== undefined) {
        replyError(id, -32601, `unsupported method: ${String(method)}`);
      }
  }
});

reader.on('close', () => {
  process.exit(0);
});

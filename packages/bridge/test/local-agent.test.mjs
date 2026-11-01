/**
 * canvas-bridge 本地直连模式的黑盒测试：真实启动 dist/index.js，
 * 用假 ACP Agent 验证 health、会话、SSE 流、提示词、取消与鉴权。
 *
 * 运行：pnpm --filter ./packages/bridge test（会先构建 dist）
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BRIDGE_PATH = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const FAKE_AGENT_PATH = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const CONNECT_TOKEN = 'test-connect-token-0123456789';
const WORK_DIR = mkdtempSync(join(tmpdir(), 'canvas-bridge-test-'));
const AGENT_LOG = join(WORK_DIR, 'fake-agent.ndjson');

let bridge = null;
let baseUrl = '';
let stdout = '';
let stderr = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOutput(pattern, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(stdout);
    if (match) {
      return match;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${label} 超时；stdout：${stdout}\nstderr：${stderr}`);
    }
    await sleep(20);
  }
}

function channel(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (init.authorized !== false) {
    headers.authorization = `Bearer ${CONNECT_TOKEN}`;
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function readJson(response) {
  return response.json();
}

async function createSession(body = {}) {
  const response = await channel('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const payload = JSON.parse(text);
  assert.equal(typeof payload.sessionId, 'string');
  return payload.sessionId;
}

/** 打开 SSE 并收集事件，提供 waitFor 断言辅助。 */
async function openEvents(sessionId) {
  const controller = new AbortController();
  const response = await channel(`/sessions/${sessionId}/events`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = [];
  let buffer = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) {
            break;
          }
          const block = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 2);
          if (block.startsWith('data: ')) {
            events.push(JSON.parse(block.slice(6)));
          }
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        throw error;
      }
    }
  })();

  return {
    events,
    async waitFor(predicate, label, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) {
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error(`等待事件「${label}」超时；已收到：${JSON.stringify(events)}`);
        }
        await sleep(20);
      }
    },
    close() {
      controller.abort();
    },
  };
}

async function sendPrompt(sessionId, content) {
  const response = await channel(`/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  return response;
}

function agentLogLines() {
  try {
    return readFileSync(AGENT_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function countMethod(method) {
  return agentLogLines().filter(
    (entry) => entry.direction === 'in' && entry.message?.method === method,
  ).length;
}

before(async () => {
  bridge = spawn(
    process.execPath,
    [
      BRIDGE_PATH,
      '--local',
      '--port',
      '0',
      '--local-token',
      CONNECT_TOKEN,
      '--agent',
      'claude',
      '--agent-cmd',
      process.execPath,
      '--agent-args',
      FAKE_AGENT_PATH,
    ],
    {
      env: { ...process.env, FAKE_AGENT_LOG: AGENT_LOG },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  bridge.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  bridge.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  const urlMatch = await waitForOutput(/Local URL: (http:\/\/\S+)/, 'Local URL');
  baseUrl = urlMatch[1];
  const tokenMatch = await waitForOutput(/Connect token: (\S+)/, 'Connect token');
  assert.equal(tokenMatch[1], CONNECT_TOKEN);
});

after(async () => {
  if (!bridge) {
    return;
  }
  bridge.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    bridge.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

describe('canvas-bridge 本地直连模式', () => {
  it('GET /health 不需要令牌并返回服务信息', async () => {
    const response = await channel('/health', { authorized: false });
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.ok, true);
    assert.equal(payload.name, 'canvas-bridge');
    assert.equal(payload.agent, process.execPath);
  });

  it('除 /health 外都要求正确的连接令牌', async () => {
    const noToken = await fetch(`${baseUrl}/sessions/none/events`);
    assert.equal(noToken.status, 401);
    assert.equal((await readJson(noToken)).code, 'invalid_token');

    const wrongToken = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(wrongToken.status, 401);
  });

  it('未知会话返回 404', async () => {
    const response = await channel('/sessions/does-not-exist/events');
    assert.equal(response.status, 404);
    assert.equal((await readJson(response)).code, 'session_not_found');
  });

  it('转发提示词：消息块、工具调用、用量与 done 都会到达 SSE', async () => {
    const sessionId = await createSession({ projectId: 'project-alpha' });
    const stream = await openEvents(sessionId);
    try {
      const response = await sendPrompt(sessionId, '你好');
      assert.equal(response.status, 202);
      const { taskId } = await readJson(response);
      assert.equal(typeof taskId, 'string');

      await stream.waitFor((event) => event.type === 'done', 'done');
      const chunkText = stream.events
        .filter((event) => event.type === 'agent_message_chunk')
        .map((event) => event.text)
        .join('');
      assert.match(chunkText, /你好：/);
      assert.match(chunkText, /权限=allow-always/);

      const toolCalls = stream.events.filter((event) => event.type === 'tool_call');
      assert.equal(toolCalls.length, 1, '同一次工具调用只应转发一条 tool_call');
      assert.equal(toolCalls[0].name, '画布：新建图片节点');

      const usage = stream.events.find((event) => event.type === 'usage_update');
      assert.equal(usage?.inputTokens, 12);
      assert.equal(usage?.outputTokens, 200_000);
      const thoughts = stream.events
        .filter((event) => event.type === 'agent_thought_chunk')
        .map((event) => event.text)
        .join('');
      assert.match(thoughts, /先想一下/);
      assert.equal(stream.events.at(-1)?.type, 'done');
      assert.equal(
        stream.events.filter((event) => event.type === 'done').length,
        1,
        'done 只应出现一次',
      );
    } finally {
      stream.close();
      await channel(`/sessions/${sessionId}`, { method: 'DELETE' });
    }
  });

  it('取消长任务后用同一会话继续下一个任务', async () => {
    const sessionId = await createSession({ projectId: 'project-beta' });
    const stream = await openEvents(sessionId);
    try {
      const first = await sendPrompt(sessionId, '取消这个长任务');
      assert.equal(first.status, 202);
      await stream.waitFor(
        (event) => event.type === 'agent_message_chunk' && event.text.includes('开始长任务'),
        '长任务消息块',
      );

      const busy = await sendPrompt(sessionId, '再来一个');
      assert.equal(busy.status, 409);
      assert.equal((await readJson(busy)).code, 'prompt_in_progress');

      const cancelResponse = await channel(`/sessions/${sessionId}/cancel`, { method: 'POST' });
      assert.equal(cancelResponse.status, 204);
      await stream.waitFor((event) => event.type === 'done', '取消后的 done');
      assert.ok(countMethod('session/cancel') >= 1);

      const second = await sendPrompt(sessionId, '继续下一个任务');
      assert.equal(second.status, 202);
      await stream.waitFor(
        () => stream.events.filter((event) => event.type === 'done').length >= 2,
        '第二个任务的 done',
      );
      assert.equal(
        stream.events.some((event) => event.type === 'agent_error'),
        false,
      );
    } finally {
      stream.close();
      await channel(`/sessions/${sessionId}`, { method: 'DELETE' });
    }
  });

  it('没有进行中的任务时取消返回 409', async () => {
    const sessionId = await createSession();
    try {
      const response = await channel(`/sessions/${sessionId}/cancel`, { method: 'POST' });
      assert.equal(response.status, 409);
      assert.equal((await readJson(response)).code, 'no_active_task');
    } finally {
      await channel(`/sessions/${sessionId}`, { method: 'DELETE' });
    }
  });

  it('Agent 报错时回 agent_error + done', async () => {
    const sessionId = await createSession({ projectId: 'project-gamma' });
    const stream = await openEvents(sessionId);
    try {
      const response = await sendPrompt(sessionId, '请失败');
      assert.equal(response.status, 202);
      const error = await stream.waitFor((event) => event.type === 'agent_error', 'agent_error');
      assert.match(error.message, /假 Agent 故意失败/);
      await stream.waitFor((event) => event.type === 'done', '报错后的 done');
    } finally {
      stream.close();
      await channel(`/sessions/${sessionId}`, { method: 'DELETE' });
    }
  });

  it('拒绝不含用户消息的提示词', async () => {
    const sessionId = await createSession();
    try {
      const response = await channel(`/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'assistant', content: '我没有用户消息' }] }),
      });
      assert.equal(response.status, 400);
      assert.equal((await readJson(response)).code, 'invalid_prompt');
    } finally {
      await channel(`/sessions/${sessionId}`, { method: 'DELETE' });
    }
  });

  it('建会话时返回身份与模型，并可读取与切换模型', async () => {
    const createdResponse = await channel('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-models' }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = JSON.parse(createdText);
    assert.equal(created.agent, process.execPath);
    assert.deepEqual(
      created.models.map((model) => model.value),
      ['fake-small', 'fake-large'],
    );
    assert.equal(created.currentModel, 'fake-small');

    const modelsResponse = await channel(`/sessions/${created.sessionId}/models`);
    assert.equal(modelsResponse.status, 200);
    const profile = await readJson(modelsResponse);
    assert.deepEqual(
      profile.models.map((model) => model.value),
      ['fake-small', 'fake-large'],
    );
    assert.equal(profile.currentModel, 'fake-small');

    const switchResponse = await channel(`/sessions/${created.sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-large' }),
    });
    assert.equal(switchResponse.status, 200);
    const switched = await readJson(switchResponse);
    assert.equal(switched.currentModel, 'fake-large');

    const invalid = await channel(`/sessions/${created.sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await readJson(invalid)).code, 'invalid_model');

    await channel(`/sessions/${created.sessionId}`, { method: 'DELETE' });
  });

  it('整个流程只初始化一次 Agent，且每个会话复用自己的 ACP 会话', async () => {
    assert.equal(countMethod('initialize'), 1, stderr.slice(-2000));
    assert.ok(countMethod('session/new') >= 3);
    assert.match(stderr, /agent initialized/);
    assert.match(stderr, /local session created/);
  });
});

describe('canvas-bridge 免令牌模式（--no-token）', () => {
  const NO_TOKEN_HOME = mkdtempSync(join(tmpdir(), 'canvas-bridge-no-token-'));
  const ALLOWED_ORIGIN = 'http://127.0.0.1:5173';
  const FOREIGN_ORIGIN = 'http://evil.example.test';
  let server = null;
  let localUrl = '';
  let localStdout = '';
  let localStderr = '';

  async function waitFor(pattern, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = pattern.exec(localStdout);
      if (match) {
        return match;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 ${label} 超时；stdout：${localStdout}\nstderr：${localStderr}`);
      }
      await sleep(20);
    }
  }

  async function startBridge() {
    localStdout = '';
    localStderr = '';
    server = spawn(
      process.execPath,
      [
        BRIDGE_PATH,
        '--local',
        '--no-token',
        '--port',
        '0',
        '--agent',
        'claude',
        '--agent-cmd',
        process.execPath,
        '--agent-args',
        FAKE_AGENT_PATH,
      ],
      {
        env: {
          ...process.env,
          CANVAS_AGENT_HOME: NO_TOKEN_HOME,
          FAKE_AGENT_LOG: join(NO_TOKEN_HOME, 'fake-agent.ndjson'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    server.stderr.on('data', (chunk) => {
      localStderr += chunk.toString();
    });
    server.stdout.on('data', (chunk) => {
      localStdout += chunk.toString();
    });
    const urlMatch = await waitFor(/Local URL: (http:\/\/\S+)/, 'Local URL');
    localUrl = urlMatch[1];
    await waitFor(/免令牌模式/, '免令牌模式提示');
  }

  async function stopBridge() {
    if (!server) {
      return;
    }
    const current = server;
    server = null;
    current.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      current.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function createSessionFrom(origin) {
    const headers = { 'content-type': 'application/json' };
    if (origin) {
      headers.origin = origin;
    }
    return fetch(`${localUrl}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'project-no-token' }),
    });
  }

  before(startBridge);
  after(stopBridge);

  it('健康检查声明 auth: none，且令牌模式下才要求令牌', async () => {
    assert.match(localStdout, /Auth: none/);
    const response = await fetch(`${localUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.ok, true);
    assert.equal(payload.auth, 'none');
  });

  it('没有 Origin 头的请求被拒绝', async () => {
    const response = await createSessionFrom(null);
    assert.equal(response.status, 403);
    assert.equal((await readJson(response)).code, 'origin_required');
  });

  it('非本机来源的页面被拒绝', async () => {
    const response = await createSessionFrom(FOREIGN_ORIGIN);
    assert.equal(response.status, 403);
    assert.equal((await readJson(response)).code, 'origin_rejected');
  });

  it('首次来自本机画布页面的连接被记住，并写入配置文件', async () => {
    const response = await createSessionFrom(ALLOWED_ORIGIN);
    assert.equal(response.status, 201);
    const payload = await readJson(response);
    assert.equal(typeof payload.sessionId, 'string');

    const config = JSON.parse(readFileSync(join(NO_TOKEN_HOME, 'local-agent.json'), 'utf8'));
    assert.deepEqual(config.allowedOrigins, [ALLOWED_ORIGIN]);
    assert.equal(config.token, undefined);
  });

  it('记住来源后，同来源新连接直接放行，异来源仍被拒绝', async () => {
    const allowed = await createSessionFrom('http://localhost:5173');
    assert.equal(allowed.status, 201);

    const rejected = await createSessionFrom('http://127.0.0.1:9999');
    assert.equal(rejected.status, 403);
    assert.equal((await readJson(rejected)).code, 'origin_rejected');
  });

  it('重启后仍记住已授权的来源', async () => {
    await stopBridge();
    await startBridge();
    assert.match(localStdout, /已记住的页面来源/);

    const allowed = await createSessionFrom(ALLOWED_ORIGIN);
    assert.equal(allowed.status, 201);
  });
});

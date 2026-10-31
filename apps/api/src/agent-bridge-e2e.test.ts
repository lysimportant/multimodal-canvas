import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore } from './assets';
import { closeAllBridgeConnections } from './agent-bridge-routes';
import { TestAuthContext } from './fixtures/auth-session';
import { buildApp } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

/**
 * 端到端用例：真实的 canvas-bridge 进程 + 真实的（假）ACP Agent 子进程，
 * 走完整的 浏览器 SSE → API 中继 → 桥接 NDJSON → Agent stdio 链路。
 *
 * 桥接产物需要先构建；未构建时整组跳过，避免 `pnpm --filter ./apps/api test` 单跑失败。
 */
const BRIDGE_PATH = fileURLToPath(
  new URL('../../../packages/bridge/dist/index.js', import.meta.url),
);
const FAKE_AGENT_PATH = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

const apps: FastifyInstance[] = [];
const bridges: BridgeProcess[] = [];
const tempDirs: string[] = [];

type AgentLogEntry = {
  direction: 'in' | 'out' | 'prompt';
  message: { method?: string; id?: number; result?: { outcome?: { optionId?: string } } };
};

type BridgeProcess = {
  child: ChildProcess;
  stderr: () => string;
  stop: () => Promise<void>;
};

type BridgeFixture = Awaited<ReturnType<typeof fixture>>;

function startBridge(options: {
  api: string;
  token: string;
  projectId: string;
  agentLog: string;
}): BridgeProcess {
  const child = spawn(
    process.execPath,
    [
      BRIDGE_PATH,
      '--api',
      options.api,
      '--token',
      options.token,
      '--project',
      options.projectId,
      '--agent-cmd',
      process.execPath,
      '--agent-args',
      FAKE_AGENT_PATH,
    ],
    {
      env: { ...process.env, FAKE_AGENT_LOG: options.agentLog },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  const bridge: BridgeProcess = {
    child,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    },
  };
  bridges.push(bridge);
  return bridge;
}

async function fixture() {
  const context = new TestAuthContext();
  const session = await context.session({ email: 'bridge-e2e@example.test', role: 'admin' });
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const projectStore = new MemoryProjectStore();
  const app = buildApp({
    logger: false,
    ...context.appOptions,
    projectStore,
    assetStore: new MemoryAssetStore(),
    runService: new MemoryRunService({ stepDelayMs: 0 }),
  });
  apps.push(app);
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers,
    payload: { name: '桥接端到端项目' },
  });
  expect(projectResponse.statusCode).toBe(201);
  const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
  const connectionResponse = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/agent-url-connections`,
    headers,
    payload: {},
  });
  expect(connectionResponse.statusCode).toBe(201);
  const connection = connectionResponse.json<{ connection: { mcpPath: string } }>().connection;
  const key = connection.mcpPath.split('connection=')[1]!;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, headers, projectId, key, address };
}

async function createSession(f: BridgeFixture, attempts = 60): Promise<{ sessionId: string }> {
  const url = `${f.address}/v1/agent-bridge/sessions`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...f.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: f.projectId }),
    });
    if (response.status === 201) {
      const payload = (await response.json()) as { sessionId: string };
      return { sessionId: payload.sessionId };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`桥接程序在超时前未连接：${f.address}`);
}

type SseEvent = {
  type?: string;
  text?: string;
  name?: string;
  message?: string;
  inputTokens?: number;
};

function subscribeSse(f: BridgeFixture, sessionId: string) {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const ready = (async () => {
    try {
      const response = await fetch(`${f.address}/v1/agent-bridge/sessions/${sessionId}/stream`, {
        headers: f.headers,
        signal: controller.signal,
      });
      if (response.status !== 200) {
        return { close: () => controller.abort() };
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf('\n\n');
            while (index >= 0) {
              const block = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = block
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice(6);
              if (data) {
                events.push(JSON.parse(data) as SseEvent);
              }
              index = buffer.indexOf('\n\n');
            }
          }
        } catch {
          // 主动 abort 或连接被关闭，结束读取。
        }
      })();
      return { close: () => controller.abort() };
    } catch {
      return { close: () => controller.abort() };
    }
  })();
  return { events, ready };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时：${label}`);
}

async function sendPrompt(f: BridgeFixture, sessionId: string, content: string): Promise<string> {
  const response = await fetch(`${f.address}/v1/agent-bridge/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { ...f.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  expect(response.status).toBe(202);
  const payload = (await response.json()) as { taskId: string };
  return payload.taskId;
}

async function cancelTask(f: BridgeFixture, sessionId: string): Promise<void> {
  const response = await fetch(`${f.address}/v1/agent-bridge/sessions/${sessionId}/cancel`, {
    method: 'POST',
    headers: { ...f.headers, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(204);
}

async function readAgentLog(logPath: string): Promise<AgentLogEntry[]> {
  const content = await readFile(logPath, 'utf8').catch(() => '');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentLogEntry);
}

function countMethod(entries: AgentLogEntry[], method: string): number {
  return entries.filter((entry) => entry.direction === 'in' && entry.message.method === method)
    .length;
}

async function makeAgentLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-bridge-e2e-'));
  tempDirs.push(dir);
  return join(dir, 'agent.ndjson');
}

const hasBridge = existsSync(BRIDGE_PATH);

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  closeAllBridgeConnections();
});

beforeEach(() => {
  vi.stubEnv('API_JWT_SECRET', 'synthetic-bridge-e2e-secret');
});

describe.skipIf(!hasBridge)('agent-bridge 端到端（真实桥接进程 + 假 ACP Agent）', () => {
  it('转发提示词并流式回传消息、工具调用、用量并结束', { timeout: 30_000 }, async () => {
    const f = await fixture();
    const agentLog = await makeAgentLogPath();
    const bridge = startBridge({
      api: f.address,
      token: f.key,
      projectId: f.projectId,
      agentLog,
    });
    const { sessionId } = await createSession(f);
    const { events } = subscribeSse(f, sessionId);
    await sendPrompt(f, sessionId, '你好，新建一个图片节点');

    await waitFor(() => events.some((event) => event.type === 'done'), 20_000, 'done 事件');
    const chunks = events.filter((event) => event.type === 'agent_message_chunk');
    expect(chunks.map((event) => event.text).join('')).toContain('你好');
    expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    expect(events.some((event) => event.type === 'usage_update')).toBe(true);
    expect(events.some((event) => event.type === 'agent_error')).toBe(false);
    // done 必须是最后一个事件
    expect(events[events.length - 1]?.type).toBe('done');

    const entries = await readAgentLog(agentLog);
    expect(countMethod(entries, 'initialize')).toBe(1);
    expect(countMethod(entries, 'session/new')).toBe(1);
    expect(countMethod(entries, 'session/prompt')).toBe(1);
    const permissionResponse = entries.find(
      (entry) => entry.direction === 'in' && typeof entry.message.result?.outcome === 'object',
    );
    expect(permissionResponse?.message.result?.outcome?.optionId).toBe('allow-always');
    expect(bridge.stderr()).toContain('agent initialized');
    expect(bridge.stderr()).toContain('auto-approving');
  });

  it('取消长任务后 session 仍可继续下一个提示词', { timeout: 30_000 }, async () => {
    const f = await fixture();
    const agentLog = await makeAgentLogPath();
    const bridge = startBridge({
      api: f.address,
      token: f.key,
      projectId: f.projectId,
      agentLog,
    });
    const { sessionId } = await createSession(f);
    const { events } = subscribeSse(f, sessionId);

    await sendPrompt(f, sessionId, '开始一个可取消的长任务');
    await waitFor(
      () => events.some((event) => event.type === 'agent_message_chunk'),
      20_000,
      '长任务首个消息',
    );
    await cancelTask(f, sessionId);
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 1,
      20_000,
      '取消后的 done',
    );

    await sendPrompt(f, sessionId, '继续下一个任务');
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      20_000,
      '第二个提示词完成',
    );

    const entries = await readAgentLog(agentLog);
    expect(countMethod(entries, 'session/cancel')).toBe(1);
    // 同一个 ACP 会话复用，不再新建
    expect(countMethod(entries, 'session/new')).toBe(1);
    expect(bridge.stderr()).toContain('finished (cancelled)');
  });

  it('Agent 报错时回传 agent_error 并保持可用', { timeout: 30_000 }, async () => {
    const f = await fixture();
    const agentLog = await makeAgentLogPath();
    startBridge({ api: f.address, token: f.key, projectId: f.projectId, agentLog });
    const { sessionId } = await createSession(f);
    const { events } = subscribeSse(f, sessionId);

    await sendPrompt(f, sessionId, '这次触发失败');
    await waitFor(() => events.some((event) => event.type === 'done'), 20_000, '错误后的 done');
    const errorEvent = events.find((event) => event.type === 'agent_error');
    expect(errorEvent?.message).toContain('假 Agent 故意失败');

    await sendPrompt(f, sessionId, '错误之后恢复');
    await waitFor(
      () => events.filter((event) => event.type === 'done').length >= 2,
      20_000,
      '恢复后的 done',
    );
  });

  it('中继连接断开后自动重连并继续工作', { timeout: 40_000 }, async () => {
    const f = await fixture();
    const agentLog = await makeAgentLogPath();
    const bridge = startBridge({
      api: f.address,
      token: f.key,
      projectId: f.projectId,
      agentLog,
    });
    const { sessionId } = await createSession(f);
    subscribeSse(f, sessionId);

    // 模拟中继断开（等价于 API 侧长连接被关闭）。
    closeAllBridgeConnections();
    await waitFor(() => bridge.stderr().includes('reconnecting'), 10_000, '桥接程序开始退避重连');

    // 重连后浏览器侧的会话映射已失效，重新建会话即可继续。
    const reconnected = await createSession(f, 80);
    const { events: events2 } = subscribeSse(f, reconnected.sessionId);
    await sendPrompt(f, reconnected.sessionId, '重连之后继续');
    await waitFor(() => events2.some((event) => event.type === 'done'), 20_000, '重连后的 done');
    expect(bridge.stderr().match(/connected to/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 桥接进程与 Agent 子进程都没有重启：ACP 会话仍旧复用。
    const entries = await readAgentLog(agentLog);
    expect(countMethod(entries, 'initialize')).toBe(1);
    expect(countMethod(entries, 'session/new')).toBe(1);
  });

  it('下载接口返回构建好的桥接程序', { timeout: 20_000 }, async () => {
    const f = await fixture();
    const response = await fetch(`${f.address}/v1/agent-bridge/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('content-disposition')).toContain('canvas-bridge.js');
    const body = await response.text();
    expect(body.startsWith('#!')).toBe(true);
    expect(body).toContain('canvas-bridge');
    expect(body.length).toBeGreaterThan(100_000);
  });
});

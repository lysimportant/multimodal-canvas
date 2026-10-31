import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryAssetStore } from './assets';
import { TestAuthContext } from './fixtures/auth-session';
import { buildApp, type BuildAppOptions } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

const apps: FastifyInstance[] = [];

/**
 * 桥接中继为长连接流，必须 app.listen 后用原生 http 客户端读取，
 * 不能走 app.inject（hijack 后 Fastify 不再管理响应）。
 */
function connectStream(
  url: string,
  headers: Record<string, string>,
  onLine: (line: string) => void,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) onLine(line);
        }
      });
      response.on('error', reject);
      resolve({ close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function postNdjson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/x-ndjson',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function readSse(
  url: string,
  headers: Record<string, string>,
  onData: (data: string) => void,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) onData(dataLine.slice(6));
        }
      });
      response.on('error', reject);
      resolve({ close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fixture(extra: Pick<BuildAppOptions, 'bridgeFilePath'> = {}) {
  const context = new TestAuthContext();
  const session = await context.session({ email: 'bridge@example.test', role: 'admin' });
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const projectStore = new MemoryProjectStore();
  const assetStore = new MemoryAssetStore();
  const runService = new MemoryRunService({ stepDelayMs: 0 });
  const app = buildApp({
    logger: false,
    ...context.appOptions,
    projectStore,
    assetStore,
    runService,
    ...extra,
  });
  apps.push(app);
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers,
    payload: { name: '桥接项目' },
  });
  expect(projectResponse.statusCode).toBe(201);
  const projectId = projectResponse.json<{ project: { id: string } }>().project.id;
  const urlConn = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/agent-url-connections`,
    headers,
    payload: {},
  });
  expect(urlConn.statusCode).toBe(201);
  const connection = urlConn.json<{ connection: { id: string; mcpPath: string } }>().connection;
  const key = connection.mcpPath.split('connection=')[1]!;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    context,
    headers,
    projectId,
    connection,
    key,
    address,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv('API_JWT_SECRET', 'synthetic-bridge-test-secret');
});

describe('agent-bridge routes', () => {
  it('rejects connect without a valid url-key', async () => {
    const f = await fixture();
    const bad = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        `${f.address}/v1/agent-bridge/connect?projectId=${f.projectId}`,
        { method: 'GET', headers: { authorization: 'Bearer not-a-key' } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode! });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(bad.status).toBe(401);
  });

  it('accepts a valid url-key and sends ready + ping', async () => {
    const f = await fixture();
    const lines: string[] = [];
    const stream = await connectStream(
      `${f.address}/v1/agent-bridge/connect?projectId=${f.projectId}`,
      { authorization: `Bearer ${f.key}` },
      (line) => lines.push(line),
    );
    // ready 立即送达
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.some((l) => l.includes('"type":"ready"'))).toBe(true);
    // ping 在 20s 间隔，测试里只验证 ready；关闭流不影响断开清理
    stream.close();
  });

  it('returns 409 when no bridge is connected for the project', async () => {
    const f = await fixture();
    const res = await postJson(`${f.address}/v1/agent-bridge/sessions`, f.headers, {
      projectId: f.projectId,
    });
    expect(res.status).toBe(409);
    expect(res.body).toContain('bridge_not_connected');
  });

  it('relays prompt through to the bridge and events back to the browser SSE', async () => {
    const f = await fixture();
    // 桥接程序连接
    const bridgeLines: string[] = [];
    const stream = await connectStream(
      `${f.address}/v1/agent-bridge/connect?projectId=${f.projectId}`,
      { authorization: `Bearer ${f.key}` },
      (line) => bridgeLines.push(line),
    );

    // 浏览器创建会话
    const sessionRes = await postJson(`${f.address}/v1/agent-bridge/sessions`, f.headers, {
      projectId: f.projectId,
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = JSON.parse(sessionRes.body).sessionId;

    // 浏览器订阅 SSE
    const sseEvents: string[] = [];
    const sse = await readSse(
      `${f.address}/v1/agent-bridge/sessions/${sessionId}/stream`,
      f.headers,
      (data) => sseEvents.push(data),
    );

    // 浏览器发送提示词
    const promptRes = await postJson(
      `${f.address}/v1/agent-bridge/sessions/${sessionId}/prompt`,
      f.headers,
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    expect(promptRes.status).toBe(202);
    const taskId = JSON.parse(promptRes.body).taskId;

    // 桥接程序收到 prompt 任务
    await new Promise((r) => setTimeout(r, 100));
    const promptLine = bridgeLines.find((l) => l.includes('"type":"prompt"'));
    expect(promptLine).toBeDefined();
    expect(promptLine).toContain(taskId);

    // 桥接程序回传一个 agent 事件
    const eventsRes = await postNdjson(
      `${f.address}/v1/agent-bridge/tasks/${taskId}/events?projectId=${f.projectId}`,
      { authorization: `Bearer ${f.key}` },
      JSON.stringify({ type: 'agent_message_chunk', text: 'hi' }) +
        '\n' +
        JSON.stringify({ type: 'done' }) +
        '\n',
    );
    expect(eventsRes.status).toBe(204);

    // 浏览器 SSE 收到事件
    await new Promise((r) => setTimeout(r, 100));
    expect(sseEvents.some((e) => e.includes('"type":"agent_message_chunk"'))).toBe(true);

    sse.close();
    stream.close();
  });

  it('propagates cancel to the bridge', async () => {
    const f = await fixture();
    const bridgeLines: string[] = [];
    const stream = await connectStream(
      `${f.address}/v1/agent-bridge/connect?projectId=${f.projectId}`,
      { authorization: `Bearer ${f.key}` },
      (line) => bridgeLines.push(line),
    );

    const sessionRes = await postJson(`${f.address}/v1/agent-bridge/sessions`, f.headers, {
      projectId: f.projectId,
    });
    const sessionId = JSON.parse(sessionRes.body).sessionId;

    await postJson(`${f.address}/v1/agent-bridge/sessions/${sessionId}/prompt`, f.headers, {
      messages: [{ role: 'user', content: 'long' }],
    });

    const cancelRes = await postJson(
      `${f.address}/v1/agent-bridge/sessions/${sessionId}/cancel`,
      f.headers,
      {},
    );
    expect(cancelRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 100));
    expect(bridgeLines.some((l) => l.includes('"type":"cancel"'))).toBe(true);
    stream.close();
  });

  it('returns 404 when bridge file is missing', async () => {
    const f = await fixture({ bridgeFilePath: join(tmpdir(), 'nope-' + Date.now() + '.js') });
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(`${f.address}/v1/agent-bridge/download`, (response) => {
        response.resume();
        resolve({ status: response.statusCode! });
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it('serves the bridge file when it exists', async () => {
    const dir = join(tmpdir(), 'bridge-test-' + Date.now());
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'index.js');
    await writeFile(filePath, '// bridge bundle\n');
    const f = await fixture({ bridgeFilePath: filePath });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${f.address}/v1/agent-bridge/download`, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c: Buffer) => chunks.push(c));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('// bridge bundle');
    await rm(dir, { recursive: true, force: true });
  });
});

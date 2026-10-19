import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  CanvasMcpToolError,
  registerCanvasMcp,
  type CanvasMcpOptions,
  type CanvasMcpTool,
} from './canvas-mcp';

const tools: CanvasMcpTool[] = [
  {
    name: 'inspect_canvas',
    description: '读取合成画布内容',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
const apps: FastifyInstance[] = [];
const clients: Client[] = [];

/** 仅监听随机本机端口，执行器与项目均为合成数据，不使用真实鉴权或画布存储。 */
async function fixture(
  execute: CanvasMcpOptions['execute'] = async (_request, name, args) => ({ name, args }),
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-fixture-host-header', 'preserved');
  });
  registerCanvasMcp(app, { tools, execute });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const url = new URL('/v1/projects/project-a/mcp', address);
  return {
    app,
    url,
    async post(body: unknown, headers: Record<string, string> = {}, target = url) {
      return fetch(target, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    },
    async client() {
      const client = new Client({ name: 'canvas-protocol-test', version: '1.0.0' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      return { client, transport };
    },
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('画布无状态 Streamable HTTP MCP', () => {
  it('官方 Client 完成初始化、工具发现与调用，返回文本与结构化结果且不建立服务端会话', async () => {
    const f = await fixture();
    const { client, transport } = await f.client();
    expect(client.getServerVersion()).toEqual({ name: 'multimodal-canvas', version: '1.0.0' });
    expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: false } });
    expect(client.getInstructions()).toContain('run_node 必须携带唯一幂等键');
    expect(transport.sessionId).toBeUndefined();
    expect((await client.listTools()).tools).toEqual(tools);
    const result = await client.callTool({ name: 'inspect_canvas', arguments: { label: '示例' } });
    const expected = { name: 'inspect_canvas', args: { label: '示例' } };
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(expected) }],
      structuredContent: expected,
    });
  });

  it('初始化返回 JSON 并保留宿主响应头，通知返回 202 空响应，ping 返回 JSON-RPC 结果', async () => {
    const f = await fixture();
    const initialize = await f.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'synthetic-harness', version: '1.0.0' },
      },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('content-type')).toContain('application/json');
    expect(initialize.headers.get('x-fixture-host-header')).toBe('preserved');
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    expect(await initialize.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} } },
    });
    const notified = await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
    const ping = await f.post({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' });
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} });
  });

  it('未知方法、未知工具与无效工具参数返回协议错误，执行器不被调用', async () => {
    const execute = vi.fn<CanvasMcpOptions['execute']>();
    const f = await fixture(execute);
    const requests = [
      [{ method: 'missing/method' }, ErrorCode.MethodNotFound],
      [
        { method: 'tools/call', params: { name: 'missing_tool', arguments: {} } },
        ErrorCode.InvalidParams,
      ],
      [
        { method: 'tools/call', params: { name: 'inspect_canvas', arguments: { label: 12 } } },
        ErrorCode.InvalidParams,
      ],
      [
        {
          method: 'tools/call',
          params: { name: 'inspect_canvas', arguments: { label: '示例' }, task: {} },
        },
        ErrorCode.InvalidParams,
      ],
    ] as const;
    for (const [request, code] of requests) {
      const response = await f.post({ jsonrpc: '2.0', id: 9, ...request });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code } });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('业务错误具有可识别结构，未知异常不泄露原始消息或内部栈', async () => {
    let known = true;
    const f = await fixture(async () => {
      if (known)
        throw new CanvasMcpToolError(409, 'canvas_revision_conflict', '画布版本已变化', {
          expectedRevision: 4,
        });
      throw new Error('fixture-internal-exception-detail');
    });
    const { client } = await f.client();
    const call = () => client.callTool({ name: 'inspect_canvas', arguments: { label: '示例' } });
    const conflict = await call();
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          status: 409,
          code: 'canvas_revision_conflict',
          message: '画布版本已变化',
          details: { expectedRevision: 4 },
        },
      },
    });
    known = false;
    const unexpected = await call();
    expect(unexpected).toMatchObject({
      isError: true,
      structuredContent: { error: { status: 500, code: 'tool_execution_failed' } },
    });
    expect(JSON.stringify(unexpected)).not.toContain('fixture-internal-exception-detail');
    expect(JSON.stringify(unexpected)).not.toContain('stack');
  });

  it('并发请求即使 JSON-RPC id 相同也只使用各自用户和项目上下文', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const f = await fixture(async (request, _name, args) => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
      return { params: request.params, actor: request.headers['x-fixture-actor'], args };
    });
    const calls = ['first', 'second'].map(async (actor) => {
      const target = new URL(`/v1/projects/${actor}/mcp`, f.url);
      const response = await f.post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'inspect_canvas', arguments: { label: actor } },
        },
        { 'x-fixture-actor': actor },
        target,
      );
      expect(response.headers.get('mcp-session-id')).toBeNull();
      return response.json();
    });
    const results = await Promise.all(calls);
    results.forEach((result, index) => {
      const actor = ['first', 'second'][index];
      expect(result).toMatchObject({
        id: 1,
        result: {
          structuredContent: { params: { projectId: actor }, actor, args: { label: actor } },
        },
      });
    });
  });

  it.each(['GET', 'DELETE'])('%s 不创建长连接或会话，明确返回 405 与允许方法', async (method) => {
    const f = await fixture();
    const response = await fetch(f.url, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000 },
    });
  });

  it('拒绝不支持的 Accept、协议版本和无效 JSON，且不执行工具', async () => {
    const execute = vi.fn<CanvasMcpOptions['execute']>();
    const f = await fixture(execute);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const notAcceptable = await f.post(ping, { accept: 'application/json' });
    expect(notAcceptable.status).toBe(406);
    const version = await f.post(ping, { 'mcp-protocol-version': '1900-01-01' });
    expect(version.status).toBe(400);
    const parseError = await fetch(f.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{invalid-json',
    });
    expect(parseError.status).toBe(400);
    expect(await parseError.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: ErrorCode.ParseError, message: '请求不是有效的 JSON' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

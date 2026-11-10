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
    expect(client.getInstructions()).toContain(
      'create_node 的显示尺寸写在 node.width / node.height',
    );
    expect(client.getInstructions()).toContain('按 data.parameters.aspectRatio 推导长方形卡片');
    expect(client.getInstructions()).toContain('素材引用与连线必须双写');
    expect(client.getInstructions()).toContain('update_node');
    expect(client.getInstructions()).toContain('适度风格化的 3D CG / 2.5D CG 渲染');
    expect(client.getInstructions()).toContain('所有视频引擎共用人物风格与参考图规则');
    expect(client.getInstructions()).toContain('缺图时先用图片节点制作人物、场景参考图');
    expect(client.getInstructions()).toContain(
      '生成任何新参考图片前，先用 get_canvas 检查现有图片节点',
    );
    expect(client.getInstructions()).toContain('遍历 list_assets 返回的当前项目全部分页');
    expect(client.getInstructions()).toContain('直到 hasMore 为 false');
    expect(client.getInstructions()).toContain(
      '画布节点或连线被删除，不代表项目素材库中的资产被删除',
    );
    expect(client.getInstructions()).toContain('按名称、项目资产台账身份/变体及用途筛选候选');
    expect(client.getInstructions()).toContain('再用 get_image 查看候选的指定版本');
    expect(client.getInstructions()).toContain('复用完全相同的 assetId@assetVersion');
    expect(client.getInstructions()).toContain(
      '没有来源节点时创建 source 节点：node.data.assetId 填候选素材 ID',
    );
    expect(client.getInstructions()).toContain('node.data.assetId 填候选素材 ID');
    expect(client.getInstructions()).toContain(
      'create_node 操作顶层 assetVersion 填 get_image 已核实版本',
    );
    expect(client.getInstructions()).toContain('服务端据此生成对应固定版本 contentUrl');
    expect(client.getInstructions()).toContain(
      '只有确认全部项目资产分页中没有适用候选后才生成新参考图片',
    );
    expect(client.getInstructions()).toContain('候选身份、用途或版本不明确时暂停并报告');
    expect(client.getInstructions()).toContain('MCP 不执行自动图像语义匹配');
    expect(client.getInstructions()).toContain('【固定资产】→【视频生成风格类型】→【分镜】');
    expect(client.getInstructions()).toContain('仅当用户明确要求 H3 原生协议导出时');
    expect(client.getInstructions()).toContain('禁止默认退回手绘平涂');
    expect(client.getInstructions()).toContain('生成人物定妆图或人物参考图时');
    expect(client.getInstructions()).toContain('左侧 40% 放唯一大正脸');
    expect(client.getInstructions()).toContain('右侧 60% 全高均分');
    expect(client.getInstructions()).toContain('更换角色或服装时，只替换身份/面部锚点');
    expect(client.getInstructions()).toContain('纵向铺满全高');
    expect(client.getInstructions()).toContain('每栏上边界水平落在肩线/衣料肩线');
    expect(client.getInstructions()).toContain('头脸、颈部、发际线与发型均位于画框之外');
    expect(client.getInstructions()).toContain('人体采用自然成人比例');
    expect(client.getInstructions()).toContain('不另设材质球或服饰样本区');
    expect(client.getInstructions()).toContain('颜色保持清晰、有层次');
    expect(client.getInstructions()).toContain('背景为纯白纯色（#FFFFFF）');
    expect(client.getInstructions()).toContain('图片 mention＋一个空格＋姓名');
    expect(client.getInstructions()).toContain('先放 promptDocument 图片 mention 块');
    expect(client.getInstructions()).toContain('兼容既有“姓名＋一个空格＋图片 mention”的相邻结构');
    expect(client.getInstructions()).toContain('镜头正文里人物、场景首次出现处');
    expect(client.getInstructions()).toContain('台词行、声音：<…>、环境：…');
    expect(client.getInstructions()).toContain('禁止面部变形与五官不对称');
    expect(client.getInstructions()).toContain('minimax-h3-1 自动使用 H3 的 <Picture N>');
    expect(client.getInstructions()).toContain('重复 mention 复用同一编号和发送项');
    expect(client.getInstructions()).toContain('不同版本或用途保持独立');
    expect(client.getInstructions()).toContain('不能为了凑本地数量上限删减 mention');
    expect(client.getInstructions()).not.toContain('minimax-h3-1 使用通用 Image N');
    expect(client.getInstructions()).toContain('属于预览、提交或外部裸文本的输出语法');
    expect(client.getInstructions()).toContain(
      '当前画布不会自动把图片或人物外观转换成 <Subject N> 定义',
    );
    expect(client.getInstructions()).toContain('批量写入后必须逐节点打开“查看真实提示词”');
    expect(client.getInstructions()).not.toContain('H3 把角色外观写进');
    expect(client.getInstructions()).not.toContain('只适用于不经过 promptDocument 的手写文本');
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

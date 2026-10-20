import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { CanvasDocument, CanvasOperations, RunRecord } from '@multimodal-canvas/domain';

import { MemoryAssetStore } from './assets';
import { TestAuthContext } from './fixtures/auth-session';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp, type BuildAppOptions } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

const apps: FastifyInstance[] = [];
const clients: Client[] = [];
const modelAlias = 'synthetic-text-model';
const edge = {
  id: 'source-to-target',
  sourceNodeId: 'source',
  sourceHandle: 'output:text',
  targetNodeId: 'target',
  targetHandle: 'input:content',
  order: 0,
};

function generatedNode(id = 'target'): CanvasOperations['operations'][number] {
  return {
    type: 'create_node',
    node: {
      id,
      type: 'text',
      position: { x: 300, y: 0 },
      data: {
        label: '合成生成节点',
        mediaType: 'text',
        mode: 'generate',
        modelAlias,
        prompt: '概括输入内容',
        parameters: { temperature: 0.1 },
      },
    },
  };
}

function sourceNode(assetId: string, assetVersion = 1): CanvasOperations['operations'][number] {
  return {
    type: 'create_node',
    assetVersion,
    node: {
      id: 'source',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: '合成输入', mediaType: 'text', mode: 'source', assetId },
    },
  };
}

function rawLocalPost(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

async function expectToolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  status: number,
  code: string,
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { status, code } },
  });
  return result;
}

/** 合成登录和业务数据只驻留内存；官方 SDK 连接每例独立的随机本机端口。 */
async function fixture(
  allowGeneration = true,
  extra: Pick<BuildAppOptions, 'logger' | 'observability'> = {},
) {
  const context = new TestAuthContext();
  const session = await context.session({ email: 'canvas-agent@example.test', role: 'admin' });
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const projectStore = new MemoryProjectStore();
  const assetStore = new MemoryAssetStore();
  const runService = new MemoryRunService({ stepDelayMs: 0 });
  const settingsStore = new MemoryAiSettingsStore();
  settingsStore.replaceModels([
    {
      id: modelAlias,
      name: 'Synthetic text',
      mediaTypes: ['text'],
      refreshedAt: new Date().toISOString(),
    },
  ]);
  const app = buildApp({
    logger: false,
    ...context.appOptions,
    projectStore,
    assetStore,
    runService,
    settingsStore,
    ...extra,
  });
  apps.push(app);
  async function createProject(name: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ project: { id: string } }>().project.id;
  }
  const projectId = await createProject('合成 Agent 项目');
  const projectPath = `/v1/projects/${projectId}`;
  const issued = await app.inject({
    method: 'POST',
    url: `${projectPath}/agent-connections`,
    headers,
    payload: { allowGeneration, expiresInHours: 1 },
  });
  expect(issued.statusCode).toBe(201);
  expect(issued.headers['cache-control']).toBe('no-store');
  const connection = issued.json<{ token: string; connection: { id: string }; mcpPath: string }>();
  expect(connection.mcpPath).toBe(`${projectPath}/mcp`);
  const agentHeaders = { authorization: `Bearer ${connection.token}` };
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'canvas-integration-test', version: '1.0.0' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(connection.mcpPath, address), {
    requestInit: { headers: agentHeaders },
  });
  await client.connect(transport);
  return {
    app,
    context,
    session,
    headers,
    agentHeaders,
    connection,
    client,
    transport,
    address,
    projectStore,
    assetStore,
    runService,
    projectId,
    projectPath,
    createProject,
    async asset(project = projectId) {
      return assetStore.create({
        name: 'synthetic-input.txt',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('synthetic input version one'),
        projectId: project,
        ownerId: session.user.id,
      });
    },
    async mcp(headersOverride: Record<string, string> = {}, project = projectId) {
      return app.inject({
        method: 'POST',
        url: `/v1/projects/${project}/mcp`,
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          ...agentHeaders,
          ...headersOverride,
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_canvas', arguments: {} },
        },
      });
    },
  };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-canvas-agent-integration-secret');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('WORKER_PROVIDER', 'mock');
  vi.stubEnv('CORS_ORIGIN', 'http://localhost:5173');
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('项目 Agent 路由与官方 MCP Client 集成', () => {
  it('读取目录、原子建图、冻结素材版本、mock 生成及查询，重试幂等键只保留一次运行', async () => {
    const f = await fixture();
    expect(f.transport.sessionId).toBeUndefined();
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_canvas',
        'list_assets',
        'list_models',
        'apply_canvas_operations',
        'run_node',
        'get_run',
        'cancel_run',
      ]),
    );
    const initial = await call<{ canvas: CanvasDocument; projectId: string }>(
      f.client,
      'get_canvas',
    );
    expect(initial).toMatchObject({
      projectId: f.projectId,
      canvas: { revision: 0, nodes: [], edges: [] },
    });
    const asset = await f.asset();
    const assets = await call<{
      assets: Array<{ id: string; versions: Array<{ version: number; contentUrl: string }> }>;
    }>(f.client, 'list_assets');
    expect(assets.assets).toEqual([
      expect.objectContaining({
        id: asset.id,
        versions: [
          expect.objectContaining({
            version: 1,
            contentUrl: `/v1/assets/${asset.id}/versions/1/content`,
          }),
        ],
      }),
    ]);
    const models = await call<{ models: Array<{ id: string }> }>(f.client, 'list_models', {
      mediaType: 'text',
    });
    expect(models.models.map((model) => model.id)).toContain(modelAlias);
    const changed = await call<{ canvas: CanvasDocument }>(f.client, 'apply_canvas_operations', {
      revision: 0,
      operations: [
        sourceNode(asset.id),
        generatedNode(),
        { type: 'connect_nodes', edge },
        {
          type: 'update_node',
          nodeId: 'target',
          data: { prompt: '输出合成内容摘要', parameters: { temperature: 0.4, max_tokens: 128 } },
        },
        { type: 'move_node', nodeId: 'target', position: { x: 420, y: 80 } },
      ],
    });
    expect(changed.canvas).toMatchObject({ revision: 1, edges: [edge] });
    expect(changed.canvas.nodes.find((node) => node.id === 'target')).toMatchObject({
      position: { x: 420, y: 80 },
      data: { prompt: '输出合成内容摘要', parameters: { temperature: 0.4, max_tokens: 128 } },
    });
    // 添加更新的素材版本后仍须按建图时明确选中的旧版执行。
    await f.assetStore.createVersion(
      asset.id,
      { content: Buffer.from('synthetic input version two') },
      { projectId: f.projectId },
    );
    const refreshed = await call<{ canvas: CanvasDocument; ports: unknown[] }>(
      f.client,
      'get_canvas',
    );
    expect(refreshed.canvas).toEqual(changed.canvas);
    expect(refreshed.ports).toContainEqual(
      expect.objectContaining({
        nodeId: 'target',
        inputs: expect.arrayContaining(['input:content']),
      }),
    );
    const args = { nodeId: 'target', revision: 1, idempotencyKey: 'synthetic-complete-run' };
    const submitted = await call<{ run: RunRecord }>(f.client, 'run_node', args);
    const repeated = await call<{ run: RunRecord }>(f.client, 'run_node', args);
    expect(repeated.run.id).toBe(submitted.run.id);
    await expect
      .poll(async () => (await f.runService.get(submitted.run.id))?.status, { timeout: 2_000 })
      .toBe('succeeded');
    const queried = await call<{ run: RunRecord }>(f.client, 'get_run', {
      runId: submitted.run.id,
    });
    expect(queried.run).toMatchObject({
      id: submitted.run.id,
      projectId: f.projectId,
      status: 'succeeded',
      result: {
        provider: 'mock',
        targetNodeId: 'target',
        asset: { assetId: expect.any(String), version: 1 },
      },
    });
    const saved = await f.runService.get(submitted.run.id);
    expect(saved?.snapshot.nodes.find((node) => node.id === 'source')?.data).toMatchObject({
      assetId: asset.id,
      contentUrl: `/v1/assets/${asset.id}/versions/1/content`,
    });
    expect(saved?.snapshot.nodes.find((node) => node.id === 'target')?.data).toMatchObject({
      prompt: '输出合成内容摘要',
      parameters: { temperature: 0.4, max_tokens: 128 },
      modelAlias,
    });
    expect(saved?.snapshot.edges).toEqual([edge]);
    expect(await f.runService.listByProject(f.projectId)).toHaveLength(1);
    expect(
      await f.assetStore.get(queried.run.result!.asset!.assetId, { projectId: f.projectId }),
    ).toBeDefined();
  });

  it('旧 revision 既不能覆盖画布，也不能执行已经变化的节点', async () => {
    const f = await fixture();
    const changed = await call<{ canvas: CanvasDocument }>(f.client, 'apply_canvas_operations', {
      revision: 0,
      operations: [generatedNode()],
    });
    const stale = await expectToolError(
      f.client,
      'apply_canvas_operations',
      {
        revision: 0,
        operations: [{ type: 'move_node', nodeId: 'target', position: { x: 9, y: 9 } }],
      },
      409,
      'revision_conflict',
    );
    expect(stale.structuredContent).toMatchObject({ error: { details: { revision: 1 } } });
    await expectToolError(
      f.client,
      'run_node',
      { nodeId: 'target', revision: 0, idempotencyKey: 'stale-run' },
      409,
      'revision_conflict',
    );
    expect(await f.projectStore.getCanvas(f.projectId)).toEqual(changed.canvas);
    expect(await f.runService.listByProject(f.projectId)).toEqual([]);
  });

  it('批次后段语义非法时不保存前段新建节点，也不推进 revision', async () => {
    const f = await fixture();
    const before = structuredClone(await f.projectStore.getCanvas(f.projectId));
    await expectToolError(
      f.client,
      'apply_canvas_operations',
      {
        revision: 0,
        operations: [
          generatedNode(),
          {
            type: 'connect_nodes',
            edge: { ...edge, sourceNodeId: 'target', targetNodeId: 'missing-target' },
          },
        ],
      },
      400,
      'invalid_operation',
    );
    expect(await f.projectStore.getCanvas(f.projectId)).toEqual(before);
  });

  it.each(['missing-version', 'other-project', 'private-library'] as const)(
    '来源素材 %s 不可引入当前画布，整个批次不写入',
    async (kind) => {
      const f = await fixture();
      const asset =
        kind === 'private-library'
          ? await f.assetStore.create({
              name: 'private.txt',
              mediaType: 'text',
              mimeType: 'text/plain',
              content: Buffer.from('private synthetic data'),
              ownerId: f.session.user.id,
            })
          : await f.asset(
              kind === 'other-project' ? await f.createProject('另一个合成项目') : f.projectId,
            );
      const before = structuredClone(await f.projectStore.getCanvas(f.projectId));
      await expectToolError(
        f.client,
        'apply_canvas_operations',
        {
          revision: 0,
          operations: [generatedNode(), sourceNode(asset.id, kind === 'missing-version' ? 99 : 1)],
        },
        400,
        'invalid_asset',
      );
      expect(await f.projectStore.getCanvas(f.projectId)).toEqual(before);
      if (kind !== 'missing-version') {
        const listed = await call<{ assets: unknown[] }>(f.client, 'list_assets');
        expect(listed.assets).toEqual([]);
      }
    },
  );

  it('项目令牌不能通过直接运行请求覆盖提示词并读取未绑定的个人素材', async () => {
    const f = await fixture();
    await call(f.client, 'apply_canvas_operations', { revision: 0, operations: [generatedNode()] });
    const asset = await f.assetStore.create({
      name: 'unbound-private.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('synthetic private content outside the project'),
      ownerId: f.session.user.id,
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/nodes/target/runs',
      headers: f.agentHeaders,
      payload: {
        projectId: f.projectId,
        canvasRevision: 1,
        idempotencyKey: 'synthetic-run-override',
        promptDocument: {
          version: 1,
          blocks: [
            { type: 'text', text: 'Summarize the reference.' },
            {
              type: 'mention',
              mentionId: 'private-reference',
              assetId: asset.id,
              assetVersion: 1,
              label: 'Private reference',
              mediaType: 'text',
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('agent_scope_denied');
    expect(await f.runService.listByProject(f.projectId)).toEqual([]);
  });

  it('未授予生成权限的连接仍可编辑，但不能创建运行', async () => {
    const f = await fixture(false);
    await call(f.client, 'apply_canvas_operations', { revision: 0, operations: [generatedNode()] });
    await expectToolError(
      f.client,
      'run_node',
      { nodeId: 'target', revision: 1, idempotencyKey: 'disallowed-run' },
      403,
      'agent_scope_denied',
    );
    expect(await f.runService.listByProject(f.projectId)).toEqual([]);
  });

  it('项目令牌不能访问同一用户的其他项目，其他用户不能签发本项目连接', async () => {
    const f = await fixture();
    const anotherProject = await f.createProject('同账号另一个项目');
    const wrongProject = await f.mcp({}, anotherProject);
    expect(wrongProject.statusCode).toBe(403);
    expect(wrongProject.json().code).toBe('agent_scope_denied');
    const read = await f.app.inject({
      method: 'GET',
      url: `/v1/projects/${anotherProject}/canvas`,
      headers: f.agentHeaders,
    });
    expect(read.statusCode).toBe(403);
    const otherSession = await f.context.session({ email: 'different-owner@example.test' });
    const issued = await f.app.inject({
      method: 'POST',
      url: `${f.projectPath}/agent-connections`,
      headers: { authorization: `Bearer ${otherSession.accessToken}` },
      payload: {},
    });
    expect(issued.statusCode).toBe(404);
  });

  it('撤销后已连接 SDK 的后续调用立即拒绝，普通登录 JWT 不能用于 MCP', async () => {
    const f = await fixture();
    const normalSession = await f.mcp(f.headers);
    expect(normalSession.statusCode).toBe(401);
    expect(normalSession.json().code).toBe('agent_token_required');
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `${f.projectPath}/agent-connections/${f.connection.connection.id}`,
      headers: f.headers,
    });
    expect(revoked.statusCode).toBe(204);
    const rejected = await f.mcp();
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe('invalid_agent_token');
    await expect(f.client.callTool({ name: 'get_canvas', arguments: {} })).rejects.toMatchObject({
      code: 401,
    });
  });

  it.each<Record<string, string>>([
    { origin: 'https://untrusted.example.test' },
    { origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' },
  ])('拒绝错误 Origin 或浏览器跨站请求 %j', async (originHeaders) => {
    const f = await fixture();
    const response = await f.mcp(originHeaders);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('origin_rejected');
  });

  it('连接不能管理账户或再签令牌，普通会话可见的连接列表只返回脱敏元数据', async () => {
    const f = await fixture();
    const profile = await f.app.inject({
      method: 'GET',
      url: '/v1/account/profile',
      headers: f.agentHeaders,
    });
    expect(profile.statusCode).toBe(403);
    expect(profile.json().code).toBe('agent_scope_denied');
    const revokeOthers = await f.app.inject({
      method: 'POST',
      url: '/v1/account/sessions/revoke-others',
      headers: f.agentHeaders,
      payload: {},
    });
    expect(revokeOthers.statusCode).toBe(403);
    const reissue = await f.app.inject({
      method: 'POST',
      url: `${f.projectPath}/agent-connections`,
      headers: f.agentHeaders,
      payload: { allowGeneration: true },
    });
    expect(reissue.statusCode).toBe(403);
    expect(reissue.json().code).toBe('agent_scope_denied');
    const listed = await f.app.inject({
      method: 'GET',
      url: `${f.projectPath}/agent-connections`,
      headers: f.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json().connections).toEqual([
      expect.objectContaining({
        id: f.connection.connection.id,
        projectId: f.projectId,
        allowGeneration: true,
      }),
    ]);
    expect(listed.body.includes(f.connection.token)).toBe(false);
    for (const entry of listed.json().connections) {
      expect(entry).not.toHaveProperty('token');
      expect(entry).not.toHaveProperty('tokenHash');
    }
    expect(
      (await f.app.inject({ method: 'GET', url: '/v1/account/profile', headers: f.headers }))
        .statusCode,
    ).toBe(200);
  });

  it('get_image 返回指定版本的原生 MCP image block，不能读取其他项目或未绑定私人图片', async () => {
    const f = await fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=',
      'base64',
    );
    const image = {
      name: 'synthetic-pixel.png',
      mediaType: 'image' as const,
      mimeType: 'image/png',
      content: png,
      ownerId: f.session.user.id,
    };
    const local = await f.assetStore.create({ ...image, projectId: f.projectId });
    const foreign = await f.assetStore.create({
      ...image,
      projectId: await f.createProject('图片隔离项目'),
    });
    const privateImage = await f.assetStore.create(image);
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain('get_image');
    const result = await f.client.callTool({
      name: 'get_image',
      arguments: { assetId: local.id, version: 1 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ assetId: local.id, version: 1 });
    expect(result.content).toContainEqual({
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    for (const asset of [foreign, privateImage]) {
      await expectToolError(
        f.client,
        'get_image',
        { assetId: asset.id, version: 1 },
        404,
        'canvas_request_failed',
      );
    }
    await expectToolError(
      f.client,
      'get_image',
      { assetId: local.id, version: 99 },
      404,
      'canvas_request_failed',
    );
  });

  it('get_image 拒绝非图片与超过4MiB的版本，超限不读取素材正文', async () => {
    const f = await fixture();
    const text = await f.asset();
    await expectToolError(
      f.client,
      'get_image',
      { assetId: text.id, version: 1 },
      400,
      'unsupported_image',
    );
    const oversized = await f.assetStore.create({
      name: 'synthetic-oversized.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.alloc(4 * 1024 * 1024 + 1),
      projectId: f.projectId,
      ownerId: f.session.user.id,
    });
    const readContent = vi.spyOn(f.assetStore, 'getVersionContent');
    await expectToolError(
      f.client,
      'get_image',
      { assetId: oversized.id, version: 1 },
      413,
      'image_too_large',
    );
    expect(readContent).not.toHaveBeenCalled();
  });

  it('即使拥有其他项目，当前连接仍不能读取或取消其他项目的运行', async () => {
    const f = await fixture();
    const otherProject = await f.createProject('另一个运行项目');
    const canvasResponse = await f.app.inject({
      method: 'POST',
      url: `/v1/projects/${otherProject}/canvas/operations`,
      headers: f.headers,
      payload: { revision: 0, operations: [generatedNode('other-target')] },
    });
    expect(canvasResponse.statusCode).toBe(200);
    const submitted = await f.app.inject({
      method: 'POST',
      url: '/v1/nodes/other-target/runs',
      headers: f.headers,
      payload: { projectId: otherProject, canvasRevision: 1, idempotencyKey: 'other-project-run' },
    });
    expect(submitted.statusCode).toBe(202);
    const runId = submitted.json<{ run: { id: string } }>().run.id;
    const cancel = vi.spyOn(f.runService, 'cancel');
    await expectToolError(f.client, 'get_run', { runId }, 403, 'agent_scope_denied');
    await expectToolError(f.client, 'cancel_run', { runId }, 403, 'agent_scope_denied');
    expect(cancel).not.toHaveBeenCalled();
    await expect.poll(async () => (await f.runService.get(runId))?.status).toBe('succeeded');
  });
});

describe('服务器 MCP 连接地址', () => {
  async function urlFixture(
    payload: Record<string, unknown> = {},
    extra: Pick<BuildAppOptions, 'logger' | 'observability'> = {},
  ) {
    const f = await fixture(true, extra);
    const path = `${f.projectPath}/agent-url-connections`;
    const remote = {
      remoteAddress: '192.0.2.10',
      headers: { ...f.headers, host: 'canvas.example.test', 'x-forwarded-for': '198.51.100.10' },
    };
    const created = await f.app.inject({ method: 'POST', url: path, payload, ...remote });
    expect(created.statusCode).toBe(201);
    const { connection } = created.json<{
      connection: { id: string; projectId: string; allowGeneration: boolean; mcpPath: string };
    }>();
    expect(connection.mcpPath).toMatch(
      new RegExp(`^${f.projectPath}/mcp\\?connection=[A-Za-z0-9_-]{43}$`),
    );
    expect(created.json()).not.toHaveProperty('token');
    expect(created.body).not.toContain('cva1.');
    const client = new Client({ name: 'synthetic-url-agent', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpPath, f.address)));
    const mcp = (url = connection.mcpPath, headers: Record<string, string> = {}) =>
      f.app.inject({
        method: 'POST',
        url,
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          ...headers,
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_canvas', arguments: {} },
        },
      });
    return { ...f, path, remote, urlConnection: connection, urlClient: client, urlMcp: mcp };
  }

  it('远程登录可创建列出撤销；官方SDK仅复制URL就默认完成读取、连线调参和mock生成', async () => {
    const f = await urlFixture();
    expect(f.urlConnection.allowGeneration).toBe(true);
    const initial = await call<{ canvas: CanvasDocument }>(f.urlClient, 'get_canvas');
    const asset = await f.asset();
    const edited = await call<{ canvas: CanvasDocument }>(f.urlClient, 'apply_canvas_operations', {
      revision: initial.canvas.revision,
      operations: [
        sourceNode(asset.id),
        generatedNode(),
        { type: 'connect_nodes', edge },
        { type: 'update_node', nodeId: 'target', data: { parameters: { temperature: 0.6 } } },
      ],
    });
    const submitted = await call<{ run: RunRecord }>(f.urlClient, 'run_node', {
      nodeId: 'target',
      revision: edited.canvas.revision,
      idempotencyKey: 'default-url-generation',
    });
    await expect
      .poll(async () => (await f.runService.get(submitted.run.id))?.status)
      .toBe('succeeded');
    expect(edited.canvas.edges).toEqual([edge]);
    const listed = await f.app.inject({ method: 'GET', url: f.path, ...f.remote });
    expect(listed.json()).toEqual({ available: true, connections: [f.urlConnection] });
    expect(listed.body).not.toContain('cva1.');
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `${f.path}/${f.urlConnection.id}`,
      ...f.remote,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await f.urlMcp()).statusCode).toBe(401);
    expect(
      (await f.app.inject({ method: 'GET', url: f.path, ...f.remote })).json().connections,
    ).toEqual([]);
  });

  it('显式false的既有受限语义保留，其他账号或项目不能管理地址', async () => {
    const f = await urlFixture({ allowGeneration: false });
    await call(f.urlClient, 'apply_canvas_operations', {
      revision: 0,
      operations: [generatedNode()],
    });
    await expectToolError(
      f.urlClient,
      'run_node',
      { nodeId: 'target', revision: 1, idempotencyKey: 'url-read-edit-only' },
      403,
      'agent_scope_denied',
    );
    const other = await f.context.session({ email: 'foreign-url-manager@example.test' });
    const inaccessible = await f.app.inject({
      method: 'GET',
      url: f.path,
      headers: { authorization: `Bearer ${other.accessToken}` },
    });
    expect(inaccessible.statusCode).toBe(404);
    const otherProject = await f.createProject('URL隔离项目');
    const listed = await f.app.inject({
      method: 'GET',
      url: `/v1/projects/${otherProject}/agent-url-connections`,
      headers: f.headers,
    });
    expect(listed.json()).toEqual({ available: true, connections: [] });
    const wrongRevoke = await f.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${otherProject}/agent-url-connections/${f.urlConnection.id}`,
      headers: f.headers,
    });
    expect(wrongRevoke.statusCode).toBe(404);
  });

  it('拒绝错误键、跨项目、重复/额外参数和混合认证，不允许其他API使用查询键', async () => {
    const f = await urlFixture();
    const other = await f.createProject('另一个URL项目');
    const key = new URL(f.urlConnection.mcpPath, f.address).searchParams.get('connection')!;
    const bad = await f.urlMcp(`${f.projectPath}/mcp?connection=${'x'.repeat(43)}`);
    expect(bad.statusCode).toBe(401);
    expect((await f.urlMcp(f.urlConnection.mcpPath.replace(f.projectId, other))).statusCode).toBe(
      401,
    );
    for (const url of [
      `${f.urlConnection.mcpPath}&connection=${key}`,
      `${f.urlConnection.mcpPath}&other=1`,
    ])
      expect((await f.urlMcp(url)).statusCode).toBe(400);
    for (const headers of [f.headers, f.agentHeaders, { cookie: 'synthetic=value' }])
      expect((await f.urlMcp(undefined, headers)).statusCode).toBe(400);
    expect(
      (await f.app.inject({ method: 'GET', url: `/v1/models?connection=${key}` })).statusCode,
    ).toBe(401);
  });

  it.each<Record<string, string>>([
    { origin: 'http://localhost:5173' },
    { origin: 'https://untrusted.example.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])('拒绝浏览器来源 %j', async (headers) => {
    const f = await urlFixture();
    expect((await f.urlMcp(undefined, headers)).statusCode).toBe(403);
  });

  it.each(['disabled', 'revoked'] as const)('账户%s后连接立即失效并清理映射', async (state) => {
    const f = await urlFixture();
    if (state === 'disabled')
      await f.context.store.updateUser(f.session.user.id, { status: 'disabled' });
    else {
      const revoked = await f.app.inject({
        method: 'DELETE',
        url: `${f.projectPath}/agent-connections/${f.urlConnection.id}`,
        headers: f.headers,
      });
      expect(revoked.statusCode).toBe(204);
    }
    expect((await f.urlMcp()).statusCode).toBe(401);
    if (state === 'revoked')
      expect(
        (await f.app.inject({ method: 'GET', url: f.path, headers: f.headers })).json().connections,
      ).toEqual([]);
  });

  it('本地、URL、旧Bearer并发签发共用每项目20上限', async () => {
    const f = await fixture();
    const requests = Array.from({ length: 24 }, (_, index) => {
      const endpoint = ['agent-connections', 'local-agent-connections', 'agent-url-connections'][
        index % 3
      ];
      return f.app.inject({
        method: 'POST',
        url: `${f.projectPath}/${endpoint}`,
        headers: { ...f.headers, host: new URL(f.address).host },
        remoteAddress: '127.0.0.1',
        payload: {},
      });
    });
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(19);
    expect(results.filter((result) => result.statusCode === 409)).toHaveLength(5);
    const listed = await f.app.inject({
      method: 'GET',
      url: `${f.projectPath}/agent-connections`,
      headers: f.headers,
    });
    expect(listed.json().connections).toHaveLength(20);
  });

  it('主服务关闭先撤销URL和本地授权，再关闭会话存储', async () => {
    const f = await urlFixture();
    const local = await f.app.inject({
      method: 'POST',
      url: `${f.projectPath}/local-agent-connections`,
      headers: { ...f.headers, host: new URL(f.address).host },
      remoteAddress: '127.0.0.1',
      payload: {},
    });
    expect(local.statusCode).toBe(201);
    let storeClosed = false;
    vi.spyOn(f.context.store, 'close').mockImplementation(async () => {
      storeClosed = true;
    });
    const revoke = f.context.store.revokeSession.bind(f.context.store);
    const revoked: string[] = [];
    vi.spyOn(f.context.store, 'revokeSession').mockImplementation(async (id, time) => {
      expect(storeClosed).toBe(false);
      revoked.push(id);
      await revoke(id, time);
    });
    await f.app.close();
    expect(storeClosed).toBe(true);
    expect(revoked).toEqual(
      expect.arrayContaining([f.urlConnection.id, local.json().connection.id]),
    );
  });

  it('URL键不会进入请求日志或遥测', async () => {
    const logs: string[] = [];
    const attributes: unknown[] = [];
    const f = await urlFixture(
      {},
      {
        logger: {
          level: 'info',
          stream: {
            write: (line) => {
              logs.push(line);
            },
          },
        },
        observability: {
          startSpan: (_name, attrs) => {
            attributes.push(attrs);
            return {
              setAttribute: (name, value) => {
                attributes.push({ [name]: value });
              },
              recordException: () => undefined,
              end: () => undefined,
            };
          },
          captureException: () => undefined,
        },
      },
    );
    expect((await f.urlMcp()).statusCode).toBe(200);
    const key = new URL(f.urlConnection.mcpPath, f.address).searchParams.get('connection')!;
    expect(logs.join('')).not.toContain(key);
    expect(JSON.stringify(attributes)).not.toContain(key);
  });
});

describe('本机免令牌 MCP 连接', () => {
  async function localFixture(allowGeneration = false) {
    const f = await fixture();
    const localHeaders = { ...f.headers, host: new URL(f.address).host };
    const path = `${f.projectPath}/local-agent-connections`;
    const created = await f.app.inject({
      method: 'POST',
      url: path,
      headers: localHeaders,
      remoteAddress: '127.0.0.1',
      payload: { allowGeneration, expiresInHours: 1 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { connection } = created.json<{
      connection: { id: string; projectId: string; mcpUrl: string; allowGeneration: boolean };
    }>();
    expect(Object.keys(created.json())).toEqual(['connection']);
    expect(connection.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(connection).not.toHaveProperty('token');
    expect(created.body).not.toContain('cva1.');
    const client = new Client({ name: 'synthetic-local-agent', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpUrl)));
    return { ...f, connection, localHeaders, path, localClient: client };
  }

  it('官方 SDK 只用本地 URL 建图调参，保留 revision 和生成权限约束', async () => {
    const f = await localFixture();
    const initial = await call<{ canvas: CanvasDocument }>(f.localClient, 'get_canvas');
    expect(initial.canvas.revision).toBe(0);
    const changed = await call<{ canvas: CanvasDocument }>(
      f.localClient,
      'apply_canvas_operations',
      { revision: 0, operations: [generatedNode()] },
    );
    expect(changed.canvas.revision).toBe(1);
    await expectToolError(
      f.localClient,
      'apply_canvas_operations',
      { revision: 0, operations: [generatedNode('stale')] },
      409,
      'revision_conflict',
    );
    await expectToolError(
      f.localClient,
      'run_node',
      { nodeId: 'target', revision: 1, idempotencyKey: 'local-disallowed-run' },
      403,
      'agent_scope_denied',
    );
    expect(await f.runService.listByProject(f.projectId)).toEqual([]);
    const listed = await f.app.inject({
      method: 'GET',
      url: f.path,
      headers: f.localHeaders,
      remoteAddress: '127.0.0.1',
    });
    expect(listed.json()).toMatchObject({ available: true, connections: [f.connection] });
    expect(listed.body).not.toContain('cva1.');
    expect(listed.body).not.toContain('tokenHash');
    const account = await fetch(new URL('/v1/account/profile', f.connection.mcpUrl));
    expect(account.status).toBe(404);
    const another = await f.createProject('本地连接隔离项目');
    const foreign = await f.app.inject({
      method: 'GET',
      url: `/v1/projects/${another}/local-agent-connections`,
      headers: f.localHeaders,
      remoteAddress: '127.0.0.1',
    });
    expect(foreign.json().connections).toEqual([]);
  });

  it.each([
    { remoteAddress: '192.0.2.10', headers: {} },
    { remoteAddress: '127.0.0.1', headers: { host: 'canvas.example.test' } },
    { remoteAddress: '127.0.0.1', headers: { forwarded: 'for=127.0.0.1' } },
    { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' } },
    { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-host': 'localhost' } },
  ])('管理接口拒绝非直接本机来源 %j', async (source) => {
    const f = await fixture();
    const request = {
      url: `${f.projectPath}/local-agent-connections`,
      headers: { ...f.headers, host: new URL(f.address).host, ...source.headers },
      remoteAddress: source.remoteAddress,
    };
    const listed = await f.app.inject({ ...request, method: 'GET' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      available: false,
      reason: 'local_api_required',
      connections: [],
    });
    const created = await f.app.inject({ ...request, method: 'POST', payload: {} });
    expect(created.statusCode).toBe(403);
  });

  it('即使本机请求也必须登录且拥有当前项目，其他账号无法枚举或撤销连接', async () => {
    const f = await localFixture();
    const other = await f.context.session({ email: 'local-foreign-owner@example.test' });
    const local = { host: new URL(f.address).host };
    for (const headers of [local, { ...local, authorization: `Bearer ${other.accessToken}` }]) {
      const result = await f.app.inject({
        method: 'GET',
        url: f.path,
        headers,
        remoteAddress: '127.0.0.1',
      });
      expect(result.statusCode).toBe('authorization' in headers ? 404 : 401);
    }
    const otherProject = await f.createProject('不可撤销其他项目连接');
    const wrongProject = await f.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${otherProject}/local-agent-connections/${f.connection.id}`,
      headers: f.localHeaders,
      remoteAddress: '127.0.0.1',
    });
    expect(wrongProject.statusCode).toBe(404);
    await call(f.localClient, 'get_canvas');
  });

  it.each<Record<string, string>>([
    { origin: 'http://localhost:5173' },
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-mode': 'navigate' },
    { forwarded: 'for=127.0.0.1' },
    { 'x-forwarded-for': '127.0.0.1' },
    { host: 'localhost:80' },
  ])('本地 MCP 端口拒绝浏览器或代理来源 %j', async (headers) => {
    const f = await localFixture();
    const result = await rawLocalPost(f.connection.mcpUrl, headers);
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({ code: 'local_origin_rejected' });
    await call(f.localClient, 'get_canvas');
  });

  it('撤销即关闭端口；主 API 关闭同时释放已连接客户端的本地端口', async () => {
    const f = await localFixture();
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `${f.path}/${f.connection.id}`,
      headers: f.localHeaders,
      remoteAddress: '127.0.0.1',
    });
    expect(revoked.statusCode).toBe(204);
    await expect(fetch(f.connection.mcpUrl)).rejects.toThrow();
    const other = await localFixture();
    await call(other.localClient, 'get_canvas');
    await other.app.close();
    await expect(fetch(other.connection.mcpUrl)).rejects.toThrow();
    await expect(other.localClient.listTools()).rejects.toThrow();
  });

  it.each(['disabled', 'revoked'] as const)(
    '账户%s后每次调用重新校验并停用本地连接',
    async (state) => {
      const f = await localFixture();
      if (state === 'disabled')
        await f.context.store.updateUser(f.session.user.id, { status: 'disabled' });
      else await f.context.auth.logoutAll(f.session.user.id);
      // SDK 的后台 GET 也会立即触发校验，可能已经先关闭失效端口。
      await expect(f.localClient.listTools()).rejects.toThrow();
      await expect
        .poll(async () => {
          try {
            await fetch(f.connection.mcpUrl);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
    },
  );
});

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  applyCanvasOperations,
  canvasOperationsSchema,
  CanvasOperationError,
  type CanvasDocument,
} from '@multimodal-canvas/domain';
import type { AuthPrincipal } from './auth';
import type { AuthenticatedSession } from './auth-service';
import type { AssetStore } from './assets';
import { ProjectStoreError, type ProjectStore } from './projects';
import type { RunService } from './runs';
import {
  AgentAccessService,
  AgentAccessConnectionLimitError,
  type AgentAccessClaims,
} from './agent-access';
import { AgentUrlConnectionLimitError, type AgentUrlConnections } from './agent-url-connections';
import { canvasAgentTools, executeCanvasTool } from './canvas-agent-tools';
import { registerCanvasMcp, CanvasMcpToolError } from './canvas-mcp';
import {
  LocalAgentConnections,
  LocalAgentConnectionLimitError,
  localAgentAvailability,
} from './local-agent-connections';

type Options = {
  access?: AgentAccessService;
  urlConnections?: AgentUrlConnections;
  projectStore: ProjectStore;
  assetStore: AssetStore;
  runService: RunService;
  principals: WeakMap<object, AuthPrincipal>;
  sessions: WeakMap<object, AuthenticatedSession>;
  validateMentions(
    canvas: CanvasDocument,
    projectId: string,
    ownerId: string | undefined,
    requestId: string,
  ): Promise<void>;
};
type ProjectParams = { projectId: string };
const connectionSchema = z
  .object({
    allowGeneration: z.boolean().default(true),
    expiresInHours: z.number().int().min(1).max(24).default(8),
  })
  .strict();
// Agent 只能执行已经过画布校验的配置，禁止借普通运行接口覆盖素材或提示词。
const agentRunSchema = z
  .object({
    projectId: z.string(),
    idempotencyKey: z.string().trim().min(1),
    canvasRevision: z.number().int().nonnegative(),
  })
  .strict();

/** 令牌只授权固定画布业务路由；不能管理账号、凭据或另发连接令牌。 */
export async function isAgentRequestAllowed(
  request: FastifyRequest,
  claims: AgentAccessClaims,
  runs: RunService,
): Promise<boolean> {
  const url = new URL(request.url, 'http://canvas.local');
  const path = url.pathname;
  const projectPath = `/v1/projects/${encodeURIComponent(claims.projectId)}`;
  if (path === `${projectPath}/mcp`) return ['POST', 'GET', 'DELETE'].includes(request.method);
  if (path === `${projectPath}/canvas` || path === `${projectPath}/agent-assets`)
    return request.method === 'GET';
  if (
    path.startsWith(`${projectPath}/agent-assets/`) &&
    /^\/[^/]+\/versions\/\d+\/image$/.test(path.slice(`${projectPath}/agent-assets`.length))
  )
    return request.method === 'GET';
  if (path === `${projectPath}/canvas/operations`) return request.method === 'POST';
  if (path === '/v1/models') return request.method === 'GET';
  if (/^\/v1\/nodes\/[^/]+\/runs$/.test(path)) {
    const body = agentRunSchema.safeParse(request.body);
    return (
      request.method === 'POST' &&
      claims.allowGeneration &&
      body.success &&
      body.data.projectId === claims.projectId
    );
  }
  const runPath = /^\/v1\/runs\/([^/]+)(\/cancel)?$/.exec(path);
  if (runPath && request.method === (runPath[2] ? 'POST' : 'GET')) {
    let runId: string;
    try {
      runId = decodeURIComponent(runPath[1]!);
    } catch {
      return false;
    }
    return (await runs.get(runId))?.projectId === claims.projectId;
  }
  return false;
}

function referencedAssetIds(canvas: CanvasDocument): Set<string> {
  const ids = new Set<string>();
  for (const node of canvas.nodes) {
    if (node.data.assetId) ids.add(node.data.assetId);
    if (node.data.imageEditSource) ids.add(node.data.imageEditSource.assetId);
    for (const ref of node.data.resourceRefs ?? []) ids.add(ref.assetId);
    for (const block of node.data.promptDocument?.blocks ?? [])
      if (block.type === 'mention') ids.add(block.assetId);
  }
  return ids;
}

/** 注册项目连接与共用画布操作 API；只签发受当前登录授权期限约束的项目令牌。 */
export function registerCanvasAgentRoutes(app: FastifyInstance, options: Options): void {
  const { projectStore, assetStore, access } = options;
  const localConnections = access ? new LocalAgentConnections(app, access) : undefined;
  app.addHook('preClose', async () => localConnections?.close());
  const mcpPath = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}/mcp`;
  const scopeOf = (request: FastifyRequest) => ({
    ownerId: options.principals.get(request)?.userId,
  });
  const projectExists = async (
    request: FastifyRequest<{ Params: ProjectParams }>,
    reply: FastifyReply,
  ) => {
    if (!(await projectStore.get(request.params.projectId, scopeOf(request)))) {
      reply.code(404).send({ error: 'project not found' });
      return false;
    }
    return true;
  };
  const requireSession = async (
    request: FastifyRequest<{ Params: ProjectParams }>,
    reply: FastifyReply,
  ) => {
    const session = options.sessions.get(request);
    if (!access || !session) {
      reply.code(401).send({ code: 'session_required', error: '请登录后创建或管理 Agent 连接' });
      return undefined;
    }
    return (await projectExists(request, reply)) ? session : undefined;
  };

  app.get<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/agent-url-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      return reply.header('cache-control', 'no-store').send({
        available: true,
        connections: await options.urlConnections!.list(session.user.id, request.params.projectId),
      });
    },
  );
  app.post<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/agent-url-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'invalid_input', error: '连接权限或有效期无效' });
      try {
        await options.urlConnections!.list(session.user.id, request.params.projectId);
        const connection = await options.urlConnections!.create({
          ...parsed.data,
          userId: session.user.id,
          projectId: request.params.projectId,
          authorizedUntil: session.session.absoluteExpiresAt ?? session.session.expiresAt,
        });
        return reply.code(201).send({ connection });
      } catch (error) {
        if (
          error instanceof AgentAccessConnectionLimitError ||
          error instanceof AgentUrlConnectionLimitError
        )
          return reply.code(409).send({
            code: 'connection_limit',
            error: 'Agent 连接数量已达上限，请先撤销不用的连接',
          });
        request.log.warn({ code: 'agent_url_create_failed' }, '创建 Agent 连接地址失败');
        return reply.code(503).send({
          code: 'agent_connection_unavailable',
          error: '无法创建 Agent 连接地址，请稍后重试',
        });
      }
    },
  );
  app.delete<{ Params: ProjectParams & { connectionId: string } }>(
    '/v1/projects/:projectId/agent-url-connections/:connectionId',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      if (
        !z.string().uuid().safeParse(request.params.connectionId).success ||
        !(await options.urlConnections!.revoke(
          session.user.id,
          request.params.projectId,
          request.params.connectionId,
        ))
      )
        return reply.code(404).send({ error: 'connection not found' });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/local-agent-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      const availability = localAgentAvailability(app, request);
      return {
        ...availability,
        connections: availability.available
          ? await localConnections!.list(session.user.id, request.params.projectId)
          : [],
      };
    },
  );
  app.post<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/local-agent-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      const availability = localAgentAvailability(app, request);
      if (!availability.available)
        return reply
          .code(403)
          .send({ code: 'local_connection_unavailable', error: availability.reason });
      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'invalid_input', error: '连接权限或有效期无效' });
      await localConnections!.list(session.user.id, request.params.projectId);
      if ((await access!.list(session.user.id, request.params.projectId)).length >= 20)
        return reply.code(409).send({
          code: 'connection_limit',
          error: '当前项目最多保留20个有效连接，请先撤销不用的连接',
        });
      try {
        const connection = await localConnections!.create({
          ...parsed.data,
          userId: session.user.id,
          projectId: request.params.projectId,
          authorizedUntil: session.session.absoluteExpiresAt ?? session.session.expiresAt,
        });
        return reply.code(201).send({ connection });
      } catch (error) {
        if (
          error instanceof LocalAgentConnectionLimitError ||
          error instanceof AgentAccessConnectionLimitError
        )
          return reply
            .code(409)
            .send({ code: 'connection_limit', error: '本地连接数量已达上限，请先撤销不用的连接' });
        request.log.warn({ code: 'local_mcp_create_failed' }, '创建本地 Agent 连接失败');
        return reply.code(503).send({
          code: 'local_connection_unavailable',
          error: '无法启动本机 MCP 服务，请稍后重试',
        });
      }
    },
  );
  app.delete<{ Params: ProjectParams & { connectionId: string } }>(
    '/v1/projects/:projectId/local-agent-connections/:connectionId',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      const availability = localAgentAvailability(app, request);
      if (!availability.available)
        return reply
          .code(403)
          .send({ code: 'local_connection_unavailable', error: availability.reason });
      if (
        !z.string().uuid().safeParse(request.params.connectionId).success ||
        !(await localConnections!.revoke(
          session.user.id,
          request.params.projectId,
          request.params.connectionId,
        ))
      )
        return reply.code(404).send({ error: 'connection not found' });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/agent-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      reply.header('cache-control', 'no-store');
      return {
        connections: await access!.list(session.user.id, request.params.projectId),
        mcpPath: mcpPath(request.params.projectId),
      };
    },
  );
  app.post<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/agent-connections',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'invalid_input', error: '连接权限或有效期无效' });
      if ((await access!.list(session.user.id, request.params.projectId)).length >= 20)
        return reply.code(409).send({
          code: 'connection_limit',
          error: '当前项目最多保留20个有效连接，请先撤销不用的连接',
        });
      const result = await access!.issue({
        ...parsed.data,
        userId: session.user.id,
        projectId: request.params.projectId,
        authorizedUntil: session.session.absoluteExpiresAt ?? session.session.expiresAt,
      });
      return reply
        .header('cache-control', 'no-store')
        .code(201)
        .send({ ...result, mcpPath: mcpPath(request.params.projectId) });
    },
  );
  app.delete<{ Params: ProjectParams & { connectionId: string } }>(
    '/v1/projects/:projectId/agent-connections/:connectionId',
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      if (
        !z.string().uuid().safeParse(request.params.connectionId).success ||
        !(await access!.revoke(
          session.user.id,
          request.params.projectId,
          request.params.connectionId,
        ))
      )
        return reply.code(404).send({ error: 'connection not found' });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/agent-assets',
    async (request, reply) => {
      if (!(await projectExists(request, reply))) return;
      const parsed = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(50).default(20),
        })
        .strict()
        .safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid asset query' });
      const scope = { projectId: request.params.projectId };
      const assets = await assetStore.list(scope, { ...parsed.data, status: 'ready' });
      const results = await Promise.all(
        assets.map(async (asset) => ({
          id: asset.id,
          name: asset.name,
          mediaType: asset.mediaType,
          mimeType: asset.mimeType,
          versions: (await assetStore.listVersions(asset.id, scope)).map((version) => ({
            version: version.version,
            sizeBytes: version.sizeBytes,
            contentUrl: `/v1/assets/${encodeURIComponent(asset.id)}/versions/${version.version}/content`,
          })),
        })),
      );
      return { assets: results, ...parsed.data, hasMore: results.length === parsed.data.pageSize };
    },
  );

  app.post<{ Params: ProjectParams }>(
    '/v1/projects/:projectId/canvas/operations',
    async (request, reply) => {
      const { projectId } = request.params;
      const scope = scopeOf(request);
      const canvas = await projectStore.getCanvas(projectId, scope);
      if (!canvas) return reply.code(404).send({ error: 'project not found' });
      try {
        const batch = canvasOperationsSchema.safeParse(request.body);
        if (!batch.success)
          return reply.code(400).send({ code: 'invalid_operation', error: '画布操作参数无效' });
        const next = applyCanvasOperations(canvas, batch.data);
        const existing = referencedAssetIds(canvas);
        // 限制个人素材为已经绑定到当前画布的资源；项目令牌不能枚举/引入其他私人素材。
        for (const assetId of referencedAssetIds(next)) {
          const read = assetStore.getMetadata?.bind(assetStore) ?? assetStore.get.bind(assetStore);
          const asset =
            (await read(assetId, { projectId })) ??
            (existing.has(assetId) && scope.ownerId
              ? await read(assetId, { ownerId: scope.ownerId, projectId: null })
              : undefined);
          if (!asset || asset.status === 'archived')
            throw new ProjectStoreError('invalid_asset', '素材不属于当前项目或已不可用');
        }
        for (const node of next.nodes) {
          if (
            !node.data.assetId ||
            canvas.nodes.some((old) => old.id === node.id && old.data.assetId === node.data.assetId)
          )
            continue;
          const match = /\/versions\/(\d+)\/content$/.exec(node.data.contentUrl ?? '');
          const read = assetStore.getMetadata?.bind(assetStore) ?? assetStore.get.bind(assetStore);
          const projectAsset = await read(node.data.assetId, { projectId });
          const assetScope = projectAsset
            ? { projectId }
            : { projectId: null, ownerId: scope.ownerId };
          const versions = await assetStore.listVersions(node.data.assetId, assetScope);
          if (!match || !versions.some((entry) => entry.version === Number(match[1])))
            throw new ProjectStoreError('invalid_asset', '素材版本不存在，请重新读取可用素材');
          const asset = projectAsset ?? (await read(node.data.assetId, assetScope));
          if (asset?.mediaType !== node.data.mediaType)
            throw new ProjectStoreError('invalid_asset', '素材类型与节点不一致');
        }
        await options.validateMentions(next, projectId, scope.ownerId, request.id);
        return { canvas: await projectStore.updateCanvas(projectId, next, scope) };
      } catch (error) {
        if (error instanceof CanvasOperationError || error instanceof ProjectStoreError)
          return reply
            .code(error.code === 'revision_conflict' ? 409 : error.code === 'not_found' ? 404 : 400)
            .send({
              code: error.code,
              error: error.message,
              ...(error.revision === undefined ? {} : { revision: error.revision }),
            });
        throw error;
      }
    },
  );

  app.get<{ Params: ProjectParams & { assetId: string; version: string } }>(
    '/v1/projects/:projectId/agent-assets/:assetId/versions/:version/image',
    async (request, reply) => {
      if (!(await projectExists(request, reply))) return;
      const { projectId, assetId, version: rawVersion } = request.params;
      if (
        !/^\d+$/.test(rawVersion) ||
        !Number.isSafeInteger(Number(rawVersion)) ||
        Number(rawVersion) < 1
      )
        return reply.code(400).send({ error: 'invalid asset version' });
      const read = assetStore.getMetadata?.bind(assetStore) ?? assetStore.get.bind(assetStore);
      let scope: { projectId: string | null; ownerId?: string } = { projectId };
      let asset = await read(assetId, scope);
      if (!asset) {
        const canvas = await projectStore.getCanvas(projectId, scopeOf(request));
        const ownerId = scopeOf(request).ownerId;
        if (ownerId && canvas && referencedAssetIds(canvas).has(assetId)) {
          scope = { ownerId, projectId: null };
          asset = await read(assetId, scope);
        }
      }
      if (!asset || asset.status === 'archived')
        return reply.code(404).send({ error: 'image not found' });
      if (
        asset.mediaType !== 'image' ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mimeType)
      )
        return reply.code(400).send({ code: 'unsupported_image', error: '此素材不能作为图片读取' });
      const version = (await assetStore.listVersions(assetId, scope)).find(
        (entry) => entry.version === Number(rawVersion),
      );
      if (!version) return reply.code(404).send({ error: 'image version not found' });
      const maxBytes = 4 * 1024 * 1024;
      if (version.sizeBytes > maxBytes)
        return reply
          .code(413)
          .send({ code: 'image_too_large', error: 'Agent 图片读取上限为4MiB，请使用较小图片' });
      const content = await assetStore.getVersionContent(assetId, version.version, scope);
      if (!content) return reply.code(404).send({ error: 'image version not found' });
      if (content.length > maxBytes)
        return reply.code(413).send({ code: 'image_too_large', error: 'Agent 图片读取上限为4MiB' });
      return reply
        .header('cache-control', 'no-store')
        .send({ image: { data: content.toString('base64'), mimeType: asset.mimeType } });
    },
  );

  registerCanvasMcp(app, {
    tools: canvasAgentTools(),
    execute: async (request, name, args) => {
      const projectId = (request.params as ProjectParams).projectId;
      if (!options.sessions.has(request) || !(await projectStore.get(projectId, scopeOf(request))))
        throw new CanvasMcpToolError(403, 'project_access_denied', '当前连接无法访问此项目');
      return executeCanvasTool(name, args, {
        projectId,
        invoke: async (method, url, payload) => {
          // 固定内部路由仍经过完整认证、账户状态、限流、模型权限和提交校验。
          const result = await app.inject({
            method,
            url,
            headers: {
              authorization: request.headers.authorization!,
              ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
          });
          const body = result.json<Record<string, unknown>>();
          if (result.statusCode >= 400)
            throw new CanvasMcpToolError(
              result.statusCode,
              typeof body.code === 'string' ? body.code : 'canvas_request_failed',
              result.statusCode >= 500
                ? '画布服务暂不可用，请稍后重试'
                : typeof body.error === 'string'
                  ? body.error
                  : '画布操作失败',
              typeof body.revision === 'number' ? { revision: body.revision } : undefined,
            );
          return body;
        },
      });
    },
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, resolve as resolvePath } from 'node:path';
import { z } from 'zod';

import type { AuthPrincipal } from './auth';
import type { AuthenticatedSession } from './auth-service';
import type { AgentUrlConnections } from './agent-url-connections';
import type { ProjectStore } from './projects';

/**
 * 方案 B：本地 Agent 聊天侧栏的服务端中继。
 *
 * 浏览器侧栏与桥接程序之间通过 API 长连接转发提示词与 Agent 事件；
 * 桥接程序以 Bearer url-key 认证，复用现有 URL 连接凭据。
 * 单进程内存态：生产单实例足够，多副本部署首版不支持。
 */

type Options = {
  urlConnections?: AgentUrlConnections;
  /** 桥接程序打包后的入口文件路径；默认 apps/api/dist/bridge/index.js。 */
  bridgeFilePath?: string;
  projectStore?: ProjectStore;
  principals: WeakMap<object, AuthPrincipal>;
  sessions: WeakMap<object, AuthenticatedSession>;
};

type BridgeConnection = {
  projectId: string;
  connectionId: string;
  write: (line: string) => void;
  close: () => void;
};

type BridgeSession = {
  sessionId: string;
  connectionId: string;
  projectId: string;
  userId: string;
  sseWriters: Set<(data: string) => void>;
  /** 当前正在运行的 taskId，用于 cancel。 */
  currentTaskId?: string;
};

const bridgeConnections = new Map<string, BridgeConnection>();
const bridgeSessions = new Map<string, BridgeSession>();
const bridgeTasks = new Map<string, string>();
/** 所有 hijack 后的原始响应；preClose 时强制销毁底层 socket 以解除 app.close() 挂起。 */
const hijackedRaws = new Set<ServerResponse>();

const URL_KEY_RE =
  /^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.([A-Za-z0-9_-]{43})$/;
const promptSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(32_000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || !authorization.toLowerCase().startsWith('bearer ')) return undefined;
  return authorization.slice(7).trim() || undefined;
}

/** 关闭所有活跃 bridge 连接；app preClose 钩子调用。 */
export function closeAllBridgeConnections(): void {
  for (const connection of bridgeConnections.values()) connection.close();
  bridgeConnections.clear();
  bridgeSessions.clear();
  bridgeTasks.clear();
  for (const raw of hijackedRaws) {
    try {
      raw.destroy();
    } catch {
      // 已销毁。
    }
  }
  hijackedRaws.clear();
}

/**
 * 桥接程序下载文件位置。
 *
 * 构建产物由 `scripts/copy-bridge.mjs` 复制到 `apps/api/dist/bridge/index.js`，所以默认取
 * 当前模块目录下的 `bridge/index.js`；开发态直接从 `src` 运行时退回 workspace 里桥接包的 dist。
 */
function defaultBridgeFilePath(): string {
  const candidates = [
    join(import.meta.dirname, 'bridge', 'index.js'),
    resolvePath(import.meta.dirname, '..', '..', '..', 'packages', 'bridge', 'dist', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function registerAgentBridgeRoutes(app: FastifyInstance, options: Options): void {
  const { urlConnections, projectStore, principals, sessions } = options;
  const bridgeFilePath = options.bridgeFilePath ?? defaultBridgeFilePath();

  // NDJSON 请求体解析（桥接程序回传 Agent 事件使用此 Content-Type）。
  app.addContentTypeParser(
    'application/x-ndjson',
    { parseAs: 'string' },
    (_req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      done(null, body);
    },
  );

  const requireLogin = (request: FastifyRequest): AuthenticatedSession | undefined => {
    return sessions.get(request);
  };

  const scopeOf = (request: FastifyRequest) => ({
    ownerId: principals.get(request)?.userId,
  });

  /**
   * 桥接程序长连接。认证用 Bearer url-key；projectId 由 query 提供，
   * urlConnections.resolve 会校验签名与项目一致性。
   */
  app.get<{ Querystring: { projectId?: string } }>(
    '/v1/agent-bridge/connect',
    async (request, reply) => {
      if (!urlConnections) return reply.code(503).send({ error: 'bridge unavailable' });
      const projectId = request.query.projectId;
      if (!projectId) return reply.code(400).send({ error: 'project_id_required' });
      const key = extractBearerToken(request.headers.authorization);
      if (!key || !URL_KEY_RE.test(key)) return reply.code(401).send({ error: 'invalid_token' });
      const token = await urlConnections.resolve(projectId, key);
      if (!token) return reply.code(401).send({ error: 'invalid_token' });
      const connectionId = key.split('.')[0]!;

      const previous = bridgeConnections.get(connectionId);
      if (previous) previous.close();

      reply.hijack();
      const raw = reply.raw;
      hijackedRaws.add(raw);
      raw.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-cache,no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      raw.write(`{"type":"ready","projectId":${JSON.stringify(projectId)}}\n`);

      const connection: BridgeConnection = {
        projectId,
        connectionId,
        write: (line) => {
          try {
            raw.write(`${line}\n`);
          } catch {
            // socket 已断开，忽略；onClose 会清理。
          }
        },
        close: () => {
          try {
            raw.end();
          } catch {
            // 已关闭。
          }
        },
      };
      bridgeConnections.set(connectionId, connection);

      const heartbeat = setInterval(() => connection.write('{"type":"ping"}'), 20_000);
      raw.on('close', () => {
        clearInterval(heartbeat);
        hijackedRaws.delete(raw);
        if (bridgeConnections.get(connectionId) === connection)
          bridgeConnections.delete(connectionId);
      });
    },
  );

  /** 浏览器创建聊天会话；要求登录且项目有活跃 bridge。 */
  app.post<{ Body: unknown }>('/v1/agent-bridge/sessions', async (request, reply) => {
    const session = requireLogin(request);
    if (!session)
      return reply.code(401).send({ code: 'session_required', error: '请登录后使用本地 Agent' });
    const parsed = z
      .object({ projectId: z.string().min(1).max(512) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ code: 'invalid_input', error: '项目 ID 无效' });
    const { projectId } = parsed.data;
    const ownerId = scopeOf(request).ownerId;
    if (!ownerId || !(await projectStore?.get(projectId, { ownerId })))
      return reply.code(404).send({ error: 'project not found' });
    const connection = [...bridgeConnections.values()].find((c) => c.projectId === projectId);
    if (!connection)
      return reply
        .code(409)
        .send({ code: 'bridge_not_connected', error: '请先在本机启动桥接程序' });

    const sessionId = randomUUID();
    bridgeSessions.set(sessionId, {
      sessionId,
      connectionId: connection.connectionId,
      projectId,
      userId: session.user.id,
      sseWriters: new Set(),
    });
    return reply.code(201).send({ sessionId });
  });

  /** 浏览器发送提示词；最后一条须为 user。 */
  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/v1/agent-bridge/sessions/:sessionId/prompt',
    async (request, reply) => {
      const session = requireLogin(request);
      if (!session)
        return reply.code(401).send({ code: 'session_required', error: '请登录后使用本地 Agent' });
      const bridge = bridgeSessions.get(request.params.sessionId);
      if (!bridge || bridge.userId !== session.user.id)
        return reply.code(404).send({ error: 'session not found' });
      const parsed = promptSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: 'invalid_input', error: '提示词内容无效' });
      const messages = parsed.data.messages;
      if (messages[messages.length - 1]!.role !== 'user')
        return reply.code(400).send({ code: 'invalid_input', error: '最后一条须为用户消息' });

      const connection = bridgeConnections.get(bridge.connectionId);
      if (!connection)
        return reply
          .code(409)
          .send({ code: 'bridge_not_connected', error: '桥接程序已断开，请重新启动' });

      const taskId = randomUUID();
      bridgeTasks.set(taskId, bridge.sessionId);
      bridge.currentTaskId = taskId;
      connection.write(
        JSON.stringify({
          type: 'prompt',
          taskId,
          sessionId: bridge.sessionId,
          projectId: bridge.projectId,
          messages,
        }),
      );
      return reply.code(202).send({ taskId });
    },
  );

  /** 浏览器取消当前任务。 */
  app.post<{ Params: { sessionId: string } }>(
    '/v1/agent-bridge/sessions/:sessionId/cancel',
    async (request, reply) => {
      const session = requireLogin(request);
      if (!session)
        return reply.code(401).send({ code: 'session_required', error: '请登录后使用本地 Agent' });
      const bridge = bridgeSessions.get(request.params.sessionId);
      if (!bridge || bridge.userId !== session.user.id)
        return reply.code(404).send({ error: 'session not found' });
      const connection = bridgeConnections.get(bridge.connectionId);
      if (!connection || !bridge.currentTaskId)
        return reply.code(409).send({ code: 'no_active_task', error: '没有正在运行的任务' });
      connection.write(JSON.stringify({ type: 'cancel', taskId: bridge.currentTaskId }));
      return reply.code(204).send();
    },
  );

  /** 浏览器订阅 Agent 事件流（SSE）。 */
  app.get<{ Params: { sessionId: string } }>(
    '/v1/agent-bridge/sessions/:sessionId/stream',
    async (request, reply) => {
      const session = requireLogin(request);
      if (!session)
        return reply.code(401).send({ code: 'session_required', error: '请登录后使用本地 Agent' });
      const bridge = bridgeSessions.get(request.params.sessionId);
      if (!bridge || bridge.userId !== session.user.id)
        return reply.code(404).send({ error: 'session not found' });

      reply.hijack();
      const raw = reply.raw;
      hijackedRaws.add(raw);
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache,no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      raw.write(': connected\n\n');

      const writer = (data: string) => {
        try {
          raw.write(`data: ${data}\n\n`);
        } catch {
          // 已断开，onClose 清理。
        }
      };
      bridge.sseWriters.add(writer);
      raw.on('close', () => {
        hijackedRaws.delete(raw);
        bridge.sseWriters.delete(writer);
      });
    },
  );

  /** 桥接程序回传 Agent 事件（NDJSON，每行一个事件）。 */
  app.post<{ Params: { taskId: string } }>(
    '/v1/agent-bridge/tasks/:taskId/events',
    async (request, reply) => {
      if (!urlConnections) return reply.code(503).send({ error: 'bridge unavailable' });
      // 从 query 取 projectId 用于认证（与 connect 一致）。
      const projectId = (request.query as { projectId?: string } | undefined)?.projectId;
      if (!projectId) return reply.code(400).send({ error: 'project_id_required' });
      const key = extractBearerToken(request.headers.authorization);
      if (!key || !URL_KEY_RE.test(key)) return reply.code(401).send({ error: 'invalid_token' });
      const token = await urlConnections.resolve(projectId, key);
      if (!token) return reply.code(401).send({ error: 'invalid_token' });

      const sessionId = bridgeTasks.get(request.params.taskId);
      if (!sessionId) return reply.code(404).send({ error: 'task not found' });
      const bridge = bridgeSessions.get(sessionId);
      if (!bridge) return reply.code(404).send({ error: 'session not found' });

      // 事件体应为 application/x-ndjson；逐行解析并转发到 SSE。
      const body = request.body;
      const text =
        typeof body === 'string'
          ? body
          : Buffer.isBuffer(body)
            ? body.toString('utf8')
            : typeof body === 'object' && body !== null
              ? JSON.stringify(body)
              : '';
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let payload: { type?: string; done?: boolean };
        try {
          payload = JSON.parse(trimmed);
        } catch {
          continue;
        }
        for (const writer of bridge.sseWriters) writer(trimmed);
        if (payload.type === 'done' || payload.done) {
          bridgeTasks.delete(request.params.taskId);
          if (bridge.currentTaskId === request.params.taskId) bridge.currentTaskId = undefined;
        }
      }
      return reply.code(204).send();
    },
  );

  /** 匿名下载桥接程序打包文件。 */
  app.get('/v1/agent-bridge/download', async (_request, reply) => {
    try {
      const stats = await stat(bridgeFilePath);
      if (!stats.isFile()) throw new Error('not a file');
    } catch {
      return reply.code(404).send({ error: 'bridge not available' });
    }
    const stream = createReadStream(bridgeFilePath);
    return reply
      .header('content-type', 'application/javascript')
      .header('content-disposition', 'attachment; filename="canvas-bridge.js"')
      .header('cache-control', 'no-store')
      .send(stream);
  });
}

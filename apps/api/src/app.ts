import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  createAssetAccessToken,
  detectMediaType,
  MemoryAssetStore,
  verifyAssetAccessToken,
  type AssetScope,
  type AssetStore,
} from './assets';
import {
  MemoryProjectStore,
  ProjectStoreError,
  type ProjectScope,
  type ProjectStore,
} from './projects';
import { createRunSnapshot, MemoryRunService, RunServiceError, type RunService } from './runs';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';
import { z } from 'zod';
import { AiSettingsError, AiSettingsStore, type AiSettingsStoreLike } from './settings';
import { openApiDocument } from './openapi';
import { MemoryWebhookEventStore, type WebhookEventStore } from './webhooks';
import {
  NoopMediaMetadataExtractor,
  NoopMediaDerivativeGenerator,
  type MediaDerivativeGenerator,
  type MediaMetadataExtractor,
  type MediaProbeInput,
} from './media';
import {
  MemoryUploadSessionStore,
  type UploadSessionScope,
  type UploadSessionStore,
} from './upload-sessions';
import {
  createEnvironmentObservability,
  type Observability,
  type ObservabilitySpan,
} from '@multimodal-canvas/observability';
import { extractBearerToken, authenticateBearer, type AuthPrincipal } from './auth';
import { AuthService, AuthServiceError, type AuthenticatedSession } from './auth-service';
import { MemoryAuthStore, type AuthStore } from './auth-store';
import {
  enforceRunCostPolicy,
  parseRunCostPolicy,
  quoteModelCost,
  UsagePolicyError,
} from './usage-policy';

type BuildAppOptions = {
  assetStore?: AssetStore;
  projectStore?: ProjectStore;
  runService?: RunService;
  /** Optional backing-store check for JWT subjects in production. */
  userExists?: (userId: string) => Promise<boolean>;
  logger?: boolean | { level?: string; redact?: { paths: string[]; censor: string } };
  observability?: Observability;
  settingsStore?: AiSettingsStoreLike;
  webhookEventStore?: WebhookEventStore;
  mediaMetadataExtractor?: MediaMetadataExtractor;
  mediaDerivativeGenerator?: MediaDerivativeGenerator;
  uploadSessionStore?: UploadSessionStore;
  /** Stateful user/session store used by the first-party authentication routes. */
  authStore?: AuthStore;
  /** Injectable authentication service for tests or custom deployments. */
  authService?: AuthService;
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'headers.authorization',
          'apiKey',
          'api_key',
          'body.apiKey',
          'body.api_key',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  const observability =
    options.observability ??
    createEnvironmentObservability({ logger: app.log, service: 'multimodal-canvas-api' });
  const requestSpans = new WeakMap<object, ObservabilitySpan>();
  const assetStore: AssetStore = options.assetStore ?? new MemoryAssetStore();
  const projectStore = options.projectStore ?? new MemoryProjectStore();
  const runService = options.runService ?? new MemoryRunService();
  const userExists = options.userExists;
  const settingsStore: AiSettingsStoreLike = options.settingsStore ?? new AiSettingsStore();
  const webhookEventStore: WebhookEventStore =
    options.webhookEventStore ?? new MemoryWebhookEventStore();
  const mediaMetadataExtractor = options.mediaMetadataExtractor ?? new NoopMediaMetadataExtractor();
  const mediaDerivativeGenerator =
    options.mediaDerivativeGenerator ?? new NoopMediaDerivativeGenerator();
  const eventStreamCleanups = new Set<() => void>();
  const uploadSessionStore = options.uploadSessionStore ?? new MemoryUploadSessionStore();
  const authToken = process.env.API_AUTH_TOKEN?.trim();
  const jwtSecret = process.env.API_JWT_SECRET?.trim();
  // A deployment may provide a dedicated key. Falling back to an existing
  // server-side auth secret keeps local development usable without exposing
  // credentials; the final fallback is process-local and non-persistent.
  const assetAccessSecret =
    process.env.ASSET_ACCESS_URL_SECRET?.trim() || jwtSecret || authToken || randomUUID();
  const authStore = options.authStore ?? new MemoryAuthStore();
  const authService =
    options.authService ??
    (jwtSecret ? new AuthService({ store: authStore, jwtSecret }) : undefined);
  const requireJwtExpiration = process.env.NODE_ENV === 'production';
  const requestPrincipals = new WeakMap<object, AuthPrincipal>();
  const requestSessions = new WeakMap<object, AuthenticatedSession>();
  const maxActiveRunsPerProject = parsePositiveInt(process.env.RUN_MAX_ACTIVE_PER_PROJECT);
  const rateLimitPerMinute = parsePositiveInt(process.env.API_RATE_LIMIT_PER_MINUTE);
  const rateLimitWindowMs = 60_000;
  const rateLimitBuckets = new Map<string, { startedAt: number; count: number }>();
  const configuredCorsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
  const corsOrigin =
    configuredCorsOrigins.length > 0
      ? configuredCorsOrigins
      : process.env.NODE_ENV === 'production'
        ? false
        : true;

  app.register(cors, { origin: corsOrigin });
  app.register(multipart, {
    limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
  });
  app.addHook('onRequest', async (request) => {
    requestSpans.set(
      request,
      observability.startSpan('http.request', {
        'http.method': request.method,
        'http.target': request.url.split('?')[0],
        'service.name': process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas-api',
      }),
    );
  });
  app.addHook('onError', async (request, reply, error) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.status_code', reply.statusCode || 500);
    span.recordException(error);
    observability.captureException(error, {
      component: 'api',
      'http.method': request.method,
      'http.status_code': reply.statusCode || 500,
    });
    span.end('error');
  });
  app.addHook('onResponse', async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.status_code', reply.statusCode);
    const route = request.routeOptions?.url;
    if (route) span.setAttribute('http.route', route);
    span.end(reply.statusCode >= 500 ? 'error' : 'ok');
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (
      pathname === '/health' ||
      pathname === '/v1/webhooks/newapi' ||
      pathname === '/v1/auth/register' ||
      pathname === '/v1/auth/login'
    )
      return;
    if (request.method === 'GET') {
      const signedResource = assetContentResource(pathname);
      if (signedResource) {
        const token = new URL(request.url, 'http://localhost').searchParams.get('access_token');
        const verified = verifyAssetAccessToken(
          token ?? undefined,
          assetAccessSecret,
          signedResource,
        );
        if (verified) {
          requestPrincipals.set(request, {
            method: 'anonymous',
            ...(verified.ownerId ? { userId: verified.ownerId } : {}),
          });
          return;
        }
        // Do not silently fall back to development anonymous access when a
        // caller presents a malformed, expired, or resource-mismatched token.
        if (token !== null) return reply.code(401).send({ error: 'invalid or expired access URL' });
      }
    }
    if (!authToken && !jwtSecret) {
      if (process.env.NODE_ENV === 'production') {
        return reply
          .code(503)
          .send({ error: 'API_AUTH_TOKEN or API_JWT_SECRET is required in production' });
      }
      requestPrincipals.set(request, { method: 'anonymous' });
      return;
    }
    const result = authenticateBearer(request.headers.authorization, {
      apiToken: authToken,
      jwtSecret,
      requireExpiration: requireJwtExpiration,
    });
    if (!result.ok) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    if (result.principal.method === 'jwt' && result.principal.sessionId && authService) {
      const accessToken = extractBearerToken(request.headers.authorization);
      if (!accessToken) return reply.code(401).send({ error: 'authentication required' });
      try {
        const session = await authService.verifyAccessToken(accessToken);
        requestSessions.set(request, session);
        result.principal.role = session.user.role;
      } catch (error) {
        if (error instanceof AuthServiceError) {
          return reply.code(401).send({ error: 'authentication required' });
        }
        request.log.error({ err: error }, 'authentication session lookup failed');
        return reply.code(503).send({ error: 'authentication service unavailable' });
      }
    } else if (result.principal.method === 'jwt' && result.principal.sessionId && !authService) {
      request.log.error('stateful JWT authentication requires an authentication service');
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    // The implicit in-memory store exists to make local auth route tests and
    // development convenient; it must not count as a production backing store
    // for legacy stateless JWTs. Production callers must inject a real store
    // (or the explicit userExists lookup) before those tokens are accepted.
    const effectiveUserExists =
      userExists ??
      (options.authStore
        ? async (userId: string) => Boolean(await options.authStore!.findUserById(userId))
        : undefined);
    if (
      result.principal.method === 'jwt' &&
      !result.principal.sessionId &&
      !effectiveUserExists &&
      process.env.NODE_ENV === 'production'
    ) {
      request.log.error('JWT authentication requires a production user store');
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    if (result.principal.userId && effectiveUserExists && !requestSessions.has(request)) {
      try {
        if (!(await effectiveUserExists(result.principal.userId))) {
          return reply.code(401).send({ error: 'authentication required' });
        }
      } catch (error) {
        request.log.error({ err: error }, 'authentication user lookup failed');
        return reply.code(503).send({ error: 'authentication service unavailable' });
      }
    }
    requestPrincipals.set(request, result.principal);
    if (rateLimitPerMinute === undefined || !pathname.startsWith('/v1/')) return;

    const now = Date.now();
    const key = result.principal.userId ?? request.ip ?? 'unknown';
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= rateLimitWindowMs) {
      rateLimitBuckets.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (bucket.count >= rateLimitPerMinute) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((rateLimitWindowMs - (now - bucket.startedAt)) / 1000),
      );
      return reply
        .header('retry-after', String(retryAfterSeconds))
        .code(429)
        .send({ error: 'rate limit exceeded', retryAfterSeconds });
    }
    bucket.count += 1;
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
  }));

  app.get('/documentation', async () => openApiDocument);
  app.get('/documentation/json', async () => openApiDocument);

  app.post('/v1/auth/register', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const body = z
      .object({
        email: z.string(),
        password: z.string(),
        displayName: z.string().trim().max(120).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid authentication input' });
    try {
      return reply.code(201).send(await authService.register(body.data));
    } catch (error) {
      return sendAuthServiceError(reply, error);
    }
  });

  app.post('/v1/auth/login', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const body = z
      .object({ email: z.string(), password: z.string() })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid authentication input' });
    try {
      return reply.send(await authService.login(body.data));
    } catch (error) {
      return sendAuthServiceError(reply, error);
    }
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const session = requestSessions.get(request);
    if (!session) return reply.code(401).send({ error: 'authentication required' });
    return { user: session.user };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const session = requestSessions.get(request);
    const principal = requestPrincipals.get(request);
    const accessToken = extractBearerToken(request.headers.authorization);
    if (!session || principal?.method !== 'jwt' || !accessToken) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    await authService.logout(accessToken);
    return { loggedOut: true };
  });

  app.post('/v1/auth/logout-all', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const session = requestSessions.get(request);
    if (!session) return reply.code(401).send({ error: 'authentication required' });
    const revokedSessions = await authService.logoutAll(session.user.id);
    return { revokedSessions };
  });

  app.post('/v1/webhooks/newapi', async (request, reply) => {
    const secret = process.env.NEW_API_WEBHOOK_SECRET?.trim();
    if (!secret && process.env.NODE_ENV === 'production') {
      return reply.code(503).send({ error: 'webhook secret is not configured' });
    }
    if (secret) {
      const signature = request.headers['x-newapi-signature'];
      if (
        typeof signature !== 'string' ||
        !verifyWebhookSignature(request.body, signature, secret)
      ) {
        return reply.code(401).send({ error: 'invalid webhook signature' });
      }
    }
    const eventIdHeader = request.headers['x-newapi-event-id'];
    const body = isRecord(request.body) ? request.body : {};
    const eventId =
      (typeof eventIdHeader === 'string' && eventIdHeader.trim()) ||
      (typeof body.eventId === 'string' && body.eventId.trim()) ||
      (typeof body.id === 'string' && body.id.trim());
    if (!eventId) return reply.code(400).send({ error: 'webhook event id is required' });
    const result = await webhookEventStore.accept(eventId, 'newapi', body);
    return reply.code(202).send({ accepted: true, ...result, eventId });
  });

  app.get('/v1/settings/ai', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { settings: await settingsStore.get() };
  });

  app.patch('/v1/settings/ai', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    const result = z
      .object({
        baseUrl: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
          }, 'baseUrl must use HTTPS outside local development')
          .optional(),
        apiKey: z.string().min(1).optional(),
        defaultModels: z
          .object({
            text: z.string().min(1).nullable().optional(),
            image: z.string().min(1).nullable().optional(),
            audio: z.string().min(1).nullable().optional(),
            video: z.string().min(1).nullable().optional(),
          })
          .optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid AI settings' });
    return { settings: await settingsStore.update(result.data) };
  });

  app.delete('/v1/settings/ai/credentials', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { settings: await settingsStore.removeCredentials() };
  });

  app.post('/v1/settings/ai/test', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { result: await settingsStore.testConnection() };
  });

  app.post('/v1/settings/ai/models/refresh', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    try {
      return { models: await settingsStore.refreshModels() };
    } catch (error) {
      return reply
        .code(502)
        .send({ error: error instanceof Error ? error.message : '模型刷新失败' });
    }
  });

  app.get<{ Querystring: { mediaType?: string } }>('/v1/models', async (request, reply) => {
    if (
      request.query.mediaType &&
      !['text', 'image', 'audio', 'video'].includes(request.query.mediaType)
    ) {
      return reply.code(400).send({ error: 'invalid media type' });
    }
    return { models: await settingsStore.listModels(request.query.mediaType as never) };
  });

  app.post('/v1/projects', async (request, reply) => {
    const result = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ error: 'project name is required' });
    }

    const project = await projectStore.create(
      result.data,
      projectScope(requestPrincipals, request),
    );
    return reply.code(201).send({ project });
  });

  app.get('/v1/projects', async (request) => ({
    projects: await projectStore.list(projectScope(requestPrincipals, request)),
  }));

  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
    const project = await projectStore.get(
      request.params.projectId,
      projectScope(requestPrincipals, request),
    );
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { project };
  });

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const canvas = await projectStore.getCanvas(
        request.params.projectId,
        projectScope(requestPrincipals, request),
      );
      if (!canvas) return reply.code(404).send({ error: 'project not found' });
      return { canvas };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/runs',
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await projectStore.get(projectId, projectScope(requestPrincipals, request));
      if (!project) return reply.code(404).send({ error: 'project not found' });

      return { runs: await runService.listByProject(projectId) };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/events',
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await projectStore.get(projectId, projectScope(requestPrincipals, request));
      if (!project) return reply.code(404).send({ error: 'project not found' });

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      const lastSeen = new Map<string, string>();
      const write = (event: string, data: unknown) => {
        if (closed) return;
        try {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        eventStreamCleanups.delete(cleanup);
        request.raw.off('close', cleanup);
        request.raw.off('error', cleanup);
        if (!response.writableEnded) response.end();
      };

      eventStreamCleanups.add(cleanup);
      request.raw.once('close', cleanup);
      request.raw.once('error', cleanup);

      const publishChanges = async () => {
        if (closed) return;
        try {
          const runs = await runService.listByProject(projectId);
          for (const run of runs) {
            const serialized = JSON.stringify(run);
            if (lastSeen.get(run.id) === serialized) continue;
            lastSeen.set(run.id, serialized);
            write('run.updated', run);
          }
        } catch (error) {
          write('error', { message: error instanceof Error ? error.message : '事件读取失败' });
        }
      };

      write('ready', { projectId, projectName: project.name });
      await publishChanges();
      pollTimer = setInterval(() => void publishChanges(), 250);
      keepAliveTimer = setInterval(() => {
        if (!closed) response.write(': keep-alive\n\n');
      }, 15_000);
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const result = canvasDocumentSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'invalid canvas', issues: result.error.issues });
      }

      try {
        const canvas = await projectStore.updateCanvas(
          request.params.projectId,
          result.data,
          projectScope(requestPrincipals, request),
        );
        return { canvas };
      } catch (error) {
        if (error instanceof ProjectStoreError && error.code === 'revision_conflict') {
          return reply.code(409).send({ error: error.message, revision: error.revision });
        }
        if (error instanceof ProjectStoreError && error.code === 'not_found') {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ProjectStoreError && error.code === 'invalid_asset') {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/runs', async (request, reply) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        modelAlias: z.string().trim().min(1).max(160).optional(),
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        parameters: z.record(z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'projectId is required' });
    }

    const scope = projectScope(requestPrincipals, request);
    const canvas = await projectStore.getCanvas(body.data.projectId, scope);
    if (!canvas) return reply.code(404).send({ error: 'project not found' });

    try {
      if (maxActiveRunsPerProject !== undefined) {
        const activeRuns = await runService.listByProject(body.data.projectId);
        const activeCount = activeRuns.filter((run) =>
          ['queued', 'preparing', 'running', 'processing', 'cancel_requested'].includes(run.status),
        ).length;
        if (activeCount >= maxActiveRunsPerProject) {
          return reply.code(429).send({
            error: 'project run quota exceeded',
            retryAfterSeconds: 30,
          });
        }
      }
      const target = canvas.nodes.find((node) => node.id === request.params.nodeId);
      const modelAlias = target
        ? await settingsStore.resolveModel(
            target.data.mediaType,
            body.data.modelAlias ?? target.data.modelAlias,
          )
        : body.data.modelAlias;
      const modelCatalog = target ? await settingsStore.listModels(target.data.mediaType) : [];
      const model = modelAlias
        ? modelCatalog.find((candidate) => candidate.id === modelAlias)
        : undefined;
      const estimatedCost = quoteModelCost(
        model?.price,
        target ? canvas.edges.filter((edge) => edge.targetNodeId === target.id).length : 0,
        getRequestedUnits(body.data.parameters),
      );
      enforceRunCostPolicy(estimatedCost, parseRunCostPolicy());
      const credential = await settingsStore.getCredentialReference();
      const snapshot = createRunSnapshot(body.data.projectId, canvas, request.params.nodeId, {
        ...body.data,
        ...(modelAlias ? { modelAlias } : {}),
        ...credential,
      });
      const headerIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof headerIdempotencyKey === 'string' ? headerIdempotencyKey : body.data.idempotencyKey;
      const principal = requestPrincipals.get(request);
      const run = await runService.create(snapshot, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(principal?.userId ? { userId: principal.userId } : {}),
        ...(estimatedCost
          ? { estimatedCost: { amount: estimatedCost.amount, currency: estimatedCost.currency } }
          : {}),
      });
      request.log.info(
        {
          runId: run.id,
          projectId: body.data.projectId,
          nodeId: request.params.nodeId,
          provider: run.provider,
          modelAlias: run.modelAlias,
          ...(estimatedCost
            ? { estimatedCost: `${estimatedCost.amount} ${estimatedCost.currency}` }
            : {}),
          idempotent: Boolean(idempotencyKey),
        },
        'run queued',
      );
      return reply.code(202).send({ run });
    } catch (error) {
      if (
        error instanceof RunServiceError &&
        (error.code === 'invalid_target' || error.code === 'idempotency_conflict')
      ) {
        return reply
          .code(error.code === 'idempotency_conflict' ? 409 : 400)
          .send({ error: error.message });
      }
      if (error instanceof AiSettingsError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      if (error instanceof UsagePolicyError) {
        return reply
          .code(error.code === 'cost_limit_exceeded' ? 429 : 400)
          .send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (request, reply) => {
    const run = await runService.get(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    if (!(await projectStore.get(run.projectId, projectScope(requestPrincipals, request)))) {
      return reply.code(404).send({ error: 'run not found' });
    }
    return { run };
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/retry', async (request, reply) => {
    try {
      const previous = await runService.get(request.params.runId);
      if (
        !previous ||
        !(await projectStore.get(previous.projectId, projectScope(requestPrincipals, request)))
      ) {
        return reply.code(404).send({ error: 'run not found' });
      }
      const run = await runService.retry(request.params.runId);
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/cancel', async (request, reply) => {
    try {
      const current = await runService.get(request.params.runId);
      if (
        !current ||
        !(await projectStore.get(current.projectId, projectScope(requestPrincipals, request)))
      ) {
        return reply.code(404).send({ error: 'run not found' });
      }
      const run = await runService.cancel(request.params.runId);
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { status?: 'ready' | 'archived'; query?: string } }>(
    '/v1/assets',
    async (request, reply) => {
      const query = request.query.query?.trim().toLowerCase();
      const status = request.query.status;
      if (status && status !== 'ready' && status !== 'archived') {
        return reply.code(400).send({ error: 'invalid asset status' });
      }
      const assets = await assetStore.list(assetScope(requestPrincipals, request));
      return {
        assets: assets.filter(
          (asset) =>
            (!status || asset.status === status) &&
            (!query ||
              asset.name.toLowerCase().includes(query) ||
              asset.tags.some((tag) => tag.toLowerCase().includes(query))),
        ),
      };
    },
  );

  app.post('/v1/assets/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'file is required' });
    }

    const content = await file.toBuffer();
    const validation = validateUploadContent(file.filename, file.mimetype, content);
    if (!validation.ok) return reply.code(validation.status).send({ error: validation.error });

    const metadata = await tryExtractMediaMetadata(
      mediaMetadataExtractor,
      {
        content,
        mimeType: file.mimetype || 'application/octet-stream',
        mediaType: validation.mediaType,
      },
      request.log,
    );
    const derivatives = await tryGenerateMediaDerivatives(
      mediaDerivativeGenerator,
      {
        content,
        mimeType: file.mimetype || 'application/octet-stream',
        mediaType: validation.mediaType,
      },
      request.log,
    );

    const asset = await assetStore.create({
      name: file.filename,
      mediaType: validation.mediaType,
      mimeType: file.mimetype || 'application/octet-stream',
      content,
      ...(derivatives ? { derivatives } : {}),
      ...(metadata ? { metadata } : {}),
      ...ownerInput(requestPrincipals, request),
    });

    const { content: _content, ...response } = asset;
    return reply.code(201).send({ asset: response });
  });

  app.post('/v1/assets/uploads/init', async (request, reply) => {
    const result = z
      .object({
        name: z.string().trim().min(1).max(240),
        mimeType: z.string().trim().min(1).max(160),
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid upload initialization' });
    const mediaType = detectMediaType(result.data.name, result.data.mimeType);
    if (!mediaType) return reply.code(415).send({ error: 'unsupported media type' });
    const upload = await uploadSessionStore.create({
      name: result.data.name,
      mimeType: result.data.mimeType,
      mediaType,
      sizeBytes: result.data.sizeBytes,
      sha256: result.data.sha256.toLowerCase(),
      tags: result.data.tags ?? [],
      ...ownerInput(requestPrincipals, request),
    });
    const scope = uploadScope(requestPrincipals, request);
    const externalUploadUrl = await uploadSessionStore.getUploadUrl(upload.uploadId, scope);
    return reply.code(201).send({
      uploadId: upload.uploadId,
      uploadUrl: externalUploadUrl ?? `/v1/assets/uploads/${upload.uploadId}`,
      completeUrl: '/v1/assets/uploads/complete',
      expiresAt: new Date(upload.expiresAt).toISOString(),
    });
  });

  app.put<{ Params: { uploadId: string }; Body: Buffer }>(
    '/v1/assets/uploads/:uploadId',
    async (request, reply) => {
      const scope = uploadScope(requestPrincipals, request);
      const upload = await uploadSessionStore.get(request.params.uploadId, scope);
      if (!upload || isUploadExpired(upload)) {
        await uploadSessionStore.delete(request.params.uploadId, scope);
        return reply.code(404).send({ error: 'upload not found or expired' });
      }
      const content = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (content.byteLength > MAX_UPLOAD_BYTES || content.byteLength !== upload.sizeBytes) {
        return reply.code(400).send({ error: 'uploaded size does not match initialization' });
      }
      const actualSha256 = sha256(content);
      if (actualSha256 !== upload.sha256) {
        return reply.code(400).send({ error: 'uploaded SHA-256 does not match initialization' });
      }
      await uploadSessionStore.putContent(upload.uploadId, content, scope);
      return reply.code(204).send();
    },
  );

  app.post('/v1/assets/uploads/complete', async (request, reply) => {
    const result = z
      .object({
        uploadId: z.string().min(1),
        name: z.string().trim().min(1).max(240),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid upload completion' });
    const scope = uploadScope(requestPrincipals, request);
    const upload = await uploadSessionStore.get(result.data.uploadId, scope);
    if (!upload || isUploadExpired(upload)) {
      await uploadSessionStore.delete(result.data.uploadId, scope);
      return reply.code(404).send({ error: 'upload not found or expired' });
    }
    if (
      upload.name !== result.data.name ||
      upload.mimeType !== result.data.mimeType ||
      upload.sizeBytes !== result.data.sizeBytes ||
      upload.sha256 !== result.data.sha256.toLowerCase()
    ) {
      return reply
        .code(409)
        .send({ error: 'upload completion metadata does not match initialization' });
    }
    const content = await uploadSessionStore.getContent(upload.uploadId, scope);
    if (!content) return reply.code(409).send({ error: 'upload content is not ready' });
    const validation = validateUploadContent(upload.name, upload.mimeType, content);
    if (!validation.ok || sha256(content) !== upload.sha256) {
      await uploadSessionStore.delete(result.data.uploadId, scope);
      return reply.code(400).send({ error: 'uploaded content failed integrity validation' });
    }
    const metadata = await tryExtractMediaMetadata(
      mediaMetadataExtractor,
      { content, mimeType: upload.mimeType, mediaType: validation.mediaType },
      request.log,
    );
    const derivatives = await tryGenerateMediaDerivatives(
      mediaDerivativeGenerator,
      { content, mimeType: upload.mimeType, mediaType: validation.mediaType },
      request.log,
    );
    const asset = await assetStore.create({
      name: upload.name,
      mediaType: validation.mediaType,
      mimeType: upload.mimeType,
      content,
      tags: upload.tags,
      ...(derivatives ? { derivatives } : {}),
      ...(metadata ? { metadata } : {}),
      ...ownerInput(requestPrincipals, request),
    });
    await uploadSessionStore.delete(result.data.uploadId, scope);
    const { content: _content, ...response } = asset;
    return reply.code(201).send({ asset: response });
  });

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/access-url',
    async (request, reply) => {
      const result = z
        .object({
          expiresInSeconds: z.number().int().min(30).max(900).optional(),
          version: z.number().int().min(1).optional(),
          derivative: z.enum(['thumbnail', 'poster', 'waveform']).optional(),
        })
        .strict()
        .safeParse(request.body ?? {});
      if (!result.success || (result.data.version !== undefined && result.data.derivative)) {
        return reply.code(400).send({ error: 'invalid asset access URL request' });
      }

      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset not found' });

      const resource = accessResource(request.params.assetId, result.data);
      if (result.data.version !== undefined) {
        const content = await assetStore.getVersionContent(
          request.params.assetId,
          result.data.version,
          scope,
        );
        if (!content) return reply.code(404).send({ error: 'asset version not found' });
      } else if (result.data.derivative !== undefined) {
        const derivative = await assetStore.getDerivative(
          request.params.assetId,
          result.data.derivative,
          scope,
        );
        if (!derivative) return reply.code(404).send({ error: 'derivative not found' });
      }

      const expiresIn = result.data.expiresInSeconds ?? 300;
      const expiresAt = Date.now() + expiresIn * 1000;
      const nativeUrl = await assetStore.createPresignedGetUrl?.(
        request.params.assetId,
        {
          ...(result.data.version !== undefined ? { version: result.data.version } : {}),
          ...(result.data.derivative !== undefined ? { derivative: result.data.derivative } : {}),
          expiresIn,
        },
        scope,
      );
      if (nativeUrl)
        return reply.send({ url: nativeUrl, expiresAt: new Date(expiresAt).toISOString() });
      const token = createAssetAccessToken(
        {
          resource,
          assetId: request.params.assetId,
          ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
          expiresAt,
        },
        assetAccessSecret,
      );
      const path = accessPath(request.params.assetId, result.data);
      return reply.send({
        url: `${path}?access_token=${encodeURIComponent(token)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/content',
    async (request, reply) => {
      const asset = await assetStore.get(
        request.params.assetId,
        assetScope(requestPrincipals, request),
      );
      if (!asset) {
        return reply.code(404).send({ error: 'asset not found' });
      }

      return reply.type(asset.mimeType).send(asset.content);
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/versions',
    async (request, reply) => {
      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const versions = await assetStore.listVersions(request.params.assetId, scope);
      return {
        versions: versions.map(({ contentKey: _contentKey, ...version }) => ({
          ...version,
          contentUrl: `/v1/assets/${request.params.assetId}/versions/${version.version}/content`,
        })),
      };
    },
  );

  app.get<{ Params: { assetId: string; version: string } }>(
    '/v1/assets/:assetId/versions/:version/content',
    async (request, reply) => {
      if (!/^\d+$/.test(request.params.version)) {
        return reply.code(400).send({ error: 'invalid asset version' });
      }
      const version = Number(request.params.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        return reply.code(400).send({ error: 'invalid asset version' });
      }
      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset version not found' });
      const content = await assetStore.getVersionContent(request.params.assetId, version, scope);
      if (!content) return reply.code(404).send({ error: 'asset version not found' });
      return reply.type(asset.mimeType).send(content);
    },
  );

  app.get<{ Params: { assetId: string; kind: string } }>(
    '/v1/assets/:assetId/derivatives/:kind',
    async (request, reply) => {
      if (!['thumbnail', 'poster', 'waveform'].includes(request.params.kind)) {
        return reply.code(404).send({ error: 'derivative not found' });
      }
      const derivative = await assetStore.getDerivative(
        request.params.assetId,
        request.params.kind,
        assetScope(requestPrincipals, request),
      );
      if (!derivative) return reply.code(404).send({ error: 'derivative not found' });
      return reply.type(derivative.mimeType).send(derivative.content);
    },
  );

  app.patch<{ Params: { assetId: string } }>('/v1/assets/:assetId', async (request, reply) => {
    const result = z
      .object({
        name: z.string().trim().min(1).max(240).optional(),
        tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid asset update' });
    const asset = await assetStore.update(
      request.params.assetId,
      result.data,
      assetScope(requestPrincipals, request),
    );
    if (!asset) return reply.code(404).send({ error: 'asset not found' });
    const { content: _content, ...response } = asset;
    return { asset: response };
  });

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/archive',
    async (request, reply) => {
      const asset = await assetStore.setArchived(
        request.params.assetId,
        true,
        assetScope(requestPrincipals, request),
      );
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const { content: _content, ...response } = asset;
      return { asset: response };
    },
  );

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/restore',
    async (request, reply) => {
      const asset = await assetStore.setArchived(
        request.params.assetId,
        false,
        assetScope(requestPrincipals, request),
      );
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const { content: _content, ...response } = asset;
      return { asset: response };
    },
  );

  app.addHook('onClose', async () => {
    await uploadSessionStore.close?.();
    for (const cleanup of [...eventStreamCleanups]) cleanup();
    await runService.close();
    await (projectStore as ProjectStore).close?.();
    await settingsStore.close?.();
    await webhookEventStore.close?.();
    await authStore.close?.();
  });

  return app;
}

function projectScope(principals: WeakMap<object, AuthPrincipal>, request: object): ProjectScope {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

function assetScope(principals: WeakMap<object, AuthPrincipal>, request: object): AssetScope {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

type AccessUrlRequest = {
  version?: number;
  derivative?: 'thumbnail' | 'poster' | 'waveform';
};

function accessResource(assetId: string, options: AccessUrlRequest): string {
  if (options.version !== undefined) return `asset:${assetId}:version:${options.version}`;
  if (options.derivative !== undefined) return `asset:${assetId}:derivative:${options.derivative}`;
  return `asset:${assetId}:content`;
}

function accessPath(assetId: string, options: AccessUrlRequest): string {
  if (options.version !== undefined) {
    return `/v1/assets/${encodeURIComponent(assetId)}/versions/${options.version}/content`;
  }
  if (options.derivative !== undefined) {
    return `/v1/assets/${encodeURIComponent(assetId)}/derivatives/${options.derivative}`;
  }
  return `/v1/assets/${encodeURIComponent(assetId)}/content`;
}

function assetContentResource(pathname: string): string | undefined {
  const content = /^\/v1\/assets\/([^/]+)\/content$/.exec(pathname);
  if (content) {
    const assetId = decodePathSegment(content[1]);
    return assetId ? `asset:${assetId}:content` : undefined;
  }
  const version = /^\/v1\/assets\/([^/]+)\/versions\/(\d+)\/content$/.exec(pathname);
  if (version) {
    const assetId = decodePathSegment(version[1]);
    return assetId ? `asset:${assetId}:version:${version[2]}` : undefined;
  }
  const derivative = /^\/v1\/assets\/([^/]+)\/derivatives\/(thumbnail|poster|waveform)$/.exec(
    pathname,
  );
  if (derivative) {
    const assetId = decodePathSegment(derivative[1]);
    return assetId ? `asset:${assetId}:derivative:${derivative[2]}` : undefined;
  }
  return undefined;
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function ownerInput(
  principals: WeakMap<object, AuthPrincipal>,
  request: object,
): { ownerId?: string } {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

function uploadScope(
  principals: WeakMap<object, AuthPrincipal>,
  request: object,
): UploadSessionScope {
  const ownerId = principals.get(request)?.userId;
  return ownerId ? { ownerId } : {};
}

/**
 * Current AI credentials are platform-wide records. A JWT identifies an end
 * user, but it does not convey an administrator role, so only the configured
 * service token may manage those credentials until project-scoped credentials
 * and roles are introduced.
 */
function canManagePlatformSettings(
  principals: WeakMap<object, AuthPrincipal>,
  sessions: WeakMap<object, AuthenticatedSession>,
  request: object,
): boolean {
  const principal = principals.get(request);
  if (!principal) return false;
  if (principal.method !== 'jwt') return true;
  // Only the first-party session lookup may grant the admin role. A role claim
  // on a legacy stateless JWT is deliberately ignored for platform settings.
  return sessions.get(request)?.user.role === 'admin';
}

function sendAuthServiceError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
): unknown {
  if (!(error instanceof AuthServiceError)) throw error;
  switch (error.code) {
    case 'invalid_input':
      return reply.code(400).send({ error: error.message });
    case 'email_taken':
      return reply.code(409).send({ error: error.message });
    case 'invalid_credentials':
    case 'invalid_token':
    case 'session_revoked':
      return reply.code(401).send({ error: error.message });
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validateUploadContent(
  name: string,
  mimeType: string,
  content: Buffer,
):
  | { ok: true; mediaType: Exclude<ReturnType<typeof detectMediaType>, undefined> }
  | { ok: false; status: 400 | 413 | 415; error: string } {
  if (content.byteLength === 0) return { ok: false, status: 400, error: 'file cannot be empty' };
  if (content.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: 'file exceeds the 100 MB upload limit' };
  }
  const mediaType = detectMediaType(name, mimeType);
  if (!mediaType) return { ok: false, status: 415, error: 'unsupported media type' };
  return { ok: true, mediaType };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isUploadExpired(upload: { expiresAt: number }): boolean {
  return Date.now() >= upload.expiresAt;
}

function verifyWebhookSignature(payload: unknown, signature: string, secret: string) {
  const normalized = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(payload ?? {}))
    .digest('hex');
  return safeEqual(normalized, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function getRequestedUnits(parameters: Record<string, unknown> | undefined): number | string {
  const value = parameters?.units;
  return typeof value === 'number' || typeof value === 'string' ? value : 1;
}

async function tryExtractMediaMetadata(
  extractor: MediaMetadataExtractor,
  input: MediaProbeInput,
  logger: { warn: (object: unknown, message?: string) => void },
): Promise<Record<string, unknown> | undefined> {
  try {
    const metadata = await extractor.extract(input);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch (error) {
    logger.warn({ err: error, mimeType: input.mimeType }, 'media metadata extraction failed');
    return undefined;
  }
}

async function tryGenerateMediaDerivatives(
  generator: MediaDerivativeGenerator,
  input: MediaProbeInput,
  logger: { warn: (object: unknown, message?: string) => void },
): Promise<Record<string, { mimeType: string; content: Buffer }> | undefined> {
  try {
    const generated = await generator.generate(input);
    if (generated.length === 0) return undefined;
    return Object.fromEntries(
      generated
        .filter((derivative) => derivative.content.byteLength > 0)
        .map((derivative) => [
          derivative.kind,
          { mimeType: derivative.mimeType, content: derivative.content },
        ]),
    );
  } catch (error) {
    logger.warn({ err: error, mimeType: input.mimeType }, 'media derivative generation failed');
    return undefined;
  }
}

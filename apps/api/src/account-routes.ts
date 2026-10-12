import { AccountAccessError as AccountServiceError, accountError } from './account-errors';
import { randomUUID } from 'node:crypto';
import type { RunRecord } from '@multimodal-canvas/domain';
import { ExecutionError } from '@multimodal-canvas/execution';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, toPublicUser, type AuthenticatedSession } from './auth-service';
import { extractBearerToken } from './auth';
import type { AuthStore } from './auth-store';
import type { AssetStore, ManagementAsset } from './assets';
import type { ProjectStore } from './projects';
import { RunServiceError, type RunService } from './runs';

/** 通用分页最大一百条，空值和无效枚举均明确拒绝。 */
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
/** 列表过滤在鉴权后的用户范围内执行，不接受任意 ownerId 覆盖。 */
const resourceQuerySchema = paginationSchema
  .extend({
    query: z.string().max(512).optional(),
    mediaType: z.enum(['text', 'image', 'audio', 'video']).optional(),
    status: z.enum(['ready', 'archived']).optional(),
    source: z.enum(['upload', 'generated']).optional(),
    ownerId: z.string().max(100).optional(),
    projectId: z.string().max(100).optional(),
    tags: z.string().max(2048).optional(),
  })
  .strict();

/** 后台路由所依赖的既有业务存储与真实会话解析边界。 */
export type AccountRoutesOptions = {
  store: AuthStore;
  auth?: AuthService;
  assets: AssetStore;
  projects: ProjectStore;
  runs: RunService;
  sessions: WeakMap<object, AuthenticatedSession>;
};

/** 注册 /admin、个人账户及分用户资源管理接口，权限由服务端逐路由执行。 */
export function registerAccountRoutes(app: FastifyInstance, options: AccountRoutesOptions): void {
  /** 统一捕获输入和已知业务错误，未知基础设施错误保留给全局错误边界。 */
  const handler =
    (operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await operation(request, reply);
      } catch (error) {
        if (error instanceof z.ZodError)
          return reply.code(400).send({
            code: 'invalid_input',
            error: '输入字段不符合要求',
            issues: error.issues.map(({ path, message }) => ({ path, message })),
          });
        const mapped = accountError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    };
  /** 只接受有状态会话；服务凭据和 JWT 中未经确认的角色不能进入账户后台。 */
  const session = (request: FastifyRequest, admin = false) => {
    const current = options.sessions.get(request);
    if (!current) throw new AccountServiceError('authentication_required', '请先登录', 401);
    if (admin && current.user.role !== 'admin')
      throw new AccountServiceError('admin_required', '仅管理员可以访问', 403);
    return current;
  };
  /** 用户详情不存在时采用统一 404，不把密码摘要带入响应。 */
  const userById = async (id: string) => {
    const user = await options.store.findUserById(id);
    if (!user) throw new AccountServiceError('user_not_found', '用户不存在', 404);
    return user;
  };
  app.get(
    '/v1/account/profile',
    handler(async (request) => ({ user: toPublicUser(await userById(session(request).user.id)) })),
  );
  app.get(
    '/v1/account/sessions',
    handler(async (request) => {
      const current = session(request);
      const sessions = (await options.store.listSessions(current.user.id))
        .filter((entry) => !entry.revokedAt && entry.expiresAt.getTime() > Date.now())
        .map((entry) => ({
          id: entry.id,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
          expiresAt: entry.expiresAt,
          current: entry.id === current.session.id,
        }));
      return { sessions };
    }),
  );
  app.delete(
    '/v1/account/sessions/:id',
    handler(async (request) => {
      const current = session(request);
      const { id } = idParams(request);
      const target = await options.store.findSession(id);
      if (!target || target.userId !== current.user.id)
        throw new AccountServiceError('session_not_found', '会话不存在', 404);
      await options.store.revokeSession(id, new Date());
      await audit(
        options.store,
        current.user.id,
        current.user.id,
        id,
        'account.session.revoke',
        '撤销登录会话',
      );
      return { revoked: true };
    }),
  );
  app.post(
    '/v1/account/sessions/revoke-others',
    handler(async (request) => {
      const current = session(request);
      const revokedSessions = await options.store.transaction(async (store) => {
        const others = (await store.listSessions(current.user.id)).filter(
          (entry) => entry.id !== current.session.id && !entry.revokedAt,
        );
        for (const entry of others) await store.revokeSession(entry.id, new Date());
        await audit(
          store,
          current.user.id,
          current.user.id,
          current.user.id,
          'account.sessions.revoke-others',
          '退出其他登录会话',
        );
        return others.length;
      });
      return { revokedSessions };
    }),
  );

  app.get(
    '/v1/admin/resource-owners/:id',
    handler(async (request) => {
      session(request, true);
      const user = await userById(idParams(request).id);
      const projects = await options.projects.list({ ownerId: user.id }, { includeArchived: true });
      const assets = (await managedAssets(options)).filter((asset) => asset.ownerId === user.id);
      const runs = await managedRuns(options, user.id);
      return {
        user: toPublicUser(user),
        projects,
        stats: {
          resourceCount: assets.length,
          storageBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
          runCount: runs.length,
        },
      };
    }),
  );
  app.get(
    '/v1/admin/resource-groups',
    handler(async (request) => {
      session(request, true);
      const users = await options.store.listUsers();
      const assets = await managedAssets(options);
      const groups = users.map((user) => ({
        ownerId: user.id as string | null,
        user: toPublicUser(user) as ReturnType<typeof toPublicUser> | null,
        resourceCount: 0,
        storageBytes: 0,
      }));
      groups.push({ ownerId: null, user: null, resourceCount: 0, storageBytes: 0 });
      const byId = new Map(groups.map((group) => [group.ownerId, group]));
      for (const asset of assets) {
        const group = byId.get(asset.ownerId) ?? byId.get(null)!;
        group.resourceCount += 1;
        group.storageBytes += asset.sizeBytes;
      }
      return { groups };
    }),
  );

  for (const admin of [false, true]) {
    const base = admin ? '/v1/admin/resources' : '/v1/account/resources';
    app.get(
      base,
      handler(async (request) => {
        const current = session(request, admin);
        const query = resourceQuerySchema.parse(request.query);
        if (!admin && query.ownerId !== undefined)
          throw new AccountServiceError('invalid_input', '我的资源不接受所有者参数');
        if (admin && !query.ownerId)
          throw new AccountServiceError('owner_required', '请先选择一个用户分组');
        const ownerId = admin
          ? query.ownerId === 'unassigned'
            ? null
            : query.ownerId!
          : current.user.id;
        const assets = (await managedAssets(options, admin ? undefined : current.user.id)).filter(
          (asset) =>
            asset.ownerId === ownerId &&
            (!query.query || asset.name.toLowerCase().includes(query.query.toLowerCase())) &&
            (!query.mediaType || asset.mediaType === query.mediaType) &&
            (!query.status || asset.status === query.status) &&
            (!query.source || asset.source === query.source) &&
            (!query.projectId || asset.projectId === query.projectId) &&
            (!query.tags ||
              query.tags
                .split(',')
                .every((tag) =>
                  asset.tags.some((value) => value.toLowerCase() === tag.trim().toLowerCase()),
                )),
        );
        return {
          assets: paginate(assets, query),
          total: assets.length,
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    );
    app.get(
      `${base}/:id`,
      handler(async (request) => {
        const current = session(request, admin);
        const asset = await authorizedAsset(
          options,
          idParams(request).id,
          admin ? undefined : current.user.id,
        );
        const versions = (await options.assets.listVersions(asset.id)).map(
          ({ contentKey: _contentKey, ...version }) => version,
        );
        const project = asset.projectId ? await options.projects.get(asset.projectId) : undefined;
        return { asset, versions, ...(project ? { project } : {}) };
      }),
    );
    app.patch(
      `${base}/:id`,
      handler(async (request) => {
        const current = session(request, admin);
        const asset = await authorizedAsset(
          options,
          idParams(request).id,
          admin ? undefined : current.user.id,
        );
        const input = z
          .object({
            name: z.string().trim().min(1).max(240).optional(),
            tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
            status: z.enum(['ready', 'archived']).optional(),
          })
          .strict()
          .refine((value) => Object.keys(value).length > 0, '至少提供一个可编辑字段')
          .parse(request.body);
        await audit(
          options.store,
          current.user.id,
          asset.ownerId ?? undefined,
          asset.id,
          'resource.update.request',
          `申请修改资源字段：${Object.keys(input).join('、')}`,
        );
        if (input.name !== undefined || input.tags !== undefined) {
          const updated = await options.assets.update(asset.id, {
            name: input.name,
            tags: input.tags,
          });
          if (!updated)
            throw new AccountServiceError(
              'resource_unavailable',
              '资源更新未完成，请检查存储',
              503,
            );
        }
        if (input.status !== undefined) {
          const updated = await options.assets.setArchived(asset.id, input.status === 'archived');
          if (!updated)
            throw new AccountServiceError(
              'resource_unavailable',
              '资源状态更新未完成，请检查存储',
              503,
            );
        }
        await audit(
          options.store,
          current.user.id,
          asset.ownerId ?? undefined,
          asset.id,
          'resource.update',
          `已修改资源字段：${Object.keys(input).join('、')}`,
        );
        return {
          asset: await authorizedAsset(options, asset.id, admin ? undefined : current.user.id),
        };
      }),
    );
    app.get(
      `${base}/:id/content`,
      handler(async (request, reply) => {
        const current = session(request, admin);
        const asset = await authorizedAsset(
          options,
          idParams(request).id,
          admin ? undefined : current.user.id,
        );
        const query = z
          .object({
            version: z.coerce.number().int().positive().optional(),
            derivative: z.enum(['thumbnail', 'poster', 'waveform']).optional(),
          })
          .strict()
          .refine((value) => !(value.version && value.derivative), '版本和衍生资源不能同时指定')
          .parse(request.query);
        let content: Buffer | undefined;
        let mimeType = asset.mimeType;
        if (query.version)
          content = await options.assets.getVersionContent(asset.id, query.version);
        else if (query.derivative) {
          const derivative = await options.assets.getDerivative(asset.id, query.derivative);
          content = derivative?.content;
          mimeType = derivative?.mimeType ?? mimeType;
        } else content = (await options.assets.get(asset.id))?.content;
        if (!content) throw new AccountServiceError('resource_not_found', '资源内容不存在', 404);
        reply
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .header(
            'content-disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
          )
          .type(mimeType);
        return sendContent(reply, request, content);
      }),
    );
  }

  for (const admin of [false, true]) {
    app.get(
      admin ? '/v1/admin/runs' : '/v1/account/runs',
      handler(async (request) => {
        const current = session(request, admin);
        const query = paginationSchema
          .extend({
            ownerId: z.string().max(100).optional(),
            status: z.string().max(32).optional(),
            projectId: z.string().max(100).optional(),
          })
          .strict()
          .parse(request.query);
        if (!admin && query.ownerId)
          throw new AccountServiceError('invalid_input', '我的任务不接受所有者参数');
        const runs = (await managedRuns(options, admin ? query.ownerId : current.user.id)).filter(
          (run) =>
            (!query.status || run.status === query.status) &&
            (!query.projectId || run.projectId === query.projectId),
        );
        return {
          runs: paginate(runs, query),
          total: runs.length,
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    );
  }
  for (const admin of [false, true]) {
    const base = admin ? '/v1/admin/runs' : '/v1/account/runs';
    app.get(
      `${base}/:id`,
      handler(async (request) => {
        const current = session(request, admin);
        z.object({}).strict().parse(request.query);
        const run = await authorizedRun(
          options,
          idParams(request).id,
          admin ? undefined : current.user.id,
          admin,
        );
        if (!run) throw new AccountServiceError('run_not_found', '任务不存在或无权访问', 404);
        const users = new Map(
          (await options.store.listUsers()).map((user) => [user.id, toPublicUser(user)]),
        );
        return { run: managedRunDto(run.run, run.project, users) };
      }),
    );
    app.post(
      `${base}/:id/recover`,
      handler(async (request, reply) => {
        const current = session(request, admin);
        z.object({}).strict().parse(request.query);
        z.object({})
          .strict()
          .parse(request.body === undefined ? {} : request.body);
        const authorized = await authorizedRun(
          options,
          idParams(request).id,
          admin ? undefined : current.user.id,
          admin,
        );
        if (!authorized)
          throw new AccountServiceError('run_not_found', '任务不存在或无权访问', 404);
        const users = new Map(
          (await options.store.listUsers()).map((user) => [user.id, toPublicUser(user)]),
        );
        const dto = managedRunDto(authorized.run, authorized.project, users);
        if (!dto.recoverableVideo)
          throw new AccountServiceError(
            'recovery_unavailable',
            '该任务没有可获取的原视频结果',
            409,
          );
        if (!options.runs.recover)
          throw new AccountServiceError(
            'recovery_unavailable',
            '当前执行后端不支持持久任务恢复',
            409,
          );
        await audit(
          options.store,
          current.user.id,
          authorized.run.userId,
          authorized.run.id,
          'run.video.retrieve.request',
          '请求查询原视频平台任务并获取结果',
        );
        let recovered: RunRecord;
        try {
          recovered = await options.runs.recover(authorized.run.id, { retrieveOnly: true });
        } catch (error) {
          if (error instanceof RunServiceError)
            throw new AccountServiceError('recovery_unavailable', error.message, 409);
          if (error instanceof ExecutionError)
            throw new AccountServiceError(
              error.code,
              error.message,
              error.code === 'authorization_revoked' ? 403 : 409,
            );
          throw error;
        }
        if (
          recovered.id !== authorized.run.id ||
          recovered.projectId !== authorized.run.projectId ||
          recovered.userId !== authorized.run.userId ||
          recovered.targetNodeId !== authorized.run.targetNodeId ||
          recovered.attempt !== authorized.run.attempt
        )
          throw new AccountServiceError('recovery_conflict', '恢复任务身份已变化', 409);
        return reply.code(202).send({
          run: managedRunDto(recovered, authorized.project, users),
          accepted: true,
        });
      }),
    );
  }
  app.get(
    '/v1/admin/audit',
    handler(async (request) => {
      session(request, true);
      const query = paginationSchema
        .extend({ query: z.string().max(512).optional(), ownerId: z.string().max(100).optional() })
        .strict()
        .parse(request.query);
      const events = (await options.store.listAudit()).filter(
        (event) =>
          (!query.ownerId || event.ownerId === query.ownerId) &&
          (!query.query ||
            `${event.action} ${event.summary}`.toLowerCase().includes(query.query.toLowerCase())),
      );
      return {
        events: paginate(events, query),
        total: events.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    }),
  );
  app.get(
    '/v1/admin/overview',
    handler(async (request) => {
      session(request, true);
      const users = await options.store.listUsers();
      const assets = await managedAssets(options);
      const runs = await managedRuns(options);
      return {
        users: {
          total: users.length,
          active: users.filter((user) => user.status === 'active').length,
          pending: users.filter((user) => user.status === 'pending').length,
          disabled: users.filter((user) => user.status === 'disabled').length,
        },
        resources: {
          total: assets.length,
          storageBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
          unassigned: assets.filter((asset) => !asset.ownerId).length,
        },
        runs: {
          total: runs.length,
          failed: runs.filter((run) => run.status === 'failed').length,
          active: runs.filter((run) => !['succeeded', 'failed', 'cancelled'].includes(run.status))
            .length,
        },
      };
    }),
  );
  app.get(
    '/v1/admin/system',
    handler(async (request) => {
      session(request, true);
      const storage = await managedAssets(options).then(
        () => ({ status: 'ok' }),
        () => ({ status: 'error' }),
      );
      const queue = options.runs.health
        ? await options.runs.health().then(
            () => ({ status: 'available' }),
            () => ({ status: 'error' }),
          )
        : { status: 'unknown' };
      return {
        api: { status: 'ok' },
        storage,
        queue,
      };
    }),
  );
}

/** 校验路由标识；资源和项目允许既有 memory 前缀，用户存储不存在时返回 404。 */
function idParams(request: FastifyRequest): { id: string } {
  return z
    .object({
      id: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .parse(request.params);
}
/** 在已授权结果上分页，避免总数暴露其他用户的信息。 */
function paginate<T>(entries: T[], query: { page: number; pageSize: number }): T[] {
  return entries.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
}
/** 从项目归属推导明确的历史资源；归属冲突与孤立资源进入管理员待归属组。 */
async function managedAssets(
  options: AccountRoutesOptions,
  ownerId?: string,
): Promise<ManagementAsset[]> {
  if (!options.assets.listManagement)
    throw new AccountServiceError('resource_index_unavailable', '资源管理索引不可用', 503);
  const projects = await options.projects.list(ownerId ? { ownerId } : {}, {
    includeArchived: true,
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const raw = ownerId
    ? [
        ...(await options.assets.listManagement({ ownerId })),
        ...(
          await Promise.all(
            projects.map((project) => options.assets.listManagement!({ projectId: project.id })),
          )
        ).flat(),
      ]
    : await options.assets.listManagement();
  if (ownerId) {
    const missingProjectIds = [
      ...new Set(
        raw
          .map((asset) => asset.projectId)
          .filter((id): id is string => Boolean(id && !projectById.has(id))),
      ),
    ];
    for (const id of missingProjectIds) {
      const project = await options.projects.get(id);
      if (project) projectById.set(id, project);
    }
  }
  return [...new Map(raw.map((asset) => [asset.id, asset])).values()]
    .map((asset) => {
      const project = asset.projectId ? projectById.get(asset.projectId) : undefined;
      const conflict = Boolean(
        asset.projectId &&
        (!project || (asset.ownerId && project.ownerId && asset.ownerId !== project.ownerId)),
      );
      return { ...asset, ownerId: conflict ? null : (asset.ownerId ?? project?.ownerId ?? null) };
    })
    .filter((asset) => ownerId === undefined || asset.ownerId === ownerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
/** 先验证元数据归属，再允许调用底层内容存储，禁止通过替换 ID 读取他人内容。 */
async function authorizedAsset(
  options: AccountRoutesOptions,
  id: string,
  ownerId?: string,
): Promise<ManagementAsset> {
  const asset = (await managedAssets(options, ownerId)).find((candidate) => candidate.id === id);
  if (!asset) throw new AccountServiceError('resource_not_found', '资源不存在或无权访问', 404);
  return asset;
}
/** 使用既有 RunService 获取真实任务；公开形状不包含快照内容、凭据或 Provider 原始响应。 */
async function managedRuns(options: AccountRoutesOptions, ownerId?: string) {
  const projects = await options.projects.list(ownerId ? { ownerId } : {}, {
    includeArchived: true,
  });
  const users = new Map(
    (await options.store.listUsers()).map((user) => [user.id, toPublicUser(user)]),
  );
  const runs = (
    await Promise.all(
      projects.map(async (project) =>
        (await options.runs.listByProject(project.id))
          .filter(
            (run) =>
              (!ownerId || !run.userId || run.userId === ownerId) &&
              !(run.userId && project.ownerId && run.userId !== project.ownerId),
          )
          .map((run) => managedRunDto(run, project, users)),
      ),
    )
  ).flat();
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
/** 管理任务列表、详情和受理响应共用的公开字段；不承载原始执行数据。 */
type ManagedRunDto = {
  id: string;
  projectId: string;
  projectName: string;
  targetNodeId: string;
  status: RunRecord['status'];
  progress: number;
  attempt: number;
  provider: string;
  modelAlias: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string | null;
  user: ReturnType<typeof toPublicUser> | null;
  recoverableVideo: boolean;
  error?: string;
  result?: {
    summary: string;
    targetNodeId: string;
    mediaType: string;
    provider: string;
    inputCount: number;
    asset?: { assetId: string; version?: number; mimeType?: string; sizeBytes?: number };
  };
};

/**
 * 将已核对归属的 Run 转成管理页安全 DTO，不返回平台任务 ID、冻结快照或凭据。
 * @param run 原任务记录，恢复资格仅表示可发起查询，执行层仍须验证持久授权。
 * @param project 原任务项目及其当前所有者。
 * @param users 用户公开信息索引，不含会话和凭据。
 * @returns 可用于列表、独立详情和受理响应的状态与归档资源标识。
 */
function managedRunDto(
  run: RunRecord,
  project: { id: string; name: string; ownerId?: string },
  users: ReadonlyMap<string, ReturnType<typeof toPublicUser>>,
): ManagedRunDto {
  const ownerId = run.userId ?? project.ownerId ?? null;
  const user = users.get(ownerId ?? '') ?? null;
  const target = run.snapshot.nodes.find((node) => node.id === run.targetNodeId);
  const recoverableVideo = Boolean(
    ownerId &&
    project.ownerId === ownerId &&
    run.userId === ownerId &&
    ['failed', 'cancelled'].includes(run.status) &&
    target?.data.mediaType === 'video' &&
    run.provider === 'newapi' &&
    run.providerJob?.provider === 'newapi' &&
    Boolean(run.providerJob.platformJobId?.trim()) &&
    !run.result?.asset,
  );
  return {
    id: run.id,
    projectId: run.projectId,
    projectName: project.name,
    targetNodeId: run.targetNodeId,
    status: run.status,
    progress: run.progress,
    attempt: run.attempt,
    provider: run.provider,
    modelAlias: run.modelAlias,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ownerId,
    user,
    recoverableVideo,
    ...(run.error ? { error: run.error } : {}),
    ...(run.result
      ? {
          result: {
            summary: run.result.summary,
            targetNodeId: run.result.targetNodeId,
            mediaType: run.result.mediaType,
            provider: run.result.provider,
            inputCount: run.result.inputCount,
            ...(run.result.asset
              ? {
                  asset: {
                    assetId: run.result.asset.assetId,
                    version: run.result.asset.version,
                    mimeType: run.result.asset.mimeType,
                    sizeBytes: run.result.asset.sizeBytes,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * 读取原任务并核对 Run 与项目所有权；身份冲突统一作为不存在处理。
 * @param options 管理路由所依赖的任务和项目存储。
 * @param id 服务端持久 Run ID，不是平台任务 ID。
 * @param ownerId 个人路由的已登录用户；管理员路由省略，不接受客户端替换。
 * @param admin 调用方已通过管理员会话校验时为 true。
 * @returns 已授权的任务与项目；不存在或归属冲突返回 undefined，存储错误继续抛出。
 */
async function authorizedRun(
  options: AccountRoutesOptions,
  id: string,
  ownerId: string | undefined,
  admin: boolean,
): Promise<
  { run: RunRecord; project: { id: string; name: string; ownerId?: string } } | undefined
> {
  const run = await options.runs.get(id);
  if (!run) return undefined;
  const project = await options.projects.get(run.projectId, ownerId ? { ownerId } : {});
  if (!project) return undefined;
  if (run.userId && project.ownerId && run.userId !== project.ownerId) return undefined;
  if (!admin && (project.ownerId !== ownerId || (run.userId && run.userId !== ownerId)))
    return undefined;
  return { run, project };
}
/** 对每次敏感命令写入脱敏审计，调用方明确区分申请与完成。 */
async function audit(
  store: AuthStore,
  actorId: string,
  ownerId: string | undefined,
  targetId: string,
  action: string,
  summary: string,
): Promise<void> {
  await store.appendAudit({
    id: randomUUID(),
    actorId,
    ownerId,
    targetId,
    action,
    summary,
    createdAt: new Date(),
  });
}
/** 支持单段 Range 的受控内容响应，供视频音频拖动与下载；非法范围返回 416。 */
function sendContent(reply: FastifyReply, request: FastifyRequest, content: Buffer): unknown {
  reply.header('accept-ranges', 'bytes');
  const range = request.headers.range;
  if (!range) return reply.header('content-length', content.length).send(content);
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]))
    return reply.code(416).header('content-range', `bytes */${content.length}`).send();
  const start = match[1] ? Number(match[1]) : Math.max(0, content.length - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= content.length
  )
    return reply.code(416).header('content-range', `bytes */${content.length}`).send();
  return reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${content.length}`)
    .header('content-length', end - start + 1)
    .send(content.subarray(start, end + 1));
}

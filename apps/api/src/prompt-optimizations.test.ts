import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockPromptOptimizationOutput,
  PROMPT_OPTIMIZATION_NODE_ID,
  PROMPT_SKILLS,
  type PromptDocument,
} from '@multimodal-canvas/domain';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService, type RunExecutorRequest } from './runs';
import { AiSettingsStore } from './settings';
import { MemoryPromptSkillStore } from './prompt-skill-store';

/** 所有请求使用隔离内存存储及合成模型，不访问外部服务。 */
const apps: Array<ReturnType<typeof buildApp>> = [];
/** 未保存节点可引用尚未上传的资源；优化模型只接收占位标记。 */
const input: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '保持人物造型，参考 ' },
    {
      type: 'mention',
      mentionId: 'ref-1',
      assetId: 'not-uploaded',
      assetVersion: 3,
      mediaType: 'image',
      label: '人物参考',
    },
    { type: 'text', text: ' 绘制近景。' },
  ],
};
/** 固定所有者身份用于鉴权边界测试。 */
const ownerId = '123e4567-e89b-42d3-a456-426614174001';
/** 构造仅供隔离测试的外部 JWT。 */
function authorization(userId: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 600 }),
  ).toString('base64url');
  const signature = createHmac('sha256', 'synthetic-optimization-secret')
    .update(`${header}.${body}`)
    .digest('base64url');
  return `Bearer ${header}.${body}.${signature}`;
}

/** 建立真实执行器替身或明确标记的 Mock 运行，并返回提交所需数据。 */
async function fixture(
  options: {
    output?: string;
    mock?: boolean;
    authenticated?: boolean;
    fetchImpl?: typeof fetch;
    stepDelayMs?: number;
  } = {},
) {
  if (options.authenticated) vi.stubEnv('API_JWT_SECRET', 'synthetic-optimization-secret');
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const settingsStore = new AiSettingsStore('prompt-optimization-tests');
  const promptSkillStore = new MemoryPromptSkillStore();
  settingsStore.update({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'synthetic-optimization-key',
  });
  settingsStore.replaceModels(
    ['alpha-text', 'beta-text'].map((id) => ({
      id,
      name: id,
      mediaTypes: ['text'],
      refreshedAt: new Date().toISOString(),
    })),
    settingsStore.getCredentialReference().credentialId,
  );
  const project = await projectStore.create({ name: 'Skill 优化' }, { ownerId });
  const executor = vi.fn(async (request: RunExecutorRequest) =>
    options.fetchImpl
      ? new NewApiProvider({
          baseUrl: 'https://provider.invalid/v1',
          apiKey: 'synthetic-optimization-key',
          fetchImpl: options.fetchImpl,
        }).execute(request)
      : {
          result: {
            provider: 'newapi',
            summary: '优化完成',
            targetNodeId: request.snapshot.targetNodeId,
            mediaType: 'text' as const,
            inputCount: 0,
          },
          output: {
            mediaType: 'text' as const,
            text:
              options.output ??
              createMockPromptOptimizationOutput(request.snapshot.promptOptimization!.input),
            mimeType: 'text/plain',
          },
        },
  );
  const runService = new MemoryRunService({
    providerName: options.mock ? 'mock' : 'newapi',
    stepDelayMs: options.stepDelayMs ?? 0,
  });
  const archiver = vi.fn(async () => undefined);
  const app = buildApp({
    logger: false,
    assetStore,
    projectStore,
    settingsStore,
    promptSkillStore,
    runService,
    ...(options.mock ? {} : { runExecutor: executor }),
    runResultArchiver: archiver,
    userExists: async () => true,
  });
  apps.push(app);
  const url = `/v1/projects/${project.id}/prompt-optimizations`;
  const payload = {
    nodeId: 'unsaved-node',
    skillId: PROMPT_SKILLS[0]!.id,
    mediaType: 'image',
    promptDocument: input,
    idempotencyKey: 'click-1',
  };
  const headers = options.authenticated ? { authorization: authorization(ownerId) } : {};
  return {
    app,
    assetStore,
    projectStore,
    settingsStore,
    promptSkillStore,
    project,
    runService,
    executor,
    archiver,
    url,
    payload,
    headers,
  };
}

/** 控制异步存储的完成时刻，避免并发回归依赖随机网络或固定睡眠。 */
function submissionGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', '');
  vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '');
  for (const mediaType of ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'])
    vi.stubEnv(`NEW_API_${mediaType}_MODEL`, '');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

describe('独立 Skill 提示词优化 API', () => {
  it('HTTP 启动冒烟：健康检查、用户 Skill 目录、Mock 提交及轮询可完成闭环', async () => {
    const ctx = await fixture({ mock: true });
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const health = await fetch(`${address}/health`);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    const catalog = await fetch(`${address}/v1/prompt-skills`);
    expect(catalog.status).toBe(200);
    const start = await fetch(`${address}${ctx.url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ctx.payload),
    });
    expect(start.status).toBe(202);
    const { optimization } = (await start.json()) as { optimization: { runId: string } };
    await vi.waitFor(async () => {
      const read = await fetch(`${address}${ctx.url}/${optimization.runId}`);
      expect(await read.json()).toMatchObject({
        optimization: { status: 'succeeded', simulated: true, promptDocument: input },
      });
    });
    expect(ctx.archiver).not.toHaveBeenCalled();
  });

  it('冻结自定义 Skill，修改、停用及删除后同键仍恢复原任务，明确版本冲突不执行', async () => {
    const ctx = await fixture({ authenticated: true });
    const skill = await ctx.promptSkillStore.create(ownerId, {
      name: '小说节奏',
      category: '小说创作',
      description: '调整节奏',
      instruction:
        'Refine the supplied novel writing prompt while preserving all explicit constraints.',
    });
    const payload = { ...ctx.payload, skillId: skill.id, skillVersion: skill.version };
    const first = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload,
      headers: ctx.headers,
    });
    expect(first.statusCode, first.body).toBe(202);
    const runId = first.json().optimization.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    expect((await ctx.runService.get(runId))?.snapshot.promptOptimization).toMatchObject({
      skillId: skill.id,
      skillVersion: skill.version,
      instruction: skill.instruction,
    });
    const updated = await ctx.promptSkillStore.update(ownerId, skill.id, {
      revision: skill.revision!,
      instruction: 'Refine a chapter outline.',
    });
    const stale = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { ...payload, idempotencyKey: 'new' },
      headers: ctx.headers,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('PROMPT_SKILL_VERSION_CONFLICT');
    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { ...payload, skillVersion: updated.version },
      headers: ctx.headers,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe('idempotency_conflict');
    const updatedReplay = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload,
      headers: ctx.headers,
    });
    expect(updatedReplay.statusCode, updatedReplay.body).toBe(202);
    expect(updatedReplay.json().optimization).toMatchObject({ runId, skillVersion: skill.version });
    const disabled = await ctx.promptSkillStore.update(ownerId, skill.id, {
      revision: updated.revision!,
      enabled: false,
    });
    expect(
      (await ctx.app.inject({ method: 'POST', url: ctx.url, payload, headers: ctx.headers })).json()
        .optimization.runId,
    ).toBe(runId);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: { ...payload, idempotencyKey: 'disabled' },
          headers: ctx.headers,
        })
      ).statusCode,
    ).toBe(400);
    await ctx.promptSkillStore.delete(ownerId, skill.id, disabled.revision!);
    const deletedReplay = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload,
      headers: ctx.headers,
    });
    expect(deletedReplay.statusCode, deletedReplay.body).toBe(202);
    expect(deletedReplay.json().optimization.runId).toBe(runId);
    expect(
      (
        await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}`, headers: ctx.headers })
      ).json().optimization.status,
    ).toBe('succeeded');
    expect(ctx.executor).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'disable', 'delete'] as const)(
    '同键请求等待创建期间 Skill %s 后恢复冻结任务，不返回可释放键的版本冲突',
    async (change) => {
      const ctx = await fixture({ authenticated: true });
      const skill = await ctx.promptSkillStore.create(ownerId, {
        name: '并发小说',
        category: '小说',
        description: '',
        instruction: 'Preserve the supplied story intent.',
      });
      const payload = { ...ctx.payload, skillId: skill.id, skillVersion: skill.version };
      const entered = submissionGate();
      const gate = submissionGate();
      const create = ctx.runService.create.bind(ctx.runService);
      vi.spyOn(ctx.runService, 'create').mockImplementationOnce(async (...args) => {
        entered.release();
        await gate.promise;
        return create(...args);
      });
      const projectReads = vi.spyOn(ctx.projectStore, 'get');
      const first = ctx.app
        .inject({ method: 'POST', url: ctx.url, payload, headers: ctx.headers })
        .then((response) => response);
      await entered.promise;
      if (change === 'delete') {
        await ctx.promptSkillStore.delete(ownerId, skill.id, skill.revision!);
      } else {
        await ctx.promptSkillStore.update(ownerId, skill.id, {
          revision: skill.revision!,
          ...(change === 'disable'
            ? { enabled: false }
            : { instruction: 'Preserve updated story intent.' }),
        });
      }
      const second = ctx.app
        .inject({ method: 'POST', url: ctx.url, payload, headers: ctx.headers })
        .then((response) => response);
      try {
        await vi.waitFor(() => expect(projectReads).toHaveBeenCalledTimes(2));
      } finally {
        gate.release();
      }
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
      const runId = responses[0]!.json().optimization.runId;
      expect(responses[1]!.json().optimization).toMatchObject({
        runId,
        skillVersion: skill.version,
      });
      const conflict = await ctx.app.inject({
        method: 'POST',
        url: ctx.url,
        headers: ctx.headers,
        payload: { ...payload, skillVersion: '1.0.1' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe('idempotency_conflict');
      await vi.waitFor(async () =>
        expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
      );
      expect(ctx.executor).toHaveBeenCalledTimes(1);
      expect(await ctx.runService.listByProject(ctx.project.id)).toHaveLength(1);
    },
  );

  it('同项目并发不同键不能突破配额，已有键可恢复，取消后释放额度', async () => {
    vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '1');
    const ctx = await fixture({ stepDelayMs: 60_000 });
    const gate = submissionGate();
    const getSkill = ctx.promptSkillStore.get.bind(ctx.promptSkillStore);
    vi.spyOn(ctx.promptSkillStore, 'get').mockImplementation(async (...args) => {
      await gate.promise;
      return getSkill(...args);
    });
    const projectReads = vi.spyOn(ctx.projectStore, 'get');
    const requests = Array.from({ length: 6 }, (_, index) =>
      ctx.app
        .inject({
          method: 'POST',
          url: ctx.url,
          payload: { ...ctx.payload, idempotencyKey: `concurrent-${index}` },
        })
        .then((response) => response),
    );
    try {
      await vi.waitFor(() => expect(projectReads).toHaveBeenCalledTimes(6));
    } finally {
      gate.release();
    }
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(5);
    expect(await ctx.runService.listByProject(ctx.project.id)).toHaveLength(1);
    const acceptedIndex = responses.findIndex((response) => response.statusCode === 202);
    const runId = responses[acceptedIndex]!.json().optimization.runId;
    const replay = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { ...ctx.payload, idempotencyKey: `concurrent-${acceptedIndex}` },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().optimization.runId).toBe(runId);
    await ctx.runService.cancel(runId);
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('cancelled'),
    );
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: { ...ctx.payload, idempotencyKey: 'after-cancel' },
        })
      ).statusCode,
    ).toBe(202);
    expect(ctx.executor).not.toHaveBeenCalled();
  });

  it('同项目存储失败不堵塞后续请求，不同项目不等待该项目的提交', async () => {
    const ctx = await fixture({ stepDelayMs: 60_000 });
    const otherProject = await ctx.projectStore.create({ name: '另一个优化项目' }, { ownerId });
    const gate = submissionGate();
    const entered = submissionGate();
    vi.spyOn(ctx.promptSkillStore, 'get').mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
      throw new Error('synthetic skill lookup failure');
    });
    const first = ctx.app
      .inject({ method: 'POST', url: ctx.url, payload: ctx.payload })
      .then((response) => response);
    await entered.promise;
    const second = ctx.app
      .inject({ method: 'POST', url: ctx.url, payload: ctx.payload })
      .then((response) => response);
    try {
      const other = await ctx.app.inject({
        method: 'POST',
        url: `/v1/projects/${otherProject.id}/prompt-optimizations`,
        payload: ctx.payload,
      });
      expect(other.statusCode).toBe(202);
    } finally {
      gate.release();
    }
    expect((await first).statusCode).toBe(503);
    expect((await second).statusCode).toBe(202);
    expect(await ctx.runService.listByProject(ctx.project.id)).toHaveLength(1);
  });

  it('queued 恢复使用原快照，补发失败返回 503，同键重试不重复执行', async () => {
    const ctx = await fixture({ authenticated: true, stepDelayMs: 60_000 });
    const originalCreate = ctx.runService.create.bind(ctx.runService);
    const create = vi.spyOn(ctx.runService, 'create').mockImplementationOnce(async (...args) => {
      await originalCreate(...args);
      throw new Error('synthetic publication failure after durable create');
    });
    const request = {
      method: 'POST' as const,
      url: ctx.url,
      payload: ctx.payload,
      headers: ctx.headers,
    };
    const started = await ctx.app.inject(request);
    expect(started.statusCode).toBe(503);
    const frozen = (await ctx.runService.listByProject(ctx.project.id))[0]!;
    const runId = frozen.id;
    expect(frozen.status).toBe('queued');
    expect(frozen.userId).toBe(ownerId);
    ctx.settingsStore.update({ defaultModels: { text: 'beta-text' } });
    vi.spyOn(ctx.promptSkillStore, 'get').mockRejectedValue(new Error('Skill store unavailable'));
    create.mockClear();
    create.mockRejectedValueOnce(new Error('synthetic queue publication failure'));
    const failed = await ctx.app.inject(request);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('synthetic');
    const restored = await ctx.app.inject(request);
    expect(restored.statusCode).toBe(202);
    expect(restored.json().optimization).toMatchObject({ runId, modelAlias: frozen.modelAlias });
    expect(create).toHaveBeenCalledTimes(2);
    for (const args of create.mock.calls)
      expect(args).toEqual([
        frozen.snapshot,
        { idempotencyKey: frozen.idempotencyKey, userId: frozen.userId },
      ]);
    expect(ctx.promptSkillStore.get).not.toHaveBeenCalled();
    expect(await ctx.runService.listByProject(ctx.project.id)).toHaveLength(1);
    expect(ctx.executor).not.toHaveBeenCalled();
    await ctx.runService.cancel(runId);
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('cancelled'),
    );
    const terminal = await ctx.app.inject(request);
    expect(terminal.json().optimization.status).toBe('cancelled');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('用户只能运行自己的自定义 Skill，服务令牌不能回退到本地 Skill 库', async () => {
    const ctx = await fixture({ authenticated: true });
    const otherSkill = await ctx.promptSkillStore.create('123e4567-e89b-42d3-a456-426614174002', {
      name: '私有',
      category: '小说',
      description: '',
      instruction: 'Private instruction.',
    });
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          headers: ctx.headers,
          payload: { ...ctx.payload, skillId: otherSkill.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(ctx.executor).not.toHaveBeenCalled();
    vi.stubEnv('API_AUTH_TOKEN', 'synthetic-service-token');
    const service = await fixture();
    const headers = { authorization: 'Bearer synthetic-service-token' };
    expect(
      (await service.app.inject({ method: 'GET', url: '/v1/prompt-skills', headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await service.app.inject({
          method: 'POST',
          url: service.url,
          headers,
          payload: service.payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(service.executor).not.toHaveBeenCalled();
  });

  it('接受未保存提示词，冻结文字默认及引用，既不读媒体也不改画布或归档资产', async () => {
    const ctx = await fixture();
    ctx.settingsStore.update({ defaultModels: { text: 'beta-text' } });
    const readContent = vi.spyOn(ctx.assetStore, 'getVersionContent');
    const before = await ctx.projectStore.getCanvas(ctx.project.id);
    const response = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().optimization.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    const read = await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().optimization).toMatchObject({
      nodeId: 'unsaved-node',
      skillId: ctx.payload.skillId,
      skillVersion: PROMPT_SKILLS[0]!.version,
      status: 'succeeded',
      modelAlias: 'beta-text',
    });
    expect(read.json().optimization.promptDocument.blocks).toContainEqual(input.blocks[1]);
    const request = ctx.executor.mock.calls[0]![0];
    expect(request.snapshot.promptOptimization).toMatchObject({
      nodeId: 'unsaved-node',
      skillId: ctx.payload.skillId,
      input,
    });
    expect(request.snapshot.targetNodeId).toBe(PROMPT_OPTIMIZATION_NODE_ID);
    expect(request.snapshot.credentialId).toBe(
      ctx.settingsStore.getCredentialReference().credentialId,
    );
    expect(request.snapshot.credentialVersion).toBeGreaterThan(0);
    expect(request.snapshot.inputs).toEqual([]);
    expect(request.snapshot.promptMentions ?? []).toEqual([]);
    expect(request.resolvedMentions).toBeUndefined();
    expect(JSON.stringify(request.snapshot.nodes)).not.toContain('not-uploaded');
    expect(request.snapshot.parameters).not.toHaveProperty('promptOptimization');
    expect(readContent).not.toHaveBeenCalled();
    expect(ctx.archiver).not.toHaveBeenCalled();
    expect((await ctx.runService.get(runId))?.result?.asset).toBeUndefined();
    expect(await ctx.projectStore.getCanvas(ctx.project.id)).toEqual(before);
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${ctx.project.id}/runs`,
    });
    expect(history.json().runs).toEqual([]);
    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${ctx.project.id}/export/workflow`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(runId);
  });

  it('并发相同幂等键只执行一次，默认变化及失败后的同键轮询不重新收费', async () => {
    const ctx = await fixture({ output: 'not JSON' });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(Array(6).fill(202));
    const runIds = new Set(responses.map((response) => response.json().optimization.runId));
    expect(runIds.size).toBe(1);
    const runId = responses[0]!.json().optimization.runId;
    await vi.waitFor(async () => expect((await ctx.runService.get(runId))?.status).toBe('failed'));
    ctx.settingsStore.update({ defaultModels: { text: 'beta-text' } });
    const repeated = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().optimization).toMatchObject({
      runId,
      status: 'failed',
      modelAlias: 'alpha-text',
    });
    expect(repeated.json().optimization).not.toHaveProperty('promptDocument');
    expect(ctx.executor).toHaveBeenCalledTimes(1);
    const retry = await ctx.app.inject({ method: 'POST', url: `/v1/runs/${runId}/retry` });
    expect(retry.statusCode).toBe(409);
    await expect(ctx.runService.retry(runId)).rejects.toThrow('提示词优化窗口');
  });

  it.each([
    { nodeId: 'other-node' },
    { skillId: 'camera' },
    { mediaType: 'video' },
    { promptDocument: { version: 1, blocks: [{ type: 'text', text: '另一个提示词' }] } },
    { modelAlias: 'beta-text' },
  ])('同键请求改变输入时拒绝冲突：%j', async (change) => {
    const ctx = await fixture();
    const first = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(first.statusCode).toBe(202);
    const conflicting = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { ...ctx.payload, ...change },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe('idempotency_conflict');
  });

  it('按项目鉴权，拒绝未登录、其他所有者、其他项目及普通 Run 的读取', async () => {
    const ctx = await fixture({ authenticated: true });
    expect(
      (await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload })).statusCode,
    ).toBe(401);
    const otherHeaders = { authorization: authorization('123e4567-e89b-42d3-a456-426614174002') };
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: ctx.payload,
          headers: otherHeaders,
        })
      ).statusCode,
    ).toBe(404);
    const first = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: ctx.payload,
      headers: ctx.headers,
    });
    expect(first.statusCode, first.body).toBe(202);
    const runId = first.json().optimization.runId;
    expect(
      (await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}`, headers: otherHeaders }))
        .statusCode,
    ).toBe(404);
    const other = await ctx.projectStore.create({ name: '另一个项目' }, { ownerId });
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/v1/projects/${other.id}/prompt-optimizations/${runId}`,
          headers: ctx.headers,
        })
      ).statusCode,
    ).toBe(404);
    const run = (await ctx.runService.get(runId))!;
    vi.spyOn(ctx.runService, 'get').mockResolvedValue({
      ...run,
      snapshot: { ...run.snapshot, promptOptimization: undefined },
    });
    expect(
      (await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}`, headers: ctx.headers }))
        .statusCode,
    ).toBe(404);
  });

  it('配额满时允许读取幂等任务，拒绝新优化；归档项目及非法输入不触发供应商', async () => {
    vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '1');
    const ctx = await fixture({ stepDelayMs: 1000 });
    const first = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(first.statusCode).toBe(202);
    expect(
      (await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload })).statusCode,
    ).toBe(202);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: { ...ctx.payload, idempotencyKey: 'second' },
        })
      ).statusCode,
    ).toBe(429);
    await ctx.runService.cancel(first.json().optimization.runId);
    for (const change of [
      { skillId: 'missing' },
      { idempotencyKey: '' },
      { promptDocument: { version: 1, blocks: [{ type: 'text', text: ' ' }] } },
      { promptDocument: { version: 1, blocks: [{ type: 'text', text: 'a'.repeat(20_000) }] } },
    ]) {
      expect(
        (
          await ctx.app.inject({
            method: 'POST',
            url: ctx.url,
            payload: { ...ctx.payload, idempotencyKey: 'invalid-input', ...change },
          })
        ).statusCode,
      ).toBe(400);
    }
    await ctx.projectStore.setArchived(ctx.project.id, true);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: { ...ctx.payload, idempotencyKey: 'new' },
        })
      ).statusCode,
    ).toBe(400);
    expect(ctx.executor).not.toHaveBeenCalled();
  });

  it('冻结独立 Key 默认，默认目录失效时不切换模型或凭据', async () => {
    const ctx = await fixture();
    const credentialId = ctx.settingsStore.update({
      baseUrl: 'https://other.invalid/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    }).createdCredentialId!;
    ctx.settingsStore.replaceModels(
      [
        {
          id: 'independent-text',
          name: '独立文字',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credentialId,
    );
    ctx.settingsStore.updateCredentialDefaults(credentialId, { text: 'independent-text' });
    const start = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(start.statusCode, start.body).toBe(202);
    expect(start.json().optimization).toMatchObject({
      modelAlias: 'independent-text',
    });
    expect(start.json().optimization).not.toHaveProperty('credentialId');
    const runId = start.json().optimization.runId;
    expect((await ctx.runService.get(runId))?.snapshot.credentialId).toBe(credentialId);
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    ctx.settingsStore.replaceModels([], credentialId);
    const failed = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { ...ctx.payload, idempotencyKey: 'new' },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().code).toBe('model_unavailable');
    expect(
      (await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload })).json()
        .optimization.runId,
    ).toBe(runId);
  });

  it.each(['not JSON', '{"prompt":"引用已丢失"}', '{"prompt":123}', '{"prompt":""}'])(
    '模型格式或引用损坏时失败且不归档：%s',
    async (output) => {
      const ctx = await fixture({ output });
      const start = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
      const runId = start.json().optimization.runId;
      await vi.waitFor(async () =>
        expect((await ctx.runService.get(runId))?.status).toBe('failed'),
      );
      const read = await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}` });
      expect(read.json().optimization).toMatchObject({
        status: 'failed',
        error: expect.any(String),
      });
      expect(read.json().optimization).not.toHaveProperty('promptDocument');
      expect(ctx.archiver).not.toHaveBeenCalled();
    },
  );

  it('供应商错误不通过优化结果泄漏 URL、凭据或原始模型内容', async () => {
    const ctx = await fixture();
    ctx.executor.mockRejectedValue(
      new Error(
        'provider https://private.invalid?secret=test returned Bearer synthetic-secret private-input',
      ),
    );
    const start = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    const runId = start.json().optimization.runId;
    await vi.waitFor(async () => expect((await ctx.runService.get(runId))?.status).toBe('failed'));
    const read = await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}` });
    expect(read.body).not.toMatch(/private-input|private.invalid|synthetic-secret/);
  });

  it('Mock 明确展示模拟优化并完整保留引用，不伪装真实模型结果', async () => {
    const ctx = await fixture({ mock: true });
    const start = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    expect(start.statusCode, start.body).toBe(202);
    const runId = start.json().optimization.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    const run = (await ctx.runService.get(runId))!;
    expect(run.result?.simulated).toBe(true);
    const read = await ctx.app.inject({ method: 'GET', url: `${ctx.url}/${runId}` });
    expect(read.json().optimization.simulated).toBe(true);
    expect(run.result?.promptOptimization?.promptDocument).toEqual(input);
    expect(run.result?.promptOptimization?.promptDocument.blocks).toContainEqual(input.blocks[1]);
    expect(ctx.archiver).not.toHaveBeenCalled();
  });

  it('真实 Provider 映射只发送英文规则、原文与占位符，并保留无资产绑定的请求记录', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: createMockPromptOptimizationOutput(input) } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const ctx = await fixture({ fetchImpl: fetcher });
    const start = await ctx.app.inject({ method: 'POST', url: ctx.url, payload: ctx.payload });
    const runId = start.json().optimization.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.model).toBe('alpha-text');
    expect(JSON.stringify(body)).toContain('Optimize the supplied prompt');
    expect(JSON.stringify(body)).toContain('保持人物造型');
    expect(JSON.stringify(body)).not.toMatch(/not-uploaded|image_url|data:image/);
    const records = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/request-prompts`,
    });
    expect(records.json().records).toHaveLength(1);
    expect(records.json().records[0]).not.toHaveProperty('assetId');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService, type RunExecutorRequest } from './runs';
import { AiSettingsStore } from './settings';

/** 每个用例使用隔离内存存储和合成 Provider，不发送外部请求。 */
const apps: Array<ReturnType<typeof buildApp>> = [];
const reverseResult = {
  summary: '白色背景中的红色立方体。',
  prompt: '在纯白背景中心放置一个红色立方体，柔和侧光、清晰边缘，正面构图。',
};

/** 创建带版本化图片和两个文字模型的隔离 API。 */
async function fixture(output = JSON.stringify(reverseResult), providerFetch?: typeof fetch) {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const settingsStore = new AiSettingsStore('reverse-prompt-tests');
  settingsStore.update({
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'synthetic-key-for-reverse-tests',
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
  const project = await projectStore.create({ name: '资源分析' });
  const asset = await assetStore.create({
    projectId: project.id,
    name: 'source.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: Buffer.from('version-one'),
  });
  const executor = vi.fn(async (request: RunExecutorRequest) =>
    providerFetch
      ? new NewApiProvider({
          baseUrl: 'https://provider.invalid/v1',
          apiKey: 'synthetic-key-for-reverse-tests',
          fetchImpl: providerFetch,
        }).execute(request)
      : {
          result: {
            provider: 'newapi',
            summary: 'analysis',
            targetNodeId: request.snapshot.targetNodeId,
            mediaType: 'text' as const,
            inputCount: 1,
          },
          output: { mediaType: 'text' as const, text: output, mimeType: 'text/plain' },
        },
  );
  const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 0 });
  const archiver = vi.fn(async () => undefined);
  const app = buildApp({
    logger: false,
    assetStore,
    projectStore,
    settingsStore,
    runService,
    runExecutor: executor,
    runResultArchiver: archiver,
  });
  apps.push(app);
  const url = `/v1/assets/${asset.id}/versions/1/reverse-prompts`;
  return {
    app,
    assetStore,
    projectStore,
    settingsStore,
    runService,
    executor,
    archiver,
    project,
    asset,
    url,
  };
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

describe('资源反推提示词 API', () => {
  it('选择文字默认模型并读取指定旧版本，独立保存结果而不归档或修改画布', async () => {
    const ctx = await fixture();
    ctx.settingsStore.update({ defaultModels: { text: 'beta-text' } });
    await ctx.assetStore.createVersion(ctx.asset.id, { content: Buffer.from('version-two') });
    const before = await ctx.projectStore.getCanvas(ctx.project.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, idempotencyKey: 'click-1' },
    });
    expect(response.statusCode, response.body).toBe(202);
    const runId = response.json().analysis.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    const read = await ctx.app.inject({
      method: 'GET',
      url: `${ctx.url}?projectId=${ctx.project.id}&runId=${runId}`,
    });
    expect(read.json().analysis).toMatchObject({
      status: 'succeeded',
      modelAlias: 'beta-text',
      assetId: ctx.asset.id,
      assetVersion: 1,
      ...reverseResult,
    });
    expect(ctx.executor).toHaveBeenCalledTimes(1);
    const request = ctx.executor.mock.calls[0]![0];
    expect(request.resolvedMentions?.[0]?.source).toMatchObject({
      dataUrl: `data:image/png;base64,${Buffer.from('version-one').toString('base64')}`,
    });
    expect(request.snapshot.reversePrompt).toEqual({
      assetId: ctx.asset.id,
      assetVersion: 1,
      automatic: false,
    });
    expect(request.snapshot.parameters).not.toHaveProperty('reversePrompt');
    expect(ctx.archiver).not.toHaveBeenCalled();
    expect((await ctx.runService.get(runId))?.result?.asset).toBeUndefined();
    expect(await ctx.projectStore.getCanvas(ctx.project.id)).toEqual(before);
    const canvasRuns = await ctx.app.inject({
      method: 'GET',
      url: `/v1/projects/${ctx.project.id}/runs`,
    });
    expect(canvasRuns.json().runs).toEqual([]);
    const original = await ctx.app.inject({
      method: 'GET',
      url: ctx.url.replace('reverse-prompts', 'request-prompts'),
    });
    expect(original.json().records).toEqual([]);
  });

  it('未设置默认时选择第一个文字模型，允许明确选择其它模型', async () => {
    const ctx = await fixture();
    const first = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(first.json().analysis.modelAlias).toBe(ctx.settingsStore.listModels('text')[0]?.id);
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(first.json().analysis.runId))?.status).toBe('succeeded'),
    );
    const second = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, modelAlias: 'beta-text' },
    });
    expect(second.json().analysis.modelAlias).toBe('beta-text');
    expect(second.json().analysis.runId).not.toBe(first.json().analysis.runId);
  });

  it('保留默认模型的独立凭据，默认失效时不自动切换模型或 Key', async () => {
    const ctx = await fixture();
    const added = ctx.settingsStore.update({
      baseUrl: 'https://other.invalid/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    });
    const credentialId = added.createdCredentialId!;
    ctx.settingsStore.replaceModels(
      [
        {
          id: 'independent-text',
          name: '独立',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credentialId,
    );
    ctx.settingsStore.update({
      defaultModels: { text: { modelAlias: 'independent-text', credentialId } },
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().analysis).toMatchObject({
      modelAlias: 'independent-text',
      credentialId,
    });
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(response.json().analysis.runId))?.status).toBe('succeeded'),
    );
    ctx.settingsStore.replaceModels([], credentialId);
    const failed = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().code).toBe('model_unavailable');
  });

  it('自动请求和重复手动点击按版本持久去重，失败也不自动重发', async () => {
    const ctx = await fixture('not JSON');
    const first = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, automatic: true },
    });
    const runId = first.json().analysis.runId;
    await vi.waitFor(async () => expect((await ctx.runService.get(runId))?.status).toBe('failed'));
    ctx.settingsStore.update({ defaultModels: { text: 'beta-text' } });
    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, automatic: true },
    });
    expect(duplicate.json().analysis).toMatchObject({
      runId,
      status: 'failed',
      modelAlias: 'alpha-text',
    });
    const manual = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, idempotencyKey: 'manual' },
    });
    const sameManual = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, idempotencyKey: 'manual' },
    });
    expect(sameManual.json().analysis.runId).toBe(manual.json().analysis.runId);
    expect((await ctx.runService.listByProject(ctx.project.id)).length).toBe(2);
    expect(first.json().analysis).not.toHaveProperty('prompt');
    expect(ctx.archiver).not.toHaveBeenCalled();
  });

  it('同版本自动请求并发只产生一次运行', async () => {
    const ctx = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        ctx.app.inject({
          method: 'POST',
          url: ctx.url,
          payload: { projectId: ctx.project.id, automatic: true },
        }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(new Set(responses.map((response) => response.json().analysis.runId)).size).toBe(1);
    await vi.waitFor(() => expect(ctx.executor).toHaveBeenCalledTimes(1));
  });

  it('拒绝其他项目资源、缺失版本和归档资源，在调用供应商前完成校验', async () => {
    const ctx = await fixture();
    const other = await ctx.projectStore.create({ name: '其它项目' });
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: other.id },
    });
    expect(forbidden.statusCode).toBe(404);
    const missing = await ctx.app.inject({
      method: 'POST',
      url: ctx.url.replace('/versions/1/', '/versions/99/'),
      payload: { projectId: ctx.project.id },
    });
    expect(missing.statusCode).toBe(404);
    await ctx.assetStore.setArchived(ctx.asset.id, true);
    const archived = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(archived.statusCode).toBe(400);
    expect(ctx.executor).not.toHaveBeenCalled();
  });

  it('复用资源大小与显式媒体能力限制', async () => {
    const ctx = await fixture();
    vi.stubEnv('RESOURCE_MENTION_MAX_BYTES', '3');
    const oversized = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().code).toBe('RESOURCE_MENTION_FREEZE_FAILED');
    vi.stubEnv('RESOURCE_MENTION_MAX_BYTES', '1048576');
    ctx.settingsStore.replaceModels(
      [
        {
          id: 'alpha-text',
          name: '文字',
          mediaTypes: ['text'],
          capabilities: { mentionMediaTypes: ['text'] },
          refreshedAt: new Date().toISOString(),
        },
      ],
      ctx.settingsStore.getCredentialReference().credentialId,
    );
    const unsupported = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().code).toBe('RESOURCE_MENTION_CAPABILITY_UNSUPPORTED');
    expect(ctx.executor).not.toHaveBeenCalled();
  });

  it('轮询精确运行身份，不能用其它资源的 runId 读取结果', async () => {
    const ctx = await fixture();
    const empty = await ctx.app.inject({
      method: 'GET',
      url: `${ctx.url}?projectId=${ctx.project.id}`,
    });
    expect(empty.json()).toMatchObject({
      analysis: null,
      defaultModel: { modelAlias: 'alpha-text' },
    });
    const started = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    await ctx.assetStore.createVersion(ctx.asset.id, { content: Buffer.from('new') });
    const mismatch = await ctx.app.inject({
      method: 'GET',
      url: `${ctx.url.replace('/versions/1/', '/versions/2/')}?projectId=${ctx.project.id}&runId=${started.json().analysis.runId}`,
    });
    expect(mismatch.statusCode).toBe(404);
  });

  it('复用尚在执行的手动分析，禁止使用通用 retry 接口重新收费', async () => {
    const ctx = await fixture('invalid JSON');
    const first = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, idempotencyKey: 'click-one' },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id, idempotencyKey: 'click-two' },
    });
    const runId = first.json().analysis.runId;
    expect(second.json().analysis.runId).toBe(runId);
    await vi.waitFor(async () => expect((await ctx.runService.get(runId))?.status).toBe('failed'));
    const retry = await ctx.app.inject({ method: 'POST', url: `/v1/runs/${runId}/retry` });
    expect(retry.statusCode).toBe(409);
    await expect(ctx.runService.retry(runId)).rejects.toThrow('反推提示词窗口');
    expect(ctx.executor).toHaveBeenCalledTimes(1);
  });

  it('真实 Provider 映射发送图片字节与英文分析指令，保留分析请求记录但不绑定原图', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(reverseResult) } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const ctx = await fixture(undefined, fetcher);
    const start = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(start.statusCode, start.body).toBe(202);
    const runId = start.json().analysis.runId;
    await vi.waitFor(async () =>
      expect((await ctx.runService.get(runId))?.status).toBe('succeeded'),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://provider.invalid/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const payload = JSON.parse(String(init?.body));
    expect(payload.model).toBe('alpha-text');
    expect(payload.messages[0].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('untrusted data') }),
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from('version-one').toString('base64')}`,
          },
        },
      ]),
    );
    const prompts = await ctx.app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}/request-prompts`,
    });
    expect(prompts.json().records).toHaveLength(1);
    expect(prompts.json().records[0]).not.toHaveProperty('assetId');
    const original = await ctx.app.inject({
      method: 'GET',
      url: ctx.url.replace('reverse-prompts', 'request-prompts'),
    });
    expect(original.json().records).toEqual([]);
  });

  it('GET 只返回安全默认模型身份，并可继承独立 Key 的文字类型默认', async () => {
    const ctx = await fixture();
    const added = ctx.settingsStore.update({
      baseUrl: 'https://other.invalid/v1',
      apiKey: 'synthetic-independent-key',
      activate: false,
    });
    const credentialId = added.createdCredentialId!;
    ctx.settingsStore.replaceModels(
      [
        {
          id: 'bound-text',
          name: '独立文字',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credentialId,
    );
    ctx.settingsStore.updateCredentialDefaults(credentialId, { text: 'bound-text' });
    const read = await ctx.app.inject({
      method: 'GET',
      url: `${ctx.url}?projectId=${ctx.project.id}`,
    });
    expect(read.json()).toEqual({
      analysis: null,
      defaultModel: { modelAlias: 'bound-text', credentialId },
    });
    const start = await ctx.app.inject({
      method: 'POST',
      url: ctx.url,
      payload: { projectId: ctx.project.id },
    });
    expect(start.json().analysis).toMatchObject(read.json().defaultModel);
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type BillingQuote } from '@prisma/client';
import {
  BillingError,
  billingSnapshotHash,
  type NewApiEstimate,
  type PrismaBillingService,
  type QuoteItemInput,
} from '@multimodal-canvas/billing';
import {
  PROMPT_SKILLS,
  type BillingPriceRule,
  type MarketplacePriceRule,
  type CanvasNode,
  type MediaType,
  type RunRecord,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { AuthService } from './auth-service';
import { MemoryAuthStore } from './auth-store';
import { MemoryProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';
import { AiSettingsStore } from './settings';
import {
  ModelMarketplaceError,
  type ModelMarketplace,
  type ResolvedMarketplaceModel,
} from './model-marketplace';
import {
  createRunQuoteItems,
  freezeRunBillingModels,
  prepareBillingSubmission,
} from './billing-submission';

/** 测试仅使用本机内存与合成身份，所有生成调用由返回排队记录的替身截断。 */
const apps: Array<ReturnType<typeof buildApp>> = [];
/** 显式发布的按次价格，最小 nanos 也不能四舍五入到分。 */
const fixedPrice: BillingPriceRule = {
  unit: 'per_call',
  meteringSource: 'fixed',
  unitPriceNanos: '7',
  minQuantity: 1,
  maxQuantity: 1,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** 生成完整平台版本记录，避免测试把候选模型名称误当商品身份。 */
function resolvedModel(
  mediaType: MediaType = 'text',
  rule: MarketplacePriceRule = fixedPrice,
): ResolvedMarketplaceModel {
  const now = new Date();
  const modelId = randomUUID();
  const bindingId = randomUUID();
  const pricingId = randomUUID();
  const actor = randomUUID();
  return {
    model: {
      id: modelId,
      name: '人工商品',
      description: '',
      mediaType: mediaType.toUpperCase() as ResolvedMarketplaceModel['model']['mediaType'],
      specifications: {},
      status: 'published',
      sortOrder: 0,
      sourceSyncId: null,
      sourceModelId: null,
      activeBindingId: bindingId,
      activePricingVersionId: pricingId,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    },
    binding: {
      id: bindingId,
      platformModelId: modelId,
      revision: 1,
      credentialId: randomUUID(),
      credentialVersion: 1,
      upstreamModelId: 'manual-exact-model（按次）',
      contract:
        mediaType === 'audio'
          ? 'openai-audio'
          : mediaType === 'video'
            ? 'newapi-video-v1'
            : mediaType === 'image'
              ? 'openai-images'
              : 'openai-chat-completions',
      capabilities: { mentionMediaTypes: ['text', 'image'] },
      limitations: {},
      verificationEvidence: 'isolated test',
      verifiedAt: now,
      createdBy: actor,
      createdAt: now,
    },
    pricing: {
      id: pricingId,
      platformModelId: modelId,
      revision: 1,
      currency: 'CNY',
      rule,
      effectiveAt: now,
      createdBy: actor,
      createdAt: now,
    },
  };
}

/** 创建一个可执行节点；字段可逐测试覆盖。 */
function nodeFor(model: ResolvedMarketplaceModel, id = 'target'): CanvasNode {
  const mediaType = model.model.mediaType.toLowerCase() as MediaType;
  return {
    id,
    type: mediaType,
    position: { x: 0, y: 0 },
    data: {
      label: '测试节点',
      mediaType,
      mode: 'generate',
      platformModelId: model.model.id,
      prompt: 'English test prompt',
    },
  };
}

/** 仅验证 API 调用边界；原子冻结、数据库锁及 outbox 由账务集成测试覆盖。 */
async function fixture() {
  vi.stubEnv('API_JWT_SECRET', 'synthetic-billing-api-secret');
  vi.stubEnv('API_AUTH_TOKEN', 'synthetic-service-token');
  vi.stubEnv('RUN_MAX_ACTIVE_PER_PROJECT', '');
  const authStore = new MemoryAuthStore();
  const auth = new AuthService({ store: authStore, jwtSecret: process.env.API_JWT_SECRET! });
  const user = await authStore.createUser({
    email: `${randomUUID()}@example.invalid`,
    passwordHash: 'test-only-password-hash',
  });
  const token = await auth.issueToken(user);
  const headers = { authorization: `Bearer ${token.accessToken}` };
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: '报价测试' }, { ownerId: user.id });
  const model = resolvedModel();
  const canvas = await projectStore.updateCanvas(
    project.id,
    { revision: 0, nodes: [nodeFor(model)], edges: [] },
    { ownerId: user.id },
  );
  const settingsStore = new AiSettingsStore('billing-api-test');
  const catalog = vi.spyOn(settingsStore, 'listModels');
  const marketplace = {
    resolvePublishedModel: vi.fn(async () => model),
    resolveLegacyModel: vi.fn(async () => model),
  } as unknown as ModelMarketplace;
  const quotes = new Map<string, BillingQuote>();
  const createQuote = vi.fn(
    async (input: {
      payerId: string;
      snapshot: RunSnapshot;
      items: QuoteItemInput[];
      expiresAt?: Date;
    }) => {
      const quote: BillingQuote = {
        id: randomUUID(),
        payerId: input.payerId,
        requestHash: billingSnapshotHash(input.snapshot),
        snapshot: input.snapshot as unknown as Prisma.JsonValue,
        items: input.items as unknown as Prisma.JsonValue,
        maximumNanos: new Prisma.Decimal(
          input.items.reduce((sum, item) => sum + BigInt(item.maximumNanos), 0n).toString(),
        ),
        expiresAt: input.expiresAt ?? new Date(Date.now() + 300_000),
        consumedRunId: null,
        createdAt: new Date(),
      };
      quotes.set(quote.id, quote);
      return quote;
    },
  );
  const billing = {
    createQuote,
    prisma: {
      billingQuote: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; payerId: string } }) => {
          const quote = quotes.get(where.id);
          return quote?.payerId === where.payerId ? quote : null;
        }),
      },
    },
  } as unknown as PrismaBillingService;
  const runService = new MemoryRunService();
  const runs: RunRecord[] = [];
  const create = vi.spyOn(runService, 'create').mockImplementation(async (snapshot, options) => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'queued',
      progress: 0,
      attempt: 1,
      provider: 'mock',
      modelAlias: snapshot.modelAlias,
      snapshot,
      createdAt: now,
      updatedAt: now,
      userId: options?.userId,
      idempotencyKey: options?.idempotencyKey,
    };
    runs.push(run);
    return run;
  });
  vi.spyOn(runService, 'listByProject').mockImplementation(async (id) =>
    runs.filter((run) => run.projectId === id),
  );
  vi.spyOn(runService, 'get').mockImplementation(async (id) => runs.find((run) => run.id === id));
  const assetStore = new MemoryAssetStore();
  const app = buildApp({
    logger: false,
    authStore,
    authService: auth,
    projectStore,
    assetStore,
    settingsStore,
    runService,
    billing,
    marketplace,
  });
  apps.push(app);
  return {
    app,
    user,
    auth,
    authStore,
    headers,
    project,
    canvas,
    projectStore,
    settingsStore,
    model,
    marketplace,
    billing,
    createQuote,
    quotes,
    create,
    runs,
    runService,
    assetStore,
    catalog,
    path: '/v1/nodes/target/runs',
    body: { projectId: project.id, platformModelId: model.model.id },
  };
}

describe('平台报价与执行边界', () => {
  it('手工平台模型无需上游目录即可报价，报价不执行且公开响应不泄露绑定', async () => {
    const ctx = await fixture();
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quote: {
        currency: 'CNY',
        capNanos: '7',
        items: [{ platformModelId: ctx.model.model.id, modelName: '人工商品', capNanos: '7' }],
      },
    });
    expect(response.body).not.toContain(ctx.model.binding.credentialId);
    expect(response.body).not.toContain(ctx.model.binding.upstreamModelId);
    expect(ctx.catalog).not.toHaveBeenCalled();
    expect(ctx.create).not.toHaveBeenCalled();
    const snapshot = ctx.createQuote.mock.calls[0]![0].snapshot;
    expect(snapshot.billingBindings?.target).toMatchObject({
      bindingId: ctx.model.binding.id,
      pricingVersionId: ctx.model.pricing.id,
    });
    expect(snapshot.modelAlias).toBe(ctx.model.binding.upstreamModelId);
    expect(snapshot.nodes[0]!.data.platformModelId).toBe(ctx.model.model.id);
  });

  it('缺少确认、过期、其他付款人与变更参数均不创建任务', async () => {
    const ctx = await fixture();
    const missing = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: ctx.body,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe('quote_required');
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    const quoteId = response.json().quote.id as string;
    const changed = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId, parameters: { temperature: 0.2 } },
    });
    expect(changed.json().code).toBe('quote_changed');
    const quote = ctx.quotes.get(quoteId)!;
    quote.expiresAt = new Date(Date.now() - 1);
    const expired = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId },
    });
    expect(expired.json().code).toBe('quote_expired');
    quote.payerId = randomUUID();
    const another = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId },
    });
    expect(another.statusCode).toBe(404);
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('确认报价传递冻结身份；发布新价格或切换 API 要求重新确认', async () => {
    const ctx = await fixture();
    const quoted = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    const quoteId = quoted.json().quote.id as string;
    const priceId = ctx.model.pricing.id;
    ctx.model.pricing.id = randomUUID();
    const changedPrice = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId },
    });
    expect(changedPrice.json().code).toBe('quote_changed');
    ctx.model.pricing.id = priceId;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId },
    });
    expect(accepted.statusCode).toBe(202);
    expect(ctx.create).toHaveBeenCalledWith(
      expect.objectContaining({ modelAlias: ctx.model.binding.upstreamModelId }),
      expect.objectContaining({ quoteId, userId: ctx.user.id }),
    );
    ctx.model.binding.id = randomUUID();
    ctx.model.binding.credentialVersion = 2;
    const changedBinding = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId },
    });
    expect(changedBinding.json().code).toBe('quote_changed');
    expect(ctx.create).toHaveBeenCalledTimes(1);
  });

  it('服务 token 无法报价或计费，通用报价拒绝任意转发并复用冻结预检', async () => {
    const ctx = await fixture();
    for (const path of [
      ctx.path,
      '/v1/runs/unknown/retry',
      `/v1/projects/${ctx.project.id}/prompt-optimizations`,
      '/v1/assets/source/versions/1/reverse-prompts',
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: 'Bearer synthetic-service-token' },
        payload: { quoteOnly: true },
      });
      expect(response.statusCode).toBe(401);
    }
    const invalid = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/quotes',
      headers: ctx.headers,
      payload: { path: '/v1/admin/wallets/user/adjustments', body: {} },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await ctx.app.inject({
      method: 'POST',
      url: '/v1/billing/quotes',
      headers: ctx.headers,
      payload: { path: ctx.path, body: ctx.body },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().quote.capNanos).toBe('7');
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('反推与 Skill 优化经过相同报价确认且平台 ID 不触发候选查询', async () => {
    const ctx = await fixture();
    const asset = await ctx.assetStore.create({
      projectId: ctx.project.id,
      ownerId: ctx.user.id,
      name: 'source.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('synthetic source'),
    });
    const requests = [
      {
        path: `/v1/assets/${asset.id}/versions/1/reverse-prompts`,
        body: { ...ctx.body, idempotencyKey: 'reverse-one' },
      },
      {
        path: `/v1/projects/${ctx.project.id}/prompt-optimizations`,
        body: {
          nodeId: 'target',
          platformModelId: ctx.model.model.id,
          skillId: PROMPT_SKILLS[0]!.id,
          mediaType: 'image',
          promptDocument: { version: 1, blocks: [{ type: 'text', text: 'English draft' }] },
          idempotencyKey: 'optimization-one',
        },
      },
    ];
    for (const entry of requests) {
      const quoted = await ctx.app.inject({
        method: 'POST',
        url: entry.path,
        headers: ctx.headers,
        payload: { ...entry.body, quoteOnly: true },
      });
      expect(quoted.statusCode, quoted.body).toBe(200);
      const accepted = await ctx.app.inject({
        method: 'POST',
        url: entry.path,
        headers: ctx.headers,
        payload: { ...entry.body, quoteId: quoted.json().quote.id },
      });
      expect(accepted.statusCode, accepted.body).toBe(202);
    }
    expect(ctx.create).toHaveBeenCalledTimes(2);
    expect(ctx.catalog).not.toHaveBeenCalled();
  });

  it('工作流对每个真实生成节点逐项报价，来源节点不收费', async () => {
    const ctx = await fixture();
    await ctx.projectStore.updateCanvas(
      ctx.project.id,
      {
        revision: ctx.canvas.revision,
        nodes: [
          {
            ...nodeFor(ctx.model, 'source'),
            data: { label: 'source', mediaType: 'text', mode: 'source', prompt: 'frozen source' },
          },
          nodeFor(ctx.model, 'upstream'),
          nodeFor(ctx.model),
        ],
        edges: [
          {
            id: 'source-upstream',
            sourceNodeId: 'source',
            sourceHandle: 'output:text',
            targetNodeId: 'upstream',
            targetHandle: 'input:prompt',
            order: 0,
          },
          {
            id: 'upstream-target',
            sourceNodeId: 'upstream',
            sourceHandle: 'output:text',
            targetNodeId: 'target',
            targetHandle: 'input:prompt',
            order: 0,
          },
        ],
      },
      { ownerId: ctx.user.id },
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().quote.capNanos).toBe('14');
    expect(response.json().quote.items.map((item: { nodeId: string }) => item.nodeId)).toEqual([
      'upstream',
      'target',
    ]);
  });

  it('旧模型名不能绕过发布解析，重复名称明确拒绝', async () => {
    const ctx = await fixture();
    await ctx.projectStore.updateCanvas(
      ctx.project.id,
      {
        revision: ctx.canvas.revision,
        nodes: [
          {
            ...nodeFor(ctx.model),
            data: {
              label: 'legacy',
              mediaType: 'text',
              mode: 'generate',
              modelAlias: 'shared-name',
            },
          },
        ],
        edges: [],
      },
      { ownerId: ctx.user.id },
    );
    vi.mocked(ctx.marketplace.resolveLegacyModel).mockRejectedValue(
      new ModelMarketplaceError('model_ambiguous', '存在多个已发布模型', 409),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { projectId: ctx.project.id, quoteOnly: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('model_ambiguous');
    expect(ctx.catalog).not.toHaveBeenCalled();
    expect(ctx.createQuote).not.toHaveBeenCalled();
  });

  it('切换 API 后旧画布保留平台身份，并忽略已废弃的名称与连接提示', async () => {
    const ctx = await fixture();
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: {
        projectId: ctx.project.id,
        modelAlias: 'retired-upstream-alias',
        credentialId: randomUUID(),
        quoteOnly: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(ctx.marketplace.resolvePublishedModel).toHaveBeenCalledWith(ctx.model.model.id);
    expect(ctx.marketplace.resolveLegacyModel).not.toHaveBeenCalled();
    expect(ctx.createQuote.mock.calls[0]![0].snapshot.credentialId).toBe(
      ctx.model.binding.credentialId,
    );
  });

  it('显式重试重新报价当前绑定，确认后只向 Run 服务传递该报价', async () => {
    const ctx = await fixture();
    const quoted = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteId: quoted.json().quote.id },
    });
    const previous = ctx.runs[0]!;
    previous.status = 'failed';
    ctx.model.binding.id = randomUUID();
    ctx.model.binding.credentialVersion = 2;
    ctx.model.binding.upstreamModelId = 'new-exact-model';
    const retry = vi
      .spyOn(ctx.runService, 'retry')
      .mockResolvedValue({ ...previous, id: `run_${randomUUID()}`, status: 'queued', attempt: 2 });
    const path = `/v1/runs/${previous.id}/retry`;
    const requoted = await ctx.app.inject({
      method: 'POST',
      url: path,
      headers: ctx.headers,
      payload: { quoteOnly: true },
    });
    expect(requoted.statusCode, requoted.body).toBe(200);
    expect(ctx.createQuote.mock.calls[1]![0].snapshot).toMatchObject({
      modelAlias: 'new-exact-model',
      credentialVersion: 2,
    });
    expect(retry).not.toHaveBeenCalled();
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: path,
      headers: ctx.headers,
      payload: { quoteId: requoted.json().quote.id },
    });
    expect(accepted.statusCode).toBe(202);
    expect(retry).toHaveBeenCalledWith(previous.id, {
      quoteId: requoted.json().quote.id,
      userId: ctx.user.id,
    });
  });

  it('运行服务的财务拒绝保留业务状态，不变成通用服务不可用', async () => {
    const ctx = await fixture();
    const path = `/v1/projects/${ctx.project.id}/prompt-optimizations`;
    const body = {
      nodeId: 'target',
      platformModelId: ctx.model.model.id,
      skillId: PROMPT_SKILLS[0]!.id,
      mediaType: 'image',
      promptDocument: { version: 1, blocks: [{ type: 'text', text: 'English draft' }] },
      idempotencyKey: 'insufficient-one',
    };
    const quoted = await ctx.app.inject({
      method: 'POST',
      url: path,
      headers: ctx.headers,
      payload: { ...body, quoteOnly: true },
    });
    ctx.create.mockRejectedValueOnce(new BillingError('insufficient_balance', '可用余额不足', 402));
    const response = await ctx.app.inject({
      method: 'POST',
      url: path,
      headers: ctx.headers,
      payload: { ...body, quoteId: quoted.json().quote.id },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ code: 'insufficient_balance' });
  });
});

describe('可信报价计量', () => {
  it('语音字符按实际冻结文档的 Unicode 码点计数，不能使用浏览器自报字符数', () => {
    const model = resolvedModel('audio', {
      unit: 'per_character',
      meteringSource: 'input_characters',
      unitPriceNanos: '3',
      maxCharacters: 4096,
      minQuantity: 1,
      maxQuantity: 1,
    });
    const node = nodeFor(model);
    node.data.promptDocument = { version: 1, blocks: [{ type: 'text', text: ' 你😀 ' }] };
    const snapshot = freezeRunBillingModels(
      createRunSnapshot('project-test', { revision: 0, nodes: [node], edges: [] }, node.id, {
        parameters: { input: 'ignored', characters: 1 },
      }),
      { [node.id]: model },
    );
    const [item] = createRunQuoteItems(snapshot, { [node.id]: model });
    expect(item!.maximumNanos).toBe('12');
    expect(item!.quoteInput).toMatchObject({ characters: 4 });
  });

  it('Token 未可靠计量和动态字符输入都拒绝提前报价', () => {
    const model = resolvedModel('text', {
      unit: 'per_token',
      meteringSource: 'provider_usage',
      inputPriceNanos: '1',
      outputPriceNanos: '2',
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      minQuantity: 1,
      maxQuantity: 1,
    });
    const node = nodeFor(model);
    const snapshot = freezeRunBillingModels(
      createRunSnapshot('project-test', { revision: 0, nodes: [node], edges: [] }, node.id, {
        parameters: { inputTokensVerified: true, inputTokens: 1 },
      }),
      { [node.id]: model },
    );
    expect(() => createRunQuoteItems(snapshot, { [node.id]: model })).toThrowError(
      expect.objectContaining({ code: 'metering_unavailable' }),
    );
    const audio = resolvedModel('audio', {
      unit: 'per_character',
      meteringSource: 'input_characters',
      unitPriceNanos: '1',
      maxCharacters: 4096,
      minQuantity: 1,
      maxQuantity: 1,
    });
    const audioNode = nodeFor(audio);
    const upstream = {
      ...nodeFor(model, 'source'),
      data: {
        label: 'source',
        mediaType: 'text' as const,
        mode: 'source' as const,
        prompt: 'source',
      },
    };
    const audioSnapshot = freezeRunBillingModels(
      createRunSnapshot(
        'project-test',
        {
          revision: 0,
          nodes: [upstream, audioNode],
          edges: [
            {
              id: 'edge',
              sourceNodeId: 'source',
              sourceHandle: 'output:text',
              targetNodeId: 'target',
              targetHandle: 'input:content',
              order: 0,
            },
          ],
        },
        'target',
      ),
      { target: audio },
    );
    expect(() => createRunQuoteItems(audioSnapshot, { target: audio })).toThrowError(
      expect.objectContaining({ code: 'metering_unavailable' }),
    );
  });

  it('秒数缺省或冲突与多结果请求都不能低估授权上限', () => {
    const model = resolvedModel('video', {
      unit: 'per_second',
      meteringSource: 'output_metadata',
      unitPriceNanos: '5',
      maxDurationSeconds: '60',
      durationRounding: 'exact',
      minQuantity: 1,
      maxQuantity: 1,
    });
    const node = nodeFor(model);
    for (const parameters of [
      {},
      { seconds: '8', duration: 4 },
      { duration: -1 },
      { duration: 4, n: 2 },
    ]) {
      const snapshot = freezeRunBillingModels(
        createRunSnapshot('project-test', { revision: 0, nodes: [node], edges: [] }, node.id, {
          parameters,
        }),
        { target: model },
      );
      expect(() => createRunQuoteItems(snapshot, { target: model })).toThrow(BillingError);
    }
    const snapshot = freezeRunBillingModels(
      createRunSnapshot('project-test', { revision: 0, nodes: [node], edges: [] }, node.id, {
        parameters: { duration: 4 },
      }),
      { target: model },
    );
    expect(createRunQuoteItems(snapshot, { target: model })[0]!.maximumNanos).toBe('20');
  });
});

/** 托管模型只冻结上游估算预算；精确绑定和凭据由现有快照机制负责。 */
async function managedSubmissionFixture(
  mediaType: MediaType = 'text',
  parameters: Record<string, unknown> = {},
) {
  const ctx = await fixture();
  const model = resolvedModel(mediaType, {
    unit: 'upstream_cost',
    meteringSource: 'newapi_receipt',
  });
  const node = nodeFor(model);
  const models = { target: model };
  const snapshot = freezeRunBillingModels(
    createRunSnapshot(ctx.project.id, { revision: 0, nodes: [node], edges: [] }, node.id, {
      parameters,
    }),
    models,
  );
  const credentials = {
    baseUrl: 'https://original.example.invalid/v1',
    apiKey: 'synthetic-original-key',
  };
  const settings = { getProviderCredentials: vi.fn(async () => credentials) };
  const estimated: NewApiEstimate = {
    version: 1,
    model: model.binding.upstreamModelId,
    group: 'original-group',
    pricing_version: 'price-at-estimate',
    estimated_quota: '3',
    quota_per_unit: '500000',
    usd_to_cny: '7.1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    estimate_only: true,
  };
  const estimate = vi.fn(async () => estimated);
  const session = await ctx.auth.verifyAccessToken(
    ctx.headers.authorization.replace('Bearer ', ''),
  );
  return {
    ...ctx,
    model,
    node,
    models,
    snapshot,
    settings,
    estimate,
    estimated,
    credentials,
    session,
  };
}

describe('New API 托管报价', () => {
  it('使用冻结 Key 估算精确模型，公开预算隐藏上游细节且到期不晚于预估', async () => {
    const ctx = await managedSubmissionFixture('text', {
      max_tokens: 200,
      inferenceStrength: 'high',
      asset_url: 'https://not-forwarded.invalid',
    });
    const quote = await prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } });
    expect(ctx.settings.getProviderCredentials).toHaveBeenCalledWith({
      credentialId: ctx.model.binding.credentialId,
      credentialVersion: 1,
    });
    expect(ctx.estimate).toHaveBeenCalledWith(ctx.credentials, {
      model: ctx.model.binding.upstreamModelId,
      contract: 'openai-chat-completions',
      parameters: { max_tokens: 200, reasoning_effort: 'high' },
      input_text: 'English test prompt',
      input_pending: false,
    });
    expect(quote).toMatchObject({
      currency: 'CNY',
      capNanos: '42600',
      expiresAt: ctx.estimated.expires_at,
      items: [{ unit: 'upstream_cost', quantity: 1, capNanos: '42600' }],
    });
    expect(ctx.createQuote.mock.calls[0]?.[0].items[0]?.quoteInput).toMatchObject({
      version: 2,
      capNanos: '42600',
      estimate: ctx.estimated,
    });
    expect(JSON.stringify(quote)).not.toContain(ctx.model.binding.upstreamModelId);
    expect(JSON.stringify(quote)).not.toContain(ctx.credentials.apiKey);
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('用户确认时复用已存预算，不读取当前 Key、不重新请求估算或执行价格锁定', async () => {
    const ctx = await managedSubmissionFixture();
    const quote = await prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } });
    ctx.estimate.mockRejectedValue(new Error('must not reprice'));
    ctx.settings.getProviderCredentials.mockRejectedValue(new Error('must not use current key'));
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteId: quote!.id } }),
    ).resolves.toBeUndefined();
    expect(ctx.estimate).toHaveBeenCalledTimes(1);
    expect(ctx.settings.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it('凭据版本与快照不符时拒绝估算，不能改用当前活动 Key', async () => {
    const ctx = await managedSubmissionFixture();
    ctx.snapshot.nodeCredentialReferences!.target!.credentialVersion = 2;
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } }),
    ).rejects.toMatchObject({ code: 'invalid_charge_plan' });
    expect(ctx.settings.getProviderCredentials).not.toHaveBeenCalled();
    expect(ctx.estimate).not.toHaveBeenCalled();
  });

  it('上游明确返回免费预算时允许零值，缺失换算配置则拒绝并且不补价', async () => {
    const ctx = await managedSubmissionFixture('text', { n: 1 });
    ctx.estimate.mockResolvedValue({ ...ctx.estimated, estimated_quota: '0' });
    expect(await prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } })).toMatchObject({
      capNanos: '0',
    });
    expect(ctx.estimate).toHaveBeenCalledWith(
      ctx.credentials,
      expect.objectContaining({ parameters: {} }),
    );
    ctx.estimate.mockResolvedValue({
      ...ctx.estimated,
      usd_to_cny: undefined,
    } as unknown as NewApiEstimate);
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } }),
    ).rejects.toMatchObject({ code: 'newapi_estimate_unavailable' });
    expect(ctx.createQuote).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'image',
      { resolution: '1024x1024', imageQuality: 'high', aspectRatio: '1:1' },
      { size: '1024x1024', quality: 'high', aspect_ratio: '1:1' },
    ],
    [
      'video',
      { duration: 8, seconds: 4, videoResolution: '720p', aspectRatio: '16:9' },
      { seconds: 8, resolution: '720p', aspect_ratio: '16:9' },
    ],
    [
      'audio',
      { input: 'Speech input', voice: 'alloy', speed: 1.2, inferenceStrength: 'high' },
      { voice: 'alloy', speed: 1.2 },
    ],
  ] as const)('按 %s Provider 字段优先级发送预估规格', async (mediaType, parameters, expected) => {
    const ctx = await managedSubmissionFixture(mediaType, parameters);
    await prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } });
    expect(ctx.estimate).toHaveBeenCalledWith(
      ctx.credentials,
      expect.objectContaining({ parameters: expected }),
    );
  });

  it('混合 DAG 保留人工规则与托管预算，待生成输入仅标记不完整', async () => {
    const ctx = await managedSubmissionFixture();
    const manual = resolvedModel();
    const upstream = nodeFor(manual, 'upstream');
    const models = { ...ctx.models, upstream: manual };
    const snapshot = freezeRunBillingModels(
      createRunSnapshot(
        ctx.project.id,
        {
          revision: 0,
          nodes: [upstream, ctx.node],
          edges: [
            {
              id: 'edge',
              sourceNodeId: 'upstream',
              sourceHandle: 'output:text',
              targetNodeId: 'target',
              targetHandle: 'input:prompt',
              order: 0,
            },
          ],
        },
        'target',
      ),
      models,
    );
    const quote = await prepareBillingSubmission({
      ...ctx,
      snapshot,
      models,
      fields: { quoteOnly: true },
    });
    expect(quote).toMatchObject({
      capNanos: '42607',
      items: [
        { nodeId: 'upstream', unit: 'per_call', capNanos: '7' },
        { nodeId: 'target', unit: 'upstream_cost', capNanos: '42600' },
      ],
    });
    expect(ctx.estimate).toHaveBeenCalledWith(
      ctx.credentials,
      expect.objectContaining({ input_pending: true }),
    );
  });

  it('原 Key 缺失、模型不符、过期与上游错误都不创建报价或零价放行', async () => {
    const ctx = await managedSubmissionFixture();
    await expect(
      prepareBillingSubmission({
        ...ctx,
        settings: { getProviderCredentials: async () => undefined },
        fields: { quoteOnly: true },
      }),
    ).rejects.toMatchObject({ code: 'billing_credentials_unavailable' });
    ctx.estimate.mockResolvedValue({ ...ctx.estimated, model: 'other-model' });
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } }),
    ).rejects.toMatchObject({ code: 'invalid_upstream_estimate' });
    ctx.estimate.mockResolvedValue({
      ...ctx.estimated,
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } }),
    ).rejects.toMatchObject({ code: 'quote_expired' });
    ctx.estimate.mockRejectedValue(new Error('secret url and key'));
    await expect(
      prepareBillingSubmission({ ...ctx, fields: { quoteOnly: true } }),
    ).rejects.toMatchObject({
      code: 'newapi_estimate_unavailable',
      message: 'New API 预估暂不可用，未创建运行或冻结余额',
    });
    expect(ctx.createQuote).not.toHaveBeenCalled();
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('真实节点报价入口注入服务端设置，只请求估算接口不创建生成任务', async () => {
    const ctx = await fixture();
    ctx.model.pricing.rule = { unit: 'upstream_cost', meteringSource: 'newapi_receipt' };
    vi.spyOn(ctx.settingsStore, 'getProviderCredentials').mockReturnValue({
      baseUrl: 'https://estimate.example.invalid/v1',
      apiKey: 'synthetic-key',
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        model: ctx.model.binding.upstreamModelId,
        group: 'key-group',
        pricing_version: 'actual',
        estimated_quota: '1',
        quota_per_unit: '500000',
        usd_to_cny: '7.1',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        estimate_only: true,
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const response = await ctx.app.inject({
      method: 'POST',
      url: ctx.path,
      headers: ctx.headers,
      payload: { ...ctx.body, quoteOnly: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().quote).toMatchObject({
      capNanos: '14200',
      items: [{ unit: 'upstream_cost' }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://estimate.example.invalid/v1/canvas/estimate',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(ctx.create).not.toHaveBeenCalled();
  });
});

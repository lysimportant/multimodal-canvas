import { randomUUID } from 'node:crypto';
import type {
  ModelBinding,
  ModelCatalogSync,
  PlatformModel,
  PricingVersion,
  PrismaClient,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AiCredentialNotFoundError, type AiSettingsStoreLike } from './settings';
import {
  PrismaModelMarketplace,
  createMarketplaceBindingSchema,
  createMarketplaceModelSchema,
  createMarketplacePricingSchema,
  marketplaceListSchema,
} from './model-marketplace';

/** 所有测试身份均为合成 UUID，不访问真实连接或数据库。 */
const actorId = '11111111-1111-4111-8111-111111111111';
/** 确定性时间早于本次创建及验证，用于检查版本切换和同步冲突。 */
const past = new Date('2025-01-01T00:00:00.000Z');
/** 显式发布的单次微额人民币价格。 */
const rule = { unit: 'per_call', meteringSource: 'fixed', unitPriceNanos: '1000' } as const;

/** 数据库返回的已发布模型、当前绑定和当前价格。 */
function records() {
  const id = randomUUID();
  const binding: ModelBinding = {
    id: randomUUID(),
    platformModelId: id,
    revision: 1,
    credentialId: randomUUID(),
    credentialVersion: 1,
    upstreamModelId: 'Exact-Model（按次）',
    contract: 'openai-images',
    capabilities: { mediaTypes: ['image'], sizes: ['1024x1024'] },
    limitations: { maxImages: 1 },
    verificationEvidence: '隔离合同用例确认',
    verifiedAt: past,
    createdBy: actorId,
    createdAt: past,
  };
  const pricing: PricingVersion = {
    id: randomUUID(),
    platformModelId: id,
    revision: 1,
    currency: 'CNY',
    rule,
    effectiveAt: past,
    createdBy: actorId,
    createdAt: past,
  };
  const model: PlatformModel = {
    id,
    name: '人工商品名称',
    description: '保留人工说明',
    mediaType: 'IMAGE',
    specifications: { sizes: ['1024x1024'] },
    status: 'published',
    sortOrder: 0,
    activeBindingId: binding.id,
    activePricingVersionId: pricing.id,
    sourceSyncId: null,
    sourceModelId: null,
    createdBy: actorId,
    createdAt: past,
    updatedAt: past,
  };
  return { model, binding, pricing };
}

/** Prisma 委托替身保留参数观测；业务规则测试不模拟 SQL 并发或迁移成功。 */
function fixture() {
  const rows = records();
  let currentModel = rows.model;
  let currentBinding = rows.binding;
  let currentPricing = rows.pricing;
  const published = () => ({
    ...currentModel,
    activeBinding: currentModel.activeBindingId ? currentBinding : null,
    activePrice: currentModel.activePricingVersionId ? currentPricing : null,
  });
  const database = {
    platformModel: {
      findUnique: vi.fn(async () => published()),
      findMany: vi.fn(async () => [published()]),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Partial<PlatformModel> }) => {
        currentModel = {
          ...currentModel,
          activeBindingId: null,
          activePricingVersionId: null,
          ...data,
          sourceSyncId: data.sourceSyncId ?? null,
          sourceModelId: data.sourceModelId ?? null,
        };
        return published();
      }),
      update: vi.fn(async ({ data }: { data: Partial<PlatformModel> }) => {
        currentModel = { ...currentModel, ...data };
        return published();
      }),
    },
    modelBinding: {
      findUnique: vi.fn(async () => currentBinding),
      findFirst: vi.fn(async () => currentBinding),
      findMany: vi.fn(async () => [currentBinding]),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Omit<ModelBinding, 'id' | 'createdAt'> }) => {
        currentBinding = { ...data, id: randomUUID(), createdAt: new Date() };
        return currentBinding;
      }),
    },
    pricingVersion: {
      findUnique: vi.fn(async () => currentPricing),
      findFirst: vi.fn(async () => currentPricing),
      findMany: vi.fn(async () => [currentPricing]),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: Omit<PricingVersion, 'id' | 'createdAt'> }) => {
        currentPricing = {
          ...data,
          effectiveAt: data.effectiveAt ?? new Date(),
          id: randomUUID(),
          createdAt: new Date(),
        };
        return currentPricing;
      }),
    },
    aiCredential: {
      findUnique: vi.fn(async () => ({
        label: 'independent',
        version: 1,
        baseUrl: 'https://synthetic.invalid/v1',
        encryptedApiKey: 'synthetic-encrypted-key',
        keyFingerprint: 'synthetic-fingerprint',
      })),
    },
    modelCatalogSync: {
      findUnique: vi.fn(async (): Promise<ModelCatalogSync | null> => null),
      findFirst: vi.fn(async (): Promise<ModelCatalogSync | null> => null),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<ModelCatalogSync, 'id' | 'createdAt' | 'errorCode'> & { errorCode?: string };
        }) => ({
          ...data,
          errorCode: data.errorCode ?? null,
          id: randomUUID(),
          createdAt: new Date(),
        }),
      ),
    },
    $queryRaw: vi.fn(async (): Promise<ModelCatalogSync[]> => []),
    $transaction: vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation(database),
    ),
  };
  const settings = {
    listCredentials: vi.fn(async () => [
      {
        id: rows.binding.credentialId,
        baseUrl: 'https://synthetic.invalid/v1',
        keySuffix: 'test-key',
        keyFingerprint: 'synthetic-fingerprint',
        active: true,
        updatedAt: past.toISOString(),
      },
    ]),
    getProviderCredentials: vi.fn(async () => ({
      baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'synthetic-bridge-key',
    })),
    getCredentialReference: vi.fn(async (credentialId: string) => ({
      credentialId,
      credentialVersion: 1,
    })),
    listModels: vi.fn(async () => []),
    refreshModels: vi.fn(async () => []),
  };
  const pricingFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, data: [] }));
  const service = new PrismaModelMarketplace(
    database as unknown as PrismaClient,
    settings as unknown as AiSettingsStoreLike,
    { pricingFetchImpl: pricingFetch },
  );
  return { service, database, settings, rows, published, pricingFetch };
}

/** 一次成功的来源快照，只包含候选字段，不具备发布权限。 */
function snapshot(credentialId: string, candidates: unknown[]): ModelCatalogSync {
  return {
    id: randomUUID(),
    credentialId,
    status: 'succeeded',
    candidates: candidates as ModelCatalogSync['candidates'],
    missing: [],
    errorCode: null,
    createdBy: actorId,
    createdAt: new Date(),
  };
}

describe('PrismaModelMarketplace', () => {
  it('删除幂等且保留历史版本，禁止编辑和新报价，管理列表排除删除状态', async () => {
    const { service, database, rows, published } = fixture();
    await service.deleteModel(rows.model.id);
    await service.deleteModel(rows.model.id);
    expect(database.platformModel.update).toHaveBeenCalledTimes(1);
    expect(published()).toMatchObject({
      status: 'deleted',
      activeBindingId: rows.binding.id,
      activePricingVersionId: rows.pricing.id,
    });
    expect((await service.listBindings(rows.model.id, 1, 30)).items).toEqual([rows.binding]);
    expect((await service.listPricing(rows.model.id, 1, 30)).items).toEqual([rows.pricing]);
    await expect(service.updateModel(rows.model.id, { status: 'published' })).rejects.toMatchObject(
      { code: 'platform_model_deleted' },
    );
    await expect(service.resolvePublishedModel(rows.model.id)).rejects.toMatchObject({
      code: 'platform_model_deleted',
    });
    await expect(
      service.createPricing({ platformModelId: rows.model.id, rule }, actorId),
    ).rejects.toMatchObject({ code: 'platform_model_deleted' });
    await service.listAdmin({ page: 1, pageSize: 30 });
    expect(database.platformModel.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { status: { not: 'deleted' } } }),
    );
    database.platformModel.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.deleteModel(randomUUID())).rejects.toMatchObject({
      code: 'platform_model_not_found',
      status: 404,
    });
  });
  it('公开目录过滤草稿并递归剔除内部凭据、成本和管理地址', async () => {
    const { service, database, rows } = fixture();
    rows.binding.capabilities = {
      mediaTypes: ['image'],
      credentialId: rows.binding.credentialId,
      internalUrl: 'https://synthetic.invalid/admin',
      cost: '900',
      imageEdit: { supported: true, baseUrl: 'https://synthetic.invalid' },
    };
    const page = await service.listPublished(marketplaceListSchema.parse({}));
    expect(database.platformModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'published' }, take: 30 }),
    );
    expect(page.items[0]).toMatchObject({
      id: rows.model.id,
      modelAlias: 'Exact-Model（按次）',
      availability: 'available',
      pricing: { currency: 'CNY', rule: { unitPriceNanos: '1000' } },
      capabilities: { mediaTypes: ['image'], imageEdit: { supported: true } },
    });
    const encoded = JSON.stringify(page);
    for (const secret of [
      'credentialId',
      'encryptedApiKey',
      'https://synthetic.invalid',
      'synthetic-fingerprint',
      rows.binding.credentialId,
      'verificationEvidence',
      'cost',
    ])
      expect(encoded).not.toContain(secret);
    expect(page.items[0]?.connection?.label).toBe('synthetic.invalid · Key …test-key');
  });

  it('没有候选目录也可手工建立草稿，未定价不能上架', async () => {
    const { service, database, settings } = fixture();
    const draft = await service.createModel({ name: '手工图像模型', mediaType: 'image' }, actorId);
    expect(draft).toMatchObject({ name: '手工图像模型', status: 'draft', sourceSyncId: null });
    expect(settings.refreshModels).not.toHaveBeenCalled();
    expect(database.modelCatalogSync.findUnique).not.toHaveBeenCalled();
    await expect(service.updateModel(draft.id, { status: 'published' })).rejects.toMatchObject({
      code: 'model_setup_incomplete',
    });
  });

  it('候选导入只创建草稿名称来源，不自动导入售价或能力', async () => {
    const { service, database, rows } = fixture();
    const sync = snapshot(rows.binding.credentialId, [
      {
        id: 'Selected-ID',
        name: '上游名称',
        mediaTypes: ['image'],
        capabilities: { mediaTypes: ['image'] },
        providerDeclaredPrice: { amount: 20, currency: 'USD' },
      },
    ]);
    database.modelCatalogSync.findUnique.mockResolvedValue(sync);
    const model = await service.createModel(
      {
        source: { syncId: sync.id, upstreamModelId: 'Selected-ID' },
        mediaType: 'image',
        name: '人工改名',
      },
      actorId,
    );
    expect(model).toMatchObject({
      name: '人工改名',
      status: 'draft',
      sourceSyncId: sync.id,
      sourceModelId: 'Selected-ID',
      activeBindingId: null,
      activePricingVersionId: null,
      capabilities: {},
    });
    expect(database.modelBinding.create).not.toHaveBeenCalled();
    expect(database.pricingVersion.create).not.toHaveBeenCalled();
  });

  it('更换 API 追加不可变绑定，商品 ID、旧绑定与售价保留', async () => {
    const { service, database, rows } = fixture();
    const before = structuredClone(rows.binding);
    const nextCredentialId = randomUUID();
    const binding = await service.createBinding(
      rows.model.id,
      {
        credentialId: nextCredentialId,
        credentialVersion: 1,
        upstreamModelId: 'Replacement-Exact-ID',
        contract: 'openai-images',
        capabilities: { mediaTypes: ['image'] },
        verificationEvidence: '管理员已经验证替代合同',
        activate: true,
      },
      actorId,
    );
    const resolved = await service.resolvePublishedModel(rows.model.id);
    expect(binding.revision).toBe(2);
    expect(binding.id).not.toBe(before.id);
    expect(rows.binding).toEqual(before);
    expect(resolved.model.id).toBe(rows.model.id);
    expect(resolved.pricing.id).toBe(rows.pricing.id);
    expect(resolved.binding).toMatchObject({
      credentialId: nextCredentialId,
      upstreamModelId: 'Replacement-Exact-ID',
    });
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('禁止跨模型绑定、跨模型价格以及不兼容合同', async () => {
    const { service, rows } = fixture();
    rows.binding.platformModelId = randomUUID();
    await expect(
      service.updateModel(rows.model.id, { activeBindingId: rows.binding.id }),
    ).rejects.toMatchObject({ code: 'model_version_mismatch' });
    rows.binding.platformModelId = rows.model.id;
    rows.pricing.platformModelId = randomUUID();
    await expect(
      service.updateModel(rows.model.id, { activePricingVersionId: rows.pricing.id }),
    ).rejects.toMatchObject({ code: 'model_version_mismatch' });
    await expect(
      service.createBinding(
        rows.model.id,
        {
          credentialId: rows.binding.credentialId,
          credentialVersion: 1,
          upstreamModelId: rows.binding.upstreamModelId,
          contract: 'openai-chat-completions',
          capabilities: { mediaTypes: ['image'] },
          verificationEvidence: '合成验证依据',
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'binding_contract_mismatch' });
  });

  it('停用连接或凭据版本变化后禁止新调用，目录仍保留模型与价格', async () => {
    const { service, settings, rows } = fixture();
    settings.getCredentialReference.mockRejectedValue(
      new AiCredentialNotFoundError(rows.binding.credentialId),
    );
    await expect(service.resolvePublishedModel(rows.model.id)).rejects.toMatchObject({
      code: 'binding_unavailable',
    });
    const page = await service.listPublished(marketplaceListSchema.parse({}));
    expect(page.items[0]).toMatchObject({
      id: rows.model.id,
      availability: 'unavailable',
      pricing: { id: rows.pricing.id },
    });
    settings.getCredentialReference.mockResolvedValue({
      credentialId: rows.binding.credentialId,
      credentialVersion: 2,
    });
    await expect(service.resolvePublishedModel(rows.model.id)).rejects.toMatchObject({
      code: 'binding_version_changed',
    });
  });

  it('同步成功后的模型缺失和同步失败都保留人工字段及售价', async () => {
    const { service, settings, database, rows } = fixture();
    const prior = snapshot(rows.binding.credentialId, [
      {
        id: rows.binding.upstreamModelId,
        name: '旧目录名称',
        mediaTypes: ['image'],
        capabilities: { mediaTypes: ['image'] },
      },
    ]);
    database.$queryRaw.mockResolvedValue([prior]);
    const success = await service.sync(rows.binding.credentialId, actorId);
    expect(success).toMatchObject({ status: 'succeeded', missing: [rows.binding.upstreamModelId] });
    settings.refreshModels.mockRejectedValue(
      new Error('Bearer synthetic-private-value https://synthetic.invalid'),
    );
    const failed = await service.sync(rows.binding.credentialId, actorId);
    expect(failed).toMatchObject({
      status: 'failed',
      candidates: prior.candidates,
      errorCode: 'upstream_catalog_unavailable',
    });
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-value');
    expect(database.platformModel.update).not.toHaveBeenCalled();
    expect(database.pricingVersion.create).not.toHaveBeenCalled();
    expect((await service.resolvePublishedModel(rows.model.id)).model.name).toBe('人工商品名称');
  });

  it('新的明确能力冲突暂停新调用，模型缺失本身不证明已下架', async () => {
    const { service, database, rows } = fixture();
    database.$queryRaw.mockResolvedValue([
      snapshot(rows.binding.credentialId, [
        {
          id: rows.binding.upstreamModelId,
          name: '来源名称',
          mediaTypes: ['image'],
          capabilities: { sizes: ['512x512'] },
        },
      ]),
    ]);
    await expect(service.resolvePublishedModel(rows.model.id)).rejects.toMatchObject({
      code: 'binding_needs_review',
    });
    expect(
      (await service.listPublished(marketplaceListSchema.parse({}))).items[0]?.availability,
    ).toBe('needs_review');
    database.$queryRaw.mockResolvedValue([snapshot(rows.binding.credentialId, [])]);
    await expect(service.resolvePublishedModel(rows.model.id)).resolves.toMatchObject({
      model: { id: rows.model.id },
    });
  });

  it('公开定价只读取保存地址，重复同步不解密、不刷新 Key 目录、不改模型售价', async () => {
    const { service, database, settings, pricingFetch, rows } = fixture();
    const input = {
      success: true,
      data: [
        {
          model_name: 'Exact-NewAPI（按次）',
          description: '来源描述',
          quota_type: 1,
          model_price: 0.2,
          supported_endpoint_types: ['openai'],
        },
      ],
    };
    pricingFetch.mockImplementation(async () => Response.json(input));
    const first = await service.sync(rows.binding.credentialId, actorId, 'newapi_pricing');
    await service.sync(rows.binding.credentialId, actorId, 'newapi_pricing');
    expect(first).toMatchObject({
      sourceType: 'newapi_pricing',
      status: 'succeeded',
      candidates: [
        {
          id: 'Exact-NewAPI（按次）',
          description: '来源描述',
          mediaTypes: [],
          capabilities: {},
          verification: 'unverified',
        },
      ],
    });
    expect(database.aiCredential.findUnique).toHaveBeenCalledWith({
      where: { id: rows.binding.credentialId },
      select: { baseUrl: true, label: true, projectId: true },
    });
    for (const method of Object.values(settings)) expect(method).not.toHaveBeenCalled();
    expect(database.platformModel.update).not.toHaveBeenCalled();
    expect(database.platformModel.create).not.toHaveBeenCalled();
    expect(database.pricingVersion.create).not.toHaveBeenCalled();
    expect(database.modelBinding.create).not.toHaveBeenCalled();
    const stored = database.modelCatalogSync.create.mock.calls[0]![0].data;
    expect(stored.candidates).toMatchObject({
      sourceType: 'newapi_pricing',
      candidates: first.candidates,
    });
    expect(database.$queryRaw.mock.calls[0]).toBeDefined();
  });

  it('公开定价失败与空列表保持来源，来源描述只在新草稿未显式填写时使用', async () => {
    const { service, database, pricingFetch, rows } = fixture();
    const previous = snapshot(rows.binding.credentialId, []);
    previous.candidates = {
      sourceType: 'newapi_pricing',
      candidates: [{ id: 'source', name: '来源名称', description: '来源描述', mediaTypes: [] }],
    };
    database.$queryRaw.mockResolvedValue([previous]);
    pricingFetch.mockRejectedValue(new Error('Bearer synthetic-private-failure'));
    const failed = await service.sync(rows.binding.credentialId, actorId, 'newapi_pricing');
    expect(failed).toMatchObject({
      sourceType: 'newapi_pricing',
      status: 'failed',
      candidates: [{ id: 'source' }],
      errorCode: 'upstream_pricing_unavailable',
    });
    expect(JSON.stringify(failed)).not.toContain('synthetic-private-failure');
    pricingFetch.mockResolvedValue(Response.json({ success: true, data: [] }));
    expect(await service.sync(rows.binding.credentialId, actorId, 'newapi_pricing')).toMatchObject({
      sourceType: 'newapi_pricing',
      candidates: [],
      missing: ['source'],
    });
    database.modelCatalogSync.findUnique.mockResolvedValue(previous);
    const source = { syncId: previous.id, upstreamModelId: 'source' };
    expect(await service.createModel({ source, mediaType: 'video' }, actorId)).toMatchObject({
      description: '来源描述',
      status: 'draft',
    });
    expect(
      await service.createModel(
        { source, mediaType: 'video', name: '人工名称', description: '' },
        actorId,
      ),
    ).toMatchObject({ name: '人工名称', description: '' });
  });

  it('旧模型别名只允许唯一精确匹配，同名商品歧义拒绝', async () => {
    const { service, database, rows, published } = fixture();
    await expect(
      service.resolveLegacyModel(rows.binding.upstreamModelId, rows.binding.credentialId, 'image'),
    ).resolves.toMatchObject({ model: { id: rows.model.id } });
    expect(database.platformModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          activeBinding: {
            is: {
              upstreamModelId: rows.binding.upstreamModelId,
              credentialId: rows.binding.credentialId,
            },
          },
        }),
      }),
    );
    database.platformModel.findMany.mockResolvedValue([
      published(),
      { ...published(), id: randomUUID() },
    ]);
    await expect(service.resolveLegacyModel(rows.binding.upstreamModelId)).rejects.toMatchObject({
      code: 'model_selection_ambiguous',
    });
  });

  it('人民币定价追加版本，显式零价格允许，未来价格不能立即启用', async () => {
    const { service, database, rows } = fixture();
    const previous = structuredClone(rows.pricing);
    const free = await service.createPricing(
      { platformModelId: rows.model.id, rule: { ...rule, unitPriceNanos: '0' }, activate: true },
      actorId,
    );
    expect(free).toMatchObject({ revision: 2, currency: 'CNY', rule: { unitPriceNanos: '0' } });
    expect(rows.pricing).toEqual(previous);
    expect(database.platformModel.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activePricingVersionId: free.id } }),
    );
    await expect(
      service.createPricing(
        {
          platformModelId: rows.model.id,
          rule,
          effectiveAt: '2100-01-01T00:00:00.000Z',
          activate: true,
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'pricing_not_effective' });
  });

  it('缺少单价、浮点金额、内部元数据、未知字段和无界分页都明确拒绝', () => {
    expect(
      createMarketplacePricingSchema.safeParse({
        platformModelId: randomUUID(),
        rule: { unit: 'per_call', meteringSource: 'fixed' },
      }).success,
    ).toBe(false);
    expect(
      createMarketplacePricingSchema.safeParse({
        platformModelId: randomUUID(),
        rule: { ...rule, unitPriceNanos: 0.5 },
      }).success,
    ).toBe(false);
    expect(
      createMarketplacePricingSchema.safeParse({
        platformModelId: randomUUID(),
        rule,
        currency: 'USD',
      }).success,
    ).toBe(false);
    expect(
      createMarketplaceModelSchema.safeParse({
        name: '模型',
        mediaType: 'image',
        specifications: { parameters: { apiKey: 'private' } },
      }).success,
    ).toBe(false);
    expect(
      createMarketplaceModelSchema.safeParse({
        name: '模型',
        mediaType: 'image',
        status: 'published',
      }).success,
    ).toBe(false);
    expect(
      createMarketplaceBindingSchema.safeParse({ ...records().binding, capabilities: {} }).success,
    ).toBe(false);
    expect(marketplaceListSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(marketplaceListSchema.safeParse({ ownerId: actorId }).success).toBe(false);
  });

  it('New API 价格无需单价，仍要求当前绑定和实际 Key 的模型权限', async () => {
    const f = fixture();
    f.pricingFetch.mockResolvedValue(Response.json(managedCatalog(f.rows.binding.upstreamModelId)));
    await f.service.createPricing(
      {
        platformModelId: f.rows.model.id,
        rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
        activate: true,
      },
      actorId,
    );
    expect(f.database.pricingVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
        }),
      }),
    );
    expect((await f.service.getAdmin(f.rows.model.id)).pricing?.rule.unit).toBe('upstream_cost');
    f.pricingFetch.mockResolvedValue(Response.json({ ...managedCatalog(), models: [] }));
    await expect(
      f.service.createPricing(
        {
          platformModelId: f.rows.model.id,
          rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
          activate: true,
        },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it('托管来源独立同步，可用合同和缺失原因保留，Key 不进入来源快照', async () => {
    const f = fixture();
    const catalog = managedCatalog();
    f.pricingFetch.mockResolvedValue(Response.json(catalog));
    const result = await f.service.sync(f.rows.binding.credentialId, actorId, 'newapi_managed');
    expect(result.sourceType).toBe('newapi_managed');
    expect(result.candidates[0]).toMatchObject({
      mediaTypes: ['image'],
      managed: { available: true, contract: 'openai-images' },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-bridge-key');
    expect(f.database.platformModel.create).not.toHaveBeenCalled();
    f.pricingFetch.mockRejectedValue(new Error('private response'));
    f.database.$queryRaw.mockResolvedValue([
      snapshot(f.rows.binding.credentialId, result.candidates),
    ]);
    const failed = await f.service.sync(f.rows.binding.credentialId, actorId, 'newapi_managed');
    expect(failed.status).toBe('failed');
    expect(failed.candidates).toEqual(result.candidates);
    expect(JSON.stringify(failed)).not.toContain('private response');
  });

  it('批量同步独立保存连接且只读取每条目录一次，保留失败原因和同名模型身份', async () => {
    const f = fixture();
    const first = (await f.settings.listCredentials())[0]!;
    const second = { ...first, id: randomUUID(), active: false, keySuffix: 'second08' };
    const third = { ...first, id: randomUUID(), active: false, keySuffix: 'failed08' };
    f.settings.listCredentials.mockResolvedValue([first, second, third]);
    f.database.platformModel.findUnique.mockResolvedValue(null as never);
    let reads = 0;
    f.pricingFetch.mockImplementation(async () => {
      reads++;
      if (reads === 3) throw new Error('private upstream body');
      const catalog = managedCatalog();
      return Response.json({
        ...catalog,
        models: [
          ...catalog.models,
          {
            ...catalog.models[0],
            id: 'unavailable',
            available: false,
            unavailable_reason: '缺少调用合同',
          },
        ],
      });
    });
    const result = await f.service.syncConnections(undefined, actorId);
    expect(reads).toBe(3);
    expect(result.connections.map((item) => item.published)).toEqual([1, 1, 0]);
    expect(result.connections[0]?.issues).toEqual([
      { modelId: 'unavailable', message: '缺少调用合同' },
    ]);
    expect(result.connections[2]?.issues[0]?.message).toContain('New API 联动接口不可用');
    const ids = f.database.platformModel.create.mock.calls.map(([{ data }]) => data.id);
    expect(new Set(ids).size).toBe(2);
    expect(
      f.database.modelBinding.create.mock.calls.map(([{ data }]) => data.credentialId),
    ).toEqual([first.id, second.id]);
    expect(JSON.stringify(result)).not.toContain('private upstream body');
  });

  it('自动同步保留人工价格、暂停和删除状态，数据库故障不伪装为成功', async () => {
    const f = fixture();
    f.database.platformModel.findUnique.mockResolvedValueOnce(null as never);
    f.pricingFetch.mockImplementation(async () => Response.json(managedCatalog()));
    const credentialId = f.rows.binding.credentialId;
    expect((await f.service.syncConnections(credentialId, actorId)).connections[0]?.published).toBe(
      1,
    );
    const id = f.database.platformModel.create.mock.calls[0]![0].data.id!;
    await f.service.createPricing({ platformModelId: id, rule, activate: true }, actorId);
    await f.service.updateModel(id, { status: 'paused', name: '人工名称' });
    const repeated = await f.service.syncConnections(credentialId, actorId);
    expect(repeated.connections[0]).toMatchObject({ published: 0, retained: 1, issues: [] });
    expect(await f.service.getAdmin(id)).toMatchObject({
      name: '人工名称',
      status: 'paused',
      pricing: { rule: { unit: 'per_call' } },
    });
    expect(f.database.platformModel.create).toHaveBeenCalledTimes(1);
    await f.service.deleteModel(id);
    expect(
      (await f.service.syncConnections(credentialId, actorId)).connections[0]?.issues[0]?.message,
    ).toContain('已删除');
    f.database.modelCatalogSync.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.service.syncConnections(credentialId, actorId)).rejects.toThrow(
      'database unavailable',
    );
  });

  it('全局切换折叠旧凭据版本后仍显示原 Key 尾号，平台绑定不改变', async () => {
    const f = fixture();
    const original = (await f.settings.listCredentials())[0]!;
    const before = await f.service.getAdmin(f.rows.model.id);
    f.settings.listCredentials.mockResolvedValue([{ ...original, id: randomUUID() }]);
    const after = await f.service.getAdmin(f.rows.model.id);
    expect(after.connection).toEqual(before.connection);
    expect(after.connection?.label).toContain('test-key');
    expect(after.activeBindingId).toBe(before.activeBindingId);
  });

  it('公开来源去除地址认证、路径与查询字段，同一连接跨页面身份稳定', async () => {
    const f = fixture();
    const credential = (await f.settings.listCredentials())[0]!;
    f.settings.listCredentials.mockResolvedValue([
      {
        ...credential,
        baseUrl:
          'https://hidden-user:hidden-password@synthetic.invalid/private-path?key=hidden-query',
      },
    ]);
    const page = await f.service.listPublished(marketplaceListSchema.parse({}));
    expect(page.items[0]?.connection?.label).toBe('synthetic.invalid · Key …test-key');
    expect(JSON.stringify(page)).not.toMatch(/hidden-|private-path|synthetic-fingerprint/);
    expect((await f.service.getAdmin(f.rows.model.id)).connection).toEqual(
      page.items[0]?.connection,
    );
  });

  it('托管导入只接收托管快照，重新校验 Key 权限后自动建立价格与绑定', async () => {
    const f = fixture();
    const candidate = {
      id: 'managed-image',
      name: '托管图片',
      mediaTypes: ['image'],
      capabilities: {},
      limitations: {},
      refreshedAt: new Date().toISOString(),
      verification: 'unverified',
    };
    const source = snapshot(f.rows.binding.credentialId, [candidate]);
    source.candidates = { sourceType: 'newapi_managed', candidates: [candidate] };
    f.database.modelCatalogSync.findUnique.mockResolvedValue(source);
    f.database.platformModel.findUnique.mockResolvedValueOnce(null as never);
    f.pricingFetch.mockImplementation(async () => Response.json(managedCatalog()));
    const imported = await f.service.createModel(
      { managed: true, source: { syncId: source.id, upstreamModelId: 'managed-image' } },
      actorId,
    );
    expect(imported.status).toBe('published');
    expect(imported.pricing?.rule.unit).toBe('upstream_cost');
    expect(imported.modelAlias).toBe('managed-image');
    expect(f.database.platformModel.create).toHaveBeenCalledTimes(1);
    const repeated = await f.service.createModel(
      { managed: true, source: { syncId: source.id, upstreamModelId: 'managed-image' } },
      actorId,
    );
    expect(repeated.id).toBe(imported.id);
    expect(f.database.platformModel.create).toHaveBeenCalledTimes(1);
    expect(f.database.pricingVersion.create).toHaveBeenCalledTimes(1);
    await f.service.deleteModel(imported.id);
    await expect(
      f.service.createModel(
        { managed: true, source: { syncId: source.id, upstreamModelId: 'managed-image' } },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'platform_model_deleted' });
    expect(f.database.platformModel.create).toHaveBeenCalledTimes(1);
  });
});

/** 合成的 Key 作用域目录，不包含真实定价、凭据或供应商请求。 */
function managedCatalog(id = 'managed-image') {
  return {
    version: 1,
    currency: 'CNY',
    quota_per_unit: '500000',
    usd_to_cny: '7.3',
    models: [
      {
        id,
        name: '托管图片',
        media_type: 'image',
        contract: 'openai-images',
        available: true,
        capabilities: { mediaTypes: ['image'] },
        limitations: {},
        pricing_version: 'synthetic-version',
      },
    ],
  };
}

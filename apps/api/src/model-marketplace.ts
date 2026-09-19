import { createHash } from 'node:crypto';
import { requestNewApiCatalog } from '@multimodal-canvas/billing';
import {
  marketplacePriceRuleSchema,
  mediaTypes,
  type MarketplacePriceRule,
  type MediaType,
} from '@multimodal-canvas/domain';
import {
  Prisma,
  type ModelBinding,
  type ModelCatalogSync,
  type PlatformModel,
  type PricingVersion,
  type PrismaClient,
} from '@prisma/client';
import { z } from 'zod';
import {
  NewApiPricingError,
  requestNewApiPricing,
  type NewApiPricingReference,
} from './newapi-pricing';
import {
  AiCredentialNotFoundError,
  type AiSettingsStoreLike,
  type ModelCatalogEntry,
} from './settings';

/** 模型管理业务错误；稳定错误码不包含上游地址或认证数据。 */
export class ModelMarketplaceError extends Error {
  /** 构建可安全返回 HTTP 的中文业务错误，status 默认为输入错误 400。 */
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ModelMarketplaceError';
  }
}

/** 当前 Provider 实现支持的调用合同；不接受任意 endpoint 或 URL。 */
export const marketplaceContractSchema = z.enum([
  'openai-chat-completions',
  'openai-images',
  'newapi-video-v1',
  'newapi-unified-v1',
  'legacy-v1',
  'openai-audio',
]);
/** API 的 Zod 运行时独立校验媒体枚举，避免跨工作区 Zod 次版本类型混用。 */
const mediaTypeSchema = z.enum(mediaTypes);
/** 来源显式隔离；旧调用和旧数组快照继续归属 models。 */
export const marketplaceSourceTypeSchema = z.enum(['models', 'newapi_pricing', 'newapi_managed']);
/** 同步来源决定读取端点，不允许客户端提交任意 URL。 */
export type MarketplaceSourceType = z.infer<typeof marketplaceSourceTypeSchema>;
/** 对外保留候选数组，数据库中的 JSON 包装不进入路由响应。 */
export type MarketplaceSyncDto = Omit<ModelCatalogSync, 'candidates'> & {
  sourceType: MarketplaceSourceType;
  candidates: MarketplaceCandidate[];
};
/** 共享账务规则负责业务校验，本地桥接仅传递结果与脱敏错误路径。 */
const marketplaceRuleSchema = z.unknown().transform((value, context): MarketplacePriceRule => {
  const result = marketplacePriceRuleSchema.safeParse(value);
  if (result.success) {
    if (containsPrivateMetadata(result.data)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '价格规格不能包含内部地址或凭据字段',
      });
      return z.NEVER;
    }
    return result.data;
  }
  for (const issue of result.error.issues) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
  return z.NEVER;
});
/** 手工和来源 JSON 的单字段限制，阻止把认证数据或无界响应当成模型元数据。 */
const metadataSchema = z.record(z.unknown()).superRefine((value, context) => {
  if (JSON.stringify(value).length > 32_768 || containsPrivateMetadata(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '模型元数据过大或含内部地址、凭据字段',
    });
  }
});
/** 草稿创建可以完全手工；候选导入只提供名称来源，不自动验证调用能力。 */
export const createMarketplaceModelSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4_000).optional(),
    mediaType: mediaTypeSchema.optional(),
    managed: z.boolean().optional(),
    specifications: metadataSchema.default({}),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    source: z
      .object({ syncId: z.string().uuid(), upstreamModelId: z.string().min(1).max(512) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.name || value.source), '手工新建必须填写名称')
  .refine(
    (value) => (value.managed ? Boolean(value.source) : Boolean(value.mediaType)),
    '托管导入需要来源，手工创建需要媒体类型',
  );
/** 启用绑定、价格和发布在同一更新中验证，禁止跨模型引用。 */
export const updateMarketplaceModelSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(4_000).optional(),
    specifications: metadataSchema.optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    status: z.enum(['draft', 'published', 'paused']).optional(),
    activeBindingId: z.string().uuid().nullable().optional(),
    activePricingVersionId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个更新字段');
/** 精确模型 ID 不修剪、不改大小写，管理员必须提供能力声明和验证依据。 */
export const createMarketplaceBindingSchema = z
  .object({
    credentialId: z.string().uuid(),
    credentialVersion: z.number().int().positive(),
    upstreamModelId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value === value.trim(), '模型 ID 不允许首尾空格'),
    contract: marketplaceContractSchema,
    capabilities: metadataSchema.refine(
      (value) => Object.keys(value).length > 0,
      '必须明确填写已验证能力',
    ),
    limitations: metadataSchema.default({}),
    verificationEvidence: z.string().trim().min(1).max(4_000),
    verifiedAt: z.string().datetime({ offset: true }).optional(),
    activate: z.boolean().default(false),
  })
  .strict();
/** 平台售价只能创建新版本；无默认价格，显式零价由共享规则校验。 */
export const createMarketplacePricingSchema = z
  .object({
    platformModelId: z.string().uuid(),
    currency: z.literal('CNY').default('CNY'),
    rule: marketplaceRuleSchema,
    effectiveAt: z.string().datetime({ offset: true }).optional(),
    activate: z.boolean().default(false),
  })
  .strict();
/** 列表限制一百条并采用稳定排序，防止目录无限返回。 */
export const marketplaceListSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(30),
    query: z.string().trim().max(160).optional(),
    mediaType: mediaTypeSchema.optional(),
    status: z.enum(['draft', 'published', 'paused']).optional(),
  })
  .strict();
/** 已校验分页与可选搜索过滤。 */
export type MarketplaceListInput = z.infer<typeof marketplaceListSchema>;
/** 普通用户可见的不可变售价，不包含平台成本。 */
export type MarketplacePricingDto = {
  id: string;
  revision: number;
  currency: 'CNY';
  rule: MarketplacePriceRule;
  effectiveAt: string;
};
/** 商品公开视图；modelAlias 保留精确上游 ID，id 始终为平台商品身份。 */
export type MarketplaceModelDto = {
  id: string;
  name: string;
  description: string;
  mediaType: MediaType;
  specifications: Record<string, unknown>;
  modelAlias?: string;
  capabilities: Record<string, unknown>;
  limitations: Record<string, unknown>;
  pricing: MarketplacePricingDto | null;
  availability: 'available' | 'unavailable' | 'needs_review';
  availabilityReason?: string;
};
/** 管理员视图保留当前绑定与价格身份及来源，客户端仍拿不到 Key。 */
export type MarketplaceAdminModelDto = MarketplaceModelDto & {
  status: string;
  sortOrder: number;
  activeBindingId: string | null;
  activePricingVersionId: string | null;
  sourceSyncId: string | null;
  sourceModelId: string | null;
  createdAt: string;
  updatedAt: string;
};
/** 分页结果总数用于后台和模型广场导航。 */
export type MarketplacePage<T> = { items: T[]; page: number; pageSize: number; total: number };
/** 仅用于服务端报价和执行冻结的解析结果，不应直接序列化到用户响应。 */
export type ResolvedMarketplaceModel = {
  model: PlatformModel;
  binding: ModelBinding;
  pricing: PricingVersion;
};
/** 管理路由依赖最小接口，测试可注入隔离实现。 */
export interface ModelMarketplace {
  listPublished(input: MarketplaceListInput): Promise<MarketplacePage<MarketplaceModelDto>>;
  listAdmin(input: MarketplaceListInput): Promise<MarketplacePage<MarketplaceAdminModelDto>>;
  getAdmin(id: string): Promise<MarketplaceAdminModelDto>;
  createModel(input: unknown, actorId: string): Promise<MarketplaceAdminModelDto>;
  updateModel(id: string, input: unknown): Promise<MarketplaceAdminModelDto>;
  listBindings(id: string, page: number, pageSize: number): Promise<MarketplacePage<ModelBinding>>;
  createBinding(id: string, input: unknown, actorId: string): Promise<ModelBinding>;
  listPricing(
    platformModelId: string,
    page: number,
    pageSize: number,
  ): Promise<MarketplacePage<PricingVersion>>;
  createPricing(input: unknown, actorId: string): Promise<PricingVersion>;
  sync(
    credentialId: string,
    actorId: string,
    sourceType?: MarketplaceSourceType,
  ): Promise<MarketplaceSyncDto>;
  getSync(
    credentialId: string,
    sourceType?: MarketplaceSourceType,
  ): Promise<MarketplaceSyncDto | null>;
  resolvePublishedModel(id: string): Promise<ResolvedMarketplaceModel>;
  resolveLegacyModel(
    modelAlias: string,
    credentialId?: string,
    mediaType?: MediaType,
  ): Promise<ResolvedMarketplaceModel>;
}

/** 查询时仅加载当前版本；所有旧绑定和价格继续独立留存。 */
const modelInclude = { activeBinding: true, activePrice: true } as const;
/** Prisma 加载后的当前商品与版本。 */
type LoadedModel = Prisma.PlatformModelGetPayload<{ include: typeof modelInclude }>;
/** 单次事务需要的 Prisma 客户端。 */
type MarketplaceDatabase = PrismaClient | Prisma.TransactionClient;

/**
 * 平台商品管理；人工字段、调用绑定、售价和来源快照分别持久化。
 * 只同步模型目录，不发起真实生成；创建价格或绑定永不覆盖历史版本。
 */
export class PrismaModelMarketplace implements ModelMarketplace {
  /** 复用现有持久化客户端和版本化凭据存储，不持有解密后的 Key。 */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: AiSettingsStoreLike,
    private readonly options: { pricingFetchImpl?: typeof fetch } = {},
  ) {}

  /** 返回已发布商品，连接停用时仍展示商品身份及不可用状态。 */
  async listPublished(input: MarketplaceListInput): Promise<MarketplacePage<MarketplaceModelDto>> {
    const page = await this.loadPage({
      ...marketplaceListSchema.parse(input),
      status: 'published',
    });
    return { ...page, items: await Promise.all(page.items.map((item) => this.publicView(item))) };
  }

  /** 管理后台列表包含草稿、来源和版本指针；分页上限在服务边界复验。 */
  async listAdmin(input: MarketplaceListInput): Promise<MarketplacePage<MarketplaceAdminModelDto>> {
    const page = await this.loadPage(marketplaceListSchema.parse(input));
    return { ...page, items: await Promise.all(page.items.map((item) => this.adminView(item))) };
  }

  /** 管理员按平台身份读取当前版本，编辑后无需依赖名称搜索定位商品。 */
  async getAdmin(id: string): Promise<MarketplaceAdminModelDto> {
    z.string().uuid().parse(id);
    return this.adminView(await requireModel(this.prisma, id));
  }

  /** 手工或选中候选创建草稿；不会自动继承上游售价、能力或发布状态。 */
  async createModel(input: unknown, actorId: string): Promise<MarketplaceAdminModelDto> {
    const parsed = createMarketplaceModelSchema.parse(input);
    z.string().uuid().parse(actorId);
    if (parsed.managed) return this.importManagedModel(parsed.source!, actorId);
    let sourceName: string | undefined;
    let sourceDescription: string | undefined;
    if (parsed.source) {
      const sync = await this.prisma.modelCatalogSync.findUnique({
        where: { id: parsed.source.syncId },
      });
      const candidate = readCandidates(sync?.candidates).find(
        (item) => item.id === parsed.source?.upstreamModelId,
      );
      if (!sync || sync.status !== 'succeeded' || !candidate) {
        throw new ModelMarketplaceError('candidate_not_found', '候选来源不存在或同步未成功', 404);
      }
      sourceName = z.string().trim().min(1).max(160).parse(candidate.name);
      sourceDescription = candidate.description;
    }
    const model = await this.prisma.platformModel.create({
      data: {
        name: parsed.name ?? sourceName!,
        description: parsed.description ?? sourceDescription ?? '',
        mediaType: toDatabaseMediaType(parsed.mediaType!),
        specifications: parsed.specifications as Prisma.InputJsonValue,
        sortOrder: parsed.sortOrder,
        status: 'draft',
        createdBy: actorId,
        sourceSyncId: parsed.source?.syncId,
        sourceModelId: parsed.source?.upstreamModelId,
      },
      include: modelInclude,
    });
    return this.adminView(model);
  }

  /** 修改人工资料或切换当前版本；跨商品指针、失效连接、缺价格发布全部拒绝。 */
  async updateModel(id: string, input: unknown): Promise<MarketplaceAdminModelDto> {
    z.string().uuid().parse(id);
    const parsed = updateMarketplaceModelSchema.parse(input);
    const model = await this.transaction(async (transaction) => {
      const current = await requireModel(transaction, id);
      const bindingId =
        parsed.activeBindingId === undefined ? current.activeBindingId : parsed.activeBindingId;
      const pricingId =
        parsed.activePricingVersionId === undefined
          ? current.activePricingVersionId
          : parsed.activePricingVersionId;
      const binding = bindingId
        ? await transaction.modelBinding.findUnique({ where: { id: bindingId } })
        : null;
      const pricing = pricingId
        ? await transaction.pricingVersion.findUnique({ where: { id: pricingId } })
        : null;
      assertVersionOwners(id, bindingId, binding, pricingId, pricing);
      if (parsed.activeBindingId && binding)
        await this.assertBindingAvailable(binding, transaction);
      if (parsed.activePricingVersionId && pricing) assertPriceAvailable(pricing);
      if ((parsed.status ?? current.status) === 'published') {
        await this.assertReady(
          { ...current, activeBinding: binding, activePrice: pricing },
          transaction,
        );
      }
      return transaction.platformModel.update({
        where: { id },
        data: {
          ...parsed,
          specifications: parsed.specifications as Prisma.InputJsonValue | undefined,
        },
        include: modelInclude,
      });
    });
    return this.adminView(model);
  }

  /** 按修订号倒序展示不可变绑定；不存在的商品返回 404。 */
  async listBindings(id: string, page = 1, pageSize = 30): Promise<MarketplacePage<ModelBinding>> {
    z.string().uuid().parse(id);
    const pagination = marketplaceListSchema.parse({ page, pageSize });
    await requireModel(this.prisma, id);
    const where = { platformModelId: id };
    const [items, total] = await Promise.all([
      this.prisma.modelBinding.findMany({
        where,
        orderBy: { revision: 'desc' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      this.prisma.modelBinding.count({ where }),
    ]);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  /** 创建经人工核验的绑定；精确凭据版本、合同、能力及验证时间进入不可变记录。 */
  async createBinding(id: string, input: unknown, actorId: string): Promise<ModelBinding> {
    z.string().uuid().parse(id);
    z.string().uuid().parse(actorId);
    const {
      activate,
      verifiedAt: suppliedDate,
      ...parsed
    } = createMarketplaceBindingSchema.parse(input);
    const verifiedAt = suppliedDate ? new Date(suppliedDate) : new Date();
    if (verifiedAt.getTime() > Date.now()) {
      throw new ModelMarketplaceError('invalid_verification_date', '验证时间不能晚于当前时间');
    }
    return this.transaction(async (transaction) => {
      const model = await requireModel(transaction, id);
      assertContractMediaType(parsed.contract, model.mediaType);
      const latest = await transaction.modelBinding.findFirst({
        where: { platformModelId: id },
        orderBy: { revision: 'desc' },
      });
      const binding = await transaction.modelBinding.create({
        data: {
          ...parsed,
          platformModelId: id,
          revision: (latest?.revision ?? 0) + 1,
          capabilities: parsed.capabilities as Prisma.InputJsonValue,
          limitations: parsed.limitations as Prisma.InputJsonValue,
          verifiedAt,
          createdBy: actorId,
        },
      });
      await this.assertBindingAvailable(binding, transaction);
      if (activate) {
        if (model.status === 'published') {
          await this.assertReady({ ...model, activeBinding: binding }, transaction);
        }
        await transaction.platformModel.update({
          where: { id },
          data: { activeBindingId: binding.id },
        });
      }
      return binding;
    });
  }

  /** 按商品返回售价历史；普通用户仅通过公开视图读取当前售价。 */
  async listPricing(
    platformModelId: string,
    page = 1,
    pageSize = 30,
  ): Promise<MarketplacePage<PricingVersion>> {
    z.string().uuid().parse(platformModelId);
    const pagination = marketplaceListSchema.parse({ page, pageSize });
    await requireModel(this.prisma, platformModelId);
    const where = { platformModelId };
    const [items, total] = await Promise.all([
      this.prisma.pricingVersion.findMany({
        where,
        orderBy: { revision: 'desc' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      this.prisma.pricingVersion.count({ where }),
    ]);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  /** 创建人民币价格新版本；未来版本可保存但必须到生效时间后才能启用。 */
  async createPricing(input: unknown, actorId: string): Promise<PricingVersion> {
    const { activate, effectiveAt, ...parsed } = createMarketplacePricingSchema.parse(input);
    z.string().uuid().parse(actorId);
    if (parsed.rule.unit === 'upstream_cost') {
      const model = await requireModel(this.prisma, parsed.platformModelId);
      if (!model.activeBinding)
        throw new ModelMarketplaceError('binding_unavailable', '请先确认模型的调用绑定', 409);
      if (
        !['openai-chat-completions', 'openai-images', 'newapi-video-v1', 'openai-audio'].includes(
          model.activeBinding.contract,
        )
      )
        throw new ModelMarketplaceError(
          'model_contract_unavailable',
          '此调用合同尚未接入 New API 费用联动',
          409,
        );
      await this.assertBindingAvailable(model.activeBinding, this.prisma);
      const catalog = await this.managedCatalog(model.activeBinding.credentialId);
      if (!catalog.models.some((entry) => entry.id === model.activeBinding!.upstreamModelId))
        throw new ModelMarketplaceError(
          'model_unavailable',
          '当前 New API Key 无权使用此模型',
          409,
        );
    }
    return this.transaction(async (transaction) => {
      const model = await requireModel(transaction, parsed.platformModelId);
      assertPriceMediaType(parsed.rule, model.mediaType);
      const latest = await transaction.pricingVersion.findFirst({
        where: { platformModelId: parsed.platformModelId },
        orderBy: { revision: 'desc' },
      });
      const pricing = await transaction.pricingVersion.create({
        data: {
          ...parsed,
          rule: parsed.rule as Prisma.InputJsonValue,
          revision: (latest?.revision ?? 0) + 1,
          effectiveAt: effectiveAt ? new Date(effectiveAt) : new Date(),
          createdBy: actorId,
        },
      });
      if (activate) {
        assertPriceAvailable(pricing);
        if (model.status === 'published') {
          await this.assertReady({ ...model, activePrice: pricing }, transaction);
        }
        await transaction.platformModel.update({
          where: { id: parsed.platformModelId },
          data: { activePricingVersionId: pricing.id },
        });
      }
      return pricing;
    });
  }

  /**
   * 只刷新指定连接的候选缓存并追加来源证据，永不写人工模型或售价。
   * 失败返回 failed 快照及稳定错误码，保留前次候选，不保存上游错误正文。
   */
  async sync(
    credentialId: string,
    actorId: string,
    sourceType: MarketplaceSourceType = 'models',
  ): Promise<MarketplaceSyncDto> {
    z.string().uuid().parse(credentialId);
    z.string().uuid().parse(actorId);
    marketplaceSourceTypeSchema.parse(sourceType);
    const pricingBaseUrl =
      sourceType === 'newapi_pricing' ? await this.pricingBaseUrl(credentialId) : undefined;
    if (sourceType !== 'newapi_pricing') await this.assertCredential(credentialId);
    const previous = await this.findSync(credentialId, sourceType, 'succeeded');
    const existing = previous
      ? readCandidates(previous.candidates)
      : sourceType === 'models'
        ? sanitizeCandidates(await this.settings.listModels(undefined, credentialId))
        : [];
    let candidates: MarketplaceCandidate[];
    try {
      candidates =
        sourceType === 'newapi_managed'
          ? await this.managedCandidates(credentialId)
          : sourceType === 'newapi_pricing'
            ? await requestNewApiPricing(pricingBaseUrl!, {
                fetchImpl: this.options.pricingFetchImpl,
              })
            : sanitizeCandidates(await this.settings.refreshModels(credentialId));
    } catch (error) {
      return syncView(
        await this.prisma.modelCatalogSync.create({
          data: {
            credentialId,
            status: 'failed',
            candidates: { sourceType, candidates: existing } as unknown as Prisma.InputJsonValue,
            missing: [],
            errorCode:
              sourceType === 'newapi_pricing'
                ? error instanceof NewApiPricingError
                  ? error.code
                  : 'upstream_pricing_unavailable'
                : 'upstream_catalog_unavailable',
            createdBy: actorId,
          },
        }),
      );
    }
    const present = new Set(candidates.map((item) => item.id));
    return syncView(
      await this.prisma.modelCatalogSync.create({
        data: {
          credentialId,
          status: 'succeeded',
          candidates: { sourceType, candidates } as unknown as Prisma.InputJsonValue,
          missing: existing.filter((item) => !present.has(item.id)).map((item) => item.id),
          createdBy: actorId,
        },
      }),
    );
  }

  /** 管理员重开页面可读取最近同步状态，包括失败后保留的候选。 */
  async getSync(
    credentialId: string,
    sourceType: MarketplaceSourceType = 'models',
  ): Promise<MarketplaceSyncDto | null> {
    z.string().uuid().parse(credentialId);
    marketplaceSourceTypeSchema.parse(sourceType);
    const row = await this.findSync(credentialId, sourceType);
    return row ? syncView(row) : null;
  }

  /** 使用所选连接的精确凭据查询受 Key 权限约束的目录，失败不回退到匿名价格。 */
  private async managedCatalog(credentialId: string) {
    await this.assertCredential(credentialId);
    const reference = await this.settings.getCredentialReference(credentialId);
    const credentials = await this.settings.getProviderCredentials?.(reference);
    if (!credentials)
      throw new ModelMarketplaceError('binding_unavailable', '无法读取模型连接凭据', 409);
    try {
      return await requestNewApiCatalog(credentials, { fetchImpl: this.options.pricingFetchImpl });
    } catch {
      throw new ModelMarketplaceError(
        'newapi_bridge_unavailable',
        'New API 联动接口不可用，请确认服务已升级、开启画布联动且当前 Key 有效',
        502,
      );
    }
  }

  /** 目录保留不可用模型及具体原因；已确认协议仍只进入白名单能力字段。 */
  private async managedCandidates(credentialId: string): Promise<MarketplaceCandidate[]> {
    const catalog = await this.managedCatalog(credentialId);
    return catalog.models.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      ...(entry.description ? { description: entry.description } : {}),
      mediaTypes: entry.media_type ? [entry.media_type] : [],
      capabilities: publicMetadata(entry.capabilities),
      limitations: publicMetadata(entry.limitations),
      refreshedAt: new Date().toISOString(),
      verification: 'unverified',
      managed: {
        available: entry.available,
        ...(entry.contract ? { contract: entry.contract } : {}),
        ...(entry.unavailable_reason ? { reason: entry.unavailable_reason } : {}),
        pricingVersion: entry.pricing_version,
      },
    }));
  }

  /**
   * 选中导入时再次读取 Key 权限和协议；稳定主键使重复导入复用商品，人工资料不覆盖。
   * 新商品自动建立绑定与跟随价格版本并发布，既有暂停状态和人工价格保持原状。
   */
  private async importManagedModel(
    source: { syncId: string; upstreamModelId: string },
    actorId: string,
  ): Promise<MarketplaceAdminModelDto> {
    const sync = await this.prisma.modelCatalogSync.findUnique({ where: { id: source.syncId } });
    if (
      !sync ||
      sync.status !== 'succeeded' ||
      syncView(sync).sourceType !== 'newapi_managed' ||
      !readCandidates(sync.candidates).some((candidate) => candidate.id === source.upstreamModelId)
    )
      throw new ModelMarketplaceError('candidate_not_found', '托管模型来源不存在或同步未成功', 404);
    const catalog = await this.managedCatalog(sync.credentialId);
    const entry = catalog.models.find((candidate) => candidate.id === source.upstreamModelId);
    if (!entry?.available || !entry.media_type || !entry.contract)
      throw new ModelMarketplaceError(
        'model_contract_unavailable',
        'New API 尚未提供此模型可用的调用合同',
        409,
      );
    const contract = marketplaceContractSchema.parse(entry.contract);
    const mediaType = toDatabaseMediaType(entry.media_type);
    assertContractMediaType(contract, mediaType);
    const reference = await this.settings.getCredentialReference(sync.credentialId);
    const capabilities = publicMetadata(entry.capabilities);
    const limitations = publicMetadata(entry.limitations);
    if (!Object.keys(capabilities).length)
      throw new ModelMarketplaceError('binding_unverified', 'New API 未返回可确认的模型能力', 409);
    const id = managedModelId(sync.credentialId, entry.id);
    const model = await this.transaction(async (transaction) => {
      let current = await transaction.platformModel.findUnique({
        where: { id },
        include: modelInclude,
      });
      if (current && current.mediaType !== mediaType)
        throw new ModelMarketplaceError(
          'binding_needs_review',
          '上游模型媒体类型已变化，请复核原模型',
          409,
        );
      if (!current)
        current = await transaction.platformModel.create({
          data: {
            id,
            name: entry.name ?? entry.id,
            description: entry.description ?? '',
            mediaType,
            sourceSyncId: sync.id,
            sourceModelId: entry.id,
            createdBy: actorId,
          },
          include: modelInclude,
        });
      const existingBinding = current.activeBinding;
      if (
        existingBinding &&
        (existingBinding.credentialId !== sync.credentialId ||
          existingBinding.upstreamModelId !== entry.id)
      )
        throw new ModelMarketplaceError(
          'binding_manually_changed',
          '此商品已切换调用连接，请在原商品中确认绑定；同步保留现有连接',
          409,
        );
      const bindingUnchanged =
        existingBinding &&
        existingBinding.credentialId === reference.credentialId &&
        existingBinding.credentialVersion === reference.credentialVersion &&
        existingBinding.upstreamModelId === entry.id &&
        existingBinding.contract === contract &&
        JSON.stringify(existingBinding.capabilities) === JSON.stringify(capabilities) &&
        JSON.stringify(existingBinding.limitations) === JSON.stringify(limitations);
      const latestBinding = bindingUnchanged
        ? existingBinding
        : await transaction.modelBinding.findFirst({
            where: { platformModelId: id },
            orderBy: { revision: 'desc' },
          });
      const binding = bindingUnchanged
        ? existingBinding
        : await transaction.modelBinding.create({
            data: {
              platformModelId: id,
              revision: (latestBinding?.revision ?? 0) + 1,
              credentialId: reference.credentialId!,
              credentialVersion: reference.credentialVersion!,
              upstreamModelId: entry.id,
              contract,
              capabilities: capabilities as Prisma.InputJsonValue,
              limitations: limitations as Prisma.InputJsonValue,
              verificationEvidence: `New API Key 作用域目录确认调用合同；价格依据 ${entry.pricing_version}`,
              verifiedAt: new Date(),
              createdBy: actorId,
            },
          });
      let pricing = current.activePrice;
      if (!pricing) {
        const latest = await transaction.pricingVersion.findFirst({
          where: { platformModelId: id },
          orderBy: { revision: 'desc' },
        });
        pricing = await transaction.pricingVersion.create({
          data: {
            platformModelId: id,
            revision: (latest?.revision ?? 0) + 1,
            currency: 'CNY',
            rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
            createdBy: actorId,
          },
        });
      }
      await this.assertReady(
        { ...current, activeBinding: binding, activePrice: pricing },
        transaction,
      );
      return transaction.platformModel.update({
        where: { id },
        data: {
          activeBindingId: binding.id,
          activePricingVersionId: pricing.id,
          status: current.status === 'paused' ? 'paused' : 'published',
          sourceSyncId: sync.id,
        },
        include: modelInclude,
      });
    });
    return this.adminView(model);
  }

  /** 公开定价只读连接地址，不调用会解密凭据的设置存储，也不改变连接和默认模型。 */
  private async pricingBaseUrl(credentialId: string): Promise<string> {
    const credential = await this.prisma.aiCredential.findUnique({
      where: { id: credentialId },
      select: { baseUrl: true, label: true, projectId: true },
    });
    if (
      !credential?.baseUrl ||
      credential.projectId ||
      ['deleted', 'independent-deleted', 'revoked'].includes(credential.label)
    )
      throw new ModelMarketplaceError('binding_unavailable', '模型连接已停用或不可用', 409);
    return credential.baseUrl;
  }

  /** JSON 来源在数据库内过滤，无回溯页数上限；旧数组只匹配 models，空候选仍保留来源。 */
  private async findSync(
    credentialId: string,
    sourceType: MarketplaceSourceType,
    status?: 'succeeded',
    createdAfter?: Date,
    database: MarketplaceDatabase = this.prisma,
  ): Promise<ModelCatalogSync | null> {
    const rows = await database.$queryRaw<ModelCatalogSync[]>(Prisma.sql`
      SELECT id, "credentialId", status, candidates, missing, "errorCode", "createdBy", "createdAt"
      FROM model_catalog_syncs
      WHERE "credentialId" = ${credentialId}::uuid
        AND (candidates->>'sourceType' = ${sourceType}
          OR (${sourceType} = 'models' AND jsonb_typeof(candidates) = 'array'))
        ${status ? Prisma.sql`AND status = ${status}` : Prisma.empty}
        ${createdAfter ? Prisma.sql`AND "createdAt" > ${createdAfter}` : Prisma.empty}
      ORDER BY "createdAt" DESC, id DESC LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * 报价入口读取平台商品及当前不可变版本，不要求模型还出现在候选目录中。
   * @throws ModelMarketplaceError 未发布、缺少价格、停用连接或能力冲突。
   */
  async resolvePublishedModel(id: string): Promise<ResolvedMarketplaceModel> {
    z.string().uuid().parse(id);
    const model = await requireModel(this.prisma, id);
    if (model.status !== 'published') {
      throw new ModelMarketplaceError('model_not_published', '模型尚未上架或已暂停', 409);
    }
    await this.assertReady(model, this.prisma);
    const { activeBinding, activePrice, ...record } = model;
    return { model: record, binding: activeBinding!, pricing: activePrice! };
  }

  /** 旧画布按精确上游 ID、可选连接和媒体解析；同名歧义必须重新选择平台模型。 */
  async resolveLegacyModel(
    modelAlias: string,
    credentialId?: string,
    mediaType?: MediaType,
  ): Promise<ResolvedMarketplaceModel> {
    z.string().min(1).max(512).parse(modelAlias);
    if (credentialId) z.string().uuid().parse(credentialId);
    if (mediaType) mediaTypeSchema.parse(mediaType);
    const models = await this.prisma.platformModel.findMany({
      where: {
        status: 'published',
        ...(mediaType ? { mediaType: toDatabaseMediaType(mediaType) } : {}),
        activeBinding: {
          is: { upstreamModelId: modelAlias, ...(credentialId ? { credentialId } : {}) },
        },
      },
      select: { id: true },
      take: 2,
    });
    if (models.length !== 1) {
      throw new ModelMarketplaceError(
        models.length ? 'model_selection_ambiguous' : 'model_not_published',
        models.length
          ? '旧模型选择对应多个商品，请重新选择平台模型'
          : '当前选择没有对应的已上架平台模型',
        409,
      );
    }
    return this.resolvePublishedModel(models[0]!.id);
  }

  /** 串行化修改防止版本号及当前指针竞态，冲突由客户端重新读取后提交。 */
  private async transaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ModelMarketplaceError(
          'model_revision_conflict',
          '模型同时被修改，请刷新后重试',
          409,
        );
      }
      throw error;
    }
  }

  /** 数据库稳定排序和总数不依赖上游目录的排序或连接状态。 */
  private async loadPage(input: MarketplaceListInput): Promise<MarketplacePage<LoadedModel>> {
    const where: Prisma.PlatformModelWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.mediaType ? { mediaType: toDatabaseMediaType(input.mediaType) } : {}),
      ...(input.query ? { name: { contains: input.query, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.platformModel.findMany({
        where,
        include: modelInclude,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.prisma.platformModel.count({ where }),
    ]);
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  /** 仅对明确业务不可用显示状态，数据库错误继续上抛而非伪装成空目录。 */
  private async publicView(model: LoadedModel): Promise<MarketplaceModelDto> {
    let availability: MarketplaceModelDto['availability'] = 'available';
    let availabilityReason: string | undefined;
    try {
      await this.assertReady(model, this.prisma);
    } catch (error) {
      if (!(error instanceof ModelMarketplaceError)) throw error;
      availability = error.code === 'binding_needs_review' ? 'needs_review' : 'unavailable';
      availabilityReason = error.message;
    }
    return {
      id: model.id,
      name: model.name,
      description: model.description,
      mediaType: model.mediaType.toLowerCase() as MediaType,
      specifications: publicMetadata(model.specifications),
      ...(model.activeBinding ? { modelAlias: model.activeBinding.upstreamModelId } : {}),
      capabilities: publicMetadata(model.activeBinding?.capabilities),
      limitations: publicMetadata(model.activeBinding?.limitations),
      pricing:
        model.activePrice &&
        model.activePrice.currency === 'CNY' &&
        marketplaceRuleSchema.safeParse(model.activePrice.rule).success
          ? publicPrice(model.activePrice)
          : null,
      availability,
      ...(availabilityReason ? { availabilityReason } : {}),
    };
  }

  /** 后台视图复用公开字段并补充人工编辑及来源状态，不暴露加密 Key。 */
  private async adminView(model: LoadedModel): Promise<MarketplaceAdminModelDto> {
    return {
      ...(await this.publicView(model)),
      specifications: model.specifications as Record<string, unknown>,
      status: model.status,
      sortOrder: model.sortOrder,
      activeBindingId: model.activeBindingId,
      activePricingVersionId: model.activePricingVersionId,
      sourceSyncId: model.sourceSyncId,
      sourceModelId: model.sourceModelId,
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
    };
  }

  /** 缺失和无效价格始终阻断发布与报价，不能被当成免费调用。 */
  private async assertReady(model: LoadedModel, database: MarketplaceDatabase): Promise<void> {
    if (!model.activeBinding || !model.activePrice) {
      throw new ModelMarketplaceError(
        'model_setup_incomplete',
        '模型需要有效调用绑定和平台售价',
        409,
      );
    }
    assertVersionOwners(
      model.id,
      model.activeBinding.id,
      model.activeBinding,
      model.activePrice.id,
      model.activePrice,
    );
    assertPriceAvailable(model.activePrice);
    assertPriceMediaType(marketplacePriceRuleSchema.parse(model.activePrice.rule), model.mediaType);
    assertContractMediaType(model.activeBinding.contract, model.mediaType);
    await this.assertBindingAvailable(model.activeBinding, database);
  }

  /** 新调用必须解析仍可选的精确连接版本；不读取或输出明文认证材料。 */
  private async assertCredential(credentialId: string, version?: number): Promise<void> {
    try {
      const reference = await this.settings.getCredentialReference(credentialId);
      if (reference.credentialId !== credentialId || !reference.credentialVersion) {
        throw new ModelMarketplaceError('binding_unavailable', '模型连接已停用或不可用', 409);
      }
      if (version !== undefined && reference.credentialVersion !== version) {
        throw new ModelMarketplaceError(
          'binding_version_changed',
          '连接版本已变化，请验证并启用新绑定',
          409,
        );
      }
    } catch (error) {
      if (error instanceof AiCredentialNotFoundError) {
        throw new ModelMarketplaceError('binding_unavailable', '模型连接已停用或不可用', 409);
      }
      throw error;
    }
  }

  /** 已核验绑定遇到更新的明确能力冲突需复核；目录缺失或刷新失败不等同下架。 */
  private async assertBindingAvailable(
    binding: ModelBinding,
    database: MarketplaceDatabase,
  ): Promise<void> {
    await this.assertCredential(binding.credentialId, binding.credentialVersion);
    const credential = await database.aiCredential.findUnique({
      where: { id: binding.credentialId },
      select: { label: true, version: true, baseUrl: true, encryptedApiKey: true },
    });
    if (
      !credential?.baseUrl ||
      !credential.encryptedApiKey ||
      ['deleted', 'independent-deleted', 'revoked'].includes(credential.label) ||
      credential.version !== binding.credentialVersion
    ) {
      throw new ModelMarketplaceError('binding_unavailable', '模型连接已停用或不可用', 409);
    }
    if (
      !binding.verificationEvidence.trim() ||
      !Object.keys(publicMetadata(binding.capabilities)).length
    ) {
      throw new ModelMarketplaceError('binding_unverified', '模型调用能力尚未验证', 409);
    }
    if (binding.verificationEvidence.startsWith('New API Key 作用域目录')) {
      const managedSource = await this.findSync(
        binding.credentialId,
        'newapi_managed',
        'succeeded',
        binding.verifiedAt,
        database,
      );
      if (managedSource) {
        const latest = readCandidates(managedSource.candidates).find(
          (entry) => entry.id === binding.upstreamModelId,
        );
        if (
          !latest?.managed?.available ||
          latest.managed.contract !== binding.contract ||
          hasConflict(binding.capabilities, latest.capabilities) ||
          hasConflict(binding.limitations, latest.limitations)
        )
          throw new ModelMarketplaceError(
            'binding_needs_review',
            'New API 模型权限或调用合同已变化，请重新同步联动',
            409,
          );
      }
    }
    const source = await this.findSync(
      binding.credentialId,
      'models',
      'succeeded',
      binding.verifiedAt,
      database,
    );
    const candidate = readCandidates(source?.candidates).find(
      (item) => item.id === binding.upstreamModelId,
    );
    if (
      candidate &&
      (hasConflict(binding.capabilities, candidate.capabilities) ||
        hasConflict(binding.limitations, candidate.limitations))
    ) {
      throw new ModelMarketplaceError(
        'binding_needs_review',
        '上游能力或限制已变化，请重新验证调用绑定',
        409,
      );
    }
  }
}

/** 候选仅作为未验证来源；价格明确为供应商参考，不得直接作为平台售价。 */
export type MarketplaceCandidate = {
  id: string;
  name: string;
  description?: string;
  vendorName?: string;
  tags?: string[];
  endpointTypes?: string[];
  mediaTypes: MediaType[];
  capabilities: Record<string, unknown>;
  limitations: Record<string, unknown>;
  providerDeclaredPrice?: Record<string, unknown>;
  pricingReference?: NewApiPricingReference;
  managed?: { available: boolean; contract?: string; pricingVersion: string; reason?: string };
  refreshedAt: string;
  verification: 'unverified';
};
/** 公开能力和规格可用字段；嵌套对象同样应用白名单，避免隐藏内部连接配置。 */
const publicMetadataKeys = new Set([
  'text',
  'image',
  'audio',
  'video',
  'parameters',
  'textParameters',
  'imageParameters',
  'audioParameters',
  'videoParameters',
  'text_parameters',
  'image_parameters',
  'audio_parameters',
  'video_parameters',
  'mediaTypes',
  'media_types',
  'mentionMediaTypes',
  'mention_media_types',
  'semanticRoles',
  'semantic_roles',
  'maxMentions',
  'max_mentions',
  'supportsMixedMentions',
  'supports_mixed_mentions',
  'modes',
  'imageEdit',
  'image_edit',
  'supportsImageEdit',
  'supported',
  'supports',
  'enabled',
  'disabled',
  'available',
  'mimeTypes',
  'mime_types',
  'size',
  'sizes',
  'quality',
  'qualities',
  'resolution',
  'resolutions',
  'aspectRatio',
  'aspectRatios',
  'aspect_ratio',
  'aspect_ratios',
  'duration',
  'durations',
  'durationSeconds',
  'duration_seconds',
  'maxDurationSeconds',
  'minDurationSeconds',
  'maxImages',
  'max_images',
  'min',
  'max',
  'step',
  'default',
  'values',
  'options',
  'items',
  'enum',
  'allowed',
  'value',
  'label',
  'description',
  'title',
  'name',
  'reasoning_effort',
  'reasoningEffort',
  'inferenceStrength',
  'inference_strength',
  'maxTokens',
  'max_tokens',
  'contextWindow',
  'context_window',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCharacters',
  'input',
  'output',
  'inputModalities',
  'outputModalities',
  'streaming',
  'tools',
  'jsonMode',
  'maxReferences',
  'maxQuantity',
  'minQuantity',
  'quantity',
  'n',
  'count',
  'seed',
  'temperature',
  'format',
  'formats',
  'output_format',
  'outputFormat',
  'voice',
  'voices',
  'speed',
  'languages',
  'sampleRate',
  'sample_rate',
  'fps',
  'width',
  'height',
  'maxWidth',
  'maxHeight',
  'fields',
]);
/** 判断递归数据是否包含凭据字段或管理 URL；字符串本身不能成为网络请求目标。 */
function containsPrivateMetadata(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === 'string')
    return /(?:https?:\/\/|\bbearer\s|\bsk-[A-Za-z0-9_-]{12,})/i.test(value);
  if (Array.isArray(value))
    return value.length > 256 || value.some((item) => containsPrivateMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /(?:apikey|api_key|authorization|credential|baseurl|base_url|endpoint|secret|password|cost|headers|url$)/i.test(
        key,
      ) || containsPrivateMetadata(item, depth + 1),
  );
}
/** 白名单投影递归剔除未知字段，普通用户响应不透传管理员提供的任意 JSON。 */
function publicMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!publicMetadataKeys.has(key)) return [];
      const safe = safeMetadataValue(item);
      return safe === undefined ? [] : [[key, safe]];
    }),
  );
}
/** 数组和标量保留展示语义；对象继续应用字段白名单。 */
function safeMetadataValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string')
    return value.length <= 4_000 && !containsPrivateMetadata(value) ? value : undefined;
  if (Array.isArray(value))
    return value
      .slice(0, 256)
      .map(safeMetadataValue)
      .filter((item) => item !== undefined);
  if (typeof value === 'object') return publicMetadata(value);
  return undefined;
}
/** 规范化候选快照；不会把目录推断的类型当成已经验证的绑定能力。 */
function sanitizeCandidates(models: ModelCatalogEntry[]): MarketplaceCandidate[] {
  if (models.length > 10_000) {
    throw new ModelMarketplaceError('catalog_too_large', '单次目录超过一万条，请缩小上游目录范围');
  }
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    mediaTypes: [...model.mediaTypes],
    capabilities: publicMetadata(model.capabilities),
    limitations: publicMetadata(model.limitations),
    ...(model.price ? { providerDeclaredPrice: providerPriceMetadata(model.price) } : {}),
    refreshedAt: model.refreshedAt,
    verification: 'unverified',
  }));
}
/** 成本参考只接受金额、币种和单位等常见标量，不保留 URL、认证头或原始响应。 */
function providerPriceMetadata(price: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'amount',
    'currency',
    'unit',
    'input',
    'output',
    'inputPrice',
    'outputPrice',
    'perRequest',
    'perSecond',
    'perImage',
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = price[key];
      return (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length < 100 && !containsPrivateMetadata(value))
        ? [[key, value]]
        : [];
    }),
  );
}
/** 只读取本服务写入的规范候选；错误形状不会被当成来源证据。 */
function readCandidates(value: unknown): MarketplaceCandidate[] {
  const candidates = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        'sourceType' in value &&
        marketplaceSourceTypeSchema.safeParse(value.sourceType).success &&
        'candidates' in value
      ? value.candidates
      : [];
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((item): item is MarketplaceCandidate =>
    Boolean(
      item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      Array.isArray(item.mediaTypes),
    ),
  );
}
/** 旧数组和新 JSON 包装统一为管理员 DTO，不把持久化内部包装泄漏给旧客户端。 */
function syncView(row: ModelCatalogSync): MarketplaceSyncDto {
  const stored = row.candidates;
  const sourceType =
    !Array.isArray(stored) &&
    stored &&
    typeof stored === 'object' &&
    marketplaceSourceTypeSchema.safeParse(stored.sourceType).success
      ? (stored.sourceType as MarketplaceSourceType)
      : 'models';
  return { ...row, sourceType, candidates: readCandidates(stored) };
}
/** 对明确重叠字段检查能力变化；新字段和缺失字段没有足够证据判为冲突。 */
function hasConflict(verified: unknown, latest: unknown): boolean {
  if (!verified || !latest || typeof verified !== 'object' || typeof latest !== 'object')
    return false;
  if (Array.isArray(verified) || Array.isArray(latest))
    return JSON.stringify(verified) !== JSON.stringify(latest);
  return Object.entries(latest).some(([key, value]) => {
    if (!Object.hasOwn(verified, key)) return false;
    const existing = (verified as Record<string, unknown>)[key];
    return existing && value && typeof existing === 'object' && typeof value === 'object'
      ? hasConflict(existing, value)
      : JSON.stringify(existing) !== JSON.stringify(value);
  });
}
/** 查找商品同时保留当前版本；调用者负责状态与权限要求。 */
async function requireModel(database: MarketplaceDatabase, id: string): Promise<LoadedModel> {
  const model = await database.platformModel.findUnique({ where: { id }, include: modelInclude });
  if (!model) throw new ModelMarketplaceError('platform_model_not_found', '平台模型不存在', 404);
  return model;
}
/** 防止把其他模型的绑定或售价指向当前商品。 */
function assertVersionOwners(
  modelId: string,
  bindingId: string | null,
  binding: ModelBinding | null,
  pricingId: string | null,
  pricing: PricingVersion | null,
): void {
  if (
    (bindingId && (!binding || binding.platformModelId !== modelId)) ||
    (pricingId && (!pricing || pricing.platformModelId !== modelId))
  ) {
    throw new ModelMarketplaceError(
      'model_version_mismatch',
      '绑定或价格版本不属于此平台模型',
      409,
    );
  }
}
/** 合同按当前适配器支持的媒体分类限制，防止人工配置把视频发到文本接口。 */
function assertContractMediaType(contract: string, mediaType: PlatformModel['mediaType']): void {
  const allowed: Record<PlatformModel['mediaType'], string[]> = {
    TEXT: ['openai-chat-completions'],
    IMAGE: ['openai-images'],
    AUDIO: ['openai-audio'],
    VIDEO: ['newapi-video-v1', 'newapi-unified-v1', 'legacy-v1'],
  };
  if (!allowed[mediaType].includes(contract))
    throw new ModelMarketplaceError('binding_contract_mismatch', '接口合同与模型媒体类型不兼容');
}
/** 固定按次可覆盖任意媒体，其他收费单位必须与可计量的媒体一致。 */
function assertPriceMediaType(
  rule: MarketplacePriceRule,
  mediaType: PlatformModel['mediaType'],
): void {
  const allowed: Record<string, PlatformModel['mediaType'][]> = {
    per_call: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
    per_image: ['IMAGE'],
    per_token: ['TEXT'],
    per_second: ['AUDIO', 'VIDEO'],
    per_character: ['AUDIO'],
    upstream_cost: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO'],
  };
  if (!allowed[rule.unit]?.includes(mediaType))
    throw new ModelMarketplaceError('pricing_unit_mismatch', '收费单位与模型媒体类型不兼容');
}
/** 已保存规则仍需复验，避免无效历史数据被解释成免费或提前生效。 */
function assertPriceAvailable(pricing: PricingVersion): void {
  if (pricing.currency !== 'CNY' || !marketplaceRuleSchema.safeParse(pricing.rule).success)
    throw new ModelMarketplaceError('pricing_invalid', '平台售价无效，请创建有效价格版本', 409);
  if (pricing.effectiveAt.getTime() > Date.now())
    throw new ModelMarketplaceError('pricing_not_effective', '价格版本尚未生效', 409);
}
/** 公开价格只使用严格规则解析后的白名单结构。 */
function publicPrice(pricing: PricingVersion): MarketplacePricingDto {
  return {
    id: pricing.id,
    revision: pricing.revision,
    currency: 'CNY',
    rule: marketplacePriceRuleSchema.parse(pricing.rule),
    effectiveAt: pricing.effectiveAt.toISOString(),
  };
}
/** Prisma 媒体枚举使用大写，HTTP 与共享领域模型使用小写。 */
function toDatabaseMediaType(mediaType: MediaType): PlatformModel['mediaType'] {
  return mediaType.toUpperCase() as PlatformModel['mediaType'];
}

/** 固定命名空间、连接和精确模型 ID 产生稳定 UUID；数据库主键约束阻止并发重复导入。 */
function managedModelId(credentialId: string, modelId: string): string {
  const value = createHash('sha256')
    .update(`newapi-managed-v1\0${credentialId}\0${modelId}`)
    .digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

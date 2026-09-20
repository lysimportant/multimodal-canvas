import { createHash } from 'node:crypto';
import {
  newApiPriceConfigSchema,
  newApiPriceModelSchema,
  newApiSquareSnapshotSchema,
  type NewApiPriceConfig,
  type NewApiPriceModel,
} from '@multimodal-canvas/domain';
import {
  createCredentialEncryptionKeyringFromEnvironment,
  type CredentialEncryptionKeyring,
} from '@multimodal-canvas/credential-crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AiSettingsStoreLike } from './settings';

/** 广场和写回错误不包含远端正文、URL 或管理凭据。 */
export class NewApiSquareError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'NewApiSquareError';
  }
}

/** 接受站点、/pricing、/api/pricing 或 /v1 地址；保留部署前缀，不跟随迁移重定向。 */
export function normalizeNewApiSquareUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new NewApiSquareError('invalid_url', '请输入有效的 New API 广场地址');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new NewApiSquareError(
      'invalid_url',
      '广场地址须为 HTTPS（本机调试可使用 HTTP），不能包含凭据、查询参数或片段',
    );
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:api\/pricing|pricing|v1)$/, '');
  return url.toString().replace(/\/$/, '');
}

/** 消除 schema 错误中的上游原值，错误日志不记录用户规则或凭据。 */
function parseSquareData<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new NewApiSquareError('invalid_square_data', '输入或上游价格格式无效，现有数据已保留');
  }
}
/** 上游原配置快照只读取目标模型；不把其他模型管理配置返回浏览器。 */
const configSchema = z
  .unknown()
  .transform((value): NewApiPriceConfig => parseSquareData(newApiPriceConfigSchema, value));
/** 工作区 Zod 版本可能不同，通过 unknown 边界复用领域校验。 */
const priceModelSchema = z
  .unknown()
  .transform((value): NewApiPriceModel => parseSquareData(newApiPriceModelSchema, value));
/** 上游配置版本必须与编辑基线一同保存。 */
const entrySchema = z.object({
  model_name: z.string().min(1).max(512),
  version: z.string().min(1).max(512),
  configured: configSchema,
  effective: configSchema,
});
/** 客户端只能编辑既有上游配置，价格草稿含本地修订和上游版本。 */
export const squareDraftInputSchema = z
  .object({
    modelName: z.string().min(1).max(512),
    expectedVersion: z.string().min(1).max(512),
    revision: z.number().int().nonnegative(),
    sourceRevision: z.number().int().positive(),
    pricing: configSchema,
  })
  .strict();
/** 上游读写传输固定路径、十秒超时、5 MiB 上限，不自动重试。 */
export async function requestNewApiSquare(
  baseUrl: string,
  path: string,
  options: {
    token?: string;
    method?: 'GET' | 'PATCH';
    body?: unknown;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 401 || response.status === 403)
      throw new NewApiSquareError(
        'upstream_permission_denied',
        'New API 管理授权无效或没有全站定价权限，请重新授权',
        403,
      );
    if (response.status === 409)
      throw new NewApiSquareError(
        'upstream_price_conflict',
        'New API 价格已被修改，草稿已保留；请读取最新价格后重新编辑',
        409,
      );
    if (!response.ok || response.redirected || !response.body)
      throw new NewApiSquareError(
        'upstream_unavailable',
        'New API 请求失败，现有目录和改价草稿已保留',
        502,
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 5 * 1024 * 1024) throw new Error('size');
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (value?.success !== true)
      throw new NewApiSquareError(
        'upstream_rejected',
        'New API 拒绝了请求，请检查管理权限和价格规则；草稿已保留',
        422,
      );
    return value;
  } catch (error) {
    if (error instanceof NewApiSquareError) throw error;
    throw new NewApiSquareError(
      'upstream_unavailable',
      'New API 请求未能确认完成，现有目录和草稿已保留；下次同步会先核对上游结果',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 深层稳定比较用于写回结果不明后的确认；不把本地哈希当作上游版本。 */
function configurationDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** 单一 URL 广场、独立加密管理授权和持久改价草稿；不参与钱包扣款。 */
export class PrismaNewApiSquare {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      fetchImpl?: typeof fetch;
      keyring?: CredentialEncryptionKeyring;
      settings?: AiSettingsStoreLike;
    } = {},
  ) {}

  /** 普通用户只读生效快照；源地址由管理员明确配置，凭据与草稿不公开。 */
  async published() {
    const source = await this.prisma.newApiPricingSource.findUnique({ where: { id: 'default' } });
    const credentials =
      source && this.options.settings ? await this.options.settings.listCredentials() : [];
    const matching = credentials.filter((credential) => {
      try {
        return normalizeNewApiSquareUrl(credential.baseUrl) === source?.baseUrl;
      } catch {
        return false;
      }
    });
    const availableModels = matching.length
      ? await this.prisma.platformModel.findMany({
          where: {
            status: 'published',
            activeBinding: { credentialId: { in: matching.map((item) => item.id) } },
          },
          select: { id: true, activeBinding: { select: { upstreamModelId: true } } },
        })
      : [];
    return {
      configured: Boolean(source),
      url: source ? `${source.baseUrl}/pricing` : null,
      snapshot: source?.snapshot
        ? parseSquareData(newApiSquareSnapshotSchema, source.snapshot)
        : null,
      availableModels: availableModels.flatMap((model) =>
        model.activeBinding
          ? [{ platformModelId: model.id, modelName: model.activeBinding.upstreamModelId }]
          : [],
      ),
    };
  }

  /** 管理员读取授权状态和草稿状态，任何路径均不回显密文或 PAT。 */
  async admin() {
    const source = await this.prisma.newApiPricingSource.findUnique({ where: { id: 'default' } });
    return {
      ...(await this.published()),
      revision: source?.revision ?? 0,
      authorized: Boolean(source?.encryptedAccessToken),
      drafts: source
        ? await this.prisma.newApiPricingDraft.findMany({
            where: { baseUrl: source.baseUrl },
            select: { modelName: true, revision: true, status: true, error: true, updatedAt: true },
          })
        : [],
    };
  }

  /** 保存前只读验证地址与新授权；域名改变永不携带旧站 PAT，旧站草稿仍保留。 */
  async configure(input: unknown) {
    const parsed = z
      .object({
        url: z.string().min(1).max(2048),
        revision: z.number().int().nonnegative(),
        accessToken: z
          .string()
          .trim()
          .min(1)
          .max(4096)
          .refine((value) => !/[\s\r\n]/.test(value))
          .optional(),
        removeAuthorization: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const baseUrl = normalizeNewApiSquareUrl(parsed.url);
    const original = await this.prisma.newApiPricingSource.findUnique({ where: { id: 'default' } });
    if ((original?.revision ?? 0) !== parsed.revision)
      throw new NewApiSquareError('source_conflict', '广场来源已更改，请刷新后重试', 409);
    const snapshot =
      parsed.removeAuthorization && original?.baseUrl === baseUrl && original.snapshot
        ? parseSquareData(newApiSquareSnapshotSchema, original.snapshot)
        : await this.readPublic(baseUrl);
    if (parsed.accessToken)
      await this.readEntry(baseUrl, parsed.accessToken, snapshot.models[0]?.model_name);
    const ciphertext = parsed.accessToken ? this.keyring().encrypt(parsed.accessToken) : undefined;
    await this.prisma.$transaction(async (transaction) => {
      const previous = await transaction.newApiPricingSource.findUnique({
        where: { id: 'default' },
      });
      if ((previous?.revision ?? 0) !== parsed.revision)
        throw new NewApiSquareError('source_conflict', '广场来源已更改，请刷新后重试', 409);
      const encryptedAccessToken = parsed.removeAuthorization
        ? null
        : (ciphertext ?? (previous?.baseUrl === baseUrl ? previous.encryptedAccessToken : null));
      if (previous) {
        const result = await transaction.newApiPricingSource.updateMany({
          where: { id: 'default', revision: parsed.revision },
          data: {
            baseUrl,
            snapshot: snapshot as Prisma.InputJsonValue,
            encryptedAccessToken,
            revision: { increment: 1 },
          },
        });
        if (!result.count)
          throw new NewApiSquareError('source_conflict', '广场来源已更改，请刷新后重试', 409);
      } else
        await transaction.newApiPricingSource.create({
          data: { baseUrl, encryptedAccessToken, snapshot: snapshot as Prisma.InputJsonValue },
        });
    });
    return this.admin();
  }

  /** 读取目标模型当前完整配置；草稿继续关联原基线，冲突不会被新读取掩盖。 */
  async edit(modelName: string) {
    const source = await this.source();
    this.assertCatalogModel(source.snapshot, modelName);
    const entry = await this.readEntry(
      source.baseUrl,
      this.token(source.encryptedAccessToken),
      modelName,
    );
    const draft = await this.prisma.newApiPricingDraft.findUnique({
      where: { baseUrl_modelName: { baseUrl: source.baseUrl, modelName } },
    });
    const pending = draft && draft.status !== 'synced' ? draft : null;
    return {
      modelName,
      sourceRevision: source.revision,
      version: pending?.expectedVersion ?? entry.version,
      latestVersion: entry.version,
      configured: pending
        ? parseSquareData(newApiPriceConfigSchema, pending.pricing)
        : entry.configured,
      effective: entry.effective,
      baseline: pending
        ? parseSquareData(newApiPriceConfigSchema, pending.baseline)
        : entry.configured,
      revision: draft?.revision ?? 0,
      status: pending?.status ?? 'clean',
      error: pending?.error ?? null,
    };
  }

  /** 草稿只持久化原站配置；并发编辑使用修订校验，保存不会调用 PATCH 或改变结算。 */
  async saveDraft(input: unknown, actorId: string) {
    const parsed = squareDraftInputSchema.parse(input);
    const source = await this.source();
    if (source.revision !== parsed.sourceRevision)
      throw new NewApiSquareError('source_conflict', '广场来源或授权已变更，请重新打开编辑器', 409);
    this.assertCatalogModel(source.snapshot, parsed.modelName);
    const entry = await this.readEntry(
      source.baseUrl,
      this.token(source.encryptedAccessToken),
      parsed.modelName,
    );
    if (entry.version !== parsed.expectedVersion)
      throw new NewApiSquareError(
        'upstream_price_conflict',
        'New API 价格已变化，请重新读取后再修改',
        409,
      );
    await this.prisma.$transaction(async (transaction) => {
      const currentSource = await transaction.newApiPricingSource.findUnique({
        where: { id: 'default' },
      });
      if (currentSource?.revision !== parsed.sourceRevision)
        throw new NewApiSquareError(
          'source_conflict',
          '广场来源或授权已变更，请重新打开编辑器',
          409,
        );
      const where = { baseUrl_modelName: { baseUrl: source.baseUrl, modelName: parsed.modelName } };
      const previous = await transaction.newApiPricingDraft.findUnique({ where });
      if (
        (previous?.revision ?? 0) !== parsed.revision ||
        (previous?.status === 'syncing' && previous.updatedAt.getTime() > Date.now() - 120000)
      )
        throw new NewApiSquareError(
          'draft_conflict',
          '价格正在同步或已被其他管理员修改，请刷新后重试',
          409,
        );
      const data = {
        expectedVersion: entry.version,
        baseline: entry.configured as Prisma.InputJsonValue,
        pricing: parsed.pricing as Prisma.InputJsonValue,
        createdBy: actorId,
        status: 'pending',
        error: null,
      };
      if (previous) {
        const updated = await transaction.newApiPricingDraft.updateMany({
          where: { id: previous.id, revision: parsed.revision, updatedAt: previous.updatedAt },
          data: { ...data, revision: { increment: 1 } },
        });
        if (!updated.count)
          throw new NewApiSquareError('draft_conflict', '草稿已变化，请刷新后重试', 409);
      } else
        await transaction.newApiPricingDraft.create({
          data: { ...data, baseUrl: source.baseUrl, modelName: parsed.modelName },
        });
    });
    return {
      modelName: parsed.modelName,
      sourceRevision: source.revision,
      version: entry.version,
      latestVersion: entry.version,
      configured: parsed.pricing,
      effective: entry.effective,
      baseline: entry.configured,
      revision: parsed.revision + 1,
      status: 'pending',
      error: null,
    };
  }

  /** 只删除指定修订的本地草稿；同步中的记录不可撤销，生效上游价格保持不变。 */
  async discard(modelName: string, revision: number, sourceRevision: number) {
    const source = await this.source();
    if (source.revision !== sourceRevision)
      throw new NewApiSquareError('source_conflict', '广场来源或授权已变更，请重新打开编辑器', 409);
    this.assertCatalogModel(source.snapshot, modelName);
    // 先确认可读取最新价格；离线时保留草稿，避免删除已成功却向用户报告失败。
    const entry = await this.readEntry(
      source.baseUrl,
      this.token(source.encryptedAccessToken),
      modelName,
    );
    const result = await this.prisma.newApiPricingDraft.deleteMany({
      where: {
        baseUrl: source.baseUrl,
        modelName,
        revision,
        OR: [{ status: { not: 'syncing' } }, { updatedAt: { lt: new Date(Date.now() - 120000) } }],
      },
    });
    if (!result.count)
      throw new NewApiSquareError('draft_conflict', '草稿已更改或正在同步，请刷新后重试', 409);
    return {
      modelName,
      sourceRevision: source.revision,
      version: entry.version,
      latestVersion: entry.version,
      configured: entry.configured,
      effective: entry.effective,
      baseline: entry.configured,
      revision: 0,
      status: 'clean',
      error: null,
    };
  }

  /** 显式同步先逐项核对并写回草稿，再拉取整个广场；部分失败保留状态，不盲目重发。 */
  async sync(sourceRevision: number) {
    const source = await this.source();
    if (source.revision !== sourceRevision)
      throw new NewApiSquareError(
        'source_conflict',
        '广场来源或授权已变更，请刷新后重新确认同步',
        409,
      );
    const drafts = await this.prisma.newApiPricingDraft.findMany({
      where: { baseUrl: source.baseUrl, status: { not: 'synced' } },
      orderBy: { modelName: 'asc' },
    });
    const results: Array<{ modelName: string; status: string; message?: string }> = [];
    for (const draft of drafts) {
      // 用领取时间区分同一修订的恢复尝试，超时旧进程不能覆盖新尝试的状态。
      const claimedAt = new Date();
      const claimed = await this.prisma.newApiPricingDraft.updateMany({
        where: {
          id: draft.id,
          revision: draft.revision,
          updatedAt: draft.updatedAt,
          status: { not: 'synced' },
          OR: [
            { status: { not: 'syncing' } },
            { updatedAt: { lt: new Date(Date.now() - 120000) } },
          ],
        },
        data: { status: 'syncing', error: null, updatedAt: claimedAt },
      });
      if (!claimed.count) {
        results.push({
          modelName: draft.modelName,
          status: 'syncing',
          message: '另一次同步正在处理该价格',
        });
        continue;
      }
      try {
        const currentSource = await this.source();
        if (currentSource.revision !== source.revision)
          throw new NewApiSquareError('source_conflict', '来源或授权已更改，请重新同步', 409);
        const token = this.token(currentSource.encryptedAccessToken);
        const current = await this.readEntry(source.baseUrl, token, draft.modelName);
        const desired = parseSquareData(newApiPriceConfigSchema, draft.pricing);
        if (configurationDigest(current.configured) !== configurationDigest(desired)) {
          if (current.version !== draft.expectedVersion)
            throw new NewApiSquareError(
              'upstream_price_conflict',
              'New API 价格已改变；草稿保留，请读取最新价格重新编辑',
              409,
            );
          await requestNewApiSquare(source.baseUrl, '/api/option/model_pricing', {
            token,
            method: 'PATCH',
            fetchImpl: this.options.fetchImpl,
            body: {
              changes: [
                {
                  model_name: draft.modelName,
                  expected_version: draft.expectedVersion,
                  pricing: desired,
                },
              ],
            },
          });
          const confirmed = await this.readEntry(source.baseUrl, token, draft.modelName);
          if (configurationDigest(confirmed.configured) !== configurationDigest(desired))
            throw new NewApiSquareError(
              'write_unconfirmed',
              '写回后的价格未能确认一致，草稿保留',
              409,
            );
        }
        const completed = await this.prisma.newApiPricingDraft.updateMany({
          where: {
            id: draft.id,
            revision: draft.revision,
            status: 'syncing',
            updatedAt: claimedAt,
          },
          data: { status: 'synced', error: null },
        });
        results.push(
          completed.count
            ? { modelName: draft.modelName, status: 'synced' }
            : {
                modelName: draft.modelName,
                status: 'syncing',
                message: '价格由另一次同步接管，请刷新查看结果',
              },
        );
      } catch (error) {
        const message =
          error instanceof NewApiSquareError ? error.message : '价格同步失败，草稿已保留';
        const status =
          error instanceof NewApiSquareError && error.status === 409 ? 'conflict' : 'failed';
        await this.prisma.newApiPricingDraft.updateMany({
          where: {
            id: draft.id,
            revision: draft.revision,
            status: 'syncing',
            updatedAt: claimedAt,
          },
          data: { status, error: message },
        });
        results.push({ modelName: draft.modelName, status, message });
      }
    }
    const snapshot = await this.readPublic(source.baseUrl);
    const refreshed = await this.prisma.newApiPricingSource.updateMany({
      where: { id: 'default', revision: source.revision },
      data: { snapshot: snapshot as Prisma.InputJsonValue },
    });
    if (!refreshed.count)
      throw new NewApiSquareError(
        'source_conflict',
        '来源已更改，请重新同步；原站写回结果保存在对应草稿中',
        409,
      );
    return { ...(await this.admin()), results };
  }

  /** 新站点目录和状态均匿名读取，状态缺汇率时仅保留 USD，绝不假设换算率。 */
  private async readPublic(baseUrl: string) {
    const payload = z
      .object({
        success: z.literal(true),
        data: z.array(priceModelSchema).max(20000),
        group_ratio: z.record(z.number().finite().nonnegative()),
        vendors: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
      })
      .parse(
        await requestNewApiSquare(baseUrl, '/api/pricing', { fetchImpl: this.options.fetchImpl }),
      );
    if (new Set(payload.data.map((item) => item.model_name)).size !== payload.data.length)
      throw new NewApiSquareError('invalid_catalog', '广场返回重复模型，已保留原目录', 502);
    let usdToCny: number | null = null;
    let displayCurrency: 'USD' | 'CNY' = 'USD';
    try {
      const status = z
        .object({
          data: z.object({
            usd_exchange_rate: z.number().positive().finite(),
            quota_display_type: z.string().optional(),
          }),
        })
        .parse(
          await requestNewApiSquare(baseUrl, '/api/status', { fetchImpl: this.options.fetchImpl }),
        );
      usdToCny = status.data.usd_exchange_rate;
      displayCurrency = status.data.quota_display_type === 'CNY' ? 'CNY' : 'USD';
    } catch {
      /* 状态并非公开价格的必需接口；未知汇率保持为空，界面仅展示 USD。 */
    }
    return parseSquareData(newApiSquareSnapshotSchema, {
      models: payload.data.map((item) => ({
        ...item,
        vendor_name:
          payload.vendors?.find((vendor) => vendor.id === item.vendor_id)?.name ?? item.vendor_name,
        group_ratio: Object.fromEntries(
          item.enable_groups
            .filter((group) => payload.group_ratio[group] !== undefined)
            .map((group) => [group, payload.group_ratio[group]]),
        ),
      })),
      usdToCny,
      displayCurrency,
      fetchedAt: new Date().toISOString(),
    });
  }

  /** 固定读取模型级管理接口，RootAuth 在 New API 服务端校验；普通 Key 无法代替 PAT。 */
  private async readEntry(baseUrl: string, token: string, modelName?: string) {
    const payload = z
      .object({ data: z.object({ entries: z.array(entrySchema).max(20000) }) })
      .parse(
        await requestNewApiSquare(
          baseUrl,
          `/api/option/model_pricing${modelName ? `?model=${encodeURIComponent(modelName)}` : ''}`,
          { token, fetchImpl: this.options.fetchImpl },
        ),
      );
    const entry = modelName
      ? payload.data.entries.find((item) => item.model_name === modelName)
      : payload.data.entries[0];
    if (!entry)
      throw new NewApiSquareError('model_missing', 'New API 未返回此模型的可编辑价格', 404);
    return entry;
  }
  /** 来源缺失必须显式配置，不从浏览器请求推断收费站点。 */
  private async source() {
    const source = await this.prisma.newApiPricingSource.findUnique({ where: { id: 'default' } });
    if (!source) throw new NewApiSquareError('source_required', '请先保存 New API 广场地址', 409);
    return source;
  }
  /** 编辑仅开放给已同步目录里的精确模型 ID，不接受其他后台模型名称。 */
  private assertCatalogModel(snapshot: unknown, name: string) {
    if (
      !parseSquareData(newApiSquareSnapshotSchema, snapshot).models.some(
        (item) => item.model_name === name,
      )
    )
      throw new NewApiSquareError('model_missing', '模型不在当前广场目录内，请先同步', 404);
  }
  /** 延迟读取共享密钥环，单纯读广场不要求管理授权。 */
  private keyring() {
    return this.options.keyring ?? createCredentialEncryptionKeyringFromEnvironment();
  }
  /** 管理令牌只存在服务端内存，不复用模型调用连接。 */
  private token(ciphertext: string | null) {
    if (!ciphertext)
      throw new NewApiSquareError(
        'authorization_required',
        '请先授权 New API 管理访问令牌，再修改或写回价格',
        409,
      );
    return this.keyring().decrypt(ciphertext).plaintext;
  }
}

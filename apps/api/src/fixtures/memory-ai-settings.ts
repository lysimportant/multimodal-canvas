import { createHash, randomUUID } from 'node:crypto';

import { mediaTypes, type MediaType, type ModelSelection } from '@multimodal-canvas/domain';
import { sanitizeExceptionForObservability } from '@multimodal-canvas/observability';
import { normalizeNewApiBaseUrl } from '@multimodal-canvas/providers';

import {
  AiCredentialNotFoundError,
  AiSettingsError,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  normalizeModelsPayload,
  normalizeProviderTimeout,
  type AiCredentialSummary,
  type AiSettings,
  type AiSettingsStoreLike,
  type CredentialReference,
  type ModelCatalogEntry,
  type ProviderCredentials,
  type UpdateAiSettingsInput,
} from '../settings';

const LEGACY_CATALOG_KEY = '__legacy__';
const DEFAULT_MODEL_RESPONSE_BYTES = 50 * 1024 * 1024;

/** 内存设置替身的网络边界配置；仅测试代码可以导入本模块。 */
export type MemoryAiSettingsStoreOptions = {
  fetchImpl?: typeof fetch;
  onTestConnectionError?: (error: Error) => void;
  modelRequestTimeoutMs?: number;
  modelRequestMaxAttempts?: number;
  modelRequestRetryDelayMs?: number;
  modelRequestMaxResponseBytes?: number;
};

type MemoryUpdateInput = UpdateAiSettingsInput & {
  baseUrl?: string;
  apiKey?: string;
  activate?: boolean;
};

type CredentialRecord = ProviderCredentials & {
  id: string;
  version: number;
  keyFingerprint: string;
  updatedAt: string;
  defaultModels: Partial<Record<MediaType, ModelSelection>>;
  independent: boolean;
};

type MemoryAiSettings = AiSettings & {
  baseUrl: string;
  keyFingerprint?: string;
  keySuffix?: string;
};

type MemoryAiCredentialSummary = AiCredentialSummary & {
  baseUrl: string;
  keyFingerprint: string;
  keySuffix?: string;
};

/**
 * API 单测使用的内存模型目录与合成凭据替身。
 *
 * 该类不被生产入口导入；它保留旧测试需要的目录构造和冻结版本行为，避免重新引入
 * 全局 Key 持久化产品。凭据只存在于当前测试进程内。
 */
export class MemoryAiSettingsStore implements AiSettingsStoreLike {
  private baseUrl = '';
  private apiKey = '';
  private defaultModels: Partial<Record<MediaType, ModelSelection>> = {};
  private timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS;
  private updatedAt = new Date().toISOString();
  private activeCredentialId?: string;
  private version = 0;
  private readonly credentials = new Map<string, CredentialRecord>();
  private readonly credentialHistory = new Map<string, ProviderCredentials>();
  private readonly deletedCredentialIds = new Set<string>();
  private readonly catalogs = new Map<string, Map<string, ModelCatalogEntry>>();
  private readonly refreshQueues = new Map<string, Promise<void>>();
  private readonly fetchImpl?: typeof fetch;
  private readonly onTestConnectionError?: (error: Error) => void;
  private readonly modelRequestTimeoutMs: number;
  private readonly modelRequestMaxAttempts: number;
  private readonly modelRequestRetryDelayMs: number;
  private readonly modelRequestMaxResponseBytes: number;

  /**
   * @param _syntheticSecret 兼容既有测试构造签名；内存替身不持久化或加密数据。
   * @param options 可注入的合成网络边界。
   */
  constructor(
    _syntheticSecret = 'memory-ai-settings-test-only',
    options: MemoryAiSettingsStoreOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl;
    this.onTestConnectionError = options.onTestConnectionError;
    this.modelRequestTimeoutMs = options.modelRequestTimeoutMs ?? 10_000;
    this.modelRequestMaxAttempts = Math.min(
      10,
      Math.max(1, Math.floor(options.modelRequestMaxAttempts ?? 10)),
    );
    this.modelRequestRetryDelayMs = Math.max(
      0,
      Math.floor(options.modelRequestRetryDelayMs ?? 250),
    );
    this.modelRequestMaxResponseBytes = positiveByteLimit(
      options.modelRequestMaxResponseBytes ?? process.env.NEW_API_MAX_RESPONSE_BYTES,
      DEFAULT_MODEL_RESPONSE_BYTES,
    );
  }

  /** 返回不会包含 API Key 明文的当前设置。 */
  get(): MemoryAiSettings {
    return {
      baseUrl: this.baseUrl,
      configured: Boolean(this.baseUrl && this.apiKey),
      ...(this.apiKey ? { keyFingerprint: fingerprint(this.apiKey) } : {}),
      ...(this.apiKey && safeKeySuffix(this.apiKey)
        ? { keySuffix: safeKeySuffix(this.apiKey) }
        : {}),
      defaultModels: cloneDefaults(this.defaultModels),
      timeoutMs: this.timeoutMs,
      updatedAt: this.updatedAt,
    };
  }

  /** 更新测试偏好，或为旧测试构造仅驻留内存的合成凭据。 */
  update(input: MemoryUpdateInput): MemoryAiSettings & { createdCredentialId?: string } {
    const nextTimeout =
      input.timeoutMs === undefined ? undefined : normalizeProviderTimeout(input.timeoutMs);
    if (input.activate === false) return this.createIndependentCredential(input);

    const nextBaseUrl = input.baseUrl?.replace(/\/$/, '') ?? this.baseUrl;
    const nextApiKey = input.apiKey ?? this.apiKey;
    const providerChanged = nextBaseUrl !== this.baseUrl || nextApiKey !== this.apiKey;
    let changed = providerChanged;

    if (input.defaultModels) {
      const nextDefaults = applyDefaults(this.defaultModels, input.defaultModels);
      if (!sameDefaults(nextDefaults, this.defaultModels)) {
        this.defaultModels = nextDefaults;
        changed = true;
      }
    }
    if (nextTimeout !== undefined && nextTimeout !== this.timeoutMs) {
      this.timeoutMs = nextTimeout;
      changed = true;
    }
    if (!changed) return this.get();

    const previousCredentialId = this.activeCredentialId;
    this.baseUrl = nextBaseUrl;
    this.apiKey = nextApiKey;
    this.updatedAt = new Date().toISOString();
    if (providerChanged && this.baseUrl && this.apiKey) {
      const record = this.createCredential(this.baseUrl, this.apiKey, false, this.defaultModels);
      this.activeCredentialId = record.id;
      if (previousCredentialId) this.copyModels(previousCredentialId, record.id);
    } else if (providerChanged) {
      this.activeCredentialId = undefined;
    } else {
      this.updateActiveDefaults();
    }
    return this.get();
  }

  /** 列出测试进程内仍可用于新任务的凭据摘要。 */
  listCredentials(): MemoryAiCredentialSummary[] {
    return [...this.credentials.values()]
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.version - left.version,
      )
      .map((credential) => ({
        id: credential.id,
        version: credential.version,
        group: credential.baseUrl,
        status: 'active',
        baseUrl: credential.baseUrl,
        keyFingerprint: credential.keyFingerprint,
        ...(safeKeySuffix(credential.apiKey)
          ? { keySuffix: safeKeySuffix(credential.apiKey) }
          : {}),
        updatedAt: credential.updatedAt,
        active: credential.id === this.activeCredentialId,
        ...(Object.keys(credential.defaultModels).length > 0
          ? { defaultModels: cloneDefaults(credential.defaultModels) }
          : {}),
      }));
  }

  /** 更新指定合成凭据的测试默认模型。 */
  updateCredentialDefaults(
    credentialId: string,
    defaults: Partial<Record<MediaType, string | ModelSelection | null>>,
  ): MemoryAiCredentialSummary[] | undefined {
    const credential = this.credentials.get(credentialId);
    if (!credential) return undefined;
    const next = applyDefaults(credential.defaultModels, defaults);
    credential.defaultModels = next;
    credential.updatedAt = new Date().toISOString();
    if (credentialId === this.activeCredentialId) {
      this.defaultModels = cloneDefaults(next);
      this.updatedAt = credential.updatedAt;
    }
    return this.listCredentials();
  }

  /** 激活指定合成凭据，并创建新的冻结版本。 */
  activateCredential(credentialId: string): MemoryAiSettings | undefined {
    const credential = this.credentials.get(credentialId);
    if (!credential) return undefined;
    this.baseUrl = credential.baseUrl;
    this.apiKey = credential.apiKey;
    this.defaultModels = cloneDefaults(credential.defaultModels);
    this.updatedAt = new Date().toISOString();
    const active = this.createCredential(
      credential.baseUrl,
      credential.apiKey,
      false,
      credential.defaultModels,
    );
    this.activeCredentialId = active.id;
    this.copyModels(credentialId, active.id);
    return this.get();
  }

  /** 清除活动引用，保留已冻结任务读取所需的历史版本。 */
  removeCredentials(): MemoryAiSettings {
    this.baseUrl = '';
    this.apiKey = '';
    this.activeCredentialId = undefined;
    this.updatedAt = new Date().toISOString();
    return this.get();
  }

  /** 删除测试凭据的新任务可见性，保留精确历史引用。 */
  removeCredential(credentialId: string): MemoryAiSettings | undefined {
    const target = this.credentials.get(credentialId);
    if (!target) return undefined;
    for (const [id, credential] of this.credentials) {
      if (
        credential.baseUrl !== target.baseUrl ||
        credential.keyFingerprint !== target.keyFingerprint
      ) {
        continue;
      }
      this.credentials.delete(id);
      this.deletedCredentialIds.add(id);
      this.catalogs.delete(id);
      if (this.activeCredentialId === id) this.removeCredentials();
    }
    return this.get();
  }

  /** 判断指定合成凭据能否用于新任务。 */
  hasCredential(credentialId: string): boolean {
    const credential = this.credentials.get(credentialId);
    return Boolean(credential && (credential.independent || this.get().configured));
  }

  /** 测试合成连接并返回稳定、无敏感信息的结果。 */
  async testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
    if (!this.baseUrl || !this.apiKey) return { ok: false, error: 'New API 地址和 Key 尚未配置' };
    try {
      const models = await this.requestModels(this.baseUrl, this.apiKey);
      return { ok: true, modelCount: models.length };
    } catch (error) {
      const diagnostic = sanitizeExceptionForObservability(error);
      try {
        this.onTestConnectionError?.(diagnostic);
      } catch {
        // 测试诊断钩子不能改变稳定的客户端错误合同。
      }
      return { ok: false, error: '连接失败' };
    }
  }

  /** 刷新指定合成凭据的目录；失败时保留原目录。 */
  async refreshModels(credentialId?: string): Promise<ModelCatalogEntry[]> {
    const resolvedId = credentialId ?? this.activeCredentialId;
    if (credentialId && !this.hasCredential(credentialId)) {
      throw new AiCredentialNotFoundError(credentialId);
    }
    const credential = resolvedId ? this.credentials.get(resolvedId) : undefined;
    const provider: ProviderCredentials | undefined = credential
      ? { baseUrl: credential.baseUrl, apiKey: credential.apiKey }
      : this.baseUrl && this.apiKey
        ? { baseUrl: this.baseUrl, apiKey: this.apiKey }
        : undefined;
    if (!provider || !resolvedId) throw new Error('New API 地址和 Key 尚未配置');
    return this.enqueueRefresh(resolvedId, async () => {
      const models = await this.requestModels(provider.baseUrl, provider.apiKey);
      this.replaceModels(models, resolvedId);
      return this.listModels(undefined, resolvedId);
    });
  }

  /** 直接替换测试目录；用于构造无需网络的业务回归。 */
  replaceModels(models: ModelCatalogEntry[], credentialId?: string): void {
    const resolvedId = credentialId ?? this.activeCredentialId;
    const normalized = normalizeModelsPayload({ data: models });
    this.catalogs.set(
      resolvedId ?? LEGACY_CATALOG_KEY,
      new Map(
        normalized.map((model) => [
          model.id,
          {
            ...model,
            ...(resolvedId ? { credentialId: resolvedId } : {}),
          },
        ]),
      ),
    );
  }

  /** 读取指定媒体类型和凭据范围的测试目录。 */
  listModels(mediaType?: MediaType, credentialId?: string): ModelCatalogEntry[] {
    if (credentialId && this.deletedCredentialIds.has(credentialId)) {
      throw new AiCredentialNotFoundError(credentialId);
    }
    const catalog =
      this.catalogs.get(credentialId ?? this.activeCredentialId ?? LEGACY_CATALOG_KEY) ??
      (credentialId === undefined ? this.catalogs.get(LEGACY_CATALOG_KEY) : undefined);
    return [...(catalog?.values() ?? [])].filter(
      (model) => !mediaType || model.mediaTypes.includes(mediaType),
    );
  }

  /** 解析测试显式模型或默认模型，并校验已有目录的媒体能力。 */
  resolveModel(mediaType: MediaType, requestedAlias?: string): string {
    const alias =
      requestedAlias ?? this.defaultModels[mediaType]?.modelAlias ?? `mock-${mediaType}`;
    if (alias.startsWith('mock-')) return alias;
    const catalog = this.listModels();
    if (catalog.length > 0 && !this.listModels(mediaType).some((model) => model.id === alias)) {
      throw new AiSettingsError('model_unavailable', `模型 ${alias} 不支持 ${mediaType} 媒体类型`);
    }
    return alias;
  }

  /** 返回指定合成凭据或当前活动凭据的冻结引用。 */
  getCredentialReference(credentialId?: string): CredentialReference {
    if (credentialId) {
      if (!this.hasCredential(credentialId)) throw new AiCredentialNotFoundError(credentialId);
      const credential = this.credentials.get(credentialId)!;
      return { credentialId: credential.id, credentialVersion: credential.version };
    }
    const active = this.activeCredentialId
      ? this.credentials.get(this.activeCredentialId)
      : undefined;
    return active ? { credentialId: active.id, credentialVersion: active.version } : {};
  }

  /** 按冻结 ID/版本读取测试进程内的合成凭据。 */
  getProviderCredentials(reference?: CredentialReference): ProviderCredentials | undefined {
    if (reference?.credentialId || reference?.credentialVersion) {
      if (!reference.credentialId || !reference.credentialVersion) return undefined;
      const historical = this.credentialHistory.get(
        referenceKey({
          credentialId: reference.credentialId,
          credentialVersion: reference.credentialVersion,
        }),
      );
      return historical ? { ...historical } : undefined;
    }
    return this.baseUrl && this.apiKey ? { baseUrl: this.baseUrl, apiKey: this.apiKey } : undefined;
  }

  private createIndependentCredential(
    input: MemoryUpdateInput,
  ): MemoryAiSettings & { createdCredentialId: string } {
    if (!input.apiKey?.trim()) throw new TypeError('apiKey is required when activate is false');
    if (input.defaultModels !== undefined || input.timeoutMs !== undefined) {
      throw new TypeError('independent credentials cannot update defaults or timeout');
    }
    const baseUrl = (input.baseUrl ?? this.baseUrl).trim().replace(/\/$/, '');
    if (!baseUrl) throw new TypeError('baseUrl is required when activate is false');
    const keyFingerprint = fingerprint(input.apiKey);
    const existing = [...this.credentials.values()].find(
      (credential) =>
        credential.independent &&
        credential.baseUrl === baseUrl &&
        credential.keyFingerprint === keyFingerprint,
    );
    if (existing) return { ...this.get(), createdCredentialId: existing.id };
    const credential = this.createCredential(baseUrl, input.apiKey, true, {});
    return { ...this.get(), createdCredentialId: credential.id };
  }

  private createCredential(
    baseUrl: string,
    apiKey: string,
    independent: boolean,
    defaultModels: Partial<Record<MediaType, ModelSelection>>,
  ): CredentialRecord {
    const record: CredentialRecord = {
      id: randomUUID(),
      version: ++this.version,
      baseUrl,
      apiKey,
      keyFingerprint: fingerprint(apiKey),
      updatedAt: new Date().toISOString(),
      defaultModels: cloneDefaults(defaultModels),
      independent,
    };
    this.credentials.set(record.id, record);
    this.credentialHistory.set(
      referenceKey({ credentialId: record.id, credentialVersion: record.version }),
      { baseUrl, apiKey },
    );
    return record;
  }

  private updateActiveDefaults(): void {
    if (!this.activeCredentialId) return;
    const active = this.credentials.get(this.activeCredentialId);
    if (!active) return;
    active.defaultModels = cloneDefaults(this.defaultModels);
    active.updatedAt = this.updatedAt;
  }

  private copyModels(sourceCredentialId: string, targetCredentialId: string): void {
    if (sourceCredentialId === targetCredentialId) return;
    const source = this.catalogs.get(sourceCredentialId);
    if (!source) return;
    this.catalogs.set(
      targetCredentialId,
      new Map(
        [...source.entries()].map(([id, model]) => [
          id,
          { ...model, credentialId: targetCredentialId },
        ]),
      ),
    );
  }

  private async requestModels(baseUrl: string, apiKey: string): Promise<ModelCatalogEntry[]> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const endpoint = `${normalizeNewApiBaseUrl(baseUrl)}/models`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.modelRequestMaxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.modelRequestTimeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`New API model request failed with ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text) > this.modelRequestMaxResponseBytes) {
          throw new Error('New API model response exceeds the configured byte limit');
        }
        return normalizeModelsPayload(JSON.parse(text) as unknown);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.modelRequestMaxAttempts && this.modelRequestRetryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.modelRequestRetryDelayMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('New API model request failed');
  }

  private enqueueRefresh<T>(credentialId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.refreshQueues.get(credentialId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.refreshQueues.set(credentialId, settled);
    void settled.finally(() => {
      if (this.refreshQueues.get(credentialId) === settled) this.refreshQueues.delete(credentialId);
    });
    return result;
  }
}

function applyDefaults(
  current: Partial<Record<MediaType, ModelSelection>>,
  update: Partial<Record<MediaType, string | ModelSelection | null>>,
): Partial<Record<MediaType, ModelSelection>> {
  const next = cloneDefaults(current);
  for (const mediaType of mediaTypes) {
    const value = update[mediaType];
    if (value === undefined) continue;
    if (value === null || value === '') delete next[mediaType];
    else next[mediaType] = typeof value === 'string' ? { modelAlias: value } : { ...value };
  }
  return next;
}

function cloneDefaults(
  defaults: Partial<Record<MediaType, ModelSelection>>,
): Partial<Record<MediaType, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(defaults).map(([mediaType, selection]) => [mediaType, { ...selection }]),
  ) as Partial<Record<MediaType, ModelSelection>>;
}

function sameDefaults(
  left: Partial<Record<MediaType, ModelSelection>>,
  right: Partial<Record<MediaType, ModelSelection>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeKeySuffix(apiKey: string): string | undefined {
  const visibleLength = apiKey.length > 8 ? 8 : Math.min(4, Math.floor(apiKey.length / 2));
  return visibleLength ? apiKey.slice(-visibleLength) : undefined;
}

function referenceKey(reference: Required<CredentialReference>): string {
  return `${reference.credentialId}:${reference.credentialVersion}`;
}

function positiveByteLimit(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

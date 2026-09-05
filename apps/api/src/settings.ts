import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  CredentialEncryptionKeyring,
  createCredentialEncryptionKeyringFromEnvironment,
} from '@multimodal-canvas/credential-crypto';
import { mediaTypes, type MediaType, type ModelSelection } from '@multimodal-canvas/domain';
import { sanitizeExceptionForObservability } from '@multimodal-canvas/observability';
import { normalizeNewApiBaseUrl } from '@multimodal-canvas/providers';
import { Prisma, PrismaClient, type ModelCatalog } from '@prisma/client';

export type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string | ModelSelection>>;
  updatedAt: string;
};

export type AiCredentialSummary = {
  id: string;
  baseUrl: string;
  keyFingerprint: string;
  updatedAt: string;
  active: boolean;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  mediaTypes: MediaType[];
  credentialId?: string;
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
  price?: Record<string, unknown>;
  refreshedAt: string;
};

export type ModelCapabilityOverride = {
  credentialId?: string | null;
  modelAlias: string;
  mediaType: MediaType;
  capabilities: Record<string, unknown>;
};

export type UpdateAiSettingsInput = {
  baseUrl?: string;
  apiKey?: string;
  defaultModels?: Partial<Record<MediaType, string | ModelSelection | null>>;
};

export type AiSettingsStoreOptions = {
  /**
   * 服务端共享的凭据密钥环。未提供时保持单密钥兼容模式，适用于隔离测试和
   * 不需要跨部署轮换的内存存储。
   */
  credentialKeyring?: CredentialEncryptionKeyring;
  /** Injectable for tests; production uses the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Receives a sanitized server-side diagnostic without changing the client error contract. */
  onTestConnectionError?: (error: Error) => void;
  modelRequestTimeoutMs?: number;
  /** Maximum attempts for connection tests and model refreshes. Capped at 10. */
  modelRequestMaxAttempts?: number;
  /** Delay between failed model requests, in milliseconds. */
  modelRequestRetryDelayMs?: number;
  /** Maximum bytes accepted from the upstream model catalog response. */
  modelRequestMaxResponseBytes?: number;
};

export type CredentialReference = {
  credentialId?: string;
  credentialVersion?: number;
};

/** Internal-only provider credentials. Never expose this shape from an HTTP route. */
export type ProviderCredentials = {
  baseUrl: string;
  apiKey: string;
};

export type PersistedAiSettings = {
  baseUrl: string;
  encryptedApiKey: string;
  /** 仅标识密文使用的部署密钥，不包含密钥材料。 */
  encryptionKeyId?: string;
  keyFingerprint: string;
  defaultModels: Partial<Record<MediaType, string | ModelSelection>>;
  updatedAt: string;
};

export interface AiSettingsStoreLike {
  get(): AiSettings | Promise<AiSettings>;
  update(input: UpdateAiSettingsInput): AiSettings | Promise<AiSettings>;
  listCredentials(): AiCredentialSummary[] | Promise<AiCredentialSummary[]>;
  activateCredential(
    credentialId: string,
  ): AiSettings | undefined | Promise<AiSettings | undefined>;
  removeCredentials(): AiSettings | Promise<AiSettings>;
  hasCredential(credentialId: string): boolean | Promise<boolean>;
  testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }>;
  refreshModels(credentialId?: string): Promise<ModelCatalogEntry[]>;
  listModels(
    mediaType?: MediaType,
    credentialId?: string,
  ): ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  resolveModel(mediaType: MediaType, requestedAlias?: string): string | Promise<string>;
  getCredentialReference(credentialId?: string): CredentialReference | Promise<CredentialReference>;
  /** Used only by the server-side run executor; intentionally optional for test doubles. */
  getProviderCredentials?(
    reference?: CredentialReference,
  ): ProviderCredentials | undefined | Promise<ProviderCredentials | undefined>;
  close?(): Promise<void>;
}

export class AiSettingsError extends Error {
  constructor(
    public readonly code: 'model_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export class AiCredentialNotFoundError extends Error {
  readonly code = 'credential_not_found';

  constructor(credentialId: string) {
    super(`AI credential ${credentialId} was not found`);
  }
}

const LEGACY_MODEL_CATALOG_KEY = '__legacy__';
const DEFAULT_MODEL_RESPONSE_BYTES = 50 * 1024 * 1024;

/** GPT-5.6 文本模型目前可用的推理强度值，顺序与界面展示顺序保持一致。 */
const GPT_56_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** 上一版兼容回退使用的档位，读取旧缓存时需要迁移到当前顺序。 */
const LEGACY_GPT_56_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** GPT-5.6 系列文本模型的别名；兼容供应商增加的稳定后缀。 */
const GPT_56_TEXT_MODEL_ALIAS_PATTERN = /^gpt-5\.6(?:$|[-_.])/;

export class AiSettingsStore {
  private baseUrl = '';
  private encryptedApiKey = '';
  /** 当前密文的持久化 key-id；旧格式未写入该字段时保留 undefined。 */
  private encryptionKeyId?: string;
  private keyFingerprint = '';
  private readonly credentialKeyring: CredentialEncryptionKeyring;
  private readonly fetchImpl?: typeof fetch;
  private readonly onTestConnectionError?: (error: Error) => void;
  private readonly modelRequestTimeoutMs: number;
  private readonly modelRequestMaxAttempts: number;
  private readonly modelRequestRetryDelayMs: number;
  private readonly modelRequestMaxResponseBytes: number;
  private defaultModels: Partial<Record<MediaType, ModelSelection>> = {};
  private readonly modelCatalogs = new Map<string, Map<string, ModelCatalogEntry>>();
  private readonly modelRefreshQueues = new Map<string, Promise<void>>();
  private readonly capabilityOverrides = new Map<string, Record<string, unknown>>();
  private credentialId?: string;
  private credentialVersion?: number;
  private readonly credentialHistory = new Map<string, ProviderCredentials>();
  private readonly credentialRecords = new Map<
    string,
    ProviderCredentials & {
      id: string;
      version: number;
      keyFingerprint: string;
      updatedAt: string;
    }
  >();
  private updatedAt = new Date().toISOString();

  constructor(
    encryptionSecret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
    options: AiSettingsStoreOptions = {},
  ) {
    this.credentialKeyring =
      options.credentialKeyring ??
      new CredentialEncryptionKeyring({ currentSecret: encryptionSecret });
    // Resolve the global fetch at request time when no test/deployment
    // override is supplied, so callers can still instrument or stub it.
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
    this.modelRequestMaxResponseBytes = parsePositiveByteLimit(
      options.modelRequestMaxResponseBytes ?? process.env.NEW_API_MAX_RESPONSE_BYTES,
      DEFAULT_MODEL_RESPONSE_BYTES,
    );
    // Provider credentials and model defaults are entered through the Web
    // settings flow. Environment variables intentionally do not bootstrap
    // them, which prevents a stale .env value from overriding that state.
  }

  get(): AiSettings {
    return {
      baseUrl: this.baseUrl,
      configured: Boolean(this.baseUrl && this.encryptedApiKey),
      ...(this.keyFingerprint ? { keyFingerprint: this.keyFingerprint } : {}),
      defaultModels: serializeDefaultModels(this.defaultModels),
      updatedAt: this.updatedAt,
    };
  }

  getPersisted(): PersistedAiSettings {
    return {
      baseUrl: this.baseUrl,
      encryptedApiKey: this.encryptedApiKey,
      ...(this.encryptedApiKey && this.encryptionKeyId
        ? { encryptionKeyId: this.encryptionKeyId }
        : {}),
      keyFingerprint: this.keyFingerprint,
      defaultModels: serializeDefaultModels(this.defaultModels),
      updatedAt: this.updatedAt,
    };
  }

  hydrate(persisted: PersistedAiSettings, reference?: CredentialReference) {
    if (
      this.credentialId &&
      (this.credentialId !== reference?.credentialId ||
        this.credentialVersion !== reference?.credentialVersion)
    ) {
      this.credentialHistory.delete(credentialKey(this.getCredentialReference()));
      this.credentialRecords.delete(this.credentialId);
    }
    this.baseUrl = persisted.baseUrl;
    this.encryptedApiKey = persisted.encryptedApiKey;
    this.encryptionKeyId = persisted.encryptionKeyId;
    this.keyFingerprint = persisted.keyFingerprint;
    this.defaultModels = normalizeDefaultModels(persisted.defaultModels);
    this.updatedAt = persisted.updatedAt;
    this.credentialId = reference?.credentialId;
    this.credentialVersion = reference?.credentialVersion;
    this.registerCredential(false);
  }

  update(input: UpdateAiSettingsInput): AiSettings {
    let changed = false;
    let providerCredentialsChanged = false;
    const previousCredentialId = this.credentialId;
    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl.replace(/\/$/, '');
      if (baseUrl !== this.baseUrl) {
        this.baseUrl = baseUrl;
        changed = true;
        providerCredentialsChanged = true;
      }
    }
    if (input.apiKey !== undefined) {
      const currentApiKey = this.encryptedApiKey ? this.decryptCurrentApiKey() : undefined;
      if (input.apiKey !== currentApiKey) {
        this.encryptedApiKey = this.credentialKeyring.encrypt(input.apiKey);
        this.encryptionKeyId = this.credentialKeyring.currentKeyId;
        this.keyFingerprint = fingerprint(input.apiKey);
        changed = true;
        providerCredentialsChanged = true;
      }
    }
    if (input.defaultModels) {
      const next = { ...this.defaultModels };
      for (const [mediaType, modelAlias] of Object.entries(input.defaultModels)) {
        if (modelAlias === null || modelAlias === '') delete next[mediaType as MediaType];
        else next[mediaType as MediaType] = normalizeModelSelection(modelAlias);
      }
      if (!sameDefaultModels(next, this.defaultModels)) {
        this.defaultModels = next;
        changed = true;
      }
    }
    if (!changed) return this.get();
    this.updatedAt = new Date().toISOString();
    if (providerCredentialsChanged) {
      this.registerCredential();
    }
    if (!providerCredentialsChanged && previousCredentialId && this.credentialId) {
      this.copyModels(previousCredentialId, this.credentialId);
    }
    return this.get();
  }

  listCredentials(): AiCredentialSummary[] {
    return summarizeCredentials([...this.credentialRecords.values()], this.credentialId);
  }

  activateCredential(credentialId: string): AiSettings | undefined {
    const credential = this.credentialRecords.get(credentialId);
    if (!credential) return undefined;
    const currentApiKey = this.encryptedApiKey ? this.decryptCurrentApiKey() : undefined;
    if (credential.baseUrl === this.baseUrl && credential.apiKey === currentApiKey) {
      return this.get();
    }
    this.baseUrl = credential.baseUrl;
    this.encryptedApiKey = this.credentialKeyring.encrypt(credential.apiKey);
    this.encryptionKeyId = this.credentialKeyring.currentKeyId;
    this.keyFingerprint = credential.keyFingerprint;
    this.updatedAt = new Date().toISOString();
    this.registerCredential();
    if (this.credentialId) this.copyModels(credentialId, this.credentialId);
    return this.get();
  }

  removeCredentials(): AiSettings {
    // Keep immutable historical versions so queued/running snapshots can
    // finish with the credential captured at submission time. The active
    // reference is cleared, so new runs cannot resolve or use a credential.
    this.baseUrl = '';
    this.encryptedApiKey = '';
    this.encryptionKeyId = undefined;
    this.keyFingerprint = '';
    this.credentialId = undefined;
    this.credentialVersion = undefined;
    this.updatedAt = new Date().toISOString();
    return this.get();
  }

  hasCredential(credentialId: string): boolean {
    if (!this.credentialId || !this.credentialVersion || !this.baseUrl || !this.encryptedApiKey) {
      return false;
    }
    return this.credentialRecords.has(credentialId);
  }

  async testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
    if (!this.baseUrl || !this.encryptedApiKey)
      return { ok: false, error: 'New API 地址和 Key 尚未配置' };
    try {
      const response = await requestModels(
        this.baseUrl,
        this.decryptCurrentApiKey(),
        this.fetchImpl,
        this.modelRequestTimeoutMs,
        this.modelRequestMaxAttempts,
        this.modelRequestRetryDelayMs,
        this.modelRequestMaxResponseBytes,
      );
      return { ok: true, modelCount: response.length };
    } catch (error) {
      const diagnostic = sanitizeExceptionForObservability(error);
      try {
        this.onTestConnectionError?.(diagnostic);
      } catch {
        // Diagnostics must never alter the stable connection-test response.
      }
      return { ok: false, error: '连接失败' };
    }
  }

  async refreshModels(credentialId?: string): Promise<ModelCatalogEntry[]> {
    const resolvedCredentialId = credentialId ?? this.credentialId;
    const credential = resolvedCredentialId
      ? this.credentialRecords.get(resolvedCredentialId)
      : undefined;
    if (credentialId && !credential) throw new AiCredentialNotFoundError(credentialId);
    const providerCredentials = credential
      ? { baseUrl: credential.baseUrl, apiKey: credential.apiKey }
      : this.getProviderCredentials();
    if (!providerCredentials || !resolvedCredentialId) {
      throw new Error('New API 地址和 Key 尚未配置');
    }
    return this.enqueueModelRefresh(resolvedCredentialId, () =>
      this.refreshModelsForCredential(resolvedCredentialId, providerCredentials),
    );
  }

  async refreshModelsForCredential(
    credentialId: string,
    providerCredentials: ProviderCredentials,
  ): Promise<ModelCatalogEntry[]> {
    const models = await requestModels(
      providerCredentials.baseUrl,
      providerCredentials.apiKey,
      this.fetchImpl,
      this.modelRequestTimeoutMs,
      this.modelRequestMaxAttempts,
      this.modelRequestRetryDelayMs,
      this.modelRequestMaxResponseBytes,
    );
    this.replaceModels(models, credentialId);
    return this.listModels(undefined, credentialId);
  }

  replaceModels(models: ModelCatalogEntry[], credentialId?: string) {
    const resolvedCredentialId =
      credentialId ?? models.find((model) => model.credentialId)?.credentialId;
    const catalog = new Map<string, ModelCatalogEntry>();
    for (const model of models) {
      const capabilities = normalizeReasoningEffortCapabilities(
        model.id,
        model.mediaTypes,
        model.capabilities,
      );
      catalog.set(model.id, {
        ...model,
        ...(resolvedCredentialId ? { credentialId: resolvedCredentialId } : {}),
        ...(capabilities ? { capabilities } : {}),
      });
    }
    this.modelCatalogs.set(modelCatalogKey(resolvedCredentialId), catalog);
  }

  copyModels(sourceCredentialId: string, targetCredentialId: string) {
    if (sourceCredentialId === targetCredentialId) return;
    const source = this.modelCatalogs.get(modelCatalogKey(sourceCredentialId));
    if (!source) return;
    this.modelCatalogs.set(
      modelCatalogKey(targetCredentialId),
      new Map(
        [...source.entries()].map(([modelId, model]) => [
          modelId,
          { ...model, credentialId: targetCredentialId },
        ]),
      ),
    );
  }

  replaceCapabilityOverrides(overrides: ModelCapabilityOverride[]) {
    this.capabilityOverrides.clear();
    for (const override of overrides) {
      if (
        !isRecord(override) ||
        typeof override.modelAlias !== 'string' ||
        !override.modelAlias.trim() ||
        !mediaTypes.includes(override.mediaType) ||
        !isRecord(override.capabilities)
      ) {
        continue;
      }
      this.capabilityOverrides.set(
        capabilityOverrideKey(override.credentialId, override.modelAlias, override.mediaType),
        { ...override.capabilities },
      );
    }
  }

  listModels(mediaType?: MediaType, credentialId?: string): ModelCatalogEntry[] {
    const catalog =
      this.modelCatalogs.get(modelCatalogKey(credentialId ?? this.credentialId)) ??
      (credentialId === undefined ? this.modelCatalogs.get(LEGACY_MODEL_CATALOG_KEY) : undefined);
    return [...(catalog?.values() ?? [])]
      .filter((model) => !mediaType || model.mediaTypes.includes(mediaType))
      .map((model) => (mediaType ? this.withCapabilityOverride(model, mediaType) : model));
  }

  resolveModel(mediaType: MediaType, requestedAlias?: string): string {
    const alias =
      requestedAlias ?? this.defaultModels[mediaType]?.modelAlias ?? `mock-${mediaType}`;
    if (alias.startsWith('mock-')) return alias;

    const catalog = this.listModels();
    const compatibleModels = this.listModels(mediaType);
    if (catalog.length > 0 && !compatibleModels.some((model) => model.id === alias)) {
      throw new AiSettingsError('model_unavailable', `模型 ${alias} 不支持 ${mediaType} 媒体类型`);
    }
    return alias;
  }

  getCredentialReference(credentialId?: string): CredentialReference {
    if (credentialId) {
      if (!this.credentialId || !this.credentialVersion || !this.baseUrl || !this.encryptedApiKey) {
        throw new AiCredentialNotFoundError(credentialId);
      }
      const credential = this.credentialRecords.get(credentialId);
      if (!credential) throw new AiCredentialNotFoundError(credentialId);
      return { credentialId: credential.id, credentialVersion: credential.version };
    }
    return {
      ...(this.credentialId ? { credentialId: this.credentialId } : {}),
      ...(this.credentialVersion ? { credentialVersion: this.credentialVersion } : {}),
    };
  }

  getProviderCredentials(reference?: CredentialReference): ProviderCredentials | undefined {
    if (reference?.credentialId || reference?.credentialVersion) {
      if (
        reference.credentialId !== this.credentialId ||
        reference.credentialVersion !== this.credentialVersion
      ) {
        const historical =
          reference.credentialId && reference.credentialVersion
            ? this.credentialHistory.get(credentialKey(reference))
            : undefined;
        return historical ? { ...historical } : undefined;
      }
    }
    if (!this.baseUrl || !this.encryptedApiKey) return undefined;
    return {
      baseUrl: this.baseUrl,
      apiKey: this.decryptCurrentApiKey(),
    };
  }

  /** 解密内存中的当前凭据，并把旧密文立即升级为当前 key-id 包装。 */
  private decryptCurrentApiKey(): string {
    const decrypted = this.credentialKeyring.decrypt(this.encryptedApiKey, this.encryptionKeyId);
    if (decrypted.needsReencryption) {
      this.encryptedApiKey = this.credentialKeyring.encrypt(decrypted.plaintext);
      this.encryptionKeyId = this.credentialKeyring.currentKeyId;
    }
    return decrypted.plaintext;
  }

  private registerCredential(advanceVersion = true) {
    if (!this.baseUrl || !this.encryptedApiKey) return;
    if (advanceVersion) {
      this.credentialId = randomUUID();
      this.credentialVersion = (this.credentialVersion ?? 0) + 1;
    } else {
      this.credentialId ??= randomUUID();
      this.credentialVersion ??= 1;
    }
    const credentials = {
      baseUrl: this.baseUrl,
      apiKey: this.decryptCurrentApiKey(),
    };
    this.credentialHistory.set(credentialKey(this.getCredentialReference()), credentials);
    this.credentialRecords.set(this.credentialId, {
      ...credentials,
      id: this.credentialId,
      version: this.credentialVersion,
      keyFingerprint: this.keyFingerprint,
      updatedAt: this.updatedAt,
    });
  }

  private withCapabilityOverride(model: ModelCatalogEntry, mediaType: MediaType) {
    const override =
      this.capabilityOverrides.get(
        capabilityOverrideKey(model.credentialId, model.id, mediaType),
      ) ?? this.capabilityOverrides.get(capabilityOverrideKey(undefined, model.id, mediaType));
    if (!override) return model;
    const capabilities = mergeModelCapabilities(
      model.id,
      model.mediaTypes,
      model.capabilities,
      override,
    );
    return {
      ...model,
      ...(capabilities ? { capabilities } : {}),
    };
  }

  private enqueueModelRefresh<T>(credentialId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.modelRefreshQueues.get(credentialId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.modelRefreshQueues.set(credentialId, settled);
    void settled.finally(() => {
      if (this.modelRefreshQueues.get(credentialId) === settled) {
        this.modelRefreshQueues.delete(credentialId);
      }
    });
    return result;
  }
}

/**
 * PostgreSQL 设置存储。每次当前状态操作都先读取数据库，撤销提交后开始的操作
 * 不再使用其他实例的旧缓存；数据库不可用时抛错，不回退到缓存凭据。
 * 完整的 credentialId/version 仍按不可变历史记录解析，不取消已冻结的任务。
 * 文件存储不使用此同步机制，仍只支持单 API 进程。
 */
export class PrismaAiSettingsStore implements AiSettingsStoreLike {
  /** 最近一次完整加载的设置视图，仅在串行操作内部使用。 */
  private memory: AiSettingsStore;
  private readonly ready: Promise<void>;
  private readonly encryptionSecret: string;
  private readonly credentialKeyring: CredentialEncryptionKeyring;
  /** 重建视图时保留请求超时、测试注入及共享密钥环配置。 */
  private readonly memoryOptions: AiSettingsStoreOptions;
  private credentialReference: CredentialReference = {};
  /** 串行化本实例的刷新与写入，避免读取未持久化状态；失败后仍可继续操作。 */
  private writeQueue: Promise<void> = Promise.resolve();

  /** 使用调用方管理的数据库客户端初始化；缺少稳定加密密钥时立即拒绝启动。 */
  constructor(
    private readonly prisma: PrismaClient,
    encryptionSecret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
    options: AiSettingsStoreOptions = {},
  ) {
    if (!encryptionSecret?.trim()) {
      throw new Error(
        'AI_CREDENTIAL_ENCRYPTION_KEY is required when PostgreSQL-backed AI settings are enabled',
      );
    }
    this.encryptionSecret = encryptionSecret;
    this.credentialKeyring = createCredentialEncryptionKeyringFromEnvironment({
      ...process.env,
      AI_CREDENTIAL_ENCRYPTION_KEY: encryptionSecret,
    });
    this.memoryOptions = {
      ...options,
      credentialKeyring: this.credentialKeyring,
    };
    this.memory = new AiSettingsStore(encryptionSecret, this.memoryOptions);
    this.ready = this.load();
  }

  /** 返回数据库最新设置；读取失败时不暴露旧的活动状态。 */
  async get() {
    return this.withLatestSettings(() => this.memory.get());
  }

  /** 基于最新已提交设置合并局部更新，落库失败时撤回本实例的临时变更。 */
  async update(input: UpdateAiSettingsInput) {
    return this.withLatestSettings(async () => {
      const previous = this.memory.getPersisted();
      const previousReference = this.memory.getCredentialReference();
      const previousStoreReference = { ...this.credentialReference };
      const result = this.memory.update(input);
      if (samePersistedSettings(previous, this.memory.getPersisted())) return result;
      try {
        const next = this.memory.getPersisted();
        const sourceCatalogCredentialId =
          previous.baseUrl === next.baseUrl && previous.keyFingerprint === next.keyFingerprint
            ? previousStoreReference.credentialId
            : undefined;
        await this.persistCredential(
          sourceCatalogCredentialId,
          previous.baseUrl === next.baseUrl && previous.keyFingerprint === next.keyFingerprint,
          previous.updatedAt,
        );
        return this.memory.get();
      } catch (error) {
        // A database outage must not leave this process serving credentials or
        // defaults that were never durably written.
        this.memory.hydrate(previous, previousReference);
        this.credentialReference = previousStoreReference;
        throw error;
      }
    });
  }

  /** 列出历史连接摘要，活动标记以本次读取的数据库设置为准。 */
  async listCredentials() {
    return this.withLatestSettings(async () => {
      const credentials = await this.prisma.aiCredential.findMany({
        where: { projectId: null },
        orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
      });
      return summarizeCredentials(credentials, this.credentialReference.credentialId);
    });
  }

  /** 显式重新激活历史连接并保留最新默认模型；目标不存在时返回 undefined。 */
  async activateCredential(credentialId: string) {
    return this.withLatestSettings(async () => {
      const credential = await this.prisma.aiCredential.findFirst({
        where: { id: credentialId, projectId: null },
      });
      if (!credential?.baseUrl || !credential.encryptedApiKey || !credential.keyFingerprint) {
        return undefined;
      }

      const providerCredentials = await this.providerCredentialsForCredential(credential);
      if (!providerCredentials) return undefined;

      const previous = this.memory.getPersisted();
      const previousReference = this.memory.getCredentialReference();
      const previousStoreReference = { ...this.credentialReference };
      const result = this.memory.update(providerCredentials);
      if (samePersistedSettings(previous, this.memory.getPersisted())) return result;
      try {
        await this.persistCredential(credential.id, false, previous.updatedAt);
        return this.memory.get();
      } catch (error) {
        this.memory.hydrate(previous, previousReference);
        this.credentialReference = previousStoreReference;
        throw error;
      }
    });
  }

  /** 写入撤销墓碑阻止后续新任务使用凭据，保留历史快照的 id/version 和密文。 */
  async removeCredentials() {
    return this.withLatestSettings(async () => {
      // Do not delete or zero historical rows: queued/running jobs may refer
      // to the current id/version. Append an empty tombstone version to revoke
      // the active credential while leaving every immutable snapshot resolvable.
      const revoked = await this.prisma.$transaction(async (transaction) => {
        const updatedAt = await this.lockCredentialWrites(transaction);
        const current = await transaction.aiCredential.findFirst({
          where: { projectId: null },
          orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
          select: { version: true },
        });
        if (current) {
          return transaction.aiCredential.create({
            data: {
              projectId: null,
              ownerId: null,
              version: current.version + 1,
              baseUrl: '',
              encryptedApiKey: '',
              encryptionKeyId: null,
              keyFingerprint: '',
              defaultModels: Prisma.JsonNull,
              label: 'revoked',
              updatedAt,
            },
          });
        }
        return null;
      });
      this.credentialReference = {};
      if (revoked) {
        this.memory.hydrate({
          baseUrl: '',
          encryptedApiKey: '',
          keyFingerprint: '',
          defaultModels: {},
          updatedAt: revoked.updatedAt.toISOString(),
        });
        return this.memory.get();
      }
      return this.memory.removeCredentials();
    });
  }

  /** 检查指定凭据是否可用于新任务；当前设置被撤销时历史凭据也不可新选。 */
  async hasCredential(credentialId: string) {
    return this.withLatestSettings(() => this.hasLoadedCredential(credentialId));
  }

  /** 仅在已同步的串行操作中检查可选凭据，避免再次入队造成自等待。 */
  private async hasLoadedCredential(credentialId: string) {
    if (!this.memory.get().configured) return false;
    if (credentialId === this.credentialReference.credentialId) {
      return true;
    }
    const credential = await this.prisma.aiCredential.findFirst({
      where: { id: credentialId, projectId: null },
      select: { id: true, baseUrl: true, encryptedApiKey: true },
    });
    return Boolean(credential?.baseUrl && credential.encryptedApiKey);
  }

  /** 使用本次读取的活动连接测试上游；已提交的远程撤销会阻止请求发出。 */
  async testConnection() {
    return this.withLatestSettings(() => this.memory.testConnection());
  }

  /** 同步活动状态后刷新指定连接目录；撤销后不能借历史 id 发起新的上游请求。 */
  async refreshModels(credentialId?: string) {
    return this.withLatestSettings(async () => {
      const selected = await this.resolveModelCredential(credentialId);
      const previousModels = this.memory.listModels(undefined, selected.credentialId);
      const models = await this.memory.refreshModelsForCredential(
        selected.credentialId,
        selected.providerCredentials,
      );
      try {
        await this.prisma.$transaction(async (transaction) => {
          await transaction.modelCatalog.deleteMany({
            where: { credentialId: selected.credentialId },
          });
          if (models.length > 0) {
            await transaction.modelCatalog.createMany({
              data: models.flatMap((model) =>
                model.mediaTypes.map((mediaType) => ({
                  credentialId: selected.credentialId,
                  modelAlias: model.id,
                  name: model.name,
                  mediaType: toPrismaMediaType(mediaType),
                  capabilities: model.capabilities
                    ? (model.capabilities as Prisma.InputJsonValue)
                    : undefined,
                  limitations: model.limitations
                    ? (model.limitations as Prisma.InputJsonValue)
                    : undefined,
                  price: model.price ? (model.price as Prisma.InputJsonValue) : undefined,
                  refreshedAt: new Date(model.refreshedAt),
                })),
              ),
            });
          }
        });
        return models;
      } catch (error) {
        this.memory.replaceModels(previousModels, selected.credentialId);
        throw error;
      }
    });
  }

  /** 返回数据库最新模型目录和能力覆盖；撤销后的显式历史选择会抛出未找到错误。 */
  async listModels(mediaType?: MediaType, credentialId?: string) {
    return this.withLatestSettings(async () => {
      const resolvedCredentialId = credentialId ?? this.credentialReference.credentialId;
      if (credentialId && !(await this.hasLoadedCredential(credentialId))) {
        throw new AiCredentialNotFoundError(credentialId);
      }
      return this.memory.listModels(mediaType, resolvedCredentialId);
    });
  }

  /** 使用最新默认模型、目录和能力覆盖解析别名；不兼容时保持既有错误契约。 */
  async resolveModel(mediaType: MediaType, requestedAlias?: string) {
    return this.withLatestSettings(() => this.memory.resolveModel(mediaType, requestedAlias));
  }

  /** 为新任务选择最新凭据版本；无活动连接时返回空引用，显式历史选择则报错。 */
  async getCredentialReference(credentialId?: string) {
    return this.withLatestSettings(async () => {
      if (credentialId && credentialId !== this.credentialReference.credentialId) {
        if (!this.memory.get().configured) {
          throw new AiCredentialNotFoundError(credentialId);
        }
        const credential = await this.prisma.aiCredential.findFirst({
          where: { id: credentialId, projectId: null },
          select: { id: true, version: true, baseUrl: true, encryptedApiKey: true },
        });
        if (!credential?.baseUrl || !credential.encryptedApiKey) {
          throw new AiCredentialNotFoundError(credentialId);
        }
        return { credentialId: credential.id, credentialVersion: credential.version };
      }
      return { ...this.credentialReference };
    });
  }

  /**
   * 无引用时读取最新活动凭据；完整引用只按冻结 id/version 查询历史数据库记录。
   * 部分引用或版本不匹配返回 undefined，不回退当前 Key；读取失败直接抛错。
   * 返回值含明文，仅供服务端执行器使用，不得用于 HTTP 响应或日志。
   */
  async getProviderCredentials(reference?: CredentialReference) {
    const requested = reference ?? {};
    if (requested.credentialId === undefined && requested.credentialVersion === undefined) {
      return this.withLatestSettings(() => this.memory.getProviderCredentials());
    }
    if (
      !requested.credentialId ||
      !requested.credentialVersion ||
      !Number.isSafeInteger(requested.credentialVersion) ||
      requested.credentialVersion < 1
    )
      return undefined;
    await this.ready;
    return this.enqueueWrite(async () => {
      const historical = await this.prisma.aiCredential.findFirst({
        where: {
          id: requested.credentialId,
          version: requested.credentialVersion,
          projectId: null,
        },
      });
      if (!historical) return undefined;
      return this.providerCredentialsForCredential(historical);
    });
  }

  /** 等待初始化和本实例已入队操作；数据库客户端仍由调用方管理。 */
  async close() {
    await this.ready;
    await this.writeQueue;
  }

  /**
   * 构造完整的新设置视图后才替换缓存，清除远程已删除的目录和能力覆盖。
   * 数据库、解密或轮换写回失败时保留错误，不发布半加载状态。
   */
  private async load() {
    const overrideDelegate = (
      this.prisma as PrismaClient & {
        modelCapabilityOverride?: { findMany: () => Promise<unknown[]> };
      }
    ).modelCapabilityOverride;
    const [credential, catalog, overrides] = await Promise.all([
      this.prisma.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
      }),
      this.prisma.modelCatalog.findMany(),
      overrideDelegate?.findMany ? overrideDelegate.findMany() : Promise.resolve([]),
    ]);
    const memory = new AiSettingsStore(this.encryptionSecret, this.memoryOptions);
    const reference: CredentialReference = {};
    if (credential) {
      if (credential.baseUrl && credential.encryptedApiKey) {
        await this.providerCredentialsForCredential(credential);
        Object.assign(reference, {
          credentialId: credential.id,
          credentialVersion: credential.version,
        });
      }
      const defaults = isDefaultModels(credential.defaultModels) ? credential.defaultModels : {};
      memory.hydrate(
        {
          baseUrl: credential.baseUrl,
          encryptedApiKey: credential.encryptedApiKey,
          ...(credential.encryptionKeyId ? { encryptionKeyId: credential.encryptionKeyId } : {}),
          keyFingerprint: credential.keyFingerprint,
          defaultModels: defaults,
          updatedAt: credential.updatedAt.toISOString(),
        },
        reference,
      );
    }
    const activeCredentialId = reference.credentialId;
    let resolvedCatalog = catalog;
    if (activeCredentialId) {
      const legacyModels = catalog.filter((model) => model.credentialId === null);
      if (legacyModels.length > 0) {
        const activeModels = catalog.filter((model) => model.credentialId === activeCredentialId);
        await this.prisma.$transaction(async (transaction) => {
          if (activeModels.length === 0) {
            await transaction.modelCatalog.createMany({
              data: legacyModels.map((model) => copyModelCatalogData(model, activeCredentialId)),
              skipDuplicates: true,
            });
          }
          await transaction.modelCatalog.deleteMany({ where: { credentialId: null } });
        });
        resolvedCatalog = [
          ...catalog.filter((model) => model.credentialId !== null),
          ...(activeModels.length === 0
            ? legacyModels.map((model) => ({ ...model, credentialId: activeCredentialId }))
            : []),
        ];
      }
    }

    const grouped = new Map<string, Map<string, ModelCatalogEntry>>();
    for (const model of resolvedCatalog) {
      const catalogCredentialId = model.credentialId ?? activeCredentialId;
      const scopeKey = modelCatalogKey(catalogCredentialId);
      const scopedModels = grouped.get(scopeKey) ?? new Map<string, ModelCatalogEntry>();
      const existing = scopedModels.get(model.modelAlias);
      const mediaType = fromPrismaMediaType(model.mediaType);
      scopedModels.set(model.modelAlias, {
        id: model.modelAlias,
        name: model.name,
        mediaTypes: existing ? [...new Set([...existing.mediaTypes, mediaType])] : [mediaType],
        ...(catalogCredentialId ? { credentialId: catalogCredentialId } : {}),
        ...(isRecord(model.capabilities) || existing?.capabilities
          ? {
              capabilities: {
                ...(existing?.capabilities ?? {}),
                ...(isRecord(model.capabilities) ? model.capabilities : {}),
              },
            }
          : {}),
        ...(isRecord(model.limitations) || existing?.limitations
          ? {
              limitations: {
                ...(existing?.limitations ?? {}),
                ...(isRecord(model.limitations) ? model.limitations : {}),
              },
            }
          : {}),
        ...(isRecord(model.price) || existing?.price
          ? {
              price: {
                ...(existing?.price ?? {}),
                ...(isRecord(model.price) ? model.price : {}),
              },
            }
          : {}),
        refreshedAt: model.refreshedAt.toISOString(),
      });
      grouped.set(scopeKey, scopedModels);
    }
    for (const [scopeKey, models] of grouped) {
      memory.replaceModels(
        [...models.values()],
        scopeKey === LEGACY_MODEL_CATALOG_KEY ? undefined : scopeKey,
      );
    }
    memory.replaceCapabilityOverrides(normalizeCapabilityOverrides(overrides));
    this.memory = memory;
    this.credentialReference = reference;
  }

  /**
   * 持久化设置并绑定数据库版本；所有更新都校验原活动行与更新时间。
   * 并发撤销或配置变更导致原视图失效时拒绝写入，不允许把历史行重新排成活动行。
   */
  private async persistCredential(
    sourceCatalogCredentialId: string | undefined,
    defaultsOnly: boolean,
    expectedUpdatedAt: string,
  ) {
    const persisted = this.memory.getPersisted();
    const current = await this.prisma.$transaction(async (transaction) => {
      const updatedAt = await this.lockCredentialWrites(transaction);
      const existing = await transaction.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
      });
      const expectedReference = this.credentialReference;
      const matchesReference = expectedReference.credentialId
        ? existing?.id === expectedReference.credentialId &&
          existing.version === expectedReference.credentialVersion
        : !existing?.baseUrl || !existing.encryptedApiKey;
      if (
        !matchesReference ||
        (existing && existing.updatedAt.toISOString() !== expectedUpdatedAt)
      ) {
        throw new Error('AI settings changed before they could be persisted');
      }
      if (
        defaultsOnly &&
        this.credentialReference.credentialId &&
        typeof transaction.aiCredential.update === 'function'
      ) {
        if (!existing) {
          throw new Error('AI settings changed before they could be persisted');
        }
        return transaction.aiCredential.update({
          where: { id: existing.id, version: existing.version, updatedAt: existing.updatedAt },
          data: { defaultModels: persisted.defaultModels, updatedAt },
        });
      }
      const created = await transaction.aiCredential.create({
        data: {
          label: 'default',
          baseUrl: persisted.baseUrl,
          encryptedApiKey: persisted.encryptedApiKey,
          encryptionKeyId:
            persisted.encryptionKeyId ??
            (persisted.encryptedApiKey ? this.credentialKeyring.currentKeyId : null),
          keyFingerprint: persisted.keyFingerprint,
          defaultModels: persisted.defaultModels,
          version: Math.max(
            existing ? existing.version + 1 : 1,
            this.memory.getCredentialReference().credentialVersion ?? 1,
          ),
          projectId: null,
          ownerId: null,
          updatedAt,
        },
      });
      if (sourceCatalogCredentialId) {
        const sourceModels = await transaction.modelCatalog.findMany({
          where: { credentialId: sourceCatalogCredentialId },
        });
        if (sourceModels.length > 0) {
          await transaction.modelCatalog.createMany({
            data: sourceModels.map((model) => copyModelCatalogData(model, created.id)),
          });
        }
      }
      return created;
    });
    if (current) {
      this.credentialReference =
        persisted.baseUrl && persisted.encryptedApiKey
          ? { credentialId: current.id, credentialVersion: current.version }
          : {};
      if (sourceCatalogCredentialId) {
        this.memory.copyModels(sourceCatalogCredentialId, current.id);
      }
      this.memory.hydrate(
        { ...persisted, updatedAt: current.updatedAt.toISOString() },
        this.credentialReference,
      );
    }
  }

  /**
   * 创建、默认模型更新和撤销共享事务级表锁，普通 SELECT 仍可读取已提交状态。
   * 锁仅覆盖设置表的短时数据库操作，不跨 Provider 请求；由事务提交或回滚释放。
   * 获锁后使用数据库 UTC wall clock，不使用应用时钟或事务开始时间；至少超过
   * 已存最大时间一毫秒，使旧未来时间和同毫秒并发均不破坏排序或 CAS，无需迁移历史数据。
   */
  private async lockCredentialWrites(transaction: Prisma.TransactionClient): Promise<Date> {
    await transaction.$executeRaw`LOCK TABLE "ai_credentials" IN SHARE ROW EXCLUSIVE MODE`;
    const timestamps = await transaction.$queryRaw<Array<{ updatedAt: Date }>>`
      SELECT GREATEST(
        (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
        MAX("updatedAt") + interval '1 millisecond'
      ) AS "updatedAt"
      FROM "ai_credentials" WHERE "projectId" IS NULL
    `;
    const updatedAt = timestamps[0]?.updatedAt;
    if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) {
      throw new Error('AI settings database timestamp is unavailable');
    }
    return updatedAt;
  }

  /** 在已同步的视图内解析模型请求凭据；撤销后拒绝显式历史选择，不影响冻结任务读取。 */
  private async resolveModelCredential(credentialId?: string): Promise<{
    credentialId: string;
    providerCredentials: ProviderCredentials;
  }> {
    const resolvedCredentialId = credentialId ?? this.credentialReference.credentialId;
    if (!this.memory.get().configured || !resolvedCredentialId) {
      if (credentialId) throw new AiCredentialNotFoundError(credentialId);
      throw new Error('New API 地址和 Key 尚未配置');
    }
    if (resolvedCredentialId === this.credentialReference.credentialId) {
      const providerCredentials = this.memory.getProviderCredentials();
      if (providerCredentials) return { credentialId: resolvedCredentialId, providerCredentials };
    }

    const credential = await this.prisma.aiCredential.findFirst({
      where: { id: resolvedCredentialId, projectId: null },
    });
    if (!credential?.baseUrl || !credential.encryptedApiKey || !credential.keyFingerprint) {
      if (credentialId) throw new AiCredentialNotFoundError(credentialId);
      throw new Error('New API 地址和 Key 尚未配置');
    }
    const providerCredentials = await this.providerCredentialsForCredential(credential);
    if (!providerCredentials) throw new AiCredentialNotFoundError(resolvedCredentialId);
    return { credentialId: resolvedCredentialId, providerCredentials };
  }

  /**
   * 在同一队列内刷新并消费设置，避免异步刷新覆盖本实例尚未落库的写入。
   * 每次操作重新读取，不使用 TTL；失败只拒绝本次操作，后续请求可自动恢复。
   */
  private async withLatestSettings<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.ready;
    return this.enqueueWrite(async () => {
      await this.load();
      return operation();
    });
  }

  /** 将操作追加到本实例队列并向调用方保留异常，不让失败中断后续操作。 */
  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 按记录的 key-id 解密历史凭据，并在同一行可更新时逐步迁移到当前 key。
   *
   * 读取失败会向上抛出，不会用活动凭据替代历史快照。重加密只改变密文包装，
   * 不改变 credentialId/version 或活动排序时间。比较读取版本后写回，冲突时
   * 拒绝本次读取，不覆盖其他实例的新密文，也不返回尚未持久化的凭据。
   */
  private async providerCredentialsForCredential(credential: {
    id: string;
    baseUrl: string;
    encryptedApiKey: string;
    encryptionKeyId?: string | null;
    version: number;
    updatedAt: Date;
  }): Promise<ProviderCredentials | undefined> {
    if (!credential.baseUrl || !credential.encryptedApiKey) return undefined;
    const decrypted = this.credentialKeyring.decrypt(
      credential.encryptedApiKey,
      credential.encryptionKeyId ?? undefined,
    );
    if (decrypted.needsReencryption) {
      const rotated = this.credentialKeyring.encrypt(decrypted.plaintext);
      if (typeof this.prisma.aiCredential.update !== 'function') {
        throw new Error('AI credential rotation requires a durable credential update method');
      }
      try {
        await this.prisma.aiCredential.update({
          where: {
            id: credential.id,
            version: credential.version,
            encryptedApiKey: credential.encryptedApiKey,
            encryptionKeyId: credential.encryptionKeyId ?? null,
            updatedAt: credential.updatedAt,
          },
          data: {
            encryptedApiKey: rotated,
            encryptionKeyId: this.credentialKeyring.currentKeyId,
            updatedAt: credential.updatedAt,
          },
        });
      } catch {
        throw new Error('AI credential rotation could not be persisted');
      }
      credential.encryptedApiKey = rotated;
      credential.encryptionKeyId = this.credentialKeyring.currentKeyId;
    }
    return { baseUrl: credential.baseUrl, apiKey: decrypted.plaintext };
  }
}

function copyModelCatalogData(
  model: ModelCatalog,
  credentialId: string,
): Prisma.ModelCatalogCreateManyInput {
  return {
    credentialId,
    modelAlias: model.modelAlias,
    name: model.name,
    mediaType: model.mediaType,
    ...(model.capabilities === null
      ? {}
      : { capabilities: model.capabilities as Prisma.InputJsonValue }),
    ...(model.limitations === null
      ? {}
      : { limitations: model.limitations as Prisma.InputJsonValue }),
    ...(model.price === null ? {} : { price: model.price as Prisma.InputJsonValue }),
    refreshedAt: model.refreshedAt,
  };
}

function toPrismaMediaType(mediaType: MediaType) {
  return mediaType.toUpperCase() as 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';
}

function fromPrismaMediaType(mediaType: string): MediaType {
  return mediaType.toLowerCase() as MediaType;
}

function capabilityOverrideKey(
  credentialId: string | null | undefined,
  modelAlias: string,
  mediaType: MediaType,
): string {
  return `${credentialId ?? ''}\0${modelAlias.trim()}\0${mediaType}`;
}

function credentialKey(reference: CredentialReference): string {
  return `${reference.credentialId ?? ''}:${reference.credentialVersion ?? ''}`;
}

function modelCatalogKey(credentialId: string | undefined): string {
  return credentialId ?? LEGACY_MODEL_CATALOG_KEY;
}

function sameDefaultModels(
  left: Partial<Record<MediaType, ModelSelection>>,
  right: Partial<Record<MediaType, ModelSelection>>,
): boolean {
  return mediaTypes.every(
    (mediaType) =>
      left[mediaType]?.modelAlias === right[mediaType]?.modelAlias &&
      left[mediaType]?.credentialId === right[mediaType]?.credentialId,
  );
}

function normalizeModelSelection(value: string | ModelSelection): ModelSelection {
  if (typeof value === 'string') return { modelAlias: value.trim() };
  return {
    modelAlias: value.modelAlias.trim(),
    ...(value.credentialId ? { credentialId: value.credentialId } : {}),
  };
}

function normalizeDefaultModels(
  value: Partial<Record<MediaType, string | ModelSelection>>,
): Partial<Record<MediaType, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([mediaType, selection]) =>
      mediaTypes.includes(mediaType as MediaType) && selection
        ? [[mediaType, normalizeModelSelection(selection)]]
        : [],
    ),
  ) as Partial<Record<MediaType, ModelSelection>>;
}

function cloneDefaultModels(
  value: Partial<Record<MediaType, ModelSelection>>,
): Partial<Record<MediaType, ModelSelection>> {
  return normalizeDefaultModels(value);
}

function serializeDefaultModels(
  value: Partial<Record<MediaType, ModelSelection>>,
): Partial<Record<MediaType, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).map(([mediaType, selection]) => [mediaType, selection]),
  ) as Partial<Record<MediaType, ModelSelection>>;
}

function samePersistedSettings(left: PersistedAiSettings, right: PersistedAiSettings): boolean {
  return (
    left.baseUrl === right.baseUrl &&
    left.encryptedApiKey === right.encryptedApiKey &&
    left.keyFingerprint === right.keyFingerprint &&
    sameDefaultModels(
      normalizeDefaultModels(left.defaultModels),
      normalizeDefaultModels(right.defaultModels),
    )
  );
}

function summarizeCredentials(
  credentials: Array<{
    id: string;
    baseUrl: string;
    keyFingerprint: string;
    updatedAt: string | Date;
  }>,
  activeCredentialId?: string,
): AiCredentialSummary[] {
  const sorted = credentials
    .filter((credential) => credential.baseUrl && credential.keyFingerprint)
    .map((credential) => ({
      id: credential.id,
      baseUrl: credential.baseUrl,
      keyFingerprint: credential.keyFingerprint,
      updatedAt:
        credential.updatedAt instanceof Date
          ? credential.updatedAt.toISOString()
          : credential.updatedAt,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const deduplicated = new Map<string, (typeof sorted)[number]>();
  for (const credential of sorted) {
    const key = `${credential.baseUrl}\0${credential.keyFingerprint}`;
    if (!deduplicated.has(key) || credential.id === activeCredentialId) {
      deduplicated.set(key, credential);
    }
  }
  return [...deduplicated.values()]
    .map((credential) => ({
      ...credential,
      active: credential.id === activeCredentialId,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeCapabilityOverrides(value: unknown): ModelCapabilityOverride[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const modelAlias = typeof candidate.modelAlias === 'string' ? candidate.modelAlias.trim() : '';
    const credentialId =
      typeof candidate.credentialId === 'string' && candidate.credentialId.trim()
        ? candidate.credentialId.trim()
        : undefined;
    const mediaTypeValue =
      typeof candidate.mediaType === 'string' ? candidate.mediaType.toLowerCase() : '';
    const capabilities = candidate.capabilities;
    if (
      !modelAlias ||
      !mediaTypes.includes(mediaTypeValue as MediaType) ||
      !isRecord(capabilities)
    ) {
      return [];
    }
    return [
      {
        ...(credentialId ? { credentialId } : {}),
        modelAlias,
        mediaType: mediaTypeValue as MediaType,
        capabilities,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDefaultModels(
  value: unknown,
): value is Partial<Record<MediaType, string | ModelSelection>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, alias]) =>
        mediaTypes.includes(key as MediaType) &&
        (typeof alias === 'string' || (isRecord(alias) && typeof alias.modelAlias === 'string')),
    )
  );
}

async function requestModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  maxAttempts = 10,
  retryDelayMs = 250,
  maxResponseBytes = DEFAULT_MODEL_RESPONSE_BYTES,
): Promise<ModelCatalogEntry[]> {
  const normalizedBaseUrl = normalizeNewApiBaseUrl(baseUrl);
  const attempts = Math.min(10, Math.max(1, Math.floor(maxAttempts)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${normalizedBaseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
      const payload = await readJsonResponseWithinLimit(response, maxResponseBytes);
      return normalizeModelsPayload(payload);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      if (retryDelayMs > 0) await delay(retryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型服务请求失败');
}

async function readJsonResponseWithinLimit(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new Error('模型服务响应超出大小限制');
    }
  }

  if (!response.body) {
    const payload = (await response.json()) as unknown;
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    if (encoded.byteLength > maxResponseBytes) {
      throw new Error('模型服务响应超出大小限制');
    }
    return payload;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error('模型服务响应超出大小限制');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function parsePositiveByteLimit(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Accept the OpenAI `{ data: [...] }` shape as well as common gateway
 * variants. The returned list is deduplicated by model ID and merges explicit
 * media capabilities from repeated records instead of letting the last record
 * erase earlier capabilities.
 */
export function normalizeModelsPayload(payload: unknown): ModelCatalogEntry[] {
  const candidates = extractModelCandidates(payload);
  const refreshedAt = new Date().toISOString();
  const merged = new Map<string, ModelCatalogEntry>();
  for (const candidate of candidates) {
    const model = normalizeModel(candidate, refreshedAt);
    if (!model) continue;
    const existing = merged.get(model.id);
    if (!existing) {
      merged.set(model.id, model);
      continue;
    }
    const mediaTypes = [...new Set([...existing.mediaTypes, ...model.mediaTypes])];
    const capabilities = mergeModelCapabilities(
      model.id,
      mediaTypes,
      existing.capabilities,
      model.capabilities,
    );
    merged.set(model.id, {
      ...existing,
      name: model.name !== model.id ? model.name : existing.name,
      mediaTypes,
      ...(capabilities ? { capabilities } : {}),
      ...(model.limitations || existing.limitations
        ? { limitations: { ...(existing.limitations ?? {}), ...(model.limitations ?? {}) } }
        : {}),
      ...(model.price || existing.price
        ? { price: { ...(existing.price ?? {}), ...(model.price ?? {}) } }
        : {}),
      // One refresh should expose one coherent timestamp for a model.
      refreshedAt: model.refreshedAt,
    });
  }
  return [...merged.values()];
}

function extractModelCandidates(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ['data', 'models', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/**
 * 合并重复模型记录的能力，并避免低档占位值覆盖已确认的非低档声明。
 *
 * @param modelAlias 模型别名。
 * @param mediaTypes 模型支持的媒体类型。
 * @param existing 已合并的能力对象。
 * @param incoming 当前记录的能力对象。
 * @returns 合并后的能力；两侧都没有能力时返回 `undefined`。
 */
function mergeModelCapabilities(
  modelAlias: string,
  mediaTypes: MediaType[],
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!existing && !incoming) {
    return normalizeReasoningEffortCapabilities(modelAlias, mediaTypes, undefined);
  }

  const merged = { ...(existing ?? {}), ...(incoming ?? {}) };
  const existingEffort = existing?.reasoning_effort;
  const incomingEffort = incoming?.reasoning_effort;
  if (
    existingEffort !== undefined &&
    existingEffort !== null &&
    (isLowOnlyReasoningEffort(incomingEffort) || isGpt56ReasoningEffortFallback(incomingEffort))
  ) {
    merged.reasoning_effort = existingEffort;
  }
  return normalizeReasoningEffortCapabilities(modelAlias, mediaTypes, merged);
}

/**
 * 为已确认的 GPT-5.6 文本模型补齐缺失或仅有 low 占位的推理强度。
 * 未列入白名单的模型、非文本模型以及已声明任一非 low 值的模型均原样返回。
 *
 * @param modelAlias 模型别名。
 * @param mediaTypes 模型支持的媒体类型。
 * @param capabilities 上游声明的能力对象。
 * @returns 可能补齐 `reasoning_effort` 的能力对象。
 */
function normalizeReasoningEffortCapabilities(
  modelAlias: string,
  mediaTypes: MediaType[],
  capabilities: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!mediaTypes.includes('text')) return capabilities;
  if (!isGpt56TextModelAlias(modelAlias)) return capabilities;

  const declared = capabilities?.reasoning_effort;
  const shouldFill =
    !capabilities ||
    declared === undefined ||
    declared === null ||
    isLowOnlyReasoningEffort(declared) ||
    isLegacyGpt56ReasoningEffortFallback(declared);
  if (!shouldFill) return capabilities;

  return {
    ...(capabilities ?? {}),
    reasoning_effort: [...GPT_56_REASONING_EFFORTS],
  };
}

/** 判断模型别名是否属于已确认支持六档推理强度的 GPT-5.6 系列。 */
function isGpt56TextModelAlias(modelAlias: string): boolean {
  return GPT_56_TEXT_MODEL_ALIAS_PATTERN.test(modelAlias.trim().toLowerCase());
}

/** 判断能力字段是否为空或仅包含 low（忽略空白与大小写）。 */
function isLowOnlyReasoningEffort(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().toLowerCase() === 'low')
  );
}

/** 判断数组是否为本模块为 GPT-5.6 生成的完整兼容档位。 */
function isGpt56ReasoningEffortFallback(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === GPT_56_REASONING_EFFORTS.length &&
    value.every((item, index) => item === GPT_56_REASONING_EFFORTS[index])
  );
}

/** 判断数组是否为上一版包含 none 的 GPT-5.6 兼容档位。 */
function isLegacyGpt56ReasoningEffortFallback(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === LEGACY_GPT_56_REASONING_EFFORTS.length &&
    value.every((item, index) => item === LEGACY_GPT_56_REASONING_EFFORTS[index])
  );
}

function normalizeModel(candidate: unknown, refreshedAt: string): ModelCatalogEntry | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  const explicitMediaTypes = extractMediaTypes(record);
  const inferredMediaTypes =
    explicitMediaTypes.length > 0 ? explicitMediaTypes : inferMediaTypes(id);
  const mediaTypes: MediaType[] = inferredMediaTypes.length > 0 ? inferredMediaTypes : ['text'];
  const capabilities = normalizeReasoningEffortCapabilities(
    id,
    mediaTypes,
    isRecord(record.capabilities) ? record.capabilities : undefined,
  );
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
    mediaTypes,
    ...(capabilities ? { capabilities } : {}),
    ...(isRecord(record.limitations)
      ? { limitations: record.limitations }
      : isRecord(record.limits)
        ? { limitations: record.limits }
        : isRecord(record.constraints)
          ? { limitations: record.constraints }
          : {}),
    ...(isRecord(record.price)
      ? { price: record.price }
      : isRecord(record.pricing)
        ? { price: record.pricing }
        : {}),
    refreshedAt,
  };
}

/**
 * Some OpenAI-compatible gateways omit media capabilities entirely. Keep the
 * fallback deliberately narrow; database capability overrides remain the
 * authoritative way to describe non-standard model aliases.
 */
function inferMediaTypes(modelAlias: string): MediaType[] {
  const normalized = modelAlias.trim().toLowerCase();
  if (/^(gpt-image|dall[-_]?e|imagen|flux|sdxl|stable[-_]?diffusion|midjourney)/.test(normalized)) {
    return ['image'];
  }
  if (
    /^(sora|veo|runway|kling|wan[-_]?video|video[-_]?generation)/.test(normalized) ||
    /video/.test(normalized) ||
    /^grok[-_]?imagine/.test(normalized) ||
    /^minimax[-_]?h3/.test(normalized)
  ) {
    return ['video'];
  }
  if (/^(tts|whisper|speech|audio[-_]?generation|eleven)/.test(normalized)) {
    return ['audio'];
  }
  return [];
}

function extractMediaTypes(record: Record<string, unknown>): MediaType[] {
  const values: unknown[] = [];
  for (const key of [
    'mediaType',
    'media_type',
    'type',
    'modality',
    'modalities',
    'mediaTypes',
    'media_types',
    'supportedMediaTypes',
    'supported_media_types',
    'supportedEndpointTypes',
    'supported_endpoint_types',
    'endpointTypes',
    'endpoint_types',
  ]) {
    const value = record[key];
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  const normalized = values
    .flatMap((value) => (typeof value === 'string' ? value.split(/[+,\s]/) : []))
    .map((value) => normalizeMediaType(value))
    .filter((value): value is MediaType => value !== undefined);
  return [...new Set(normalized)];
}

function normalizeMediaType(value: string): MediaType | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]/g, '');
  if (!normalized) return undefined;
  if (['text', 'language', 'chat', 'completion', 'llm'].includes(normalized)) return 'text';
  if (['image', 'images', 'imggeneration', 'imagegeneration'].includes(normalized)) {
    return 'image';
  }
  if (['audio', 'speech', 'tts', 'stt', 'transcription', 'audiogeneration'].includes(normalized)) {
    return 'audio';
  }
  if (['video', 'videos', 'videogeneration'].includes(normalized)) return 'video';
  return undefined;
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

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
  private keyFingerprint = '';
  private readonly encryptionKey: Buffer;
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
    this.encryptionKey = createHash('sha256').update(encryptionSecret).digest();
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
      const currentApiKey = this.encryptedApiKey
        ? decrypt(this.encryptedApiKey, this.encryptionKey)
        : undefined;
      if (input.apiKey !== currentApiKey) {
        this.encryptedApiKey = encrypt(input.apiKey, this.encryptionKey);
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
    const currentApiKey = this.encryptedApiKey
      ? decrypt(this.encryptedApiKey, this.encryptionKey)
      : undefined;
    if (credential.baseUrl === this.baseUrl && credential.apiKey === currentApiKey) {
      return this.get();
    }
    this.baseUrl = credential.baseUrl;
    this.encryptedApiKey = encrypt(credential.apiKey, this.encryptionKey);
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
        decrypt(this.encryptedApiKey, this.encryptionKey),
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
      apiKey: decrypt(this.encryptedApiKey, this.encryptionKey),
    };
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
      apiKey: decrypt(this.encryptedApiKey, this.encryptionKey),
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

/** PostgreSQL-backed AI settings, credential version, defaults and model catalog. */
export class PrismaAiSettingsStore implements AiSettingsStoreLike {
  private readonly memory: AiSettingsStore;
  private readonly ready: Promise<void>;
  private readonly encryptionSecret: string;
  private credentialReference: CredentialReference = {};
  // Serialize writes in this process so concurrent settings requests cannot
  // derive the same credential version or persist another request's memory
  // state. The queue is deliberately kept alive after failures.
  private writeQueue: Promise<void> = Promise.resolve();

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
    this.memory = new AiSettingsStore(encryptionSecret, options);
    this.ready = this.load();
  }

  async get() {
    await this.ready;
    return this.memory.get();
  }

  async update(input: UpdateAiSettingsInput) {
    await this.ready;
    return this.enqueueWrite(async () => {
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
        );
        return result;
      } catch (error) {
        // A database outage must not leave this process serving credentials or
        // defaults that were never durably written.
        this.memory.hydrate(previous, previousReference);
        this.credentialReference = previousStoreReference;
        throw error;
      }
    });
  }

  async listCredentials() {
    await this.ready;
    await this.writeQueue;
    const credentials = await this.prisma.aiCredential.findMany({
      where: { projectId: null },
      orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
    });
    return summarizeCredentials(credentials, this.credentialReference.credentialId);
  }

  async activateCredential(credentialId: string) {
    await this.ready;
    return this.enqueueWrite(async () => {
      const credential = await this.prisma.aiCredential.findFirst({
        where: { id: credentialId, projectId: null },
      });
      if (!credential?.baseUrl || !credential.encryptedApiKey || !credential.keyFingerprint) {
        return undefined;
      }

      const snapshot = new AiSettingsStore(this.encryptionSecret);
      snapshot.hydrate(
        {
          baseUrl: credential.baseUrl,
          encryptedApiKey: credential.encryptedApiKey,
          keyFingerprint: credential.keyFingerprint,
          defaultModels: {},
          updatedAt: credential.updatedAt.toISOString(),
        },
        { credentialId: credential.id, credentialVersion: credential.version },
      );
      const providerCredentials = snapshot.getProviderCredentials();
      if (!providerCredentials) return undefined;

      const previous = this.memory.getPersisted();
      const previousReference = this.memory.getCredentialReference();
      const previousStoreReference = { ...this.credentialReference };
      const result = this.memory.update(providerCredentials);
      if (samePersistedSettings(previous, this.memory.getPersisted())) return result;
      try {
        await this.persistCredential(credential.id);
        return result;
      } catch (error) {
        this.memory.hydrate(previous, previousReference);
        this.credentialReference = previousStoreReference;
        throw error;
      }
    });
  }

  async removeCredentials() {
    await this.ready;
    return this.enqueueWrite(async () => {
      // Do not delete or zero historical rows: queued/running jobs may refer
      // to the current id/version. Append an empty tombstone version to revoke
      // the active credential while leaving every immutable snapshot resolvable.
      const current = await this.prisma.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: { updatedAt: 'desc' },
        select: { version: true },
      });
      if (current) {
        await this.prisma.aiCredential.create({
          data: {
            projectId: null,
            ownerId: null,
            version: current.version + 1,
            baseUrl: '',
            encryptedApiKey: '',
            keyFingerprint: '',
            defaultModels: Prisma.JsonNull,
            label: 'revoked',
          },
        });
      }
      this.credentialReference = {};
      return this.memory.removeCredentials();
    });
  }

  async hasCredential(credentialId: string) {
    await this.ready;
    await this.writeQueue;
    if (!(await this.get()).configured) return false;
    if (credentialId === this.credentialReference.credentialId) {
      return true;
    }
    const credential = await this.prisma.aiCredential.findFirst({
      where: { id: credentialId, projectId: null },
      select: { id: true, baseUrl: true, encryptedApiKey: true },
    });
    return Boolean(credential?.baseUrl && credential.encryptedApiKey);
  }

  async testConnection() {
    await this.ready;
    return this.memory.testConnection();
  }

  async refreshModels(credentialId?: string) {
    await this.ready;
    return this.enqueueWrite(async () => {
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

  async listModels(mediaType?: MediaType, credentialId?: string) {
    await this.ready;
    await this.writeQueue;
    const resolvedCredentialId = credentialId ?? this.credentialReference.credentialId;
    if (credentialId && !(await this.hasCredential(credentialId))) {
      throw new AiCredentialNotFoundError(credentialId);
    }
    return this.memory.listModels(mediaType, resolvedCredentialId);
  }

  async resolveModel(mediaType: MediaType, requestedAlias?: string) {
    await this.ready;
    return this.memory.resolveModel(mediaType, requestedAlias);
  }

  async getCredentialReference(credentialId?: string) {
    await this.ready;
    await this.writeQueue;
    if (credentialId && credentialId !== this.credentialReference.credentialId) {
      if (!(await this.get()).configured) {
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
  }

  async getProviderCredentials(reference?: CredentialReference) {
    await this.ready;
    const requested = reference ?? {};
    if (
      (!requested.credentialId && !requested.credentialVersion) ||
      (requested.credentialId === this.credentialReference.credentialId &&
        requested.credentialVersion === this.credentialReference.credentialVersion)
    ) {
      return this.memory.getProviderCredentials();
    }
    if (!requested.credentialId || !requested.credentialVersion) return undefined;
    const historical = await this.prisma.aiCredential.findFirst({
      where: {
        id: requested.credentialId,
        version: requested.credentialVersion,
        projectId: null,
      },
    });
    if (!historical) return undefined;
    const snapshot = new AiSettingsStore(this.encryptionSecret);
    snapshot.hydrate(
      {
        baseUrl: historical.baseUrl,
        encryptedApiKey: historical.encryptedApiKey,
        keyFingerprint: historical.keyFingerprint,
        defaultModels: isDefaultModels(historical.defaultModels) ? historical.defaultModels : {},
        updatedAt: historical.updatedAt.toISOString(),
      },
      { credentialId: historical.id, credentialVersion: historical.version },
    );
    return snapshot.getProviderCredentials();
  }

  async close() {
    await this.ready;
  }

  private async load() {
    const overrideDelegate = (
      this.prisma as PrismaClient & {
        modelCapabilityOverride?: { findMany: () => Promise<unknown[]> };
      }
    ).modelCapabilityOverride;
    const [credential, catalog, overrides] = await Promise.all([
      this.prisma.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.modelCatalog.findMany(),
      overrideDelegate?.findMany ? overrideDelegate.findMany() : Promise.resolve([]),
    ]);
    if (credential?.baseUrl && credential.encryptedApiKey) {
      this.credentialReference = {
        credentialId: credential.id,
        credentialVersion: credential.version,
      };
      const defaults = isDefaultModels(credential.defaultModels) ? credential.defaultModels : {};
      this.memory.hydrate(
        {
          baseUrl: credential.baseUrl,
          encryptedApiKey: credential.encryptedApiKey,
          keyFingerprint: credential.keyFingerprint,
          defaultModels: defaults,
          updatedAt: credential.updatedAt.toISOString(),
        },
        { credentialId: credential.id, credentialVersion: credential.version },
      );
    } else {
      this.credentialReference = {};
      // A revoked tombstone must override any development-time environment
      // credentials loaded by the in-memory fallback during construction.
      if (credential) this.memory.removeCredentials();
    }
    const activeCredentialId = this.credentialReference.credentialId;
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
      this.memory.replaceModels(
        [...models.values()],
        scopeKey === LEGACY_MODEL_CATALOG_KEY ? undefined : scopeKey,
      );
    }
    this.memory.replaceCapabilityOverrides(normalizeCapabilityOverrides(overrides));
  }

  private async persistCredential(sourceCatalogCredentialId?: string, defaultsOnly = false) {
    const persisted = this.memory.getPersisted();
    if (defaultsOnly && this.credentialReference.credentialId) {
      const update = (
        this.prisma.aiCredential as unknown as {
          update?: (args: {
            where: { id: string };
            data: { defaultModels: PersistedAiSettings['defaultModels']; updatedAt: Date };
          }) => Promise<unknown>;
        }
      ).update;
      if (update) {
        await update({
          where: { id: this.credentialReference.credentialId },
          data: { defaultModels: persisted.defaultModels, updatedAt: new Date() },
        });
        return;
      }
    }
    const existing = await this.prisma.aiCredential.findFirst({
      where: { projectId: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, version: true },
    });
    const data = {
      label: 'default',
      baseUrl: persisted.baseUrl,
      encryptedApiKey: persisted.encryptedApiKey,
      keyFingerprint: persisted.keyFingerprint,
      defaultModels: persisted.defaultModels,
      version: Math.max(
        existing ? existing.version + 1 : 1,
        this.memory.getCredentialReference().credentialVersion ?? 1,
      ),
      projectId: null,
      ownerId: null,
    };
    const current = sourceCatalogCredentialId
      ? await this.prisma.$transaction(async (transaction) => {
          const created = await transaction.aiCredential.create({ data });
          const sourceModels = await transaction.modelCatalog.findMany({
            where: { credentialId: sourceCatalogCredentialId },
          });
          if (sourceModels.length > 0) {
            await transaction.modelCatalog.createMany({
              data: sourceModels.map((model) => copyModelCatalogData(model, created.id)),
            });
          }
          return created;
        })
      : await this.prisma.aiCredential.create({ data });
    if (current) {
      this.credentialReference = {
        credentialId: current.id,
        credentialVersion: current.version,
      };
      if (sourceCatalogCredentialId) {
        this.memory.copyModels(sourceCatalogCredentialId, current.id);
      }
      this.memory.hydrate(persisted, this.credentialReference);
    }
  }

  private async resolveModelCredential(credentialId?: string): Promise<{
    credentialId: string;
    providerCredentials: ProviderCredentials;
  }> {
    const resolvedCredentialId = credentialId ?? this.credentialReference.credentialId;
    if (!resolvedCredentialId) throw new Error('New API 地址和 Key 尚未配置');
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
    const snapshot = new AiSettingsStore(this.encryptionSecret);
    snapshot.hydrate(
      {
        baseUrl: credential.baseUrl,
        encryptedApiKey: credential.encryptedApiKey,
        keyFingerprint: credential.keyFingerprint,
        defaultModels: isDefaultModels(credential.defaultModels) ? credential.defaultModels : {},
        updatedAt: credential.updatedAt.toISOString(),
      },
      { credentialId: credential.id, credentialVersion: credential.version },
    );
    const providerCredentials = snapshot.getProviderCredentials();
    if (!providerCredentials) throw new AiCredentialNotFoundError(resolvedCredentialId);
    return { credentialId: resolvedCredentialId, providerCredentials };
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decrypt(value: string, key: Buffer) {
  const payload = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

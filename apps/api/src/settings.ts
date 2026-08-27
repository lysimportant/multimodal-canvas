import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { normalizeNewApiBaseUrl } from '@multimodal-canvas/providers';
import { Prisma, PrismaClient } from '@prisma/client';

export type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string>>;
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
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
  price?: Record<string, unknown>;
  refreshedAt: string;
};

export type ModelCapabilityOverride = {
  modelAlias: string;
  mediaType: MediaType;
  capabilities: Record<string, unknown>;
};

export type UpdateAiSettingsInput = {
  baseUrl?: string;
  apiKey?: string;
  defaultModels?: Partial<Record<MediaType, string | null>>;
};

export type AiSettingsStoreOptions = {
  /** Injectable for tests; production uses the platform fetch implementation. */
  fetchImpl?: typeof fetch;
  modelRequestTimeoutMs?: number;
  /** Maximum attempts for connection tests and model refreshes. Capped at 10. */
  modelRequestMaxAttempts?: number;
  /** Delay between failed model requests, in milliseconds. */
  modelRequestRetryDelayMs?: number;
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
  defaultModels: Partial<Record<MediaType, string>>;
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
  testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }>;
  refreshModels(): Promise<ModelCatalogEntry[]>;
  listModels(mediaType?: MediaType): ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  resolveModel(mediaType: MediaType, requestedAlias?: string): string | Promise<string>;
  getCredentialReference(): CredentialReference | Promise<CredentialReference>;
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

export class AiSettingsStore {
  private baseUrl = '';
  private encryptedApiKey = '';
  private keyFingerprint = '';
  private readonly encryptionKey: Buffer;
  private readonly fetchImpl?: typeof fetch;
  private readonly modelRequestTimeoutMs: number;
  private readonly modelRequestMaxAttempts: number;
  private readonly modelRequestRetryDelayMs: number;
  private defaultModels: Partial<Record<MediaType, string>> = {};
  private readonly models = new Map<string, ModelCatalogEntry>();
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
    this.modelRequestTimeoutMs = options.modelRequestTimeoutMs ?? 10_000;
    this.modelRequestMaxAttempts = Math.min(
      10,
      Math.max(1, Math.floor(options.modelRequestMaxAttempts ?? 10)),
    );
    this.modelRequestRetryDelayMs = Math.max(
      0,
      Math.floor(options.modelRequestRetryDelayMs ?? 250),
    );
    this.baseUrl = (process.env.NEW_API_BASE_URL ?? '').replace(/\/$/, '');
    const initialApiKey = process.env.NEW_API_API_KEY;
    if (initialApiKey) {
      this.encryptedApiKey = encrypt(initialApiKey, this.encryptionKey);
      this.keyFingerprint = fingerprint(initialApiKey);
      this.registerCredential();
    }
    this.defaultModels = Object.fromEntries(
      mediaTypes.flatMap((mediaType) => {
        const value = process.env[`NEW_API_${mediaType.toUpperCase()}_MODEL`];
        return value ? [[mediaType, value]] : [];
      }),
    ) as Partial<Record<MediaType, string>>;
  }

  get(): AiSettings {
    return {
      baseUrl: this.baseUrl,
      configured: Boolean(this.baseUrl && this.encryptedApiKey),
      ...(this.keyFingerprint ? { keyFingerprint: this.keyFingerprint } : {}),
      defaultModels: { ...this.defaultModels },
      updatedAt: this.updatedAt,
    };
  }

  getPersisted(): PersistedAiSettings {
    return {
      baseUrl: this.baseUrl,
      encryptedApiKey: this.encryptedApiKey,
      keyFingerprint: this.keyFingerprint,
      defaultModels: { ...this.defaultModels },
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
    this.defaultModels = { ...persisted.defaultModels };
    this.updatedAt = persisted.updatedAt;
    this.credentialId = reference?.credentialId;
    this.credentialVersion = reference?.credentialVersion;
    this.registerCredential(false);
  }

  update(input: UpdateAiSettingsInput): AiSettings {
    let changed = false;
    if (input.baseUrl !== undefined) {
      const baseUrl = input.baseUrl.replace(/\/$/, '');
      if (baseUrl !== this.baseUrl) {
        this.baseUrl = baseUrl;
        changed = true;
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
      }
    }
    if (input.defaultModels) {
      const next = { ...this.defaultModels };
      for (const [mediaType, modelAlias] of Object.entries(input.defaultModels)) {
        if (modelAlias === null || modelAlias === '') delete next[mediaType as MediaType];
        else next[mediaType as MediaType] = modelAlias;
      }
      if (!sameDefaultModels(next, this.defaultModels)) {
        this.defaultModels = next;
        changed = true;
      }
    }
    if (!changed) return this.get();
    this.updatedAt = new Date().toISOString();
    this.registerCredential();
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
      );
      return { ok: true, modelCount: response.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '连接失败' };
    }
  }

  async refreshModels(): Promise<ModelCatalogEntry[]> {
    if (!this.baseUrl || !this.encryptedApiKey) throw new Error('New API 地址和 Key 尚未配置');
    const models = await requestModels(
      this.baseUrl,
      decrypt(this.encryptedApiKey, this.encryptionKey),
      this.fetchImpl,
      this.modelRequestTimeoutMs,
      this.modelRequestMaxAttempts,
      this.modelRequestRetryDelayMs,
    );
    this.models.clear();
    for (const model of models) this.models.set(model.id, model);
    return this.listModels();
  }

  replaceModels(models: ModelCatalogEntry[]) {
    this.models.clear();
    for (const model of models) this.models.set(model.id, model);
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
      this.capabilityOverrides.set(capabilityOverrideKey(override.modelAlias, override.mediaType), {
        ...override.capabilities,
      });
    }
  }

  listModels(mediaType?: MediaType): ModelCatalogEntry[] {
    return [...this.models.values()]
      .filter((model) => !mediaType || model.mediaTypes.includes(mediaType))
      .map((model) => (mediaType ? this.withCapabilityOverride(model, mediaType) : model));
  }

  resolveModel(mediaType: MediaType, requestedAlias?: string): string {
    const alias = requestedAlias ?? this.defaultModels[mediaType] ?? `mock-${mediaType}`;
    if (alias.startsWith('mock-')) return alias;

    const catalog = this.listModels();
    const compatibleModels = this.listModels(mediaType);
    if (catalog.length > 0 && !compatibleModels.some((model) => model.id === alias)) {
      throw new AiSettingsError('model_unavailable', `模型 ${alias} 不支持 ${mediaType} 媒体类型`);
    }
    return alias;
  }

  getCredentialReference(): CredentialReference {
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
    const override = this.capabilityOverrides.get(capabilityOverrideKey(model.id, mediaType));
    if (!override) return model;
    return {
      ...model,
      capabilities: { ...(model.capabilities ?? {}), ...override },
    };
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
        await this.persistCredential();
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
        await this.persistCredential();
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

  async testConnection() {
    await this.ready;
    return this.memory.testConnection();
  }

  async refreshModels() {
    await this.ready;
    const models = await this.memory.refreshModels();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.modelCatalog.deleteMany();
      if (models.length > 0) {
        await transaction.modelCatalog.createMany({
          data: models.flatMap((model) =>
            model.mediaTypes.map((mediaType) => ({
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
  }

  async listModels(mediaType?: MediaType) {
    await this.ready;
    return this.memory.listModels(mediaType);
  }

  async resolveModel(mediaType: MediaType, requestedAlias?: string) {
    await this.ready;
    return this.memory.resolveModel(mediaType, requestedAlias);
  }

  async getCredentialReference() {
    await this.ready;
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
      where: { id: requested.credentialId, version: requested.credentialVersion },
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
    const grouped = new Map<string, ModelCatalogEntry>();
    for (const model of catalog) {
      const existing = grouped.get(model.modelAlias);
      const mediaType = fromPrismaMediaType(model.mediaType);
      grouped.set(model.modelAlias, {
        id: model.modelAlias,
        name: model.name,
        mediaTypes: existing ? [...new Set([...existing.mediaTypes, mediaType])] : [mediaType],
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
    }
    this.memory.replaceModels([...grouped.values()]);
    this.memory.replaceCapabilityOverrides(normalizeCapabilityOverrides(overrides));
  }

  private async persistCredential() {
    const persisted = this.memory.getPersisted();
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
    const current = await this.prisma.aiCredential.create({ data });
    if (current) {
      this.credentialReference = {
        credentialId: current.id,
        credentialVersion: current.version,
      };
      this.memory.hydrate(persisted, this.credentialReference);
    }
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

function toPrismaMediaType(mediaType: MediaType) {
  return mediaType.toUpperCase() as 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';
}

function fromPrismaMediaType(mediaType: string): MediaType {
  return mediaType.toLowerCase() as MediaType;
}

function capabilityOverrideKey(modelAlias: string, mediaType: MediaType): string {
  return `${modelAlias.trim()}\0${mediaType}`;
}

function credentialKey(reference: CredentialReference): string {
  return `${reference.credentialId ?? ''}:${reference.credentialVersion ?? ''}`;
}

function sameDefaultModels(
  left: Partial<Record<MediaType, string>>,
  right: Partial<Record<MediaType, string>>,
): boolean {
  return mediaTypes.every((mediaType) => left[mediaType] === right[mediaType]);
}

function samePersistedSettings(left: PersistedAiSettings, right: PersistedAiSettings): boolean {
  return (
    left.baseUrl === right.baseUrl &&
    left.encryptedApiKey === right.encryptedApiKey &&
    left.keyFingerprint === right.keyFingerprint &&
    sameDefaultModels(left.defaultModels, right.defaultModels)
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

function isDefaultModels(value: unknown): value is Partial<Record<MediaType, string>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, alias]) => mediaTypes.includes(key as MediaType) && typeof alias === 'string',
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
      const payload = (await response.json()) as unknown;
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
    merged.set(model.id, {
      ...existing,
      name: model.name !== model.id ? model.name : existing.name,
      mediaTypes: [...new Set([...existing.mediaTypes, ...model.mediaTypes])],
      ...(model.capabilities || existing.capabilities
        ? { capabilities: { ...(existing.capabilities ?? {}), ...(model.capabilities ?? {}) } }
        : {}),
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

function normalizeModel(candidate: unknown, refreshedAt: string): ModelCatalogEntry | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  const explicitMediaTypes = extractMediaTypes(record);
  const inferredMediaTypes =
    explicitMediaTypes.length > 0 ? explicitMediaTypes : inferMediaTypes(id);
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id,
    mediaTypes: inferredMediaTypes.length > 0 ? inferredMediaTypes : ['text'],
    ...(isRecord(record.capabilities) ? { capabilities: record.capabilities } : {}),
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

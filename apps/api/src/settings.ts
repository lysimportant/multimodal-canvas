import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { Prisma, PrismaClient } from '@prisma/client';

export type AiSettings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string>>;
  updatedAt: string;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  mediaTypes: MediaType[];
  capabilities?: Record<string, unknown>;
  price?: Record<string, unknown>;
  refreshedAt: string;
};

export type UpdateAiSettingsInput = {
  baseUrl?: string;
  apiKey?: string;
  defaultModels?: Partial<Record<MediaType, string | null>>;
};

export type CredentialReference = {
  credentialId?: string;
  credentialVersion?: number;
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
  removeCredentials(): AiSettings | Promise<AiSettings>;
  testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }>;
  refreshModels(): Promise<ModelCatalogEntry[]>;
  listModels(mediaType?: MediaType): ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  resolveModel(mediaType: MediaType, requestedAlias?: string): string | Promise<string>;
  getCredentialReference(): CredentialReference | Promise<CredentialReference>;
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
  private defaultModels: Partial<Record<MediaType, string>> = {};
  private readonly models = new Map<string, ModelCatalogEntry>();
  private updatedAt = new Date().toISOString();

  constructor(
    encryptionSecret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
  ) {
    this.encryptionKey = createHash('sha256').update(encryptionSecret).digest();
    this.baseUrl = (process.env.NEW_API_BASE_URL ?? '').replace(/\/$/, '');
    const initialApiKey = process.env.NEW_API_API_KEY;
    if (initialApiKey) {
      this.encryptedApiKey = encrypt(initialApiKey, this.encryptionKey);
      this.keyFingerprint = fingerprint(initialApiKey);
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

  hydrate(persisted: PersistedAiSettings) {
    this.baseUrl = persisted.baseUrl;
    this.encryptedApiKey = persisted.encryptedApiKey;
    this.keyFingerprint = persisted.keyFingerprint;
    this.defaultModels = { ...persisted.defaultModels };
    this.updatedAt = persisted.updatedAt;
  }

  update(input: UpdateAiSettingsInput): AiSettings {
    if (input.baseUrl !== undefined) this.baseUrl = input.baseUrl.replace(/\/$/, '');
    if (input.apiKey !== undefined) {
      this.encryptedApiKey = encrypt(input.apiKey, this.encryptionKey);
      this.keyFingerprint = fingerprint(input.apiKey);
    }
    if (input.defaultModels) {
      const next = { ...this.defaultModels };
      for (const [mediaType, modelAlias] of Object.entries(input.defaultModels)) {
        if (modelAlias === null || modelAlias === '') delete next[mediaType as MediaType];
        else next[mediaType as MediaType] = modelAlias;
      }
      this.defaultModels = next;
    }
    this.updatedAt = new Date().toISOString();
    return this.get();
  }

  removeCredentials(): AiSettings {
    this.encryptedApiKey = '';
    this.keyFingerprint = '';
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
    );
    this.models.clear();
    for (const model of models) this.models.set(model.id, model);
    return this.listModels();
  }

  replaceModels(models: ModelCatalogEntry[]) {
    this.models.clear();
    for (const model of models) this.models.set(model.id, model);
  }

  listModels(mediaType?: MediaType): ModelCatalogEntry[] {
    return [...this.models.values()].filter(
      (model) => !mediaType || model.mediaTypes.includes(mediaType),
    );
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
    return {};
  }
}

/** PostgreSQL-backed AI settings, credential version, defaults and model catalog. */
export class PrismaAiSettingsStore implements AiSettingsStoreLike {
  private readonly memory: AiSettingsStore;
  private readonly ready: Promise<void>;
  private credentialReference: CredentialReference = {};

  constructor(
    private readonly prisma: PrismaClient,
    encryptionSecret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
  ) {
    if (!encryptionSecret?.trim()) {
      throw new Error(
        'AI_CREDENTIAL_ENCRYPTION_KEY is required when PostgreSQL-backed AI settings are enabled',
      );
    }
    this.memory = new AiSettingsStore(encryptionSecret);
    this.ready = this.load();
  }

  async get() {
    await this.ready;
    return this.memory.get();
  }

  async update(input: UpdateAiSettingsInput) {
    await this.ready;
    const result = this.memory.update(input);
    await this.persistCredential();
    return result;
  }

  async removeCredentials() {
    await this.ready;
    await this.prisma.aiCredential.deleteMany({ where: { projectId: null } });
    this.credentialReference = {};
    return this.memory.removeCredentials();
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

  async close() {
    await this.ready;
  }

  private async load() {
    const [credential, catalog] = await Promise.all([
      this.prisma.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.modelCatalog.findMany(),
    ]);
    if (credential) {
      this.credentialReference = {
        credentialId: credential.id,
        credentialVersion: credential.version,
      };
      const defaults = isDefaultModels(credential.defaultModels) ? credential.defaultModels : {};
      this.memory.hydrate({
        baseUrl: credential.baseUrl,
        encryptedApiKey: credential.encryptedApiKey,
        keyFingerprint: credential.keyFingerprint,
        defaultModels: defaults,
        updatedAt: credential.updatedAt.toISOString(),
      });
    }
    const grouped = new Map<string, ModelCatalogEntry>();
    for (const model of catalog) {
      const existing = grouped.get(model.modelAlias);
      const mediaType = fromPrismaMediaType(model.mediaType);
      grouped.set(model.modelAlias, {
        id: model.modelAlias,
        name: model.name,
        mediaTypes: existing ? [...new Set([...existing.mediaTypes, mediaType])] : [mediaType],
        ...(isRecord(model.capabilities) ? { capabilities: model.capabilities } : {}),
        ...(isRecord(model.price) ? { price: model.price } : {}),
        refreshedAt: model.refreshedAt.toISOString(),
      });
    }
    this.memory.replaceModels([...grouped.values()]);
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
      version: existing ? existing.version + 1 : 1,
      projectId: null,
      ownerId: null,
    };
    if (existing) await this.prisma.aiCredential.update({ where: { id: existing.id }, data });
    else await this.prisma.aiCredential.create({ data });
    const current =
      existing ??
      (await this.prisma.aiCredential.findFirst({
        where: { projectId: null },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, version: true },
      }));
    if (current) {
      this.credentialReference = {
        credentialId: current.id,
        credentialVersion: data.version,
      };
    }
  }
}

function toPrismaMediaType(mediaType: MediaType) {
  return mediaType.toUpperCase() as 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO';
}

function fromPrismaMediaType(mediaType: string): MediaType {
  return mediaType.toLowerCase() as MediaType;
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

async function requestModels(baseUrl: string, apiKey: string): Promise<ModelCatalogEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
    const payload = (await response.json()) as { data?: unknown[] };
    return (payload.data ?? []).flatMap(normalizeModel);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeModel(candidate: unknown): ModelCatalogEntry[] {
  if (!candidate || typeof candidate !== 'object') return [];
  const record = candidate as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return [];
  const rawType = typeof record.mediaType === 'string' ? record.mediaType : undefined;
  const mediaTypesFromPayload = Array.isArray(record.mediaTypes)
    ? record.mediaTypes.filter(
        (item): item is MediaType =>
          typeof item === 'string' && mediaTypes.includes(item as MediaType),
      )
    : rawType && mediaTypes.includes(rawType as MediaType)
      ? [rawType as MediaType]
      : ['text' as const];
  return [
    {
      id,
      name: typeof record.name === 'string' ? record.name : id,
      mediaTypes: mediaTypesFromPayload,
      ...(record.capabilities && typeof record.capabilities === 'object'
        ? { capabilities: record.capabilities as Record<string, unknown> }
        : {}),
      ...(record.price && typeof record.price === 'object' && !Array.isArray(record.price)
        ? { price: record.price as Record<string, unknown> }
        : {}),
      refreshedAt: new Date().toISOString(),
    },
  ];
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

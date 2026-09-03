import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { mediaTypes, type MediaType, type ModelSelection } from '@multimodal-canvas/domain';

import {
  AiCredentialNotFoundError,
  AiSettingsStore,
  type AiCredentialSummary,
  type AiSettings,
  type AiSettingsStoreLike,
  type AiSettingsStoreOptions,
  type CredentialReference,
  type ModelCapabilityOverride,
  type ModelCatalogEntry,
  type PersistedAiSettings,
  type ProviderCredentials,
  type UpdateAiSettingsInput,
} from './settings';

/**
 * 本地文件凭据存储的可选配置。
 *
 * 未提供路径时，凭据写入 `.data/ai-credentials.json`，本地加密材料写入同目录的
 * `.data/ai-credentials.key`。生产环境仍应使用 PostgreSQL 和
 * `AI_CREDENTIAL_ENCRYPTION_KEY`，本存储仅用于单进程本地开发。
 */
export type FileAiSettingsStoreOptions = AiSettingsStoreOptions & {
  filePath?: string;
  encryptionKeyFile?: string;
  encryptionSecret?: string;
};

/** 文件内保存的单个不可变凭据版本；API Key 始终为 AES-GCM 密文。 */
type PersistedCredential = PersistedAiSettings & {
  id: string;
  version: number;
};

/** 本地 AI 设置文件的版本化结构。 */
type PersistedFileAiSettingsStore = {
  version: 1;
  activeSettings: PersistedAiSettings;
  activeCredential: CredentialReference;
  credentials: PersistedCredential[];
  modelCatalogs: Record<string, ModelCatalogEntry[]>;
  capabilityOverrides: ModelCapabilityOverride[];
};

/** 包含完整 id 与版本号的不可变凭据引用。 */
type CompleteCredentialReference = Required<CredentialReference>;

/**
 * 无 PostgreSQL 时的本地持久化 AI 设置存储。
 *
 * 它复用内存设置实现的加密和模型解析逻辑，将密文、凭据版本与模型目录写入一个
 * Git 忽略的 JSON 文件。所有写入在单个进程内串行化，并用临时文件替换避免半写入。
 */
export class FileAiSettingsStore implements AiSettingsStoreLike {
  private readonly filePath: string;
  private readonly encryptionKeyFile: string;
  private readonly requestedEncryptionSecret?: string;
  private readonly memoryOptions: AiSettingsStoreOptions;
  private readonly ready: Promise<void>;
  private memory?: AiSettingsStore;
  private encryptionSecret = '';
  private activeCredential: CredentialReference = {};
  private credentials = new Map<string, PersistedCredential>();
  private modelCatalogs = new Map<string, ModelCatalogEntry[]>();
  private capabilityOverrides: ModelCapabilityOverride[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FileAiSettingsStoreOptions = {}) {
    const configuredFile =
      options.filePath ?? process.env.AI_CREDENTIAL_STORAGE_FILE ?? '.data/ai-credentials.json';
    const defaultKeyFile = configuredFile.endsWith('.json')
      ? `${configuredFile.slice(0, -'.json'.length)}.key`
      : `${configuredFile}.key`;
    this.filePath = resolve(configuredFile);
    this.encryptionKeyFile = resolve(
      options.encryptionKeyFile ?? process.env.AI_CREDENTIAL_ENCRYPTION_KEY_FILE ?? defaultKeyFile,
    );
    this.requestedEncryptionSecret =
      options.encryptionSecret?.trim() || process.env.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
    this.memoryOptions = {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.onTestConnectionError
        ? { onTestConnectionError: options.onTestConnectionError }
        : {}),
      ...(options.modelRequestTimeoutMs !== undefined
        ? { modelRequestTimeoutMs: options.modelRequestTimeoutMs }
        : {}),
      ...(options.modelRequestMaxAttempts !== undefined
        ? { modelRequestMaxAttempts: options.modelRequestMaxAttempts }
        : {}),
      ...(options.modelRequestRetryDelayMs !== undefined
        ? { modelRequestRetryDelayMs: options.modelRequestRetryDelayMs }
        : {}),
      ...(options.modelRequestMaxResponseBytes !== undefined
        ? { modelRequestMaxResponseBytes: options.modelRequestMaxResponseBytes }
        : {}),
    };
    this.ready = this.load();
  }

  /** 返回当前设置；响应中不会包含 API Key 明文。 */
  async get(): Promise<AiSettings> {
    await this.ready;
    return this.requireMemory().get();
  }

  /** 更新设置并在成功后持久化；落盘失败会恢复变更前的内存状态。 */
  async update(input: UpdateAiSettingsInput): Promise<AiSettings> {
    await this.ready;
    return this.enqueueWrite(async () => {
      const previous = this.snapshot();
      const memory = this.requireMemory();
      const previousSettings = memory.getPersisted();
      const result = memory.update(input);
      const nextSettings = memory.getPersisted();
      if (samePersistedSettings(previousSettings, nextSettings)) return result;

      try {
        const providerChanged =
          previousSettings.baseUrl !== nextSettings.baseUrl ||
          previousSettings.encryptedApiKey !== nextSettings.encryptedApiKey;
        if (isConfigured(nextSettings)) {
          if (providerChanged || !hasCredentialReference(this.activeCredential)) {
            this.createActiveCredential();
          } else {
            this.updateActiveCredential();
          }
        } else {
          this.activeCredential = {};
        }
        await this.persist();
        return result;
      } catch (error) {
        this.restore(previous);
        throw error;
      }
    });
  }

  /** 列出所有本地保存的凭据摘要，不泄露 API Key 明文。 */
  async listCredentials(): Promise<AiCredentialSummary[]> {
    await this.ready;
    await this.writeQueue;
    return summarizeCredentials([...this.credentials.values()], this.activeCredential.credentialId);
  }

  /** 激活指定历史凭据，并创建一个新的活动版本以冻结后续任务引用。 */
  async activateCredential(credentialId: string): Promise<AiSettings | undefined> {
    await this.ready;
    return this.enqueueWrite(async () => {
      const credential = this.credentials.get(credentialId);
      if (!credential) return undefined;
      const providerCredentials = this.credentialsFor(credential);
      if (!providerCredentials) return undefined;

      const previous = this.snapshot();
      const memory = this.requireMemory();
      const result = memory.update(providerCredentials);
      if (samePersistedSettings(previous.activeSettings, memory.getPersisted())) return result;

      try {
        const active = this.createActiveCredential();
        this.copyModelCatalog(credentialId, active.credentialId!);
        await this.persist();
        return result;
      } catch (error) {
        this.restore(previous);
        throw error;
      }
    });
  }

  /** 取消活动凭据，但保留历史密文供已冻结的任务快照解析。 */
  async removeCredentials(): Promise<AiSettings> {
    await this.ready;
    return this.enqueueWrite(async () => {
      const previous = this.snapshot();
      try {
        const result = this.requireMemory().removeCredentials();
        this.activeCredential = {};
        await this.persist();
        return result;
      } catch (error) {
        this.restore(previous);
        throw error;
      }
    });
  }

  /** 判断凭据是否仍可用于新任务；撤销活动凭据后历史版本不能用于新任务。 */
  async hasCredential(credentialId: string): Promise<boolean> {
    await this.ready;
    await this.writeQueue;
    return this.requireMemory().get().configured && this.credentials.has(credentialId);
  }

  /** 使用当前活动凭据测试上游模型服务连通性。 */
  async testConnection(): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
    await this.ready;
    return this.requireMemory().testConnection();
  }

  /** 刷新指定凭据的模型目录，并将成功结果持久化。 */
  async refreshModels(credentialId?: string): Promise<ModelCatalogEntry[]> {
    await this.ready;
    return this.enqueueWrite(async () => {
      const selected = this.resolveModelCredential(credentialId);
      const previous = this.snapshot();
      try {
        const models = await this.requireMemory().refreshModelsForCredential(
          selected.credentialId,
          selected.providerCredentials,
        );
        this.modelCatalogs.set(selected.credentialId, cloneModels(models));
        await this.persist();
        return models;
      } catch (error) {
        this.restore(previous);
        throw error;
      }
    });
  }

  /** 返回当前或指定历史凭据的模型目录。 */
  async listModels(mediaType?: MediaType, credentialId?: string): Promise<ModelCatalogEntry[]> {
    await this.ready;
    await this.writeQueue;
    if (credentialId && !(await this.hasCredential(credentialId))) {
      throw new AiCredentialNotFoundError(credentialId);
    }
    return this.requireMemory().listModels(
      mediaType,
      credentialId ?? this.activeCredential.credentialId,
    );
  }

  /** 按当前模型目录验证并解析模型别名。 */
  async resolveModel(mediaType: MediaType, requestedAlias?: string): Promise<string> {
    await this.ready;
    return this.requireMemory().resolveModel(mediaType, requestedAlias);
  }

  /** 返回当前或指定历史凭据的不可变版本引用。 */
  async getCredentialReference(credentialId?: string): Promise<CredentialReference> {
    await this.ready;
    await this.writeQueue;
    if (!credentialId || credentialId === this.activeCredential.credentialId) {
      return { ...this.activeCredential };
    }
    if (!this.requireMemory().get().configured) {
      throw new AiCredentialNotFoundError(credentialId);
    }
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new AiCredentialNotFoundError(credentialId);
    return { credentialId: credential.id, credentialVersion: credential.version };
  }

  /**
   * 仅供服务端执行器读取 API Key；HTTP 路由不得调用此方法并返回其结果。
   */
  async getProviderCredentials(
    reference?: CredentialReference,
  ): Promise<ProviderCredentials | undefined> {
    await this.ready;
    const requested = reference ?? {};
    if (
      (!requested.credentialId && !requested.credentialVersion) ||
      (requested.credentialId === this.activeCredential.credentialId &&
        requested.credentialVersion === this.activeCredential.credentialVersion)
    ) {
      return this.requireMemory().getProviderCredentials();
    }
    if (!requested.credentialId || !requested.credentialVersion) return undefined;
    const credential = this.credentials.get(requested.credentialId);
    if (!credential || credential.version !== requested.credentialVersion) return undefined;
    return this.credentialsFor(credential);
  }

  /** 等待初始化和队列中的本地写入完成。 */
  async close(): Promise<void> {
    await this.ready;
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    this.encryptionSecret = await this.resolveEncryptionSecret();
    this.memory = new AiSettingsStore(this.encryptionSecret, this.memoryOptions);
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedFileAiSettingsStore(parsed)) {
        throw new Error(`invalid local AI credential storage file: ${this.filePath}`);
      }
      try {
        this.restore(parsed);
        this.validateStoredCredentials();
      } catch {
        throw new Error(
          `local AI credential storage cannot be decrypted with the configured encryption key: ${this.filePath}`,
        );
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }

  private async resolveEncryptionSecret(): Promise<string> {
    if (this.requestedEncryptionSecret) return this.requestedEncryptionSecret;
    try {
      const existing = (await readFile(this.encryptionKeyFile, 'utf8')).trim();
      if (!existing) {
        throw new Error(`local AI credential encryption key is empty: ${this.encryptionKeyFile}`);
      }
      return existing;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }

    if (await pathExists(this.filePath)) {
      throw new Error(
        `local AI credential storage exists but its encryption key is missing: ${this.encryptionKeyFile}`,
      );
    }

    const generated = randomBytes(32).toString('hex');
    await mkdir(dirname(this.encryptionKeyFile), { recursive: true });
    try {
      await writeFile(this.encryptionKeyFile, `${generated}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return generated;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const existing = (await readFile(this.encryptionKeyFile, 'utf8')).trim();
      if (!existing) {
        throw new Error(`local AI credential encryption key is empty: ${this.encryptionKeyFile}`);
      }
      return existing;
    }
  }

  private createActiveCredential(): CredentialReference {
    const memory = this.requireMemory();
    const persisted = memory.getPersisted();
    const rawReference = memory.getCredentialReference();
    const credentialId = rawReference.credentialId;
    if (!credentialId || !rawReference.credentialVersion || !isConfigured(persisted)) {
      throw new Error('configured local AI settings are missing a credential reference');
    }
    const reference: CompleteCredentialReference = {
      credentialId,
      credentialVersion: this.nextCredentialVersion(),
    };
    memory.hydrate(persisted, reference);
    this.activeCredential = reference;
    this.credentials.set(reference.credentialId, {
      ...persisted,
      id: reference.credentialId,
      version: reference.credentialVersion,
    });
    return reference;
  }

  private updateActiveCredential(): void {
    if (!this.activeCredential.credentialId || !this.activeCredential.credentialVersion) {
      this.createActiveCredential();
      return;
    }
    const persisted = this.requireMemory().getPersisted();
    this.credentials.set(this.activeCredential.credentialId, {
      ...persisted,
      id: this.activeCredential.credentialId,
      version: this.activeCredential.credentialVersion,
    });
  }

  private copyModelCatalog(sourceCredentialId: string, targetCredentialId: string): void {
    const source = this.modelCatalogs.get(sourceCredentialId);
    if (source) {
      this.modelCatalogs.set(
        targetCredentialId,
        source.map((model) => ({ ...structuredClone(model), credentialId: targetCredentialId })),
      );
    }
    this.requireMemory().copyModels(sourceCredentialId, targetCredentialId);
  }

  private resolveModelCredential(credentialId?: string): {
    credentialId: string;
    providerCredentials: ProviderCredentials;
  } {
    const resolvedCredentialId = credentialId ?? this.activeCredential.credentialId;
    if (!resolvedCredentialId) throw new Error('New API 地址和 Key 尚未配置');
    if (resolvedCredentialId === this.activeCredential.credentialId) {
      const providerCredentials = this.requireMemory().getProviderCredentials();
      if (providerCredentials) return { credentialId: resolvedCredentialId, providerCredentials };
    }
    const credential = this.credentials.get(resolvedCredentialId);
    const providerCredentials = credential ? this.credentialsFor(credential) : undefined;
    if (!providerCredentials) {
      if (credentialId) throw new AiCredentialNotFoundError(credentialId);
      throw new Error('New API 地址和 Key 尚未配置');
    }
    return { credentialId: resolvedCredentialId, providerCredentials };
  }

  private credentialsFor(credential: PersistedCredential): ProviderCredentials | undefined {
    const snapshot = new AiSettingsStore(this.encryptionSecret, this.memoryOptions);
    snapshot.hydrate(
      {
        baseUrl: credential.baseUrl,
        encryptedApiKey: credential.encryptedApiKey,
        keyFingerprint: credential.keyFingerprint,
        defaultModels: credential.defaultModels,
        updatedAt: credential.updatedAt,
      },
      { credentialId: credential.id, credentialVersion: credential.version },
    );
    return snapshot.getProviderCredentials();
  }

  private snapshot(): PersistedFileAiSettingsStore {
    return {
      version: 1,
      activeSettings: structuredClone(this.requireMemory().getPersisted()),
      activeCredential: { ...this.activeCredential },
      credentials: [...this.credentials.values()].map((credential) => structuredClone(credential)),
      modelCatalogs: Object.fromEntries(
        [...this.modelCatalogs.entries()].map(([credentialId, models]) => [
          credentialId,
          cloneModels(models),
        ]),
      ),
      capabilityOverrides: structuredClone(this.capabilityOverrides),
    };
  }

  private restore(snapshot: PersistedFileAiSettingsStore): void {
    this.credentials = new Map(
      snapshot.credentials.map((credential) => [credential.id, structuredClone(credential)]),
    );
    this.modelCatalogs = new Map(
      Object.entries(snapshot.modelCatalogs).map(([credentialId, models]) => [
        credentialId,
        cloneModels(models),
      ]),
    );
    this.capabilityOverrides = structuredClone(snapshot.capabilityOverrides);
    this.activeCredential = { ...snapshot.activeCredential };
    this.memory = new AiSettingsStore(this.encryptionSecret, this.memoryOptions);
    this.memory.hydrate(snapshot.activeSettings, this.activeCredential);
    for (const [credentialId, models] of this.modelCatalogs) {
      this.memory.replaceModels(models, credentialId);
    }
    this.memory.replaceCapabilityOverrides(this.capabilityOverrides);
  }

  /**
   * 在服务开始接受请求前校验所有历史密文均可由当前加密材料解开。
   *
   * 不能只校验活动凭据，因为撤销后的历史版本仍可能被冻结任务引用；加密材料错误时
   * 必须在启动阶段失败，而不是让任务运行到一半才失败。
   */
  private validateStoredCredentials(): void {
    for (const credential of this.credentials.values()) {
      if (!this.credentialsFor(credential)) {
        throw new Error('stored credential is not configured');
      }
    }
  }

  private nextCredentialVersion(): number {
    return (
      Math.max(0, ...[...this.credentials.values()].map((credential) => credential.version)) + 1
    );
  }

  private async persist(): Promise<void> {
    const contents = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    await writeUtf8Atomically(this.filePath, contents);
  }

  private requireMemory(): AiSettingsStore {
    if (!this.memory) throw new Error('local AI settings storage has not finished initializing');
    return this.memory;
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

function isConfigured(settings: PersistedAiSettings): boolean {
  return Boolean(settings.baseUrl && settings.encryptedApiKey);
}

function hasCredentialReference(
  reference: CredentialReference,
): reference is CompleteCredentialReference {
  return (
    typeof reference.credentialId === 'string' &&
    reference.credentialId.trim().length > 0 &&
    typeof reference.credentialVersion === 'number' &&
    Number.isSafeInteger(reference.credentialVersion) &&
    reference.credentialVersion > 0
  );
}

function samePersistedSettings(left: PersistedAiSettings, right: PersistedAiSettings): boolean {
  return (
    left.baseUrl === right.baseUrl &&
    left.encryptedApiKey === right.encryptedApiKey &&
    left.keyFingerprint === right.keyFingerprint &&
    sameDefaultModels(left.defaultModels, right.defaultModels)
  );
}

function sameDefaultModels(
  left: Partial<Record<MediaType, string | ModelSelection>>,
  right: Partial<Record<MediaType, string | ModelSelection>>,
): boolean {
  return mediaTypes.every((mediaType) => {
    const leftSelection = normalizeModelSelection(left[mediaType]);
    const rightSelection = normalizeModelSelection(right[mediaType]);
    return (
      leftSelection?.modelAlias === rightSelection?.modelAlias &&
      leftSelection?.credentialId === rightSelection?.credentialId
    );
  });
}

function normalizeModelSelection(
  value: string | ModelSelection | undefined,
): ModelSelection | undefined {
  if (!value) return undefined;
  return typeof value === 'string'
    ? { modelAlias: value.trim() }
    : {
        modelAlias: value.modelAlias.trim(),
        ...(value.credentialId ? { credentialId: value.credentialId } : {}),
      };
}

function cloneModels(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return structuredClone(models);
}

function summarizeCredentials(
  credentials: PersistedCredential[],
  activeCredentialId?: string,
): AiCredentialSummary[] {
  const sorted = credentials
    .filter((credential) => credential.baseUrl && credential.keyFingerprint)
    .map((credential) => ({
      id: credential.id,
      baseUrl: credential.baseUrl,
      keyFingerprint: credential.keyFingerprint,
      updatedAt: credential.updatedAt,
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
    .map((credential) => ({ ...credential, active: credential.id === activeCredentialId }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function isPersistedFileAiSettingsStore(value: unknown): value is PersistedFileAiSettingsStore {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isPersistedAiSettings(value.activeSettings)) return false;
  if (!isCredentialReference(value.activeCredential)) return false;
  if (!Array.isArray(value.credentials) || !value.credentials.every(isPersistedCredential))
    return false;
  const credentials = new Map(value.credentials.map((credential) => [credential.id, credential]));
  if (credentials.size !== value.credentials.length) return false;

  const activeCredential = hasCredentialReference(value.activeCredential)
    ? credentials.get(value.activeCredential.credentialId)
    : undefined;
  const activeSettingsConfigured = isConfigured(value.activeSettings);
  if (activeSettingsConfigured !== Boolean(activeCredential)) {
    return false;
  }
  if (
    activeCredential &&
    (activeCredential.version !== value.activeCredential.credentialVersion ||
      !sameExactPersistedSettings(value.activeSettings, activeCredential))
  ) {
    return false;
  }
  if (!isRecord(value.modelCatalogs)) return false;
  if (
    !Object.entries(value.modelCatalogs).every(
      ([credentialId, models]) =>
        credentials.has(credentialId) &&
        Array.isArray(models) &&
        models.every((model) => isModelCatalogEntry(model, credentialId)),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.capabilityOverrides) ||
    !value.capabilityOverrides.every(isModelCapabilityOverride)
  ) {
    return false;
  }
  return value.capabilityOverrides.every(
    (override) => !override.credentialId || credentials.has(override.credentialId),
  );
}

function isPersistedCredential(value: unknown): value is PersistedCredential {
  if (!isRecord(value)) return false;
  const version = value.version;
  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > 0 &&
    isPersistedAiSettings(value) &&
    Boolean(value.baseUrl && value.encryptedApiKey && value.keyFingerprint)
  );
}

function isPersistedAiSettings(value: unknown): value is PersistedAiSettings {
  return (
    isRecord(value) &&
    typeof value.baseUrl === 'string' &&
    typeof value.encryptedApiKey === 'string' &&
    typeof value.keyFingerprint === 'string' &&
    isDefaultModels(value.defaultModels) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

function isCredentialReference(value: unknown): value is CredentialReference {
  if (!isRecord(value)) return false;
  const id = value.credentialId;
  const version = value.credentialVersion;
  if (id === undefined && version === undefined) return true;
  return (
    typeof id === 'string' &&
    id.trim().length > 0 &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > 0
  );
}

function isDefaultModels(
  value: unknown,
): value is Partial<Record<MediaType, string | ModelSelection>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([mediaType, selection]) =>
        mediaTypes.includes(mediaType as MediaType) && isPersistedModelSelection(selection),
    )
  );
}

/** 校验落盘的默认模型选择，避免将任意 JSON 重新注入运行时设置。 */
function isPersistedModelSelection(value: unknown): value is string | ModelSelection {
  if (typeof value === 'string') return value.trim().length > 0;
  return (
    isRecord(value) &&
    typeof value.modelAlias === 'string' &&
    value.modelAlias.trim().length > 0 &&
    (value.credentialId === undefined ||
      (typeof value.credentialId === 'string' && value.credentialId.trim().length > 0))
  );
}

function isModelCatalogEntry(value: unknown, credentialId: string): value is ModelCatalogEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    Array.isArray(value.mediaTypes) &&
    value.mediaTypes.every((mediaType) => mediaTypes.includes(mediaType as MediaType)) &&
    (value.credentialId === undefined || value.credentialId === credentialId) &&
    (value.capabilities === undefined || isRecord(value.capabilities)) &&
    (value.limitations === undefined || isRecord(value.limitations)) &&
    (value.price === undefined || isRecord(value.price)) &&
    typeof value.refreshedAt === 'string' &&
    Number.isFinite(Date.parse(value.refreshedAt))
  );
}

function isModelCapabilityOverride(value: unknown): value is ModelCapabilityOverride {
  return (
    isRecord(value) &&
    (value.credentialId === undefined ||
      value.credentialId === null ||
      (typeof value.credentialId === 'string' && value.credentialId.trim().length > 0)) &&
    typeof value.modelAlias === 'string' &&
    value.modelAlias.trim().length > 0 &&
    typeof value.mediaType === 'string' &&
    mediaTypes.includes(value.mediaType as MediaType) &&
    isRecord(value.capabilities)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 检查目标路径是否存在；权限等其他 I/O 错误必须向上抛出。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 比较活动设置与活动凭据，包含更新时间以检测不完整或串改的状态文件。 */
function sameExactPersistedSettings(
  settings: PersistedAiSettings,
  credential: PersistedAiSettings,
): boolean {
  return samePersistedSettings(settings, credential) && settings.updatedAt === credential.updatedAt;
}

async function writeUtf8Atomically(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (!isNodeError(error) || !['EEXIST', 'EPERM'].includes(error.code ?? '')) throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

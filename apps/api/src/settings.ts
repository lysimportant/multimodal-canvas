import { type MediaType, type ModelSelection } from '@multimodal-canvas/domain';

/** 当前用户的模型偏好与 Provider 请求超时。 */
export type AiSettings = {
  configured: boolean;
  defaultModels: Partial<Record<MediaType, string | ModelSelection>>;
  /** Provider 单次请求超时，单位毫秒。 */
  timeoutMs: number;
  updatedAt: string;
};

/** 可供当前用户选择的 New API 分组凭据摘要，不包含密钥材料。 */
export type AiCredentialSummary = {
  id: string;
  /** 管理关系当前绑定的不可变凭据修订号。 */
  version?: number;
  group: string;
  status: string;
  error?: string;
  updatedAt: string;
  active: boolean;
  defaultModels?: Partial<Record<MediaType, string | ModelSelection>>;
};

/** 规范化后的模型目录条目；同名模型可通过 credentialId/group 保持独立。 */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  mediaTypes: MediaType[];
  credentialId?: string;
  capabilities?: Record<string, unknown>;
  limitations?: Record<string, unknown>;
  price?: Record<string, unknown>;
  refreshedAt: string;
  /** 本人 New API 原始分组与执行合同，同名模型跨组保持独立。 */
  group?: string;
  contract?: string;
  available?: boolean;
  unavailableReason?: string;
};

/** 用户可修改的模型偏好；分组地址和 Key 只由 New API 授权同步。 */
export type UpdateAiSettingsInput = {
  defaultModels?: Partial<Record<MediaType, string | ModelSelection | null>>;
  /** Provider 单次请求超时，单位毫秒；范围为 1 秒至 Node 定时器上限。 */
  timeoutMs?: number;
};

/** 设置更新后的安全视图。 */
export type AiSettingsUpdateResult = AiSettings;

/** 任务快照引用的不可变凭据 ID 与版本。 */
export type CredentialReference = {
  credentialId?: string;
  credentialVersion?: number;
};

/** 仅供服务端执行器读取的 Provider 凭据，禁止从 HTTP 响应返回。 */
export type ProviderCredentials = {
  baseUrl: string;
  apiKey: string;
};

/** API、运行解析和 Worker 共用的本人 New API 设置合同。 */
export interface AiSettingsStoreLike {
  /** 读取当前用户的模型偏好和超时。 */
  get(): AiSettings | Promise<AiSettings>;
  /** 更新当前用户的模型偏好和超时。 */
  update(input: UpdateAiSettingsInput): AiSettingsUpdateResult | Promise<AiSettingsUpdateResult>;
  /** 列出当前用户可用的分组凭据摘要。 */
  listCredentials(): AiCredentialSummary[] | Promise<AiCredentialSummary[]>;
  /** 判断凭据是否属于当前用户且可用于新任务。 */
  hasCredential(credentialId: string): boolean | Promise<boolean>;
  /** 从 New API 重新同步目录并返回指定范围的模型。 */
  refreshModels(credentialId?: string): Promise<ModelCatalogEntry[]>;
  /** 按媒体类型和凭据范围读取模型目录。 */
  listModels(
    mediaType?: MediaType,
    credentialId?: string,
  ): ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>;
  /** 解析显式模型或当前用户默认模型。 */
  resolveModel(mediaType: MediaType, requestedAlias?: string): string | Promise<string>;
  /** 冻结指定分组凭据的精确 ID 和版本。 */
  getCredentialReference(credentialId?: string): CredentialReference | Promise<CredentialReference>;
  /** 按冻结引用读取服务端凭据；测试替身可省略。 */
  getProviderCredentials?(
    reference?: CredentialReference,
  ): ProviderCredentials | undefined | Promise<ProviderCredentials | undefined>;
  /** 释放适配器持有的连接。 */
  close?(): Promise<void>;
}

/** 模型解析失败时返回稳定错误码。 */
export class AiSettingsError extends Error {
  /**
   * @param code 对外稳定错误码。
   * @param message 可直接返回给客户端的中文错误说明。
   */
  constructor(
    public readonly code: 'model_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** 当前用户无权访问指定凭据时抛出的稳定错误。 */
export class AiCredentialNotFoundError extends Error {
  readonly code = 'credential_not_found';

  /** @param credentialId 未找到或不属于当前用户的凭据 ID。 */
  constructor(credentialId: string) {
    super(`AI credential ${credentialId} was not found`);
  }
}

/** Provider 默认超时，单位毫秒；视频任务需要较长等待窗口。 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;

/** Node.js 定时器支持的最大毫秒数，防止溢出后立即超时。 */
const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

/**
 * 校验并规范化 Provider 超时。
 *
 * @param value 待校验值；未提供时使用 fallback。
 * @param fallback 缺省超时，默认 15 分钟。
 * @returns 1 秒至 Node 定时器上限内的整数毫秒值。
 * @throws TypeError 值不是范围内安全整数时抛出。
 */
export function normalizeProviderTimeout(
  value: unknown,
  fallback = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  const timeoutMs = value === undefined ? fallback : value;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > MAX_PROVIDER_TIMEOUT_MS
  ) {
    throw new TypeError('Provider timeout must be an integer between 1000 and 2147483647 ms');
  }
  return timeoutMs;
}

const GPT_56_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const LEGACY_GPT_56_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const GPT_56_TEXT_MODEL_ALIAS_PATTERN = /^gpt-5\.6(?:$|[-_.])/;

/**
 * 规范化 OpenAI `{ data: [...] }` 与常见网关模型目录。
 *
 * @param payload 上游 JSON 响应。
 * @returns 去重后的安全模型目录；无效记录会被忽略。
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

function normalizeReasoningEffortCapabilities(
  modelAlias: string,
  mediaTypes: MediaType[],
  capabilities: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!mediaTypes.includes('text')) return capabilities;
  if (!GPT_56_TEXT_MODEL_ALIAS_PATTERN.test(modelAlias.trim().toLowerCase())) return capabilities;
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

function isLowOnlyReasoningEffort(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().toLowerCase() === 'low')
  );
}

function isGpt56ReasoningEffortFallback(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === GPT_56_REASONING_EFFORTS.length &&
    value.every((item, index) => item === GPT_56_REASONING_EFFORTS[index])
  );
}

function isLegacyGpt56ReasoningEffortFallback(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === LEGACY_GPT_56_REASONING_EFFORTS.length &&
    value.every((item, index) => item === LEGACY_GPT_56_REASONING_EFFORTS[index])
  );
}

function normalizeModel(candidate: unknown, refreshedAt: string): ModelCatalogEntry | undefined {
  if (!isRecord(candidate)) return undefined;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  if (!id) return undefined;
  const explicitMediaTypes = extractMediaTypes(candidate);
  const inferredMediaTypes =
    explicitMediaTypes.length > 0 ? explicitMediaTypes : inferMediaTypes(id);
  const mediaTypes: MediaType[] = inferredMediaTypes.length > 0 ? inferredMediaTypes : ['text'];
  const capabilities = normalizeReasoningEffortCapabilities(
    id,
    mediaTypes,
    isRecord(candidate.capabilities) ? candidate.capabilities : undefined,
  );
  return {
    id,
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : id,
    mediaTypes,
    ...(capabilities ? { capabilities } : {}),
    ...(isRecord(candidate.limitations)
      ? { limitations: candidate.limitations }
      : isRecord(candidate.limits)
        ? { limitations: candidate.limits }
        : isRecord(candidate.constraints)
          ? { limitations: candidate.constraints }
          : {}),
    ...(isRecord(candidate.price)
      ? { price: candidate.price }
      : isRecord(candidate.pricing)
        ? { price: candidate.pricing }
        : {}),
    refreshedAt,
  };
}

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
  if (/^(tts|whisper|speech|audio[-_]?generation|eleven)/.test(normalized)) return ['audio'];
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
    .map(normalizeMediaType)
    .filter((value): value is MediaType => value !== undefined);
  return [...new Set(normalized)];
}

function normalizeMediaType(value: string): MediaType | undefined {
  const normalized = value.trim().toLowerCase().replace(/[_-]/g, '');
  if (!normalized) return undefined;
  if (['text', 'language', 'chat', 'completion', 'llm'].includes(normalized)) return 'text';
  if (['image', 'images', 'imggeneration', 'imagegeneration'].includes(normalized)) return 'image';
  if (['audio', 'speech', 'tts', 'stt', 'transcription', 'audiogeneration'].includes(normalized)) {
    return 'audio';
  }
  if (['video', 'videos', 'videogeneration'].includes(normalized)) return 'video';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

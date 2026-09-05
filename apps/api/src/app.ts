import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  createAssetAccessToken,
  detectMediaType,
  MemoryAssetStore,
  verifyAssetAccessToken,
  type AssetScope,
  type AssetListOptions,
  type AssetStore,
} from './assets';
import {
  MemoryProjectStore,
  ProjectStoreError,
  type ProjectModelDefaults,
  type ProjectScope,
  type ProjectStore,
  type UpdateProjectModelDefaultsInput,
} from './projects';
import {
  createRunSnapshot,
  getRunSnapshotIncludedNodeIds,
  MemoryRunService,
  RunServiceError,
  type ProviderWebhookUpdate,
  type FrozenRunAssetRef,
  type RunExecutor,
  type RunResultArchiver,
  type RunService,
} from './runs';
import { databaseRunId, type PrismaRunPersistence } from './run-persistence';
import {
  canvasDocumentSchema,
  mediaTypes,
  promptDocumentSchema,
  type CanvasDocument,
  type FrozenPromptMention,
  type MediaType,
  type PromptDocument,
  type PromptMention,
  type RunCredentialReference,
  type RunRecord,
  type RunResultAsset,
} from '@multimodal-canvas/domain';
import { z } from 'zod';
import {
  AiCredentialNotFoundError,
  AiSettingsError,
  AiSettingsStore,
  type AiSettingsStoreLike,
  type ModelCatalogEntry,
} from './settings';
import type { ModelSelection } from '@multimodal-canvas/domain';
import { openApiDocument } from './openapi';
import { MemoryWebhookEventStore, type WebhookEventStore } from './webhooks';
import {
  NoopMediaMetadataExtractor,
  NoopMediaDerivativeGenerator,
  type MediaDerivativeGenerator,
  type MediaMetadataExtractor,
  type MediaProbeInput,
} from './media';
import {
  MemoryUploadSessionStore,
  type UploadSessionScope,
  type UploadSessionStore,
} from './upload-sessions';
import {
  createEnvironmentObservability,
  sanitizeExceptionForObservability,
  type Observability,
  type ObservabilitySpan,
} from '@multimodal-canvas/observability';
import { extractBearerToken, authenticateBearer, type AuthPrincipal } from './auth';
import { AuthService, AuthServiceError, type AuthenticatedSession } from './auth-service';
import { MemoryAuthStore, type AuthStore } from './auth-store';
import { quoteModelCost, UsagePolicyError } from './usage-policy';
import {
  attachmentDisposition,
  createWorkflowExport,
  ExportError,
  prepareResultsExport,
  resolveExportLimits,
} from './export';
import { ArchiveError, buildZipArchive } from './export-archive';
import { MemoryRateLimiter, RateLimitUnavailableError, type RateLimiter } from './rate-limit';
import {
  checkResourceMentionCapabilities,
  type ResourceMentionCapabilityDiagnostic,
} from './resource-mention-capabilities';
import { importWorkflowExport, WorkflowImportError } from './workflow-import';

type AppLoggerOptions = {
  level?: string;
  redact?: { paths: string[]; censor: string };
  serializers?: {
    req?: (request: FastifyRequest) => Record<string, unknown>;
  };
  stream?: { write(message: string): void };
};

export type BuildAppOptions = {
  assetStore?: AssetStore;
  projectStore?: ProjectStore;
  runService?: RunService;
  /** Provider-like executor for an in-memory/local run service. */
  runExecutor?: RunExecutor;
  /** Optional result archiver; defaults to the configured asset store. */
  runResultArchiver?: RunResultArchiver;
  /** Optional backing-store check for JWT subjects in production. */
  userExists?: (userId: string) => Promise<boolean>;
  logger?: boolean | AppLoggerOptions;
  observability?: Observability;
  settingsStore?: AiSettingsStoreLike;
  webhookEventStore?: WebhookEventStore;
  /** Optional durable lifecycle persistence for provider callbacks. */
  runPersistence?: Pick<PrismaRunPersistence, 'upsertProviderJob' | 'updateRun'>;
  mediaMetadataExtractor?: MediaMetadataExtractor;
  mediaDerivativeGenerator?: MediaDerivativeGenerator;
  uploadSessionStore?: UploadSessionStore;
  /** Stateful user/session store used by the first-party authentication routes. */
  authStore?: AuthStore;
  /** Injectable authentication service for tests or custom deployments. */
  authService?: AuthService;
  /** Shared limiter; defaults to a bounded in-memory fallback. */
  rateLimiter?: RateLimiter;
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_SSE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_SSE_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_ASSET_LIST_PAGE = 1;
const DEFAULT_ASSET_LIST_PAGE_SIZE = 50;
const MAX_ASSET_LIST_PAGE_SIZE = 200;

type AssetListQuery = {
  /** 资源所属项目；提供后只返回该项目资源和当前用户的个人资源。 */
  projectId?: string;
  query?: string;
  mediaType?: string;
  status?: string;
  tags?: string | string[];
  page?: string;
  pageSize?: string;
};

const assetListQuerySchema = z.object({
  projectId: z.string().trim().min(1).max(512).optional(),
  query: z.string().trim().max(512).optional(),
  mediaType: z.enum(['text', 'image', 'audio', 'video']).optional(),
  status: z.enum(['ready', 'archived']).optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .transform((values) => values.flatMap((value) => value.split(',')))
    .transform((values) => values.map((value) => value.trim()).filter(Boolean))
    .refine((values) => values.length <= 32 && values.every((value) => value.length <= 64), {
      message: 'invalid asset tags',
    })
    .optional(),
  page: parsePositiveQueryInt().optional(),
  pageSize: parsePositiveQueryInt()
    .refine((value) => value <= MAX_ASSET_LIST_PAGE_SIZE, 'asset page size is too large')
    .optional(),
});

type RunRequestBody = {
  projectId: string;
  modelAlias?: string;
  credentialId?: string;
  idempotencyKey?: string;
  parameters?: Record<string, unknown>;
  promptDocument?: PromptDocument;
};

const runRequestBodySchema = z.object({
  projectId: z.string().min(1),
  modelAlias: z.string().trim().min(1).max(160).optional(),
  credentialId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  parameters: z.record(z.unknown()).optional(),
  // Parse this field separately to keep Fastify's route type instantiation
  // bounded while retaining the domain schema and its diagnostics.
  promptDocument: z.unknown().optional(),
});

function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    // Access tokens and other credentials may be carried in the query string
    // for short-lived resource URLs, so keep query parameters out of logs.
    url: request.url.split('?')[0],
    version: request.raw.httpVersion,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

type PublicRunSnapshot = {
  canvasRevision: number;
  inputCount: number;
  /** Legacy Web clients only read `.length`; item contents stay server-side. */
  inputs: null[];
  /** 已冻结的资源提及元数据；不包含 URL、凭据或媒体内容。 */
  promptMentions?: FrozenPromptMention[];
};

type PublicRunResultAsset = {
  assetId: string;
  version?: number;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
};

type PublicRunResult = {
  provider: string;
  summary: string;
  targetNodeId: string;
  mediaType: MediaType;
  inputCount: number;
  /** Mock 预览结果必须明确标记，不能被误认为真实供应商输出。 */
  simulated?: boolean;
  asset?: PublicRunResultAsset;
  /** 仅返回冻结提及元数据，不返回媒体内容、URL 或凭据。 */
  promptMentions?: FrozenPromptMention[];
};

type PublicRunFields = {
  id: string;
  projectId: string;
  targetNodeId: string;
  status: RunRecord['status'];
  progress: number;
  attempt: number;
  provider: string;
  modelAlias: string;
  result?: PublicRunResult;
  error?: string;
  retryOf?: string;
  createdAt: string;
  updatedAt: string;
};

type PublicRunRecord = PublicRunFields & {
  snapshot: PublicRunSnapshot;
};

type PublicRunEvent = PublicRunFields;

type RunNodeModelResolution = {
  targetModelAlias: string;
  nodeModelAliases: Record<string, string>;
  nodeCredentialReferences: Record<string, RunCredentialReference>;
  targetModel?: ModelCatalogEntry;
  /** 每个可执行节点实际解析到的模型，供提交前能力预检使用。 */
  nodeModels: Record<string, ModelCatalogEntry | undefined>;
};

class ResourceMentionCapabilityError extends Error {
  constructor(public readonly diagnostics: ResourceMentionCapabilityDiagnostic[]) {
    super('资源提及与当前模型能力不兼容');
  }
}

class RunAssetFreezeError extends Error {
  constructor(
    public readonly code: 'asset_unavailable' | 'asset_version_unavailable',
    message: string,
  ) {
    super(message);
  }
}

export type ResourceMentionFailureReason =
  | 'not_found'
  | 'forbidden'
  | 'archived'
  | 'version_missing'
  | 'mime_mismatch'
  | 'size_exceeded'
  | 'placeholder';

export type ResourceMentionDiagnostic = {
  code: `RESOURCE_MENTION_${Uppercase<ResourceMentionFailureReason>}`;
  message: string;
  requestId: string;
  nodeId: string;
  mentionId: string;
  assetId: string;
  mediaType: MediaType;
  reason: ResourceMentionFailureReason;
};

class ResourceMentionFreezeError extends Error {
  readonly diagnostics: ResourceMentionDiagnostic[];

  constructor(diagnostics: ResourceMentionDiagnostic[]) {
    super('资源提及无法冻结');
    this.diagnostics = diagnostics;
  }
}

/**
 * Validate project defaults before touching the project store. A default can
 * be a legacy unbound alias, but a bound selection must point at a usable
 * credential-scoped catalog entry. Unbound aliases are rejected when more
 * than one credential exposes the same model so the later run snapshot has a
 * deterministic credential reference.
 */
async function validateProjectModelDefaults(input: {
  settingsStore: AiSettingsStoreLike;
  defaults: UpdateProjectModelDefaultsInput;
  allowVirtualMockModels: boolean;
  requireCredentialReferences: boolean;
  unboundCredentialScope?: 'all' | 'active';
}): Promise<void> {
  const credentials = await Promise.resolve(input.settingsStore.listCredentials());
  const catalogCache = new Map<string, Promise<ModelCatalogEntry[]>>();
  const getCatalog = (mediaType: MediaType, credentialId?: string) => {
    const key = `${credentialId ?? 'active'}\0${mediaType}`;
    const cached = catalogCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(input.settingsStore.listModels(mediaType, credentialId));
    catalogCache.set(key, pending);
    return pending;
  };

  for (const mediaType of mediaTypes) {
    if (!Object.prototype.hasOwnProperty.call(input.defaults, mediaType)) continue;
    const configured = input.defaults[mediaType];
    if (configured === null || configured === undefined) continue;

    const selection = typeof configured === 'string' ? { modelAlias: configured } : configured;
    const alias = selection.modelAlias.trim();
    const credentialId = selection.credentialId?.trim();
    if (!alias) {
      throw new AiSettingsError('model_unavailable', `未配置可用的 ${mediaType} 项目默认模型`);
    }

    if (alias === `mock-${mediaType}` && !credentialId && input.allowVirtualMockModels) {
      continue;
    }
    if (alias.startsWith('mock-')) {
      throw new AiSettingsError(
        'model_unavailable',
        `模型 ${alias} 不能作为 ${mediaType} 的生产项目默认模型`,
      );
    }

    if (credentialId) {
      if (!(await Promise.resolve(input.settingsStore.hasCredential(credentialId)))) {
        throw new AiCredentialNotFoundError(credentialId);
      }
      const catalog = await getCatalog(mediaType, credentialId);
      const model = catalog.find(
        (candidate) =>
          candidate.id === alias &&
          candidate.mediaTypes.includes(mediaType) &&
          (!candidate.credentialId || candidate.credentialId === credentialId),
      );
      if (!model) {
        throw new AiSettingsError(
          'model_unavailable',
          `模型 ${alias} 不支持 ${mediaType} 媒体类型或未绑定到指定 API Key`,
        );
      }
      if (input.requireCredentialReferences) {
        await requireCredentialReference(input.settingsStore, credentialId, alias);
      }
      continue;
    }

    if (input.unboundCredentialScope === 'active') {
      const activeReference = await Promise.resolve(input.settingsStore.getCredentialReference());
      if (activeReference.credentialId) {
        const catalog = await getCatalog(mediaType, activeReference.credentialId);
        const model = catalog.find(
          (candidate) =>
            candidate.id === alias &&
            candidate.mediaTypes.includes(mediaType) &&
            (!candidate.credentialId || candidate.credentialId === activeReference.credentialId),
        );
        if (!model) {
          throw new AiSettingsError(
            'model_unavailable',
            `模型 ${alias} 不支持 ${mediaType} 媒体类型或不在当前 API Key 的模型目录中`,
          );
        }
        if (input.requireCredentialReferences) {
          await requireCredentialReference(
            input.settingsStore,
            activeReference.credentialId,
            alias,
          );
        }
        continue;
      }
    }

    const unscopedCatalog = await getCatalog(mediaType);
    const credentialMatches = new Map<string, ModelCatalogEntry>();
    await Promise.all(
      credentials.map(async (credential) => {
        const catalog = await getCatalog(mediaType, credential.id);
        const model = catalog.find(
          (candidate) =>
            candidate.id === alias &&
            candidate.mediaTypes.includes(mediaType) &&
            (!candidate.credentialId || candidate.credentialId === credential.id),
        );
        if (model) credentialMatches.set(credential.id, model);
      }),
    );

    if (credentialMatches.size > 1) {
      throw new AiSettingsError(
        'model_unavailable',
        `模型 ${alias} 在多个 API Key 中存在，请明确指定 credentialId`,
      );
    }
    if (credentialMatches.size === 1) {
      if (input.requireCredentialReferences) {
        await requireCredentialReference(
          input.settingsStore,
          [...credentialMatches.keys()][0],
          alias,
        );
      }
      continue;
    }

    const legacyModel = unscopedCatalog.find(
      (candidate) => candidate.id === alias && !candidate.credentialId,
    );
    if (!legacyModel || !legacyModel.mediaTypes.includes(mediaType)) {
      throw new AiSettingsError(
        'model_unavailable',
        `模型 ${alias} 不支持 ${mediaType} 媒体类型或不在模型目录中`,
      );
    }
    if (input.requireCredentialReferences) {
      await requireCredentialReference(input.settingsStore, undefined, alias);
    }
  }
}

async function requireCredentialReference(
  settingsStore: AiSettingsStoreLike,
  credentialId: string | undefined,
  alias: string,
): Promise<void> {
  const reference = await Promise.resolve(settingsStore.getCredentialReference(credentialId));
  if (!reference.credentialId || !reference.credentialVersion) {
    throw new AiSettingsError('model_unavailable', `模型 ${alias} 未绑定可用的 API Key`);
  }
}

/**
 * Resolve and validate every executable node in a run's upstream closure at
 * submission time. The resulting aliases are passed into the immutable run
 * snapshot; later project/settings changes therefore cannot affect retries.
 */
async function resolveRunNodeModels(input: {
  settingsStore: AiSettingsStoreLike;
  canvas: CanvasDocument;
  targetNodeId: string;
  requestModelAlias?: string;
  credentialId?: string;
  projectDefaults?: ProjectModelDefaults;
  allowVirtualMockModels: boolean;
  requireCredentialReferences: boolean;
}): Promise<RunNodeModelResolution> {
  const target = input.canvas.nodes.find((node) => node.id === input.targetNodeId);
  if (!target) throw new RunServiceError('invalid_target', 'run target node not found');
  if (target.data.mode === 'source') {
    throw new RunServiceError('invalid_target', 'source nodes cannot be run directly');
  }
  if (target.data.enabled === false) {
    throw new RunServiceError('invalid_target', 'disabled nodes cannot be run');
  }

  const globalSettings = await input.settingsStore.get();
  const runCredentialId = input.credentialId ?? target.data.credentialId;
  const catalogCache = new Map<string, Promise<ModelCatalogEntry[]>>();
  const credentialCache = new Map<string, Promise<RunCredentialReference | undefined>>();
  const getCatalog = (mediaType: MediaType, credentialId?: string) => {
    const key = `${credentialId ?? 'active'}\0${mediaType}`;
    const cached = catalogCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(input.settingsStore.listModels(mediaType, credentialId));
    catalogCache.set(key, pending);
    return pending;
  };
  const getCredentialReference = (credentialId?: string) => {
    const key = credentialId ?? 'active';
    const cached = credentialCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(input.settingsStore.getCredentialReference(credentialId)).then(
      (reference) =>
        reference.credentialId && reference.credentialVersion
          ? {
              credentialId: reference.credentialId,
              credentialVersion: reference.credentialVersion,
            }
          : undefined,
    );
    credentialCache.set(key, pending);
    return pending;
  };

  const includedNodeIds = getRunSnapshotIncludedNodeIds(input.canvas, input.targetNodeId);
  const nodeModelAliases: Record<string, string> = {};
  const nodeCredentialReferences: Record<string, RunCredentialReference> = {};
  const nodeModels: Record<string, ModelCatalogEntry | undefined> = {};
  let targetModel: ModelCatalogEntry | undefined;

  for (const node of input.canvas.nodes) {
    if (
      !includedNodeIds.has(node.id) ||
      node.data.enabled === false ||
      node.data.mode === 'source'
    ) {
      continue;
    }

    const mediaType = node.data.mediaType;
    const nodeCredentialId =
      node.id === input.targetNodeId ? runCredentialId : node.data.credentialId;
    const requestedAlias = node.id === input.targetNodeId ? input.requestModelAlias : undefined;
    const configured = [
      requestedAlias ? { modelAlias: requestedAlias, credentialId: nodeCredentialId } : undefined,
      node.data.modelAlias
        ? {
            modelAlias: node.data.modelAlias,
            ...(node.data.credentialId ? { credentialId: node.data.credentialId } : {}),
          }
        : undefined,
      input.projectDefaults?.[mediaType],
      globalSettings.defaultModels?.[mediaType],
    ].find(Boolean) as string | ModelSelection | undefined;
    const selected = configured
      ? typeof configured === 'string'
        ? { modelAlias: configured }
        : configured
      : input.allowVirtualMockModels
        ? { modelAlias: `mock-${mediaType}` }
        : undefined;
    const alias = selected?.modelAlias?.trim();
    if (!alias) {
      throw new AiSettingsError(
        'model_unavailable',
        `节点 ${node.id} 未配置可用的 ${mediaType} 模型`,
      );
    }
    const selectedCredentialId = selected?.credentialId?.trim();
    if (nodeCredentialId && selectedCredentialId && selectedCredentialId !== nodeCredentialId) {
      throw new AiSettingsError(
        'model_unavailable',
        `模型 ${alias} 的默认凭据与节点 ${node.id} 指定的 API Key 不一致`,
      );
    }
    let effectiveCredentialId = nodeCredentialId ?? selectedCredentialId;
    let catalog = await getCatalog(mediaType, effectiveCredentialId);
    if (!effectiveCredentialId && alias && !alias.startsWith('mock-')) {
      const candidates = await Promise.all(
        (await Promise.resolve(input.settingsStore.listCredentials())).map(async (credential) => ({
          credentialId: credential.id,
          models: await getCatalog(mediaType, credential.id),
        })),
      );
      const matches = candidates.filter((candidate) =>
        candidate.models.some(
          (model) =>
            model.id === alias &&
            model.mediaTypes.includes(mediaType) &&
            (!model.credentialId || model.credentialId === candidate.credentialId),
        ),
      );
      if (matches.length > 1) {
        throw new AiSettingsError(
          'model_unavailable',
          `模型 ${alias} 在多个 API Key 中存在，请明确指定 credentialId（节点 ${node.id}）`,
        );
      }
      if (matches.length === 1) {
        effectiveCredentialId = matches[0].credentialId;
        catalog = matches[0].models;
      }
    }
    const model = catalog.find(
      (candidate) =>
        candidate.id === alias &&
        candidate.mediaTypes.includes(mediaType) &&
        (!candidate.credentialId ||
          !effectiveCredentialId ||
          candidate.credentialId === effectiveCredentialId),
    );
    const virtualMockModel =
      input.allowVirtualMockModels && !nodeCredentialId && alias === `mock-${mediaType}`;
    if (!model && !virtualMockModel) {
      throw new AiSettingsError(
        'model_unavailable',
        `模型 ${alias} 不支持 ${mediaType} 媒体类型（节点 ${node.id}）`,
      );
    }

    nodeModelAliases[node.id] = alias;
    nodeModels[node.id] = model;
    if (!virtualMockModel) {
      const reference = await getCredentialReference(
        model?.credentialId ?? effectiveCredentialId ?? nodeCredentialId,
      );
      if (reference) {
        nodeCredentialReferences[node.id] = reference;
      } else if (input.requireCredentialReferences) {
        throw new AiSettingsError(
          'model_unavailable',
          `模型 ${alias} 未绑定可用的 API Key（节点 ${node.id}）`,
        );
      }
    }
    if (node.id === input.targetNodeId) targetModel = model;
  }

  const targetModelAlias = nodeModelAliases[input.targetNodeId];
  if (!targetModelAlias) {
    throw new RunServiceError('invalid_target', 'run target node not found');
  }
  return {
    targetModelAlias,
    nodeModelAliases,
    nodeCredentialReferences,
    nodeModels,
    ...(targetModel ? { targetModel } : {}),
  };
}

async function resolveRunAssetRefs(input: {
  assetStore: AssetStore;
  canvas: CanvasDocument;
  targetNodeId: string;
  projectId: string;
  ownerId?: string;
}): Promise<Record<string, FrozenRunAssetRef>> {
  const includedNodeIds = getRunSnapshotIncludedNodeIds(input.canvas, input.targetNodeId);
  // 项目权限已经由项目存储边界校验；项目内资源按项目身份授权，兼容
  // 早期没有 ownerId 的项目资产。个人资源仍在 globalAssetScope 中按用户隔离。
  const projectAssetScope: AssetScope = { projectId: input.projectId };
  const globalAssetScope: AssetScope = {
    projectId: null,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  };
  const assetCache = new Map<string, Promise<{ ref: FrozenRunAssetRef; mediaType: MediaType }>>();
  const loadAsset = (assetId: string) => {
    const cached = assetCache.get(assetId);
    if (cached) return cached;
    const pending = (async () => {
      const projectAsset = await input.assetStore.get(assetId, projectAssetScope);
      const scope = projectAsset ? projectAssetScope : globalAssetScope;
      const asset = projectAsset ?? (await input.assetStore.get(assetId, globalAssetScope));
      if (!asset) {
        throw new RunAssetFreezeError(
          'asset_unavailable',
          `资产 ${assetId} 不存在或无权用于项目 ${input.projectId}`,
        );
      }
      const versions = await input.assetStore.listVersions(assetId, scope);
      const latest = versions.reduce(
        (current, candidate) =>
          !current || candidate.version > current.version ? candidate : current,
        undefined as (typeof versions)[number] | undefined,
      );
      if (!latest) {
        throw new RunAssetFreezeError(
          'asset_version_unavailable',
          `资产 ${assetId} 没有可冻结的版本`,
        );
      }
      return {
        ref: {
          assetId,
          version: latest.version,
          contentUrl: `/v1/assets/${encodeURIComponent(assetId)}/versions/${latest.version}/content`,
        },
        mediaType: asset.mediaType,
      };
    })();
    assetCache.set(assetId, pending);
    return pending;
  };

  const frozenAssetRefs: Record<string, FrozenRunAssetRef> = {};
  for (const node of input.canvas.nodes) {
    const assetId = node.data.assetId;
    if (!includedNodeIds.has(node.id) || node.data.enabled === false || !assetId) continue;
    const resolved = await loadAsset(assetId);
    if (resolved.mediaType !== node.data.mediaType) {
      throw new RunAssetFreezeError(
        'asset_unavailable',
        `资产 ${assetId} 的媒体类型与节点 ${node.id} 不匹配`,
      );
    }
    frozenAssetRefs[node.id] = resolved.ref;
  }
  return frozenAssetRefs;
}

const DEFAULT_RESOURCE_MENTION_MAX_BYTES = 50 * 1024 * 1024;

type PromptMentionResolutionInput = {
  assetStore: AssetStore;
  canvas: CanvasDocument;
  targetNodeId?: string;
  projectId: string;
  ownerId?: string;
  requestId: string;
};

/**
 * 校验并冻结节点提示词中的资源提及。这里同时承担保存前校验和运行
 * 前冻结，避免快照在排队期间跟随资源的最新版本漂移。
 */
async function resolvePromptMentionRefs(
  input: PromptMentionResolutionInput,
): Promise<FrozenPromptMention[]> {
  const includedNodeIds = input.targetNodeId
    ? getRunSnapshotIncludedNodeIds(input.canvas, input.targetNodeId)
    : undefined;
  // 项目资源由已校验的项目权限授权，不再额外要求资产 ownerId；否则
  // 匿名创建的项目资产或未来共享项目资产会在搜索后又被运行边界拒绝。
  const projectScope: AssetScope = { projectId: input.projectId };
  const globalScope: AssetScope = {
    projectId: null,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  };
  const maxBytes = parseByteLimit(
    process.env.RESOURCE_MENTION_MAX_BYTES,
    DEFAULT_RESOURCE_MENTION_MAX_BYTES,
  );
  const assetCache = new Map<
    string,
    Promise<{
      asset: Awaited<ReturnType<AssetStore['get']>>;
      scope: AssetScope;
      accessible: boolean;
    }>
  >();

  const loadAsset = (assetId: string) => {
    const cached = assetCache.get(assetId);
    if (cached) return cached;
    const pending = (async () => {
      const projectAsset = await input.assetStore.get(assetId, projectScope);
      if (projectAsset) return { asset: projectAsset, scope: projectScope, accessible: true };
      const globalAsset = await input.assetStore.get(assetId, globalScope);
      if (globalAsset) return { asset: globalAsset, scope: globalScope, accessible: true };
      // A second, unscoped lookup only distinguishes not-found from forbidden;
      // no unscoped value is returned to the client.
      const existing = await input.assetStore.get(assetId);
      return { asset: existing, scope: projectScope, accessible: false };
    })();
    assetCache.set(assetId, pending);
    return pending;
  };

  const frozen: FrozenPromptMention[] = [];
  const diagnostics: ResourceMentionDiagnostic[] = [];
  for (const node of input.canvas.nodes) {
    if (includedNodeIds && !includedNodeIds.has(node.id)) continue;
    // 来源节点的说明文本中的 @ 仅是元数据，不参与 Provider 请求或资源冻结。
    if (node.data.mode === 'source') continue;
    const document = node.data.promptDocument;
    if (!document) continue;
    const parsedDocument = promptDocumentSchema.parse(document);
    for (const [blockOrder, block] of parsedDocument.blocks.entries()) {
      if (block.type !== 'mention') continue;
      const base = {
        requestId: input.requestId,
        nodeId: node.id,
        mentionId: block.mentionId,
        assetId: block.assetId,
        mediaType: block.mediaType,
      } as const;
      // Imported placeholders retain their original identity but must never
      // trigger an asset lookup or reach a provider executor. Treat a reason
      // without the legacy boolean as a placeholder as well so malformed
      // forward-compatible documents fail closed at this boundary.
      if (block.placeholder || block.placeholderReason) {
        diagnostics.push({
          ...base,
          reason: 'placeholder',
          code: 'RESOURCE_MENTION_PLACEHOLDER',
          message: `资源提及 ${block.mentionId} 是不可执行占位，请重新绑定资产`,
        });
        continue;
      }
      const loaded = await loadAsset(block.assetId);
      if (!loaded.accessible || !loaded.asset) {
        diagnostics.push({
          ...base,
          reason: loaded.asset ? 'forbidden' : 'not_found',
          code: `RESOURCE_MENTION_${(loaded.asset ? 'forbidden' : 'not_found').toUpperCase()}` as ResourceMentionDiagnostic['code'],
          message: loaded.asset
            ? `资源提及 ${block.mentionId} 无权访问资产 ${block.assetId}`
            : `资源提及 ${block.mentionId} 的资产 ${block.assetId} 不存在`,
        });
        continue;
      }
      const asset = loaded.asset;
      if (asset.status === 'archived') {
        diagnostics.push({
          ...base,
          reason: 'archived',
          code: 'RESOURCE_MENTION_ARCHIVED',
          message: `资源提及 ${block.mentionId} 引用的资产 ${block.assetId} 已归档`,
        });
        continue;
      }
      if (
        asset.mediaType !== block.mediaType ||
        !isMentionMimeCompatible(asset.mimeType, block.mediaType)
      ) {
        diagnostics.push({
          ...base,
          reason: 'mime_mismatch',
          code: 'RESOURCE_MENTION_MIME_MISMATCH',
          message: `资源提及 ${block.mentionId} 的媒体类型与资产 ${block.assetId} 不匹配`,
        });
        continue;
      }
      const versions = await input.assetStore.listVersions(block.assetId, loaded.scope);
      const selectedVersion = block.assetVersion
        ? versions.find((candidate) => candidate.version === block.assetVersion)
        : versions.reduce(
            (latest, candidate) =>
              !latest || candidate.version > latest.version ? candidate : latest,
            undefined as (typeof versions)[number] | undefined,
          );
      if (!selectedVersion) {
        diagnostics.push({
          ...base,
          reason: 'version_missing',
          code: 'RESOURCE_MENTION_VERSION_MISSING',
          message: block.assetVersion
            ? `资源提及 ${block.mentionId} 指定的资产 ${block.assetId} 版本不存在`
            : `资源提及 ${block.mentionId} 的资产 ${block.assetId} 没有可冻结版本`,
        });
        continue;
      }
      if (selectedVersion.sizeBytes <= 0 || selectedVersion.sizeBytes > maxBytes) {
        diagnostics.push({
          ...base,
          reason: 'size_exceeded',
          code: 'RESOURCE_MENTION_SIZE_EXCEEDED',
          message: `资源提及 ${block.mentionId} 的资产 ${block.assetId} 超出 ${maxBytes} 字节限制`,
        });
        continue;
      }
      frozen.push({
        nodeId: node.id,
        mentionId: block.mentionId,
        assetId: block.assetId,
        assetVersion: selectedVersion.version,
        mediaType: block.mediaType,
        label: block.label,
        blockOrder,
        ...((block.semanticRole ?? block.binding?.semanticRole)
          ? { semanticRole: block.semanticRole ?? block.binding?.semanticRole }
          : {}),
        ...((block.entityName ?? block.binding?.entityName)
          ? { entityName: block.entityName ?? block.binding?.entityName }
          : {}),
        ...((block.scope ?? block.binding?.scope)
          ? { scope: block.scope ?? block.binding?.scope }
          : {}),
        ...(block.binding ? { binding: block.binding } : {}),
      });
    }
  }
  if (diagnostics.length > 0) throw new ResourceMentionFreezeError(diagnostics);
  return frozen;
}

function isMentionMimeCompatible(mimeType: string, mediaType: MediaType): boolean {
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0];
  if (mediaType === 'text') {
    return (
      normalized.startsWith('text/') || /^(application\/json|application\/xml)$/.test(normalized)
    );
  }
  return normalized.startsWith(`${mediaType}/`);
}

/**
 * 对运行快照中每个可执行节点做资源提及能力预检。源节点的提示词只是
 * 元数据，不会单独调用 Provider，因此不参与付费能力判断。
 */
function validateRunPromptMentionCapabilities(input: {
  canvas: CanvasDocument;
  targetNodeId: string;
  frozenPromptMentions: readonly FrozenPromptMention[];
  nodeModelAliases: Readonly<Record<string, string>>;
  nodeModels: Readonly<Record<string, ModelCatalogEntry | undefined>>;
  requestId: string;
  allowMockPreview: boolean;
}): ResourceMentionCapabilityDiagnostic[] {
  if (input.frozenPromptMentions.length === 0) return [];
  const included = getRunSnapshotIncludedNodeIds(input.canvas, input.targetNodeId);
  const byNode = new Map<string, FrozenPromptMention[]>();
  for (const mention of input.frozenPromptMentions) {
    const nodeId = mention.nodeId ?? input.targetNodeId;
    const list = byNode.get(nodeId) ?? [];
    list.push(mention);
    byNode.set(nodeId, list);
  }
  const diagnostics: ResourceMentionCapabilityDiagnostic[] = [];
  for (const [nodeId, mentions] of byNode) {
    if (!included.has(nodeId)) continue;
    const node = input.canvas.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.data.mode === 'source') continue;
    const result = checkResourceMentionCapabilities({
      node: { id: node.id, data: { mediaType: node.data.mediaType, mode: node.data.mode } },
      modelAlias: input.nodeModelAliases[nodeId] ?? node.data.modelAlias ?? 'unknown-model',
      model: input.nodeModels[nodeId],
      mentions: [...mentions].sort((left, right) => left.blockOrder - right.blockOrder),
      requestId: input.requestId,
      allowMockPreview: input.allowMockPreview,
    });
    diagnostics.push(...result.issues);
  }
  return diagnostics;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const bodyLimitBytes = parseByteLimit(process.env.API_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES);
  const defaultLogger = {
    level: process.env.LOG_LEVEL ?? 'info',
    serializers: { req: serializeRequestForLog },
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'apiKey',
        'api_key',
        'body.apiKey',
        'body.api_key',
      ],
      censor: '[REDACTED]',
    },
  };
  const logger =
    options.logger === true || options.logger === undefined
      ? defaultLogger
      : typeof options.logger === 'object' && options.logger !== null
        ? {
            ...defaultLogger,
            ...options.logger,
            serializers: {
              ...defaultLogger.serializers,
              ...options.logger.serializers,
              req: serializeRequestForLog,
            },
          }
        : options.logger;
  const app = Fastify({
    bodyLimit: bodyLimitBytes,
    logger,
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RateLimitUnavailableError) {
      request.log.warn({ requestId: request.id }, 'global rate limiter unavailable');
      return reply.header('retry-after', String(error.retryAfterSeconds)).code(503).send({
        error: 'rate limit service unavailable',
        code: 'rate_limit_unavailable',
        retryAfterSeconds: error.retryAfterSeconds,
        requestId: request.id,
      });
    }
    const code = isErrorCode(error) ? error.code : undefined;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: 'request body exceeds configured limit',
        code: 'request_body_too_large',
        requestId: request.id,
        maxBytes: bodyLimitBytes,
      });
    }
    if (code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
      return reply.code(400).send({
        error: 'invalid content length',
        code: 'invalid_content_length',
        requestId: request.id,
      });
    }
    const statusCode = errorStatusCode(error);
    request.log.error(
      { err: sanitizeExceptionForObservability(error), requestId: request.id },
      'unhandled request error',
    );
    return reply.code(statusCode).send({
      error: 'internal server error',
      code: 'internal_error',
      requestId: request.id,
    });
  });
  const observability =
    options.observability ??
    createEnvironmentObservability({ logger: app.log, service: 'multimodal-canvas-api' });
  const requestSpans = new WeakMap<object, ObservabilitySpan>();
  const assetStore: AssetStore = options.assetStore ?? new MemoryAssetStore();
  const projectStore = options.projectStore ?? new MemoryProjectStore();
  const providerName = process.env.WORKER_PROVIDER === 'newapi' ? 'newapi' : 'mock';
  const runService =
    options.runService ??
    new MemoryRunService({
      providerName,
      ...(options.runExecutor ? { executor: options.runExecutor } : {}),
      resultArchiver: options.runResultArchiver ?? createAssetResultArchiver(assetStore),
    });
  // Callers sometimes provide a pre-built MemoryRunService so they can tune
  // timing/provider state. Still honor an explicitly injected executor.
  if (options.runService instanceof MemoryRunService && options.runExecutor) {
    options.runService.setExecutor(options.runExecutor);
  }
  if (runService instanceof MemoryRunService) {
    if (options.runResultArchiver || !runService.hasResultArchiver()) {
      runService.setResultArchiver(
        options.runResultArchiver ?? createAssetResultArchiver(assetStore),
      );
    }
  }
  const userExists = options.userExists;
  const settingsStore: AiSettingsStoreLike = options.settingsStore ?? new AiSettingsStore();
  const webhookEventStore: WebhookEventStore =
    options.webhookEventStore ?? new MemoryWebhookEventStore();
  const mediaMetadataExtractor = options.mediaMetadataExtractor ?? new NoopMediaMetadataExtractor();
  const mediaDerivativeGenerator =
    options.mediaDerivativeGenerator ?? new NoopMediaDerivativeGenerator();
  const eventStreamCleanups = new Set<() => void>();
  const uploadSessionStore = options.uploadSessionStore ?? new MemoryUploadSessionStore();
  const authToken = process.env.API_AUTH_TOKEN?.trim();
  const jwtSecret = process.env.API_JWT_SECRET?.trim();
  // A deployment may provide a dedicated key. Falling back to an existing
  // server-side auth secret keeps local development usable without exposing
  // credentials; the final fallback is process-local and non-persistent.
  const assetAccessSecret =
    process.env.ASSET_ACCESS_URL_SECRET?.trim() || jwtSecret || authToken || randomUUID();
  const authStore = options.authStore ?? new MemoryAuthStore();
  const authService =
    options.authService ??
    (jwtSecret ? new AuthService({ store: authStore, jwtSecret }) : undefined);
  const requireJwtExpiration = process.env.NODE_ENV === 'production';
  const requestPrincipals = new WeakMap<object, AuthPrincipal>();
  const requestSessions = new WeakMap<object, AuthenticatedSession>();
  const maxActiveRunsPerProject = parsePositiveInt(process.env.RUN_MAX_ACTIVE_PER_PROJECT);
  const rateLimitPerMinute = parsePositiveInt(process.env.API_RATE_LIMIT_PER_MINUTE);
  const authRateLimitPerMinute = parsePositiveInt(process.env.API_AUTH_RATE_LIMIT_PER_MINUTE) ?? 10;
  const sseRateLimitPerMinute = parsePositiveInt(process.env.API_SSE_RATE_LIMIT_PER_MINUTE) ?? 30;
  const rateLimitWindowMs = 60_000;
  const rateLimiter: RateLimiter = options.rateLimiter ?? new MemoryRateLimiter();
  const sseMaxBytes = parseByteLimit(process.env.API_SSE_MAX_BYTES, DEFAULT_SSE_MAX_BYTES);
  const sseMaxEventBytes = Math.min(
    parseByteLimit(process.env.API_SSE_MAX_EVENT_BYTES, DEFAULT_SSE_MAX_EVENT_BYTES),
    sseMaxBytes,
  );
  const corsOrigins = resolveCorsOrigins(
    process.env.CORS_ORIGIN,
    process.env.NODE_ENV,
    process.env.WEB_PORT,
  );

  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Browser downloads need to read the server-provided attachment name.
    // These are metadata headers only; credentials remain in the body/auth
    // boundary and are never exposed here.
    exposedHeaders: ['content-disposition', 'content-length'],
  });
  app.register(multipart, {
    limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
  });
  app.addHook('onRequest', async (request) => {
    requestSpans.set(
      request,
      observability.startSpan('http.request', {
        'http.method': request.method,
        'http.target': request.url.split('?')[0],
        'service.name': process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas-api',
      }),
    );
  });
  app.addHook('onError', async (request, reply, error) => {
    const span = requestSpans.get(request);
    if (!span) return;
    const telemetryError = sanitizeExceptionForObservability(error);
    span.setAttribute('http.status_code', reply.statusCode || 500);
    span.recordException(telemetryError);
    observability.captureException(telemetryError, {
      component: 'api',
      'http.method': request.method,
      'http.status_code': reply.statusCode || 500,
    });
    span.end('error');
  });
  app.addHook('onResponse', async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.status_code', reply.statusCode);
    const route = request.routeOptions?.url;
    if (route) span.setAttribute('http.route', route);
    span.end(reply.statusCode >= 500 ? 'error' : 'ok');
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.addHook('onRequest', async (request, reply) => {
    // CORS preflight never carries application credentials. The CORS plugin
    // has already validated the origin and will answer the wildcard OPTIONS
    // route, so do not make preflight depend on API authentication.
    if (request.method === 'OPTIONS') return;
    const pathname = request.url.split('?')[0];
    if (pathname === '/health' || pathname === '/v1/webhooks/newapi') return;
    const authRoute =
      pathname === '/v1/auth/register' || pathname === '/v1/auth/login'
        ? pathname.slice('/v1/auth/'.length)
        : undefined;
    if (authRoute) {
      const decision = await rateLimiter.consume(`auth:${authRoute}:${request.ip ?? 'unknown'}`, {
        limit: authRateLimitPerMinute,
        windowMs: rateLimitWindowMs,
      });
      setRateLimitHeaders(reply, decision);
      if (!decision.allowed) {
        return reply.header('retry-after', String(decision.retryAfterSeconds)).code(429).send({
          error: 'rate limit exceeded',
          code: 'auth_rate_limit_exceeded',
          retryAfterSeconds: decision.retryAfterSeconds,
          requestId: request.id,
        });
      }
      return;
    }
    if (request.method === 'GET') {
      const signedResource = assetContentResource(pathname);
      if (signedResource) {
        const token = new URL(request.url, 'http://localhost').searchParams.get('access_token');
        const verified = verifyAssetAccessToken(
          token ?? undefined,
          assetAccessSecret,
          signedResource,
        );
        if (verified) {
          requestPrincipals.set(request, {
            method: 'anonymous',
            ...(verified.ownerId ? { userId: verified.ownerId } : {}),
          });
          return;
        }
        // Do not silently fall back to development anonymous access when a
        // caller presents a malformed, expired, or resource-mismatched token.
        if (token !== null) return reply.code(401).send({ error: 'invalid or expired access URL' });
      }
    }
    if (!authToken && !jwtSecret) {
      if (process.env.NODE_ENV === 'production') {
        return reply
          .code(503)
          .send({ error: 'API_AUTH_TOKEN or API_JWT_SECRET is required in production' });
      }
      requestPrincipals.set(request, { method: 'anonymous' });
      return;
    }
    const result = authenticateBearer(request.headers.authorization, {
      apiToken: authToken,
      jwtSecret,
      requireExpiration: requireJwtExpiration,
    });
    if (!result.ok) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    if (result.principal.method === 'jwt' && result.principal.sessionId && authService) {
      const accessToken = extractBearerToken(request.headers.authorization);
      if (!accessToken) return reply.code(401).send({ error: 'authentication required' });
      try {
        const session = await authService.verifyAccessToken(accessToken);
        requestSessions.set(request, session);
        result.principal.role = session.user.role;
      } catch (error) {
        if (error instanceof AuthServiceError) {
          return reply.code(401).send({ error: 'authentication required' });
        }
        request.log.error(
          { err: sanitizeExceptionForObservability(error) },
          'authentication session lookup failed',
        );
        return reply.code(503).send({ error: 'authentication service unavailable' });
      }
    } else if (result.principal.method === 'jwt' && result.principal.sessionId && !authService) {
      request.log.error('stateful JWT authentication requires an authentication service');
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    // The implicit in-memory store exists to make local auth route tests and
    // development convenient; it must not count as a production backing store
    // for legacy stateless JWTs. Production callers must inject a real store
    // (or the explicit userExists lookup) before those tokens are accepted.
    const effectiveUserExists =
      userExists ??
      (options.authStore
        ? async (userId: string) => Boolean(await options.authStore!.findUserById(userId))
        : undefined);
    if (
      result.principal.method === 'jwt' &&
      !result.principal.sessionId &&
      !effectiveUserExists &&
      process.env.NODE_ENV === 'production'
    ) {
      request.log.error('JWT authentication requires a production user store');
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    if (result.principal.userId && effectiveUserExists && !requestSessions.has(request)) {
      try {
        if (!(await effectiveUserExists(result.principal.userId))) {
          return reply.code(401).send({ error: 'authentication required' });
        }
      } catch (error) {
        request.log.error(
          { err: sanitizeExceptionForObservability(error) },
          'authentication user lookup failed',
        );
        return reply.code(503).send({ error: 'authentication service unavailable' });
      }
    }
    requestPrincipals.set(request, result.principal);
    if (!pathname.startsWith('/v1/')) return;

    const isSse = /^\/v1\/projects\/[^/]+\/events$/.test(pathname);
    const limit = isSse ? sseRateLimitPerMinute : rateLimitPerMinute;
    if (limit === undefined) return;
    const key = result.principal.userId ?? request.ip ?? 'unknown';
    const decision = await rateLimiter.consume(`${isSse ? 'sse' : 'api'}:${key}`, {
      limit,
      windowMs: rateLimitWindowMs,
    });
    setRateLimitHeaders(reply, decision);
    if (!decision.allowed) {
      return reply
        .header('retry-after', String(decision.retryAfterSeconds))
        .code(429)
        .send({
          error: 'rate limit exceeded',
          code: isSse ? 'sse_rate_limit_exceeded' : 'rate_limit_exceeded',
          retryAfterSeconds: decision.retryAfterSeconds,
          requestId: request.id,
        });
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
  }));

  app.get('/documentation', async () => openApiDocument);
  app.get('/documentation/json', async () => openApiDocument);

  app.post('/v1/auth/register', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const body = z
      .object({
        email: z.string(),
        password: z.string(),
        displayName: z.string().trim().max(120).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid authentication input' });
    try {
      return reply.code(201).send(await authService.register(body.data));
    } catch (error) {
      return sendAuthServiceError(reply, error);
    }
  });

  app.post('/v1/auth/login', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const body = z
      .object({ email: z.string(), password: z.string() })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid authentication input' });
    try {
      return reply.send(await authService.login(body.data));
    } catch (error) {
      return sendAuthServiceError(reply, error);
    }
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const session = requestSessions.get(request);
    if (!session) return reply.code(401).send({ error: 'authentication required' });
    return { user: session.user };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const session = requestSessions.get(request);
    const principal = requestPrincipals.get(request);
    const accessToken = extractBearerToken(request.headers.authorization);
    if (!session || principal?.method !== 'jwt' || !accessToken) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    await authService.logout(accessToken);
    return { loggedOut: true };
  });

  app.post('/v1/auth/logout-all', async (request, reply) => {
    if (!authService) {
      return reply.code(503).send({ error: 'authentication service unavailable' });
    }
    const session = requestSessions.get(request);
    if (!session) return reply.code(401).send({ error: 'authentication required' });
    const revokedSessions = await authService.logoutAll(session.user.id);
    return { revokedSessions };
  });

  app.post('/v1/webhooks/newapi', async (request, reply) => {
    const secret = process.env.NEW_API_WEBHOOK_SECRET?.trim();
    if (!secret && process.env.NODE_ENV === 'production') {
      return reply.code(503).send({ error: 'webhook secret is not configured' });
    }
    if (secret) {
      const signature = request.headers['x-newapi-signature'];
      if (
        typeof signature !== 'string' ||
        !verifyWebhookSignature(request.body, signature, secret)
      ) {
        return reply.code(401).send({ error: 'invalid webhook signature' });
      }
    }
    const eventIdHeader = request.headers['x-newapi-event-id'];
    const body = isRecord(request.body) ? request.body : {};
    const eventId =
      (typeof eventIdHeader === 'string' && eventIdHeader.trim()) ||
      (typeof body.eventId === 'string' && body.eventId.trim()) ||
      (typeof body.id === 'string' && body.id.trim());
    if (!eventId) return reply.code(400).send({ error: 'webhook event id is required' });
    const claim = await webhookEventStore.claim(eventId, 'newapi', body);
    if (claim.deduplicated) {
      return reply.code(202).send({ accepted: true, ...claim, eventId });
    }

    const leaseToken = claim.leaseToken;
    if (!leaseToken) {
      return reply.code(503).send({ error: 'webhook processing lease was not granted' });
    }

    try {
      const webhookUpdate = parseNewApiWebhook(body);
      if (!webhookUpdate) {
        await webhookEventStore.markFailed(
          eventId,
          leaseToken,
          new Error('webhook platform job id is required'),
        );
        return reply.code(400).send({
          error: 'webhook platform job id is required',
          code: 'invalid_webhook',
          eventId,
        });
      }
      const updatedRun = await runService.applyProviderWebhook?.(webhookUpdate);
      if (updatedRun?.providerJob && options.runPersistence) {
        const persistedRunId = databaseRunId(updatedRun.id);
        await options.runPersistence.upsertProviderJob({
          runId: persistedRunId,
          providerJob: updatedRun.providerJob,
        });
        await options.runPersistence.updateRun({
          runId: updatedRun.id,
          status: updatedRun.status,
          ...(updatedRun.error ? { error: updatedRun.error } : {}),
        });
      }
      const processed = await webhookEventStore.markProcessed(eventId, leaseToken);
      return reply.code(202).send({
        accepted: true,
        deduplicated: false,
        processed: processed.applied,
        status: processed.status,
        attempt: processed.attempt,
        eventId,
        ...(updatedRun ? { updatedRunId: updatedRun.id } : {}),
      });
    } catch (error) {
      await webhookEventStore.markFailed(eventId, leaseToken, error);
      throw error;
    }
  });

  app.get('/v1/settings/ai', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { settings: await settingsStore.get() };
  });

  app.patch('/v1/settings/ai', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    const result = z
      .object({
        baseUrl: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
          }, 'baseUrl must use HTTPS outside local development')
          .optional(),
        apiKey: z.string().min(1).optional(),
        defaultModels: z
          .object({
            text: z
              .union([
                z.string().min(1),
                z
                  .object({
                    modelAlias: z.string().min(1),
                    credentialId: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .nullable()
              .optional(),
            image: z
              .union([
                z.string().min(1),
                z
                  .object({
                    modelAlias: z.string().min(1),
                    credentialId: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .nullable()
              .optional(),
            audio: z
              .union([
                z.string().min(1),
                z
                  .object({
                    modelAlias: z.string().min(1),
                    credentialId: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .nullable()
              .optional(),
            video: z
              .union([
                z.string().min(1),
                z
                  .object({
                    modelAlias: z.string().min(1),
                    credentialId: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .nullable()
              .optional(),
          })
          .optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid AI settings' });
    try {
      const defaults = result.data.defaultModels as UpdateProjectModelDefaultsInput | undefined;
      const hasUnboundDefault = defaults
        ? Object.values(defaults).some(
            (selection) =>
              selection !== null &&
              selection !== undefined &&
              (typeof selection === 'string' || !selection.credentialId),
          )
        : false;
      if (
        defaults &&
        hasUnboundDefault &&
        (result.data.baseUrl !== undefined || result.data.apiKey !== undefined)
      ) {
        throw new AiSettingsError(
          'model_unavailable',
          '更换 API Key 后请先刷新模型目录，再保存未绑定凭据的默认模型',
        );
      }
      if (defaults) {
        await validateProjectModelDefaults({
          settingsStore,
          defaults,
          allowVirtualMockModels: providerName === 'mock' && process.env.NODE_ENV !== 'production',
          requireCredentialReferences: providerName === 'newapi',
          unboundCredentialScope: 'active',
        });
      }
      const settings = await settingsStore.update(result.data);
      return { settings, credentials: await settingsStore.listCredentials() };
    } catch (error) {
      if (error instanceof AiCredentialNotFoundError) {
        return reply.code(404).send({ error: 'credential not found', code: error.code });
      }
      if (error instanceof AiSettingsError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get('/v1/settings/ai/credentials', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { credentials: await settingsStore.listCredentials() };
  });

  app.post<{ Params: { credentialId: string } }>(
    '/v1/settings/ai/credentials/:credentialId/activate',
    async (request, reply) => {
      if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
        return reply.code(403).send({ error: 'platform credential access is not permitted' });
      }
      const credentialId = z.string().uuid().safeParse(request.params.credentialId);
      if (!credentialId.success) return reply.code(400).send({ error: 'invalid credential id' });
      const settings = await settingsStore.activateCredential(credentialId.data);
      if (!settings) return reply.code(404).send({ error: 'credential not found' });
      return { settings, credentials: await settingsStore.listCredentials() };
    },
  );

  app.delete('/v1/settings/ai/credentials', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    const settings = await settingsStore.removeCredentials();
    return { settings, credentials: await settingsStore.listCredentials() };
  });

  app.post('/v1/settings/ai/test', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    return { result: await settingsStore.testConnection() };
  });

  app.post('/v1/settings/ai/models/refresh', async (request, reply) => {
    if (!canManagePlatformSettings(requestPrincipals, requestSessions, request)) {
      return reply.code(403).send({ error: 'platform credential access is not permitted' });
    }
    const body = z
      .object({ credentialId: z.string().uuid().optional() })
      .strict()
      .optional()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid model refresh request' });
    try {
      return { models: await settingsStore.refreshModels(body.data?.credentialId) };
    } catch (error) {
      if (error instanceof AiCredentialNotFoundError) {
        return reply.code(404).send({ error: 'credential not found', code: error.code });
      }
      request.log.warn(
        { err: sanitizeExceptionForObservability(error), requestId: request.id },
        'model catalog refresh failed',
      );
      return reply
        .code(502)
        .send({ error: 'model catalog refresh failed', code: 'upstream_error' });
    }
  });

  app.get<{ Querystring: { credentialId?: string; mediaType?: string } }>(
    '/v1/models',
    async (request, reply) => {
      const query = z
        .object({
          credentialId: z.string().uuid().optional(),
          mediaType: z.enum(['text', 'image', 'audio', 'video']).optional(),
        })
        .safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid model query' });
      if (
        query.data.credentialId &&
        !canManagePlatformSettings(requestPrincipals, requestSessions, request)
      ) {
        return reply.code(403).send({ error: 'platform credential access is not permitted' });
      }
      if (
        query.data.credentialId &&
        !(await settingsStore.hasCredential(query.data.credentialId))
      ) {
        return reply.code(404).send({ error: 'credential not found' });
      }
      try {
        return {
          models: await settingsStore.listModels(query.data.mediaType, query.data.credentialId),
        };
      } catch (error) {
        if (error instanceof AiCredentialNotFoundError) {
          return reply.code(404).send({ error: 'credential not found', code: error.code });
        }
        throw error;
      }
    },
  );

  app.post('/v1/projects', async (request, reply) => {
    const result = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ error: 'project name is required' });
    }

    const project = await projectStore.create(
      result.data,
      projectScope(requestPrincipals, request),
    );
    return reply.code(201).send({ project });
  });

  app.get<{ Querystring: { includeArchived?: string } }>('/v1/projects', async (request) => ({
    projects: await projectStore.list(projectScope(requestPrincipals, request), {
      includeArchived: request.query.includeArchived === 'true',
    }),
  }));

  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
    const project = await projectStore.get(
      request.params.projectId,
      projectScope(requestPrincipals, request),
    );
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { project };
  });

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId',
    async (request, reply) => {
      const result = z
        .object({ name: z.string().trim().min(1).max(120) })
        .strict()
        .safeParse(request.body);
      if (!result.success) return reply.code(400).send({ error: 'project name is required' });
      const project = await projectStore.update(
        request.params.projectId,
        result.data,
        projectScope(requestPrincipals, request),
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return { project };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/archive',
    async (request, reply) => {
      const project = await projectStore.setArchived(
        request.params.projectId,
        true,
        projectScope(requestPrincipals, request),
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return { project };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/restore',
    async (request, reply) => {
      const project = await projectStore.setArchived(
        request.params.projectId,
        false,
        projectScope(requestPrincipals, request),
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
      return { project };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const canvas = await projectStore.getCanvas(
        request.params.projectId,
        projectScope(requestPrincipals, request),
      );
      if (!canvas) return reply.code(404).send({ error: 'project not found' });
      return { canvas };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/export/workflow',
    async (request, reply) => {
      const { projectId } = request.params;
      const scope = projectScope(requestPrincipals, request);
      const project = await projectStore.get(projectId, scope);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const canvas = await projectStore.getCanvas(projectId, scope);
      if (!canvas) return reply.code(404).send({ error: 'project canvas not found' });
      const runs = (await runService.listByProject(projectId)).filter(
        (run) => run.projectId === projectId,
      );
      const modelDefaults = await projectStore.getModelDefaults(projectId, scope);
      const workflow = createWorkflowExport({
        project,
        canvas,
        runs,
        ...(modelDefaults ? { modelDefaults } : {}),
      });
      const body = JSON.stringify(workflow, null, 2);
      return reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', attachmentDisposition(`${project.name}.workflow.json`))
        .header('cache-control', 'no-store')
        .header('content-length', String(Buffer.byteLength(body)))
        .send(body);
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/import/workflow',
    async (request, reply) => {
      const scope = projectScope(requestPrincipals, request);
      const project = await projectStore.get(request.params.projectId, scope);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const currentCanvas = await projectStore.getCanvas(request.params.projectId, scope);
      if (!currentCanvas) return reply.code(404).send({ error: 'project canvas not found' });

      const body = request.body;
      const bodyRecord = isRecord(body) ? body : undefined;
      const workflowInput =
        bodyRecord && isRecord(bodyRecord.workflow) ? bodyRecord.workflow : body;
      const expectedRevision = bodyRecord?.expectedRevision;
      if (expectedRevision !== undefined) {
        if (
          typeof expectedRevision !== 'number' ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 0
        ) {
          return reply.code(400).send({
            error: 'invalid workflow import revision',
            code: 'invalid_schema',
            requestId: request.id,
          });
        }
        if (expectedRevision !== currentCanvas.revision) {
          return reply.code(409).send({
            error: 'canvas revision is stale',
            code: 'revision_conflict',
            revision: currentCanvas.revision,
            requestId: request.id,
          });
        }
      }

      try {
        const imported = await importWorkflowExport(workflowInput, {
          assetStore,
          assetScope: assetScope(requestPrincipals, request),
          projectId: request.params.projectId,
        });
        let modelDefaults = await projectStore.getModelDefaults(request.params.projectId, scope);
        if (imported.modelDefaults) {
          await validateProjectModelDefaults({
            settingsStore,
            defaults: imported.modelDefaults as UpdateProjectModelDefaultsInput,
            allowVirtualMockModels:
              providerName === 'mock' && process.env.NODE_ENV !== 'production',
            requireCredentialReferences: providerName === 'newapi',
          });
        }

        // 导出文件中的 revision 只是源项目元数据；写入目标项目前必须
        // 以目标当前 revision 为乐观锁基线。
        const rebasedCanvas: CanvasDocument = {
          ...imported.canvas,
          revision: currentCanvas.revision,
        };
        const canvas = await projectStore.updateCanvas(
          request.params.projectId,
          rebasedCanvas,
          scope,
        );
        if (imported.modelDefaults) {
          modelDefaults = await projectStore.updateModelDefaults(
            request.params.projectId,
            imported.modelDefaults as UpdateProjectModelDefaultsInput,
            scope,
          );
        }
        return {
          workflow: imported.workflow,
          canvas,
          ...(modelDefaults ? { modelDefaults } : {}),
          issues: imported.issues,
        };
      } catch (error) {
        if (error instanceof WorkflowImportError) {
          return reply.code(400).send({
            error: error.message,
            code: error.code,
            requestId: request.id,
            ...(error.issues.length > 0 ? { issues: error.issues } : {}),
          });
        }
        if (error instanceof ProjectStoreError && error.code === 'revision_conflict') {
          return reply.code(409).send({
            error: error.message,
            code: 'revision_conflict',
            revision: error.revision,
            requestId: request.id,
          });
        }
        if (error instanceof ProjectStoreError && error.code === 'not_found') {
          return reply.code(404).send({ error: error.message, requestId: request.id });
        }
        if (error instanceof ProjectStoreError && error.code === 'invalid_asset') {
          return reply
            .code(400)
            .send({ error: error.message, code: error.code, requestId: request.id });
        }
        if (error instanceof AiCredentialNotFoundError) {
          return reply.code(404).send({ error: 'credential not found', code: error.code });
        }
        if (error instanceof AiSettingsError) {
          return reply
            .code(400)
            .send({ error: error.message, code: error.code, requestId: request.id });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/export/results',
    async (request, reply) => {
      const { projectId } = request.params;
      const scope = projectScope(requestPrincipals, request);
      const project = await projectStore.get(projectId, scope);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const canvas = await projectStore.getCanvas(projectId, scope);
      if (!canvas) return reply.code(404).send({ error: 'project canvas not found' });

      try {
        const runs = (await runService.listByProject(projectId)).filter(
          (run) => run.projectId === projectId,
        );
        const modelDefaults = await projectStore.getModelDefaults(projectId, scope);
        const prepared = await prepareResultsExport({
          project,
          canvas,
          runs,
          ...(modelDefaults ? { modelDefaults } : {}),
          assetStore,
          assetScope: assetScope(requestPrincipals, request),
        });
        const exportLimits = resolveExportLimits();
        // The business limit applies to result bytes. Metadata entries are
        // small but still need room in the ZIP helper's uncompressed budget.
        const metadataBytes = prepared.entries
          .filter((entry) => entry.path === 'workflow.json' || entry.path === 'manifest.json')
          .reduce(
            (total, entry) =>
              total +
              (typeof entry.content === 'string'
                ? Buffer.byteLength(entry.content)
                : entry.content.byteLength),
            0,
          );
        const archive = buildZipArchive(prepared.entries, {
          maxEntries: Math.min(Number.MAX_SAFE_INTEGER, exportLimits.maxFiles + 2),
          maxEntryBytes: exportLimits.maxBytes,
          maxTotalBytes: Math.min(Number.MAX_SAFE_INTEGER, exportLimits.maxBytes + metadataBytes),
        });
        return reply
          .type('application/zip')
          .header('content-disposition', attachmentDisposition(`${project.name}.results.zip`))
          .header('cache-control', 'no-store')
          .header('content-length', String(archive.byteLength))
          .send(archive);
      } catch (error) {
        if (error instanceof ExportError) {
          return reply.code(error.statusCode).send({ error: error.message, code: error.code });
        }
        if (
          error instanceof ArchiveError &&
          ['too_many_entries', 'entry_too_large', 'archive_too_large'].includes(error.code)
        ) {
          return reply.code(413).send({ error: error.message, code: 'export_limit_exceeded' });
        }
        request.log.error(
          { err: sanitizeExceptionForObservability(error), projectId },
          'failed to export project results',
        );
        return reply
          .code(500)
          .send({ error: 'failed to export project results', code: 'export_failed' });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/models/defaults',
    async (request, reply) => {
      const defaults = await projectStore.getModelDefaults(
        request.params.projectId,
        projectScope(requestPrincipals, request),
      );
      if (!defaults) return reply.code(404).send({ error: 'project not found' });
      return { defaults };
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/models/defaults',
    async (request, reply) => {
      const result = z
        .object({
          text: z
            .union([
              z.string().trim().min(1),
              z
                .object({
                  modelAlias: z.string().trim().min(1),
                  credentialId: z.string().trim().min(1).optional(),
                })
                .strict(),
            ])
            .nullable()
            .optional(),
          image: z
            .union([
              z.string().trim().min(1),
              z
                .object({
                  modelAlias: z.string().trim().min(1),
                  credentialId: z.string().trim().min(1).optional(),
                })
                .strict(),
            ])
            .nullable()
            .optional(),
          audio: z
            .union([
              z.string().trim().min(1),
              z
                .object({
                  modelAlias: z.string().trim().min(1),
                  credentialId: z.string().trim().min(1).optional(),
                })
                .strict(),
            ])
            .nullable()
            .optional(),
          video: z
            .union([
              z.string().trim().min(1),
              z
                .object({
                  modelAlias: z.string().trim().min(1),
                  credentialId: z.string().trim().min(1).optional(),
                })
                .strict(),
            ])
            .nullable()
            .optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!result.success) return reply.code(400).send({ error: 'invalid project model defaults' });

      const scope = projectScope(requestPrincipals, request);
      const project = await projectStore.get(request.params.projectId, scope);
      if (!project) return reply.code(404).send({ error: 'project not found' });

      try {
        await validateProjectModelDefaults({
          settingsStore,
          defaults: result.data as UpdateProjectModelDefaultsInput,
          allowVirtualMockModels: providerName === 'mock' && process.env.NODE_ENV !== 'production',
          requireCredentialReferences: providerName === 'newapi',
        });
        const defaults = await projectStore.updateModelDefaults(
          request.params.projectId,
          result.data as UpdateProjectModelDefaultsInput,
          scope,
        );
        return { defaults };
      } catch (error) {
        if (error instanceof ProjectStoreError && error.code === 'not_found') {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof AiCredentialNotFoundError) {
          return reply.code(404).send({ error: 'credential not found', code: error.code });
        }
        if (error instanceof AiSettingsError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/runs',
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await projectStore.get(projectId, projectScope(requestPrincipals, request));
      if (!project) return reply.code(404).send({ error: 'project not found' });

      return { runs: (await runService.listByProject(projectId)).map(toPublicRunRecord) };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/events',
    async (request, reply) => {
      const { projectId } = request.params;
      const project = await projectStore.get(projectId, projectScope(requestPrincipals, request));
      if (!project) return reply.code(404).send({ error: 'project not found' });

      // reply.hijack() bypasses Fastify's normal serializer, including the
      // point where reply headers are copied to the raw response. Preserve
      // CORS/rate-limit headers before taking ownership of the SSE stream.
      const responseHeaders = reply.getHeaders();
      reply.hijack();
      const response = reply.raw;
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) response.setHeader(name, value);
      }
      response.writeHead(200, {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      let publishing = false;
      let bytesWritten = 0;
      let responseLimitReached = false;
      const lastSeen = new Map<string, string>();
      const writeRaw = (chunk: string, options: { bypassLimit?: boolean } = {}) => {
        if (closed) return;
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (
          !options.bypassLimit &&
          (chunkBytes > sseMaxBytes || bytesWritten + chunkBytes > sseMaxBytes)
        ) {
          if (!responseLimitReached) {
            responseLimitReached = true;
            const diagnostic =
              'event: error\ndata: {"error":"SSE response exceeds configured limit","code":"sse_response_too_large"}\n\n';
            const diagnosticBytes = Buffer.byteLength(diagnostic, 'utf8');
            if (bytesWritten + diagnosticBytes <= sseMaxBytes) {
              try {
                response.write(diagnostic);
                bytesWritten += diagnosticBytes;
              } catch {
                // cleanup below still closes the stream after a broken client.
              }
            }
          }
          cleanup();
          return;
        }
        try {
          response.write(chunk);
          bytesWritten += chunkBytes;
        } catch {
          cleanup();
        }
      };
      const write = (event: string, data: unknown) => {
        const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        if (Buffer.byteLength(chunk, 'utf8') > sseMaxEventBytes) {
          writeRaw(
            'event: error\ndata: {"error":"SSE event exceeds configured limit","code":"sse_event_too_large"}\n\n',
          );
          return;
        }
        writeRaw(chunk);
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        eventStreamCleanups.delete(cleanup);
        request.raw.off('close', cleanup);
        request.raw.off('error', cleanup);
        if (!response.writableEnded) response.end();
      };

      eventStreamCleanups.add(cleanup);
      request.raw.once('close', cleanup);
      request.raw.once('error', cleanup);

      const publishChanges = async () => {
        if (closed || publishing) return;
        publishing = true;
        try {
          const runs = await runService.listByProject(projectId);
          for (const run of runs) {
            const publicRun = toPublicRunEvent(run);
            const serialized = JSON.stringify(publicRun);
            if (lastSeen.get(run.id) === serialized) continue;
            lastSeen.set(run.id, serialized);
            write('run.updated', publicRun);
          }
        } catch (error) {
          request.log.error(
            { err: sanitizeExceptionForObservability(error), requestId: request.id },
            'SSE run event read failed',
          );
          write('error', {
            error: 'internal server error',
            code: 'internal_error',
            requestId: request.id,
          });
        } finally {
          publishing = false;
        }
      };

      write('ready', { projectId, projectName: project.name });
      await publishChanges();
      // Polling is a compatibility fallback for the in-process run service;
      // avoid overlapping reads and keep the interval modest for projects
      // with many connected clients.
      pollTimer = setInterval(() => void publishChanges(), 500);
      keepAliveTimer = setInterval(() => {
        writeRaw(': keep-alive\n\n');
      }, 15_000);
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const result = canvasDocumentSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'invalid canvas', issues: result.error.issues });
      }

      try {
        const principal = requestPrincipals.get(request);
        await resolvePromptMentionRefs({
          assetStore,
          canvas: result.data,
          projectId: request.params.projectId,
          ...(principal?.userId ? { ownerId: principal.userId } : {}),
          requestId: request.id,
        });
        const canvas = await projectStore.updateCanvas(
          request.params.projectId,
          result.data,
          projectScope(requestPrincipals, request),
        );
        return { canvas };
      } catch (error) {
        if (error instanceof ProjectStoreError && error.code === 'revision_conflict') {
          return reply.code(409).send({ error: error.message, revision: error.revision });
        }
        if (error instanceof ProjectStoreError && error.code === 'not_found') {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ProjectStoreError && error.code === 'invalid_asset') {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof ResourceMentionFreezeError) {
          return reply.code(400).send({
            error: error.message,
            code: 'RESOURCE_MENTION_FREEZE_FAILED',
            requestId: request.id,
            issues: error.diagnostics,
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/runs', async (request, reply) => {
    const parsedBody = runRequestBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'projectId is required' });
    }
    const promptResult =
      parsedBody.data.promptDocument === undefined
        ? undefined
        : promptDocumentSchema.safeParse(parsedBody.data.promptDocument);
    if (promptResult && !promptResult.success) {
      return reply.code(400).send({
        error: 'invalid prompt document',
        issues: promptResult.error.issues,
      });
    }
    const body: RunRequestBody = {
      projectId: parsedBody.data.projectId,
      ...(parsedBody.data.modelAlias ? { modelAlias: parsedBody.data.modelAlias } : {}),
      ...(parsedBody.data.credentialId ? { credentialId: parsedBody.data.credentialId } : {}),
      ...(parsedBody.data.idempotencyKey ? { idempotencyKey: parsedBody.data.idempotencyKey } : {}),
      ...(parsedBody.data.parameters ? { parameters: parsedBody.data.parameters } : {}),
      ...(promptResult?.success ? { promptDocument: promptResult.data } : {}),
    };

    const scope = projectScope(requestPrincipals, request);
    // Running with an already configured credential does not expose or mutate
    // its secret. Regular project users may select the credential bound to a
    // node, while listing, activating and editing credentials remains admin-only.
    if (body.credentialId && !(await settingsStore.hasCredential(body.credentialId))) {
      return reply.code(404).send({ error: 'credential not found' });
    }
    const canvas = await projectStore.getCanvas(body.projectId, scope);
    if (!canvas) return reply.code(404).send({ error: 'project not found' });

    try {
      // A request may submit a freshly edited document before the canvas PATCH
      // reaches storage. It applies only to the target node's immutable run
      // snapshot; it never mutates the saved canvas implicitly.
      const canvasForRun = body.promptDocument
        ? {
            ...canvas,
            nodes: canvas.nodes.map((node) =>
              node.id === request.params.nodeId
                ? {
                    ...node,
                    data: { ...node.data, promptDocument: body.promptDocument },
                  }
                : node,
            ),
          }
        : canvas;
      if (maxActiveRunsPerProject !== undefined) {
        const activeRuns = await runService.listByProject(body.projectId);
        const activeCount = activeRuns.filter((run) =>
          ['queued', 'preparing', 'running', 'processing', 'cancel_requested'].includes(run.status),
        ).length;
        if (activeCount >= maxActiveRunsPerProject) {
          return reply.code(429).send({
            error: 'project run quota exceeded',
            retryAfterSeconds: 30,
          });
        }
      }
      const target = canvasForRun.nodes.find((node) => node.id === request.params.nodeId);
      const projectDefaults = await projectStore.getModelDefaults(body.projectId, scope);
      const modelResolution = await resolveRunNodeModels({
        settingsStore,
        canvas: canvasForRun,
        targetNodeId: request.params.nodeId,
        ...(body.modelAlias ? { requestModelAlias: body.modelAlias } : {}),
        ...(body.credentialId ? { credentialId: body.credentialId } : {}),
        ...(projectDefaults ? { projectDefaults } : {}),
        allowVirtualMockModels: providerName === 'mock' && process.env.NODE_ENV !== 'production',
        requireCredentialReferences: providerName === 'newapi',
      });
      // 目录价格仅作为可选估算元数据；本项目不以估算或上游费用阻断提交。
      let estimatedCost: ReturnType<typeof quoteModelCost>;
      try {
        estimatedCost = quoteModelCost(
          modelResolution.targetModel?.price,
          target ? canvasForRun.edges.filter((edge) => edge.targetNodeId === target.id).length : 0,
          getRequestedUnits(body.parameters),
        );
      } catch (error) {
        if (!(error instanceof UsagePolicyError)) throw error;
        request.log.warn(
          { code: error.code, modelAlias: modelResolution.targetModelAlias },
          'ignoring invalid provider price metadata; upstream remains responsible for billing',
        );
        estimatedCost = undefined;
      }
      const principal = requestPrincipals.get(request);
      const frozenAssetRefs = await resolveRunAssetRefs({
        assetStore,
        canvas: canvasForRun,
        targetNodeId: request.params.nodeId,
        projectId: body.projectId,
        ...(principal?.userId ? { ownerId: principal.userId } : {}),
      });
      const frozenPromptMentions = await resolvePromptMentionRefs({
        assetStore,
        canvas: canvasForRun,
        targetNodeId: request.params.nodeId,
        projectId: body.projectId,
        ...(principal?.userId ? { ownerId: principal.userId } : {}),
        requestId: request.id,
      });
      const capabilityDiagnostics = validateRunPromptMentionCapabilities({
        canvas: canvasForRun,
        targetNodeId: request.params.nodeId,
        frozenPromptMentions,
        nodeModelAliases: modelResolution.nodeModelAliases,
        nodeModels: modelResolution.nodeModels,
        requestId: request.id,
        allowMockPreview: providerName === 'mock' && process.env.NODE_ENV !== 'production',
      });
      if (capabilityDiagnostics.length > 0) {
        throw new ResourceMentionCapabilityError(capabilityDiagnostics);
      }
      const credential = modelResolution.nodeCredentialReferences[request.params.nodeId];
      const snapshot = createRunSnapshot(body.projectId, canvasForRun, request.params.nodeId, {
        ...body,
        modelAlias: modelResolution.targetModelAlias,
        nodeModelAliases: modelResolution.nodeModelAliases,
        ...(Object.keys(modelResolution.nodeCredentialReferences).length > 0
          ? { nodeCredentialReferences: modelResolution.nodeCredentialReferences }
          : {}),
        frozenAssetRefs,
        ...(frozenPromptMentions.length > 0 ? { frozenPromptMentions } : {}),
        ...(credential ?? {}),
      });
      const headerIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof headerIdempotencyKey === 'string' ? headerIdempotencyKey : body.idempotencyKey;
      const run = await runService.create(snapshot, {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(principal?.userId ? { userId: principal.userId } : {}),
        ...(estimatedCost
          ? { estimatedCost: { amount: estimatedCost.amount, currency: estimatedCost.currency } }
          : {}),
      });
      request.log.info(
        {
          runId: run.id,
          projectId: body.projectId,
          nodeId: request.params.nodeId,
          provider: run.provider,
          modelAlias: run.modelAlias,
          ...(estimatedCost
            ? { estimatedCost: `${estimatedCost.amount} ${estimatedCost.currency}` }
            : {}),
          idempotent: Boolean(idempotencyKey),
        },
        'run queued',
      );
      return reply.code(202).send({ run: toPublicRunRecord(run) });
    } catch (error) {
      if (
        error instanceof RunServiceError &&
        (error.code === 'invalid_target' || error.code === 'idempotency_conflict')
      ) {
        return reply
          .code(error.code === 'idempotency_conflict' ? 409 : 400)
          .send({ error: error.message });
      }
      if (error instanceof AiSettingsError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      if (error instanceof AiCredentialNotFoundError) {
        return reply.code(404).send({ error: 'credential not found', code: error.code });
      }
      if (error instanceof RunAssetFreezeError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      if (error instanceof ResourceMentionFreezeError) {
        return reply.code(400).send({
          error: error.message,
          code: 'RESOURCE_MENTION_FREEZE_FAILED',
          requestId: request.id,
          issues: error.diagnostics,
        });
      }
      if (error instanceof ResourceMentionCapabilityError) {
        return reply.code(400).send({
          error: error.message,
          code: 'RESOURCE_MENTION_CAPABILITY_UNSUPPORTED',
          requestId: request.id,
          issues: error.diagnostics,
        });
      }
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (request, reply) => {
    const run = await runService.get(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    if (!(await projectStore.get(run.projectId, projectScope(requestPrincipals, request)))) {
      return reply.code(404).send({ error: 'run not found' });
    }
    return { run: toPublicRunRecord(run) };
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/retry', async (request, reply) => {
    try {
      const previous = await runService.get(request.params.runId);
      if (
        !previous ||
        !(await projectStore.get(previous.projectId, projectScope(requestPrincipals, request)))
      ) {
        return reply.code(404).send({ error: 'run not found' });
      }
      const run = await runService.retry(request.params.runId);
      return reply.code(202).send({ run: toPublicRunRecord(run) });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/cancel', async (request, reply) => {
    try {
      const current = await runService.get(request.params.runId);
      if (
        !current ||
        !(await projectStore.get(current.projectId, projectScope(requestPrincipals, request)))
      ) {
        return reply.code(404).send({ error: 'run not found' });
      }
      const run = await runService.cancel(request.params.runId);
      return reply.code(202).send({ run: toPublicRunRecord(run) });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Querystring: AssetListQuery }>('/v1/assets', async (request, reply) => {
    const parsedQuery = assetListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      const query = request.query as AssetListQuery;
      if (query.status !== undefined && !['ready', 'archived'].includes(query.status)) {
        return reply.code(400).send({ error: 'invalid asset status' });
      }
      if (
        query.mediaType !== undefined &&
        !['text', 'image', 'audio', 'video'].includes(query.mediaType)
      ) {
        return reply.code(400).send({ error: 'invalid asset media type' });
      }
      return reply.code(400).send({ error: 'invalid asset query' });
    }

    const page = parsedQuery.data.page ?? DEFAULT_ASSET_LIST_PAGE;
    const pageSize = parsedQuery.data.pageSize ?? DEFAULT_ASSET_LIST_PAGE_SIZE;
    const options: AssetListOptions = {
      ...(parsedQuery.data.query ? { query: parsedQuery.data.query } : {}),
      ...(parsedQuery.data.mediaType ? { mediaType: parsedQuery.data.mediaType } : {}),
      ...(parsedQuery.data.status ? { status: parsedQuery.data.status } : {}),
      ...(parsedQuery.data.tags && parsedQuery.data.tags.length > 0
        ? { tags: parsedQuery.data.tags }
        : {}),
      page,
      pageSize,
    };
    const requestedProjectId = parsedQuery.data.projectId;
    if (requestedProjectId !== undefined) {
      // 项目 ID 只用于缩小资源范围，项目本身仍需经过当前请求的项目权限校验。
      // 失败统一返回 404，避免通过资源索引探测其他用户的项目是否存在。
      const project = await projectStore.get(
        requestedProjectId,
        projectScope(requestPrincipals, request),
      );
      if (!project) return reply.code(404).send({ error: 'project not found' });
    }

    const scopes = assetListScopes(requestPrincipals, request, requestedProjectId);
    const result = await listAssetsForScopes(assetStore, scopes, options);
    return { assets: result.assets, total: result.total, page, pageSize };
  });

  app.post('/v1/assets/uploads', { bodyLimit: MAX_UPLOAD_BYTES }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'file is required' });
    }

    const content = await file.toBuffer();
    const validation = validateUploadContent(file.filename, file.mimetype, content);
    if (!validation.ok) return reply.code(validation.status).send({ error: validation.error });

    const metadata = await tryExtractMediaMetadata(
      mediaMetadataExtractor,
      {
        content,
        mimeType: file.mimetype || 'application/octet-stream',
        mediaType: validation.mediaType,
      },
      request.log,
    );
    const derivatives = await tryGenerateMediaDerivatives(
      mediaDerivativeGenerator,
      {
        content,
        mimeType: file.mimetype || 'application/octet-stream',
        mediaType: validation.mediaType,
      },
      request.log,
    );

    const asset = await assetStore.create({
      name: file.filename,
      mediaType: validation.mediaType,
      mimeType: file.mimetype || 'application/octet-stream',
      content,
      ...(derivatives ? { derivatives } : {}),
      ...(metadata ? { metadata } : {}),
      ...ownerInput(requestPrincipals, request),
    });

    const { content: _content, ...response } = asset;
    return reply.code(201).send({ asset: response });
  });

  app.post('/v1/assets/uploads/init', async (request, reply) => {
    const result = z
      .object({
        name: z.string().trim().min(1).max(240),
        mimeType: z.string().trim().min(1).max(160),
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid upload initialization' });
    const mediaType = detectMediaType(result.data.name, result.data.mimeType);
    if (!mediaType) return reply.code(415).send({ error: 'unsupported media type' });
    const upload = await uploadSessionStore.create({
      name: result.data.name,
      mimeType: result.data.mimeType,
      mediaType,
      sizeBytes: result.data.sizeBytes,
      sha256: result.data.sha256.toLowerCase(),
      tags: result.data.tags ?? [],
      ...ownerInput(requestPrincipals, request),
    });
    const scope = uploadScope(requestPrincipals, request);
    const externalUploadUrl = await uploadSessionStore.getUploadUrl(upload.uploadId, scope);
    return reply.code(201).send({
      uploadId: upload.uploadId,
      uploadUrl: externalUploadUrl ?? `/v1/assets/uploads/${upload.uploadId}`,
      completeUrl: '/v1/assets/uploads/complete',
      expiresAt: new Date(upload.expiresAt).toISOString(),
    });
  });

  app.put<{ Params: { uploadId: string }; Body: Buffer }>(
    '/v1/assets/uploads/:uploadId',
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const scope = uploadScope(requestPrincipals, request);
      const upload = await uploadSessionStore.get(request.params.uploadId, scope);
      if (!upload || isUploadExpired(upload)) {
        await uploadSessionStore.delete(request.params.uploadId, scope);
        return reply.code(404).send({ error: 'upload not found or expired' });
      }
      const content = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (content.byteLength > MAX_UPLOAD_BYTES || content.byteLength !== upload.sizeBytes) {
        return reply.code(400).send({ error: 'uploaded size does not match initialization' });
      }
      const actualSha256 = sha256(content);
      if (actualSha256 !== upload.sha256) {
        return reply.code(400).send({ error: 'uploaded SHA-256 does not match initialization' });
      }
      await uploadSessionStore.putContent(upload.uploadId, content, scope);
      return reply.code(204).send();
    },
  );

  app.post('/v1/assets/uploads/complete', async (request, reply) => {
    const result = z
      .object({
        uploadId: z.string().min(1),
        name: z.string().trim().min(1).max(240),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid upload completion' });
    const scope = uploadScope(requestPrincipals, request);
    const upload = await uploadSessionStore.get(result.data.uploadId, scope);
    if (!upload || isUploadExpired(upload)) {
      await uploadSessionStore.delete(result.data.uploadId, scope);
      return reply.code(404).send({ error: 'upload not found or expired' });
    }
    if (
      upload.name !== result.data.name ||
      upload.mimeType !== result.data.mimeType ||
      upload.sizeBytes !== result.data.sizeBytes ||
      upload.sha256 !== result.data.sha256.toLowerCase()
    ) {
      return reply
        .code(409)
        .send({ error: 'upload completion metadata does not match initialization' });
    }
    const content = await uploadSessionStore.getContent(upload.uploadId, scope);
    if (!content) return reply.code(409).send({ error: 'upload content is not ready' });
    const validation = validateUploadContent(upload.name, upload.mimeType, content);
    if (!validation.ok || sha256(content) !== upload.sha256) {
      await uploadSessionStore.delete(result.data.uploadId, scope);
      return reply.code(400).send({ error: 'uploaded content failed integrity validation' });
    }
    const metadata = await tryExtractMediaMetadata(
      mediaMetadataExtractor,
      { content, mimeType: upload.mimeType, mediaType: validation.mediaType },
      request.log,
    );
    const derivatives = await tryGenerateMediaDerivatives(
      mediaDerivativeGenerator,
      { content, mimeType: upload.mimeType, mediaType: validation.mediaType },
      request.log,
    );
    const asset = await assetStore.create({
      name: upload.name,
      mediaType: validation.mediaType,
      mimeType: upload.mimeType,
      content,
      tags: upload.tags,
      ...(derivatives ? { derivatives } : {}),
      ...(metadata ? { metadata } : {}),
      ...ownerInput(requestPrincipals, request),
    });
    await uploadSessionStore.delete(result.data.uploadId, scope);
    const { content: _content, ...response } = asset;
    return reply.code(201).send({ asset: response });
  });

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/access-url',
    async (request, reply) => {
      const result = z
        .object({
          expiresInSeconds: z.number().int().min(30).max(900).optional(),
          version: z.number().int().min(1).optional(),
          derivative: z.enum(['thumbnail', 'poster', 'waveform']).optional(),
        })
        .strict()
        .safeParse(request.body ?? {});
      if (!result.success || (result.data.version !== undefined && result.data.derivative)) {
        return reply.code(400).send({ error: 'invalid asset access URL request' });
      }

      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset not found' });

      const resource = accessResource(request.params.assetId, result.data);
      if (result.data.version !== undefined) {
        const content = await assetStore.getVersionContent(
          request.params.assetId,
          result.data.version,
          scope,
        );
        if (!content) return reply.code(404).send({ error: 'asset version not found' });
      } else if (result.data.derivative !== undefined) {
        const derivative = await assetStore.getDerivative(
          request.params.assetId,
          result.data.derivative,
          scope,
        );
        if (!derivative) return reply.code(404).send({ error: 'derivative not found' });
      }

      const expiresIn = result.data.expiresInSeconds ?? 300;
      const expiresAt = Date.now() + expiresIn * 1000;
      const nativeUrl = await assetStore.createPresignedGetUrl?.(
        request.params.assetId,
        {
          ...(result.data.version !== undefined ? { version: result.data.version } : {}),
          ...(result.data.derivative !== undefined ? { derivative: result.data.derivative } : {}),
          expiresIn,
        },
        scope,
      );
      if (nativeUrl)
        return reply.send({ url: nativeUrl, expiresAt: new Date(expiresAt).toISOString() });
      const token = createAssetAccessToken(
        {
          resource,
          assetId: request.params.assetId,
          ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
          expiresAt,
        },
        assetAccessSecret,
      );
      const path = accessPath(request.params.assetId, result.data);
      return reply.send({
        url: `${path}?access_token=${encodeURIComponent(token)}`,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/content',
    async (request, reply) => {
      const asset = await assetStore.get(
        request.params.assetId,
        assetScope(requestPrincipals, request),
      );
      if (!asset) {
        return reply.code(404).send({ error: 'asset not found' });
      }

      return reply.type(asset.mimeType).send(asset.content);
    },
  );

  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/versions',
    async (request, reply) => {
      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const versions = await assetStore.listVersions(request.params.assetId, scope);
      return {
        versions: versions.map(({ contentKey: _contentKey, ...version }) => ({
          ...version,
          contentUrl: `/v1/assets/${request.params.assetId}/versions/${version.version}/content`,
        })),
      };
    },
  );

  app.get<{ Params: { assetId: string; version: string } }>(
    '/v1/assets/:assetId/versions/:version/content',
    async (request, reply) => {
      if (!/^\d+$/.test(request.params.version)) {
        return reply.code(400).send({ error: 'invalid asset version' });
      }
      const version = Number(request.params.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        return reply.code(400).send({ error: 'invalid asset version' });
      }
      const scope = assetScope(requestPrincipals, request);
      const asset = await assetStore.get(request.params.assetId, scope);
      if (!asset) return reply.code(404).send({ error: 'asset version not found' });
      const content = await assetStore.getVersionContent(request.params.assetId, version, scope);
      if (!content) return reply.code(404).send({ error: 'asset version not found' });
      return reply.type(asset.mimeType).send(content);
    },
  );

  app.get<{ Params: { assetId: string; kind: string } }>(
    '/v1/assets/:assetId/derivatives/:kind',
    async (request, reply) => {
      if (!['thumbnail', 'poster', 'waveform'].includes(request.params.kind)) {
        return reply.code(404).send({ error: 'derivative not found' });
      }
      const derivative = await assetStore.getDerivative(
        request.params.assetId,
        request.params.kind,
        assetScope(requestPrincipals, request),
      );
      if (!derivative) return reply.code(404).send({ error: 'derivative not found' });
      return reply.type(derivative.mimeType).send(derivative.content);
    },
  );

  app.patch<{ Params: { assetId: string } }>('/v1/assets/:assetId', async (request, reply) => {
    const result = z
      .object({
        name: z.string().trim().min(1).max(240).optional(),
        tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'invalid asset update' });
    const asset = await assetStore.update(
      request.params.assetId,
      result.data,
      assetScope(requestPrincipals, request),
    );
    if (!asset) return reply.code(404).send({ error: 'asset not found' });
    const { content: _content, ...response } = asset;
    return { asset: response };
  });

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/archive',
    async (request, reply) => {
      const asset = await assetStore.setArchived(
        request.params.assetId,
        true,
        assetScope(requestPrincipals, request),
      );
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const { content: _content, ...response } = asset;
      return { asset: response };
    },
  );

  app.post<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/restore',
    async (request, reply) => {
      const asset = await assetStore.setArchived(
        request.params.assetId,
        false,
        assetScope(requestPrincipals, request),
      );
      if (!asset) return reply.code(404).send({ error: 'asset not found' });
      const { content: _content, ...response } = asset;
      return { asset: response };
    },
  );

  app.addHook('onClose', async () => {
    await uploadSessionStore.close?.();
    for (const cleanup of [...eventStreamCleanups]) cleanup();
    await runService.close();
    await (projectStore as ProjectStore).close?.();
    await settingsStore.close?.();
    await webhookEventStore.close?.();
    await authStore.close?.();
    await rateLimiter.close?.();
  });

  return app;
}

function projectScope(principals: WeakMap<object, AuthPrincipal>, request: object): ProjectScope {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

function assetScope(principals: WeakMap<object, AuthPrincipal>, request: object): AssetScope {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

/**
 * 构造资源索引的授权范围。
 *
 * 项目查询使用项目范围，并由路由先校验项目权限；个人资源显式限定为
 * `projectId: null`，避免把其他项目的资源混入当前 `@` 搜索。未提供项目
 * 参数时保留旧的用户/匿名列表行为，兼容旧客户端。
 */
function assetListScopes(
  principals: WeakMap<object, AuthPrincipal>,
  request: object,
  projectId: string | undefined,
): AssetScope[] {
  if (projectId === undefined) return [assetScope(principals, request)];
  const userId = principals.get(request)?.userId;
  const projectScope: AssetScope = { projectId };
  const personalScope: AssetScope = {
    projectId: null,
    ...(userId ? { ownerId: userId } : {}),
  };
  return [projectScope, personalScope];
}

/**
 * 在项目资源和个人资源两个授权范围上执行同一组索引条件，并在 API 边界
 * 完成去重、总数和分页。AssetStore 的单范围接口保持不变，旧实现也可复用。
 */
async function listAssetsForScopes(
  assetStore: AssetStore,
  scopes: readonly AssetScope[],
  options: AssetListOptions,
): Promise<{ assets: Awaited<ReturnType<AssetStore['list']>>; total: number }> {
  if (scopes.length === 1) {
    const scope = scopes[0];
    const { page: _page, pageSize: _pageSize, ...countOptions } = options;
    const [assets, total] = await Promise.all([
      assetStore.list(scope, options),
      typeof assetStore.count === 'function'
        ? assetStore.count(scope, countOptions)
        : assetStore.list(scope, countOptions).then((all) => all.length),
    ]);
    return { assets, total };
  }

  const unpagedOptions: AssetListOptions = { ...options };
  delete unpagedOptions.page;
  delete unpagedOptions.pageSize;
  const lists = await Promise.all(scopes.map((scope) => assetStore.list(scope, unpagedOptions)));
  const assets = [...new Map(lists.flat().map((asset) => [asset.id, asset])).values()];
  const page = options.page ?? DEFAULT_ASSET_LIST_PAGE;
  const pageSize = options.pageSize ?? DEFAULT_ASSET_LIST_PAGE_SIZE;
  const start = (page - 1) * pageSize;
  return { assets: assets.slice(start, start + pageSize), total: assets.length };
}

type AccessUrlRequest = {
  version?: number;
  derivative?: 'thumbnail' | 'poster' | 'waveform';
};

function accessResource(assetId: string, options: AccessUrlRequest): string {
  if (options.version !== undefined) return `asset:${assetId}:version:${options.version}`;
  if (options.derivative !== undefined) return `asset:${assetId}:derivative:${options.derivative}`;
  return `asset:${assetId}:content`;
}

function accessPath(assetId: string, options: AccessUrlRequest): string {
  if (options.version !== undefined) {
    return `/v1/assets/${encodeURIComponent(assetId)}/versions/${options.version}/content`;
  }
  if (options.derivative !== undefined) {
    return `/v1/assets/${encodeURIComponent(assetId)}/derivatives/${options.derivative}`;
  }
  return `/v1/assets/${encodeURIComponent(assetId)}/content`;
}

function assetContentResource(pathname: string): string | undefined {
  const content = /^\/v1\/assets\/([^/]+)\/content$/.exec(pathname);
  if (content) {
    const assetId = decodePathSegment(content[1]);
    return assetId ? `asset:${assetId}:content` : undefined;
  }
  const version = /^\/v1\/assets\/([^/]+)\/versions\/(\d+)\/content$/.exec(pathname);
  if (version) {
    const assetId = decodePathSegment(version[1]);
    return assetId ? `asset:${assetId}:version:${version[2]}` : undefined;
  }
  const derivative = /^\/v1\/assets\/([^/]+)\/derivatives\/(thumbnail|poster|waveform)$/.exec(
    pathname,
  );
  if (derivative) {
    const assetId = decodePathSegment(derivative[1]);
    return assetId ? `asset:${assetId}:derivative:${derivative[2]}` : undefined;
  }
  return undefined;
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function ownerInput(
  principals: WeakMap<object, AuthPrincipal>,
  request: object,
): { ownerId?: string } {
  const userId = principals.get(request)?.userId;
  return userId ? { ownerId: userId } : {};
}

function uploadScope(
  principals: WeakMap<object, AuthPrincipal>,
  request: object,
): UploadSessionScope {
  const ownerId = principals.get(request)?.userId;
  return ownerId ? { ownerId } : {};
}

/**
 * Current AI credentials are platform-wide records. A JWT identifies an end
 * user, but it does not convey an administrator role, so only the configured
 * service token may manage those credentials until project-scoped credentials
 * and roles are introduced.
 */
function canManagePlatformSettings(
  principals: WeakMap<object, AuthPrincipal>,
  sessions: WeakMap<object, AuthenticatedSession>,
  request: object,
): boolean {
  const principal = principals.get(request);
  if (!principal) return false;
  if (principal.method === 'api-token') return true;
  if (principal.method === 'anonymous') {
    // Keep the unauthenticated local UI usable without exposing platform
    // credentials to a network peer. The runnable dev API binds to loopback
    // by default; deployments can disable this path explicitly.
    const requestIp = (request as { ip?: unknown }).ip;
    const allowAnonymous =
      process.env.NODE_ENV !== 'production' &&
      process.env.API_ALLOW_ANONYMOUS_SETTINGS !== 'false' &&
      typeof requestIp === 'string' &&
      isLoopbackAddress(requestIp);
    return allowAnonymous;
  }
  // Only the first-party session lookup may grant the admin role. A role claim
  // on a legacy stateless JWT is deliberately ignored for platform settings.
  return sessions.get(request)?.user.role === 'admin';
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function sendAuthServiceError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  error: unknown,
): unknown {
  if (!(error instanceof AuthServiceError)) throw error;
  switch (error.code) {
    case 'invalid_input':
      return reply.code(400).send({ error: error.message });
    case 'email_taken':
      return reply.code(409).send({ error: error.message });
    case 'invalid_credentials':
    case 'invalid_token':
    case 'session_revoked':
      return reply.code(401).send({ error: error.message });
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** 将内存运行产物归档到所属项目，并复用上传资产的存储边界。 */
function createAssetResultArchiver(assetStore: AssetStore): RunResultArchiver {
  return async ({ run, result, output }) => {
    if (!output || output.content.byteLength === 0) return undefined;
    const target = run.snapshot.nodes.find((node) => node.id === result.targetNodeId);
    const label = sanitizeAssetName(target?.data.label ?? result.targetNodeId);
    const extension = output.format
      ? `.${output.format.replace(/[^a-z0-9]+/gi, '').toLowerCase()}`
      : extensionForResultMime(output.mimeType, result.mediaType);
    const asset = await assetStore.create({
      projectId: run.projectId,
      name: `${label}${extension}`,
      mediaType: result.mediaType,
      mimeType: output.mimeType,
      content: output.content,
      metadata: {
        source: 'run',
        runId: run.id,
        targetNodeId: result.targetNodeId,
        provider: result.provider,
        modelAlias: run.modelAlias,
      },
      ...(run.userId ? { ownerId: run.userId } : {}),
    });
    return {
      assetId: asset.id,
      version: 1,
      ...(asset.contentUrl ? { contentUrl: asset.contentUrl } : {}),
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
    };
  };
}

function sanitizeAssetName(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim();
  return normalized.slice(0, 180) || 'Generated output';
}

function extensionForResultMime(mimeType: string, mediaType: 'text' | 'image' | 'audio' | 'video') {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (subtype === 'svg+xml') return '.svg';
  if (subtype === 'jpeg') return '.jpg';
  if (subtype === 'wav' || subtype === 'x-wav') return '.wav';
  if (subtype === 'webm') return '.webm';
  if (subtype === 'mpeg') return mediaType === 'audio' ? '.mp3' : '.mpeg';
  if (subtype) return `.${subtype.replace(/[^a-z0-9]+/g, '')}`;
  return mediaType === 'text' ? '.txt' : `.${mediaType}`;
}

function validateUploadContent(
  name: string,
  mimeType: string,
  content: Buffer,
):
  | { ok: true; mediaType: Exclude<ReturnType<typeof detectMediaType>, undefined> }
  | { ok: false; status: 400 | 413 | 415; error: string } {
  if (content.byteLength === 0) return { ok: false, status: 400, error: 'file cannot be empty' };
  if (content.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: 'file exceeds the 100 MB upload limit' };
  }
  const mediaType = detectMediaType(name, mimeType);
  if (!mediaType) return { ok: false, status: 415, error: 'unsupported media type' };
  return { ok: true, mediaType };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isUploadExpired(upload: { expiresAt: number }): boolean {
  return Date.now() >= upload.expiresAt;
}

/** Normalize the small set of fields needed by the provider-job lifecycle. */
function parseNewApiWebhook(body: Record<string, unknown>): ProviderWebhookUpdate | undefined {
  const candidates = webhookCandidates(body);
  const explicitPlatformJobId = firstWebhookString(candidates, [
    'platformJobId',
    'platform_job_id',
    'requestId',
    'request_id',
    'taskId',
    'task_id',
    'jobId',
    'job_id',
  ]);
  const nestedPlatformJobId = candidates
    .slice(1)
    .map((candidate) => candidate.id)
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const platformJobId = (
    explicitPlatformJobId ??
    nestedPlatformJobId ??
    (typeof body.id === 'string' ? body.id : undefined)
  )?.trim();
  if (!platformJobId) return undefined;

  const status = normalizeWebhookProviderStatus(
    firstWebhookString(candidates, ['status', 'state', 'phase', 'event', 'type']),
  );
  const progress = parseWebhookProgress(
    firstWebhookValue(candidates, ['progress', 'percentage', 'percent']),
  );
  const error = firstWebhookString(candidates, [
    'errorMessage',
    'error_message',
    'error',
    'message',
  ]);
  return {
    provider: 'newapi',
    platformJobId,
    ...(status ? { status } : {}),
    ...(progress !== undefined ? { progress } : {}),
    payload: body,
    ...(error && (status === 'failed' || status === 'cancelled') ? { error } : {}),
  };
}

function webhookCandidates(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [body];
  const queue: unknown[] = [body.data, body.job, body.task, body.result, body.payload];
  while (queue.length > 0 && candidates.length < 8) {
    const value = queue.shift();
    if (!isRecord(value) || candidates.includes(value)) continue;
    candidates.push(value);
    queue.push(value.data, value.job, value.task, value.result);
  }
  return candidates;
}

function firstWebhookValue(candidates: Array<Record<string, unknown>>, keys: string[]): unknown {
  for (const candidate of candidates) {
    for (const key of keys) {
      if (candidate[key] !== undefined) return candidate[key];
    }
  }
  return undefined;
}

function firstWebhookString(
  candidates: Array<Record<string, unknown>>,
  keys: string[],
): string | undefined {
  const value = firstWebhookValue(candidates, keys);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseWebhookProgress(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeWebhookProviderStatus(
  value: string | undefined,
): ProviderWebhookUpdate['status'] {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s.-]+/g, '_');
  if (/(cancel|abort)/.test(normalized)) return 'cancelled';
  if (/(fail|error|reject)/.test(normalized)) return 'failed';
  if (/(success|complete|done|finish)/.test(normalized)) return 'succeeded';
  if (/(run|process|progress|generat)/.test(normalized)) return 'running';
  if (/(queue|pending|wait|submit|accept|creat)/.test(normalized)) return 'submitted';
  return undefined;
}

function verifyWebhookSignature(payload: unknown, signature: string, secret: string) {
  const normalized = signature.startsWith('sha256=')
    ? signature.slice('sha256='.length)
    : signature;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(payload ?? {}))
    .digest('hex');
  return safeEqual(normalized, expected);
}

function toPublicRunRecord(run: RunRecord): PublicRunRecord {
  const result = run.result;
  return {
    id: run.id,
    projectId: run.projectId,
    targetNodeId: run.targetNodeId,
    status: run.status,
    progress: run.progress,
    attempt: run.attempt,
    provider: run.provider,
    modelAlias: run.modelAlias,
    snapshot: {
      canvasRevision: run.snapshot.canvasRevision,
      inputCount: run.snapshot.inputs.length,
      inputs: Array.from({ length: run.snapshot.inputs.length }, () => null),
      ...(run.snapshot.promptMentions && run.snapshot.promptMentions.length > 0
        ? { promptMentions: run.snapshot.promptMentions.map((mention) => ({ ...mention })) }
        : {}),
    },
    ...(result
      ? {
          result: {
            provider: result.provider,
            summary: result.summary,
            targetNodeId: result.targetNodeId,
            mediaType: result.mediaType,
            inputCount: result.inputCount,
            ...(result.simulated !== undefined ? { simulated: result.simulated } : {}),
            ...(result.asset ? { asset: toPublicRunResultAsset(result.asset) } : {}),
            ...(result.promptMentions && result.promptMentions.length > 0
              ? { promptMentions: result.promptMentions.map((mention) => ({ ...mention })) }
              : {}),
          },
        }
      : {}),
    ...(run.error ? { error: toPublicRunError(run.error) } : {}),
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toPublicRunEvent(run: RunRecord): PublicRunEvent {
  const { snapshot: _snapshot, ...event } = toPublicRunRecord(run);
  return event;
}

function toPublicRunResultAsset(asset: RunResultAsset): PublicRunResultAsset {
  return {
    assetId: asset.assetId,
    ...(asset.version !== undefined ? { version: asset.version } : {}),
    ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    ...(asset.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
}

function toPublicRunError(value: string): string {
  return redactPublicRunErrorUrls(
    sanitizeExceptionForObservability(new Error(value)).message,
  ).slice(0, 2_000);
}

function redactPublicRunErrorUrls(value: string): string {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\bdata:[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(
      /\b\/v1\/assets\/[^\s"'<>?#]+(?:\/versions\/\d+)?\/content[?#][^\s"'<>]*/gi,
      '[REDACTED_URL]',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isErrorCode(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

function errorStatusCode(value: unknown): number {
  if (!isRecord(value)) return 500;
  const statusCode = value.statusCode;
  return typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
    ? statusCode
    : 500;
}

function parseByteLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_UPLOAD_BYTES
    ? parsed
    : fallback;
}

function setRateLimitHeaders(
  reply: { header(name: string, value: string): unknown },
  decision: { limit: number; remaining: number; resetAt: number },
): void {
  reply.header('x-ratelimit-limit', String(decision.limit));
  reply.header('x-ratelimit-remaining', String(decision.remaining));
  reply.header('x-ratelimit-reset', String(Math.ceil(decision.resetAt / 1000)));
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析资源列表中的正整数查询参数，拒绝小数、符号和超出安全范围的值。 */
function parsePositiveQueryInt() {
  return z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value), 'asset pagination value is invalid');
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');
}

function resolveCorsOrigins(
  value: string | undefined,
  nodeEnv: string | undefined,
  webPortValue?: string,
): string[] {
  const configured = parseCorsOrigins(value);
  if (nodeEnv === 'production') return [...new Set(configured)];
  const webPort = parseLocalWebPort(webPortValue);
  return [
    ...new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`, ...configured]),
  ];
}

function parseLocalWebPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 5173;
}

function getRequestedUnits(parameters: Record<string, unknown> | undefined): number | string {
  const value = parameters?.units;
  return typeof value === 'number' || typeof value === 'string' ? value : 1;
}

async function tryExtractMediaMetadata(
  extractor: MediaMetadataExtractor,
  input: MediaProbeInput,
  logger: { warn: (object: unknown, message?: string) => void },
): Promise<Record<string, unknown> | undefined> {
  try {
    const metadata = await extractor.extract(input);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch (error) {
    logger.warn(
      { err: sanitizeExceptionForObservability(error), mimeType: input.mimeType },
      'media metadata extraction failed',
    );
    return undefined;
  }
}

async function tryGenerateMediaDerivatives(
  generator: MediaDerivativeGenerator,
  input: MediaProbeInput,
  logger: { warn: (object: unknown, message?: string) => void },
): Promise<Record<string, { mimeType: string; content: Buffer }> | undefined> {
  try {
    const generated = await generator.generate(input);
    if (generated.length === 0) return undefined;
    return Object.fromEntries(
      generated
        .filter((derivative) => derivative.content.byteLength > 0)
        .map((derivative) => [
          derivative.kind,
          { mimeType: derivative.mimeType, content: derivative.content },
        ]),
    );
  } catch (error) {
    logger.warn(
      { err: sanitizeExceptionForObservability(error), mimeType: input.mimeType },
      'media derivative generation failed',
    );
    return undefined;
  }
}

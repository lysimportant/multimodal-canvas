import type {
  FrozenPromptMention,
  ImageEditCapability,
  PromptDocument,
  MediaType,
  PortRole,
  ProviderJob,
  RequestPromptFormat,
  RequestPromptPart,
  RequestPromptRecord,
  RequestPromptResource,
  RunInputSnapshot,
  RunResult,
  RunSnapshot,
} from '@multimodal-canvas/domain';
import {
  imageEditSourceSchema,
  precheckVideoGenerationInputs,
  renderPromptDocument,
  resolveImageEditMaxImages,
  REQUEST_PROMPT_SCHEMA_VERSION,
  videoInputRoleForPromptMention,
  videoFamilyForModel,
  videoModeForPromptMentions,
} from '@multimodal-canvas/domain';

export type ProviderName = 'mock' | 'newapi';

/**
 * Provider-neutral 的已解析资源提及。
 *
 * 冻结字段来自不可变运行快照，`source` 只存在于 Worker 到 Provider 的
 * 进程内调用中，不得写回队列、运行记录或公开 API。
 */
export type ResolvedMention = FrozenPromptMention & {
  /** 新快照始终提供明确节点 ID；旧快照在解析时补为目标节点。 */
  nodeId: string;
  /** 当前 Worker 已读取并校验的不可变资产版本内容。 */
  source:
    | { kind: 'data-url'; mimeType: string; dataUrl: string }
    | { kind: 'remote-url'; mimeType: string; url: string };
};

export type ProviderCapability = {
  mediaType: MediaType;
  supportsAsync: boolean;
};

export const mockProviderCapabilities: ProviderCapability[] = [
  { mediaType: 'text', supportsAsync: false },
  { mediaType: 'image', supportsAsync: false },
  { mediaType: 'audio', supportsAsync: false },
  { mediaType: 'video', supportsAsync: true },
];

/**
 * Worker 在真正发送请求前持久化最终请求文本；抛错必须阻止请求。
 *
 * Provider 只按即将发送的请求体构造记录，并把 `sendStatus` 置为 `pending`
 * （已留存、尚未确认发送结果）；发送结果与结果资产绑定由 Worker 写入，
 * Provider 不回写已落库记录。
 */
export type RequestPromptCapture = (record: RequestPromptRecord) => Promise<void> | void;

export type MockProviderRequest = {
  snapshot: RunSnapshot;
  /** Worker 在进程内解析的资源内容；真实适配器只能按正式供应商契约消费。 */
  resolvedMentions?: readonly ResolvedMention[];
  reportProgress?: (progress: number) => Promise<void> | void;
  /** 本次运行的持久化身份；提供 onRequestPrompt 时必填，Provider 不伪造。 */
  runId?: string;
  /** 本次节点执行次数，从 1 开始；缺省按 1 记录。 */
  attempt?: number;
  /** Worker 在真正发送请求前持久化最终请求文本；抛错必须阻止请求。 */
  onRequestPrompt?: RequestPromptCapture;
};

export class MockProvider {
  async execute({ snapshot, reportProgress }: MockProviderRequest): Promise<RunResult> {
    await reportProgress?.(100);
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new Error('run target node is missing from snapshot');

    return {
      provider: 'mock',
      summary: `Mock Provider 已完成 ${target.data.label}`,
      targetNodeId: target.id,
      mediaType: target.data.mediaType,
      inputCount: snapshot.inputs.length,
      ...(snapshot.promptMentions && snapshot.promptMentions.length > 0
        ? {
            simulated: true,
            promptMentions: snapshot.promptMentions.map((mention) => ({ ...mention })),
          }
        : {}),
    };
  }
}

export type NewApiProviderOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Maximum response body buffered from the provider. */
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  /**
   * Reject plaintext HTTP endpoints. Production also enforces this when the
   * option is omitted; set true explicitly for staging-like environments.
   */
  requireHttps?: boolean;
};

/**
 * Normalize a gateway origin to the OpenAI-compatible API prefix used by
 * New API. Users commonly paste the site origin (for example
 * `https://gateway.example.com`) instead of the documented `/v1` URL. Keep
 * explicit path prefixes untouched while making the origin form safe for all
 * provider endpoints.
 */
export function normalizeNewApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new TypeError('New API Base URL 不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TypeError('New API Base URL 必须是有效 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('New API Base URL 必须使用 HTTP(S)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('New API Base URL 不得包含用户信息、查询参数或片段');
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/v1';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

/** Provider 返回的持久化增量，普通关联 ID 不占用异步平台任务身份。 */
export type ProviderJobUpdate = Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;

export type NewApiProviderRequest = MockProviderRequest & {
  /**
   * 调用方的协作取消信号。信号只终止本地请求、轮询和下载，不会猜测
   * 或伪造供应商的远程取消接口；已提交的视频任务仍通过 `providerJob`
   * 保留平台任务 ID 供后续恢复或人工核对。
   */
  signal?: AbortSignal;
  /** 已冻结合同及异步平台身份，用于恢复查询，避免再次发送收费 POST。 */
  providerJob?: ProviderJobUpdate;
  /** 新视频 POST 前必须持久化合同，创建后持久化平台 ID；失败时停止执行，不自动重试。 */
  onProviderJob?: (providerJob: ProviderJobUpdate) => Promise<void> | void;
};

/** 一次请求真正发送的文本内容；由各组装的请求体直接派生，不重新渲染提示词。 */
type RequestPromptPayload = {
  format: RequestPromptFormat;
  /** 按发送顺序排列的文本块；纯文本请求只有一项。 */
  parts: RequestPromptPart[];
  resources: RequestPromptResource[];
  /** 真正写入请求体的负向内容；未发送时省略。 */
  negativeText?: string;
};

/** 请求记录输入：请求身份、媒体类型和从请求体派生的文本。 */
export type RequestPromptCaptureInput = RequestPromptPayload & {
  snapshot: RunSnapshot;
  /** 实际发起请求的 Provider 标识。 */
  provider: 'newapi' | 'xfyun';
  mediaType: MediaType;
  /** 同一 attempt 内的请求身份，由请求路径与序号组成。 */
  requestIdentity: string;
  /** Worker 提供的持久化回调；缺省时不产生记录。 */
  onRequestPrompt?: RequestPromptCapture;
  /** Worker 提供的运行身份；提供回调时必填，Provider 不伪造。 */
  runId?: string;
  /** Worker 提供的节点执行次数，从 1 开始；缺省按 1 记录。 */
  attempt?: number;
};

/**
 * 在真正发送前把最终请求文本交给 Worker 持久化。
 *
 * 记录直接来自即将发送的请求体：`sendStatus` 固定为 `pending`，表示“已留存、
 * 尚未确认发送结果”。发送后的终态与结果资产绑定由 Worker 按自身持久化结果
 * 写入，Provider 不提供发送后的回写入口。
 *
 * @param input 请求身份与已派生的文本块；未提供 `onRequestPrompt` 时不产生记录。
 * @throws {TypeError} 提供了持久化回调却缺少 `runId`，或 `attempt` 不是正整数。
 * @throws 持久化回调自身的错误原样向上抛出，调用方必须放弃本次请求。
 */
export async function reportRequestPrompt(input: RequestPromptCaptureInput): Promise<void> {
  const onRequestPrompt = input.onRequestPrompt;
  if (!onRequestPrompt) return;
  const runId = input.runId?.trim();
  if (!runId) throw new TypeError('请求提示词记录缺少运行身份：需要 Worker 提供 runId');
  const attempt = input.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new TypeError('请求提示词记录的 attempt 必须为正整数');
  }
  await onRequestPrompt({
    schemaVersion: REQUEST_PROMPT_SCHEMA_VERSION,
    runId,
    nodeId: input.snapshot.targetNodeId,
    attempt,
    requestIdentity: input.requestIdentity,
    provider: input.provider,
    modelAlias: input.snapshot.modelAlias,
    ...frozenCredentialReference(input.snapshot),
    mediaType: input.mediaType,
    format: input.format,
    parts: input.parts,
    ...(input.negativeText ? { negativeText: input.negativeText } : {}),
    resources: input.resources,
    sendStatus: 'pending',
    createdAt: new Date().toISOString(),
  });
}

/**
 * 读取目标节点冻结的凭据引用。
 *
 * 单节点引用优先：快照为每个 provider 节点冻结 `nodeCredentialReferences`；
 * 只有旧快照缺少该字段时才退回根级引用。两个字段始终取自同一来源，
 * 不混合成“凭证 A + 版本 B”的组合。
 */
function frozenCredentialReference(snapshot: RunSnapshot): {
  credentialId?: string;
  credentialVersion?: number;
} {
  const nodeReference = snapshot.nodeCredentialReferences?.[snapshot.targetNodeId];
  if (nodeReference) {
    return {
      credentialId: nodeReference.credentialId,
      credentialVersion: nodeReference.credentialVersion,
    };
  }
  if (!snapshot.credentialId) return {};
  return {
    credentialId: snapshot.credentialId,
    ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
  };
}

/**
 * Provider-neutral representation of a generated payload.
 *
 * Providers may return a remote URL or inline base64 data for binary media;
 * the worker owns persistence and turns either representation into an asset.
 * Text is kept as UTF-8 text so it does not need a data URL round trip.
 */
type StandardProviderOutput =
  | {
      mediaType: 'text';
      kind: 'text';
      text: string;
      mimeType: 'text/plain';
      format: 'txt';
    }
  | {
      mediaType: 'image' | 'audio';
      kind: 'url';
      url: string;
      mimeType: string;
      format?: string;
    }
  | {
      mediaType: 'image' | 'audio';
      kind: 'base64';
      base64: string;
      mimeType: string;
      format?: string;
    };

export type VideoProviderOutput =
  | {
      mediaType: 'video';
      kind: 'url';
      url: string;
      mimeType: string;
      format?: string;
    }
  | {
      mediaType: 'video';
      kind: 'base64';
      base64: string;
      mimeType: string;
      format?: string;
    };

export type ProviderOutput = StandardProviderOutput | VideoProviderOutput;

type ImageProviderOutput = Extract<ProviderOutput, { kind: 'url' | 'base64' }> & {
  mediaType: 'image';
};

type AudioProviderOutput = Extract<ProviderOutput, { kind: 'url' | 'base64' }> & {
  mediaType: 'audio';
};

/**
 * Usage reported by a provider after a successful request.
 *
 * Providers do not always report a price (for example, OpenAI-compatible
 * text responses commonly only contain token counts). `amount` is therefore
 * optional: callers must treat metadata-only usage as unpriced and must never
 * derive a cost from token or media counters.
 */
export type ProviderUsage = {
  amount?: number | string;
  currency?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Result envelope used by providers that return material generated content.
 * The `result` remains compatible with the domain RunResult contract while
 * `output` carries the bytes/text before the worker archives an asset.
 */
export type ProviderExecution<Output extends ProviderOutput = ProviderOutput> = {
  result: RunResult;
  output: Output;
  providerJob?: ProviderJobUpdate;
  usage?: ProviderUsage;
};

export type NewApiProviderErrorDetails = {
  /** HTTP status returned by New API, when a response was received. */
  status?: number;
  /** Provider error code or type, if one was supplied. */
  code?: string;
  /** 仅表示错误可能是临时的；重试前必须确认供应商幂等，不能据此认定不会重复收费。 */
  retryable?: boolean;
  /** Opaque provider request/correlation ID, never a credential. */
  requestId?: string;
  /** Asynchronous platform job identity, when task creation already succeeded. */
  platformJobId?: string;
  /** Last provider task payload, suitable for durable reconciliation. */
  providerPayload?: Record<string, unknown>;
};

/**
 * A structured, non-retrying provider error.
 *
 * The worker/API decide whether and how often to retry. Keeping this class
 * descriptive (rather than retrying here) avoids accidentally creating a
 * second paid generation request when a provider response is ambiguous.
 */
export class NewApiProviderError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly platformJobId?: string;
  readonly providerPayload?: Record<string, unknown>;

  constructor(
    message: string,
    statusOrDetails?: number | NewApiProviderErrorDetails,
    legacyDetails?: NewApiProviderErrorDetails,
  ) {
    super(sanitizeProviderErrorMessage(message));
    this.name = 'NewApiProviderError';

    const details: NewApiProviderErrorDetails =
      typeof statusOrDetails === 'number' || statusOrDetails === undefined
        ? { ...legacyDetails, status: statusOrDetails ?? legacyDetails?.status }
        : statusOrDetails;
    this.status = details.status;
    this.code = sanitizeProviderDiagnosticField(details.code);
    this.requestId = sanitizeProviderDiagnosticField(details.requestId);
    this.platformJobId = normalizeErrorField(details.platformJobId);
    this.providerPayload = sanitizeProviderPayload(details.providerPayload);
    this.retryable = details.retryable ?? isRetryableStatus(this.status);

    // Required when extending Error while targeting both Node and browsers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 图片请求的组装结果。
 *
 * `sourceImages` 是作为原图实际写入请求体的冻结输入，只用于记录资产身份，
 * 不含任何媒体内容。
 */
type ImageProviderRequest = {
  path: string;
  body: Record<string, unknown> | FormData;
  sourceImages: ImageSourceInput[];
};

/**
 * 将通用快照映射为 New API 文本、图片或音频请求。
 * 视频由 NewApiVideoProvider 按显式冻结合同独立处理。
 */
export class NewApiProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NewApiProviderOptions) {
    this.baseUrl = normalizeNewApiBaseUrl(options.baseUrl);
    if (shouldRequireHttps(options.requireHttps) && !this.baseUrl.startsWith('https://')) {
      throw new TypeError('生产环境 New API Base URL 必须使用 HTTPS');
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = positiveInteger(options.timeoutMs, 900_000, 'timeoutMs');
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      defaultResponseContentLimit,
      'maxResponseBytes',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute({
    snapshot,
    reportProgress,
    providerJob,
    resolvedMentions,
    signal,
    runId,
    attempt,
    onRequestPrompt,
  }: NewApiProviderRequest): Promise<ProviderExecution<StandardProviderOutput>> {
    throwIfProviderSignalAborted(signal);
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType === 'video') {
      throw new NewApiProviderError('video generation requires NewApiVideoProvider');
    }
    validateProviderRoleParameters(snapshot.parameters, target.data.mediaType);
    if (providerJob && providerJob.provider !== 'newapi') {
      throw new NewApiProviderError('已有平台任务与 New API Provider 不匹配', {
        code: 'PROVIDER_MISMATCH',
        retryable: false,
      });
    }

    // Worker 在请求前持久化本地任务身份，重放时仅保证发送相同的幂等键。
    // 供应商是否识别该键、如何去重及计费尚需契约确认，不能据此自动重试。
    const idempotencyKey = standardRequestIdempotencyKey(snapshot, providerJob);

    const imageRequest =
      target.data.mediaType === 'image'
        ? this.imageRequest(
            snapshot,
            target.data.label,
            target.data.prompt,
            target.data.promptDocument,
            resolvedMentions,
          )
        : undefined;
    // 请求体只组装一次：请求记录与真实发送必须取自同一份结果，不重新渲染提示词。
    let plan: {
      path: string;
      body: Record<string, unknown> | FormData;
      prompt: RequestPromptPayload;
    };
    if (target.data.mediaType === 'text') {
      const body = this.textPayload(
        snapshot,
        target.data.label,
        target.data.prompt,
        target.data.promptDocument,
        resolvedMentions,
      );
      plan = {
        path: '/chat/completions',
        body,
        prompt: { format: 'messages', ...textRequestPromptCapture(snapshot, body.messages) },
      };
    } else if (imageRequest) {
      plan = {
        path: imageRequest.path,
        body: imageRequest.body,
        prompt: {
          format: 'plain',
          parts: [{ order: 0, text: sentPromptText(imageRequest.body) }],
          resources: imagePromptResources(imageRequest.sourceImages),
        },
      };
    } else {
      const body = this.audioPayload(
        snapshot,
        target.data.label,
        target.data.prompt,
        target.data.promptDocument,
        resolvedMentions,
      );
      plan = {
        path: '/audio/speech',
        body,
        prompt: { format: 'plain', parts: [{ order: 0, text: body.input }], resources: [] },
      };
    }
    // 未接线时不增加等待点，保持原有的同步推进到时序。
    if (onRequestPrompt) {
      await reportRequestPrompt({
        snapshot,
        provider: 'newapi',
        mediaType: target.data.mediaType,
        requestIdentity: `POST ${plan.path}#1`,
        onRequestPrompt,
        runId,
        attempt,
        ...plan.prompt,
      });
    }
    const response = await this.request(plan.path, plan.body, idempotencyKey, signal);
    const output =
      target.data.mediaType === 'text'
        ? parseTextOutput(response.payload)
        : target.data.mediaType === 'image'
          ? parseImageOutput(response.payload, snapshot)
          : parseAudioOutput(response.payload, snapshot);
    const usage = parseProviderUsage(response.payload);
    await reportProgress?.(100);
    throwIfProviderSignalAborted(signal);

    return {
      result: {
        provider: 'newapi',
        summary: `New API 已完成 ${target.data.label}`,
        targetNodeId: target.id,
        mediaType: target.data.mediaType,
        inputCount: snapshot.inputs.length,
      },
      output,
      ...(response.requestId
        ? {
            providerJob: {
              provider: 'newapi' as const,
              payload: { requestId: response.requestId },
            },
          }
        : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private textPayload(
    snapshot: RunSnapshot,
    label: string,
    nodePrompt?: string,
    nodePromptDocument?: PromptDocument,
    resolvedMentions?: readonly ResolvedMention[],
  ) {
    const prompt = resolvePromptSource(snapshot, label, nodePrompt, 'text', nodePromptDocument);
    if (!nodePromptDocument) {
      const targetNodeId = snapshot.targetNodeId;
      const orphanedMention =
        (snapshot.promptMentions ?? []).find(
          (mention) => (mention.nodeId ?? targetNodeId) === targetNodeId,
        ) ?? (resolvedMentions ?? []).find((mention) => mention.nodeId === targetNodeId);
      if (orphanedMention) {
        throw promptMentionMappingError(
          snapshot,
          orphanedMention,
          'RESOURCE_MENTION_RESOLUTION_INVALID',
          '目标节点缺少 promptDocument',
        );
      }
    }
    const inputMessages = orderedRunInputs(snapshot).map((input) => {
      const name = chatInputName(input.role);
      if (!name) throw unsupportedInputRoleError('text', input.role);
      return {
        role: 'user' as const,
        name,
        content: chatInputContent(input),
      };
    });

    const promptMessage = nodePromptDocument
      ? (() => {
          const contentParts = promptDocumentContentParts(
            snapshot,
            nodePromptDocument,
            resolvedMentions,
          );
          return {
            role: 'user' as const,
            content: nodePromptDocument.blocks.every((block) => block.type === 'text')
              ? contentParts.map((part) => (part.type === 'text' ? part.text : '')).join('')
              : contentParts,
          };
        })()
      : { role: 'user' as const, content: prompt.value };

    return {
      ...providerParameters(snapshot.parameters, 'text'),
      model: snapshot.modelAlias,
      messages: [
        ...(prompt.explicit || inputMessages.length === 0 ? [promptMessage] : []),
        // `name` is part of the Chat Completions message contract. It keeps
        // the canvas role visible at the provider boundary without turning
        // separate inputs into one concatenated prompt string.
        ...inputMessages,
      ],
    };
  }

  /**
   * 文生图走 `/images/generations`；带原图的图生图走官方 `/images/edits`。
   * @param snapshot 当前运行快照。
   * @param label 目标节点显示名，提示词缺失时作为回退。
   * @param nodePrompt 节点上填写的提示词。
   * @param nodePromptDocument 结构化提示词文档。
   * @param resolvedMentions Worker 水合的冻结图片提及，作为 edits 原图上传。
   * @returns 请求路径、JSON 或 multipart 请求体，以及作为原图发送的输入。
   */
  private imageRequest(
    snapshot: RunSnapshot,
    label: string,
    nodePrompt?: string,
    nodePromptDocument?: PromptDocument,
    resolvedMentions?: readonly ResolvedMention[],
  ): ImageProviderRequest {
    const mapping = mapImageGenerationInputs(
      snapshot,
      label,
      nodePrompt,
      nodePromptDocument,
      resolvedMentions,
    );
    const parameters = providerParameters(snapshot.parameters, 'image');
    if (mapping.images.length === 0) {
      // 声明了图片编辑语义却没有可用原图时，绝不静默退回文生图。
      assertImageEditSourceInput(snapshot, mapping);
      return {
        path: '/images/generations',
        body: {
          ...parameters,
          model: snapshot.modelAlias,
          prompt: mapping.prompt,
          n: 1,
        },
        sourceImages: mapping.images,
      };
    }
    const maxImages = resolveImageEditMaxImages(snapshot.modelAlias, snapshot.imageEditCapability);
    if (mapping.images.length > maxImages) {
      throw new NewApiProviderError(
        `当前模型图片编辑一次最多支持 ${maxImages} 张不同图片或版本，当前为 ${mapping.images.length} 张`,
        { code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED', retryable: false },
      );
    }
    const capability = snapshot.imageEditCapability;
    const form = new FormData();
    form.append('model', snapshot.modelAlias);
    form.append('prompt', mapping.prompt);
    form.append('n', '1');
    for (const [parameter, value] of Object.entries(parameters)) {
      if (parameter === 'n' || parameter === 'stream') continue;
      if (capability?.parameters && !capability.parameters.includes(parameter)) {
        throw new NewApiProviderError(`New API 图片编辑未声明支持参数：${parameter}`, {
          code: 'IMAGE_EDIT_PARAMETER_UNSUPPORTED',
          retryable: false,
        });
      }
      const serialized = imageEditFormValue(value);
      if (serialized !== undefined) form.append(parameter, serialized);
    }
    // 单图保留既有字段；多图按官方 edits 合同重复提交 image[]，不改变输出数量 n。
    const field = mapping.images.length === 1 ? 'image' : 'image[]';
    for (const input of mapping.images) {
      assertImageEditSupported(snapshot, input);
      const image = imageFormFile(input, capability?.mimeTypes);
      form.append(field, image.file, image.filename);
    }
    return { path: '/images/edits', body: form, sourceImages: mapping.images };
  }

  private audioPayload(
    snapshot: RunSnapshot,
    label: string,
    nodePrompt?: string,
    nodePromptDocument?: PromptDocument,
    resolvedMentions?: readonly ResolvedMention[],
  ) {
    assertPromptMentionsUnsupported('audio', snapshot, nodePromptDocument, resolvedMentions);
    const input = resolveSinglePromptInput(
      snapshot,
      label,
      nodePrompt,
      'audio',
      nodePromptDocument,
    );
    if (!input.trim() || [...input].length > 4096) {
      throw invalidProviderParameter('audio', 'input', '必须为 1 到 4096 个字符');
    }
    return {
      ...providerParameters(snapshot.parameters, 'audio'),
      model: snapshot.modelAlias,
      input,
    };
  }

  /** 返回内容及脱敏请求关联 ID；同步 completion ID 不属于视频平台任务身份。 */
  private async request(
    path: string,
    body: Record<string, unknown> | FormData,
    idempotencyKey: string,
    externalSignal?: AbortSignal,
  ): Promise<{ payload: unknown; requestId?: string }> {
    const abortContext = createProviderAbortContext(this.timeoutMs, externalSignal);
    try {
      throwIfProviderSignalAborted(externalSignal);
      const isForm = body instanceof FormData;
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'idempotency-key': idempotencyKey,
          ...(isForm ? {} : { 'content-type': 'application/json' }),
        },
        body: isForm ? body : JSON.stringify(body),
        signal: abortContext.signal,
      });
      if (externalSignal?.aborted) discardResponseBody(response);
      throwIfProviderSignalAborted(externalSignal);
      const payload = await readResponsePayload(
        response,
        this.maxResponseBytes,
        abortContext.signal,
      );
      throwIfProviderSignalAborted(externalSignal);
      if (!response.ok) {
        throw providerResponseError(response, payload, [this.apiKey], '模型调用');
      }
      const bodyRequestId = isRecord(payload)
        ? [payload.request_id, payload.requestId, payload.id]
            .map((value) => sanitizeProviderDiagnosticField(value, [this.apiKey]))
            .find((value) => value !== undefined)
        : undefined;
      const requestId = responseRequestId(response, [this.apiKey]) ?? bodyRequestId;
      return { payload, ...(requestId ? { requestId } : {}) };
    } catch (error) {
      if (error instanceof NewApiProviderError) throw error;
      if (abortContext.wasExternallyAborted()) {
        throw providerCancellationError();
      }
      const isTimeout = getErrorName(error) === 'AbortError';
      throw new NewApiProviderError(
        isTimeout
          ? 'New API 请求超时'
          : error instanceof Error
            ? sanitizeProviderErrorMessage(error.message, [this.apiKey])
            : 'New API 请求失败',
        {
          code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          retryable: true,
        },
      );
    } finally {
      abortContext.cleanup();
    }
  }
}

/** 已实现的新建视频合同；Sora multipart 尚未实现，禁止隐式兼容。 */
export const NEW_API_VIDEO_CONTRACTS = [
  'newapi-video-v1',
  'newapi-unified-v1',
  'legacy-v1',
] as const;

/** 新建视频任务可选择的契约；默认由 API/Worker 配置，构造器未指定时仍为 legacy-v1。 */
export type NewApiVideoContract = (typeof NEW_API_VIDEO_CONTRACTS)[number];

/** 历史冻结标识与新建合同相同，避免把已提交任务迁到另一条路径。 */
type FrozenVideoContract = NewApiVideoContract;

/** 判断环境变量或冻结合同是否属于已实现的视频协议。 */
export function isNewApiVideoContract(value: unknown): value is NewApiVideoContract {
  return (NEW_API_VIDEO_CONTRACTS as readonly string[]).includes(String(value));
}

/** 视频执行选项；构造器默认 legacy，新任务可显式选官方统一协议。 */
export type NewApiVideoProviderOptions = NewApiProviderOptions & {
  /** 仅用于尚未冻结合同的新任务；恢复优先使用 providerJob.payload.contract。 */
  videoContract?: NewApiVideoContract;
  /** 查询等待基数，单位毫秒；允许 0 供隔离测试使用。 */
  pollIntervalMs?: number;
  /** 单次执行的最大查询次数，必须为正整数。 */
  maxPollAttempts?: number;
  /** 同源受保护视频的下载上限，单位字节；默认 50 MiB。 */
  maxContentBytes?: number;
};

/** 已解析的视频查询结果；媒体元数据只保留已确认的数值字段。 */
type VideoPollResult = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerStatus: string;
  progress: number;
  payload: Record<string, unknown>;
  outputUrl?: string;
  error?: string;
  usage?: ProviderUsage;
  outputFormat?: string;
  mediaMetadata?: Record<string, number>;
};

const defaultResponseContentLimit = 50 * 1024 * 1024;
const defaultVideoContentLimit = 50 * 1024 * 1024;
const newApiVideoJobsPath = '/videos';
const newApiVideoCreatePath = `${newApiVideoJobsPath}/generations`;

/**
 * 按冻结契约执行官方统一视频或历史网关任务，不混入 Sora multipart 字段。
 * 新建任务必须先通过 onProviderJob 持久化合同；已有 ID 不重新 POST。
 */
export class NewApiVideoProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly maxContentBytes: number;
  private readonly maxResponseBytes: number;
  /** 新任务默认合同，不覆盖历史任务的冻结合同。 */
  private readonly videoContract: NewApiVideoContract;

  /** 校验连接与轮询配置；不发请求，未知合同直接抛出 TypeError。 */
  constructor(options: NewApiVideoProviderOptions) {
    this.videoContract = options.videoContract ?? 'legacy-v1';
    if (!isNewApiVideoContract(this.videoContract)) {
      throw new TypeError(
        '不支持的视频合同；仅允许 newapi-video-v1、newapi-unified-v1 或 legacy-v1',
      );
    }
    this.baseUrl = normalizeNewApiBaseUrl(options.baseUrl);
    if (shouldRequireHttps(options.requireHttps) && !this.baseUrl.startsWith('https://')) {
      throw new TypeError('生产环境 New API Base URL 必须使用 HTTPS');
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = positiveInteger(options.timeoutMs, 900_000, 'timeoutMs');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs, 2_000, 'pollIntervalMs');
    this.maxPollAttempts = positiveInteger(
      options.maxPollAttempts,
      defaultVideoPollAttempts(this.timeoutMs, this.pollIntervalMs),
      'maxPollAttempts',
    );
    this.maxContentBytes = positiveInteger(
      options.maxContentBytes,
      defaultVideoContentLimit,
      'maxContentBytes',
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      defaultResponseContentLimit,
      'maxResponseBytes',
    );
  }

  /** 执行或恢复视频任务；新建要求先落盘合同，返回媒体、usage 与脱敏任务摘要。 */
  async execute({
    snapshot,
    reportProgress,
    providerJob: existingProviderJob,
    onProviderJob,
    resolvedMentions,
    signal,
    runId,
    attempt,
    onRequestPrompt,
  }: NewApiProviderRequest): Promise<ProviderExecution<VideoProviderOutput>> {
    throwIfProviderSignalAborted(
      signal,
      existingProviderJob?.provider === 'newapi' ? existingProviderJob.platformJobId : undefined,
    );
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType !== 'video') {
      throw new NewApiProviderError('NewApiVideoProvider 只能执行视频节点');
    }
    if (target.data.mode !== 'generate') {
      throw new NewApiProviderError('当前视频接口仅支持 generate 模式');
    }
    if (existingProviderJob && existingProviderJob.provider !== 'newapi') {
      throw new NewApiProviderError('已有平台任务与 New API Provider 不匹配', {
        code: 'VIDEO_PROVIDER_MISMATCH',
        retryable: false,
      });
    }
    const contract = resolveVideoContract(existingProviderJob, this.videoContract);
    const unified = contract === 'newapi-unified-v1';
    const openaiVideo = contract === 'newapi-video-v1';
    let platformJobId = normalizeErrorField(existingProviderJob?.platformJobId);
    const jobsPath = videoJobsPath(contract);
    let requestId = sanitizeProviderDiagnosticField(existingProviderJob?.payload?.requestId, [
      this.apiKey,
    ]);
    let submissionUsage: ProviderUsage | undefined;
    let initialPhase: 'submitted' | 'resumed' = 'resumed';
    if (!platformJobId) {
      if (existingProviderJob?.payload?.phase === 'submitting') {
        throw new NewApiProviderError('New API 视频创建结果未知，请先核对平台任务状态', {
          code: 'VIDEO_SUBMISSION_UNKNOWN',
          providerPayload: videoJobPayloadSummary(contract, 'submitting', snapshot.modelAlias),
          retryable: false,
        });
      }
      // 已受理任务只按冻结合同查询；原素材失效或新增参数校验不得阻断取回结果。
      const { inputs: absorbedMentionInputs, absorbedMentionIds } =
        collectAbsorbedVideoMentionInputs(snapshot, resolvedMentions);
      assertPromptMentionsUnsupported(
        'video',
        snapshot,
        target.data.promptDocument,
        resolvedMentions,
        absorbedMentionIds,
      );
      validateProviderRoleParameters(snapshot.parameters, 'video');
      const family = videoFamilyForModel(snapshot.modelAlias);
      const official = ['minimax-h3', 'wan3', 'seedance-2', 'seedance-2.5'].includes(family);
      if (official && !openaiVideo) {
        throw new NewApiProviderError(
          '该官方模型使用 New API /v1/videos 插件协议，请选择 OpenAI 视频合同',
          { code: 'VIDEO_CONTRACT_UNSUPPORTED', retryable: false },
        );
      }
      if (unified) validateUnifiedVideoParameters(snapshot.parameters);
      else
        validateMediaParameters(snapshot.parameters, 'video', official && family !== 'minimax-h3');
      const inputs = mapVideoInputs(snapshot, absorbedMentionInputs);
      const idempotencyKey = standardRequestIdempotencyKey(snapshot, existingProviderJob);
      const body = unified
        ? unifiedVideoPayload(
            snapshot,
            target.data.label,
            target.data.prompt,
            inputs,
            target.data.promptDocument,
          )
        : openaiVideo
          ? openaiVideoPayload(
              snapshot,
              target.data.label,
              target.data.prompt,
              inputs,
              target.data.promptDocument,
            )
          : videoPayload(
              snapshot,
              target.data.label,
              target.data.prompt,
              inputs,
              target.data.promptDocument,
            );
      const pendingPayload = videoJobPayloadSummary(contract, 'submitting', snapshot.modelAlias);
      // 记录必须先于合同落盘：记录失败时不写 submitting 标记，避免留下
      // 与供应商无法核对的任务状态。两者都在创建 POST 之前完成。
      // 未接线时不增加等待点，保持原有的同步推进到时序。
      if (onRequestPrompt) {
        await reportRequestPrompt({
          snapshot,
          provider: 'newapi',
          mediaType: 'video',
          requestIdentity: `POST ${videoCreatePath(contract)}#1`,
          onRequestPrompt,
          runId,
          attempt,
          format: 'plain',
          parts: [{ order: 0, text: sentPromptText(body) }],
          resources: videoPromptResources(body, inputs),
          // 只有真正写入创建体的负向字段才进入记录，画布上的编辑值不参与。
          negativeText: normalizeErrorField(
            body.negative_prompt ??
              body.negativePrompt ??
              (isRecord(body.metadata) && isRecord(body.metadata.input)
                ? body.metadata.input.negative_prompt
                : undefined),
          ),
        });
      }
      if (!onProviderJob) {
        throw new NewApiProviderError('创建视频前必须提供合同持久化回调', {
          code: 'VIDEO_CONTRACT_PERSISTENCE_REQUIRED',
          providerPayload: pendingPayload,
          retryable: false,
        });
      }
      try {
        await onProviderJob({
          provider: 'newapi',
          status: 'queued',
          progress: 0,
          payload: pendingPayload,
        });
      } catch {
        throw new NewApiProviderError('视频合同持久化失败', {
          code: 'VIDEO_CONTRACT_PERSISTENCE_FAILED',
          providerPayload: pendingPayload,
          retryable: false,
        });
      }
      throwIfProviderSignalAborted(signal);
      // 创建可能立即收费，响应丢失时不重发；稳定 key 不证明供应商支持去重。
      let submission: { payload: Record<string, unknown>; requestId?: string };
      try {
        submission = await this.requestJson(
          `${this.baseUrl}${videoCreatePath(contract)}`,
          'POST',
          body,
          idempotencyKey,
          signal,
          contract,
        );
      } catch (error) {
        // 已收到明确拒绝（无渠道、参数错误等）时任务未创建，直接展示供应商诊断。
        if (error instanceof NewApiProviderError && isDefiniteProviderRejection(error)) {
          throw error;
        }
        // 超时/网络/5xx 等可能已受理，禁止自动重建，但仍保留原始失败细节。
        if (!(error instanceof NewApiProviderError) || error.retryable) {
          const original =
            error instanceof NewApiProviderError
              ? error.message
              : error instanceof Error
                ? sanitizeProviderErrorMessage(error.message, [this.apiKey])
                : '供应商未返回具体错误说明。';
          throw new NewApiProviderError(
            `${original} New API 视频创建结果未知，请先核对平台任务状态；因无法确认任务是否已创建，不要立即重复提交。`,
            {
              status: error instanceof NewApiProviderError ? error.status : undefined,
              code: 'VIDEO_SUBMISSION_UNKNOWN',
              requestId: error instanceof NewApiProviderError ? error.requestId : undefined,
              providerPayload: pendingPayload,
              retryable: false,
            },
          );
        }
        throw error;
      }
      platformJobId = videoPlatformId(submission.payload, contract);
      requestId = submission.requestId;
      if (!platformJobId) {
        throw new NewApiProviderError(
          `New API 视频创建响应缺少 ${unified ? 'task_id' : openaiVideo ? 'id' : 'request_id'}`,
          {
            code: 'VIDEO_REQUEST_ID_MISSING',
            requestId: submission.requestId,
            providerPayload: pendingPayload,
            retryable: false,
          },
        );
      }
      let unifiedCreation: VideoPollResult | undefined;
      if (unified) {
        try {
          unifiedCreation = parseUnifiedVideoPollResult(submission.payload, [this.apiKey]);
        } catch (error) {
          throw videoJobError(
            error,
            platformJobId,
            videoJobPayloadSummary(
              contract,
              'submitted',
              snapshot.modelAlias,
              undefined,
              undefined,
              undefined,
              requestId,
            ),
            [this.apiKey],
          );
        }
      }
      const creationStatus = normalizeErrorField(
        submission.payload.status ??
          (isRecord(submission.payload.data) ? submission.payload.data.status : undefined),
      )?.toLowerCase();
      if (
        creationStatus &&
        ['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(creationStatus)
      ) {
        const terminal = unifiedCreation ?? parseVideoPollResult(submission.payload, [this.apiKey]);
        const providerPayload = videoJobPayloadSummary(
          contract,
          'failed',
          snapshot.modelAlias,
          terminal.providerStatus,
          terminal.progress,
        );
        throw new NewApiProviderError(
          videoTerminalFailureMessage(terminal, platformJobId, snapshot.modelAlias),
          {
            code:
              terminal.status === 'cancelled'
                ? 'VIDEO_GENERATION_CANCELLED'
                : 'VIDEO_GENERATION_FAILED',
            requestId: submission.requestId,
            platformJobId,
            providerPayload,
            retryable: false,
          },
        );
      }
      submissionUsage = parseProviderUsage(submission.payload);
      initialPhase = 'submitted';
    }
    const initialPayload = {
      ...videoJobPayloadSummary(contract, initialPhase, snapshot.modelAlias),
      ...(requestId ? { requestId } : {}),
    };
    const submittedProviderJob: ProviderJobUpdate = {
      provider: 'newapi',
      platformJobId,
      status: 'submitted',
      progress: Math.max(5, existingProviderJob?.progress ?? 0),
      payload: initialPayload,
    };
    try {
      await onProviderJob?.(submittedProviderJob);
    } catch (error) {
      throw new NewApiProviderError('视频平台任务 ID 持久化失败', {
        code: 'VIDEO_JOB_PERSISTENCE_FAILED',
        platformJobId,
        providerPayload: initialPayload,
        retryable: false,
      });
    }
    await reportVideoProgress(reportProgress, submittedProviderJob.progress ?? 5, platformJobId);
    throwIfProviderSignalAborted(signal, platformJobId);

    let lastPoll: VideoPollResult | undefined;
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      const waitMs = videoPollDelay(this.pollIntervalMs, attempt);
      if (waitMs > 0) await delay(waitMs, signal, platformJobId);
      try {
        const statusResponse = await this.requestJson(
          `${this.baseUrl}${jobsPath}/${encodeURIComponent(platformJobId)}`,
          'GET',
          undefined,
          undefined,
          signal,
        );
        const polledId = videoPlatformId(statusResponse.payload, contract);
        if (unified && polledId !== platformJobId) {
          throw new NewApiProviderError('New API 视频查询返回了不同的平台任务身份', {
            code: 'VIDEO_TASK_ID_MISMATCH',
            retryable: false,
          });
        }
        if (openaiVideo && polledId && polledId !== platformJobId) {
          throw new NewApiProviderError('New API 视频查询返回了不同的平台任务身份', {
            code: 'VIDEO_TASK_ID_MISMATCH',
            retryable: false,
          });
        }
        lastPoll = unified
          ? parseUnifiedVideoPollResult(statusResponse.payload, [this.apiKey])
          : parseVideoPollResult(statusResponse.payload, [this.apiKey]);
        requestId = statusResponse.requestId ?? requestId;
        throwIfProviderSignalAborted(signal, platformJobId);
        const statusPayload = videoJobPayloadSummary(
          contract,
          lastPoll.status === 'succeeded' ? 'completed' : 'polling',
          snapshot.modelAlias,
          lastPoll.providerStatus,
          lastPoll.status === 'succeeded' ? 100 : lastPoll.progress,
          lastPoll.mediaMetadata,
          requestId,
        );
        try {
          await onProviderJob?.({
            provider: 'newapi',
            platformJobId,
            status:
              lastPoll.status === 'failed'
                ? 'failed'
                : lastPoll.status === 'cancelled'
                  ? 'cancelled'
                  : lastPoll.status === 'pending'
                    ? 'submitted'
                    : 'running',
            progress: lastPoll.status === 'succeeded' ? 99 : lastPoll.progress,
            payload: statusPayload,
          });
        } catch {
          throw new NewApiProviderError('视频任务状态持久化失败', {
            code: 'VIDEO_JOB_PERSISTENCE_FAILED',
            platformJobId,
            providerPayload: statusPayload,
            retryable: false,
          });
        }
      } catch (error) {
        if (
          error instanceof NewApiProviderError &&
          error.retryable &&
          attempt < this.maxPollAttempts
        ) {
          continue;
        }
        throw videoJobError(
          error,
          platformJobId,
          videoJobPayloadSummary(
            contract,
            'polling',
            snapshot.modelAlias,
            lastPoll?.providerStatus,
            lastPoll?.progress,
          ),
          [this.apiKey],
        );
      }

      if (lastPoll.status === 'failed' || lastPoll.status === 'cancelled') {
        throw new NewApiProviderError(
          videoTerminalFailureMessage(lastPoll, platformJobId, snapshot.modelAlias),
          {
            code:
              lastPoll.status === 'cancelled'
                ? 'VIDEO_GENERATION_CANCELLED'
                : 'VIDEO_GENERATION_FAILED',
            platformJobId,
            providerPayload: videoJobPayloadSummary(
              contract,
              'failed',
              snapshot.modelAlias,
              lastPoll.providerStatus,
              lastPoll.progress,
            ),
            retryable: false,
          },
        );
      }

      if (lastPoll.status === 'succeeded') {
        let output: VideoProviderOutput;
        try {
          output = await this.videoOutput(platformJobId, lastPoll, signal, contract);
        } catch (error) {
          throw videoJobError(
            error,
            platformJobId,
            videoJobPayloadSummary(
              contract,
              'completed',
              snapshot.modelAlias,
              lastPoll.providerStatus,
              100,
            ),
            [this.apiKey],
          );
        }
        const usage = lastPoll.usage ?? submissionUsage;
        await reportVideoProgress(reportProgress, 100, platformJobId);
        throwIfProviderSignalAborted(signal, platformJobId);
        return {
          result: {
            provider: 'newapi',
            summary: `New API 已完成 ${target.data.label}`,
            targetNodeId: target.id,
            mediaType: 'video',
            inputCount: snapshot.inputs.length,
          },
          output,
          providerJob: {
            ...submittedProviderJob,
            status: 'succeeded',
            progress: 100,
            payload: videoJobPayloadSummary(
              contract,
              'completed',
              snapshot.modelAlias,
              lastPoll.providerStatus,
              100,
              lastPoll.mediaMetadata,
              requestId,
            ),
          },
          ...(usage ? { usage } : {}),
        };
      }

      const progress = Math.max(
        5,
        Math.min(95, lastPoll.progress || Math.round((attempt / this.maxPollAttempts) * 90)),
      );
      await reportVideoProgress(reportProgress, progress, platformJobId);
      throwIfProviderSignalAborted(signal, platformJobId);
    }

    throw new NewApiProviderError('New API 视频任务轮询超时', {
      code: 'VIDEO_POLL_TIMEOUT',
      platformJobId,
      providerPayload: videoJobPayloadSummary(
        contract,
        'polling',
        snapshot.modelAlias,
        lastPoll?.providerStatus,
        lastPoll?.progress,
      ),
      retryable: true,
    });
  }

  private async videoOutput(
    platformJobId: string,
    poll: VideoPollResult,
    signal?: AbortSignal,
    contract: FrozenVideoContract = 'legacy-v1',
  ): Promise<VideoProviderOutput> {
    throwIfProviderSignalAborted(signal, platformJobId);
    const rawUrl = poll.outputUrl;
    if (contract === 'newapi-unified-v1' && (!rawUrl || !providerRemoteUrl(rawUrl))) {
      throw new NewApiProviderError('New API 统一视频完成响应缺少有效资源 URL', {
        code: 'VIDEO_OUTPUT_URL_INVALID',
        retryable: false,
      });
    }
    if (rawUrl) {
      const dataUrl = parseDataUrl(rawUrl);
      if (dataUrl?.mimeType.startsWith('video/')) {
        const base64 = validatedMediaBase64(dataUrl.base64);
        if (atob(base64).length > this.maxContentBytes) {
          throw new NewApiProviderError('New API 视频内容超过归档大小限制', {
            code: 'VIDEO_CONTENT_TOO_LARGE',
            retryable: false,
          });
        }
        return {
          mediaType: 'video',
          kind: 'base64',
          base64,
          mimeType: dataUrl.mimeType,
          format: formatFromMimeType(dataUrl.mimeType),
        };
      }

      const remoteUrl = providerRemoteUrl(rawUrl);
      if (remoteUrl && !this.isProtectedProviderUrl(remoteUrl)) {
        const mimeType = poll.outputFormat
          ? videoMimeTypeFromFormat(poll.outputFormat)
          : videoMimeTypeFromUrl(remoteUrl);
        return {
          mediaType: 'video',
          kind: 'url',
          url: remoteUrl,
          mimeType,
          format: poll.outputFormat ?? formatFromMimeType(mimeType),
        };
      }
    }

    const contentUrl = this.protectedContentUrl(platformJobId, rawUrl);
    const content = await this.requestBinary(contentUrl, signal, platformJobId);
    return {
      mediaType: 'video',
      kind: 'base64',
      base64: bytesToBase64(content.bytes),
      mimeType: content.mimeType,
      format: formatFromMimeType(content.mimeType) ?? 'mp4',
    };
  }

  private protectedContentUrl(platformJobId: string, rawUrl?: string): string {
    if (rawUrl) {
      try {
        const resolved = new URL(rawUrl, `${this.baseUrl}/`);
        if (resolved.origin === new URL(this.baseUrl).origin) return resolved.toString();
      } catch {
        // Fall through to the canonical authenticated content endpoint.
      }
    }
    return `${this.baseUrl}${newApiVideoJobsPath}/${encodeURIComponent(platformJobId)}/content`;
  }

  private isProtectedProviderUrl(rawUrl: string): boolean {
    try {
      return new URL(rawUrl).origin === new URL(this.baseUrl).origin;
    } catch {
      return true;
    }
  }

  /** 在响应体读取完成前保留超时与取消监听，返回已解析的平台响应及请求 ID。 */
  private async requestJson(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    idempotencyKey?: string,
    externalSignal?: AbortSignal,
    contract: FrozenVideoContract = 'legacy-v1',
  ): Promise<{ payload: Record<string, unknown>; requestId?: string }> {
    throwIfProviderSignalAborted(externalSignal);
    return this.fetchResponse(
      url,
      {
        method,
        redirect: 'error',
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(method === 'POST' && idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
      },
      async (response, requestSignal) => {
        const payload = await readResponsePayload(response, this.maxResponseBytes, requestSignal);
        throwIfProviderSignalAborted(
          externalSignal,
          method === 'POST' && isRecord(payload) ? videoPlatformId(payload, contract) : undefined,
        );
        if (!response.ok)
          throw providerResponseError(
            response,
            payload,
            [this.apiKey],
            method === 'POST' ? '视频创建' : '视频查询',
          );
        if (!isRecord(payload) || isBinaryResponsePayload(payload)) {
          throw new NewApiProviderError('New API 视频响应不是有效 JSON', {
            requestId: responseRequestId(response, [this.apiKey]),
            retryable: false,
          });
        }
        return { payload, requestId: responseRequestId(response, [this.apiKey]) };
      },
      externalSignal,
    );
  }

  /** 在同一取消生命周期内下载受保护内容，禁止将明确的非视频 MIME 伪装为视频。 */
  private async requestBinary(
    url: string,
    externalSignal?: AbortSignal,
    platformJobId?: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    throwIfProviderSignalAborted(externalSignal, platformJobId);
    return this.fetchResponse(
      url,
      {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'video/*,*/*' },
      },
      async (response, requestSignal) => {
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > this.maxContentBytes) {
          discardResponseBody(response);
          throw new NewApiProviderError('New API 视频内容超过归档大小限制', {
            code: 'VIDEO_CONTENT_TOO_LARGE',
            retryable: false,
          });
        }
        const payload = await readResponsePayload(response, this.maxContentBytes, requestSignal);
        throwIfProviderSignalAborted(externalSignal, platformJobId);
        if (!response.ok) throw providerResponseError(response, payload, [this.apiKey], '视频下载');
        if (!isBinaryResponsePayload(payload) || payload.bytes.byteLength === 0) {
          throw new NewApiProviderError('New API 视频下载响应不包含二进制内容', {
            requestId: responseRequestId(response, [this.apiKey]),
            retryable: false,
          });
        }
        const mimeType = normalizedMimeType(payload.mimeType);
        if (mimeType && mimeType !== 'application/octet-stream' && !mimeType.startsWith('video/')) {
          throw new NewApiProviderError('New API 视频下载响应 MIME 类型不匹配', {
            code: 'VIDEO_CONTENT_TYPE_INVALID',
            retryable: false,
          });
        }
        return {
          bytes: payload.bytes,
          mimeType: mimeType?.startsWith('video/') ? mimeType : 'video/mp4',
        };
      },
      externalSignal,
    );
  }

  /** 覆盖响应头及消费响应体的完整 I/O 生命周期，统一脱敏传输异常。 */
  private async fetchResponse<Result>(
    url: string,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<Result>,
    externalSignal?: AbortSignal,
  ): Promise<Result> {
    const abortContext = createProviderAbortContext(this.timeoutMs, externalSignal);
    try {
      throwIfProviderSignalAborted(externalSignal);
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: abortContext.signal,
      });
      return await consume(response, abortContext.signal);
    } catch (error) {
      if (error instanceof NewApiProviderError) throw error;
      const isTimeout = getErrorName(error) === 'AbortError';
      if (abortContext.wasExternallyAborted()) {
        throw providerCancellationError();
      }
      throw new NewApiProviderError(
        isTimeout
          ? 'New API 请求超时'
          : error instanceof Error
            ? sanitizeProviderErrorMessage(error.message, [this.apiKey])
            : 'New API 请求失败',
        { code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true },
      );
    } finally {
      abortContext.cleanup();
    }
  }
}

/**
 * Keep local HTTP gateways usable in development/tests, but make production
 * secure by default even when a caller forgets to forward `requireHttps`.
 * An explicit `true` remains useful for staging and other non-production
 * environments; production cannot opt out of TLS through this option.
 */
function shouldRequireHttps(explicit: boolean | undefined): boolean {
  const processLike = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return explicit === true || processLike?.env?.NODE_ENV === 'production';
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }
  return resolved;
}

/**
 * 优先使用 Worker 已持久化的节点任务身份，回退键不包含提示词、凭据或媒体。
 * 这里只保证同一输入得到稳定请求键，不能证明供应商支持幂等或不会重复收费。
 */
function standardRequestIdempotencyKey(
  snapshot: RunSnapshot,
  providerJob: ProviderJobUpdate | undefined,
): string {
  const localJobId = providerJob?.id?.trim();
  if (localJobId && /^[A-Za-z0-9._:-]{1,200}$/.test(localJobId)) return localJobId;
  return `newapi-${stableIdempotencyHash(
    `${snapshot.projectId}\u0000${snapshot.targetNodeId}\u0000${snapshot.submittedAt}`,
  )}`;
}

function stableIdempotencyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} 必须是非负整数`);
  }
  return resolved;
}

/** Provider 请求的超时和调用方取消状态。 */
type ProviderAbortContext = {
  signal: AbortSignal;
  wasExternallyAborted: () => boolean;
  cleanup: () => void;
};

/**
 * 将调用方取消信号与 Provider 超时合并为一次请求生命周期。
 *
 * `AbortSignal.timeout()` 在部分 Node/浏览器版本中不可用，因此这里保留
 * 显式计时器；`wasExternallyAborted` 用于把用户取消与请求超时区分诊断。
 */
function createProviderAbortContext(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): ProviderAbortContext {
  const controller = new AbortController();
  let externallyAborted = false;
  const onExternalAbort = () => {
    if (controller.signal.aborted) return;
    externallyAborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    wasExternallyAborted: () => externallyAborted,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Provider 请求在调用方主动取消后使用的稳定、不可重试诊断。 */
function providerCancellationError(platformJobId?: string): NewApiProviderError {
  return new NewApiProviderError('New API 请求已取消', {
    code: 'ABORTED',
    ...(platformJobId ? { platformJobId } : {}),
    retryable: false,
  });
}

/** 在开始本地 I/O 前将调用方取消转为 Provider 可诊断错误。 */
function throwIfProviderSignalAborted(
  signal: AbortSignal | undefined,
  platformJobId?: string,
): void {
  if (signal?.aborted) throw providerCancellationError(platformJobId);
}

/** 本地进度回调失败必须保留已知平台身份，且不能触发重新创建上游任务。 */
async function reportVideoProgress(
  reportProgress: MockProviderRequest['reportProgress'],
  progress: number,
  platformJobId: string,
): Promise<void> {
  try {
    await reportProgress?.(progress);
  } catch {
    throw new NewApiProviderError('视频任务进度回调失败', {
      code: 'VIDEO_PROGRESS_FAILED',
      platformJobId,
      retryable: false,
    });
  }
}

/** 可由调用方取消的轮询等待，取消后不会开始下一次状态查询。 */
function delay(milliseconds: number, signal?: AbortSignal, platformJobId?: string): Promise<void> {
  throwIfProviderSignalAborted(signal, platformJobId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(providerCancellationError(platformJobId));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** 根据超时预算和退避间隔计算默认轮询次数；显式次数配置仍优先。 */
function defaultVideoPollAttempts(timeoutMs: number, pollIntervalMs: number): number {
  // 零间隔仅用于测试；给出有限次数，避免无限紧密轮询。
  if (pollIntervalMs === 0) return 120;
  let remainingMs = timeoutMs;
  let attempts = 0;
  for (let multiplier = 1; multiplier <= 3; multiplier += 1) {
    const count = Math.min(30, Math.ceil(remainingMs / (pollIntervalMs * multiplier)));
    attempts += count;
    remainingMs -= count * pollIntervalMs * multiplier;
    if (remainingMs <= 0) return attempts;
  }
  return attempts + Math.ceil(remainingMs / (pollIntervalMs * 4));
}

/** 每 30 次轮询递增等待间隔，最多为基础间隔的四倍。 */
function videoPollDelay(baseMilliseconds: number, attempt: number): number {
  if (baseMilliseconds === 0) return 0;
  const multiplier = Math.min(4, 1 + Math.floor((Math.max(1, attempt) - 1) / 30));
  return baseMilliseconds * multiplier;
}

/** 只保存明确合同、状态及数值型媒体元数据，不存储签名 URL 或原始响应。 */
function videoJobPayloadSummary(
  contract: FrozenVideoContract,
  phase: 'submitting' | 'submitted' | 'resumed' | 'polling' | 'completed' | 'failed',
  modelAlias: string,
  providerStatus?: string,
  progress?: number,
  mediaMetadata?: Record<string, number>,
  requestId?: string,
): Record<string, unknown> {
  return {
    contract,
    phase,
    modelAlias,
    ...(providerStatus ? { providerStatus } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(mediaMetadata ? { mediaMetadata } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/** 返回合同对应的查询/下载路径；统一协议使用单数 video/generations。 */
function videoJobsPath(contract: FrozenVideoContract): string {
  return contract === 'newapi-unified-v1' ? '/video/generations' : newApiVideoJobsPath;
}

/** 返回合同对应的创建路径；OpenAI 视频是 POST /videos，Sub2 才是 /videos/generations。 */
function videoCreatePath(contract: FrozenVideoContract): string {
  if (contract === 'newapi-unified-v1') return '/video/generations';
  if (contract === 'newapi-video-v1') return newApiVideoJobsPath;
  return newApiVideoCreatePath;
}

/** 按合同读取平台任务 ID；OpenAI 视频优先 id，统一协议只要顶层 task_id。 */
function videoPlatformId(
  payload: Record<string, unknown>,
  contract: FrozenVideoContract,
): string | undefined {
  if (contract === 'newapi-unified-v1') return normalizeErrorField(payload.task_id);
  if (contract === 'newapi-video-v1') return extractOpenAiVideoId(payload);
  return extractVideoRequestId(payload);
}

/** 优先使用冻结合同；无合同老平台 ID 只能沿旧查询路径恢复，未知合同失败关闭。 */
function resolveVideoContract(
  job: ProviderJobUpdate | undefined,
  selected: NewApiVideoContract,
): FrozenVideoContract {
  const frozen = job?.payload?.contract;
  if (isNewApiVideoContract(frozen)) return frozen;
  if (frozen !== undefined)
    throw new NewApiProviderError('已有视频任务的合同无法识别', {
      code: 'VIDEO_CONTRACT_UNSUPPORTED',
      platformJobId: job?.platformJobId,
      retryable: false,
    });
  return normalizeErrorField(job?.platformJobId) ? 'legacy-v1' : selected;
}

/** 官方通用视频 JSON 参数白名单；不把 legacy/Sora 或不明确的 metadata 映射进来。 */
function validateUnifiedVideoParameters(parameters: Record<string, unknown>): void {
  for (const [parameter, value] of Object.entries(parameters)) {
    if (value === undefined || parameter === 'inferenceStrength') continue;
    if (
      ![
        'prompt',
        'duration',
        'width',
        'height',
        'fps',
        'seed',
        'n',
        'response_format',
        'user',
      ].includes(parameter)
    ) {
      throw unsupportedProviderParameter('video', parameter);
    }
    if (parameter === 'n' || parameter === 'response_format') {
      if (value !== (parameter === 'n' ? 1 : 'url'))
        throw unsupportedProviderParameter('video', parameter);
    } else if (parameter === 'duration') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw invalidProviderParameter('video', parameter, '必须为正有限秒数');
    } else if (['width', 'height', 'fps', 'seed'].includes(parameter)) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        (parameter !== 'seed' && value <= 0)
      )
        throw invalidProviderParameter('video', parameter, '必须为合法整数');
    } else if (!nonEmptyString(value))
      throw invalidProviderParameter('video', parameter, '必须为非空字符串');
  }
}

/** 根据公开通用视频合同创建请求，首帧 image 是字符串，不能使用 Sora 的文件字段。 */
function unifiedVideoPayload(
  snapshot: RunSnapshot,
  label: string,
  prompt: string | undefined,
  inputs: VideoInputMapping,
  document?: PromptDocument,
): Record<string, unknown> {
  const resolvedPrompt = resolveRequiredVideoPrompt(
    snapshot,
    label,
    prompt,
    inputs.prompt,
    document,
  );
  if (!resolvedPrompt.trim()) throw invalidProviderParameter('video', 'prompt', '必须为非空字符串');
  const payload: Record<string, unknown> = { model: snapshot.modelAlias, prompt: resolvedPrompt };
  for (const parameter of [
    'duration',
    'width',
    'height',
    'fps',
    'seed',
    'n',
    'response_format',
    'user',
  ]) {
    if (snapshot.parameters[parameter] !== undefined)
      payload[parameter] = snapshot.parameters[parameter];
  }
  if (inputs.firstFrame) payload.image = inputImageUrl(inputs.firstFrame, 'video');
  applyGrokImagineVideo15References(payload, inputs, 'string');
  return payload;
}

/** 严格读取官方通用视频状态、URL、格式与数值元数据，拒绝混入其他协议的状态别名。 */
function parseUnifiedVideoPollResult(
  payload: Record<string, unknown>,
  sensitiveValues: readonly string[],
): VideoPollResult {
  const providerStatus = normalizeErrorField(payload.status);
  const statuses = {
    queued: 'pending',
    in_progress: 'running',
    completed: 'succeeded',
    failed: 'failed',
  } as const;
  if (!providerStatus || !Object.prototype.hasOwnProperty.call(statuses, providerStatus)) {
    throw new NewApiProviderError('New API 统一视频响应状态无法识别', {
      code: 'VIDEO_STATUS_UNKNOWN',
      retryable: false,
    });
  }
  const status = statuses[providerStatus as keyof typeof statuses];
  const outputFormat = normalizeErrorField(payload.format);
  if (payload.format !== undefined && !outputFormat)
    throw new NewApiProviderError('New API 统一视频输出格式无效', {
      code: 'VIDEO_OUTPUT_FORMAT_UNSUPPORTED',
      retryable: false,
    });
  if (outputFormat && !['mp4', 'webm', 'mov', 'm4v'].includes(outputFormat))
    throw new NewApiProviderError('New API 统一视频输出格式不受支持', {
      code: 'VIDEO_OUTPUT_FORMAT_UNSUPPORTED',
      retryable: false,
    });
  const mediaMetadata: Record<string, number> = {};
  if (isRecord(payload.metadata)) {
    for (const field of ['duration', 'width', 'height', 'fps', 'seed']) {
      const value = payload.metadata[field];
      if (typeof value === 'number' && Number.isFinite(value)) mediaMetadata[field] = value;
    }
  }
  const usage = parseProviderUsage(payload);
  const error = extractProviderError(payload, sensitiveValues).message;
  return {
    status,
    providerStatus,
    progress: status === 'succeeded' ? 100 : 0,
    payload,
    ...(nonEmptyString(payload.url) ? { outputUrl: payload.url.trim() } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(Object.keys(mediaMetadata).length ? { mediaMetadata } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
}

function videoPayload(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt?: string,
  inputs: VideoInputMapping = mapVideoInputs(snapshot),
  nodePromptDocument?: PromptDocument,
): Record<string, unknown> {
  const prompt = resolveRequiredVideoPrompt(
    snapshot,
    label,
    nodePrompt,
    inputs.prompt,
    nodePromptDocument,
  );
  const payload: Record<string, unknown> = {
    model: snapshot.modelAlias,
    prompt,
  };
  const firstFrameUrl = inputs.firstFrame ? inputImageUrl(inputs.firstFrame, 'video') : undefined;
  const parameters = snapshot.parameters;
  const duration = positiveIntegerParameter(
    parameters.duration ?? parameters.seconds ?? parameters.durationSeconds,
  );
  if (duration !== undefined) {
    payload.duration = duration;
  }
  const resolution = normalizeErrorField(
    parameters.resolution ?? parameters.video_resolution ?? parameters.videoResolution,
  );
  if (resolution) payload.resolution = resolution;
  const size = normalizeErrorField(
    parameters.size ?? parameters.video_size ?? parameters.videoSize,
  );
  if (size) payload.size = size;
  const quality = normalizeErrorField(
    parameters.quality ?? parameters.video_quality ?? parameters.videoQuality,
  );
  if (quality) payload.quality = quality;
  const aspectRatio = normalizeErrorField(parameters.aspect_ratio ?? parameters.aspectRatio);
  if (aspectRatio) payload.aspect_ratio = aspectRatio;
  if (firstFrameUrl) payload.image = { url: firstFrameUrl };
  applyGrokImagineVideo15References(payload, inputs, 'object');
  return payload;
}

/**
 * New API OpenAI 视频创建体：路径为 POST /videos。
 * duration 用数字（该网关已验证），seconds 用字符串避免 Go 把数字 seconds 反序列化失败；图生视频 image 为 URL 字符串。
 */
function openaiVideoPayload(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt?: string,
  inputs: VideoInputMapping = mapVideoInputs(snapshot),
  nodePromptDocument?: PromptDocument,
): Record<string, unknown> {
  if (
    ['minimax-h3', 'wan3', 'seedance-2', 'seedance-2.5'].includes(
      videoFamilyForModel(snapshot.modelAlias),
    )
  ) {
    return officialVideoPayload(snapshot, label, nodePrompt, inputs, nodePromptDocument);
  }
  const payload = videoPayload(snapshot, label, nodePrompt, inputs, nodePromptDocument);
  const duration = payload.duration;
  if (typeof duration === 'number') payload.seconds = String(duration);
  if (isRecord(payload.image) && nonEmptyString(payload.image.url)) {
    payload.image = payload.image.url.trim();
  }
  if (isRecord(payload.last_frame) && nonEmptyString(payload.last_frame.url)) {
    payload.last_frame = payload.last_frame.url.trim();
  }
  return payload;
}

/**
 * 将官方视频输入映射到 New API 任务插件协议；未知参数和不合法组合在 POST 前失败。
 * H3/Seedance 使用 metadata.content，Wan3 使用 metadata.input.media；角色不会互相降级。
 */
function officialVideoPayload(
  snapshot: RunSnapshot,
  label: string,
  prompt: string | undefined,
  inputs: VideoInputMapping,
  document?: PromptDocument,
): Record<string, unknown> {
  const family = videoFamilyForModel(snapshot.modelAlias);
  const parameters = snapshot.parameters;
  for (const key of [
    'size',
    'video_size',
    'videoSize',
    'quality',
    'video_quality',
    'videoQuality',
  ]) {
    if (parameters[key] !== undefined) throw unsupportedProviderParameter('video', key);
  }
  const resolvedPrompt = resolveRequiredVideoPrompt(
    snapshot,
    label,
    prompt,
    inputs.prompt,
    document,
  );
  const rawDuration = parameters.duration ?? parameters.seconds ?? parameters.durationSeconds;
  const duration = rawDuration === undefined ? undefined : Number(rawDuration);
  const minimum = family === 'wan3' ? 2 : 4;
  const maximum = family === 'wan3' || family === 'seedance-2.5' ? 30 : 15;
  if (
    duration !== undefined &&
    !(duration === -1 && family !== 'minimax-h3') &&
    (!Number.isSafeInteger(duration) || duration < minimum || duration > maximum)
  ) {
    throw invalidProviderParameter(
      'video',
      'duration',
      `必须为 ${minimum} 到 ${maximum} 的整数秒数${family === 'minimax-h3' ? '' : '，或 -1（自动）'}`,
    );
  }
  const rawResolution = normalizeErrorField(
    parameters.resolution ?? parameters.video_resolution ?? parameters.videoResolution,
  );
  const resolution = (rawResolution ?? (family === 'minimax-h3' ? '768P' : '720P')).toUpperCase();
  const resolutions =
    family === 'minimax-h3'
      ? ['768P', '2K']
      : family === 'seedance-2' && !/-(?:fast|mini)-/.test(snapshot.modelAlias ?? '')
        ? ['480P', '720P', '1080P', '4K']
        : family === 'seedance-2'
          ? ['480P', '720P']
          : ['480P', '720P', '1080P'];
  if (!resolutions.includes(resolution)) {
    throw invalidProviderParameter('video', 'resolution', `必须为 ${resolutions.join('、')}`);
  }
  const visual = Boolean(
    inputs.firstFrame || inputs.referenceImages.length || inputs.referenceVideos.length,
  );
  const ratio =
    normalizeErrorField(parameters.aspect_ratio ?? parameters.aspectRatio) ??
    (visual ? 'adaptive' : '16:9');
  const ratios = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'];
  if (family !== 'wan3') ratios.push('21:9');
  if (!ratios.includes(ratio) || (family === 'minimax-h3' && ratio === 'adaptive' && !visual)) {
    throw invalidProviderParameter(
      'video',
      'aspectRatio',
      `必须为 ${ratios.join('、')}${family === 'minimax-h3' ? '；adaptive 需要图片或视频参考' : ''}`,
    );
  }
  const mode = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId)?.data.videoMode;
  const requiresAdaptiveRatio =
    (family === 'wan3' && mode === 'video_extend') ||
    (family === 'seedance-2.5' &&
      (inputs.firstFrame || inputs.lastFrame || mode === 'video_edit' || mode === 'video_extend'));
  if (requiresAdaptiveRatio && ratio !== 'adaptive') {
    throw invalidProviderParameter(
      'video',
      'aspectRatio',
      '该模型的当前模式必须选择 adaptive（跟随原素材比例）',
    );
  }
  if (
    family === 'seedance-2.5' &&
    mode === 'video_edit' &&
    (duration !== -1 || ratio !== 'adaptive')
  ) {
    throw invalidProviderParameter(
      'video',
      'duration/aspectRatio',
      'Seedance 2.5 视频编辑需要 -1（自动时长）和 adaptive（跟随原视频）',
    );
  }
  const media = orderedVideoMedia(inputs).map((input) => {
    const mediaType = input.snapshot.data.mediaType;
    const role =
      input.role === 'firstFrame'
        ? 'first_frame'
        : input.role === 'lastFrame'
          ? 'last_frame'
          : `reference_${mediaType}`;
    const url = officialVideoReferenceUrl(input, family);
    return family === 'wan3'
      ? { type: role, url }
      : { type: `${mediaType}_url`, role, [`${mediaType}_url`]: { url } };
  });
  const payload: Record<string, unknown> = { model: snapshot.modelAlias, prompt: resolvedPrompt };
  if (duration !== undefined) {
    payload.seconds = String(duration);
    payload.duration = duration;
  }
  if (family === 'wan3') {
    const input: Record<string, unknown> = { media };
    if (inputs.negativePrompt)
      input.negative_prompt = inputTextValue(inputs.negativePrompt, 'video');
    payload.metadata = { input };
    payload.resolution = resolution;
    payload.ratio = ratio;
  } else {
    const metadata: Record<string, unknown> = {
      content: [{ type: 'text', text: resolvedPrompt }, ...media],
      resolution: family === 'minimax-h3' ? resolution : resolution.toLowerCase(),
      ratio,
    };
    if (
      family === 'seedance-2.5' &&
      ['omni_reference', 'video_edit', 'video_extend'].includes(mode ?? '')
    ) {
      metadata.omni_reference_task_type =
        mode === 'video_edit' ? 'edit' : mode === 'video_extend' ? 'extend' : 'reference';
    }
    payload.metadata = metadata;
  }
  return payload;
}

/** 按冻结输入顺序收集实际发送的帧和参考媒体，供请求与脱敏记录共用。 */
function orderedVideoMedia(inputs: VideoInputMapping): RunInputSnapshot[] {
  return [
    inputs.firstFrame,
    inputs.lastFrame,
    ...inputs.referenceImages,
    ...inputs.referenceVideos,
    ...inputs.referenceAudios,
  ]
    .filter((input): input is RunInputSnapshot => input !== undefined)
    .sort(
      (left, right) => left.sortOrder - right.sortOrder || left.nodeId.localeCompare(right.nodeId),
    );
}

/** 校验官方参考素材的媒体类型与传输方式；URL 由 Worker 按冻结版本提供。 */
function officialVideoReferenceUrl(input: RunInputSnapshot, family: string): string {
  const data = input.snapshot.data;
  const value = normalizeErrorField(data.contentUrl);
  const parsed = value ? parseDataUrl(value) : undefined;
  const mimeType = normalizedMimeType(data.mimeType);
  if (parsed) {
    if (
      !parsed.mimeType.startsWith(`${data.mediaType}/`) ||
      !isValidBase64(parsed.base64) ||
      (mimeType && mimeType !== parsed.mimeType)
    ) {
      throw inputRoleValueError('video', input.role, '与媒体类型匹配的有效内容');
    }
    if (
      (family === 'wan3' && data.mediaType !== 'image') ||
      (family.startsWith('seedance-') && data.mediaType === 'video')
    ) {
      throw new NewApiProviderError(
        '该官方模型的参考视频或音频需要外部可访问的素材地址，请配置 S3_PROVIDER_ENDPOINT',
        {
          code: 'VIDEO_REFERENCE_PUBLIC_URL_REQUIRED',
          retryable: false,
        },
      );
    }
    return value!;
  }
  const remote = value ? providerRemoteUrl(value) : undefined;
  if (!remote || (mimeType && !mimeType.startsWith(`${data.mediaType}/`))) {
    throw inputRoleValueError('video', input.role, '与媒体类型匹配的有效地址');
  }
  return remote;
}

/** 将画布中的时长参数规范化为视频接口接受的正整数秒数。 */
function positiveIntegerParameter(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function providerVideoReferenceUrl(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  const candidate = value.trim();
  const dataUrl = parseDataUrl(candidate);
  if (dataUrl?.mimeType.startsWith('image/') && isValidBase64(dataUrl.base64)) return candidate;
  return providerRemoteUrl(candidate);
}

/** OpenAI /v1/videos 创建与查询以顶层 id 为任务身份，其次才兼容 task_id / request_id。 */
function extractOpenAiVideoId(payload: Record<string, unknown>): string | undefined {
  const data = isRecord(payload.data) ? payload.data : undefined;
  for (const candidate of [
    payload.id,
    payload.task_id,
    data?.id,
    data?.task_id,
    payload.request_id,
    data?.request_id,
  ]) {
    const id = normalizeErrorField(candidate);
    if (id) return id;
  }
  return undefined;
}

function extractVideoRequestId(payload: Record<string, unknown>): string | undefined {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const video = isRecord(payload.video) ? payload.video : undefined;
  for (const candidate of [
    payload.request_id,
    payload.id,
    data?.request_id,
    data?.id,
    video?.request_id,
    video?.id,
    payload.task_id,
    data?.task_id,
    video?.task_id,
  ]) {
    const id = normalizeErrorField(candidate);
    if (id) return id;
  }
  return undefined;
}

/** 把供应商进度规范成 0-100 的整数；数字小数按比例换算，字符串按百分数或 0-100 原值读取。 */
function normalizeVideoProgress(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)));
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/%$/, ''));
    if (Number.isFinite(parsed)) {
      return Math.round(Math.max(0, Math.min(100, parsed)));
    }
  }
  return 0;
}

function videoTerminalFailureMessage(
  terminal: { error?: string; status: string; providerStatus?: string; progress?: number },
  platformJobId: string | undefined,
  modelAlias: string,
): string {
  if (terminal.error) return terminal.error;
  const kind = terminal.status === 'cancelled' ? '已取消' : '失败';
  const details = [
    terminal.providerStatus ? `status=${terminal.providerStatus}` : undefined,
    terminal.progress !== undefined ? `progress=${terminal.progress}` : undefined,
    modelAlias ? `model=${modelAlias}` : undefined,
    platformJobId ? `task=${platformJobId}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return details.length > 0
    ? `New API 视频任务${kind}（${details.join(', ')}）。供应商未返回失败原因。`
    : `New API 视频任务${kind}`;
}

function parseVideoPollResult(
  payload: Record<string, unknown>,
  sensitiveValues: readonly string[] = [],
): VideoPollResult {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const video = isRecord(payload.video)
    ? payload.video
    : data && isRecord(data.video)
      ? data.video
      : undefined;
  const providerStatus = normalizeErrorField(payload.status ?? data?.status)?.toLowerCase();
  if (!providerStatus) {
    throw new NewApiProviderError('New API 视频状态响应缺少 status', {
      code: 'VIDEO_STATUS_MISSING',
      retryable: true,
    });
  }

  const outputUrl = normalizeErrorField(
    video?.url ??
      payload.video_url ??
      payload.download_url ??
      payload.url ??
      data?.video_url ??
      data?.download_url ??
      data?.url,
  );
  const progress = normalizeVideoProgress(payload.progress ?? data?.progress);
  const errorDetails = extractProviderError(payload, sensitiveValues);
  const error =
    errorDetails.message ??
    sanitizeOptionalProviderErrorMessage(
      payload.failure_reason ?? data?.failure_reason ?? payload.reason,
      sensitiveValues,
    );
  const usage = parseProviderUsage(payload);

  if (['done', 'succeeded', 'completed'].includes(providerStatus)) {
    return {
      status: 'succeeded',
      providerStatus,
      progress: 100,
      payload,
      ...(outputUrl ? { outputUrl } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (['failed', 'error', 'expired'].includes(providerStatus)) {
    return {
      status: 'failed',
      providerStatus,
      progress,
      payload,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (['cancelled', 'canceled'].includes(providerStatus)) {
    return {
      status: 'cancelled',
      providerStatus,
      progress,
      payload,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (['pending', 'queued', 'submitted'].includes(providerStatus)) {
    return {
      status: 'pending',
      providerStatus,
      progress,
      payload,
      ...(usage ? { usage } : {}),
    };
  }
  if (['running', 'processing', 'in_progress'].includes(providerStatus)) {
    return {
      status: 'running',
      providerStatus,
      progress,
      payload,
      ...(usage ? { usage } : {}),
    };
  }
  throw new NewApiProviderError(`New API 返回未知视频状态：${providerStatus}`, {
    code: 'VIDEO_STATUS_UNKNOWN',
    retryable: true,
  });
}

/**
 * 把 HTTP 失败整理成可展示的中文诊断，保留状态码、错误代码、请求 ID 和供应商原文。
 */
function providerResponseError(
  response: Response,
  payload: unknown,
  sensitiveValues: readonly string[] = [],
  action = 'New API 请求',
): NewApiProviderError {
  const providerError = extractProviderError(payload, sensitiveValues);
  const requestId = providerError.requestId ?? responseRequestId(response, sensitiveValues);
  const definite = isDefiniteProviderRejection({
    status: response.status,
    code: providerError.code,
    message: providerError.message,
  });
  const extra = isNoAvailableChannel(providerError.code, providerError.message)
    ? '当前分组没有可用渠道，请在网关中为该模型配置渠道或更换分组/密钥。'
    : undefined;
  return new NewApiProviderError(
    formatDetailedProviderError({
      action,
      status: response.status,
      code: providerError.code,
      requestId,
      providerMessage: providerError.message,
      extra,
    }),
    {
      status: response.status,
      code: providerError.code,
      requestId,
      providerPayload: sanitizeProviderPayload(isRecord(payload) ? payload : { body: payload }),
      retryable: definite ? false : isRetryableStatus(response.status),
    },
  );
}

/**
 * 网关已明确拒绝请求（无渠道、参数错误、4xx），可以认定任务未创建。
 */
function isDefiniteProviderRejection(error: {
  status?: number;
  code?: string;
  message?: string;
}): boolean {
  if (isNoAvailableChannel(error.code, error.message)) return true;
  if (error.code === 'invalid_request_error' || error.code === 'invalid_request') return true;
  return (
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

/** 识别 New API “当前分组无渠道”诊断，避免被当成可重试的临时故障。 */
function isNoAvailableChannel(code?: string, message?: string): boolean {
  const haystack = `${code ?? ''} ${message ?? ''}`;
  return /model_not_found/i.test(haystack) || /no available channel/i.test(haystack);
}

/**
 * 组装给用户看的失败说明：动作、HTTP 状态、错误代码、供应商原文和请求 ID。
 */
function formatDetailedProviderError(options: {
  action: string;
  status?: number;
  code?: string;
  requestId?: string;
  providerMessage?: string;
  extra?: string;
}): string {
  const parts = [
    `${options.action}失败${options.status !== undefined ? `（HTTP ${options.status}）` : ''}。`,
  ];
  if (options.code) parts.push(`错误代码：${options.code}。`);
  parts.push(
    options.providerMessage
      ? `供应商返回：${options.providerMessage}`
      : '供应商未返回具体错误说明。',
  );
  if (options.requestId) parts.push(`请求 ID：${options.requestId}。`);
  if (options.extra) parts.push(options.extra);
  return parts.join(' ');
}

function videoJobError(
  error: unknown,
  platformJobId: string,
  providerPayload: Record<string, unknown>,
  sensitiveValues: readonly string[] = [],
): NewApiProviderError {
  if (error instanceof NewApiProviderError) {
    return new NewApiProviderError(sanitizeProviderErrorMessage(error.message, sensitiveValues), {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      platformJobId,
      providerPayload,
      retryable: error.retryable,
    });
  }
  return new NewApiProviderError(
    error instanceof Error
      ? sanitizeProviderErrorMessage(error.message, sensitiveValues)
      : 'New API 视频任务处理失败',
    {
      code: 'VIDEO_JOB_ERROR',
      platformJobId,
      providerPayload,
      retryable: false,
    },
  );
}

/** 将已验证的视频格式映射为 MIME，不依赖资源 URL 的扩展名或签名参数。 */
function videoMimeTypeFromFormat(format: string): string {
  if (format === 'webm') return 'video/webm';
  if (format === 'mov') return 'video/quicktime';
  if (format === 'm4v') return 'video/x-m4v';
  return 'video/mp4';
}

function videoMimeTypeFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.webm')) return 'video/webm';
    if (pathname.endsWith('.mov')) return 'video/quicktime';
    if (pathname.endsWith('.m4v')) return 'video/x-m4v';
  } catch {
    // The URL was already validated; use the interoperable default below.
  }
  return 'video/mp4';
}

type BinaryResponsePayload = {
  __newApiBinary: true;
  bytes: Uint8Array;
  mimeType?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeErrorField(value: unknown): string | undefined {
  return nonEmptyString(value) ? value.trim() : undefined;
}

const maxProviderErrorMessageLength = 2_000;
const redactedProviderErrorValue = '[REDACTED]';
const maxProviderPayloadDepth = 4;
const maxProviderPayloadKeys = 64;
const maxProviderPayloadItems = 32;
const maxProviderPayloadStringLength = 1_000;
const sensitiveProviderPayloadKey =
  /(?:authorization|proxy[-_ ]?authorization|x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|credential|cookie|session)/i;
const urlProviderPayloadKey = /(?:url|uri|href|location|download)/i;

/** Keep provider diagnostics bounded and free of credentials or signed URLs. */
function sanitizeProviderPayload(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > maxProviderPayloadDepth) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value).slice(0, maxProviderPayloadKeys)) {
      if (sensitiveProviderPayloadKey.test(key) || urlProviderPayloadKey.test(key)) continue;
      const sanitized = sanitizeProviderPayloadValue(raw, depth + 1, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return Object.keys(output).length > 0 ? output : undefined;
  } finally {
    seen.delete(value);
  }
}

function sanitizeProviderPayloadValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > maxProviderPayloadDepth) return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized || /^data:[^,]+,/i.test(normalized)) return undefined;
    return sanitizeProviderErrorMessage(normalized, [], maxProviderPayloadStringLength);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxProviderPayloadItems)
      .map((item) => sanitizeProviderPayloadValue(item, depth + 1, seen))
      .filter((item): item is string | number | boolean | Record<string, unknown> => {
        return item !== undefined;
      });
    return items.length > 0 ? items : undefined;
  }
  if (isRecord(value)) return sanitizeProviderPayload(value, depth, seen);
  return undefined;
}

/**
 * Provider and transport errors are untrusted input. Keep their useful text,
 * but never allow credentials, URL query strings, control characters, or an
 * unbounded response body to cross the Provider boundary.
 */
function sanitizeProviderErrorMessage(
  value: string,
  sensitiveValues: readonly string[] = [],
  maxLength = maxProviderErrorMessageLength,
): string {
  let message = value.trim() || 'New API 请求失败';

  message = redactUrlQueryAndFragment(message);
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) message = message.split(sensitiveValue).join(redactedProviderErrorValue);
  }

  message = message
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_ -]?token)\b\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,;}\]"']+/gi,
      `$1${redactedProviderErrorValue}`,
    )
    .replace(/\bBearer\s+[^\s,;}\]"']+/gi, `Bearer ${redactedProviderErrorValue}`)
    .replace(/\bsk[-_][A-Za-z0-9._-]{6,}\b/gi, redactedProviderErrorValue)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const truncationSuffix = '... [truncated]';
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - truncationSuffix.length)}${truncationSuffix}`;
}

function sanitizeOptionalProviderErrorMessage(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string | undefined {
  return sanitizeProviderDiagnosticField(value, sensitiveValues);
}

function sanitizeProviderDiagnosticField(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string | undefined {
  const field = normalizeErrorField(value);
  if (!field) return undefined;
  return sanitizeProviderErrorMessage(field, sensitiveValues, 512) || undefined;
}

function redactUrlQueryAndFragment(message: string): string {
  return message.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      if (!parsed.search && !parsed.hash && !parsed.username && !parsed.password) return rawUrl;
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      const queryIndex = rawUrl.search(/[?#]/);
      return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
    }
  });
}

/**
 * These statuses describe a transient transport/provider condition. This is
 * deliberately only classification: NewApiProvider never retries itself.
 */
function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

type ExtractedProviderError = {
  message?: string;
  code?: string;
  requestId?: string;
};

function extractProviderError(
  payload: unknown,
  sensitiveValues: readonly string[] = [],
): ExtractedProviderError {
  if (!isRecord(payload)) return {};
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const rawMessage =
    normalizeErrorField(nested?.message) ??
    (typeof payload.error === 'string' ? normalizeErrorField(payload.error) : undefined) ??
    normalizeErrorField(payload.message);
  const message = rawMessage
    ? sanitizeProviderErrorMessage(rawMessage, sensitiveValues)
    : undefined;
  const rawCode =
    normalizeErrorField(nested?.code) ??
    normalizeErrorField(nested?.type) ??
    normalizeErrorField(payload.code) ??
    normalizeErrorField(payload.type);
  const code = sanitizeProviderDiagnosticField(rawCode, sensitiveValues);
  const rawRequestId =
    normalizeErrorField(nested?.request_id) ??
    normalizeErrorField(nested?.requestId) ??
    normalizeErrorField(payload.request_id) ??
    normalizeErrorField(payload.requestId);
  const requestId = sanitizeProviderDiagnosticField(rawRequestId, sensitiveValues);
  return { message, code, requestId };
}

function responseRequestId(
  response: Response,
  sensitiveValues: readonly string[] = [],
): string | undefined {
  const headers = (response as Response & { headers?: Headers }).headers;
  for (const name of ['x-request-id', 'x-requestid', 'request-id', 'openai-request-id']) {
    const value = headers?.get?.(name);
    const requestId = sanitizeProviderDiagnosticField(value, sensitiveValues);
    if (requestId) return requestId;
  }
  return undefined;
}

function getErrorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === 'string' ? error.name : undefined;
}

function normalizedMimeType(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mimeType || undefined;
}

/**
 * 校验供应商声明的媒体 MIME 类型。
 *
 * 未声明或通用的 `application/octet-stream` 交由请求格式推断；一旦供应商
 * 明确声明了其他媒体类型，则必须与目标类型一致，避免错误内容被归档为图片
 * 或音频。发现跨媒体声明时抛出不可重试错误，让调用方保留诊断上下文。
 */
function validatedMediaMimeType(value: unknown, mediaType: 'image' | 'audio'): string | undefined {
  const mimeType = normalizedMimeType(value);
  if (!mimeType || mimeType === 'application/octet-stream') return undefined;
  if (!mimeType.startsWith(`${mediaType}/`)) {
    const label = mediaType === 'image' ? '图片' : '音频';
    throw new NewApiProviderError(`New API ${label}响应 MIME 类型与媒体类型不匹配`, {
      code: 'PROVIDER_OUTPUT_MIME_MISMATCH',
      retryable: false,
    });
  }
  return mimeType;
}

/** 解析内嵌数据地址；内容仍需由调用方执行 MIME 和 base64 校验。 */
function parseDataUrl(value: string): { base64: string; mimeType: string } | undefined {
  const match = /^data:([^;,\s]+)?;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match || !match[2]) return undefined;
  return {
    base64: match[2],
    mimeType: normalizedMimeType(match[1]) ?? 'application/octet-stream',
  };
}

/** 判断是否包含非空且可解码的标准 base64，禁止把 URL 或错误文本当作媒体归档。 */
function isValidBase64(value: string): boolean {
  try {
    return atob(value).length > 0;
  } catch {
    return false;
  }
}

/** 返回合法的内嵌媒体编码，否则在归档前给出不含原始内容的明确诊断。 */
function validatedMediaBase64(value: string): string {
  const normalized = value.trim();
  if (!isValidBase64(normalized)) {
    throw new NewApiProviderError('New API 媒体响应不包含有效 base64', {
      code: 'PROVIDER_OUTPUT_BASE64_INVALID',
      retryable: false,
    });
  }
  return normalized;
}

function providerRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function outputFormat(
  parameters: RunSnapshot['parameters'],
  ...values: unknown[]
): string | undefined {
  const candidate = [
    ...values,
    parameters.output_format,
    parameters.response_format,
    parameters.format,
  ]
    .filter((value): value is string => nonEmptyString(value))
    .map((value) => value.trim().toLowerCase())
    .find((value) => !['url', 'b64_json', 'base64', 'json'].includes(value));
  return candidate;
}

function imageMimeType(format?: string): string {
  switch (format?.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'png':
    default:
      return 'image/png';
  }
}

function audioMimeType(format?: string): string {
  switch (format?.toLowerCase()) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'pcm':
      return 'audio/pcm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

function formatFromMimeType(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/opus':
      return 'opus';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/webm':
      return 'webm';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/pcm':
      return 'pcm';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'video/quicktime':
      return 'mov';
    case 'video/x-m4v':
      return 'm4v';
    default:
      return undefined;
  }
}

function mimeTypeFromUrl(url: string, mediaType: 'image' | 'audio'): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
    const dot = filename.lastIndexOf('.');
    if (dot <= 0 || dot === filename.length - 1) return undefined;
    const extension = filename.slice(dot + 1);
    if (mediaType === 'image') {
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(extension)) return undefined;
      return imageMimeType(extension);
    }
    if (
      !['mp3', 'wav', 'opus', 'aac', 'flac', 'ogg', 'oga', 'webm', 'pcm', 'm4a', 'mp4'].includes(
        extension,
      )
    ) {
      return undefined;
    }
    return audioMimeType(extension);
  } catch {
    return undefined;
  }
}

const usageAmountKeys = [
  'amount',
  'cost',
  'total_cost',
  'totalCost',
  'cost_amount',
  'costAmount',
] as const;

const usageCurrencyKeys = [
  'currency',
  'cost_currency',
  'costCurrency',
  'currency_code',
  'currencyCode',
] as const;

type UsageAmountCandidate = {
  value: unknown;
  currency?: unknown;
};

/**
 * Extracts provider-reported usage without estimating a price locally.
 *
 * The raw usage object is copied into metadata so token/media counters remain
 * available for reconciliation. A billable amount is emitted only when both
 * an explicitly named monetary field and a valid three-letter currency are
 * present in the same response.
 */
function parseProviderUsage(payload: unknown): ProviderUsage | undefined {
  if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, 'usage')) {
    return undefined;
  }

  const rawUsage = payload.usage;
  const usageRecord = isRecord(rawUsage) ? rawUsage : undefined;
  const metadata = usageRecord ? { ...usageRecord } : { raw: rawUsage };
  const candidate = usageRecord ? findUsageAmount(usageRecord) : undefined;
  const amount = normalizeUsageAmount(candidate?.value);
  const currency = normalizeUsageCurrency(
    candidate?.currency ??
      (usageRecord ? firstDefined(usageCurrencyKeys.map((key) => usageRecord[key])) : undefined) ??
      firstDefined(usageCurrencyKeys.map((key) => payload[key])),
  );

  // Do not persist an amount without an explicit, verifiable currency. In
  // particular, token counts and image dimensions are never treated as cost.
  if (amount === undefined || currency === undefined) {
    return { metadata };
  }
  return { amount, currency, metadata };
}

function findUsageAmount(record: Record<string, unknown>): UsageAmountCandidate | undefined {
  for (const key of usageAmountKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (isRecord(value)) {
      const nestedValue = firstDefined([
        value.amount,
        value.value,
        value.cost,
        value.total_cost,
        value.totalCost,
      ]);
      if (nestedValue !== undefined) {
        return {
          value: nestedValue,
          currency: firstDefined(usageCurrencyKeys.map((currencyKey) => value[currencyKey])),
        };
      }
    }
    return { value };
  }
  return undefined;
}

function firstDefined(values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeUsageAmount(value: unknown): number | string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const serialized = String(value);
    return /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(serialized) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const amount = value.trim();
  // Keep the provider's decimal representation intact for precise ledger
  // persistence; reject exponent notation and negative/empty values.
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(amount)) return undefined;
  return amount;
}

function normalizeUsageCurrency(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function parseTextOutput(payload: unknown): Extract<ProviderOutput, { kind: 'text' }> {
  if (!isRecord(payload)) {
    throw new NewApiProviderError('New API 文本响应缺少 choices[0] 内容');
  }

  // Keep Chat Completions as the canonical contract. Only fall back to the
  // explicitly named Responses envelopes when `choices` is absent, so a
  // malformed standard response cannot be silently reinterpreted.
  let content: string | undefined;
  if ('choices' in payload) {
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      throw new NewApiProviderError('New API 文本响应缺少 choices[0] 内容');
    }
    const choice = payload.choices[0];
    if (!isRecord(choice)) throw new NewApiProviderError('New API 文本响应格式无效');
    const message = isRecord(choice.message) ? choice.message.content : undefined;
    content =
      extractTextContent(message) ?? (nonEmptyString(choice.text) ? choice.text : undefined);
  } else {
    content = nonEmptyString(payload.output_text)
      ? payload.output_text
      : extractResponsesText(payload.output);
  }

  if (content === undefined || content.trim().length === 0) {
    throw new NewApiProviderError('New API 文本响应内容为空');
  }
  return {
    mediaType: 'text',
    kind: 'text',
    text: content,
    mimeType: 'text/plain',
    format: 'txt',
  };
}

function extractResponsesText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === 'output_text' && nonEmptyString(item.text)) {
      parts.push(item.text);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && nonEmptyString(part.text)) {
        parts.push(part.text);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function extractTextContent(value: unknown): string | undefined {
  if (nonEmptyString(value)) return value;
  if (isRecord(value) && nonEmptyString(value.text)) return value.text;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => {
      if (nonEmptyString(part)) return part;
      if (isRecord(part) && nonEmptyString(part.text)) return part.text;
      return undefined;
    })
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join('') : undefined;
}

function parseImageOutput(payload: unknown, snapshot: RunSnapshot): ImageProviderOutput {
  const item = firstMediaItem(payload);
  if (!item) throw new NewApiProviderError('New API 图片响应缺少 data[0] 内容');

  // New API's image gateway returns `output_format` alongside `data`, while
  // other OpenAI-compatible gateways put the same metadata on data[0]. Keep
  // the response-level value first so the persisted MIME type matches the
  // bytes actually returned by the provider.
  const response = isRecord(payload) ? payload : undefined;
  const format = outputFormat(
    snapshot.parameters,
    response?.output_format,
    response?.outputFormat,
    response?.format,
    item.format,
    item.output_format,
    item.outputFormat,
  );
  const explicitMimeType = validatedMediaMimeType(
    response?.mime_type ??
      response?.mimeType ??
      response?.content_type ??
      response?.contentType ??
      item.mime_type ??
      item.mimeType ??
      item.content_type ??
      item.contentType,
    'image',
  );
  const mimeType = explicitMimeType ?? imageMimeType(format);
  const imageUrlValue = item.url ?? item.image_url ?? item.imageUrl;
  const imageDataValue = item.data;
  const imageDataUrl =
    typeof imageDataValue === 'string' && /^https?:\/\//i.test(imageDataValue.trim())
      ? imageDataValue
      : undefined;
  const url =
    (isRecord(imageUrlValue) ? imageUrlValue.url : imageUrlValue) ?? imageDataUrl ?? undefined;
  if (nonEmptyString(url)) {
    const dataUrl = parseDataUrl(url);
    if (dataUrl) {
      const dataUrlMimeType = validatedMediaMimeType(dataUrl.mimeType, 'image');
      return {
        mediaType: 'image',
        kind: 'base64',
        base64: validatedMediaBase64(dataUrl.base64),
        mimeType: dataUrlMimeType ?? mimeType,
        format: format ?? formatFromMimeType(dataUrl.mimeType),
      };
    }
    const safeUrl = providerRemoteUrl(url);
    if (safeUrl) {
      const urlMimeType = mimeTypeFromUrl(safeUrl, 'image');
      return {
        mediaType: 'image',
        kind: 'url',
        url: safeUrl,
        mimeType: explicitMimeType ?? (format ? imageMimeType(format) : (urlMimeType ?? mimeType)),
        format: format ?? formatFromMimeType(urlMimeType),
      };
    }
  }

  const base64 = item.b64_json ?? item.b64Json ?? item.base64 ?? item.data;
  if (nonEmptyString(base64)) {
    const dataUrl = parseDataUrl(base64);
    const dataUrlMimeType = dataUrl ? validatedMediaMimeType(dataUrl.mimeType, 'image') : undefined;
    return {
      mediaType: 'image',
      kind: 'base64',
      base64: validatedMediaBase64(dataUrl?.base64 ?? base64),
      mimeType: dataUrlMimeType ?? mimeType,
      format: format ?? formatFromMimeType(dataUrl?.mimeType),
    };
  }
  throw new NewApiProviderError('New API 图片响应缺少 url 或 base64 内容');
}

function parseAudioOutput(payload: unknown, snapshot: RunSnapshot): AudioProviderOutput {
  const requestedFormat = outputFormat(snapshot.parameters);
  if (isBinaryResponsePayload(payload)) {
    if (payload.bytes.byteLength === 0) {
      throw new NewApiProviderError('New API 音频响应内容为空');
    }
    const detectedMimeType = validatedMediaMimeType(payload.mimeType, 'audio');
    const mimeType =
      detectedMimeType && detectedMimeType !== 'application/octet-stream'
        ? detectedMimeType
        : audioMimeType(requestedFormat);
    return {
      mediaType: 'audio',
      kind: 'base64',
      base64: bytesToBase64(payload.bytes),
      mimeType,
      format: formatFromMimeType(mimeType) ?? requestedFormat,
    };
  }

  const item = firstMediaItem(payload) ?? (isRecord(payload) ? payload : undefined);
  if (!item) throw new NewApiProviderError('New API 音频响应格式无效');
  const format = outputFormat(snapshot.parameters, item.format, item.output_format);
  const mimeType =
    validatedMediaMimeType(
      item.mime_type ?? item.mimeType ?? item.content_type ?? item.contentType,
      'audio',
    ) ?? audioMimeType(format);
  const audioUrlValue = item.url ?? item.audio_url ?? item.audioUrl;
  const audioDataValue = item.data;
  const audioDataUrl =
    typeof audioDataValue === 'string' && /^https?:\/\//i.test(audioDataValue.trim())
      ? audioDataValue
      : undefined;
  const url =
    (isRecord(audioUrlValue) ? audioUrlValue.url : audioUrlValue) ?? audioDataUrl ?? undefined;
  if (nonEmptyString(url)) {
    const dataUrl = parseDataUrl(url);
    if (dataUrl) {
      const dataUrlMimeType = validatedMediaMimeType(dataUrl.mimeType, 'audio');
      return {
        mediaType: 'audio',
        kind: 'base64',
        base64: validatedMediaBase64(dataUrl.base64),
        mimeType: dataUrlMimeType ?? mimeType,
        format: format ?? formatFromMimeType(dataUrl.mimeType),
      };
    }
    const safeUrl = providerRemoteUrl(url);
    if (safeUrl) {
      return {
        mediaType: 'audio',
        kind: 'url',
        url: safeUrl,
        mimeType:
          validatedMediaMimeType(
            item.mime_type ?? item.mimeType ?? item.content_type ?? item.contentType,
            'audio',
          ) ??
          mimeTypeFromUrl(safeUrl, 'audio') ??
          mimeType,
        format: format ?? formatFromMimeType(mimeTypeFromUrl(safeUrl, 'audio')),
      };
    }
  }

  const base64 = item.b64_json ?? item.b64Json ?? item.base64 ?? item.audio ?? item.data;
  if (nonEmptyString(base64)) {
    const dataUrl = parseDataUrl(base64);
    const dataUrlMimeType = dataUrl ? validatedMediaMimeType(dataUrl.mimeType, 'audio') : undefined;
    return {
      mediaType: 'audio',
      kind: 'base64',
      base64: validatedMediaBase64(dataUrl?.base64 ?? base64),
      mimeType: dataUrlMimeType ?? mimeType,
      format: format ?? formatFromMimeType(dataUrl?.mimeType),
    };
  }
  throw new NewApiProviderError('New API 音频响应缺少 url 或 base64 内容');
}

/** 单输出运行不允许静默丢弃供应商返回的多项媒体。 */
function firstMediaItem(payload: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(payload)) {
    assertSingleMediaResult(payload);
    const first = payload[0];
    if (isRecord(first)) return first;
    if (nonEmptyString(first)) return { data: first };
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  for (const key of ['data', 'images', 'output', 'results']) {
    const collection = payload[key];
    if (Array.isArray(collection)) {
      assertSingleMediaResult(collection);
      const first = collection[0];
      if (isRecord(first)) return first;
      if (nonEmptyString(first)) return { data: first };
    }
  }
  return payload;
}

/** 生成结果目前只有一个归档槽位，多项响应必须交由调用方明确处理。 */
function assertSingleMediaResult(items: unknown[]): void {
  if (items.length > 1) {
    throw new NewApiProviderError('New API 返回多个媒体结果，当前运行仅支持单项归档', {
      code: 'PROVIDER_OUTPUT_CARDINALITY_UNSUPPORTED',
      retryable: false,
    });
  }
}

function isBinaryResponsePayload(value: unknown): value is BinaryResponsePayload {
  return isRecord(value) && value.__newApiBinary === true && value.bytes instanceof Uint8Array;
}

function bytesToBase64(bytes: Uint8Array): string {
  // `btoa` is available in browsers but not in all Node runtimes. Buffer is
  // intentionally accessed through the global value to keep this package
  // usable in both environments without a Node-only import.
  const bufferCtor = (
    globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }
  ).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 有界读取 JSON 或媒体内容；取消信号涵盖响应体，不仅涵盖响应头。 */
async function readResponsePayload(
  response: Response,
  maxBytes = defaultResponseContentLimit,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers = (response as Response & { headers?: Headers }).headers;
  const mimeType = normalizedMimeType(headers?.get?.('content-type'));
  const declaredLength = Number(headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    discardResponseBody(response);
    throw new NewApiProviderError('New API 响应超过大小限制', {
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  if (typeof response.arrayBuffer !== 'function') {
    return withResponseAbort(() => response.json(), signal);
  }
  const bytes = await readResponseBytes(response, maxBytes, signal);
  const text = new TextDecoder().decode(bytes);
  const looksLikeJson =
    mimeType?.includes('json') || /^[\s]*[\[{]/.test(text) || text.trim() === '';
  if (looksLikeJson) {
    try {
      if (text.trim() === '') return {};
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'string' ? { data: parsed } : parsed;
    } catch {
      if (mimeType?.includes('json')) return {};
    }
  }
  return { __newApiBinary: true, bytes, mimeType } satisfies BinaryResponsePayload;
}

/**
 * 清理已经拒绝的响应；底层取消失败不得覆盖原始诊断或阻塞错误返回。
 * 此操作只释放本地流，不代表远程任务已取消。
 */
function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * 将读取操作绑定到请求信号；使用稳定 AbortError，避免泄露调用方的取消原因。
 * 无论操作还是取消先完成，均移除监听，底层操作晚到的异常也有处理器。
 */
async function withResponseAbort<Value>(
  operation: () => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (!signal) return operation();
  if (signal.aborted) throw new DOMException('Provider response aborted', 'AbortError');
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Provider response aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 逐块执行大小限制及取消检查；失败时释放读取锁并异步关闭底层流。 */
async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await withResponseAbort(() => reader.read(), signal);
        if (next.done) break;
        const chunk = next.value;
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new NewApiProviderError('New API 响应超过大小限制', {
            code: 'RESPONSE_TOO_LARGE',
            retryable: false,
          });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  const bytes = new Uint8Array(await withResponseAbort(() => response.arrayBuffer(), signal));
  if (bytes.byteLength > maxBytes) {
    throw new NewApiProviderError('New API 响应超过大小限制', {
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  return bytes;
}

/**
 * 读取即将发送的请求体里的主提示词字段。
 *
 * Provider 自己组装的请求体一定包含该字段；缺失说明组装与记录逻辑不一致，
 * 必须在发送前明确失败，而不是记录一个推测值。
 */
function sentPromptText(body: Record<string, unknown> | FormData): string {
  const value = body instanceof FormData ? body.get('prompt') : body.prompt;
  if (typeof value !== 'string') throw new TypeError('New API 请求体缺少可记录的提示词字段');
  return value;
}

/** 聊天消息里的内联媒体；文本块不占用资源身份。 */
type ChatMediaPart = Exclude<ChatContentPart, { type: 'text' }>;

/**
 * 聊天消息里的内联媒体在端口语义上最接近的引用角色。
 * 消息本身没有画布端口，这里只按供应商内容类型归类，不改变实际发送字段。
 */
function chatMediaPartRole(part: ChatMediaPart): PortRole {
  if (part.type === 'image_url') return 'referenceImage';
  if (part.type === 'input_audio') return 'audioTrack';
  return 'content';
}

/**
 * 从实际发送的 Chat Completions 消息派生请求文本。
 *
 * 一条消息对应一个文本块，顺序即消息顺序；数组内容只拼接 `type: 'text'` 块，
 * 提示词媒体与连线媒体分别按实际发送顺序对应冻结输入，只保留资产身份与版本。
 */
function textRequestPromptCapture(
  snapshot: RunSnapshot,
  messages: readonly {
    role: 'user';
    name?: string;
    content: string | ChatContentPart[];
  }[],
): { parts: RequestPromptPart[]; resources: RequestPromptResource[] } {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  const mentions =
    target?.data.promptDocument?.blocks.filter(
      (block) => block.type === 'mention' && block.mediaType !== 'text',
    ) ?? [];
  const inputs = orderedRunInputs(snapshot);
  const parts: RequestPromptPart[] = [];
  const resources: RequestPromptResource[] = [];
  let mentionIndex = 0;
  let inputIndex = 0;
  messages.forEach((message, order) => {
    const input = message.name ? inputs[inputIndex++] : undefined;
    const content = message.content;
    parts.push({
      order,
      role: message.role,
      ...(message.name ? { name: message.name } : {}),
      text: Array.isArray(content)
        ? content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        : content,
    });
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (part.type === 'text') continue;
      if (input) {
        const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
        resources.push({
          ...(assetId ? { assetId } : {}),
          ...(input.sourceAssetVersion ? { assetVersion: input.sourceAssetVersion } : {}),
          role: input.role,
          sortOrder: resources.length,
          mediaType: input.snapshot.data.mediaType,
        });
        continue;
      }
      const mention = mentions[mentionIndex];
      mentionIndex += 1;
      if (!mention || mention.type !== 'mention') continue;
      const frozen = snapshot.promptMentions?.find(
        (candidate) =>
          (candidate.nodeId ?? snapshot.targetNodeId) === snapshot.targetNodeId &&
          candidate.mentionId === mention.mentionId,
      );
      const assetVersion = frozen?.assetVersion ?? mention.assetVersion;
      resources.push({
        assetId: mention.assetId,
        ...(assetVersion ? { assetVersion } : {}),
        role: chatMediaPartRole(part),
        sortOrder: resources.length,
        mediaType: mention.mediaType,
      });
    }
  });
  return { parts, resources };
}

/**
 * 把实际发送的原图记录为参考资源身份。
 *
 * 只保存快照里已冻结的资产 ID 与版本；输入缺少资产身份时保留角色与顺序，
 * 绝不从 data URL、文件名或节点当前编辑状态推断身份。
 */
function imagePromptResources(images: readonly ImageSourceInput[]): RequestPromptResource[] {
  return images.map((input, sortOrder) => {
    const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
    const assetVersion = input.assetVersion;
    return {
      ...(assetId ? { assetId } : {}),
      ...(assetVersion ? { assetVersion } : {}),
      role: input.role,
      sortOrder,
      mediaType: 'image',
    };
  });
}

/**
 * 把视频创建体里真正携带的媒体记录为参考资源身份。
 *
 * 只记录请求体实际出现的帧、参考图片、视频和音频；被预检丢弃或未映射的输入
 * 不会因为出现在快照里就被写进记录。
 */
function videoPromptResources(
  body: Record<string, unknown>,
  inputs: VideoInputMapping,
): RequestPromptResource[] {
  const resources: RequestPromptResource[] = [];
  const add = (input: RunInputSnapshot | undefined) => {
    if (!input) return;
    const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
    resources.push({
      ...(assetId ? { assetId } : {}),
      ...(input.sourceAssetVersion ? { assetVersion: input.sourceAssetVersion } : {}),
      role: input.role,
      sortOrder: resources.length,
      mediaType: input.snapshot.data.mediaType,
    });
  };
  if (
    isRecord(body.metadata) &&
    (Array.isArray(body.metadata.content) ||
      (isRecord(body.metadata.input) && Array.isArray(body.metadata.input.media)))
  ) {
    for (const input of orderedVideoMedia(inputs)) add(input);
    return resources;
  }
  if (body.image !== undefined) add(inputs.firstFrame);
  if (body.last_frame !== undefined) add(inputs.lastFrame);
  if (Array.isArray(body.reference_images) && body.reference_images.length > 0) {
    for (const input of inputs.referenceImages) add(input);
  }
  return resources;
}

/**
 * Remove application-only fields before crossing the provider boundary.
 * `inferenceStrength` is intentionally translated only for chat models:
 * image, audio and video endpoints use different option sets and commonly
 * reject unknown reasoning fields.
 */
function providerParameters(
  parameters: Record<string, unknown>,
  mediaType: 'text' | 'image' | 'audio',
): Record<string, unknown> {
  if (mediaType !== 'text') validateMediaParameters(parameters, mediaType);
  const {
    inferenceStrength,
    prompt: _prompt,
    // `input` 是 provider-neutral 的音频提示词别名，会在下方映射到接口字段，不能重复透传。
    input: _input,
    ...providerParameters
  } = parameters;
  if (
    mediaType === 'text' &&
    typeof inferenceStrength === 'string' &&
    inferenceStrength.trim().length > 0
  ) {
    providerParameters.reasoning_effort = inferenceStrength.trim();
  }
  if (mediaType === 'image') {
    // 兼容旧画布中的 `resolution`/`imageSize`，统一映射到兼容接口的图片 `size` 字段。
    const size = normalizeErrorField(
      parameters.size ?? parameters.image_size ?? parameters.imageSize ?? parameters.resolution,
    );
    if (size) providerParameters.size = size;
    const quality = normalizeErrorField(
      parameters.quality ?? parameters.image_quality ?? parameters.imageQuality,
    );
    if (quality) providerParameters.quality = quality;
    const aspectRatio = normalizeErrorField(parameters.aspect_ratio ?? parameters.aspectRatio);
    if (aspectRatio) providerParameters.aspect_ratio = aspectRatio;
    delete providerParameters.image_size;
    delete providerParameters.imageSize;
    delete providerParameters.resolution;
    delete providerParameters.image_quality;
    delete providerParameters.imageQuality;
    delete providerParameters.aspectRatio;
  }
  return providerParameters;
}

/**
 * Input roles belong to the canvas graph, not to the untyped provider
 * parameter bag. A role-shaped parameter would otherwise be serialized as an
 * undocumented top-level field (or silently disappear during JSON encoding),
 * which makes the role impossible to diagnose and can produce different
 * behavior across gateways. Prompt is intentionally excluded because it is
 * mapped to the endpoint's primary prompt/input field above.
 */
function validateProviderRoleParameters(
  parameters: Record<string, unknown>,
  mediaType: MediaType,
): void {
  for (const role of providerRoleParameterKeys) {
    if (!Object.prototype.hasOwnProperty.call(parameters, role)) continue;
    const value = parameters[role];
    if (mediaType === 'image' && role === 'style' && (value === 'vivid' || value === 'natural'))
      continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    throw unsupportedInputRoleError(mediaType, role);
  }
  for (const parameter of undocumentedReferenceParameters) {
    if (parameters[parameter] !== undefined && parameters[parameter] !== null) {
      throw unsupportedProviderParameter(mediaType, parameter);
    }
  }
}

/** 未确认的参考参数别名不能绕过图端口校验或静默降级。 */
const undocumentedReferenceParameters = [
  'reference_images',
  'referenceImages',
  'reference_image',
  'referenceImage',
  'negative_prompt',
  'first_frame',
  'last_frame',
  'audio_track',
  'input_reference',
  'image',
  'images',
  'image_url',
  'image_urls',
  'audio',
  'video',
] as const;

/** 已有映射及公开图像/TTS 契约的参数边界；不意味着所有模型支持全部选项。 */
const supportedMediaParameters: Record<'image' | 'audio' | 'video', readonly string[]> = {
  image: [
    'prompt',
    'inferenceStrength',
    'size',
    'image_size',
    'imageSize',
    'resolution',
    'quality',
    'image_quality',
    'imageQuality',
    'aspect_ratio',
    'aspectRatio',
    'n',
    'style',
    'response_format',
    'output_format',
    'background',
    'moderation',
    'user',
    'stream',
  ],
  audio: ['prompt', 'input', 'inferenceStrength', 'voice', 'response_format', 'speed'],
  video: [
    'prompt',
    'inferenceStrength',
    'duration',
    'seconds',
    'durationSeconds',
    'resolution',
    'video_resolution',
    'videoResolution',
    'size',
    'video_size',
    'videoSize',
    'quality',
    'video_quality',
    'videoQuality',
    'aspect_ratio',
    'aspectRatio',
  ],
};

/** 返回非重试的未知契约诊断，只包含字段名，不包含输入值或媒体内容。 */
function unsupportedProviderParameter(
  mediaType: MediaType,
  parameter: string,
): NewApiProviderError {
  return new NewApiProviderError(`New API ${mediaType} 尚不支持参数：${parameter}`, {
    code: 'UNSUPPORTED_PROVIDER_PARAMETER',
    retryable: false,
  });
}

/** 返回字段范围或类型错误；约束描述由本地代码提供，不拼接不可信输入值。 */
function invalidProviderParameter(
  mediaType: MediaType,
  parameter: string,
  constraint: string,
): NewApiProviderError {
  return new NewApiProviderError(`New API ${mediaType} 参数 ${parameter} ${constraint}`, {
    code: 'INVALID_PROVIDER_PARAMETER',
    retryable: false,
  });
}

/**
 * 在生成或恢复前拒绝未知参数、类型错误及无法归档的多输出/流式模式。
 * 图像结果当前仅承载一项；TTS voice 必须显式配置，不猜测默认音色。
 */
function validateMediaParameters(
  parameters: Record<string, unknown>,
  mediaType: 'image' | 'audio' | 'video',
  automaticVideoDuration = false,
): void {
  for (const [parameter, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if (!supportedMediaParameters[mediaType].includes(parameter))
      throw unsupportedProviderParameter(mediaType, parameter);
    if (parameter === 'inferenceStrength') continue;
    if (parameter === 'n') {
      if (value !== 1) throw unsupportedProviderParameter(mediaType, parameter);
    } else if (parameter === 'stream') {
      if (value !== false) throw unsupportedProviderParameter(mediaType, parameter);
    } else if (parameter === 'speed') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) {
        throw invalidProviderParameter(mediaType, parameter, '必须为 0.25 到 4 的有限数值');
      }
    } else if (['duration', 'seconds', 'durationSeconds'].includes(parameter)) {
      if (
        !(automaticVideoDuration && (value === -1 || value === '-1')) &&
        positiveIntegerParameter(value) === undefined
      )
        throw invalidProviderParameter(mediaType, parameter, '必须为正整数秒数');
    } else if (!nonEmptyString(value)) {
      throw invalidProviderParameter(mediaType, parameter, '必须为非空字符串');
    }
  }
  const formats =
    mediaType === 'audio' ? ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] : ['url', 'b64_json'];
  if (
    parameters.response_format !== undefined &&
    !formats.includes(String(parameters.response_format))
  ) {
    throw invalidProviderParameter(mediaType, 'response_format', '不在已支持格式范围内');
  }
  if (
    mediaType === 'audio' &&
    !['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(String(parameters.voice))
  ) {
    throw invalidProviderParameter(mediaType, 'voice', '必须显式选择已确认的音色');
  }
  if (
    mediaType === 'image' &&
    parameters.output_format !== undefined &&
    !['png', 'jpeg', 'webp'].includes(String(parameters.output_format))
  ) {
    throw invalidProviderParameter(mediaType, 'output_format', '不在已支持格式范围内');
  }
  if (
    mediaType === 'image' &&
    parameters.background === 'transparent' &&
    parameters.output_format === 'jpeg'
  ) {
    throw invalidProviderParameter(mediaType, 'background', '透明背景不能使用 jpeg 输出');
  }
  const aliasGroups =
    mediaType === 'image'
      ? [
          ['size', 'image_size', 'imageSize', 'resolution'],
          ['quality', 'image_quality', 'imageQuality'],
          ['aspect_ratio', 'aspectRatio'],
        ]
      : mediaType === 'video'
        ? [
            ['duration', 'seconds', 'durationSeconds'],
            ['resolution', 'video_resolution', 'videoResolution'],
            ['size', 'video_size', 'videoSize'],
            ['quality', 'video_quality', 'videoQuality'],
            ['aspect_ratio', 'aspectRatio'],
          ]
        : [];
  for (const aliases of aliasGroups) {
    const values = aliases
      .filter((alias) => parameters[alias] !== undefined)
      .map((alias) =>
        alias === 'duration' || alias === 'seconds' || alias === 'durationSeconds'
          ? Number(parameters[alias])
          : String(parameters[alias]).trim(),
      );
    if (new Set(values).size > 1)
      throw invalidProviderParameter(mediaType, aliases.join('/'), '别名值冲突');
  }
}

const providerRoleParameterKeys = [
  'negativePrompt',
  'content',
  'style',
  'character',
  'referenceImage',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const satisfies readonly PortRole[];

type PromptSource = {
  value: string;
  /** A configured node/parameter prompt, as opposed to a display-label fallback. */
  explicit: boolean;
};

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: string };

type ParsedProviderDataUrl = {
  mimeType: string;
  payload: string;
  isBase64: boolean;
};

type VideoInputMapping = {
  prompt?: RunInputSnapshot;
  negativePrompt?: RunInputSnapshot;
  firstFrame?: RunInputSnapshot;
  lastFrame?: RunInputSnapshot;
  referenceImages: RunInputSnapshot[];
  referenceVideos: RunInputSnapshot[];
  referenceAudios: RunInputSnapshot[];
};

/**
 * The OpenAI-compatible endpoints do not share a reference-input schema. Keep
 * the mapping at this provider boundary and fail before an outbound request
 * whenever a canvas role has no documented field for the selected endpoint.
 */
function orderedRunInputs(snapshot: RunSnapshot): RunInputSnapshot[] {
  return snapshot.inputs
    .map((input, index) => ({ input, index }))
    .sort((left, right) => left.input.sortOrder - right.input.sortOrder || left.index - right.index)
    .map(({ input }) => input);
}

function resolvePromptSource(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt: string | undefined,
  mediaType: 'text' | 'image' | 'audio' | 'video',
  nodePromptDocument?: PromptDocument,
): PromptSource {
  if (nodePromptDocument !== undefined) {
    return { value: renderPromptDocument(nodePromptDocument), explicit: true };
  }
  const parameterPrompt = normalizeErrorField(snapshot.parameters.prompt);
  // The TTS endpoint names its primary text field `input`. Treat it as the
  // same provider-neutral prompt source while removing it from raw parameters.
  const audioInput =
    mediaType === 'audio' ? normalizeErrorField(snapshot.parameters.input) : undefined;
  const configuredPrompt = parameterPrompt ?? audioInput ?? normalizeErrorField(nodePrompt);
  return configuredPrompt
    ? { value: configuredPrompt, explicit: true }
    : { value: label, explicit: false };
}

/**
 * 从 Worker 临时水合的运行快照构造 Provider-neutral 提及列表。
 *
 * 函数严格核对冻结身份与文档块，防止 Provider 收到“标签看似正确、实际
 * 资产或版本不一致”的输入。返回列表保持快照中的提及顺序和重复项。
 *
 * @throws 当冻结提及没有对应文档块、媒体身份不一致或内容尚未解析时抛错。
 */
export function resolveProviderMentions(snapshot: RunSnapshot): ResolvedMention[] {
  return (snapshot.promptMentions ?? []).map((frozen) => {
    const nodeId = frozen.nodeId ?? snapshot.targetNodeId;
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
    const block = node?.data.promptDocument?.blocks.find(
      (candidate) => candidate.type === 'mention' && candidate.mentionId === frozen.mentionId,
    );
    if (!node || !block || block.type !== 'mention') {
      throw new Error(`resolved prompt mention ${frozen.mentionId} is missing from node ${nodeId}`);
    }
    if (block.assetId !== frozen.assetId || block.mediaType !== frozen.mediaType) {
      throw new Error(
        `resolved prompt mention ${frozen.mentionId} does not match its frozen identity`,
      );
    }
    // Worker 只在 Provider 进程内把这两个字段临时注入；它们不属于
    // PromptMention 持久化协议，因此通过受控记录读取而不扩展领域类型。
    const hydratedBlock = block as unknown as Record<string, unknown>;
    const mimeType = nonEmptyString(hydratedBlock.mimeType)
      ? hydratedBlock.mimeType.trim()
      : undefined;
    const dataUrl = nonEmptyString(hydratedBlock.contentUrl)
      ? hydratedBlock.contentUrl.trim()
      : undefined;
    const remoteUrl = dataUrl ? providerRemoteUrl(dataUrl) : undefined;
    const videoReference =
      node.data.mediaType === 'video' && ['video', 'audio'].includes(frozen.mediaType);
    if (!mimeType || (!dataUrl?.startsWith('data:') && !(videoReference && remoteUrl))) {
      throw new Error(
        `resolved prompt mention ${frozen.mentionId} has no provider-readable content`,
      );
    }
    return {
      ...frozen,
      nodeId,
      source: remoteUrl
        ? { kind: 'remote-url' as const, mimeType, url: remoteUrl }
        : { kind: 'data-url' as const, mimeType, dataUrl: dataUrl! },
    };
  });
}

/**
 * 将目标节点的结构化提示词转换为 New API Chat Completions 内容块。
 *
 * 文字块和提及块均保留原始顺序；提及必须来自 Worker 根据冻结资产版本
 * 水合的 `resolvedMentions`，缺失时 fail-closed，避免把显示标签误当成媒体内容。
 */
function promptDocumentContentParts(
  snapshot: RunSnapshot,
  document: PromptDocument,
  resolvedMentions: readonly ResolvedMention[] | undefined,
): ChatContentPart[] {
  const targetNodeId = snapshot.targetNodeId;
  const targetResolved = (resolvedMentions ?? []).filter(
    (mention) => mention.nodeId === targetNodeId,
  );
  const mentionsById = new Map<string, ResolvedMention>();
  for (const mention of targetResolved) {
    if (mentionsById.has(mention.mentionId)) {
      throw promptMentionMappingError(
        snapshot,
        mention,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '同一提及被解析了多个内容',
      );
    }
    mentionsById.set(mention.mentionId, mention);
  }

  const referencedMentionIds = new Set<string>();
  const parts = document.blocks.map((block): ChatContentPart => {
    if (block.type === 'text') return { type: 'text', text: block.text };

    referencedMentionIds.add(block.mentionId);
    const mention = mentionsById.get(block.mentionId);
    if (!mention) {
      throw promptMentionMappingError(
        snapshot,
        block,
        'RESOURCE_MENTION_RESOLUTION_MISSING',
        'Worker 未提供冻结版本内容',
      );
    }
    if (
      mention.assetId !== block.assetId ||
      mention.mediaType !== block.mediaType ||
      (block.assetVersion !== undefined && mention.assetVersion !== block.assetVersion)
    ) {
      throw promptMentionMappingError(
        snapshot,
        mention,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '冻结身份与提示词块不一致',
      );
    }
    return mentionContentPart(snapshot, mention);
  });

  const orphaned = targetResolved.find((mention) => !referencedMentionIds.has(mention.mentionId));
  if (orphaned) {
    throw promptMentionMappingError(
      snapshot,
      orphaned,
      'RESOURCE_MENTION_RESOLUTION_INVALID',
      '冻结提及不在目标节点提示词文档中',
    );
  }
  return parts;
}

/**
 * 把全能参考提示词提及收成视频输入。
 * 同一资产版本和角色重复出现时只发送一次，每次提及都算已吸收。
 * 不同版本保持独立，不能把旧版本参考误换成当前版本。
 * @param snapshot 运行快照。
 * @param resolvedMentions Worker 水合后的冻结提及。
 * @returns 去重后的参考输入，以及全部已吸收的 mentionId。
 */
function collectAbsorbedVideoMentionInputs(
  snapshot: RunSnapshot,
  resolvedMentions: readonly ResolvedMention[] | undefined,
): { inputs: RunInputSnapshot[]; absorbedMentionIds: Set<string> } {
  const empty = { inputs: [] as RunInputSnapshot[], absorbedMentionIds: new Set<string>() };
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  if (!target || target.data.mediaType !== 'video') return empty;
  const documentMentions =
    target.data.promptDocument?.blocks.flatMap((block) =>
      block.type === 'mention' ? [block] : [],
    ) ?? [];
  const resolvedById = new Map(
    (resolvedMentions ?? [])
      .filter((mention) => mention.nodeId === snapshot.targetNodeId)
      .map((mention) => [mention.mentionId, mention]),
  );
  const existingReferences = new Set(
    snapshot.inputs
      .filter((input) => input.sourceAssetId)
      .map((input) => `${input.sourceAssetId}:${input.sourceAssetVersion ?? ''}:${input.role}`),
  );
  const inputs: RunInputSnapshot[] = [];
  const absorbedMentionIds = new Set<string>();
  for (const [blockOrder, block] of documentMentions.entries()) {
    const role = videoInputRoleForPromptMention(
      block.mediaType,
      target.data.videoMode,
      snapshot.modelAlias,
    );
    if (!role) continue;
    absorbedMentionIds.add(block.mentionId);
    const resolved = resolvedById.get(block.mentionId);
    if (!resolved) {
      throw promptMentionMappingError(
        snapshot,
        {
          mentionId: block.mentionId,
          assetId: block.assetId,
          mediaType: block.mediaType,
        },
        'RESOURCE_MENTION_RESOLUTION_MISSING',
        'Worker 未提供冻结版本内容',
      );
    }
    if (
      resolved.assetId !== block.assetId ||
      resolved.mediaType !== block.mediaType ||
      (block.assetVersion !== undefined && resolved.assetVersion !== block.assetVersion)
    ) {
      throw promptMentionMappingError(
        snapshot,
        resolved,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '冻结身份与提示词块不一致',
      );
    }
    const referenceKey = `${resolved.assetId}:${resolved.assetVersion}:${role}`;
    if (existingReferences.has(referenceKey)) continue;
    existingReferences.add(referenceKey);
    inputs.push({
      nodeId: `mention:${resolved.mentionId}`,
      role,
      sortOrder: 10_000 + (resolved.blockOrder ?? blockOrder),
      sourceAssetId: resolved.assetId,
      sourceAssetVersion: resolved.assetVersion,
      snapshot: {
        id: `mention:${resolved.mentionId}`,
        type: resolved.mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: resolved.label,
          mediaType: resolved.mediaType,
          mode: 'source',
          contentUrl:
            resolved.source.kind === 'data-url' ? resolved.source.dataUrl : resolved.source.url,
          mimeType: resolved.source.mimeType,
          assetId: resolved.assetId,
        },
      },
    });
  }
  return { inputs, absorbedMentionIds };
}

function assertPromptMentionsUnsupported(
  mediaType: 'image' | 'audio' | 'video',
  snapshot: RunSnapshot,
  document: PromptDocument | undefined,
  resolvedMentions: readonly ResolvedMention[] | undefined,
  absorbedMentionIds: ReadonlySet<string> = new Set(),
): void {
  const targetNodeId = snapshot.targetNodeId;
  const documentMentions =
    document?.blocks.flatMap((block) =>
      block.type === 'mention' && !absorbedMentionIds.has(block.mentionId) ? [block] : [],
    ) ?? [];
  const frozenMentions = (snapshot.promptMentions ?? []).filter(
    (mention) =>
      (mention.nodeId ?? targetNodeId) === targetNodeId &&
      !absorbedMentionIds.has(mention.mentionId),
  );
  const targetResolved = (resolvedMentions ?? []).filter(
    (mention) => mention.nodeId === targetNodeId && !absorbedMentionIds.has(mention.mentionId),
  );

  if (documentMentions.length === 0 && frozenMentions.length === 0 && targetResolved.length === 0) {
    return;
  }

  const firstDocumentMention = documentMentions[0];
  const firstIdentity = firstDocumentMention ?? frozenMentions[0] ?? targetResolved[0];
  if (
    firstDocumentMention &&
    !targetResolved.some((mention) => mention.mentionId === firstDocumentMention.mentionId)
  ) {
    throw promptMentionMappingError(
      snapshot,
      firstDocumentMention,
      'RESOURCE_MENTION_RESOLUTION_MISSING',
      'Worker 未提供冻结版本内容',
    );
  }
  if (!firstIdentity) return;
  throw promptMentionMappingError(
    snapshot,
    firstIdentity,
    'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
    `当前项目尚未接通 New API ${mediaType} 的这种资源提及输入映射`,
  );
}

function mentionContentPart(snapshot: RunSnapshot, mention: ResolvedMention): ChatContentPart {
  if (mention.source.kind !== 'data-url') {
    throw promptMentionMappingError(
      snapshot,
      mention,
      'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
      '该接口需要 Worker 提供媒体内容，不能使用视频专用临时地址',
    );
  }
  const dataUrl = parseProviderDataUrl(mention.source.dataUrl);
  const declaredMimeType = normalizedMimeType(mention.source.mimeType);
  const providerTextMime =
    dataUrl?.mimeType === 'text/plain' &&
    declaredMimeType !== undefined &&
    isTextMentionMimeType(declaredMimeType);
  const mimeType = providerTextMime ? declaredMimeType : (dataUrl?.mimeType ?? declaredMimeType);
  if (!dataUrl || !mimeType || !declaredMimeType) {
    throw promptMentionMappingError(
      snapshot,
      mention,
      'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
      '缺少有效的 Provider 数据 URL 或 MIME 类型',
    );
  }
  if (
    !providerTextMime &&
    dataUrl.mimeType !== 'application/octet-stream' &&
    declaredMimeType !== 'application/octet-stream' &&
    dataUrl.mimeType !== declaredMimeType
  ) {
    throw promptMentionMappingError(
      snapshot,
      mention,
      'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
      '数据 URL 的 MIME 类型与冻结资源不一致',
    );
  }
  const mediaTypeMatchesMime =
    mention.mediaType === 'text'
      ? isTextMentionMimeType(mimeType)
      : mimeType.startsWith(`${mention.mediaType}/`);
  if (!mediaTypeMatchesMime) {
    throw promptMentionMappingError(
      snapshot,
      mention,
      'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
      `MIME 类型 ${mimeType} 与资源媒体类型不一致`,
    );
  }

  switch (mention.mediaType) {
    case 'text': {
      const text = decodeTextMention(dataUrl, mimeType);
      if (text === undefined) {
        throw promptMentionMappingError(
          snapshot,
          mention,
          'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
          '文本资源不是可解码的 UTF-8 数据',
        );
      }
      return { type: 'text', text };
    }
    case 'image':
      return { type: 'image_url', image_url: { url: mention.source.dataUrl.trim() } };
    case 'audio': {
      if (!dataUrl.isBase64) {
        throw promptMentionMappingError(
          snapshot,
          mention,
          'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
          'New API input_audio 要求 base64 音频数据',
        );
      }
      const format = formatFromMimeType(mimeType);
      if (format !== 'wav' && format !== 'mp3') {
        throw promptMentionMappingError(
          snapshot,
          mention,
          'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
          `无法从 MIME 类型 ${mimeType} 确定 input_audio 格式`,
        );
      }
      return { type: 'input_audio', input_audio: { data: dataUrl.payload, format } };
    }
    case 'video':
      return { type: 'video_url', video_url: mention.source.dataUrl.trim() };
    default:
      return assertNeverMediaType(mention.mediaType);
  }
}

function promptMentionMappingError(
  snapshot: RunSnapshot,
  mention: {
    mentionId: string;
    assetId: string;
    mediaType: MediaType;
  },
  code:
    | 'RESOURCE_MENTION_RESOLUTION_MISSING'
    | 'RESOURCE_MENTION_RESOLUTION_INVALID'
    | 'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED'
    | 'RESOURCE_MENTION_PROVIDER_MAPPING_INVALID',
  detail: string,
): NewApiProviderError {
  return new NewApiProviderError(
    `New API ${snapshot.modelAlias} 无法映射资源提及 ${mention.mentionId}（资产 ${mention.assetId}，媒体类型 ${mention.mediaType}）：${detail}`,
    { code, retryable: false },
  );
}

function parseProviderDataUrl(value: string): ParsedProviderDataUrl | undefined {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(value.trim());
  if (!match) return undefined;
  const metadata = (match[1] ?? '').split(';');
  const mimeType = normalizedMimeType(metadata.shift()) ?? 'application/octet-stream';
  const isBase64 = metadata.some((item) => item.trim().toLowerCase() === 'base64');
  return { mimeType, payload: match[2] ?? '', isBase64 };
}

function decodeTextMention(dataUrl: ParsedProviderDataUrl, mimeType: string): string | undefined {
  if (!isTextMentionMimeType(mimeType)) return undefined;
  try {
    if (!dataUrl.isBase64) return decodeURIComponent(dataUrl.payload);
    const binary = atob(dataUrl.payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isTextMentionMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

function assertNeverMediaType(value: never): never {
  throw new Error(`unsupported provider mention media type: ${String(value)}`);
}

function chatInputName(
  role: PortRole,
): 'canvas_prompt' | 'canvas_content' | 'canvas_transcript' | undefined {
  switch (role) {
    case 'prompt':
      return 'canvas_prompt';
    case 'content':
      return 'canvas_content';
    case 'transcript':
      return 'canvas_transcript';
    default:
      return undefined;
  }
}

function resolveSinglePromptInput(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt: string | undefined,
  mediaType: 'image' | 'audio',
  nodePromptDocument?: PromptDocument,
): string {
  let promptInput: RunInputSnapshot | undefined;
  for (const input of orderedRunInputs(snapshot)) {
    // 文本节点常会连接到目标的内容端口；图片和 TTS 接口都将它视为主提示词，
    // 但二进制或参考媒体仍在这里拒绝，避免误发到文字字段。
    if (input.role !== 'prompt' && input.role !== 'content') {
      throw unsupportedInputRoleError(mediaType, input.role);
    }
    if (promptInput) throw inputRoleCardinalityError(mediaType, 'prompt');
    promptInput = input;
  }

  return resolveMappedPromptInput(
    resolvePromptSource(snapshot, label, nodePrompt, mediaType, nodePromptDocument),
    promptInput,
    mediaType,
  );
}

const imageEditSourceRoles = new Set<PortRole>(['imageEdit', 'content', 'referenceImage']);

/**
 * 规范化 multipart 表单值。图片编辑接口只接受标量和已声明的字符串枚举，
 * 对象或数组无法表达为单个表单字段，必须在请求前明确失败而不是静默丢弃。
 * @param value 已通过参数校验的取值。
 * @returns 可直接写入 FormData 的字符串；显式空值返回 undefined。
 */
function imageEditFormValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new NewApiProviderError('New API 图片编辑参数必须为标量', {
    code: 'IMAGE_EDIT_PARAMETER_UNSUPPORTED',
    retryable: false,
  });
}

/**
 * 请求前校验图片编辑能力。
 *
 * 能力声明可省略；已冻结的格式和参数约束仍然生效。
 *
 * @param snapshot 当前运行快照；图片编辑能力随快照冻结。
 * @param input 作为原图的输入。
 * @returns 已冻结能力，未声明时返回 undefined；格式不符合声明时抛错。
 */
function assertImageEditSupported(
  snapshot: RunSnapshot,
  input: RunInputSnapshot,
): ImageEditCapability | undefined {
  const capability = snapshot.imageEditCapability;
  if (!capability) return undefined;
  const mediaType = input.snapshot.data.mimeType ?? '';
  if (
    capability.mimeTypes &&
    capability.mimeTypes.length > 0 &&
    mediaType &&
    !capability.mimeTypes.some((allowed) => allowed.toLowerCase() === mediaType.toLowerCase())
  ) {
    throw inputRoleValueError(
      'image',
      input.role,
      `模型仅声明支持 ${capability.mimeTypes.join('、')} 格式的原图`,
    );
  }
  return capability;
}

/**
 * 节点声明了图片编辑来源却没有可用的原图输入时拒绝请求。
 * 这条边界保证编辑语义不会被静默降级为文生图。
 * @param snapshot 当前运行快照。
 * @param mapping 已分组的图片输入。
 */
function assertImageEditSourceInput(snapshot: RunSnapshot, mapping: ImageGenerationMapping): void {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  const source = imageEditSourceSchema.safeParse(target?.data.imageEditSource);
  if (!source.success) return;
  const wired = snapshot.inputs.some(
    (input) => input.role === 'imageEdit' && input.snapshot.data.mediaType === 'image',
  );
  const hasImageInput = wired || mapping.images.length > 0;
  if (hasImageInput) return;
  throw new NewApiProviderError('图片编辑节点缺少来源原图输入，已阻止请求而不是退回文生图', {
    code: 'IMAGE_EDIT_SOURCE_INPUT_MISSING',
    retryable: false,
  });
}

/** Provider 内部原图输入；版本只来自冻结快照，不增加持久化字段。 */
type ImageSourceInput = RunInputSnapshot & {
  /** 已冻结的资产版本；旧连线快照可能没有版本，不据此推断为当前版本。 */
  assetVersion?: number;
};

/** 图片接口发送的文字和已按资产版本去重的原图。 */
type ImageGenerationMapping = {
  /** 发送给图片接口的主提示词。 */
  prompt: string;
  /** 去重后按连线、提及顺序上传的原图，发送前校验模型数量上限。 */
  images: ImageSourceInput[];
};

/**
 * 把图片节点的连线和资源提及分成提示词、原图。
 * 图片连线和图片提及共同作为 edits 原图，按冻结资产版本去重。
 * @param snapshot 当前运行快照。
 * @param label 目标节点显示名。
 * @param nodePrompt 节点提示词。
 * @param nodePromptDocument 结构化提示词文档。
 * @param resolvedMentions Worker 水合的冻结资源内容。
 * @returns 已按官方图像契约分组的输入。
 */
function mapImageGenerationInputs(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt: string | undefined,
  nodePromptDocument?: PromptDocument,
  resolvedMentions?: readonly ResolvedMention[],
): ImageGenerationMapping {
  let promptInput: RunInputSnapshot | undefined;
  const images: ImageSourceInput[] = [];
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  const editSource = imageEditSourceSchema.safeParse(target?.data.imageEditSource);

  for (const input of orderedRunInputs(snapshot)) {
    const sourceType = input.snapshot.data.mediaType;
    if (input.role === 'prompt' || (input.role === 'content' && sourceType === 'text')) {
      if (promptInput) throw inputRoleCardinalityError('image', 'prompt');
      promptInput = input;
      continue;
    }
    if (imageEditSourceRoles.has(input.role) && sourceType === 'image') {
      const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
      const editVersion =
        assetId &&
        editSource.success &&
        editSource.data.assetId === assetId &&
        editSource.data.sourceNodeId === input.nodeId
          ? editSource.data.version
          : undefined;
      if (
        input.sourceAssetVersion !== undefined &&
        editVersion !== undefined &&
        input.sourceAssetVersion !== editVersion
      ) {
        throw new NewApiProviderError('图片编辑来源版本与连线冻结版本不一致', {
          code: 'INPUT_ROLE_VALUE_MISSING',
          retryable: false,
        });
      }
      // 只使用实际读取的冻结版本；资源池展示版本不能用于推断连线内容。
      images.push({ ...input, assetVersion: input.sourceAssetVersion ?? editVersion });
      continue;
    }
    if (input.role === 'content') {
      throw unsupportedInputRoleError(
        'image',
        'content',
        `上游媒体类型 ${sourceType} 无法映射为文字或图片`,
      );
    }
    throw unsupportedInputRoleError('image', input.role);
  }

  images.push(...imageMentionInputs(snapshot, nodePromptDocument, resolvedMentions));
  const uniqueImages: ImageSourceInput[] = [];
  const imagesByVersion = new Map<string, ImageSourceInput>();
  for (const input of images) {
    const assetId = input.sourceAssetId ?? input.snapshot.data.assetId;
    const key = assetId && input.assetVersion ? `${assetId}\0${input.assetVersion}` : undefined;
    const previous = key ? imagesByVersion.get(key) : undefined;
    if (previous) {
      if (
        previous.snapshot.data.contentUrl !== input.snapshot.data.contentUrl ||
        previous.snapshot.data.mimeType !== input.snapshot.data.mimeType
      ) {
        throw new NewApiProviderError('图片编辑的同一冻结资产版本包含不一致的原图内容', {
          code: 'INPUT_ROLE_VALUE_MISSING',
          retryable: false,
        });
      }
      continue;
    }
    if (key) imagesByVersion.set(key, input);
    uniqueImages.push(input);
  }

  return {
    prompt: resolveMappedPromptInput(
      resolvePromptSource(snapshot, label, nodePrompt, 'image', nodePromptDocument),
      promptInput,
      'image',
    ),
    images: uniqueImages,
  };
}

/**
 * 将目标节点的图片提及转换为 edits 原图，保持冻结身份与文档一一对应。
 * @param snapshot 含冻结提及身份的运行快照。
 * @param document 目标节点的结构化提示词；文字顺序仍由原文档渲染。
 * @param resolvedMentions Worker 按冻结版本读取的进程内内容。
 * @returns 按提及顺序排列的图片输入，后续与连线统一去重。
 * @throws 非图片提及、缺失水合、重复身份、孤儿内容或冻结身份不一致时阻止请求。
 */
function imageMentionInputs(
  snapshot: RunSnapshot,
  document: PromptDocument | undefined,
  resolvedMentions: readonly ResolvedMention[] | undefined,
): ImageSourceInput[] {
  const targetNodeId = snapshot.targetNodeId;
  const frozenById = new Map<string, FrozenPromptMention>();
  const resolvedById = new Map<string, ResolvedMention>();
  for (const frozen of snapshot.promptMentions ?? []) {
    if ((frozen.nodeId ?? targetNodeId) !== targetNodeId) continue;
    if (frozenById.has(frozen.mentionId)) {
      throw promptMentionMappingError(
        snapshot,
        frozen,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '同一提及包含多个冻结身份',
      );
    }
    frozenById.set(frozen.mentionId, frozen);
  }
  for (const resolved of resolvedMentions ?? []) {
    if (resolved.nodeId !== targetNodeId) continue;
    if (resolvedById.has(resolved.mentionId)) {
      throw promptMentionMappingError(
        snapshot,
        resolved,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '同一提及被解析了多个内容',
      );
    }
    resolvedById.set(resolved.mentionId, resolved);
  }
  const seen = new Set<string>();
  const inputs: ImageSourceInput[] = [];
  for (const [blockOrder, block] of (document?.blocks ?? []).entries()) {
    if (block.type === 'text') continue;
    if (seen.has(block.mentionId)) {
      throw promptMentionMappingError(
        snapshot,
        block,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '提示词包含重复的提及身份',
      );
    }
    seen.add(block.mentionId);
    const frozen = frozenById.get(block.mentionId);
    const resolved = resolvedById.get(block.mentionId);
    if (!frozen || !resolved) {
      throw promptMentionMappingError(
        snapshot,
        block,
        'RESOURCE_MENTION_RESOLUTION_MISSING',
        'Worker 未提供冻结版本内容',
      );
    }
    if (
      frozen.assetId !== block.assetId ||
      frozen.mediaType !== block.mediaType ||
      (block.assetVersion !== undefined && frozen.assetVersion !== block.assetVersion) ||
      resolved.assetId !== frozen.assetId ||
      resolved.assetVersion !== frozen.assetVersion ||
      resolved.mediaType !== frozen.mediaType ||
      (frozen.blockOrder !== undefined && frozen.blockOrder !== blockOrder) ||
      (resolved.blockOrder !== undefined && resolved.blockOrder !== blockOrder)
    ) {
      throw promptMentionMappingError(
        snapshot,
        resolved,
        'RESOURCE_MENTION_RESOLUTION_INVALID',
        '冻结身份与提示词块或水合内容不一致',
      );
    }
    if (resolved.mediaType !== 'image') {
      throw promptMentionMappingError(
        snapshot,
        resolved,
        'RESOURCE_MENTION_PROVIDER_MAPPING_UNSUPPORTED',
        `当前项目尚未接通 New API image 的 ${block.mediaType} 资源提及输入映射`,
      );
    }
    // 复用媒体 URL/MIME 校验，标签仅供提示词引用，不替代二进制图片。
    mentionContentPart(snapshot, resolved);
    const nodeId = `mention:${resolved.mentionId}`;
    inputs.push({
      nodeId,
      role: 'imageEdit',
      sortOrder: blockOrder,
      sourceAssetId: frozen.assetId,
      assetVersion: frozen.assetVersion,
      snapshot: {
        id: nodeId,
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: frozen.label,
          mediaType: 'image',
          mode: 'source',
          assetId: frozen.assetId,
          contentUrl: resolved.source.kind === 'data-url' ? resolved.source.dataUrl : undefined,
          mimeType: resolved.source.mimeType,
        },
      },
    });
  }
  const orphaned = [...frozenById.values(), ...resolvedById.values()].find(
    (mention) => !seen.has(mention.mentionId),
  );
  if (orphaned) {
    throw promptMentionMappingError(
      snapshot,
      orphaned,
      'RESOURCE_MENTION_RESOLUTION_INVALID',
      '冻结提及不在目标节点提示词文档中',
    );
  }
  return inputs;
}

/**
 * 把 Worker 水合后的图片 data URL 编成 edits 接口需要的文件字段。
 * @param input 原图或遮罩输入。
 * @param allowedMimeTypes 目录声明的原图格式；缺省时不额外收窄。
 * @returns 带文件名的 File，便于 multipart 带上扩展名。
 */
function imageFormFile(
  input: RunInputSnapshot,
  allowedMimeTypes?: readonly string[],
): { file: File; filename: string } {
  const contentUrl = input.snapshot.data.contentUrl;
  if (!nonEmptyString(contentUrl)) {
    throw inputRoleValueError('image', input.role, '可发送的图片内容');
  }
  const parsed = parseDataUrl(contentUrl.trim());
  if (!parsed) {
    throw inputRoleValueError('image', input.role, '可发送的图片内容');
  }
  const mimeType = validatedMediaMimeType(parsed.mimeType, 'image') ?? 'image/png';
  if (
    allowedMimeTypes &&
    allowedMimeTypes.length > 0 &&
    !allowedMimeTypes.some((allowed) => allowed.toLowerCase() === mimeType.toLowerCase())
  ) {
    throw inputRoleValueError(
      'image',
      input.role,
      `模型仅声明支持 ${allowedMimeTypes.join('、')} 格式的原图`,
    );
  }
  const binary = atob(validatedMediaBase64(parsed.base64));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const filename = `${input.nodeId}.${formatFromMimeType(mimeType) ?? 'png'}`;
  return {
    file: new File([bytes], filename, { type: mimeType }),
    filename,
  };
}

function resolveMappedPromptInput(
  prompt: PromptSource,
  input: RunInputSnapshot | undefined,
  mediaType: 'image' | 'audio' | 'video',
): string {
  if (!input) return prompt.value;
  // 文本节点接入默认 content 端口时，连接内容就是用户明确选择的提示词；
  // 它应覆盖目标节点上遗留的提示词，避免再次触发角色冲突。
  if (input.role === 'content') return inputTextValue(input, mediaType);
  if (prompt.explicit) throw inputRoleConflictError(mediaType, 'prompt');
  return inputTextValue(input, mediaType);
}

function resolveRequiredVideoPrompt(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt: string | undefined,
  input: RunInputSnapshot | undefined,
  nodePromptDocument?: PromptDocument,
): string {
  const prompt = resolvePromptSource(snapshot, label, nodePrompt, 'video', nodePromptDocument);
  if (!prompt.explicit && !input) {
    throw new NewApiProviderError('New API video 需要 prompt', {
      code: 'VIDEO_PROMPT_REQUIRED',
      retryable: false,
    });
  }
  return resolveMappedPromptInput(prompt, input, 'video');
}

/**
 * 把画布输入和全能参考吸收的提示词提及收成视频规范输入。
 * 文生视频节点上的图片提及会按全能参考预检，避免参考图被文生视频规则误拦。
 * @param snapshot 运行快照。
 * @param extraInputs 提示词提及吸收出的额外输入。
 */
function mapVideoInputs(
  snapshot: RunSnapshot,
  extraInputs: readonly RunInputSnapshot[] = [],
): VideoInputMapping {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  const absorbedOmni = extraInputs.some((input) =>
    ['referenceImage', 'character', 'style', 'content', 'audioTrack'].includes(input.role),
  );
  const precheck = precheckVideoGenerationInputs([...snapshot.inputs, ...extraInputs], {
    modelAlias: snapshot.modelAlias,
    parameters: snapshot.parameters,
    videoMode: videoModeForPromptMentions(target?.data.videoMode, absorbedOmni),
  });
  const issue = precheck.issues[0];
  if (issue) {
    throw new NewApiProviderError(issue.message, {
      code: issue.code,
      retryable: false,
    });
  }
  if (precheck.inputSet.firstFrame) {
    inputImageUrl(precheck.inputSet.firstFrame, 'video');
  }
  if (precheck.inputSet.lastFrame) {
    inputImageUrl(precheck.inputSet.lastFrame, 'video');
  }
  const referenceImages = [
    ...precheck.inputSet.character,
    ...precheck.inputSet.style,
    ...precheck.inputSet.referenceImage,
  ].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.nodeId.localeCompare(right.nodeId),
  );
  for (const input of referenceImages) {
    inputImageUrl(input, 'video');
  }
  return {
    prompt: precheck.inputSet.prompt,
    negativePrompt: precheck.inputSet.negativePrompt,
    firstFrame: precheck.inputSet.firstFrame,
    lastFrame: precheck.inputSet.lastFrame,
    referenceImages,
    referenceVideos: precheck.inputSet.content,
    referenceAudios: precheck.inputSet.audioTrack,
  };
}

/**
 * 按 xAI grok-imagine-video-1.5 官方 REST 写入 last_frame 与 reference_images。
 * @param payload 即将发送的创建体。
 * @param inputs 已预检的规范输入。
 * @param imageShape 与该合同首帧字段相同：legacy 用 {url}，OpenAI/统一路径用 URL 字符串；参考图始终用官方 {url}[]。
 */
function applyGrokImagineVideo15References(
  payload: Record<string, unknown>,
  inputs: VideoInputMapping,
  imageShape: 'string' | 'object',
): void {
  if (inputs.lastFrame) {
    const url = inputImageUrl(inputs.lastFrame, 'video');
    payload.last_frame = imageShape === 'string' ? url : { url };
  }
  if (inputs.referenceImages.length > 0) {
    payload.reference_images = inputs.referenceImages.map((input) => ({
      url: inputImageUrl(input, 'video'),
    }));
  }
}

function inputTextValue(
  input: RunInputSnapshot,
  targetMediaType: 'text' | 'image' | 'audio' | 'video',
): string {
  if (input.snapshot.data.mediaType !== 'text') {
    throw unsupportedInputRoleError(
      targetMediaType,
      input.role,
      `上游媒体类型 ${input.snapshot.data.mediaType} 无法映射为文字`,
    );
  }
  const prompt = normalizeErrorField(input.snapshot.data.prompt);
  if (prompt) return prompt;
  const inlineText = inlineTextContent(input.snapshot.data.contentUrl);
  if (inlineText) return inlineText;
  throw inputRoleValueError(targetMediaType, input.role, '可发送的文字内容');
}

/**
 * 将文字节点的连线内容映射为聊天消息，图片只能来自执行器已水合的数据。
 * @param input 保留画布角色和顺序的运行输入；图片仅允许连接 content 端口。
 * @returns 纯文本字符串或携带真实图片数据的 image_url 内容块。
 * @throws 未接通的媒体/角色或无效图片在发出请求前失败，不获取外部 URL。
 */
function chatInputContent(input: RunInputSnapshot): string | ChatContentPart[] {
  const data = input.snapshot.data;
  if (data.mediaType === 'text') return inputTextValue(input, 'text');
  if (data.mediaType !== 'image' || input.role !== 'content') {
    throw new NewApiProviderError(
      `当前项目 New API 文字适配器尚未接通 ${data.mediaType} 到 ${input.role} 的连线输入映射`,
      { code: 'UNSUPPORTED_INPUT_ROLE', retryable: false },
    );
  }
  const dataUrl = nonEmptyString(data.contentUrl) ? data.contentUrl.trim() : undefined;
  const parsed = dataUrl ? parseDataUrl(dataUrl) : undefined;
  const mimeType = normalizedMimeType(data.mimeType);
  if (
    !dataUrl ||
    !parsed ||
    !mimeType?.startsWith('image/') ||
    parsed.mimeType !== mimeType ||
    !isValidBase64(parsed.base64)
  ) {
    throw new NewApiProviderError(
      '文字节点的图片连线缺少有效的已水合图片数据，或数据 URL 与资源 MIME 类型不一致',
      { code: 'INPUT_MEDIA_INVALID', retryable: false },
    );
  }
  return [{ type: 'image_url', image_url: { url: dataUrl } }];
}

function inputImageUrl(input: RunInputSnapshot, targetMediaType: 'video'): string {
  if (input.snapshot.data.mediaType !== 'image') {
    throw unsupportedInputRoleError(
      targetMediaType,
      input.role,
      `上游媒体类型 ${input.snapshot.data.mediaType} 无法映射为图片`,
    );
  }
  const url = providerVideoReferenceUrl(input.snapshot.data.contentUrl);
  if (!url) throw inputRoleValueError(targetMediaType, input.role, '可发送的图片 URL');
  return url;
}

function inlineTextContent(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  const match = /^data:text\/plain(?:;charset=[^;,]+)?(?:;(base64))?,([\s\S]*)$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;
  try {
    const decoded = match[1]
      ? new TextDecoder().decode(
          Uint8Array.from(atob(match[2] ?? ''), (character) => character.charCodeAt(0)),
        )
      : decodeURIComponent(match[2] ?? '');
    return normalizeErrorField(decoded);
  } catch {
    return undefined;
  }
}

function unsupportedInputRoleError(
  mediaType: MediaType,
  role: PortRole,
  detail?: string,
): NewApiProviderError {
  const roleHint =
    mediaType === 'video' && detail && (role === 'content' || role === 'firstFrame')
      ? ' 图生视频请把图片连到「首帧」口；提示词请连到「提示词」口或在节点中填写。'
      : mediaType === 'image' && detail && role === 'content'
        ? ' 图生图请把图片连到「内容」或「通用参考」口；提示词请连到「提示词」口或在节点中填写。'
        : '';
  return new NewApiProviderError(
    `New API ${mediaType} 不支持该输入角色：${role}${detail ? `（${detail}）` : ''}${roleHint}`,
    { code: 'UNSUPPORTED_INPUT_ROLE', retryable: false },
  );
}

function inputRoleCardinalityError(mediaType: MediaType, role: PortRole): NewApiProviderError {
  return new NewApiProviderError(`New API ${mediaType} 不支持该输入角色的多个值：${role}`, {
    code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
    retryable: false,
  });
}

function inputRoleConflictError(mediaType: MediaType, role: PortRole): NewApiProviderError {
  return new NewApiProviderError(
    `New API ${mediaType} 不支持该输入角色与节点提示词同时传入：${role}`,
    { code: 'INPUT_ROLE_CONFLICT', retryable: false },
  );
}

function inputRoleValueError(
  mediaType: MediaType,
  role: PortRole,
  expectedValue: string,
): NewApiProviderError {
  return new NewApiProviderError(`New API ${mediaType} 输入角色 ${role} 缺少${expectedValue}`, {
    code: 'INPUT_ROLE_VALUE_MISSING',
    retryable: false,
  });
}

export * from './xfyun.js';

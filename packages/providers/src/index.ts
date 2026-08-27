import type {
  MediaType,
  PortRole,
  ProviderJob,
  RunInputSnapshot,
  RunResult,
  RunSnapshot,
} from '@multimodal-canvas/domain';

export type ProviderName = 'mock' | 'newapi';

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

export type MockProviderRequest = {
  snapshot: RunSnapshot;
  reportProgress?: (progress: number) => Promise<void> | void;
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

export type ProviderJobUpdate = Partial<ProviderJob> & Pick<ProviderJob, 'provider'>;

export type NewApiProviderRequest = MockProviderRequest & {
  /** Existing asynchronous task identity used to resume without another paid POST. */
  providerJob?: ProviderJobUpdate;
  /** Persist asynchronous platform identity before polling can fail or time out. */
  onProviderJob?: (providerJob: ProviderJobUpdate) => Promise<void> | void;
};

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
  /** Whether a caller may retry after applying its own idempotency policy. */
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
    super(message);
    this.name = 'NewApiProviderError';

    const details: NewApiProviderErrorDetails =
      typeof statusOrDetails === 'number' || statusOrDetails === undefined
        ? { ...legacyDetails, status: statusOrDetails ?? legacyDetails?.status }
        : statusOrDetails;
    this.status = details.status;
    this.code = normalizeErrorField(details.code);
    this.requestId = normalizeErrorField(details.requestId);
    this.platformJobId = normalizeErrorField(details.platformJobId);
    this.providerPayload = details.providerPayload;
    this.retryable = details.retryable ?? isRetryableStatus(this.status);

    // Required when extending Error while targeting both Node and browsers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Maps the provider-neutral snapshot to the OpenAI-compatible New API contract.
 * Video remains isolated in NewApiVideoProvider until its platform contract is known.
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
    this.timeoutMs = positiveInteger(options.timeoutMs, 120_000, 'timeoutMs');
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
  }: NewApiProviderRequest): Promise<ProviderExecution<StandardProviderOutput>> {
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType === 'video') {
      throw new NewApiProviderError('video generation requires NewApiVideoProvider');
    }
    if (providerJob && providerJob.provider !== 'newapi') {
      throw new NewApiProviderError('已有平台任务与 New API Provider 不匹配', {
        code: 'PROVIDER_MISMATCH',
        retryable: false,
      });
    }

    // The worker persists this local provider-job ID before the paid POST.
    // Reusing it on BullMQ replay lets an OpenAI-compatible gateway return the
    // original synchronous generation instead of charging for a second one.
    const idempotencyKey = standardRequestIdempotencyKey(snapshot, providerJob);

    const response =
      target.data.mediaType === 'text'
        ? await this.request(
            '/chat/completions',
            this.textPayload(snapshot, target.data.label, target.data.prompt),
            idempotencyKey,
          )
        : target.data.mediaType === 'image'
          ? await this.request(
              '/images/generations',
              this.imagePayload(snapshot, target.data.label, target.data.prompt),
              idempotencyKey,
            )
          : await this.request(
              '/audio/speech',
              this.audioPayload(snapshot, target.data.label, target.data.prompt),
              idempotencyKey,
            );
    const output =
      target.data.mediaType === 'text'
        ? parseTextOutput(response)
        : target.data.mediaType === 'image'
          ? parseImageOutput(response, snapshot)
          : parseAudioOutput(response, snapshot);
    const usage = parseProviderUsage(response);
    await reportProgress?.(100);

    return {
      result: {
        provider: 'newapi',
        summary: `New API 已完成 ${target.data.label}`,
        targetNodeId: target.id,
        mediaType: target.data.mediaType,
        inputCount: snapshot.inputs.length,
      },
      output,
      ...(usage ? { usage } : {}),
    };
  }

  private textPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    const prompt = resolvePromptSource(snapshot, label, nodePrompt, 'text');
    const inputMessages = orderedRunInputs(snapshot).map((input) => {
      const name = chatInputName(input.role);
      if (!name) throw unsupportedInputRoleError('text', input.role);
      return {
        role: 'user' as const,
        name,
        content: inputTextValue(input, 'text'),
      };
    });

    return {
      ...providerParameters(snapshot.parameters, 'text'),
      model: snapshot.modelAlias,
      messages: [
        ...(prompt.explicit || inputMessages.length === 0
          ? [{ role: 'user' as const, content: prompt.value }]
          : []),
        // `name` is part of the Chat Completions message contract. It keeps
        // the canvas role visible at the provider boundary without turning
        // separate inputs into one concatenated prompt string.
        ...inputMessages,
      ],
    };
  }

  private imagePayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...providerParameters(snapshot.parameters, 'image'),
      model: snapshot.modelAlias,
      prompt: resolveSinglePromptInput(snapshot, label, nodePrompt, 'image'),
      n: 1,
    };
  }

  private audioPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...providerParameters(snapshot.parameters, 'audio'),
      model: snapshot.modelAlias,
      input: resolveSinglePromptInput(snapshot, label, nodePrompt, 'audio'),
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readResponsePayload(response, this.maxResponseBytes);
      if (!response.ok) {
        const providerError = extractProviderError(payload);
        const message = providerError.message ?? `New API 请求失败（${response.status}）`;
        throw new NewApiProviderError(message, {
          status: response.status,
          code: providerError.code,
          requestId: providerError.requestId ?? responseRequestId(response),
          retryable: isRetryableStatus(response.status),
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof NewApiProviderError) throw error;
      const isTimeout = getErrorName(error) === 'AbortError';
      throw new NewApiProviderError(
        isTimeout
          ? 'New API 请求超时'
          : error instanceof Error
            ? error.message
            : 'New API 请求失败',
        {
          code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          retryable: true,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type NewApiVideoProviderOptions = NewApiProviderOptions & {
  /** Legacy alias for the task/status collection path. */
  videoPath?: string;
  /** POST path used to create a video generation task. */
  videoCreatePath?: string;
  /** GET /:id and GET /:id/content task/status collection path. */
  videoJobsPath?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  maxContentBytes?: number;
};

type VideoPollResult = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  providerStatus: string;
  progress: number;
  payload: Record<string, unknown>;
  outputUrl?: string;
  error?: string;
  usage?: ProviderUsage;
};

const defaultResponseContentLimit = 50 * 1024 * 1024;
const defaultVideoContentLimit = 50 * 1024 * 1024;

/** xAI-compatible asynchronous video boundary exposed by the tested New API gateway. */
export class NewApiVideoProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly videoCreatePath: string;
  private readonly videoJobsPath: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly maxContentBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: NewApiVideoProviderOptions) {
    this.baseUrl = normalizeNewApiBaseUrl(options.baseUrl);
    if (shouldRequireHttps(options.requireHttps) && !this.baseUrl.startsWith('https://')) {
      throw new TypeError('生产环境 New API Base URL 必须使用 HTTPS');
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = positiveInteger(options.timeoutMs, 120_000, 'timeoutMs');
    this.fetchImpl = options.fetchImpl ?? fetch;
    const legacyPath = options.videoPath?.trim();
    const inferredJobsPath =
      options.videoJobsPath ??
      (legacyPath?.endsWith('/generations')
        ? legacyPath.slice(0, -'/generations'.length)
        : legacyPath) ??
      '/videos';
    this.videoJobsPath = normalizeVideoPath(inferredJobsPath);
    this.videoCreatePath = normalizeVideoPath(
      options.videoCreatePath ??
        (legacyPath?.endsWith('/generations') ? legacyPath : `${this.videoJobsPath}/generations`),
    );
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs, 2_000, 'pollIntervalMs');
    this.maxPollAttempts = positiveInteger(options.maxPollAttempts, 120, 'maxPollAttempts');
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

  async execute({
    snapshot,
    reportProgress,
    providerJob: existingProviderJob,
    onProviderJob,
  }: NewApiProviderRequest): Promise<ProviderExecution<VideoProviderOutput>> {
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType !== 'video') {
      throw new NewApiProviderError('NewApiVideoProvider 只能执行视频节点');
    }
    if (target.data.mode !== 'generate') {
      throw new NewApiProviderError('当前视频接口仅支持 generate 模式');
    }
    // Validate every immutable input snapshot even when this invocation only
    // resumes an existing platform job. Otherwise a retry could silently skip
    // a role that the original creation path would reject.
    const inputs = mapVideoInputs(snapshot);

    if (existingProviderJob && existingProviderJob.provider !== 'newapi') {
      throw new NewApiProviderError('已有平台任务与 New API Provider 不匹配', {
        code: 'VIDEO_PROVIDER_MISMATCH',
        retryable: false,
      });
    }
    const idempotencyKey = standardRequestIdempotencyKey(snapshot, existingProviderJob);

    let platformJobId = normalizeErrorField(existingProviderJob?.platformJobId);
    let submissionUsage: ProviderUsage | undefined;
    let initialPhase: 'submitted' | 'resumed' = 'resumed';
    if (!platformJobId) {
      // Creating a video may charge immediately. Never retry this POST inside
      // the provider because a lost response could otherwise create duplicates.
      let submission: { payload: Record<string, unknown>; requestId?: string };
      try {
        submission = await this.requestJson(
          `${this.baseUrl}${this.videoCreatePath}`,
          'POST',
          videoPayload(snapshot, target.data.label, target.data.prompt, inputs),
          idempotencyKey,
        );
      } catch (error) {
        // A transport failure after the provider accepted the request leaves
        // the platform task identity unknown. Do not classify this as a
        // retryable error: an automatic retry could create and charge a
        // second task. Surface it for manual provider-side reconciliation.
        if (error instanceof NewApiProviderError && error.retryable) {
          throw new NewApiProviderError('New API 视频创建结果未知，请先核对平台任务状态', {
            status: error.status,
            code: 'VIDEO_SUBMISSION_UNKNOWN',
            requestId: error.requestId,
            retryable: false,
          });
        }
        throw error;
      }
      platformJobId = extractVideoRequestId(submission.payload);
      if (!platformJobId) {
        throw new NewApiProviderError('New API 视频创建响应缺少 request_id', {
          code: 'VIDEO_REQUEST_ID_MISSING',
          requestId: submission.requestId,
          retryable: false,
        });
      }
      submissionUsage = parseProviderUsage(submission.payload);
      initialPhase = 'submitted';
    }
    const initialPayload = videoJobPayloadSummary(initialPhase, snapshot.modelAlias);
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
    await reportProgress?.(submittedProviderJob.progress ?? 5);

    let lastPoll: VideoPollResult | undefined;
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      const waitMs = videoPollDelay(this.pollIntervalMs, attempt);
      if (waitMs > 0) await delay(waitMs);
      try {
        const statusResponse = await this.requestJson(
          `${this.baseUrl}${this.videoJobsPath}/${encodeURIComponent(platformJobId)}`,
          'GET',
        );
        lastPoll = parseVideoPollResult(statusResponse.payload);
        const statusPayload = videoJobPayloadSummary(
          lastPoll.status === 'succeeded' ? 'completed' : 'polling',
          snapshot.modelAlias,
          lastPoll.providerStatus,
          lastPoll.status === 'succeeded' ? 100 : lastPoll.progress,
        );
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
      } catch (error) {
        if (!(error instanceof NewApiProviderError) && lastPoll && onProviderJob) {
          const statusPayload = videoJobPayloadSummary(
            'polling',
            snapshot.modelAlias,
            lastPoll.providerStatus,
            lastPoll.progress,
          );
          throw new NewApiProviderError('视频任务状态持久化失败', {
            code: 'VIDEO_JOB_PERSISTENCE_FAILED',
            platformJobId,
            providerPayload: statusPayload,
            retryable: false,
          });
        }
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
            'polling',
            snapshot.modelAlias,
            lastPoll?.providerStatus,
            lastPoll?.progress,
          ),
        );
      }

      if (lastPoll.status === 'failed' || lastPoll.status === 'cancelled') {
        throw new NewApiProviderError(
          lastPoll.error ??
            `New API 视频任务${lastPoll.status === 'cancelled' ? '已取消' : '失败'}`,
          {
            code:
              lastPoll.status === 'cancelled'
                ? 'VIDEO_GENERATION_CANCELLED'
                : 'VIDEO_GENERATION_FAILED',
            platformJobId,
            providerPayload: videoJobPayloadSummary(
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
          output = await this.videoOutput(platformJobId, lastPoll);
        } catch (error) {
          throw videoJobError(
            error,
            platformJobId,
            videoJobPayloadSummary('completed', snapshot.modelAlias, lastPoll.providerStatus, 100),
          );
        }
        const usage = lastPoll.usage ?? submissionUsage;
        await reportProgress?.(100);
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
              'completed',
              snapshot.modelAlias,
              lastPoll.providerStatus,
              100,
            ),
          },
          ...(usage ? { usage } : {}),
        };
      }

      const progress = Math.max(
        5,
        Math.min(95, lastPoll.progress || Math.round((attempt / this.maxPollAttempts) * 90)),
      );
      await reportProgress?.(progress);
    }

    throw new NewApiProviderError('New API 视频任务轮询超时', {
      code: 'VIDEO_POLL_TIMEOUT',
      platformJobId,
      providerPayload: videoJobPayloadSummary(
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
  ): Promise<VideoProviderOutput> {
    const rawUrl = poll.outputUrl;
    if (rawUrl) {
      const dataUrl = parseDataUrl(rawUrl);
      if (dataUrl?.mimeType.startsWith('video/')) {
        return {
          mediaType: 'video',
          kind: 'base64',
          base64: dataUrl.base64,
          mimeType: dataUrl.mimeType,
          format: formatFromMimeType(dataUrl.mimeType),
        };
      }

      const remoteUrl = providerRemoteUrl(rawUrl);
      if (remoteUrl && !this.isProtectedProviderUrl(remoteUrl)) {
        const mimeType = videoMimeTypeFromUrl(remoteUrl);
        return {
          mediaType: 'video',
          kind: 'url',
          url: remoteUrl,
          mimeType,
          format: formatFromMimeType(mimeType),
        };
      }
    }

    const contentUrl = this.protectedContentUrl(platformJobId, rawUrl);
    const content = await this.requestBinary(contentUrl);
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
    return `${this.baseUrl}${this.videoJobsPath}/${encodeURIComponent(platformJobId)}/content`;
  }

  private isProtectedProviderUrl(rawUrl: string): boolean {
    try {
      return new URL(rawUrl).origin === new URL(this.baseUrl).origin;
    } catch {
      return true;
    }
  }

  private async requestJson(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ payload: Record<string, unknown>; requestId?: string }> {
    const response = await this.fetchResponse(url, {
      method,
      redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' && idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });
    const payload = await readResponsePayload(response, this.maxResponseBytes);
    if (!response.ok) throw providerResponseError(response, payload);
    if (!isRecord(payload) || isBinaryResponsePayload(payload)) {
      throw new NewApiProviderError('New API 视频响应不是有效 JSON', {
        requestId: responseRequestId(response),
        retryable: false,
      });
    }
    return { payload, requestId: responseRequestId(response) };
  }

  private async requestBinary(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const response = await this.fetchResponse(url, {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'video/*,*/*' },
    });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxContentBytes) {
      throw new NewApiProviderError('New API 视频内容超过归档大小限制', {
        code: 'VIDEO_CONTENT_TOO_LARGE',
        retryable: false,
      });
    }
    const payload = await readResponsePayload(response, this.maxContentBytes);
    if (!response.ok) throw providerResponseError(response, payload);
    if (!isBinaryResponsePayload(payload) || payload.bytes.byteLength === 0) {
      throw new NewApiProviderError('New API 视频下载响应不包含二进制内容', {
        requestId: responseRequestId(response),
        retryable: false,
      });
    }
    if (payload.bytes.byteLength > this.maxContentBytes) {
      throw new NewApiProviderError('New API 视频内容超过归档大小限制', {
        code: 'VIDEO_CONTENT_TOO_LARGE',
        retryable: false,
      });
    }
    const mimeType = normalizedMimeType(payload.mimeType);
    return {
      bytes: payload.bytes,
      mimeType: mimeType?.startsWith('video/') ? mimeType : 'video/mp4',
    };
  }

  private async fetchResponse(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    } catch (error) {
      const isTimeout = getErrorName(error) === 'AbortError';
      throw new NewApiProviderError(
        isTimeout
          ? 'New API 请求超时'
          : error instanceof Error
            ? error.message
            : 'New API 请求失败',
        { code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true },
      );
    } finally {
      clearTimeout(timeout);
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

function normalizeVideoPath(value: string): string {
  const path = value.trim().replace(/\/$/, '');
  if (!path.startsWith('/') || path.includes('..') || /[?#\\]/.test(path)) {
    throw new TypeError('videoPath 必须是安全的绝对路径');
  }
  return path || '/videos';
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }
  return resolved;
}

/**
 * Use the worker's durable per-node identity whenever it is available. The
 * fallback deliberately contains no prompt, credential, or media data, so a
 * direct provider caller still gets a stable and non-sensitive request key.
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function videoPollDelay(baseMilliseconds: number, attempt: number): number {
  if (baseMilliseconds === 0) return 0;
  // Increase every 30 polls and cap at 4x. With the 2s/120 defaults this
  // covers about ten minutes without an unbounded sleep interval.
  const multiplier = Math.min(4, 1 + Math.floor((Math.max(1, attempt) - 1) / 30));
  return baseMilliseconds * multiplier;
}

function videoJobPayloadSummary(
  phase: 'submitted' | 'resumed' | 'polling' | 'completed' | 'failed',
  modelAlias: string,
  providerStatus?: string,
  progress?: number,
): Record<string, unknown> {
  return {
    contract: 'newapi-video-v1',
    phase,
    modelAlias,
    ...(providerStatus ? { providerStatus } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

function videoPayload(
  snapshot: RunSnapshot,
  label: string,
  nodePrompt?: string,
  inputs: VideoInputMapping = mapVideoInputs(snapshot),
): Record<string, unknown> {
  const parameters = snapshot.parameters;
  const payload: Record<string, unknown> = {
    model: snapshot.modelAlias,
    prompt: resolveMappedPromptInput(
      resolvePromptSource(snapshot, label, nodePrompt, 'video'),
      inputs.prompt,
      'video',
    ),
  };
  const duration = parameters.duration;
  if (typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0) {
    payload.duration = duration;
  }
  const resolution = normalizeErrorField(parameters.resolution);
  if (resolution) payload.resolution = resolution;
  const aspectRatio = normalizeErrorField(parameters.aspect_ratio ?? parameters.aspectRatio);
  if (aspectRatio) payload.aspect_ratio = aspectRatio;
  if (inputs.firstFrame) payload.image = { url: inputImageUrl(inputs.firstFrame, 'video') };
  return payload;
}

function providerVideoReferenceUrl(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  const candidate = value.trim();
  if (/^data:image\/[^;,\s]+;base64,/i.test(candidate)) return candidate;
  return providerRemoteUrl(candidate);
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

function parseVideoPollResult(payload: Record<string, unknown>): VideoPollResult {
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
  const rawProgress = payload.progress ?? data?.progress;
  const progress =
    typeof rawProgress === 'number' && Number.isFinite(rawProgress)
      ? Math.round(Math.max(0, Math.min(100, rawProgress <= 1 ? rawProgress * 100 : rawProgress)))
      : 0;
  const errorDetails = extractProviderError(payload);
  const error =
    errorDetails.message ??
    normalizeErrorField(payload.failure_reason ?? data?.failure_reason ?? payload.reason);
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

function providerResponseError(response: Response, payload: unknown): NewApiProviderError {
  const providerError = extractProviderError(payload);
  return new NewApiProviderError(
    providerError.message ?? `New API 请求失败（${response.status}）`,
    {
      status: response.status,
      code: providerError.code,
      requestId: providerError.requestId ?? responseRequestId(response),
      retryable: isRetryableStatus(response.status),
    },
  );
}

function videoJobError(
  error: unknown,
  platformJobId: string,
  providerPayload: Record<string, unknown>,
): NewApiProviderError {
  if (error instanceof NewApiProviderError) {
    return new NewApiProviderError(error.message, {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      platformJobId,
      providerPayload,
      retryable: error.retryable,
    });
  }
  return new NewApiProviderError(
    error instanceof Error ? error.message : 'New API 视频任务处理失败',
    {
      code: 'VIDEO_JOB_ERROR',
      platformJobId,
      providerPayload,
      retryable: false,
    },
  );
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

function extractProviderError(payload: unknown): ExtractedProviderError {
  if (!isRecord(payload)) return {};
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const message =
    normalizeErrorField(nested?.message) ??
    (typeof payload.error === 'string' ? normalizeErrorField(payload.error) : undefined) ??
    normalizeErrorField(payload.message);
  const code =
    normalizeErrorField(nested?.code) ??
    normalizeErrorField(nested?.type) ??
    normalizeErrorField(payload.code) ??
    normalizeErrorField(payload.type);
  const requestId =
    normalizeErrorField(nested?.request_id) ??
    normalizeErrorField(nested?.requestId) ??
    normalizeErrorField(payload.request_id) ??
    normalizeErrorField(payload.requestId);
  return { message, code, requestId };
}

function responseRequestId(response: Response): string | undefined {
  const headers = (response as Response & { headers?: Headers }).headers;
  for (const name of ['x-request-id', 'x-requestid', 'request-id', 'openai-request-id']) {
    const value = headers?.get?.(name);
    if (nonEmptyString(value)) return value.trim();
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

function parseDataUrl(value: string): { base64: string; mimeType: string } | undefined {
  const match = /^data:([^;,\s]+)?;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match || !match[2]) return undefined;
  return {
    base64: match[2],
    mimeType: normalizedMimeType(match[1]) ?? 'application/octet-stream',
  };
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
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new NewApiProviderError('New API 文本响应缺少 choices[0] 内容');
  }
  const choice = payload.choices[0];
  if (!isRecord(choice)) throw new NewApiProviderError('New API 文本响应格式无效');

  const message = isRecord(choice.message) ? choice.message.content : undefined;
  const content =
    extractTextContent(message) ?? (nonEmptyString(choice.text) ? choice.text : undefined);
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
  const explicitMimeType = normalizedMimeType(
    response?.mime_type ??
      response?.mimeType ??
      response?.content_type ??
      response?.contentType ??
      item.mime_type ??
      item.mimeType ??
      item.content_type ??
      item.contentType,
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
      return {
        mediaType: 'image',
        kind: 'base64',
        base64: dataUrl.base64,
        mimeType: dataUrl.mimeType.startsWith('image/') ? dataUrl.mimeType : mimeType,
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
    return {
      mediaType: 'image',
      kind: 'base64',
      base64: dataUrl?.base64 ?? base64.trim(),
      mimeType: dataUrl?.mimeType.startsWith('image/') ? dataUrl.mimeType : mimeType,
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
    const detectedMimeType = normalizedMimeType(payload.mimeType);
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
    normalizedMimeType(item.mime_type ?? item.mimeType ?? item.content_type ?? item.contentType) ??
    audioMimeType(format);
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
      return {
        mediaType: 'audio',
        kind: 'base64',
        base64: dataUrl.base64,
        mimeType: dataUrl.mimeType.startsWith('audio/') ? dataUrl.mimeType : mimeType,
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
          normalizedMimeType(
            item.mime_type ?? item.mimeType ?? item.content_type ?? item.contentType,
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
    return {
      mediaType: 'audio',
      kind: 'base64',
      base64: dataUrl?.base64 ?? base64.trim(),
      mimeType: dataUrl?.mimeType.startsWith('audio/') ? dataUrl.mimeType : mimeType,
      format: format ?? formatFromMimeType(dataUrl?.mimeType),
    };
  }
  throw new NewApiProviderError('New API 音频响应缺少 url 或 base64 内容');
}

function firstMediaItem(payload: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(payload)) {
    const first = payload[0];
    if (isRecord(first)) return first;
    if (nonEmptyString(first)) return { data: first };
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  for (const key of ['data', 'images', 'output', 'results']) {
    const collection = payload[key];
    if (Array.isArray(collection)) {
      const first = collection[0];
      if (isRecord(first)) return first;
      if (nonEmptyString(first)) return { data: first };
    }
  }
  return payload;
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

async function readResponsePayload(
  response: Response,
  maxBytes = defaultResponseContentLimit,
): Promise<unknown> {
  const headers = (response as Response & { headers?: Headers }).headers;
  const mimeType = normalizedMimeType(headers?.get?.('content-type'));
  const declaredLength = Number(headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new NewApiProviderError('New API 响应超过大小限制', {
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  if (typeof response.arrayBuffer !== 'function') {
    return response.json().catch(() => ({}));
  }
  const bytes = await readResponseBytes(response, maxBytes);
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

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new NewApiProviderError('New API 响应超过大小限制', {
            code: 'RESPONSE_TOO_LARGE',
            retryable: false,
          });
        }
        chunks.push(chunk);
      }
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

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new NewApiProviderError('New API 响应超过大小限制', {
      code: 'RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  return bytes;
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
  const { inferenceStrength, prompt: _prompt, ...providerParameters } = parameters;
  if (
    mediaType === 'text' &&
    (inferenceStrength === 'low' || inferenceStrength === 'medium' || inferenceStrength === 'high')
  ) {
    providerParameters.reasoning_effort = inferenceStrength;
  }
  return providerParameters;
}

type PromptSource = {
  value: string;
  /** A configured node/parameter prompt, as opposed to a display-label fallback. */
  explicit: boolean;
};

type VideoInputMapping = {
  prompt?: RunInputSnapshot;
  firstFrame?: RunInputSnapshot;
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
): PromptSource {
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
): string {
  let promptInput: RunInputSnapshot | undefined;
  for (const input of orderedRunInputs(snapshot)) {
    if (input.role !== 'prompt') throw unsupportedInputRoleError(mediaType, input.role);
    if (promptInput) throw inputRoleCardinalityError(mediaType, 'prompt');
    promptInput = input;
  }

  return resolveMappedPromptInput(
    resolvePromptSource(snapshot, label, nodePrompt, mediaType),
    promptInput,
    mediaType,
  );
}

function resolveMappedPromptInput(
  prompt: PromptSource,
  input: RunInputSnapshot | undefined,
  mediaType: 'image' | 'audio' | 'video',
): string {
  if (!input) return prompt.value;
  if (prompt.explicit) throw inputRoleConflictError(mediaType, 'prompt');
  return inputTextValue(input, mediaType);
}

function mapVideoInputs(snapshot: RunSnapshot): VideoInputMapping {
  const mapping: VideoInputMapping = {};
  for (const input of orderedRunInputs(snapshot)) {
    if (input.role === 'prompt') {
      if (mapping.prompt) throw inputRoleCardinalityError('video', 'prompt');
      mapping.prompt = input;
      continue;
    }
    if (input.role === 'firstFrame') {
      if (mapping.firstFrame) throw inputRoleCardinalityError('video', 'firstFrame');
      mapping.firstFrame = input;
      continue;
    }
    throw unsupportedInputRoleError('video', input.role);
  }
  return mapping;
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
  return new NewApiProviderError(
    `New API ${mediaType} 不支持该输入角色：${role}${detail ? `（${detail}）` : ''}`,
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

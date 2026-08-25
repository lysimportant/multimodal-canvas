import type { MediaType, RunResult, RunSnapshot } from '@multimodal-canvas/domain';

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
  fetchImpl?: typeof fetch;
};

export type NewApiProviderRequest = MockProviderRequest;

/**
 * Provider-neutral representation of a generated payload.
 *
 * Providers may return a remote URL or inline base64 data for binary media;
 * the worker owns persistence and turns either representation into an asset.
 * Text is kept as UTF-8 text so it does not need a data URL round trip.
 */
export type ProviderOutput =
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

type ImageProviderOutput = Extract<ProviderOutput, { kind: 'url' | 'base64' }> & {
  mediaType: 'image';
};

type AudioProviderOutput = Extract<ProviderOutput, { kind: 'url' | 'base64' }> & {
  mediaType: 'audio';
};

/**
 * Result envelope used by providers that return material generated content.
 * The `result` remains compatible with the domain RunResult contract while
 * `output` carries the bytes/text before the worker archives an asset.
 */
export type ProviderExecution = {
  result: RunResult;
  output: ProviderOutput;
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
  private readonly fetchImpl: typeof fetch;

  constructor(options: NewApiProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute({ snapshot, reportProgress }: NewApiProviderRequest): Promise<ProviderExecution> {
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType === 'video') {
      throw new NewApiProviderError('video generation requires NewApiVideoProvider');
    }

    const response =
      target.data.mediaType === 'text'
        ? await this.request(
            '/chat/completions',
            this.textPayload(snapshot, target.data.label, target.data.prompt),
          )
        : target.data.mediaType === 'image'
          ? await this.request(
              '/images/generations',
              this.imagePayload(snapshot, target.data.label, target.data.prompt),
            )
          : await this.request(
              '/audio/speech',
              this.audioPayload(snapshot, target.data.label, target.data.prompt),
            );
    const output =
      target.data.mediaType === 'text'
        ? parseTextOutput(response)
        : target.data.mediaType === 'image'
          ? parseImageOutput(response, snapshot)
          : parseAudioOutput(response, snapshot);
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
    };
  }

  private textPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      messages: [{ role: 'user', content: composePrompt(snapshot, label, nodePrompt) }],
    };
  }

  private imagePayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      prompt: composePrompt(snapshot, label, nodePrompt),
      n: 1,
    };
  }

  private audioPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      input: composePrompt(snapshot, label, nodePrompt),
    };
  }

  private async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readResponsePayload(response);
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

/** Placeholder boundary for the provider-specific asynchronous video contract. */
export class NewApiVideoProvider {
  async execute(_request: NewApiProviderRequest): Promise<never> {
    throw new NewApiProviderError(
      'New API 视频接口契约尚未配置；请继续使用 Mock Provider 或提供视频 API 契约',
    );
  }
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

async function readResponsePayload(response: Response): Promise<unknown> {
  const headers = (response as Response & { headers?: Headers }).headers;
  const mimeType = normalizedMimeType(headers?.get?.('content-type'));
  if (typeof response.arrayBuffer !== 'function') {
    return response.json().catch(() => ({}));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
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

function composePrompt(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
  const parameterPrompt = snapshot.parameters.prompt;
  const prompt =
    typeof parameterPrompt === 'string' && parameterPrompt.trim().length > 0
      ? parameterPrompt.trim()
      : typeof nodePrompt === 'string' && nodePrompt.trim().length > 0
        ? nodePrompt.trim()
        : label;
  const references = [...snapshot.inputs]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((input) => {
      const data = input.snapshot.data;
      const reference = data.contentUrl ?? data.assetId ?? data.label;
      return `${input.role}: ${reference}`;
    });
  return [prompt, ...references].join('\n');
}

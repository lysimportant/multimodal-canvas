import { Buffer } from 'node:buffer';
import type { MediaType } from '@multimodal-canvas/domain';

/**
 * Provider-neutral output contract. Provider-specific response fields are
 * converted to this shape before they cross into the worker lifecycle.
 *
 * `kind` describes how binary content is carried, while `mediaType` describes
 * the actual generated media. This keeps URL/base64 handling independent of
 * the upstream provider.
 */
export type ProviderTextOutput = {
  mediaType: 'text';
  kind: 'text';
  text: string;
  mimeType: string;
  format?: string;
};

export type ProviderBinaryOutput =
  | {
      mediaType: 'image' | 'audio' | 'video';
      kind: 'url';
      url: string;
      mimeType: string;
      format?: string;
    }
  | {
      mediaType: 'image' | 'audio' | 'video';
      kind: 'base64';
      base64: string;
      mimeType: string;
      format?: string;
    };

export type ProviderOutput = ProviderTextOutput | ProviderBinaryOutput;

/** Input contract for a ResultAssetArchiver implementation. */
export type ResultAssetArchiveInput = {
  mediaType: MediaType;
  mimeType: string;
  /** In-memory content for text and inline base64 provider responses. */
  content?: Buffer;
  /** A short-lived/provider URL that the archiver may fetch server-side. */
  contentUrl?: string;
  metadata?: Record<string, unknown>;
};

export class ProviderOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderOutputError';
  }
}

/**
 * Converts a normalized provider output (or a raw OpenAI-compatible response)
 * into the small output contract consumed by the worker. Unknown/absent output
 * is represented by `undefined`; malformed output that explicitly declares a
 * kind throws so a run cannot be reported successful with an unusable asset.
 */
export function normalizeProviderOutput(
  value: unknown,
  expectedMediaType?: MediaType,
): ProviderOutput | undefined {
  if (value === undefined || value === null) return undefined;

  if (value instanceof Uint8Array) {
    if (
      expectedMediaType !== 'image' &&
      expectedMediaType !== 'audio' &&
      expectedMediaType !== 'video'
    )
      return undefined;
    if (value.byteLength === 0) throw new ProviderOutputError('provider binary output is empty');
    return {
      mediaType: expectedMediaType,
      kind: 'base64',
      base64: Buffer.from(value).toString('base64'),
      mimeType: defaultMimeType(expectedMediaType),
    };
  }

  const record = asRecord(value);
  if (record && typeof record.kind === 'string') {
    const normalized = normalizeDeclaredOutput(record);
    assertExpectedMediaType(normalized, expectedMediaType);
    return normalized;
  }

  // A raw string is only unambiguous for a text target. Binary providers must
  // return an explicit URL or base64 field.
  if (typeof value === 'string') {
    if (expectedMediaType !== 'text') return undefined;
    if (value.trim().length === 0) throw new ProviderOutputError('text provider output is empty');
    return { mediaType: 'text', kind: 'text', text: value, mimeType: 'text/plain', format: 'txt' };
  }

  if (!record) return undefined;

  if (expectedMediaType === 'text') {
    const text = extractText(record);
    if (text === undefined) return undefined;
    if (text.trim().length === 0) throw new ProviderOutputError('text provider output is empty');
    return {
      mediaType: 'text',
      kind: 'text',
      text,
      mimeType: textMimeType(record),
      format: 'txt',
    };
  }

  if (
    expectedMediaType === 'image' ||
    expectedMediaType === 'audio' ||
    expectedMediaType === 'video'
  ) {
    const output = extractBinary(record, expectedMediaType);
    if (!output) return undefined;
    assertExpectedMediaType(output, expectedMediaType);
    return output;
  }

  // Without a target media type, infer text first, then binary only when a
  // MIME hint is present. Ambiguous binary payloads are intentionally ignored.
  const text = extractText(record);
  if (text !== undefined) {
    if (text.trim().length === 0) throw new ProviderOutputError('text provider output is empty');
    return {
      mediaType: 'text',
      kind: 'text',
      text,
      mimeType: textMimeType(record),
      format: 'txt',
    };
  }
  const hintedKind = kindFromMime(recordMimeType(record));
  return hintedKind ? extractBinary(record, hintedKind) : undefined;
}

/**
 * Turns normalized output into an archiver input. Base64 is decoded here so
 * the API/storage boundary never has to understand provider encodings. URL
 * responses remain URLs and must be fetched by the server-side archiver.
 */
export function providerOutputToArchiveInput(
  value: unknown,
  expectedMediaType?: MediaType,
): ResultAssetArchiveInput | undefined {
  const output = normalizeProviderOutput(value, expectedMediaType);
  if (!output) return undefined;

  if (output.mediaType === 'text') {
    return {
      mediaType: 'text',
      mimeType: output.mimeType,
      content: Buffer.from(output.text, 'utf8'),
      ...(output.format ? { metadata: { format: output.format } } : {}),
    };
  }

  if (output.kind === 'base64') {
    return {
      mediaType: output.mediaType,
      mimeType: output.mimeType,
      content: decodeBase64(output.base64),
      ...(output.format ? { metadata: { format: output.format } } : {}),
    };
  }

  return {
    mediaType: output.mediaType,
    mimeType: output.mimeType,
    contentUrl: output.url,
    ...(output.format ? { metadata: { format: output.format } } : {}),
  };
}

/** Alias for call sites that describe this step as parsing. */
export const parseProviderOutput = normalizeProviderOutput;

function normalizeDeclaredOutput(record: Record<string, unknown>): ProviderOutput {
  const rawKind = String(record.kind).trim().toLowerCase();
  const declaredMediaType = normalizeMediaType(record.mediaType);

  // Canonical provider contract: text, url, or base64.
  if (rawKind === 'text') {
    const text = extractText(record);
    if (!text || text.trim().length === 0) {
      throw new ProviderOutputError('text provider output is empty');
    }
    if (declaredMediaType && declaredMediaType !== 'text') {
      throw new ProviderOutputError('text provider output has a non-text media type');
    }
    return {
      mediaType: 'text',
      kind: 'text',
      text,
      mimeType: textMimeType(record),
      format: firstString(record.format) ?? 'txt',
    };
  }

  if (rawKind === 'url' || rawKind === 'base64') {
    if (
      declaredMediaType !== 'image' &&
      declaredMediaType !== 'audio' &&
      declaredMediaType !== 'video'
    ) {
      throw new ProviderOutputError(
        'binary provider output must declare image, audio, or video mediaType',
      );
    }
    const output = normalizeBinaryOutput(record, declaredMediaType);
    // A `url` kind may contain a data: URL. It is normalized to inline
    // base64 so the archiver does not need to fetch a non-HTTP resource.
    if (rawKind === 'url' && output.kind !== 'url' && output.kind !== 'base64') {
      throw new ProviderOutputError('URL provider output does not contain a safe URL');
    }
    if (rawKind === 'base64' && output.kind !== 'base64') {
      throw new ProviderOutputError('base64 provider output does not contain valid base64');
    }
    return output;
  }

  // Backward-compatible legacy shape used by early worker experiments:
  // `{ kind: 'image'|'audio'|'video', url|base64, ... }`.
  if (rawKind === 'image' || rawKind === 'audio' || rawKind === 'video') {
    return normalizeBinaryOutput(record, rawKind);
  }
  throw new ProviderOutputError(`unsupported provider output kind: ${String(record.kind)}`);
}

function normalizeBinaryOutput(
  record: Record<string, unknown>,
  mediaType: 'image' | 'audio' | 'video',
): ProviderBinaryOutput {
  const mimeType =
    normalizeMimeType(recordMimeType(record), mediaType) ??
    defaultMimeType(
      mediaType,
      firstString(record.format, record.fileExtension, record.output_format, record.outputFormat),
    );
  const dataUrl = firstDataUrl(
    record.url,
    record.contentUrl,
    record.audioUrl,
    record.audio_url,
    record.videoUrl,
    record.video_url,
    record.outputUrl,
    record.output_url,
    nestedUrl(record.imageUrl),
    nestedUrl(record.image_url),
  );
  if (dataUrl) {
    if (
      dataUrl.mimeType !== 'application/octet-stream' &&
      !dataUrl.mimeType.startsWith(`${mediaType}/`)
    ) {
      throw new ProviderOutputError('provider data URL media type mismatch');
    }
    return {
      mediaType,
      kind: 'base64',
      base64: dataUrl.base64,
      mimeType: dataUrl.mimeType.startsWith(`${mediaType}/`) ? dataUrl.mimeType : mimeType,
      ...(dataUrl.format ? { format: dataUrl.format } : {}),
    };
  }
  const url = firstSafeUrl(
    record.url,
    record.contentUrl,
    record.audioUrl,
    record.audio_url,
    record.videoUrl,
    record.video_url,
    record.outputUrl,
    record.output_url,
    nestedUrl(record.imageUrl),
    nestedUrl(record.image_url),
  );
  const base64 = firstBase64(
    record.base64,
    record.b64_json,
    record.b64Json,
    record.audio,
    record.data,
  );
  const format = firstString(
    record.format,
    record.fileExtension,
    record.output_format,
    record.outputFormat,
  );
  if (!url && !base64) {
    throw new ProviderOutputError(`${mediaType} provider output has no URL or base64 content`);
  }
  return base64
    ? {
        mediaType,
        kind: 'base64',
        base64,
        mimeType,
        ...(format ? { format } : {}),
      }
    : {
        mediaType,
        kind: 'url',
        url: url as string,
        mimeType,
        ...(format ? { format } : {}),
      };
}

function extractBinary(
  record: Record<string, unknown>,
  mediaType: 'image' | 'audio' | 'video',
): ProviderBinaryOutput | undefined {
  const direct = hasBinaryFields(record);
  if (direct) return normalizeBinaryOutput(record, mediaType);

  const candidates = [record.data, record.images, record.output, record.result];
  for (const candidate of candidates) {
    const item = Array.isArray(candidate) ? candidate[0] : candidate;
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      if (typeof item === 'string') {
        return normalizeBinaryOutput({ ...record, data: item }, mediaType);
      }
      continue;
    }
    if (hasBinaryFields(itemRecord)) {
      return normalizeBinaryOutput({ ...record, ...itemRecord }, mediaType);
    }
  }
  return undefined;
}

function extractText(record: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'output_text', 'outputText', 'content']) {
    const value = record[key];
    if (typeof value === 'string') return value;
    const parts = textParts(value);
    if (parts !== undefined) return parts;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    const candidate = asRecord(choice);
    if (!candidate) continue;
    const message = asRecord(candidate.message);
    const messageText = message ? textParts(message.content) : undefined;
    if (messageText !== undefined) return messageText;
    if (typeof candidate.text === 'string') return candidate.text;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const outputParts = output.flatMap((item) => {
    const itemRecord = asRecord(item);
    return itemRecord ? [textParts(itemRecord.content), textParts(itemRecord.text)] : [];
  });
  const joined = outputParts.filter((part): part is string => part !== undefined).join('');
  return joined || undefined;
}

function textParts(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const object = asRecord(value);
  if (object) {
    if (typeof object.text === 'string') return object.text;
    if (typeof object.content === 'string') return object.content;
  }
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    const record = asRecord(part);
    if (!record) return [];
    if (typeof record.text === 'string') return [record.text];
    if (typeof record.content === 'string') return [record.content];
    return [];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

function hasBinaryFields(record: Record<string, unknown>): boolean {
  return [
    record.url,
    record.contentUrl,
    record.audioUrl,
    record.audio_url,
    record.videoUrl,
    record.video_url,
    record.outputUrl,
    record.output_url,
    record.imageUrl,
    record.image_url,
    record.base64,
    record.b64_json,
    record.b64Json,
    record.audio,
  ].some((value) => typeof value === 'string' || (value && typeof value === 'object'));
}

function nestedUrl(value: unknown): unknown {
  const record = asRecord(value);
  return record?.url;
}

function firstSafeUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const candidate = value.trim();
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password
      )
        return candidate;
    } catch {
      // Ignore malformed/relative URLs. Provider assets must be fetchable by
      // the server and therefore use an absolute HTTP(S) URL.
    }
  }
  return undefined;
}

function firstDataUrl(
  ...values: unknown[]
): { base64: string; mimeType: string; format?: string } | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = /^data:([^;,\s]+)?;base64,([\s\S]*)$/i.exec(value.trim());
    if (!match || !match[2]) continue;
    const bytes = decodeBase64(value);
    const mimeType = match[1]?.toLowerCase() || 'application/octet-stream';
    return {
      base64: bytes.toString('base64'),
      mimeType,
      ...(mimeType.includes('/') ? { format: mimeType.split('/')[1] } : {}),
    };
  }
  return undefined;
}

function firstBase64(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    try {
      decodeBase64(value);
      return value.trim();
    } catch {
      // Try the next provider field; malformed candidates are not exposed.
    }
  }
  return undefined;
}

function decodeBase64(value: string): Buffer {
  const trimmed = value.trim();
  const dataUri = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  const encoded = (dataUri?.[2] ?? trimmed).replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[a-z\d+/_-]*={0,2}$/i.test(encoded)) {
    throw new ProviderOutputError('provider base64 content is malformed');
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const content = Buffer.from(padded, 'base64');
  if (content.byteLength === 0) throw new ProviderOutputError('provider base64 content is empty');
  return content;
}

function recordMimeType(record: Record<string, unknown>): string | undefined {
  return firstString(record.mimeType, record.mime_type, record.contentType, record.content_type);
}

function textMimeType(record: Record<string, unknown>): string {
  const value = recordMimeType(record);
  return value?.toLowerCase().startsWith('text/') ? value : 'text/plain';
}

function normalizeMimeType(
  value: string | undefined,
  mediaType: 'image' | 'audio' | 'video',
): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'application/octet-stream') return undefined;
  if (!normalized.startsWith(`${mediaType}/`)) {
    throw new ProviderOutputError('provider output MIME type mismatch');
  }
  return value;
}

function kindFromMime(value: string | undefined): 'image' | 'audio' | 'video' | undefined {
  if (!value) return undefined;
  if (value.toLowerCase().startsWith('image/')) return 'image';
  if (value.toLowerCase().startsWith('audio/')) return 'audio';
  if (value.toLowerCase().startsWith('video/')) return 'video';
  return undefined;
}

function defaultMimeType(mediaType: 'image' | 'audio' | 'video', format?: string): string {
  const normalized = format?.toLowerCase().replace(/^\./, '');
  if (mediaType === 'image') {
    if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
    if (normalized === 'webp') return 'image/webp';
    if (normalized === 'gif') return 'image/gif';
    return 'image/png';
  }
  if (mediaType === 'audio') {
    if (normalized === 'aac') return 'audio/aac';
    if (normalized === 'flac') return 'audio/flac';
    if (normalized === 'opus') return 'audio/ogg';
    if (normalized === 'pcm') return 'audio/pcm';
    if (normalized === 'wav') return 'audio/wav';
    if (normalized === 'ogg' || normalized === 'oga') return 'audio/ogg';
    if (normalized === 'webm') return 'audio/webm';
    return 'audio/mpeg';
  }
  if (normalized === 'webm') return 'video/webm';
  if (normalized === 'mov' || normalized === 'quicktime') return 'video/quicktime';
  if (normalized === 'mpeg' || normalized === 'mpg') return 'video/mpeg';
  return 'video/mp4';
}

function normalizeMediaType(value: unknown): MediaType | undefined {
  return value === 'text' || value === 'image' || value === 'audio' || value === 'video'
    ? value
    : undefined;
}

function assertExpectedMediaType(output: ProviderOutput, expected?: MediaType): void {
  if (!expected || output.mediaType === expected) return;
  throw new ProviderOutputError(
    `provider output media type mismatch: expected ${expected}, received ${output.mediaType}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

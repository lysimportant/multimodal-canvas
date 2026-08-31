import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

export type WebhookEventPayload = Record<string, unknown>;

export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed';

export const DEFAULT_WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
export const MAX_WEBHOOK_ERROR_LENGTH = 2_000;

const MAX_WEBHOOK_PAYLOAD_DEPTH = 4;
const MAX_WEBHOOK_PAYLOAD_KEYS = 64;
const MAX_WEBHOOK_PAYLOAD_ITEMS = 64;
const MAX_WEBHOOK_PAYLOAD_STRING_LENGTH = 2_000;
const REDACTED_WEBHOOK_VALUE = '[REDACTED]';
const SENSITIVE_WEBHOOK_KEY =
  /(?:authorization|proxy[-_ ]?authorization|x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|credential)/i;
const URL_WEBHOOK_KEY = /(?:url|uri|href|location)/i;
const LARGE_WEBHOOK_VALUE_KEY = /(?:base64|data[-_ ]?url|binary|bytes)/i;

export type WebhookEventStoreOptions = {
  /** Injectable clock for deterministic tests and controlled deployments. */
  now?: () => Date;
  /** How long a worker owns an event before another worker may reclaim it. */
  leaseMs?: number;
  /** Injectable token source for deterministic tests. */
  createLeaseToken?: () => string;
};

export type WebhookClaimOptions = {
  now?: Date;
  leaseMs?: number;
};

export type WebhookEventClaim = {
  /** True when another attempt already owns or completed this event. */
  deduplicated: boolean;
  status: WebhookEventStatus;
  attempt: number;
  /** Only returned to the worker that owns processing. */
  leaseToken?: string;
  leaseExpiresAt?: Date;
};

export type WebhookEventTransition = {
  /** False for an idempotent duplicate or a stale lease owner. */
  applied: boolean;
  status: WebhookEventStatus;
  attempt: number;
};

export type WebhookEventSnapshot = {
  eventId: string;
  provider: string;
  payload: WebhookEventPayload;
  status: WebhookEventStatus;
  attempt: number;
  receivedAt: Date;
  processedAt?: Date;
  processingStartedAt?: Date;
  processingLeaseExpiresAt?: Date;
  lastError?: string;
};

export type WebhookEventStoreErrorCode = 'invalid_event' | 'invalid_options' | 'not_found';

export class WebhookEventStoreError extends Error {
  constructor(
    public readonly code: WebhookEventStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Durable webhook lifecycle boundary.
 *
 * `accept` remains as a compatibility wrapper for the current route. New
 * callers should claim an event, process it, and explicitly complete or fail
 * the claim so a failed handler can be retried.
 */
export interface WebhookEventStore {
  accept(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
  ): Promise<{ deduplicated: boolean }>;
  claim(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
    options?: WebhookClaimOptions,
  ): Promise<WebhookEventClaim>;
  markProcessed(eventId: string, leaseToken: string): Promise<WebhookEventTransition>;
  markFailed(eventId: string, leaseToken: string, error: unknown): Promise<WebhookEventTransition>;
  close?(): Promise<void>;
}

type InternalWebhookEvent = WebhookEventSnapshot & {
  processingToken?: string;
};

/** In-memory event store used by tests and local development without PostgreSQL. */
export class MemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<string, InternalWebhookEvent>();
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly createLeaseToken: () => string;

  constructor(options: WebhookEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = resolveLeaseMs(options.leaseMs);
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async accept(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
  ): Promise<{ deduplicated: boolean }> {
    const claim = await this.claim(eventId, provider, payload);
    return { deduplicated: claim.deduplicated };
  }

  async claim(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
    options: WebhookClaimOptions = {},
  ): Promise<WebhookEventClaim> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedProvider = normalizeProvider(provider);
    const now = resolveNow(this.now, options.now);
    const leaseMs = resolveLeaseMs(options.leaseMs ?? this.leaseMs);
    const existing = this.events.get(normalizedEventId);

    if (!existing) {
      const leaseToken = this.newLeaseToken();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      this.events.set(normalizedEventId, {
        eventId: normalizedEventId,
        provider: normalizedProvider,
        payload: sanitizeWebhookPayload(payload),
        status: 'processing',
        attempt: 1,
        receivedAt: new Date(now),
        processingStartedAt: new Date(now),
        processingLeaseExpiresAt: new Date(leaseExpiresAt),
        processingToken: leaseToken,
      });
      return {
        deduplicated: false,
        status: 'processing',
        attempt: 1,
        leaseToken,
        leaseExpiresAt,
      };
    }

    if (existing.status === 'processed' || existing.processedAt) {
      return claimFromSnapshot(existing, true);
    }

    if (
      existing.status === 'processing' &&
      existing.processingLeaseExpiresAt &&
      existing.processingLeaseExpiresAt.getTime() > now.getTime()
    ) {
      return claimFromSnapshot(existing, true);
    }

    const leaseToken = this.newLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    existing.status = 'processing';
    existing.attempt = Math.max(1, existing.attempt + 1);
    existing.processingStartedAt = new Date(now);
    existing.processingLeaseExpiresAt = new Date(leaseExpiresAt);
    existing.processingToken = leaseToken;
    existing.processedAt = undefined;
    existing.lastError = undefined;
    return {
      deduplicated: false,
      status: 'processing',
      attempt: existing.attempt,
      leaseToken,
      leaseExpiresAt,
    };
  }

  async markProcessed(eventId: string, leaseToken: string): Promise<WebhookEventTransition> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedLeaseToken = normalizeLeaseToken(leaseToken);
    const event = this.events.get(normalizedEventId);
    if (!event) throw new WebhookEventStoreError('not_found', 'webhook event not found');
    if (event.status === 'processed' || event.processedAt) {
      return transitionFromSnapshot(event, false);
    }

    const now = resolveNow(this.now);
    if (!ownsLease(event, normalizedLeaseToken, now)) {
      return transitionFromSnapshot(event, false);
    }

    event.status = 'processed';
    event.processedAt = new Date(now);
    event.processingToken = undefined;
    event.processingLeaseExpiresAt = undefined;
    event.lastError = undefined;
    return transitionFromSnapshot(event, true);
  }

  async markFailed(
    eventId: string,
    leaseToken: string,
    error: unknown,
  ): Promise<WebhookEventTransition> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedLeaseToken = normalizeLeaseToken(leaseToken);
    const event = this.events.get(normalizedEventId);
    if (!event) throw new WebhookEventStoreError('not_found', 'webhook event not found');
    if (event.status === 'processed' || event.processedAt) {
      return transitionFromSnapshot(event, false);
    }

    const now = resolveNow(this.now);
    if (!ownsLease(event, normalizedLeaseToken, now)) {
      return transitionFromSnapshot(event, false);
    }

    event.status = 'failed';
    event.processedAt = undefined;
    event.processingToken = undefined;
    event.processingLeaseExpiresAt = undefined;
    event.lastError = normalizeError(error);
    return transitionFromSnapshot(event, true);
  }

  async get(eventId: string): Promise<WebhookEventSnapshot | undefined> {
    const event = this.events.get(normalizeEventId(eventId));
    return event ? snapshotFromInternal(event) : undefined;
  }

  async close(): Promise<void> {
    this.events.clear();
  }

  private newLeaseToken(): string {
    return normalizeLeaseToken(this.createLeaseToken());
  }
}

type PrismaWebhookClient = Pick<PrismaClient, 'webhookEvent'>;

/** PostgreSQL-backed webhook lifecycle and idempotency store. */
export class PrismaWebhookEventStore implements WebhookEventStore {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly createLeaseToken: () => string;

  constructor(
    private readonly prisma: PrismaWebhookClient,
    options: WebhookEventStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = resolveLeaseMs(options.leaseMs);
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
  }

  async accept(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
  ): Promise<{ deduplicated: boolean }> {
    const claim = await this.claim(eventId, provider, payload);
    return { deduplicated: claim.deduplicated };
  }

  async claim(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
    options: WebhookClaimOptions = {},
  ): Promise<WebhookEventClaim> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedProvider = normalizeProvider(provider);
    const now = resolveNow(this.now, options.now);
    const leaseMs = resolveLeaseMs(options.leaseMs ?? this.leaseMs);
    const leaseToken = this.newLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventId: normalizedEventId,
          provider: normalizedProvider,
          payload: sanitizeWebhookPayload(payload) as Prisma.InputJsonValue,
          status: 'processing',
          attemptCount: 1,
          processingToken: leaseToken,
          processingStartedAt: now,
          processingLeaseExpiresAt: leaseExpiresAt,
        },
      });
      return {
        deduplicated: false,
        status: 'processing',
        attempt: 1,
        leaseToken,
        leaseExpiresAt,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }

    // updateMany is the compare-and-set primitive: PostgreSQL locks the row
    // and only a failed or expired processing attempt can be reclaimed.
    const reclaimed = await this.prisma.webhookEvent.updateMany({
      where: {
        eventId: normalizedEventId,
        OR: [
          { status: 'received', processedAt: null },
          { status: 'failed', processedAt: null },
          {
            status: 'processing',
            processedAt: null,
            processingLeaseExpiresAt: { lte: now },
          },
          { status: 'processing', processedAt: null, processingLeaseExpiresAt: null },
        ],
      },
      data: {
        status: 'processing',
        attemptCount: { increment: 1 },
        processingToken: leaseToken,
        processingStartedAt: now,
        processingLeaseExpiresAt: leaseExpiresAt,
        processedAt: null,
        lastError: null,
      },
    });

    const row = await this.findRow(normalizedEventId);
    if (!row) throw new WebhookEventStoreError('not_found', 'webhook event disappeared');
    const snapshot = mapPrismaRow(row);
    if (reclaimed.count === 1) {
      return {
        deduplicated: false,
        status: 'processing',
        attempt: snapshot.attempt,
        leaseToken,
        leaseExpiresAt,
      };
    }
    return claimFromSnapshot(snapshot, true);
  }

  async markProcessed(eventId: string, leaseToken: string): Promise<WebhookEventTransition> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedLeaseToken = normalizeLeaseToken(leaseToken);
    const now = resolveNow(this.now);
    const result = await this.prisma.webhookEvent.updateMany({
      where: {
        eventId: normalizedEventId,
        status: 'processing',
        processingToken: normalizedLeaseToken,
        processingLeaseExpiresAt: { gt: now },
      },
      data: {
        status: 'processed',
        processedAt: now,
        processingToken: null,
        processingLeaseExpiresAt: null,
        lastError: null,
      },
    });
    return this.transitionAfterUpdate(normalizedEventId, result.count === 1);
  }

  async markFailed(
    eventId: string,
    leaseToken: string,
    error: unknown,
  ): Promise<WebhookEventTransition> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedLeaseToken = normalizeLeaseToken(leaseToken);
    const now = resolveNow(this.now);
    const result = await this.prisma.webhookEvent.updateMany({
      where: {
        eventId: normalizedEventId,
        status: 'processing',
        processingToken: normalizedLeaseToken,
        processingLeaseExpiresAt: { gt: now },
      },
      data: {
        status: 'failed',
        processedAt: null,
        processingToken: null,
        processingLeaseExpiresAt: null,
        lastError: normalizeError(error),
      },
    });
    return this.transitionAfterUpdate(normalizedEventId, result.count === 1);
  }

  async get(eventId: string): Promise<WebhookEventSnapshot | undefined> {
    const row = await this.findRow(normalizeEventId(eventId));
    return row ? mapPrismaRow(row) : undefined;
  }

  private async findRow(eventId: string) {
    return this.prisma.webhookEvent.findUnique({ where: { eventId } });
  }

  private async transitionAfterUpdate(
    eventId: string,
    applied: boolean,
  ): Promise<WebhookEventTransition> {
    const row = await this.findRow(eventId);
    if (!row) throw new WebhookEventStoreError('not_found', 'webhook event not found');
    return transitionFromSnapshot(mapPrismaRow(row), applied);
  }

  private newLeaseToken(): string {
    return normalizeLeaseToken(this.createLeaseToken());
  }
}

function claimFromSnapshot(
  snapshot: WebhookEventSnapshot,
  deduplicated: boolean,
): WebhookEventClaim {
  return {
    deduplicated,
    status: snapshot.status,
    attempt: snapshot.attempt,
  };
}

function transitionFromSnapshot(
  snapshot: WebhookEventSnapshot,
  applied: boolean,
): WebhookEventTransition {
  return {
    applied,
    status: snapshot.status,
    attempt: snapshot.attempt,
  };
}

function snapshotFromInternal(event: InternalWebhookEvent): WebhookEventSnapshot {
  return {
    eventId: event.eventId,
    provider: event.provider,
    payload: sanitizeWebhookPayload(event.payload),
    status: event.status,
    attempt: event.attempt,
    receivedAt: new Date(event.receivedAt),
    ...(event.processedAt ? { processedAt: new Date(event.processedAt) } : {}),
    ...(event.processingStartedAt
      ? { processingStartedAt: new Date(event.processingStartedAt) }
      : {}),
    ...(event.processingLeaseExpiresAt
      ? { processingLeaseExpiresAt: new Date(event.processingLeaseExpiresAt) }
      : {}),
    ...(event.lastError ? { lastError: event.lastError } : {}),
  };
}

function mapPrismaRow(row: unknown): InternalWebhookEvent {
  const record = isRecord(row) ? row : {};
  const processedAt = toDate(record.processedAt);
  const status = normalizeStatus(record.status, processedAt);
  const attempt = normalizeAttempt(record.attemptCount, status);
  const receivedAt = toDate(record.receivedAt) ?? new Date(0);
  const processingStartedAt = toDate(record.processingStartedAt);
  const processingLeaseExpiresAt = toDate(record.processingLeaseExpiresAt);
  const processingToken =
    typeof record.processingToken === 'string' && record.processingToken
      ? record.processingToken
      : undefined;
  const lastError =
    typeof record.lastError === 'string' && record.lastError
      ? normalizeError(record.lastError)
      : undefined;

  return {
    eventId: typeof record.eventId === 'string' ? record.eventId : '',
    provider: typeof record.provider === 'string' ? record.provider : '',
    payload: isRecord(record.payload) ? sanitizeWebhookPayload(record.payload) : {},
    status,
    attempt,
    receivedAt,
    ...(processedAt ? { processedAt } : {}),
    ...(processingStartedAt ? { processingStartedAt } : {}),
    ...(processingLeaseExpiresAt ? { processingLeaseExpiresAt } : {}),
    ...(lastError ? { lastError } : {}),
    ...(processingToken ? { processingToken } : {}),
  };
}

function normalizeStatus(value: unknown, processedAt?: Date): WebhookEventStatus {
  if (processedAt) return 'processed';
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (
      normalized === 'received' ||
      normalized === 'processing' ||
      normalized === 'processed' ||
      normalized === 'failed'
    ) {
      return normalized;
    }
  }
  return 'received';
}

function normalizeAttempt(value: unknown, status: WebhookEventStatus): number {
  const attempt = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  return status === 'processed' ? Math.max(1, attempt) : attempt;
}

function ownsLease(event: InternalWebhookEvent, leaseToken: string, now: Date): boolean {
  return Boolean(
    event.status === 'processing' &&
    event.processingToken === leaseToken &&
    event.processingLeaseExpiresAt &&
    event.processingLeaseExpiresAt.getTime() > now.getTime(),
  );
}

function resolveNow(clock: () => Date, override?: Date): Date {
  const value = override ?? clock();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new WebhookEventStoreError('invalid_options', 'webhook clock returned an invalid date');
  }
  return date;
}

function resolveLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? DEFAULT_WEBHOOK_PROCESSING_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new WebhookEventStoreError(
      'invalid_options',
      'webhook processing lease must be a positive integer',
    );
  }
  return leaseMs;
}

function normalizeEventId(value: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new WebhookEventStoreError('invalid_event', 'webhook event id is required');
  return normalized;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new WebhookEventStoreError('invalid_event', 'webhook provider is required');
  return normalized;
}

function normalizeLeaseToken(value: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new WebhookEventStoreError('invalid_event', 'webhook lease token is required');
  return normalized;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = sanitizeWebhookString(message) || 'webhook processing failed';
  return normalized.slice(0, MAX_WEBHOOK_ERROR_LENGTH);
}

function clonePayload(payload: WebhookEventPayload): WebhookEventPayload {
  try {
    return structuredClone(payload);
  } catch {
    return { ...payload };
  }
}

/**
 * Webhook bodies are provider-controlled input. Keep diagnostic fields useful
 * while preventing credentials, signed URL material, and unbounded JSON from
 * crossing the durable event boundary.
 */
function sanitizeWebhookPayload(payload: WebhookEventPayload): WebhookEventPayload {
  const sanitized = sanitizeWebhookValue(payload, 0, new WeakSet<object>());
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeWebhookValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key = '',
): unknown {
  if (depth > MAX_WEBHOOK_PAYLOAD_DEPTH) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    if (SENSITIVE_WEBHOOK_KEY.test(key) || LARGE_WEBHOOK_VALUE_KEY.test(key)) {
      return REDACTED_WEBHOOK_VALUE;
    }
    return sanitizeWebhookString(value, URL_WEBHOOK_KEY.test(key));
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_WEBHOOK_PAYLOAD_ITEMS)
      .map((item) => sanitizeWebhookValue(item, depth + 1, seen, key))
      .filter((item): item is Exclude<typeof item, undefined> => item !== undefined);
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_WEBHOOK_PAYLOAD_KEYS)) {
    const sanitized = sanitizeWebhookValue(childValue, depth + 1, seen, childKey);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  seen.delete(value);
  return output;
}

function sanitizeWebhookString(value: string, urlField = false): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  if (urlField || /https?:\/\//i.test(normalized)) {
    return redactWebhookUrl(normalized).slice(0, MAX_WEBHOOK_PAYLOAD_STRING_LENGTH);
  }
  return normalized.slice(0, MAX_WEBHOOK_PAYLOAD_STRING_LENGTH);
}

function redactWebhookUrl(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      const queryIndex = rawUrl.search(/[?#]/);
      return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
    }
  });
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value);
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(value: unknown): boolean {
  return (
    value instanceof Prisma.PrismaClientKnownRequestError ||
    (isRecord(value) && value.code === 'P2002')
  );
}

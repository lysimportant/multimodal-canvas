/**
 * A deliberately small observability boundary shared by API and Worker.
 *
 * The application does not depend on a telemetry vendor. An adapter can map
 * these methods to OpenTelemetry spans and Sentry (or another error backend)
 * at process startup. The default implementation is a no-op, which keeps
 * local development and tests offline and prevents accidental data export.
 */
export type ObservabilityAttribute = string | number | boolean;
export type ObservabilityAttributes = Record<string, ObservabilityAttribute | undefined>;
export type SpanStatus = 'unset' | 'ok' | 'error';

export type ObservabilitySpan = {
  setAttribute(name: string, value: ObservabilityAttribute): void;
  recordException(error: unknown): void;
  end(status?: SpanStatus): void;
};

export type Observability = {
  startSpan(name: string, attributes?: ObservabilityAttributes): ObservabilitySpan;
  captureException(error: unknown, attributes?: ObservabilityAttributes): void;
};

const noopSpan: ObservabilitySpan = {
  setAttribute: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};

const noopObservability: Observability = {
  startSpan: () => noopSpan,
  captureException: () => undefined,
};

export function createNoopObservability(): Observability {
  return noopObservability;
}

export type ObservabilityLogger = {
  info(bindings: unknown, message?: string): void;
  error(bindings: unknown, message?: string): void;
};

export type ObservabilityExporterOptions = {
  service?: string;
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  sentryDsn?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/**
 * Vendor-neutral production adapter. Exporters are optional and fail closed:
 * telemetry delivery must never affect an API request or a worker job.
 * Endpoint values are read explicitly so tests and deployments can inject
 * them without coupling the application to a vendor SDK.
 */
export function createExportingObservability(
  options: ObservabilityExporterOptions = {},
): Observability {
  const service = options.service ?? process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas';
  const configuredOtlpEndpoint =
    options.otlpEndpoint !== undefined
      ? options.otlpEndpoint
      : process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const otlpEndpoint = normalizeOtlpEndpoint(configuredOtlpEndpoint);
  const sentryDsn = (options.sentryDsn ?? process.env.SENTRY_DSN)?.trim() || undefined;
  const otlpHeaders =
    options.otlpHeaders ??
    parseOtlpHeaders(
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS,
    );
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  if ((!otlpEndpoint && !sentryDsn) || typeof request !== 'function') {
    return createNoopObservability();
  }

  return {
    startSpan(name, attributes = {}) {
      const startedAt = safeNow(now);
      const traceId = randomHex(16);
      const spanId = randomHex(8);
      let ended = false;
      let status: SpanStatus = 'unset';
      let spanAttributes: ObservabilityAttributes = sanitizeAttributes(attributes);
      const exceptions: Array<{ name?: string; message: string }> = [];
      const span: ObservabilitySpan = {
        setAttribute(key, value) {
          if (!ended) spanAttributes = { ...spanAttributes, [key]: sanitizeAttribute(key, value) };
        },
        recordException(error) {
          if (ended) return;
          const serialized = serializeException(error);
          exceptions.push({ name: serialized.errorName, message: serialized.errorMessage });
          status = 'error';
        },
        end(finalStatus = status) {
          if (ended) return;
          ended = true;
          status = finalStatus;
          if (otlpEndpoint) {
            void sendOtlpSpan(request, otlpEndpoint, otlpHeaders, {
              traceId,
              spanId,
              name,
              service,
              startedAt,
              endedAt: safeNow(now),
              status,
              attributes: spanAttributes,
              exceptions,
            });
          }
          if (sentryDsn && exceptions.length > 0) {
            for (const exception of exceptions) {
              void sendSentryException(request, sentryDsn, service, exception, spanAttributes);
            }
          }
        },
      };
      return span;
    },
    captureException(error, attributes = {}) {
      const serialized = serializeException(error);
      const sanitizedAttributes = sanitizeAttributes(attributes);
      if (sentryDsn) {
        void sendSentryException(
          request,
          sentryDsn,
          service,
          { name: serialized.errorName, message: serialized.errorMessage },
          sanitizedAttributes,
        );
      }
      if (otlpEndpoint) {
        void sendOtlpSpan(request, otlpEndpoint, otlpHeaders, {
          traceId: randomHex(16),
          spanId: randomHex(8),
          name: 'exception',
          service,
          startedAt: safeNow(now),
          endedAt: safeNow(now),
          status: 'error',
          attributes: sanitizedAttributes,
          exceptions: [{ name: serialized.errorName, message: serialized.errorMessage }],
        });
      }
    },
  };
}

/** Select external exporters only when explicitly configured. */
export function createEnvironmentObservability(
  options: { logger?: ObservabilityLogger; service?: string } = {},
): Observability {
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const sentryDsn = process.env.SENTRY_DSN?.trim();
  if (otlpEndpoint || sentryDsn) {
    return createExportingObservability({
      service: options.service,
      otlpEndpoint,
      sentryDsn,
      otlpHeaders: parseOtlpHeaders(
        process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
    });
  }
  if (process.env.OBSERVABILITY_LOGGING === 'true' && options.logger) {
    return createLoggingObservability(options.logger, { service: options.service });
  }
  return createNoopObservability();
}

/**
 * Optional JSON logging adapter. It is intentionally opt-in and only emits
 * the attributes supplied by the caller; callers must not pass snapshots,
 * credentials, provider payloads, or user content as attributes.
 */
export function createLoggingObservability(
  logger: ObservabilityLogger,
  options: { enabled?: boolean; service?: string } = {},
): Observability {
  if (options.enabled === false) return noopObservability;
  const service = options.service ?? process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas';
  return {
    startSpan(name, attributes = {}) {
      const startedAt = performance.now();
      let ended = false;
      let status: SpanStatus = 'unset';
      let spanAttributes: ObservabilityAttributes = sanitizeAttributes(attributes);
      const span = {
        setAttribute(attributeName: string, value: ObservabilityAttribute) {
          if (!ended) {
            spanAttributes = {
              ...spanAttributes,
              [attributeName]: sanitizeAttribute(attributeName, value),
            };
          }
        },
        recordException(error: unknown) {
          if (ended) return;
          const details = serializeException(error);
          logger.error(
            {
              event: 'telemetry.span.exception',
              service,
              span: name,
              ...spanAttributes,
              ...details,
            },
            'observability span exception',
          );
          status = 'error';
        },
        end(finalStatus: SpanStatus = status) {
          if (ended) return;
          ended = true;
          logger.info(
            {
              event: 'telemetry.span',
              service,
              span: name,
              status: finalStatus,
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
              ...spanAttributes,
            },
            'observability span ended',
          );
        },
      } satisfies ObservabilitySpan;
      return span;
    },
    captureException(error, attributes = {}) {
      logger.error(
        {
          event: 'telemetry.exception',
          service,
          ...sanitizeAttributes(attributes),
          ...serializeException(error),
        },
        'observability exception',
      );
    },
  };
}

function serializeException(error: unknown): {
  errorName?: string;
  errorMessage: string;
} {
  let source: string;
  try {
    source = String(error instanceof Error ? error.message : error);
  } catch {
    source = 'Unknown exception';
  }
  let errorName: string | undefined;
  if (error instanceof Error) {
    try {
      errorName = redactSensitiveText(error.name).slice(0, 128);
    } catch {
      errorName = undefined;
    }
  }
  return {
    ...(errorName ? { errorName } : {}),
    errorMessage: redactSensitiveText(source).slice(0, 512),
  };
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function sanitizeAttributes(attributes: ObservabilityAttributes): ObservabilityAttributes {
  try {
    if (!attributes || typeof attributes !== 'object') return {};
    return Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, sanitizeAttribute(key, value)]),
    );
  } catch {
    return {};
  }
}

function sanitizeAttribute(
  key: string,
  value: ObservabilityAttribute | undefined,
): ObservabilityAttribute | undefined {
  if (value === undefined) return undefined;
  if (isSensitiveAttributeName(key)) return '[REDACTED]';
  return typeof value === 'string' ? redactSensitiveText(value).slice(0, 512) : value;
}

function isSensitiveAttributeName(key: string): boolean {
  return /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|credential)/i.test(
    key,
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(\"?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)\"?\s*[:=]\s*\"?)(?!Bearer\b)[^\"',;}\s]+/gi,
      '$1[REDACTED]',
    );
}

function normalizeOtlpEndpoint(value: string | undefined): string | undefined {
  const endpoint = value?.trim();
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1/traces')
      ? pathname || '/v1/traces'
      : `${pathname}/v1/traces`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseOtlpHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const rawName = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (!rawName || !rawValue || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(rawName)) continue;
    if (/[\r\n]/.test(rawValue)) continue;
    headers[decodeHeaderPart(rawName)] = decodeHeaderPart(rawValue);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function decodeHeaderPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  try {
    globalThis.crypto?.getRandomValues(values);
  } catch {
    // Fall back to deterministic non-zero bytes when a host crypto provider is unavailable.
  }
  if (values.every((value) => value === 0)) {
    for (let index = 0; index < values.length; index += 1) values[index] = (index * 53 + 17) % 256;
  }
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

type ExportSpan = {
  traceId: string;
  spanId: string;
  name: string;
  service: string;
  startedAt: number;
  endedAt: number;
  status: SpanStatus;
  attributes: ObservabilityAttributes;
  exceptions: Array<{ name?: string; message: string }>;
};

async function sendOtlpSpan(
  request: typeof globalThis.fetch,
  endpoint: string,
  headers: Record<string, string> | undefined,
  span: ExportSpan,
) {
  try {
    const attributes = Object.entries(span.attributes).flatMap(([key, value]) => {
      if (value === undefined) return [];
      const attributeValue =
        typeof value === 'boolean'
          ? { boolValue: value }
          : typeof value === 'number'
            ? { doubleValue: value }
            : { stringValue: value };
      return [{ key, value: attributeValue }];
    });
    for (const exception of span.exceptions) {
      attributes.push(
        { key: 'exception.message', value: { stringValue: exception.message } },
        ...(exception.name
          ? [{ key: 'exception.type', value: { stringValue: exception.name } }]
          : []),
      );
    }
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: span.service } }] },
          scopeSpans: [
            {
              scope: { name: 'multimodal-canvas' },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  name: span.name,
                  startTimeUnixNano: String(Math.round(span.startedAt * 1_000_000)),
                  endTimeUnixNano: String(Math.round(span.endedAt * 1_000_000)),
                  attributes,
                  status: { code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0 },
                },
              ],
            },
          ],
        },
      ],
    };
    await request(endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Telemetry is best-effort and must never affect the request path.
  }
}

async function sendSentryException(
  request: typeof globalThis.fetch,
  dsn: string,
  service: string,
  exception: { name?: string; message: string },
  attributes: ObservabilityAttributes,
) {
  try {
    const parsed = parseSentryDsn(dsn);
    if (!parsed) return;
    const eventId = randomHex(16);
    const envelope = [
      JSON.stringify({ event_id: eventId, dsn: parsed.dsn }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({
        event_id: eventId,
        platform: 'node',
        server_name: service,
        exception: {
          values: [
            {
              type: exception.name ?? 'Error',
              value: exception.message,
            },
          ],
        },
        tags: Object.fromEntries(
          Object.entries(attributes)
            .filter(([, value]) => typeof value === 'string')
            .slice(0, 20),
        ),
      }),
      '',
    ].join('\n');
    await request(parsed.storeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body: envelope,
    });
  } catch {
    // See sendOtlpSpan: error reporting must be isolated from application work.
  }
}

function parseSentryDsn(value: string): { storeUrl: string; dsn: string } | undefined {
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split('/').filter(Boolean);
    const projectId = pathSegments.pop()?.trim();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !projectId ||
      !url.hostname ||
      !url.username
    ) {
      return undefined;
    }
    const pathPrefix = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
    const sanitizedDsn = `${url.protocol}//${encodeURIComponent(url.username)}@${url.host}${pathPrefix}/${projectId}`;
    const serverRoot = `${url.protocol}//${url.host}${pathPrefix}`;
    return {
      storeUrl: `${serverRoot}/api/${projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(url.username)}`,
      dsn: sanitizedDsn,
    };
  } catch {
    return undefined;
  }
}

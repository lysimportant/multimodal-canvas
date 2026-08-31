import pino, { type Logger } from 'pino';

export type WorkerLogBindings = Record<string, unknown>;

const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_LOG_KEYS = new Set([
  'access_key',
  'access_token',
  'api_key',
  'authorization',
  'client_secret',
  'cookie',
  'id_token',
  'password',
  'private_key',
  'refresh_token',
  'secret',
  'secret_access_key',
  'set_cookie',
  'signature',
  'signed_url',
  'token',
]);

const SENSITIVE_LOG_KEY_PREFIXES = [...SENSITIVE_LOG_KEYS];

const SENSITIVE_ASSIGNMENT_PATTERN =
  /((?:"?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?key|key|value|token))?|password|private[_-]?key|cookie|set[_-]?cookie|signed[_-]?url|signature|token)"?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&\]]+)/gi;

const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /([?&](?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?key|key|value|token))?|password|private[_-]?key|cookie|set[_-]?cookie|signed[_-]?url|signature|token)=)[^&#\s,;}\]]+/gi;

const SENSITIVE_HEADER_PATTERN =
  /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?key|key|value|token))?|password|private[_-]?key|cookie|set[_-]?cookie|signed[_-]?url|signature|token)\s+)[^\s,;}\]]+/gi;

/**
 * Small logging boundary for the worker. Keeping this interface injectable lets
 * the run processor be tested without depending on stdout or a logging backend.
 */
export type WorkerLogger = {
  child(bindings: WorkerLogBindings): WorkerLogger;
  debug(bindings: unknown, message?: string): void;
  info(bindings: unknown, message?: string): void;
  warn(bindings: unknown, message?: string): void;
  error(bindings: unknown, message?: string): void;
};

const noopLogger: WorkerLogger = {
  child: () => noopLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createNoopWorkerLogger(): WorkerLogger {
  return noopLogger;
}

/** Keep provider/database error diagnostics useful without copying raw payloads into logs. */
export function serializeWorkerError(error: unknown): {
  errorName?: string;
  errorMessage: string;
} {
  const source = error instanceof Error ? error.message : String(error);
  return {
    ...(error instanceof Error ? { errorName: redactText(error.name) } : {}),
    errorMessage: redactText(source).slice(0, 512),
  };
}

/**
 * Redact arbitrary values before they reach Pino. Provider errors can contain
 * nested response metadata, so protecting only top-level fields is not enough.
 */
export function redactWorkerLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Date) return value;
  if (value instanceof URL) return redactText(value.toString());

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: redactText(value.name),
      message: redactText(value.message),
    };
    if (value.stack) result.stack = redactText(value.stack);

    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) result.cause = redactWorkerLogValue(cause, seen);

    for (const key of Object.keys(value)) {
      if (key === 'cause') continue;
      const entry = (value as unknown as Record<string, unknown>)[key];
      result[key] = isSensitiveLogKey(key) ? REDACTED_VALUE : redactWorkerLogValue(entry, seen);
    }
    return result;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactWorkerLogValue(entry, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveLogKey(key) ? REDACTED_VALUE : redactWorkerLogValue(entry, seen);
  }
  return result;
}

/**
 * Create a JSON logger for process stdout. Pino's redact list is deliberately
 * conservative because provider payloads can contain credentials when an
 * integration returns an upstream error. The worker only logs identifiers and
 * lifecycle metadata, never the run snapshot or usage metadata.
 */
export function createWorkerLogger(
  options: { level?: string; service?: string } = {},
): WorkerLogger {
  const base = pino({
    name: options.service ?? process.env.OTEL_SERVICE_NAME ?? 'multimodal-canvas-worker',
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'apiKey',
        'api_key',
        'authorization',
        'password',
        'secret',
        'clientSecret',
        'client_secret',
        'privateKey',
        'private_key',
        'accessToken',
        'access_token',
        'refreshToken',
        'refresh_token',
        'idToken',
        'id_token',
        'cookie',
        'setCookie',
        'set_cookie',
        'token',
        'headers.authorization',
        'credential.apiKey',
        'snapshot.credential.apiKey',
      ],
      censor: REDACTED_VALUE,
    },
  });
  return wrapLogger(base);
}

function wrapLogger(base: Logger): WorkerLogger {
  return {
    child: (bindings) =>
      wrapLogger(base.child(redactWorkerLogValue(bindings) as WorkerLogBindings)),
    debug: (bindings, message) =>
      base.debug(redactWorkerLogValue(bindings), redactOptionalText(message)),
    info: (bindings, message) =>
      base.info(redactWorkerLogValue(bindings), redactOptionalText(message)),
    warn: (bindings, message) =>
      base.warn(redactWorkerLogValue(bindings), redactOptionalText(message)),
    error: (bindings, message) =>
      base.error(redactWorkerLogValue(bindings), redactOptionalText(message)),
  };
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

  return (
    SENSITIVE_LOG_KEYS.has(normalized) ||
    SENSITIVE_LOG_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix + '_')) ||
    normalized.endsWith('_password') ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_token') ||
    normalized.endsWith('_api_key') ||
    normalized.endsWith('_private_key')
  );
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(SENSITIVE_QUERY_PARAMETER_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_HEADER_PATTERN, '$1[REDACTED]');
}

function redactOptionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactText(value);
}

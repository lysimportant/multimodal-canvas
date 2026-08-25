import pino, { type Logger } from 'pino';

export type WorkerLogBindings = Record<string, unknown>;

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
    ...(error instanceof Error ? { errorName: error.name } : {}),
    errorMessage: redactText(source).slice(0, 512),
  };
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
        'headers.authorization',
        'credential.apiKey',
        'snapshot.credential.apiKey',
      ],
      censor: '[REDACTED]',
    },
  });
  return wrapLogger(base);
}

function wrapLogger(base: Logger): WorkerLogger {
  return {
    child: (bindings) => wrapLogger(base.child(bindings)),
    debug: (bindings, message) => base.debug(bindings, message),
    info: (bindings, message) => base.info(bindings, message),
    warn: (bindings, message) => base.warn(bindings, message),
    error: (bindings, message) => base.error(bindings, message),
  };
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /("?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*["']?)[^"',;}\s]+/gi,
      '$1[REDACTED]',
    );
}

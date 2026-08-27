export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export type StartupConfigurationIssue = {
  variable: string;
  message: string;
};

export class StartupConfigurationError extends Error {
  constructor(
    service: string,
    public readonly issues: readonly StartupConfigurationIssue[],
  ) {
    super(
      `${service} cannot start in production: ${issues
        .map(({ variable, message }) => `${variable} ${message}`)
        .join('; ')}`,
    );
    this.name = 'StartupConfigurationError';
  }
}

/**
 * Lists configuration errors that would let the worker run without durable
 * persistence, object storage, or the New API provider in production.
 */
export function validateWorkerStartupConfiguration(
  environment: StartupEnvironment = process.env,
): StartupConfigurationIssue[] {
  if (environment.NODE_ENV !== 'production') return [];

  const issues: StartupConfigurationIssue[] = [];
  const databaseUrl = requireValue(environment, 'DATABASE_URL', issues);
  const redisUrl = requireValue(environment, 'REDIS_URL', issues);
  requireValue(environment, 'S3_BUCKET', issues);
  requireValue(environment, 'S3_REGION', issues);
  const newApiBaseUrl = requireValue(environment, 'NEW_API_BASE_URL', issues);
  requireValue(environment, 'AI_CREDENTIAL_ENCRYPTION_KEY', issues);

  if (databaseUrl) validateUrlProtocol(databaseUrl, 'DATABASE_URL', ['postgresql:'], issues);
  if (redisUrl) validateUrlProtocol(redisUrl, 'REDIS_URL', ['redis:', 'rediss:'], issues);
  if (newApiBaseUrl) {
    validateUrlProtocol(newApiBaseUrl, 'NEW_API_BASE_URL', ['https:'], issues);
  }

  const s3Endpoint = environment.S3_ENDPOINT?.trim();
  if (s3Endpoint) validateUrlProtocol(s3Endpoint, 'S3_ENDPOINT', ['http:', 'https:'], issues);
  validateS3CredentialPair(environment, issues);

  if (environment.WORKER_PROVIDER !== 'newapi') {
    issues.push({ variable: 'WORKER_PROVIDER', message: 'must be "newapi"' });
  }
  if (environment.RUN_SERVICE && environment.RUN_SERVICE !== 'bullmq') {
    issues.push({ variable: 'RUN_SERVICE', message: 'must be "bullmq" when configured' });
  }

  return issues;
}

/** Throws before the worker can select any mock or filesystem fallback. */
export function assertWorkerStartupConfiguration(
  environment: StartupEnvironment = process.env,
): void {
  const issues = validateWorkerStartupConfiguration(environment);
  if (issues.length > 0) throw new StartupConfigurationError('Worker', issues);
}

/**
 * Decides whether this process owns a BullMQ worker. Production validation is
 * deliberately evaluated first so RUN_SERVICE=memory cannot bypass it.
 */
export function shouldStartWorkerProcess(environment: StartupEnvironment = process.env): boolean {
  assertWorkerStartupConfiguration(environment);
  return environment.NODE_ENV !== 'test' && environment.RUN_SERVICE !== 'memory';
}

function requireValue(
  environment: StartupEnvironment,
  variable: string,
  issues: StartupConfigurationIssue[],
): string | undefined {
  const value = environment[variable]?.trim();
  if (!value) issues.push({ variable, message: 'is required' });
  return value;
}

function validateUrlProtocol(
  value: string,
  variable: string,
  protocols: string[],
  issues: StartupConfigurationIssue[],
): void {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) {
      issues.push({ variable, message: `must use ${protocols.join(' or ')}` });
    } else if (!url.hostname) {
      issues.push({ variable, message: 'must include a host' });
    }
  } catch {
    issues.push({ variable, message: 'must be a valid URL' });
  }
}

function validateS3CredentialPair(
  environment: StartupEnvironment,
  issues: StartupConfigurationIssue[],
): void {
  const accessKey = Boolean(environment.S3_ACCESS_KEY?.trim());
  const secretKey = Boolean(environment.S3_SECRET_KEY?.trim());
  // Both values may be absent when the SDK receives credentials from an IAM role.
  if (accessKey === secretKey) return;
  issues.push({
    variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
    message: 'must be configured together',
  });
}

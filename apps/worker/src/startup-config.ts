export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export type StartupConfigurationIssue = {
  variable: string;
  message: string;
};

const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_RESULT_ASSET_BYTES = 50 * 1024 * 1024;

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
  const encryptionSecret = environment.AI_CREDENTIAL_ENCRYPTION_KEY?.trim();
  validateCredentialEncryptionRotationConfiguration(environment, issues);
  // 持久化 Worker 从数据库按快照读取凭据；无完整持久化边界时才允许静态回退。
  const hasDurableCredentialStore = Boolean(databaseUrl && encryptionSecret);
  const newApiBaseUrl = hasDurableCredentialStore
    ? environment.NEW_API_BASE_URL?.trim()
    : requireValue(environment, 'NEW_API_BASE_URL', issues);
  if (!hasDurableCredentialStore) {
    requireValue(environment, 'NEW_API_API_KEY', issues);
  }
  requireValue(environment, 'AI_CREDENTIAL_ENCRYPTION_KEY', issues);

  if (databaseUrl) validateUrlProtocol(databaseUrl, 'DATABASE_URL', ['postgresql:'], issues);
  if (redisUrl) {
    validateUrlProtocol(redisUrl, 'REDIS_URL', ['redis:', 'rediss:'], issues, {
      requireTlsForNonLoopback: true,
      secureProtocols: ['rediss:'],
    });
  }
  if (newApiBaseUrl) {
    validateUrlProtocol(newApiBaseUrl, 'NEW_API_BASE_URL', ['https:'], issues, {
      rejectUserinfo: true,
      rejectQuery: true,
      rejectHash: true,
    });
  }

  const s3Endpoint = environment.S3_ENDPOINT?.trim();
  if (s3Endpoint) {
    validateUrlProtocol(s3Endpoint, 'S3_ENDPOINT', ['http:', 'https:'], issues, {
      requireTlsForNonLoopback: true,
    });
  }
  validateS3CredentialPair(environment, issues);

  if (environment.WORKER_PROVIDER !== 'newapi') {
    issues.push({ variable: 'WORKER_PROVIDER', message: 'must be "newapi"' });
  }
  if (environment.RUN_SERVICE && environment.RUN_SERVICE !== 'bullmq') {
    issues.push({ variable: 'RUN_SERVICE', message: 'must be "bullmq" when configured' });
  }

  validateByteLimitEnvironment(
    environment,
    'RESULT_ASSET_MAX_BYTES',
    MAX_RESULT_ASSET_BYTES,
    issues,
  );
  validateMediaToolConfiguration(environment, 'FFPROBE_ENABLED', 'FFPROBE_PATH', issues);

  for (const variable of [
    'NEW_API_TIMEOUT_MS',
    'NEW_API_MAX_RESPONSE_BYTES',
    'NEW_API_VIDEO_POLL_INTERVAL_MS',
    'NEW_API_VIDEO_MAX_POLL_ATTEMPTS',
    'NEW_API_VIDEO_MAX_CONTENT_BYTES',
  ]) {
    validatePositiveSafeInteger(environment, variable, issues);
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
  restrictions: {
    rejectUserinfo?: boolean;
    rejectQuery?: boolean;
    rejectHash?: boolean;
    requireTlsForNonLoopback?: boolean;
    secureProtocols?: readonly string[];
  } = {},
): void {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) {
      issues.push({ variable, message: `must use ${protocols.join(' or ')}` });
    } else if (!url.hostname) {
      issues.push({ variable, message: 'must include a host' });
    }
    if (restrictions.rejectUserinfo && (url.username || url.password)) {
      issues.push({ variable, message: 'must not include userinfo' });
    }
    if (restrictions.rejectQuery && url.search) {
      issues.push({ variable, message: 'must not include query parameters' });
    }
    if (restrictions.rejectHash && url.hash) {
      issues.push({ variable, message: 'must not include a fragment' });
    }
    const secureProtocols = restrictions.secureProtocols ?? ['https:'];
    if (
      restrictions.requireTlsForNonLoopback &&
      protocols.includes(url.protocol) &&
      url.hostname &&
      !secureProtocols.includes(url.protocol) &&
      !isLoopbackHostname(url.hostname)
    ) {
      const protocolLabel = secureProtocols
        .map((protocol) => (protocol === 'https:' ? 'HTTPS' : protocol))
        .join(' or ');
      issues.push({
        variable,
        message: `must use ${protocolLabel} in production unless the endpoint is loopback`,
      });
    }
  } catch {
    issues.push({ variable, message: 'must be a valid URL' });
  }
}

/** 仅允许回环地址使用明文本地依赖，避免把远程凭据经由 HTTP 传输。 */
function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    ) &&
    octets[0] === '127'
  );
}

function validateS3CredentialPair(
  environment: StartupEnvironment,
  issues: StartupConfigurationIssue[],
): void {
  const accessKey = Boolean(environment.S3_ACCESS_KEY?.trim());
  const secretKey = Boolean(environment.S3_SECRET_KEY?.trim());
  const customEndpoint = Boolean(environment.S3_ENDPOINT?.trim());
  // AWS deployments may use the SDK's default IAM role chain when no custom
  // endpoint is configured. MinIO and other custom endpoints do not provide
  // that role chain, so production requires an explicit credentials pair.
  if (accessKey && secretKey) return;
  if (!customEndpoint && !accessKey && !secretKey) return;
  if (customEndpoint && !accessKey && !secretKey) {
    issues.push({
      variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
      message: 'are required when S3_ENDPOINT is configured',
    });
    return;
  }
  issues.push({
    variable: 'S3_ACCESS_KEY/S3_SECRET_KEY',
    message: 'must be configured together',
  });
}

/** 校验 API/Worker 共用的凭据密钥轮换配置，避免 Worker 使用与 API 不兼容的历史 keyring。 */
function validateCredentialEncryptionRotationConfiguration(
  environment: StartupEnvironment,
  issues: StartupConfigurationIssue[],
): void {
  const keyId = environment.AI_CREDENTIAL_ENCRYPTION_KEY_ID;
  if (keyId !== undefined && !ENCRYPTION_KEY_ID_PATTERN.test(keyId.trim())) {
    issues.push({
      variable: 'AI_CREDENTIAL_ENCRYPTION_KEY_ID',
      message: 'must be a 1-64 character key identifier',
    });
  }
  const previous = environment.AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS;
  if (previous === undefined || !previous.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(previous);
  } catch {
    issues.push({
      variable: 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      message: 'must be a JSON object',
    });
    return;
  }
  if (!isStringRecord(parsed)) {
    issues.push({
      variable: 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      message: 'must be a JSON object with non-empty string values',
    });
    return;
  }
  const normalizedCurrentKeyId = keyId?.trim() || 'default';
  for (const [previousKeyId, secret] of Object.entries(parsed)) {
    if (!ENCRYPTION_KEY_ID_PATTERN.test(previousKeyId) || !secret.trim()) {
      issues.push({
        variable: 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
        message: 'must use valid key identifiers and non-empty string values',
      });
      return;
    }
    if (previousKeyId === normalizedCurrentKeyId) {
      issues.push({
        variable: 'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
        message: 'must not repeat AI_CREDENTIAL_ENCRYPTION_KEY_ID',
      });
      return;
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function validatePositiveSafeInteger(
  environment: StartupEnvironment,
  variable: string,
  issues: StartupConfigurationIssue[],
): void {
  const raw = environment[variable];
  if (raw === undefined) return;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    issues.push({ variable, message: 'must be a positive safe integer' });
    return;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    issues.push({ variable, message: 'must be a positive safe integer' });
  }
}

/** 校验结果资产的读取上限，防止非法值延迟到任务执行阶段才暴露。 */
function validateByteLimitEnvironment(
  environment: StartupEnvironment,
  variable: string,
  maxBytes: number,
  issues: StartupConfigurationIssue[],
): void {
  const raw = environment[variable];
  if (raw === undefined) return;
  const value = raw.trim();
  const message = `must be a positive safe integer no greater than ${maxBytes}`;
  if (!/^[0-9]+$/.test(value)) {
    issues.push({ variable, message });
    return;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxBytes) {
    issues.push({ variable, message });
  }
}

/** 校验可选媒体工具的开关和路径，避免生产环境因配置歧义静默降级。 */
function validateMediaToolConfiguration(
  environment: StartupEnvironment,
  enabledVariable: string,
  pathVariable: string,
  issues: StartupConfigurationIssue[],
): void {
  const enabled = environment[enabledVariable];
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    issues.push({ variable: enabledVariable, message: 'must be "true" or "false"' });
  }

  const path = environment[pathVariable];
  const normalizedPath = path?.trim();
  if (path !== undefined && !normalizedPath) {
    issues.push({ variable: pathVariable, message: 'must not be empty when configured' });
  }
  if (enabled === 'false' && normalizedPath) {
    issues.push({
      variable: enabledVariable,
      message: `cannot be "false" when ${pathVariable} is configured`,
    });
  }
}

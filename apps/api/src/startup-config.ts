export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export type StartupConfigurationIssue = {
  variable: string;
  message: string;
};

const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
 * Lists configuration errors that would make the API fall back to volatile
 * storage or a mock queue provider in production. Development and test stay
 * intentionally permissive so their explicit local fallbacks remain usable.
 */
export function validateApiStartupConfiguration(
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
  // PostgreSQL 凭据存储存在时，Provider 使用数据库中按运行快照解析的凭据；
  // 只有没有完整持久化边界时才要求静态环境变量作为明确回退路径。
  const hasDurableCredentialStore = Boolean(databaseUrl && encryptionSecret);
  const newApiBaseUrl = hasDurableCredentialStore
    ? environment.NEW_API_BASE_URL?.trim()
    : requireValue(environment, 'NEW_API_BASE_URL', issues);
  if (!hasDurableCredentialStore) {
    requireValue(environment, 'NEW_API_API_KEY', issues);
  }
  requireValue(environment, 'NEW_API_WEBHOOK_SECRET', issues);
  requireValue(environment, 'AI_CREDENTIAL_ENCRYPTION_KEY', issues);
  if (!environment.API_AUTH_TOKEN?.trim() && !environment.API_JWT_SECRET?.trim()) {
    issues.push({
      variable: 'API_AUTH_TOKEN/API_JWT_SECRET',
      message: 'one is required',
    });
  }

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

  if (
    environment.NEW_API_VIDEO_CONTRACT !== undefined &&
    !['newapi-unified-v1', 'legacy-v1'].includes(environment.NEW_API_VIDEO_CONTRACT)
  ) {
    issues.push({
      variable: 'NEW_API_VIDEO_CONTRACT',
      message: 'must be "newapi-unified-v1" or "legacy-v1"',
    });
  }

  if (environment.WORKER_PROVIDER !== 'newapi') {
    issues.push({ variable: 'WORKER_PROVIDER', message: 'must be "newapi"' });
  }
  if (environment.RUN_SERVICE && environment.RUN_SERVICE !== 'bullmq') {
    issues.push({ variable: 'RUN_SERVICE', message: 'must be "bullmq" when configured' });
  }
  if (environment.API_RATE_LIMIT_REDIS_ENABLED === 'false') {
    issues.push({
      variable: 'API_RATE_LIMIT_REDIS_ENABLED',
      message: 'cannot be "false" in production',
    });
  }
  validateCorsOrigins(environment, issues);

  validateMediaToolConfiguration(environment, 'FFPROBE_ENABLED', 'FFPROBE_PATH', issues);
  validateMediaToolConfiguration(environment, 'FFMPEG_ENABLED', 'FFMPEG_PATH', issues);

  validatePositiveIntegerEnvironment(environment, 'RUN_MAX_ACTIVE_PER_PROJECT', issues);
  validatePortEnvironment(environment, 'API_PORT', issues);
  validatePositiveIntegerEnvironment(environment, 'API_RATE_LIMIT_PER_MINUTE', issues);
  validatePositiveIntegerEnvironment(environment, 'API_AUTH_RATE_LIMIT_PER_MINUTE', issues);
  validatePositiveIntegerEnvironment(environment, 'API_SSE_RATE_LIMIT_PER_MINUTE', issues);
  validateByteLimitEnvironment(environment, 'API_BODY_LIMIT_BYTES', issues);
  validateByteLimitEnvironment(environment, 'API_SSE_MAX_BYTES', issues);
  validateByteLimitEnvironment(environment, 'API_SSE_MAX_EVENT_BYTES', issues);
  validatePositiveIntegerEnvironment(environment, 'NEW_API_TIMEOUT_MS', issues);
  validatePositiveIntegerEnvironment(environment, 'NEW_API_MAX_RESPONSE_BYTES', issues);
  validatePositiveIntegerEnvironment(environment, 'NEW_API_VIDEO_POLL_INTERVAL_MS', issues);
  validatePositiveIntegerEnvironment(environment, 'NEW_API_VIDEO_MAX_POLL_ATTEMPTS', issues);
  validatePositiveIntegerEnvironment(environment, 'NEW_API_VIDEO_MAX_CONTENT_BYTES', issues);

  return issues;
}

/** Throws before the production entrypoint creates any fallback-capable clients. */
export function assertApiStartupConfiguration(environment: StartupEnvironment = process.env): void {
  const issues = validateApiStartupConfiguration(environment);
  if (issues.length > 0) throw new StartupConfigurationError('API', issues);
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

function validatePositiveIntegerEnvironment(
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push({ variable, message: 'must be a positive safe integer' });
  }
}

/** 校验 API 监听端口，避免非法 TCP 端口在服务器已初始化后才失败。 */
function validatePortEnvironment(
  environment: StartupEnvironment,
  variable: string,
  issues: StartupConfigurationIssue[],
): void {
  const raw = environment[variable];
  if (raw === undefined) return;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    issues.push({ variable, message: 'must be a TCP port between 1 and 65535' });
    return;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    issues.push({ variable, message: 'must be a TCP port between 1 and 65535' });
  }
}

function validateByteLimitEnvironment(
  environment: StartupEnvironment,
  variable: string,
  issues: StartupConfigurationIssue[],
): void {
  const raw = environment[variable];
  if (raw === undefined) return;
  const value = raw.trim();
  if (!/^[0-9]+$/.test(value)) {
    issues.push({
      variable,
      message: `must be a positive safe integer no greater than ${MAX_UPLOAD_BYTES}`,
    });
    return;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_UPLOAD_BYTES) {
    issues.push({
      variable,
      message: `must be a positive safe integer no greater than ${MAX_UPLOAD_BYTES}`,
    });
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

/** 校验生产 CORS 来源只包含明确的 HTTPS origin，不允许把路径或凭据混入配置。 */
function validateCorsOrigins(
  environment: StartupEnvironment,
  issues: StartupConfigurationIssue[],
): void {
  const raw = environment.CORS_ORIGIN;
  if (raw === undefined || !raw.trim()) return;

  for (const candidate of raw.split(',')) {
    const origin = candidate.trim();
    if (!origin) {
      issues.push({ variable: 'CORS_ORIGIN', message: 'must not contain an empty origin' });
      continue;
    }
    if (origin === '*') {
      issues.push({
        variable: 'CORS_ORIGIN',
        message: 'must not include wildcard "*" when credentials are enabled',
      });
      continue;
    }
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:') {
        issues.push({ variable: 'CORS_ORIGIN', message: 'origins must use HTTPS in production' });
      }
      if (!url.hostname) {
        issues.push({ variable: 'CORS_ORIGIN', message: 'origins must include a host' });
      }
      if (url.username || url.password) {
        issues.push({ variable: 'CORS_ORIGIN', message: 'origins must not include userinfo' });
      }
      if (url.pathname !== '' && url.pathname !== '/') {
        issues.push({ variable: 'CORS_ORIGIN', message: 'origins must not include a path' });
      }
      if (url.search || url.hash) {
        issues.push({
          variable: 'CORS_ORIGIN',
          message: 'origins must not include query parameters or a fragment',
        });
      }
    } catch {
      issues.push({ variable: 'CORS_ORIGIN', message: 'origins must be valid URLs' });
    }
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

/**
 * 校验 API/Worker 共用的凭据密钥轮换配置。
 *
 * 历史密钥采用 JSON 对象 `{ "old-key-id": "secret" }`，这里只校验结构和
 * key-id，不把原始内容拼入错误信息。密钥材料实际由共享 keyring 在入口启动时读取。
 */
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

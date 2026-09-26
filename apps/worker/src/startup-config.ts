import { isIP } from 'node:net';
import { DEFAULT_GENERATION_CONCURRENCY } from '@multimodal-canvas/domain';

export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

export type StartupConfigurationIssue = {
  variable: string;
  message: string;
};

const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_RESULT_ASSET_BYTES = 50 * 1024 * 1024;

/** 启动配置错误；保留生产环境消息前缀，不回显配置中的原始值。 */
export class StartupConfigurationError extends Error {
  constructor(
    service: string,
    public readonly issues: readonly StartupConfigurationIssue[],
    nodeEnvironment?: string,
  ) {
    super(
      `${service} cannot start${nodeEnvironment === 'production' ? ' in production' : ''}: ${issues
        .map(({ variable, message }) => `${variable} ${message}`)
        .join('; ')}`,
    );
    this.name = 'StartupConfigurationError';
  }
}

/**
 * 读取队列首次启动的 Run 并发；未配置时为 20，Redis 已保存值优先于环境值。
 * @param environment 启动环境；显式 WORKER_CONCURRENCY 只允许可精确表示的正十进制整数。
 * @returns 初始并发数；设为 1 串行领取 Run，不改变 Run 内部 DAG 顺序。
 * @throws StartupConfigurationError 显式值为空、非整数或越界时拒绝启动。
 */
export function resolveWorkerConcurrency(environment: StartupEnvironment = process.env): number {
  const raw = environment.WORKER_CONCURRENCY;
  if (raw === undefined) return DEFAULT_GENERATION_CONCURRENCY;
  const value = raw.trim();
  const concurrency = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new StartupConfigurationError(
      'Worker',
      [{ variable: 'WORKER_CONCURRENCY', message: 'must be a positive safe integer' }],
      environment.NODE_ENV,
    );
  }
  return concurrency;
}

/**
 * 检查所有环境的 Worker 并发上限，以及生产环境的持久化、存储和 Provider 配置。
 * @param environment 启动环境；非生产环境仍可使用本地依赖和 Mock。
 * @returns 不含配置原值的错误列表；空列表表示配置通过校验。
 */
export function validateWorkerStartupConfiguration(
  environment: StartupEnvironment = process.env,
): StartupConfigurationIssue[] {
  const issues: StartupConfigurationIssue[] = [];
  try {
    resolveWorkerConcurrency(environment);
  } catch (error) {
    if (!(error instanceof StartupConfigurationError)) throw error;
    issues.push(...error.issues);
  }
  if (environment.NODE_ENV !== 'production') return issues;

  const databaseUrl = requireValue(environment, 'DATABASE_URL', issues);
  const redisUrl = requireValue(environment, 'REDIS_URL', issues);
  requireValue(environment, 'S3_BUCKET', issues);
  requireValue(environment, 'S3_REGION', issues);
  validateCredentialEncryptionRotationConfiguration(environment, issues);
  requireValue(environment, 'AI_CREDENTIAL_ENCRYPTION_KEY', issues);

  if (databaseUrl) validateUrlProtocol(databaseUrl, 'DATABASE_URL', ['postgresql:'], issues);
  if (redisUrl) {
    validateUrlProtocol(redisUrl, 'REDIS_URL', ['redis:', 'rediss:'], issues, {
      requireTlsForNonLoopback: true,
      secureProtocols: ['rediss:'],
    });
  }

  const s3Endpoint = environment.S3_ENDPOINT?.trim();
  if (s3Endpoint) {
    validateUrlProtocol(s3Endpoint, 'S3_ENDPOINT', ['http:', 'https:'], issues, {
      requireTlsForNonLoopback: true,
    });
  }
  const providerAssetEndpoint = environment.S3_PROVIDER_ENDPOINT?.trim();
  if (providerAssetEndpoint) {
    try {
      normalizeProviderAssetEndpoint(providerAssetEndpoint);
    } catch {
      issues.push({
        variable: 'S3_PROVIDER_ENDPOINT',
        message: 'must be a public HTTPS URL without credentials, query parameters or a fragment',
      });
    }
  }
  validateS3CredentialPair(environment, issues);

  if (
    environment.NEW_API_VIDEO_CONTRACT !== undefined &&
    !['newapi-video-v1', 'newapi-unified-v1', 'legacy-v1'].includes(
      environment.NEW_API_VIDEO_CONTRACT,
    )
  ) {
    issues.push({
      variable: 'NEW_API_VIDEO_CONTRACT',
      message: 'must be "newapi-video-v1", "newapi-unified-v1" or "legacy-v1"',
    });
  }

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
  validateMediaToolConfiguration(environment, 'FFMPEG_ENABLED', 'FFMPEG_PATH', issues);

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
  if (issues.length > 0)
    throw new StartupConfigurationError('Worker', issues, environment.NODE_ENV);
}

/**
 * Decides whether this process owns a BullMQ worker. Production validation is
 * deliberately evaluated first so RUN_SERVICE=memory cannot bypass it.
 */
export function shouldStartWorkerProcess(environment: StartupEnvironment = process.env): boolean {
  assertWorkerStartupConfiguration(environment);
  return environment.NODE_ENV !== 'test' && environment.RUN_SERVICE !== 'memory';
}

/**
 * 校验只用于 Provider 拉取冻结素材的对象存储 endpoint。
 * 该检查只排除显然不可公网访问的地址，不能替代部署后的外部 GET 验收。
 */
export function normalizeProviderAssetEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('S3_PROVIDER_ENDPOINT must be a valid public HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isObviouslyPrivateHostname(url.hostname)
  ) {
    throw new Error('S3_PROVIDER_ENDPOINT must be a public HTTPS URL');
  }
  return url.toString();
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

/** 排除回环、私网、链路本地和保留测试域名；不做 DNS 查询或可达性推断。 */
function isObviouslyPrivateHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (
    ['localhost', '::', '::1'].includes(normalized) ||
    ['.localhost', '.local', '.internal', '.test', '.example', '.invalid'].some((suffix) =>
      normalized.endsWith(suffix),
    )
  ) {
    return true;
  }
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0, third = 0] = normalized.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      /^(?:fc|fd|fe[89ab]|ff)/.test(normalized) ||
      normalized.startsWith('::ffff:') ||
      normalized === '2001:db8::' ||
      normalized.startsWith('2001:db8:')
    );
  }
  return !normalized.includes('.');
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

/** Docker 生产环境加载与依赖等待；不读取仓库环境文件，也不输出连接串或密钥。 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

/** API/Worker 只读密钥视图；Canonical 卷仅初始化容器可见。 */
export const secretDirectory = '/run/multimodal/secrets';

/** 返回只包含字段名称的配置错误，避免错误信息泄漏配置原值。 */
function configurationError(variable) {
  const error = new Error(`Invalid or missing runtime configuration: ${variable}`);
  error.code = `INVALID_RUNTIME_${variable}`;
  return error;
}

/** 必须使用已有 R2 bucket 的 S3 API；不创建 bucket，也不允许改回本地对象存储。 */
function storageEnvironment(environment) {
  const storage = {};
  for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
    const value = environment[name]?.trim();
    if (!value) throw configurationError(name);
    storage[name] = value;
  }
  let endpoint;
  try {
    endpoint = new URL(storage.S3_ENDPOINT);
  } catch {
    throw configurationError('S3_ENDPOINT');
  }
  if (
    endpoint.protocol !== 'https:' ||
    !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  ) {
    throw configurationError('S3_ENDPOINT');
  }
  if (environment.S3_REGION && environment.S3_REGION !== 'auto') {
    throw configurationError('S3_REGION');
  }
  return {
    ...storage,
    S3_REGION: 'auto',
    // R2 不支持 SDK 默认附加校验和，仅按操作合同启用。
    AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'WHEN_REQUIRED',
  };
}

/** 校验外部 PostgreSQL 连接串；未显式配置时使用本栈数据库和稳定随机口令。 */
function databaseUrl(environment, secret) {
  const value = environment.DATABASE_URL?.trim();
  if (!value) return `postgresql://canvas:${secret.postgres}@postgres:5432/canvas?schema=public`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' || !url.hostname || !url.pathname.slice(1)) {
      throw configurationError('DATABASE_URL');
    }
    if (
      url.hostname.endsWith('.neon.tech') &&
      (url.hostname.includes('-pooler.') ||
        !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')))
    ) {
      throw configurationError('DATABASE_URL');
    }
  } catch {
    throw configurationError('DATABASE_URL');
  }
  return value;
}

/**
 * 加载稳定密钥并生成 API、Worker 与 migrate 共用的生产环境。
 * @param {{ environment?: NodeJS.ProcessEnv, directory?: string }} options 测试可使用合成环境和临时密钥目录。
 * @returns {Promise<NodeJS.ProcessEnv>} 仅返回内存配置，不写入环境文件；R2 的 region 为 auto。
 * @throws {Error} R2 配置、连接串或持久密钥缺失/损坏时拒绝启动，不生成替代密钥。
 */
export async function runtimeEnvironment({
  environment = process.env,
  directory = secretDirectory,
} = {}) {
  const secret = JSON.parse(await readFile(`${directory}/runtime.json`, 'utf8'));
  for (const name of ['postgres', 'redis', 'jwt', 'encryption', 'webhook']) {
    if (!/^[a-f0-9]{64}$/.test(secret[name] ?? '')) throw configurationError(name);
  }
  return {
    ...environment,
    NODE_ENV: 'production',
    RUN_SERVICE: 'bullmq',
    WORKER_PROVIDER: 'newapi',
    DATABASE_URL: databaseUrl(environment, secret),
    REDIS_URL: `rediss://:${secret.redis}@redis:6379/0`,
    ...storageEnvironment(environment),
    API_JWT_SECRET: secret.jwt,
    AI_CREDENTIAL_ENCRYPTION_KEY: secret.encryption,
    NEW_API_WEBHOOK_SECRET: secret.webhook,
    NODE_EXTRA_CA_CERTS: `${directory}/ca.crt`,
  };
}

/** 检查 TCP 或受可信 CA 校验的 TLS 握手；单次最多等待三秒，不发送业务请求。 */
function probe(host, port, encrypted = false) {
  return new Promise((resolve, reject) => {
    const socket = encrypted
      ? connectTls({ host, port, servername: host })
      : connect({ host, port });
    socket.setTimeout(3000);
    socket.once(encrypted ? 'secureConnect' : 'connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Dependency connection timeout'));
    });
  });
}

/**
 * 在正式进程启动前等待数据库、TLS Redis 和 API（仅 Worker）。
 * @param {string} service api、worker 或 migrate；迁移仅依赖数据库。
 * @param {NodeJS.ProcessEnv} environment runtimeEnvironment 返回的实际连接配置。
 * @returns {Promise<void>} 依赖可达后完成；不迁移数据库、不创建任务、不请求 R2。
 * @throws {Error} 三分钟内未就绪时失败，由 Compose 的重启策略决定后续处理。
 */
export async function waitForDependencies(service, environment) {
  const database = new URL(environment.DATABASE_URL);
  const redis = new URL(environment.REDIS_URL);
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      await probe(database.hostname, Number(database.port || 5432));
      if (service !== 'migrate') await probe(redis.hostname, Number(redis.port || 6379), true);
      if (service === 'worker') {
        const api = await fetch('http://api:3000/health', { signal: AbortSignal.timeout(3000) });
        if (!api.ok) throw new Error('API is not ready');
      }
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`Dependencies did not become ready for ${service}`);
      await delay(2000);
    }
  }
}

/** Docker 运行时配置加载与依赖等待；真实密钥仅从只读卷进入子进程环境。 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

/** 密钥目录由 Compose 挂载，不读取仓库 .env。 */
export const secretDirectory = '/run/multimodal/secrets';

/**
 * 外部对象存储模式（compose.cloud.yaml 设置 MC_EXTERNAL_SERVICES=1）：S3_* 取自私有
 * env_file，不再指向本栈 minio。外部数据库需另行叠加 compose.cloud-db.yaml
 * （设置 MC_EXTERNAL_DATABASE=1 并读取 CLOUD_DATABASE_URL），否则仍使用本栈 postgres。
 */
export const externalServices = process.env.MC_EXTERNAL_SERVICES === '1';
export const externalDatabase = process.env.MC_EXTERNAL_DATABASE === '1';

/**
 * 外部存储必需的变量：私有 env_file 使用 CLOUD_ 前缀，避免与 compose.yaml 固定的
 * S3_ENDPOINT 等 environment 项冲突（environment 优先于 env_file）。
 */
const EXTERNAL_STORAGE_VARIABLES = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
];

/** 返回对象存储配置；外部模式缺项时只报告变量名，不输出取值。 */
function storageEnvironment(secret) {
  if (!externalServices) return { S3_ACCESS_KEY: 'canvas-app', S3_SECRET_KEY: secret.s3 };
  const missing = EXTERNAL_STORAGE_VARIABLES.filter(
    (name) => !process.env[`CLOUD_${name}`]?.trim(),
  );
  if (missing.length) {
    const error = new Error(`Missing CLOUD_${missing.join(', CLOUD_')}`);
    error.code = `MISSING_CLOUD_${missing[0]}`;
    throw error;
  }
  return Object.fromEntries(
    EXTERNAL_STORAGE_VARIABLES.map((name) => [name, process.env[`CLOUD_${name}`].trim()]),
  );
}

/** 返回本栈或外部数据库连接串；外部模式缺少连接串时拒绝启动。 */
function databaseUrl(secret) {
  if (!externalDatabase)
    return `postgresql://canvas:${secret.postgres}@postgres:5432/canvas?schema=public`;
  const url = process.env.CLOUD_DATABASE_URL?.trim();
  if (!url) {
    const error = new Error('Missing CLOUD_DATABASE_URL');
    error.code = 'MISSING_CLOUD_DATABASE_URL';
    throw error;
  }
  return url;
}

/** 返回经过校验的生产环境变量；密钥缺失或格式错误时直接拒绝启动。 */
export async function runtimeEnvironment() {
  const secret = JSON.parse(await readFile(`${secretDirectory}/runtime.json`, 'utf8'));
  for (const name of ['postgres', 'redis', 's3', 'jwt', 'encryption', 'webhook']) {
    if (!/^[a-f0-9]{64}$/.test(secret[name] ?? ''))
      throw new Error(`Invalid secret field: ${name}`);
  }
  return {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl(secret),
    REDIS_URL: `rediss://:${secret.redis}@redis:6379/0`,
    ...storageEnvironment(secret),
    API_JWT_SECRET: secret.jwt,
    AI_CREDENTIAL_ENCRYPTION_KEY: secret.encryption,
    NEW_API_WEBHOOK_SECRET: secret.webhook,
    NODE_EXTRA_CA_CERTS: `${secretDirectory}/ca.crt`,
  };
}

/** 检查 TCP 或受系统 CA 校验的 TLS 握手；每次尝试最多等待三秒。 */
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

/** 等待本栈依赖就绪，超时后失败交给容器重启策略；不修改数据库或重发任务。 */
export async function waitForDependencies(service) {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      if (externalDatabase) {
        // 外部数据库只确认 TCP 可达；对象存储由 API 启动后的实际请求校验。
        const database = new URL(process.env.CLOUD_DATABASE_URL);
        await probe(database.hostname, Number(database.port || 5432));
      } else {
        await probe('postgres', 5432);
      }
      if (service !== 'migrate') {
        await probe('redis', 6379, true);
        if (!externalServices) {
          const storage = await fetch('https://minio:9000/minio/health/ready', {
            signal: AbortSignal.timeout(3000),
          });
          if (!storage.ok) throw new Error('Object store is not ready');
        }
      }
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

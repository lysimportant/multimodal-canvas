/** Docker 运行时配置加载与依赖等待；真实密钥仅从只读卷进入子进程环境。 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

/** 密钥目录由 Compose 挂载，不读取仓库 .env。 */
export const secretDirectory = '/run/multimodal/secrets';

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
    DATABASE_URL: `postgresql://canvas:${secret.postgres}@postgres:5432/canvas?schema=public`,
    REDIS_URL: `rediss://:${secret.redis}@redis:6379/0`,
    S3_ACCESS_KEY: 'canvas-app',
    S3_SECRET_KEY: secret.s3,
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
      await probe('postgres', 5432);
      if (service !== 'migrate') {
        await probe('redis', 6379, true);
        const storage = await fetch('https://minio:9000/minio/health/ready', {
          signal: AbortSignal.timeout(3000),
        });
        if (!storage.ok) throw new Error('Object store is not ready');
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

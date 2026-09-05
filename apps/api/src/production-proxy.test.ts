/**
 * 本地隔离入口验收：真实 HTTPS 代理转发到独立 NODE_ENV=production API 进程。
 * 仅显式 REQUIRE_PRODUCTION_ENTRY=true 时访问测试依赖，不代表生产部署或 Provider 验收。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as requestHttp } from 'node:http';
import { createServer, request, type RequestOptions, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 独立入口必需的测试依赖变量；不读取 .env，也不回退到生产连接。 */
const configurationVariables = [
  'TEST_DATABASE_URL',
  'TEST_REDIS_URL',
  'TEST_S3_ENDPOINT',
  'TEST_S3_REGION',
  'TEST_S3_BUCKET',
  'TEST_S3_ACCESS_KEY',
  'TEST_S3_SECRET_KEY',
] as const;

/** 验收配置只允许命名明确的本机测试设施。 */
type EntryConfiguration = Record<(typeof configurationVariables)[number], string>;

/**
 * 校验隔离依赖；错误只包含变量名，不输出 URL 或凭据。
 * @throws 缺配置、非回环服务、非测试资源或 Redis 默认数据库时拒绝运行。
 */
function readConfiguration(environment: NodeJS.ProcessEnv): EntryConfiguration {
  const configuration = {} as EntryConfiguration;
  for (const name of configurationVariables) {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`隔离入口验收缺少 ${name}`);
    configuration[name] = value;
  }
  for (const [name, protocol] of [
    ['TEST_DATABASE_URL', 'postgresql:'],
    ['TEST_REDIS_URL', 'redis:'],
    ['TEST_S3_ENDPOINT', 'http:'],
  ] as const) {
    let endpoint: URL;
    try {
      endpoint = new URL(configuration[name]);
    } catch {
      throw new Error(`隔离入口验收 ${name} 不是有效 URL`);
    }
    if (endpoint.protocol !== protocol || endpoint.hostname !== '127.0.0.1') {
      throw new Error(`隔离入口验收 ${name} 必须使用 ${protocol}//127.0.0.1`);
    }
    if (name === 'TEST_REDIS_URL' && !/^\/(?:[1-9]|1[0-5])$/.test(endpoint.pathname)) {
      throw new Error('隔离入口验收 TEST_REDIS_URL 必须指定专用数据库 1-15');
    }
    if (
      name === 'TEST_DATABASE_URL' &&
      !/(?:^|[_-])(?:test|ci)(?:$|[_-])/i.test(endpoint.pathname.slice(1))
    ) {
      throw new Error('隔离入口验收 TEST_DATABASE_URL 必须使用 test/ci 数据库');
    }
  }
  if (!/(?:^|[_-])(?:test|ci)(?:$|[_-])/i.test(configuration.TEST_S3_BUCKET)) {
    throw new Error('隔离入口验收 TEST_S3_BUCKET 必须使用 test/ci bucket');
  }
  return configuration;
}

/** 仅显式开关启用真实依赖；CI 专用步骤另行断言报告中没有跳过项。 */
const configuration =
  process.env.REQUIRE_PRODUCTION_ENTRY === 'true' ? readConfiguration(process.env) : undefined;

/** 只含本机地址和合成值，用于隔离保护测试，不建立服务连接。 */
const syntheticConfiguration: EntryConfiguration = {
  TEST_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/entry_ci',
  TEST_REDIS_URL: 'redis://127.0.0.1:6379/15',
  TEST_S3_ENDPOINT: 'http://127.0.0.1:9000',
  TEST_S3_REGION: 'us-east-1',
  TEST_S3_BUCKET: 'entry-ci',
  TEST_S3_ACCESS_KEY: 'synthetic-entry-access',
  TEST_S3_SECRET_KEY: 'synthetic-entry-secret',
};

describe('生产入口验收隔离保护', () => {
  it('缺少测试依赖时失败而非回退到生产变量', () => {
    expect(() =>
      readConfiguration({ DATABASE_URL: syntheticConfiguration.TEST_DATABASE_URL }),
    ).toThrow('TEST_DATABASE_URL');
  });

  it.each([
    ['TEST_DATABASE_URL', 'postgresql://fixture:fixture@database.example/entry_ci'],
    ['TEST_DATABASE_URL', 'postgresql://fixture:fixture@127.0.0.1/production'],
    ['TEST_REDIS_URL', 'redis://127.0.0.1:6379/0'],
    ['TEST_S3_ENDPOINT', 'https://storage.example'],
    ['TEST_S3_BUCKET', 'production'],
  ])('%s 拒绝非隔离目标', (name, value) => {
    expect(() => readConfiguration({ ...syntheticConfiguration, [name]: value })).toThrow(name);
  });
});

/** 执行受控本地工具；调用方必须设置超时且不输出原始子进程日志。 */
const execFileAsync = promisify(execFile);

/** 仅保留启动 Node/pnpm 所需的操作系统环境，禁止继承用户服务、遥测和 TLS 配置。 */
function systemEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(?:path|systemroot|comspec|windir|temp|tmp|home|userprofile|appdata|localappdata|pnpm_home)$/i.test(
        name,
      ),
    ),
  );
}

/** 返回随机回环端口；API 启动失败（包括端口竞争）时测试显式失败。 */
async function availablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('无法分配隔离监听端口');
  return address.port;
}

/** 停止本测试创建的进程并等待退出，防止测试完成后继续访问依赖。 */
async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('隔离 API 未在超时内退出')), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

/** HTTPS 返回的可断言数据；TLS 授权状态来自真实套接字。 */
type EntryResponse = {
  status: number | undefined;
  headers: import('node:http').IncomingHttpHeaders;
  body: string;
  authorized: boolean;
};

describe.skipIf(!configuration)('隔离 HTTPS 代理到真实生产模式 API', () => {
  /** 证书、数据库 schema、队列与凭据均为本次随机生命周期资源。 */
  const schemaName = `mc_entry_ci_${randomUUID().replaceAll('-', '')}`;
  const bearerToken = randomUUID();
  let certificateDirectory = '';
  let certificate: Buffer;
  let proxy: Server | undefined;
  let proxyPort = 0;
  let api: ChildProcess | undefined;
  let database: PrismaClient | undefined;
  let childEnvironment: NodeJS.ProcessEnv;
  let apiLogs = '';
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const apiRoot = fileURLToPath(new URL('../', import.meta.url));

  /** 仅当前请求信任临时证书，始终开启证书链与主机名校验，五秒超时。 */
  async function send(
    path: string,
    options: RequestOptions = {},
    body?: string,
  ): Promise<EntryResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path,
          ca: certificate,
          agent: false,
          ...options,
          rejectUnauthorized: true,
        },
        (incoming) => {
          const authorized = (incoming.socket as import('node:tls').TLSSocket).authorized;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.once('error', reject);
          incoming.once('end', () =>
            resolve({
              status: incoming.statusCode,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              authorized,
            }),
          );
        },
      );
      outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('隔离 TLS 请求超时')));
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  }

  beforeAll(async () => {
    certificateDirectory = await mkdtemp(join(tmpdir(), 'mc-entry-ci-'));
    const opensslConfiguration = join(certificateDirectory, 'openssl.cnf');
    await writeFile(opensslConfiguration, '');
    await execFileAsync(
      process.env.OPENSSL_PATH || 'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-config',
        opensslConfiguration,
        '-keyout',
        join(certificateDirectory, 'key.pem'),
        '-out',
        join(certificateDirectory, 'cert.pem'),
      ],
      { env: systemEnvironment(), timeout: 15_000, windowsHide: true },
    );
    certificate = await readFile(join(certificateDirectory, 'cert.pem'));
    const scopedDatabase = new URL(configuration!.TEST_DATABASE_URL);
    scopedDatabase.searchParams.set('schema', schemaName);
    database = new PrismaClient({ datasources: { db: { url: scopedDatabase.href } } });
    const pnpmArguments = ['exec', 'prisma', 'db', 'push', '--skip-generate'];
    await execFileAsync(
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArguments]
        : pnpmArguments,
      {
        cwd: workspaceRoot,
        env: { ...systemEnvironment(), DATABASE_URL: scopedDatabase.href },
        timeout: 30_000,
        windowsHide: true,
      },
    );

    const apiPort = await availablePort();
    childEnvironment = {
      ...systemEnvironment(),
      NODE_ENV: 'production',
      WORKER_PROVIDER: 'newapi',
      RUN_SERVICE: 'bullmq',
      DATABASE_URL: scopedDatabase.href,
      REDIS_URL: configuration!.TEST_REDIS_URL,
      S3_ENDPOINT: configuration!.TEST_S3_ENDPOINT,
      S3_BUCKET: configuration!.TEST_S3_BUCKET,
      S3_REGION: configuration!.TEST_S3_REGION,
      S3_ACCESS_KEY: configuration!.TEST_S3_ACCESS_KEY,
      S3_SECRET_KEY: configuration!.TEST_S3_SECRET_KEY,
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      API_AUTH_TOKEN: bearerToken,
      API_BODY_LIMIT_BYTES: '256',
      CORS_ORIGIN: 'https://console.example.test',
      AI_CREDENTIAL_ENCRYPTION_KEY: randomUUID(),
      NEW_API_WEBHOOK_SECRET: randomUUID(),
      RUN_QUEUE_NAME: schemaName,
      FFMPEG_ENABLED: 'false',
      FFPROBE_ENABLED: 'false',
    };
    api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: apiRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('隔离 API 启动超时')), 20_000);
      api!.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('隔离 API 无法启动'));
      });
      api!.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('隔离 API 提前退出'));
      });
      api!.stderr!.on('data', (chunk: Buffer) => {
        apiLogs = (apiLogs + chunk.toString()).slice(-65_536);
      });
      api!.stdout!.on('data', (chunk: Buffer) => {
        apiLogs = (apiLogs + chunk.toString()).slice(-65_536);
        if (apiLogs.includes(`Server listening at http://127.0.0.1:${apiPort}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    proxy = createServer(
      {
        key: await readFile(join(certificateDirectory, 'key.pem')),
        cert: certificate,
        minVersion: 'TLSv1.2',
      },
      (incoming, outgoing) => {
        const upstream = requestHttp(
          {
            hostname: '127.0.0.1',
            port: apiPort,
            path: incoming.url,
            method: incoming.method,
            agent: false,
            headers: {
              ...incoming.headers,
              host: `127.0.0.1:${apiPort}`,
              'x-forwarded-proto': 'https',
              'x-forwarded-for': incoming.socket.remoteAddress,
            },
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.once('error', () => outgoing.destroy());
            response.pipe(outgoing);
          },
        );
        upstream.setTimeout(3_000, () => upstream.destroy(new Error('隔离代理上游超时')));
        upstream.once('error', () => {
          if (outgoing.headersSent) return outgoing.destroy();
          outgoing.writeHead(502, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'upstream unavailable', code: 'bad_gateway' }));
        });
        incoming.once('aborted', () => upstream.destroy());
        incoming.pipe(upstream);
      },
    );
    await new Promise<void>((resolve, reject) => {
      proxy!.once('error', reject);
      proxy!.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('隔离代理没有监听 TCP');
    proxyPort = address.port;
  }, 75_000);

  afterAll(async () => {
    try {
      if (proxy) {
        proxy.closeAllConnections();
        if (proxy.listening)
          await new Promise<void>((resolve, reject) =>
            proxy!.close((error) => (error ? reject(error) : resolve())),
          );
      }
    } finally {
      try {
        await stopProcess(api);
      } finally {
        try {
          if (database) {
            try {
              await database.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
            } finally {
              await database.$disconnect();
            }
          }
        } finally {
          if (certificateDirectory)
            await rm(certificateDirectory, { recursive: true, force: true });
        }
      }
    }
  }, 20_000);

  it('默认信任链拒绝临时自签证书', async () => {
    await expect(send('/health', { ca: undefined })).rejects.toMatchObject({
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
  });

  it('信任测试证书仍拒绝不匹配的主机名', async () => {
    await expect(send('/health', { servername: 'wrong.example.test' })).rejects.toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
  });

  it('显式信任测试证书后 TLS 健康检查成功', async () => {
    const response = await send('/health');
    expect(response.authorized).toBe(true);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'api' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([undefined, 'Bearer wrong-entry-token'])(
    '无效认证 %s 不得通过代理',
    async (authorization) => {
      const response = await send('/v1/settings/ai', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: 'authentication required' });
    },
  );

  it('正确 Bearer 经过代理后读取隔离数据库设置', async () => {
    const response = await send('/v1/settings/ai', {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ settings: { configured: false } });
    expect(response.body).not.toContain(bearerToken);
  });

  it('伪造转发头不能替代认证', async () => {
    const response = await send('/v1/settings/ai', {
      headers: {
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-user': 'admin',
        'x-forwarded-authorization': `Bearer ${bearerToken}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it('允许的 HTTPS origin 无认证即可完成 CORS 预检', async () => {
    const response = await send('/v1/projects', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://console.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://console.example.test');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it.each(['https://untrusted.example.test', 'http://console.example.test', 'null'])(
    '不向来源 %s 授予 CORS 读取权限',
    async (origin) => {
      const response = await send('/v1/projects', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('认证错误保留允许来源的 CORS 头且不回显凭据', async () => {
    const response = await send('/v1/settings/ai', {
      headers: {
        origin: 'https://console.example.test',
        authorization: 'Bearer wrong-entry-token',
      },
    });
    expect(response.status).toBe(401);
    expect(response.headers['access-control-allow-origin']).toBe('https://console.example.test');
    expect(response.body).not.toContain('wrong-entry-token');
  });

  it.each([
    { body: '{"apiKey":"synthetic-entry-body-secret",', status: 400, code: 'internal_error' },
    {
      body: JSON.stringify({ name: 'synthetic-entry-body-secret'.repeat(20) }),
      status: 413,
      code: 'request_body_too_large',
    },
  ])('入口解析错误返回 $status 且不暴露请求内容', async ({ body, status, code }) => {
    const response = await send(
      '/v1/projects',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      body,
    );
    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toMatchObject({ code, requestId: expect.any(String) });
    expect(response.body).not.toContain('synthetic-entry-body-secret');
    expect(response.body).not.toContain(bearerToken);
  });

  it('生产入口缺少认证配置时在监听前失败', async () => {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: apiRoot,
      env: { ...childEnvironment, API_AUTH_TOKEN: '' },
      timeout: 10_000,
      windowsHide: true,
    }).then(
      () => {
        throw new Error('缺配置的 API 意外启动');
      },
      (error: { code?: number; stdout?: string; stderr?: string }) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('API_AUTH_TOKEN/API_JWT_SECRET');
    expect(result.stdout).not.toContain('Server listening');
    expect(result.stderr).not.toContain(bearerToken);
  }, 15_000);

  it('API 退出后代理返回脱敏 502，既有日志不泄露合成凭据', async () => {
    await stopProcess(api);
    const response = await send('/health');
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: 'upstream unavailable',
      code: 'bad_gateway',
    });
    expect(apiLogs).not.toContain(bearerToken);
    expect(apiLogs).not.toContain('synthetic-entry-body-secret');
    expect(apiLogs).not.toContain('wrong-entry-token');
  });
});

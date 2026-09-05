/** 生产 Compose 合成验收；仅允许专用项目和本机 18080，不启动设施、不删除数据。 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createFixture,
  FIXTURE_ID,
  MODELS,
  SYNTHETIC_KEY,
  syntheticPng,
  syntheticText,
} from './provider-fixture.mjs';

/** 安全边界不可通过环境变量或命令行改为用户运行栈。 */
const PROJECT = 'mc-acceptance-test-docker';
/** 所有主机 HTTP 请求必须是此源；API 返回的跳转也不跟随。 */
const ORIGIN = 'http://localhost:18080';
/** 唯一允许的上游；经真实 API/Worker 使用独立卷 CA 校验。 */
const PROVIDER = 'https://minio:9443';
/** 必需服务列表，不对全部 services 数量作断言，兼容可选 server/Caddy。 */
const SERVICES = ['web', 'api', 'worker', 'postgres', 'redis', 'minio'];
/** 报告和 Compose 路径由脚本位置定位，不受终端当前目录影响。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE = resolve(ROOT, 'compose.yaml');
const REPORT = resolve(ROOT, '.data/docker-smoke-report.json');
/** 合成数据身份和摘要的严格格式，不接受任意已有账号或项目。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** 指定模式仅保存在进程中；Docker context 在第一次核验后固定。 */
let context;

/** 断言失败只输出静态诊断码，禁止附带响应体、stdout、密码或令牌。 */
function check(condition, code) {
  if (!condition) throw new Error(code);
}

/** SHA-256 用于合成内容和无秘密标识的完整性核对。 */
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 固定源校验也应用于服务返回的上传/内容 URL；拒绝外域、凭据及跳转。 */
function localUrl(value) {
  const url = new URL(value, ORIGIN);
  check(
    url.origin === ORIGIN && !url.username && !url.password && !url.hash,
    'HTTP_TARGET_REJECTED',
  );
  return url;
}

/**
 * 校验浏览器媒体访问地址，只接受本源已知资源的根相对签名 URL。
 * @param value access-url 接口返回的地址；不允许绝对地址、协议相对地址或控制字符。
 * @param expectedPath 当前已核验资产的内容或派生路径，不允许换成其他资源。
 * @returns 原始相对地址，仅用于本次无 Bearer GET，不输出或写入报告。
 * @throws 地址越界、路径不符或缺少唯一 access_token 时抛出静态诊断码。
 */
function checkedAccessUrl(value, expectedPath) {
  check(
    typeof value === 'string' &&
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !/[\\\u0000-\u0020\u007f]/.test(value),
    'ACCESS_URL_MUST_BE_RELATIVE',
  );
  const url = localUrl(value);
  check(url.pathname === expectedPath, 'ACCESS_URL_RESOURCE_MISMATCH');
  check(
    url.searchParams.size === 1 && Boolean(url.searchParams.get('access_token')),
    'ACCESS_URL_SIGNATURE_MISSING',
  );
  return value;
}

/** 解析 before/after；未知参数、其他项目和其他端口均在任何 Docker 调用前拒绝。 */
function options(args) {
  const phase = args[0];
  check(['before', 'after', '--self-test'].includes(phase), 'EXPECTED_BEFORE_OR_AFTER');
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    check(
      (name === '--project' && value === PROJECT) || (name === '--base-url' && value === ORIGIN),
      'CLI_TARGET_REJECTED',
    );
  }
  return phase;
}

/** 捕获子进程输出但绝不透传；超时不重试任何变更操作。stdin 不进入进程参数。 */
async function docker(args, input, timeout = 30_000) {
  const executable =
    process.platform === 'win32' &&
    existsSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
      ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
      : 'docker';
  return new Promise((resolveOutput, reject) => {
    const child = spawn(executable, [...(context ? ['--context', context] : []), ...args], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        COMPOSE_DISABLE_ENV_FILE: 'true',
        COMPOSE_ENV_FILES: '',
        COMPOSE_PROFILES: '',
        MC_HTTP_PORT: '18080',
      },
    });
    const chunks = [];
    let length = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, timeout);
    child.stdout.on('data', (part) => {
      length += part.length;
      if (length > 4 * 1024 * 1024) {
        failed = true;
        child.kill();
      } else chunks.push(part);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      failed = true;
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('DOCKER_EXEC_FAILED'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('DOCKER_EXEC_FAILED_OR_TIMED_OUT'));
      else resolveOutput(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(input);
  });
}

/** Compose 操作固定文件和项目；本脚本只 exec，不运行 up/restart/down。 */
function composeArgs(...args) {
  return ['compose', '-f', COMPOSE, '-p', PROJECT, ...args];
}

/** 只比较 Compose 文件标签，不输出可能带环境信息的 inspect 原文。 */
function samePath(left, right) {
  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/$/, '');
  return process.platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

/** 核验单个必需服务、运行模式和端口；可选服务不参与数量断言。 */
function validateContainer(container, service) {
  const labels = container.Config?.Labels ?? {};
  check(labels['com.docker.compose.project'] === PROJECT, 'CONTAINER_PROJECT_MISMATCH');
  check(labels['com.docker.compose.service'] === service, 'CONTAINER_SERVICE_MISMATCH');
  check(
    samePath(labels['com.docker.compose.project.config_files'] ?? '', COMPOSE),
    'COMPOSE_FILE_MISMATCH',
  );
  check(
    container.State?.Running && container.State.Health?.Status === 'healthy',
    'SERVICE_NOT_HEALTHY',
  );
  check(
    typeof container.Id === 'string' && /^[0-9a-f]{64}$/.test(container.Id),
    'CONTAINER_ID_INVALID',
  );
  const ports = Object.entries(container.NetworkSettings?.Ports ?? {}).filter(
    ([, bindings]) => bindings?.length,
  );
  if (service === 'web') {
    check(
      ports.length === 1 &&
        ports[0][0] === '8080/tcp' &&
        ports[0][1].length === 1 &&
        ports[0][1][0].HostIp === '127.0.0.1' &&
        ports[0][1][0].HostPort === '18080',
      'WEB_BINDING_MISMATCH',
    );
  } else check(ports.length === 0, 'INTERNAL_SERVICE_EXPOSED');
  if (['api', 'worker'].includes(service)) {
    const env = Object.fromEntries(
      container.Config.Env.map((item) => {
        const index = item.indexOf('=');
        return [item.slice(0, index), item.slice(index + 1)];
      }),
    );
    for (const [key, expected] of Object.entries({
      NODE_ENV: 'production',
      RUN_SERVICE: 'bullmq',
      WORKER_PROVIDER: 'newapi',
      S3_ENDPOINT: 'https://minio:9000',
      S3_UPLOAD_MODE: 'proxy',
      S3_DOWNLOAD_MODE: 'proxy',
      NODE_EXTRA_CA_CERTS: '/run/multimodal/secrets/ca.crt',
      FFMPEG_ENABLED: 'true',
      FFPROBE_ENABLED: 'true',
    }))
      check(env[key] === expected, 'PRODUCTION_RUNTIME_MISMATCH');
    check(
      !env.NEW_API_API_KEY && !env.NEW_API_BASE_URL && !env.API_AUTH_TOKEN,
      'EXTERNAL_CREDENTIAL_ENV_REJECTED',
    );
    check(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_VERIFICATION_DISABLED');
  }
}

/** 首个设施操作为本机 context 核验，随后校验标签、独立卷和健康状态。 */
async function inspectTarget() {
  if (!context) {
    check(
      !process.env.DOCKER_HOST && !process.env.DOCKER_TLS_VERIFY && !process.env.DOCKER_CERT_PATH,
      'DOCKER_HOST_OVERRIDE_REJECTED',
    );
    const name = await docker(['context', 'show']);
    const [detail] = JSON.parse(await docker(['context', 'inspect', name]));
    const host = detail?.Endpoints?.docker?.Host ?? '';
    check(
      host.startsWith('unix:///') || host.startsWith('npipe:////./pipe/'),
      'REMOTE_DOCKER_REJECTED',
    );
    context = name;
  }
  const raw = await docker([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
  ]);
  const ids = raw.split(/\s+/).filter(Boolean);
  check(
    ids.length > 0 && ids.every((id) => /^[0-9a-f]{12,64}$/.test(id)),
    'TEST_PROJECT_NOT_RUNNING',
  );
  const containers = JSON.parse(await docker(['inspect', ...ids]));
  const result = {};
  for (const service of SERVICES) {
    const selected = containers.filter(
      (item) => item.Config?.Labels?.['com.docker.compose.service'] === service,
    );
    check(selected.length === 1, 'REQUIRED_SERVICE_COUNT_MISMATCH');
    const container = selected[0];
    validateContainer(container, service);
    result[service] = { id: container.Id, startedAt: container.State.StartedAt };
    const mounts = container.Mounts ?? [];
    const secretVolume = ['api', 'worker'].includes(service) ? 'app_secrets' : `${service}_secrets`;
    const required =
      service === 'web'
        ? []
        : [secretVolume, ...(['postgres', 'redis', 'minio'].includes(service) ? [service] : [])];
    for (const volume of required) {
      const expected = `${PROJECT}_${volume}`;
      const mount = mounts.find((item) => item.Type === 'volume' && item.Name === expected);
      check(mount, 'ISOLATED_VOLUME_MISSING');
      if (volume === secretVolume)
        check(mount.Destination === '/run/multimodal' && !mount.RW, 'SECRET_MOUNT_NOT_READ_ONLY');
      const [inspected] = JSON.parse(await docker(['volume', 'inspect', expected]));
      check(
        inspected.Labels?.['com.docker.compose.project'] === PROJECT &&
          inspected.Labels?.['com.docker.compose.volume'] === volume,
        'VOLUME_PROJECT_MISMATCH',
      );
    }
    check(
      mounts.every(
        (mount) =>
          mount.Type !== 'volume' ||
          (mount.Name.startsWith(`${PROJECT}_`) && mount.Name !== `${PROJECT}_secrets`),
      ),
      'FOREIGN_VOLUME_REJECTED',
    );
  }
  return result;
}

/** fixture 必须共享本项目 MinIO 网络命名空间，只读挂载本项目密钥卷。 */
async function inspectFixture(target) {
  const [fixture] = JSON.parse(await docker(['inspect', `${PROJECT}-provider-fixture`]));
  check(fixture.State?.Running, 'FIXTURE_NOT_RUNNING');
  check(
    fixture.Config?.Image === 'node:24.12.0-bookworm-slim' &&
      JSON.stringify(fixture.Config.Cmd) === JSON.stringify(['node', '/fixture.mjs']) &&
      fixture.HostConfig?.ReadonlyRootfs,
    'FIXTURE_RUNTIME_MISMATCH',
  );
  check(
    fixture.Config?.Labels?.['io.multimodal.smoke.project'] === PROJECT &&
      fixture.Config.Labels['io.multimodal.smoke.fixture'] === FIXTURE_ID,
    'FIXTURE_LABEL_MISMATCH',
  );
  check(
    fixture.HostConfig?.NetworkMode === `container:${target.minio.id}`,
    'FIXTURE_NETWORK_MISMATCH',
  );
  check(!Object.keys(fixture.HostConfig.PortBindings ?? {}).length, 'FIXTURE_PORT_EXPOSED');
  check(
    fixture.Mounts.some(
      (mount) =>
        mount.Name === `${PROJECT}_minio_secrets` &&
        mount.Destination === '/run/multimodal' &&
        !mount.RW,
    ),
    'FIXTURE_SECRET_MISMATCH',
  );
  check(
    fixture.Mounts.some(
      (mount) => mount.Type === 'bind' && mount.Destination === '/fixture.mjs' && !mount.RW,
    ),
    'FIXTURE_SCRIPT_MOUNT_MISSING',
  );
}

/**
 * 在已核验 API 容器内执行 DB 断言，不输出密钥；此函数通过源码+stdin 传递，
 * 无需把新脚本 COPY 到正在构建的镜像。仅 rekey 可修改已确认的合成账号。
 */
async function containerCheck() {
  /** 所有异常限定为固定诊断码，避免 Prisma 错误泄露连接串或参数。 */
  const ensure = (value, code) => {
    if (!value) throw new Error(code);
  };
  let prisma;
  try {
    let input = '';
    for await (const part of process.stdin) {
      input += part;
      ensure(input.length < 128_000, 'INPUT_TOO_LARGE');
    }
    const { action, report, passwordHash, fingerprint } = JSON.parse(input);
    const { runtimeEnvironment } = await import('/app/docker/runtime.mjs');
    const env = await runtimeEnvironment();
    ensure(
      new URL(env.DATABASE_URL).hostname === 'postgres' &&
        new URL(env.REDIS_URL).protocol === 'rediss:',
      'INTERNAL_DATABASE_REQUIRED',
    );
    if (action === 'fixture') {
      const response = await fetch('https://minio:9443/__smoke/stats', {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      ensure(response.ok, 'FIXTURE_HTTP_FAILED');
      const data = await response.json();
      ensure(data.fixture === 'mc-acceptance-provider-v1', 'FIXTURE_IDENTITY_MISMATCH');
      process.stdout.write(
        JSON.stringify({
          ok: true,
          fixture: data.fixture,
          posts: data.posts,
          creations: data.creations,
          replays: data.replays,
          conflicts: data.conflicts,
        }),
      );
      return;
    }
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } }, log: [] });
    if (action === 'empty') {
      for (const table of [
        'user',
        'project',
        'asset',
        'run',
        'aiCredential',
        'modelCatalog',
        'uploadSession',
        'usageLedger',
      ]) {
        ensure((await prisma[table].count()) === 0, 'ISOLATED_DATABASE_NOT_EMPTY');
      }
      process.stdout.write('{"ok":true}');
      return;
    }
    const marker = `mc-docker-smoke:${report.suiteId}`;
    ensure(report.email === `smoke-${report.suiteId}@example.invalid`, 'TEST_EMAIL_MISMATCH');
    const user = await prisma.user.findUnique({
      where: { id: report.userId },
      select: { email: true, displayName: true },
    });
    ensure(user?.email === report.email && user.displayName === marker, 'TEST_ACCOUNT_MISMATCH');
    ensure((await prisma.user.count()) === 1, 'UNKNOWN_ACCOUNTS_PRESENT');
    const project = await prisma.project.findUnique({
      where: { id: report.projectId },
      select: { name: true, ownerId: true },
    });
    ensure(
      project?.name === marker &&
        project.ownerId === report.userId &&
        (await prisma.project.count()) === 1,
      'TEST_PROJECT_MISMATCH',
    );
    const credentials = await prisma.aiCredential.findMany({
      select: { id: true, baseUrl: true, keyFingerprint: true },
    });
    ensure(
      credentials.length === 1 &&
        credentials[0].id === report.credentialId &&
        credentials[0].baseUrl === 'https://minio:9443' &&
        credentials[0].keyFingerprint === fingerprint,
      'UNKNOWN_PROVIDER_CONFIGURATION',
    );
    const assets = [report.uploadAssetId, report.runs.text.assetId, report.runs.image.assetId];
    ensure(
      (await prisma.asset.count()) === assets.length &&
        (await prisma.asset.count({ where: { id: { in: assets }, ownerId: report.userId } })) ===
          assets.length,
      'UNKNOWN_ASSETS_PRESENT',
    );
    ensure((await prisma.run.count()) === 2, 'UNEXPECTED_RUN_COUNT');
    if (action === 'rekey') {
      ensure(
        /^scrypt\$1\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/.test(passwordHash),
        'TEST_PASSWORD_HASH_INVALID',
      );
      const changed = await prisma.user.updateMany({
        where: { id: report.userId, email: report.email, displayName: marker },
        data: { passwordHash },
      });
      ensure(changed.count === 1, 'TEST_REKEY_FAILED');
      process.stdout.write('{"ok":true}');
      return;
    }
    ensure(action === 'verify', 'UNKNOWN_CONTAINER_CHECK');
    const summary = {};
    for (const mediaType of ['text', 'image']) {
      const expected = report.runs[mediaType];
      const rows = await prisma.run.findMany({
        where: {
          projectId: report.projectId,
          idempotencyKey: `mc-smoke:${report.suiteId}:${mediaType}`,
        },
        include: { providerJobs: true, usageLedger: true },
      });
      ensure(rows.length === 1, 'DURABLE_RUN_NOT_UNIQUE');
      const run = rows[0];
      ensure(
        run.status === 'SUCCEEDED' &&
          run.userId === report.userId &&
          run.credentialId === report.credentialId,
        'DURABLE_RUN_MISMATCH',
      );
      ensure(
        run.result?.asset?.assetId === expected.assetId &&
          run.result.asset.sha256 === expected.sha256,
        'DURABLE_RESULT_MISMATCH',
      );
      ensure(
        run.providerJobs.some((job) => job.provider === 'newapi' && job.status === 'succeeded'),
        'DURABLE_PROVIDER_JOB_MISSING',
      );
      if (mediaType === 'text') {
        ensure(run.usageLedger.length === 0, 'TOKEN_ONLY_USAGE_INVENTED_CHARGE');
        ensure(
          run.providerJobs.some((job) => job.payload?.usage?.total_tokens === 15),
          'TOKEN_USAGE_METADATA_MISSING',
        );
      } else {
        const entry = run.usageLedger[0];
        ensure(
          run.usageLedger.length === 1 &&
            entry.amount.toFixed(6) === '0.012300' &&
            entry.currency === 'USD' &&
            entry.kind === 'generation' &&
            Boolean(entry.idempotencyKey) &&
            Boolean(entry.providerJobId),
          'PRICED_USAGE_NOT_UNIQUE',
        );
      }
      summary[mediaType] = {
        databaseRunId: run.id,
        providerJobs: run.providerJobs.length,
        ledgerRows: run.usageLedger.length,
      };
    }
    ensure((await prisma.usageLedger.count()) === 1, 'UNEXPECTED_LEDGER_COUNT');
    process.stdout.write(JSON.stringify({ ok: true, summary }));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message ?? '')
      ? error.message
      : 'CONTAINER_CHECK_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, code }));
  } finally {
    if (prisma) await prisma.$disconnect();
  }
}

/** 仅以 stdin 传递受限断言输入，避免把随机密码摘要放到 Docker 命令参数中。 */
async function probe(action, report, passwordHash) {
  const output = await docker(
    composeArgs(
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `await (${containerCheck.toString()})();`,
    ),
    JSON.stringify({
      action,
      report,
      passwordHash,
      fingerprint: digest(SYNTHETIC_KEY).slice(0, 12),
    }),
  );
  const result = JSON.parse(output);
  check(
    result.ok,
    /^[A-Z_]{3,80}$/.test(result.code ?? '') ? result.code : 'CONTAINER_CHECK_FAILED',
  );
  return result;
}

/** 请求真实同源 API；无自动重试，204 不解析 JSON，限制响应最多 8 MiB。 */
async function request(
  path,
  { method = 'GET', token, body, bytes, expected = 200, headers = {}, binary = false } = {},
) {
  let response;
  try {
    response = await fetch(localUrl(path), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(bytes ? { 'content-type': 'application/octet-stream' } : {}),
        ...headers,
      },
      body: bytes ?? (body ? JSON.stringify(body) : undefined),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('LOCAL_HTTP_REQUEST_FAILED');
  }
  if (response.status !== expected) {
    await response.body?.cancel();
    throw new Error(`HTTP_STATUS_${response.status}_EXPECTED_${expected}`);
  }
  if (expected === 204) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 8 * 1024 * 1024, 'HTTP_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return binary ? buffer : JSON.parse(buffer.toString('utf8'));
}

/** 登录只返回给当前函数调用链，永不进入报告、日志或命令行参数。 */
async function login(email, password) {
  const response = await request('/v1/auth/login', { method: 'POST', body: { email, password } });
  check(
    typeof response.accessToken === 'string' && response.user?.email === email,
    'LOGIN_CONTRACT_MISMATCH',
  );
  return response.accessToken;
}

/** 生成与 auth-service.ts 一致的 scrypt v1 摘要，仅用于恢复本脚本创建的账号。 */
function testPasswordHash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return ['scrypt', 1, 32768, 8, 1, salt.toString('base64url'), derived.toString('base64url')].join(
    '$',
  );
}

/** 校验报告结构和身份，拒绝被注入的秘密字段；只有已完成 before 才允许跨进程恢复。 */
function validateReport(report) {
  const fields = [
    'schemaVersion',
    'project',
    'origin',
    'suiteId',
    'email',
    'stage',
    'createdAt',
    'userId',
    'projectId',
    'credentialId',
    'uploadAssetId',
    'canvasSha256',
    'runs',
    'before',
    'after',
  ];
  check(
    Object.keys(report).every((key) => fields.includes(key)),
    'REPORT_UNKNOWN_FIELD',
  );
  check(
    report.schemaVersion === 1 && report.project === PROJECT && report.origin === ORIGIN,
    'REPORT_TARGET_MISMATCH',
  );
  check(
    UUID.test(report.suiteId) && report.email === `smoke-${report.suiteId}@example.invalid`,
    'REPORT_IDENTITY_INVALID',
  );
  check(
    ['before_passed', 'after_passed'].includes(report.stage),
    'INCOMPLETE_REPORT_DO_NOT_RECREATE',
  );
  for (const key of ['userId', 'projectId', 'credentialId', 'uploadAssetId'])
    check(UUID.test(report[key]), 'REPORT_UUID_INVALID');
  check(SHA256.test(report.canvasSha256), 'REPORT_CANVAS_HASH_INVALID');
  for (const mediaType of ['text', 'image']) {
    const run = report.runs?.[mediaType];
    check(
      run && Object.keys(run).every((key) => ['id', 'assetId', 'sha256'].includes(key)),
      'REPORT_RUN_INVALID',
    );
    check(
      /^run_idem_[0-9a-f]{64}$/.test(run.id) && UUID.test(run.assetId) && SHA256.test(run.sha256),
      'REPORT_RUN_ID_INVALID',
    );
  }
  return report;
}

/** 原子更新白名单报告；报告不含 API 返回体、密码、token、key 或连接串。 */
async function saveReport(report, first = false) {
  await mkdir(dirname(REPORT), { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (first) return writeFile(REPORT, body, { flag: 'wx', mode: 0o600 });
  await writeFile(`${REPORT}.tmp`, body, { flag: 'w', mode: 0o600 });
  await rename(`${REPORT}.tmp`, REPORT);
}

/** 对应 app.test.ts 上传契约，PUT 成功是 204，complete 后校验存储内容和预览。 */
async function upload(token, marker) {
  const bytes = syntheticPng();
  const metadata = {
    name: `${marker.replace(':', '-')}.png`,
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    sha256: digest(bytes),
  };
  const initialized = await request('/v1/assets/uploads/init', {
    method: 'POST',
    token,
    body: { ...metadata, tags: ['docker-smoke'] },
    expected: 201,
  });
  check(/^upload_[\w-]+$/.test(initialized.uploadId), 'UPLOAD_ID_INVALID');
  check(
    localUrl(initialized.uploadUrl).pathname === `/v1/assets/uploads/${initialized.uploadId}` &&
      initialized.completeUrl === '/v1/assets/uploads/complete',
    'PROXY_UPLOAD_CONTRACT_MISMATCH',
  );
  await request(initialized.uploadUrl, { method: 'PUT', token, bytes, expected: 204 });
  const { asset } = await request(initialized.completeUrl, {
    method: 'POST',
    token,
    body: { ...metadata, uploadId: initialized.uploadId },
    expected: 201,
  });
  check(asset.sha256 === metadata.sha256 && asset.mediaType === 'image', 'UPLOAD_INTEGRITY_FAILED');
  return asset.id;
}

/** 真实 BullMQ 提交；只在本次初始阶段验证同一幂等键的重复 HTTP 请求，不调用 retry。 */
async function generate(report, token, mediaType) {
  const nodeId = `smoke_${mediaType}_${report.suiteId}`;
  const path = `/v1/nodes/${nodeId}/runs`;
  const body = {
    projectId: report.projectId,
    modelAlias: MODELS[mediaType === 'text' ? 0 : 1].id,
    credentialId: report.credentialId,
  };
  const key = `mc-smoke:${report.suiteId}:${mediaType}`;
  const { run: first } = await request(path, {
    method: 'POST',
    token,
    body: { ...body, idempotencyKey: key },
    expected: 202,
  });
  check(/^run_idem_[0-9a-f]{64}$/.test(first.id), 'RUN_ID_INVALID');
  report.runs[mediaType] = { id: first.id };
  await saveReport(report);
  const { run: duplicate } = await request(path, {
    method: 'POST',
    token,
    body,
    headers: { 'idempotency-key': key },
    expected: 202,
  });
  check(duplicate.id === first.id, 'DUPLICATE_API_RUN_CREATED');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { run } = await request(`/v1/runs/${first.id}`, { token });
    check(!['failed', 'cancelled'].includes(run.status), 'SYNTHETIC_RUN_FAILED');
    if (run.status === 'succeeded') {
      const asset = run.result?.asset;
      check(
        run.provider === 'newapi' && asset && UUID.test(asset.assetId),
        'ARCHIVED_RESULT_MISSING',
      );
      report.runs[mediaType] = { id: first.id, assetId: asset.assetId, sha256: asset.sha256 };
      await saveReport(report);
      return;
    }
    await delay(500);
  }
  throw new Error('RUN_TIMEOUT_POLL_EXISTING_ID_ONLY');
}

/**
 * 按浏览器流程签发并读取同源短期 URL；只访问已知资产，不新增资产或生成任务。
 * @param assetId 报告中的已核验资产 ID。
 * @param token 当前进程中的鉴权令牌，仅用于签发请求，不传给返回 URL 的 GET。
 * @param expectedContent 同一资源经 Bearer GET 读取的字节，用于 SHA-256 比对。
 * @param derivative 可选 thumbnail；省略时读取原始内容。
 * @throws URL 不安全、响应失败或内容不一致时抛出固定错误，不回显短期签名。
 */
async function verifyAccessUrl(assetId, token, expectedContent, derivative) {
  const path = derivative
    ? `/v1/assets/${assetId}/derivatives/${derivative}`
    : `/v1/assets/${assetId}/content`;
  const issued = await request(`/v1/assets/${assetId}/access-url`, {
    method: 'POST',
    token,
    body: { expiresInSeconds: 60, ...(derivative ? { derivative } : {}) },
  });
  const relativeUrl = checkedAccessUrl(issued.url, path);
  const expiresAt = Date.parse(issued.expiresAt);
  const now = Date.now();
  check(expiresAt > now && expiresAt <= now + 90_000, 'ACCESS_URL_EXPIRY_INVALID');
  const bytes = await request(relativeUrl, { binary: true });
  check(digest(bytes) === digest(expectedContent), 'SIGNED_ASSET_BYTES_MISMATCH');
}

/** 校验已有图片 thumbnail 的鉴权及无 Bearer 访问；缺失时失败，不重新生成派生。 */
async function verifyThumbnail(assetId, token) {
  const thumbnail = await request(`/v1/assets/${assetId}/derivatives/thumbnail`, {
    token,
    binary: true,
  });
  check(thumbnail.length > 20, 'FFMPEG_THUMBNAIL_MISSING');
  await verifyAccessUrl(assetId, token, thumbnail, 'thumbnail');
}

/** 验证已知资源、浏览器签名访问、Prisma 记录和真实 ZIP 内容；不触发生成。 */
async function verify(report, token) {
  const marker = `mc-docker-smoke:${report.suiteId}`;
  const { project } = await request(`/v1/projects/${report.projectId}`, { token });
  check(project.name === marker, 'PROJECT_NOT_PERSISTED');
  const { canvas } = await request(`/v1/projects/${report.projectId}/canvas`, { token });
  check(digest(JSON.stringify(canvas)) === report.canvasSha256, 'CANVAS_NOT_PERSISTED');
  const uploadContent = await request(`/v1/assets/${report.uploadAssetId}/content`, {
    token,
    binary: true,
  });
  check(digest(uploadContent) === digest(syntheticPng()), 'UPLOADED_BYTES_NOT_PERSISTED');
  await verifyAccessUrl(report.uploadAssetId, token, uploadContent);
  await verifyThumbnail(report.uploadAssetId, token);
  const { runs } = await request(`/v1/projects/${report.projectId}/runs`, { token });
  check(
    runs.length === 2 &&
      runs.every((run) => Object.values(report.runs).some((known) => known.id === run.id)),
    'RUN_LIST_DUPLICATED',
  );
  for (const mediaType of ['text', 'image']) {
    const expected = report.runs[mediaType];
    const { run } = await request(`/v1/runs/${expected.id}`, { token });
    check(
      run.status === 'succeeded' && run.result?.asset?.assetId === expected.assetId,
      'RUN_RESULT_NOT_PERSISTED',
    );
    const bytes = await request(`/v1/assets/${expected.assetId}/content`, { token, binary: true });
    const synthesized = mediaType === 'text' ? Buffer.from(syntheticText(marker)) : syntheticPng();
    check(
      digest(bytes) === expected.sha256 && digest(bytes) === digest(synthesized),
      'GENERATED_BYTES_MISMATCH',
    );
    await verifyAccessUrl(expected.assetId, token, bytes);
    if (mediaType === 'image') await verifyThumbnail(expected.assetId, token);
    const { versions } = await request(`/v1/assets/${expected.assetId}/versions`, { token });
    check(versions.length === 1 && versions[0].version === 1, 'ASSET_VERSION_DUPLICATED');
    const version = await request(`/v1/assets/${expected.assetId}/versions/1/content`, {
      token,
      binary: true,
    });
    check(digest(version) === expected.sha256, 'VERSION_BYTES_NOT_PERSISTED');
  }
  const workflow = await request(`/v1/projects/${report.projectId}/export/workflow`, { token });
  check(
    workflow.schemaVersion === 1 &&
      workflow.project.id === report.projectId &&
      workflow.results.length === 2,
    'WORKFLOW_EXPORT_INVALID',
  );
  const archive = await request(`/v1/projects/${report.projectId}/export/results`, {
    token,
    binary: true,
  });
  // 使用 API 已锁定的 fflate 解码 ZIP，不额外安装依赖或自行解析压缩格式。
  const { unzipSync } = createRequire(resolve(ROOT, 'apps/api/package.json'))('fflate');
  const files = unzipSync(archive);
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
  check(
    manifest.project.id === report.projectId && manifest.fileCount >= 2,
    'RESULTS_MANIFEST_INVALID',
  );
  for (const known of Object.values(report.runs)) {
    const file = manifest.files.find((entry) => entry.assetId === known.assetId);
    check(file && digest(files[file.path]) === known.sha256, 'EXPORTED_ASSET_MISMATCH');
  }
  return (await probe('verify', report)).summary;
}

/** 首次 before 仅允许空设施；每个非幂等变更后记录身份，失败后绝不盲目重建。 */
async function before(target) {
  await inspectFixture(target);
  await probe('empty');
  const initialStats = await probe('fixture');
  check(initialStats.creations === 0 && initialStats.posts === 0, 'FIXTURE_ALREADY_USED');
  const suiteId = randomUUID();
  const marker = `mc-docker-smoke:${suiteId}`;
  const report = {
    schemaVersion: 1,
    project: PROJECT,
    origin: ORIGIN,
    suiteId,
    email: `smoke-${suiteId}@example.invalid`,
    stage: 'initializing',
    createdAt: new Date().toISOString(),
    runs: {},
  };
  await saveReport(report, true);
  const password = randomBytes(32).toString('base64url');
  let token;
  try {
    const registration = await request('/v1/auth/register', {
      method: 'POST',
      body: { email: report.email, password, displayName: marker },
      expected: 201,
    });
    report.userId = registration.user.id;
    token = registration.accessToken;
    await saveReport(report);
    await request('/v1/settings/ai', { token, expected: 403 });
    await request('/v1/auth/logout', { method: 'POST', token });
    await request('/v1/auth/me', { token, expected: 401 });
    token = undefined;
    await docker(composeArgs('exec', '-T', 'api', 'node', 'docker/run.mjs', 'admin', report.email));
    token = await login(report.email, password);
    const { user } = await request('/v1/auth/me', { token });
    check(user.id === report.userId && user.role === 'admin', 'ADMIN_LOGIN_FAILED');
    const { settings } = await request('/v1/settings/ai', { token });
    const { credentials } = await request('/v1/settings/ai/credentials', { token });
    check(
      !settings.configured &&
        !settings.baseUrl &&
        !settings.keyFingerprint &&
        credentials.length === 0 &&
        Object.keys(settings.defaultModels).length === 0,
      'UNKNOWN_PROVIDER_CONFIGURATION',
    );
    const configured = await request('/v1/settings/ai', {
      method: 'PATCH',
      token,
      body: { baseUrl: PROVIDER, apiKey: SYNTHETIC_KEY },
    });
    check(
      configured.credentials.length === 1 && configured.settings.baseUrl === PROVIDER,
      'SYNTHETIC_PROVIDER_NOT_CONFIGURED',
    );
    report.credentialId = configured.credentials[0].id;
    await saveReport(report);
    const { models } = await request('/v1/settings/ai/models/refresh', {
      method: 'POST',
      token,
      body: { credentialId: report.credentialId },
    });
    check(
      MODELS.every((known) =>
        models.some((model) => model.id === known.id && model.credentialId === report.credentialId),
      ),
      'SYNTHETIC_MODEL_CATALOG_INVALID',
    );
    const { project } = await request('/v1/projects', {
      method: 'POST',
      token,
      body: { name: marker },
      expected: 201,
    });
    report.projectId = project.id;
    await saveReport(report);
    report.uploadAssetId = await upload(token, marker);
    await saveReport(report);
    const document = {
      revision: 0,
      nodes: [
        {
          id: `smoke_source_${suiteId}`,
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Synthetic upload',
            mediaType: 'image',
            mode: 'source',
            assetId: report.uploadAssetId,
          },
        },
        ...['text', 'image'].map((mediaType, index) => ({
          id: `smoke_${mediaType}_${suiteId}`,
          type: mediaType,
          position: { x: 300, y: index * 240 },
          data: {
            label: `Synthetic ${mediaType}`,
            mediaType,
            mode: 'generate',
            prompt: marker,
            modelAlias: MODELS[index].id,
            credentialId: report.credentialId,
          },
        })),
      ],
      edges: [],
    };
    await request(`/v1/projects/${project.id}/canvas`, { method: 'PATCH', token, body: document });
    await request(`/v1/projects/${project.id}/canvas`, {
      method: 'PATCH',
      token,
      body: document,
      expected: 409,
    });
    const { canvas } = await request(`/v1/projects/${project.id}/canvas`, { token });
    check(canvas.revision === 1 && canvas.nodes.length === 3, 'CANVAS_SAVE_FAILED');
    report.canvasSha256 = digest(JSON.stringify(canvas));
    await saveReport(report);
    for (const mediaType of ['text', 'image']) await generate(report, token, mediaType);
    const summary = await verify(report, token);
    const stats = await probe('fixture');
    check(
      stats.creations === 2 && stats.posts === 2 && stats.replays === 0 && stats.conflicts === 0,
      'DUPLICATE_PROVIDER_CREATION',
    );
    report.before = {
      checkedAt: new Date().toISOString(),
      containers: target,
      summary,
      fixture: stats,
    };
    report.stage = 'before_passed';
    await saveReport(report);
    console.log(
      'before passed: auth, canvas, proxy upload, exports, BullMQ/Worker/S3/Prisma, idempotency and usage.',
    );
  } finally {
    if (token) await request('/v1/auth/logout-all', { method: 'POST', token });
  }
}

/** 确认六个必需容器确实在 before 后启动；不把相同进程误报为重启持久化通过。 */
function validateRestart(report, target) {
  for (const service of SERVICES) {
    const previous = report.before?.containers?.[service];
    const current = target[service];
    check(
      previous &&
        Date.parse(current.startedAt) > Date.parse(previous.startedAt) &&
        Date.parse(current.startedAt) > Date.parse(report.before.checkedAt),
      'CONTAINER_RESTART_NOT_OBSERVED',
    );
  }
}

/** 恢复仅匹配报告中的合成账号；重置随机密码后走正常登录，其他资源只读。 */
async function resume(report, phase, target) {
  validateReport(report);
  if (phase === 'after') validateRestart(report, target);
  await probe('verify', report);
  const password = randomBytes(32).toString('base64url');
  await probe('rekey', report, testPasswordHash(password));
  const token = await login(report.email, password);
  try {
    const summary = await verify(report, token);
    check(
      JSON.stringify(summary) === JSON.stringify(report.before.summary),
      'PERSISTED_RECORD_COUNTS_CHANGED',
    );
    if (phase === 'after') {
      report.after = { checkedAt: new Date().toISOString(), containers: target, summary };
      report.stage = 'after_passed';
      await saveReport(report);
    }
    console.log(
      `${phase} verification passed: only recorded synthetic project, assets and runs were read; no new generation.`,
    );
  } finally {
    await request('/v1/auth/logout-all', { method: 'POST', token });
  }
}

/** 无 Docker、无 HTTP 的静态回归：安全边界、fixture 契约和 Node 24 图像完整性。 */
async function selfTest() {
  const { default: assert } = await import('node:assert/strict');
  const { test } = await import('node:test');
  await test('目标白名单在任何设施操作前拒绝其他项目和 URL', () => {
    assert.equal(options(['before', '--project', PROJECT, '--base-url', ORIGIN]), 'before');
    for (const args of [
      ['before', '--project', 'multimodal-canvas-app'],
      ['after', '--base-url', 'https://example.invalid'],
      ['before', '--restart'],
    ])
      assert.throws(() => options(args));
    for (const url of [
      'https://example.invalid/v1',
      'http://127.0.0.1:18080/v1',
      'http://localhost:8080',
      'http://u:p@localhost:18080/v1',
      '//example.invalid/v1',
    ])
      assert.throws(() => localUrl(url));
    assert.equal(localUrl('/v1/auth/me').origin, ORIGIN);
  });
  await test('浏览器访问 URL 只接受本源已知资源的相对签名路径', () => {
    const path = `/v1/assets/${randomUUID()}/content`;
    const valid = `${path}?access_token=synthetic-only`;
    assert.equal(checkedAccessUrl(valid, path), valid);
    for (const value of [
      `https://minio:9000${valid}`,
      `http://minio:9000${valid}`,
      `//minio:9000${valid}`,
      `${ORIGIN}${valid}`,
      `//localhost:18080${valid}`,
      `\\\\minio:9000${valid}`,
      `/\\minio:9000${valid}`,
      ` ${valid}`,
      `${valid}\n`,
      'v1/assets/content?access_token=synthetic-only',
      null,
    ])
      assert.throws(() => checkedAccessUrl(value, path), /ACCESS_URL_MUST_BE_RELATIVE/);
    for (const value of [
      path,
      `${path}?access_token=`,
      `${valid}&access_token=duplicate`,
      `${valid}&target=https://minio:9000`,
    ])
      assert.throws(() => checkedAccessUrl(value, path), /ACCESS_URL_SIGNATURE_MISSING/);
    assert.throws(() => checkedAccessUrl(`${valid}#fragment`, path), /HTTP_TARGET_REJECTED/);
    const thumbnailPath = path.replace('/content', '/derivatives/thumbnail');
    assert.equal(
      checkedAccessUrl(`${thumbnailPath}?access_token=synthetic-only`, thumbnailPath),
      `${thumbnailPath}?access_token=synthetic-only`,
    );
    assert.throws(() => checkedAccessUrl(valid, thumbnailPath), /ACCESS_URL_RESOURCE_MISMATCH/);
  });
  await test('合成响应遵守模型、幂等和 usage 两种语义，无外部资源 URL', () => {
    const fixture = createFixture();
    const marker = `mc-docker-smoke:${randomUUID()}`;
    const input = { model: MODELS[0].id, messages: [{ role: 'user', content: marker }] };
    const first = fixture.generate('/v1/chat/completions', 'synthetic-job', input);
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0].message.content, syntheticText(marker));
    assert.equal(first.body.usage.total_tokens, 15);
    assert.equal(first.body.usage.total_cost, undefined);
    assert.deepEqual(fixture.generate('/v1/chat/completions', 'synthetic-job', input), first);
    assert.equal(
      fixture.generate('/v1/chat/completions', 'synthetic-job', { ...input, temperature: 1 })
        .status,
      409,
    );
    const image = fixture.generate('/v1/images/generations', 'synthetic-image', {
      model: MODELS[1].id,
      prompt: marker,
    });
    assert.equal(image.body.usage.total_cost, '0.0123');
    assert.equal(
      digest(Buffer.from(image.body.data[0].b64_json, 'base64')),
      digest(syntheticPng()),
    );
    assert.equal(
      fixture.generate('/v1/chat/completions', 'external', {
        ...input,
        url: 'https://example.invalid',
      }).status,
      400,
    );
    assert.equal(fixture.stats().creations, 2);
  });
  await test('重启验收拒绝未重启服务，报告拒绝秘密字段和未完成状态', () => {
    assert.throws(() => validateRestart({ before: { containers: {} } }, {}));
    assert.throws(() => validateReport({ schemaVersion: 1, token: 'synthetic' }));
    assert.throws(() =>
      validateReport({
        schemaVersion: 1,
        project: PROJECT,
        origin: ORIGIN,
        suiteId: randomUUID(),
        stage: 'initializing',
      }),
    );
    assert.match(testPasswordHash('synthetic-only-test-password'), /^scrypt\$1\$32768\$8\$1\$/);
  });
  await test('必需服务核验拒绝错误标签、非健康状态和用户栈端口', () => {
    const valid = {
      Id: 'a'.repeat(64),
      Config: {
        Labels: {
          'com.docker.compose.project': PROJECT,
          'com.docker.compose.service': 'web',
          'com.docker.compose.project.config_files': COMPOSE,
        },
      },
      State: { Running: true, Health: { Status: 'healthy' } },
      NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } },
    };
    assert.doesNotThrow(() => validateContainer(valid, 'web'));
    const wrongProject = structuredClone(valid);
    wrongProject.Config.Labels['com.docker.compose.project'] = 'multimodal-canvas-app';
    assert.throws(() => validateContainer(wrongProject, 'web'), /CONTAINER_PROJECT_MISMATCH/);
    const wrongPort = structuredClone(valid);
    wrongPort.NetworkSettings.Ports['8080/tcp'][0].HostPort = '8080';
    assert.throws(() => validateContainer(wrongPort, 'web'), /WEB_BINDING_MISMATCH/);
    const unhealthy = structuredClone(valid);
    unhealthy.State.Health.Status = 'starting';
    assert.throws(() => validateContainer(unhealthy, 'web'), /SERVICE_NOT_HEALTHY/);
  });
  await test('合成 PNG 每个块 CRC 正确，32x24 RGB 像素流可解压', async () => {
    const { crc32, inflateSync } = await import('node:zlib');
    const png = syntheticPng();
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let offset = 8;
    let data;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString();
      const content = png.subarray(offset + 8, offset + 8 + length);
      assert.equal(
        crc32(png.subarray(offset + 4, offset + 8 + length)),
        png.readUInt32BE(offset + 8 + length),
      );
      if (type === 'IHDR') {
        assert.equal(content.readUInt32BE(0), 32);
        assert.equal(content.readUInt32BE(4), 24);
      }
      if (type === 'IDAT') data = inflateSync(content);
      offset += length + 12;
    }
    assert.equal(offset, png.length);
    assert.equal(data.length, 24 * 97);
  });
  await test('生产 API 和 Worker 必须显式采用同源下载代理', () => {
    for (const service of ['api', 'worker']) {
      const valid = {
        Id: 'a'.repeat(64),
        Config: {
          Labels: {
            'com.docker.compose.project': PROJECT,
            'com.docker.compose.service': service,
            'com.docker.compose.project.config_files': COMPOSE,
          },
          Env: [
            'NODE_ENV=production',
            'RUN_SERVICE=bullmq',
            'WORKER_PROVIDER=newapi',
            'S3_ENDPOINT=https://minio:9000',
            'S3_UPLOAD_MODE=proxy',
            'S3_DOWNLOAD_MODE=proxy',
            'NODE_EXTRA_CA_CERTS=/run/multimodal/secrets/ca.crt',
            'FFMPEG_ENABLED=true',
            'FFPROBE_ENABLED=true',
          ],
        },
        State: { Running: true, Health: { Status: 'healthy' } },
        NetworkSettings: { Ports: {} },
      };
      assert.doesNotThrow(() => validateContainer(valid, service));
      for (const mode of [undefined, 'direct']) {
        const invalid = structuredClone(valid);
        invalid.Config.Env = invalid.Config.Env.filter(
          (item) => !item.startsWith('S3_DOWNLOAD_MODE='),
        );
        if (mode !== undefined) invalid.Config.Env.push(`S3_DOWNLOAD_MODE=${mode}`);
        assert.throws(() => validateContainer(invalid, service), /PRODUCTION_RUNTIME_MISMATCH/);
      }
    }
  });
}

/** 主入口先验证设施，之后才可能访问固定本机 HTTP；after 不要求 fixture 仍在线。 */
async function main() {
  const phase = options(process.argv.slice(2));
  check(Number(process.versions.node.split('.')[0]) === 24, 'NODE_24_REQUIRED');
  if (phase === '--self-test') return selfTest();
  const target = await inspectTarget();
  const health = await request('/health');
  check(health.status === 'ok' && health.service === 'api', 'API_HEALTH_INVALID');
  const html = await request('/', { binary: true });
  check(
    html.includes(Buffer.from('<!doctype html>')) || html.includes(Buffer.from('<!DOCTYPE html>')),
    'PRODUCTION_WEB_MISSING',
  );
  check(!html.includes(Buffer.from('/@vite/client')), 'DEV_WEB_REJECTED');
  if (existsSync(REPORT)) return resume(JSON.parse(await readFile(REPORT, 'utf8')), phase, target);
  check(phase === 'before', 'BEFORE_REPORT_REQUIRED');
  return before(target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message ?? '')
      ? error.message
      : 'SMOKE_FAILED_REVIEW_CHECKPOINT';
    console.error(`Docker smoke failed: ${code}. No automatic retry or cleanup was performed.`);
    process.exitCode = 1;
  });
}

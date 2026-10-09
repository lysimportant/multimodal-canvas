/** 使用合成变量检查 Compose 的 R2 部署、Neon 切换和稳定密钥；不启动业务设施。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertEmptySecretViews,
  createSecretViews,
  restrictSecretTree,
  SECRET_VIEWS,
} from './init.mjs';

/** 不继承用户部署配置；只保留 CLI 所需系统变量及合成连接信息。 */
const environment = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  COMPOSE_DISABLE_ENV_FILE: '1',
  COMPOSE_PROFILES: '',
  S3_ENDPOINT: 'https://synthetic-account.r2.cloudflarestorage.com',
  S3_BUCKET: 'synthetic-canvas',
  S3_ACCESS_KEY: 'synthetic-access-key',
  S3_SECRET_KEY: 'synthetic-secret-key',
  NEW_API_ISSUER: 'https://newapi.example.com',
  NEW_API_CLIENT_ID: 'canvas',
  NEW_API_INSTANCE_ID: 'main',
  MC_HTTP_PORT: '8080',
};
const root = fileURLToPath(new URL('../../', import.meta.url));

/** 调用 Compose 自身解析继承/overlay；仅返回配置，不启动或修改容器。 */
function compose({ overlay = false, profile, values = {} } = {}) {
  const arguments_ = ['compose', '-f', 'compose.yaml'];
  if (overlay) arguments_.push('-f', 'compose.neon.yaml');
  if (profile) arguments_.push('--profile', profile);
  arguments_.push('config', '--format', 'json');
  return JSON.parse(
    execFileSync('docker', arguments_, {
      cwd: root,
      encoding: 'utf8',
      env: { ...environment, ...values },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

test('默认栈仅含应用、数据库、队列和一次性初始化/迁移，R2 配置必须存在', () => {
  const configuration = compose({ values: { CANVAS_WEB_URL: 'http://localhost:8080' } });
  assert.deepEqual(Object.keys(configuration.services).sort(), [
    'api',
    'initialize',
    'migrate',
    'postgres',
    'redis',
    'web',
    'worker',
  ]);
  assert.equal(configuration.name, 'multimodal-canvas-app');
  for (const name of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'NEW_API_ISSUER',
  ]) {
    assert.throws(() => compose({ values: { [name]: '' } }));
  }
});

test('部署固定持久执行和 New API，R2 region/校验和与代理素材配置一致', () => {
  const configuration = compose();
  for (const service of ['api', 'worker', 'migrate']) {
    const runtime = configuration.services[service].environment;
    assert.equal(runtime.NODE_ENV, 'production');
    assert.equal(runtime.RUN_SERVICE, 'bullmq');
    assert.equal(runtime.WORKER_PROVIDER, 'newapi');
    assert.equal(runtime.S3_ENDPOINT, environment.S3_ENDPOINT);
    assert.equal(runtime.S3_REGION, 'auto');
    assert.equal(runtime.AWS_REQUEST_CHECKSUM_CALCULATION, 'WHEN_REQUIRED');
    assert.equal(runtime.AWS_RESPONSE_CHECKSUM_VALIDATION, 'WHEN_REQUIRED');
    assert.equal(runtime.S3_UPLOAD_MODE, 'proxy');
    assert.equal(runtime.S3_DOWNLOAD_MODE, 'proxy');
    assert.equal(runtime.FFMPEG_ENABLED, 'true');
    assert.equal(runtime.FFPROBE_ENABLED, 'true');
    assert.equal(runtime.NEW_API_REDIRECT_URI, 'http://localhost:8080/v1/auth/newapi/callback');
    assert.equal(runtime.CANVAS_WEB_URL, 'http://localhost:8080');
    assert.equal(runtime.CORS_ORIGIN, '');
    assert.equal(runtime.API_TRUST_PROXY_HOPS, '1');
    assert.equal(runtime.RUN_QUEUE_NAME, 'canvas-accounts-v1');
    assert.equal(runtime.DATABASE_URL, undefined);
    assert.equal(runtime.API_JWT_SECRET, undefined);
    assert.equal(runtime.AI_CREDENTIAL_ENCRYPTION_KEY, undefined);
    assert.equal(runtime.NEW_API_WEBHOOK_SECRET, undefined);
    assert.equal(runtime.NEW_API_API_KEY, undefined);
    assert.ok(!runtime.NODE_TLS_REJECT_UNAUTHORIZED);
  }
  assert.equal(
    configuration.services.api.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(configuration.services.worker.depends_on.api.condition, 'service_healthy');
});

test('只有 Web 发布回环端口；数据与稳定密钥卷名称保持原部署兼容', () => {
  const configuration = compose();
  assert.equal(configuration.services.web.ports[0].host_ip, '127.0.0.1');
  assert.equal(configuration.services.web.ports[0].published, '8080');
  for (const name of ['api', 'worker', 'postgres', 'redis'])
    assert.equal(configuration.services[name].ports, undefined);
  for (const name of [
    'secrets',
    'app_secrets',
    'postgres_secrets',
    'redis_secrets',
    'postgres',
    'redis',
  ]) {
    assert.equal(configuration.volumes[name].name, `multimodal-canvas-app_${name}`);
  }
  for (const name of ['api', 'worker', 'migrate']) {
    assert.equal(configuration.services[name].read_only, true);
    assert.ok(configuration.services[name].volumes.every(({ read_only }) => read_only));
  }
  const expected = {
    api: 'app_secrets',
    worker: 'app_secrets',
    migrate: 'app_secrets',
    postgres: 'postgres_secrets',
    redis: 'redis_secrets',
  };
  for (const [name, service] of Object.entries(configuration.services)) {
    assert.equal(
      (service.volumes ?? []).some(({ source }) => source === 'secrets'),
      name === 'initialize',
    );
    if (expected[name])
      assert.ok(
        service.volumes.some(
          ({ source, target, read_only }) =>
            source === expected[name] && target === '/run/multimodal' && read_only,
        ),
      );
  }
});

test('Neon overlay 仅在显式配置时切换，应用与迁移共用直连串且不启动本地数据库', () => {
  assert.throws(() => compose({ overlay: true }));
  const url = 'postgresql://synthetic:synthetic@ep-synthetic.neon.tech/neondb?sslmode=require';
  const configuration = compose({ overlay: true, values: { DATABASE_URL: url } });
  assert.equal(configuration.services.postgres, undefined);
  assert.deepEqual(Object.keys(configuration.services.migrate.depends_on), ['initialize']);
  for (const service of ['api', 'worker', 'migrate'])
    assert.equal(configuration.services[service].environment.DATABASE_URL, url);
  assert.equal(
    compose({ values: { DATABASE_URL: url } }).services.api.environment.DATABASE_URL,
    undefined,
  );
});

test('可选 HTTPS 网关使用单独证书卷且保持内部 API 不发布', () => {
  const configuration = compose({
    profile: 'server',
    values: {
      MC_DOMAIN: 'canvas.example.com',
      CANVAS_WEB_URL: 'https://canvas.example.com',
      CORS_ORIGIN: 'https://canvas.example.com',
    },
  });
  assert.equal(configuration.services.gateway.environment.MC_DOMAIN, 'canvas.example.com');
  assert.equal(
    configuration.services.api.environment.NEW_API_REDIRECT_URI,
    'https://canvas.example.com/v1/auth/newapi/callback',
  );
  assert.equal(configuration.services.api.environment.CORS_ORIGIN, 'https://canvas.example.com');
  assert.deepEqual(
    configuration.services.gateway.ports.map(({ published }) => published),
    ['80', '443', '443'],
  );
  assert.ok(configuration.services.gateway.volumes.some(({ source }) => source === 'gateway_data'));
});

/** 合成源卷和派生目录；仅精确清理本次临时目录，生产测试不运行 openssl。 */
async function secretFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'multimodal-secret-views-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'canonical', 'secrets');
  const views = join(directory, 'views');
  const runtime = Object.fromEntries(
    ['postgres', 'redis', 'jwt', 'encryption', 'webhook'].map((name, index) => [
      name,
      String(index + 1).repeat(64),
    ]),
  );
  const files = {
    'runtime.json': JSON.stringify(runtime),
    'postgres-password': runtime.postgres,
    'redis-password': runtime.redis,
    'ca.key': 'synthetic-ca-key',
    'ca.crt': 'synthetic-ca-certificate',
    'redis.conf': `requirepass ${runtime.redis}\n`,
    'redis/public.crt': 'synthetic-redis-certificate',
    'redis/private.key': 'synthetic-redis-key',
  };
  for (const [name, value] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), value);
  }
  const owners = new Map();
  return {
    source,
    views,
    files,
    owners,
    options: { setOwner: async (path, uid, gid) => owners.set(path, { uid, gid }) },
  };
}

/** 读取派生视图内的相对文件路径，用于精确白名单验证。 */
async function viewFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await viewFiles(join(directory, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

test('只发布三种服务的最小密钥视图，收紧权限且不改写内容', async (t) => {
  const fixture = await secretFixture(t);
  await restrictSecretTree(fixture.source);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  assert.deepEqual(Object.keys(SECRET_VIEWS), ['app', 'postgres', 'redis']);
  assert.deepEqual(SECRET_VIEWS.app.files, ['runtime.json', 'ca.crt']);
  for (const [name, view] of Object.entries(SECRET_VIEWS)) {
    const published = join(fixture.views, name, 'secrets');
    assert.deepEqual(await viewFiles(published), [...view.files].sort());
    for (const file of view.files) {
      const path = join(published, file);
      assert.equal(await readFile(path, 'utf8'), fixture.files[file]);
      assert.deepEqual(fixture.owners.get(path), { uid: view.uid, gid: view.gid });
      if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o400);
    }
  }
});

test('重复初始化保持稳定密钥，恢复缺失视图和中断的临时副本', async (t) => {
  const fixture = await secretFixture(t);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  const runtime = join(fixture.views, 'app', 'secrets', 'runtime.json');
  const before = await lstat(runtime);
  const pending = join(fixture.views, 'app', '.pending');
  await writeFile(join(pending, 'ca.crt'), 'interrupted');
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  assert.equal((await lstat(runtime)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(pending), []);
});

test('冲突视图和未知文件拒绝覆盖，符号链接拒绝跟随', async (t) => {
  const fixture = await secretFixture(t);
  const target = join(fixture.views, 'app', 'secrets');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'runtime.json'), 'existing');
  await assert.rejects(
    createSecretViews(fixture.source, fixture.views, fixture.options),
    /differs from canonical/,
  );
  assert.equal(await readFile(join(target, 'runtime.json'), 'utf8'), 'existing');
  const other = await secretFixture(t);
  await mkdir(join(other.views, 'app'), { recursive: true });
  await symlink(other.source, join(other.views, 'app', 'secrets'), 'junction');
  await assert.rejects(
    createSecretViews(other.source, other.views, other.options),
    /not a directory/,
  );
});

test('canonical 损坏或丢失时拒绝生成替代密钥', async (t) => {
  const fixture = await secretFixture(t);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  await assert.rejects(assertEmptySecretViews(fixture.views), /restore the canonical backup/);
  await chmod(join(fixture.source, 'runtime.json'), 0o600);
  await writeFile(join(fixture.source, 'runtime.json'), '{}');
  await assert.rejects(
    createSecretViews(fixture.source, fixture.views, fixture.options),
    /Invalid secret field/,
  );
});

test('旧 canonical 中已退出使用的字段和文件不影响有效密钥恢复，也不删除历史文件', async (t) => {
  const fixture = await secretFixture(t);
  const runtime = JSON.parse(fixture.files['runtime.json']);
  runtime.s3 = 'a'.repeat(64);
  await writeFile(join(fixture.source, 'runtime.json'), JSON.stringify(runtime));
  await writeFile(join(fixture.source, 'retired-storage-key'), 'legacy');
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  assert.equal(await readFile(join(fixture.source, 'retired-storage-key'), 'utf8'), 'legacy');
  assert.equal(
    JSON.parse(await readFile(join(fixture.views, 'app', 'secrets', 'runtime.json'), 'utf8'))
      .encryption,
    runtime.encryption,
  );
});

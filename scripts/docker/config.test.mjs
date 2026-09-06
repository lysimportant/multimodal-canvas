/** 校验完整 Compose 的生产模式、安全边界和重启持久化约束；不启动或修改容器。 */
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

/** 仓库根目录；不依赖调用者当前工作目录。 */
const root = fileURLToPath(new URL('../../', import.meta.url));
/** 配置测试不加载开发 .env，不继承外部 profile 或项目名；不连接 Docker daemon。 */
const composeEnvironment = {
  ...process.env,
  COMPOSE_DISABLE_ENV_FILE: '1',
  COMPOSE_PROFILES: '',
  COMPOSE_PROJECT_NAME: 'multimodal-canvas-app',
  MC_HTTP_PORT: '8080',
  MC_VIDEO_CONTRACT: 'newapi-unified-v1',
  MC_PUBLIC_ORIGIN: '',
  MC_APP_PUBLIC_URL: '',
};
/** Docker Compose 自己解析 YAML，避免自行解析字符串或忽略继承后的配置。 */
const configuration = JSON.parse(
  execFileSync('docker', ['compose', '-f', 'compose.yaml', 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: composeEnvironment,
  }),
);

test('包含完整应用、持久化设施和一次性初始化', () => {
  assert.equal(configuration.services.api.environment.APP_PUBLIC_URL, 'http://localhost:8080');
  assert.deepEqual(Object.keys(configuration.services).sort(), [
    'api',
    'initialize',
    'migrate',
    'minio',
    'postgres',
    'redis',
    'storage-init',
    'web',
    'worker',
  ]);
  assert.equal(configuration.name, 'multimodal-canvas-app');
  for (const service of ['api', 'worker', 'migrate']) {
    const environment = configuration.services[service].environment;
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.RUN_SERVICE, 'bullmq');
    assert.equal(environment.WORKER_PROVIDER, 'newapi');
    assert.equal(environment.S3_UPLOAD_MODE, 'proxy');
    assert.equal(environment.S3_DOWNLOAD_MODE, 'proxy');
    assert.equal(environment.API_TRUST_PROXY_HOPS, '1');
    assert.equal(environment.FFMPEG_ENABLED, 'true');
    assert.equal(environment.FFPROBE_ENABLED, 'true');
    assert.equal(environment.S3_ENDPOINT, 'https://minio:9000');
    assert.ok(environment.NODE_EXTRA_CA_CERTS.endsWith('/ca.crt'));
    assert.ok(!environment.NODE_TLS_REJECT_UNAUTHORIZED);
  }
});

test('只将 Web 发布到宿主回环，不暴露数据库、队列、对象存储或 API', () => {
  const web = configuration.services.web;
  assert.equal(web.ports.length, 1);
  assert.equal(web.ports[0].host_ip, '127.0.0.1');
  assert.equal(web.ports[0].published, '8080');
  for (const name of ['api', 'worker', 'postgres', 'redis', 'minio']) {
    assert.equal(configuration.services[name].ports, undefined);
  }
});

test('长驻服务自动重启，业务卷与现有开发栈分离', () => {
  for (const name of ['web', 'api', 'worker', 'postgres', 'redis', 'minio']) {
    assert.equal(configuration.services[name].restart, 'unless-stopped');
  }
  for (const name of ['initialize', 'migrate', 'storage-init']) {
    assert.equal(configuration.services[name].restart, 'no');
  }
  for (const name of ['secrets', 'postgres', 'redis', 'minio']) {
    assert.equal(configuration.volumes[name].name, `multimodal-canvas-app_${name}`);
  }
  for (const name of ['api', 'worker']) {
    assert.equal(configuration.services[name].read_only, true);
    assert.ok(configuration.services[name].volumes.every((volume) => volume.read_only));
    assert.ok(configuration.services[name].healthcheck);
  }
});

test('Compose 不嵌入实际口令，初始化顺序包含迁移与对象存储', () => {
  for (const service of Object.values(configuration.services)) {
    for (const [name, value] of Object.entries(service.environment ?? {})) {
      if (/(?:PASSWORD|SECRET|API_KEY|ENCRYPTION_KEY|JWT_SECRET)$/.test(name)) {
        assert.fail(
          `Compose embeds a credential value: ${name}=${value ? '[REDACTED]' : '(empty)'}`,
        );
      }
    }
  }
  assert.equal(
    configuration.services.api.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(
    configuration.services.api.depends_on['storage-init'].condition,
    'service_completed_successfully',
  );
  assert.equal(configuration.services.worker.depends_on.api.condition, 'service_healthy');
});

test('canonical 卷仅初始化可见，各服务仅挂载自己的只读密钥视图', () => {
  const expected = {
    api: 'app_secrets',
    worker: 'app_secrets',
    migrate: 'app_secrets',
    postgres: 'postgres_secrets',
    redis: 'redis_secrets',
    minio: 'minio_secrets',
    'storage-init': 'storage_secrets',
  };
  for (const [name, service] of Object.entries(configuration.services)) {
    const mounts = service.volumes ?? [];
    assert.equal(
      mounts.some((mount) => mount.source === 'secrets'),
      name === 'initialize',
    );
    if (expected[name]) {
      const secrets = mounts.filter((mount) => mount.target === '/run/multimodal');
      assert.equal(secrets.length, 1);
      assert.equal(secrets[0].source, expected[name]);
      assert.equal(secrets[0].read_only, true);
    }
  }
  const initializer = configuration.services.initialize.volumes;
  assert.equal(initializer.length, 6);
  for (const name of Object.keys(SECRET_VIEWS)) {
    const source = `${name}_secrets`;
    assert.equal(configuration.volumes[source].name, `multimodal-canvas-app_${source}`);
    const mount = initializer.find((volume) => volume.source === source);
    assert.equal(mount.target, `/run/multimodal-views/${name}`);
    assert.notEqual(mount.read_only, true);
  }
  assert.deepEqual(configuration.services.web.tmpfs.map((entry) => entry.split(':')[0]).sort(), [
    '/config',
    '/data',
  ]);
});

test('Linux server profile 使用 HTTPS 来源和独立持久化证书，不改写 Web 编译地址', () => {
  const server = JSON.parse(
    execFileSync(
      'docker',
      ['compose', '-f', 'compose.yaml', '--profile', 'server', 'config', '--format', 'json'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...composeEnvironment,
          MC_DOMAIN: 'canvas.example.test',
          MC_PUBLIC_ORIGIN: 'https://canvas.example.test',
        },
      },
    ),
  );
  assert.equal(server.services.api.environment.CORS_ORIGIN, 'https://canvas.example.test');
  assert.equal(server.services.api.environment.APP_PUBLIC_URL, 'https://canvas.example.test');
  assert.equal(server.services.gateway.environment.MC_DOMAIN, 'canvas.example.test');
  assert.equal(server.services.gateway.restart, 'unless-stopped');
  assert.ok(server.services.gateway.ports.some((port) => port.published === '443'));
  assert.ok(server.services.gateway.volumes.some((volume) => volume.source === 'gateway_data'));
  assert.ok(
    server.services.gateway.volumes.some(
      (volume) => volume.target === '/etc/caddy/logging.caddy' && volume.read_only,
    ),
  );
  assert.equal(server.services.web.ports[0].host_ip, '127.0.0.1');
});

test('本地 HTTPS 不需要域名且仅绑定回环，证书卷与公网入口分离', () => {
  const local = JSON.parse(
    execFileSync(
      'docker',
      ['compose', '-f', 'compose.yaml', '--profile', 'local-https', 'config', '--format', 'json'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...composeEnvironment, MC_HTTPS_PORT: '8443' },
      },
    ),
  );
  assert.equal(local.services.gateway, undefined);
  const gateway = local.services['gateway-local'];
  assert.equal(gateway.environment.MC_DOMAIN, 'localhost, :443');
  assert.deepEqual(
    gateway.ports.map(({ host_ip, published }) => ({ host_ip, published })),
    [{ host_ip: '127.0.0.1', published: '8443' }],
  );
  assert.ok(gateway.volumes.some((volume) => volume.source === 'local_gateway_data'));
  assert.ok(
    gateway.volumes.some(
      (volume) => volume.target === '/etc/caddy/logging.caddy' && volume.read_only,
    ),
  );
  assert.ok(gateway.healthcheck);
  assert.equal(gateway.restart, 'unless-stopped');
});

/** 创建仅含合成值的临时 canonical 卷；精确清理测试目录，不读取现有卷或调用 openssl。 */
async function secretFixture(t) {
  const prefix = join(tmpdir(), 'multimodal-secret-views-');
  const directory = await mkdtemp(prefix);
  assert.ok(directory.startsWith(prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'canonical', 'secrets');
  const views = join(directory, 'views');
  const runtime = Object.fromEntries(
    ['postgres', 'redis', 's3', 'jwt', 'encryption', 'webhook'].map((name, index) => [
      name,
      String(index + 1).repeat(64),
    ]),
  );
  const files = {
    'runtime.json': JSON.stringify(runtime),
    'postgres-password': runtime.postgres,
    'redis-password': runtime.redis,
    's3-password': runtime.s3,
    'minio-password': 'a'.repeat(64),
    'ca.key': 'synthetic-ca-private-key',
    'ca.crt': 'synthetic-ca-certificate',
    'redis.conf': `requirepass ${runtime.redis}\n`,
    'redis/public.crt': 'synthetic-redis-certificate',
    'redis/private.key': 'synthetic-redis-private-key',
    'minio/public.crt': 'synthetic-minio-certificate',
    'minio/private.key': 'synthetic-minio-private-key',
  };
  for (const [name, value] of Object.entries(files)) {
    const target = join(source, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, { mode: 0o644 });
  }
  const owners = new Map();
  // 测试无需管理员权限；核对真实 chown 将收到的 UID/GID，生产不注入此替身。
  const options = {
    setOwner: async (path, uid, gid) => {
      owners.set(path, { uid, gid });
    },
  };
  return { source, views, files, owners, options };
}

/** 读取已发布视图的文件清单，保留相对路径以验证精确白名单。 */
async function viewFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await viewFiles(join(directory, entry.name), path)));
    else files.push(path);
  }
  return files.sort();
}

test('派生视图精确隔离文件并使用镜像 UID/GID，源卷收紧权限但不改值', async (t) => {
  const fixture = await secretFixture(t);
  await restrictSecretTree(fixture.source);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(SECRET_VIEWS).map(([name, view]) => [name, [view.uid, view.gid]]),
    ),
    {
      app: [1000, 1000],
      postgres: [70, 70],
      redis: [999, 1000],
      minio: [0, 0],
      storage: [0, 0],
    },
  );
  assert.deepEqual(SECRET_VIEWS.app.files, ['runtime.json', 'ca.crt']);
  assert.deepEqual(SECRET_VIEWS.postgres.files, ['postgres-password']);
  assert.deepEqual(SECRET_VIEWS.redis.files, [
    'redis-password',
    'redis.conf',
    'ca.crt',
    'redis/public.crt',
    'redis/private.key',
  ]);
  assert.deepEqual(SECRET_VIEWS.minio.files, [
    'minio-password',
    'ca.crt',
    'minio/public.crt',
    'minio/private.key',
  ]);
  assert.deepEqual(SECRET_VIEWS.storage.files, ['minio-password', 's3-password', 'ca.crt']);
  for (const [name, value] of Object.entries(fixture.files)) {
    assert.equal(await readFile(join(fixture.source, name), 'utf8'), value);
    if (process.platform !== 'win32')
      assert.equal((await lstat(join(fixture.source, name))).mode & 0o777, 0o400);
  }
  for (const [name, view] of Object.entries(SECRET_VIEWS)) {
    const volume = join(fixture.views, name);
    const published = join(volume, 'secrets');
    assert.deepEqual(await viewFiles(published), [...view.files].sort());
    for (const file of view.files) {
      const path = join(published, file);
      assert.equal(await readFile(path, 'utf8'), fixture.files[file]);
      assert.deepEqual(fixture.owners.get(path), { uid: view.uid, gid: view.gid });
      if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o400);
    }
    assert.deepEqual(fixture.owners.get(volume), { uid: view.uid, gid: view.gid });
    if (process.platform !== 'win32') assert.equal((await lstat(published)).mode & 0o777, 0o700);
  }
});

test('重复初始化不重写密钥，缺失视图和中断临时文件可以恢复', async (t) => {
  const fixture = await secretFixture(t);
  const published = join(fixture.views, 'app', 'secrets');
  const pending = join(fixture.views, 'app', '.pending');
  await mkdir(published, { recursive: true });
  await mkdir(pending, { recursive: true });
  const runtime = join(published, 'runtime.json');
  await writeFile(runtime, fixture.files['runtime.json']);
  await writeFile(join(pending, 'ca.crt'), 'interrupted-copy');
  const before = await lstat(runtime);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  assert.equal((await lstat(runtime)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(pending), []);
  for (const [name, view] of Object.entries(SECRET_VIEWS)) {
    assert.deepEqual(await viewFiles(join(fixture.views, name, 'secrets')), [...view.files].sort());
  }
});

test('已发布视图不一致时明确失败，不覆盖已有值或改变 canonical', async (t) => {
  const fixture = await secretFixture(t);
  const target = join(fixture.views, 'app', 'secrets', 'runtime.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'different-existing-value');
  await assert.rejects(
    createSecretViews(fixture.source, fixture.views, fixture.options),
    /Secret view differs from canonical: app\/runtime.json/,
  );
  assert.equal(await readFile(target, 'utf8'), 'different-existing-value');
  assert.equal(
    await readFile(join(fixture.source, 'runtime.json'), 'utf8'),
    fixture.files['runtime.json'],
  );
});

test('多余密钥及符号链接被拒绝，不跟随或删除未知内容', async (t) => {
  const fixture = await secretFixture(t);
  const target = join(fixture.views, 'app', 'secrets');
  await mkdir(target, { recursive: true });
  const extra = join(target, 'minio-password');
  await writeFile(extra, 'unexpected-secret');
  await assert.rejects(
    createSecretViews(fixture.source, fixture.views, fixture.options),
    /Unexpected secret view entry/,
  );
  assert.equal(await readFile(extra, 'utf8'), 'unexpected-secret');
  const other = await secretFixture(t);
  await mkdir(join(other.views, 'app'), { recursive: true });
  await symlink(other.source, join(other.views, 'app', 'secrets'), 'junction');
  await assert.rejects(
    createSecretViews(other.source, other.views, other.options),
    /Secret directory is not a directory/,
  );
});

test('canonical 缺失或损坏时拒绝派生，不生成替代密钥', async (t) => {
  const fixture = await secretFixture(t);
  await chmod(join(fixture.source, 'runtime.json'), 0o600);
  await writeFile(join(fixture.source, 'runtime.json'), '{}');
  await assert.rejects(
    createSecretViews(fixture.source, fixture.views, fixture.options),
    /Invalid secret field/,
  );
  await assert.rejects(lstat(fixture.views), { code: 'ENOENT' });
  assert.equal(await readFile(join(fixture.source, 'ca.key'), 'utf8'), fixture.files['ca.key']);
});

test('canonical 丢失但派生卷已存在时禁止首次密钥生成', async (t) => {
  const fixture = await secretFixture(t);
  await assertEmptySecretViews(fixture.views);
  await createSecretViews(fixture.source, fixture.views, fixture.options);
  await assert.rejects(assertEmptySecretViews(fixture.views), /restore the canonical backup/);
  assert.equal(
    await readFile(join(fixture.views, 'app', 'secrets', 'runtime.json'), 'utf8'),
    fixture.files['runtime.json'],
  );
});

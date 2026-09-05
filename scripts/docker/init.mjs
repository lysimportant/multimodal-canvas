/** 首次生成内部 TLS 和随机密钥，并发布按服务隔离的只读视图；已有密钥不轮换或覆盖。 */
import { randomBytes } from 'node:crypto';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 专用密钥卷；不得指向已有开发数据目录。 */
const root = process.env.DOCKER_SECRET_ROOT ?? '/run/multimodal';
/** 完整初始化后原子发布的目录。 */
const destination = join(root, 'secrets');
/** 派生卷仅在 initializer 可写；文件路径保持各服务现有的 /run/multimodal/secrets 契约。 */
const viewRoot = '/run/multimodal-views';

/** 本机锁定镜像的 UID/GID 与最小文件白名单；MinIO/mc 的默认入口使用 root。 */
export const SECRET_VIEWS = {
  app: { uid: 1000, gid: 1000, files: ['runtime.json', 'ca.crt'] },
  postgres: { uid: 70, gid: 70, files: ['postgres-password'] },
  redis: {
    uid: 999,
    gid: 1000,
    files: ['redis-password', 'redis.conf', 'ca.crt', 'redis/public.crt', 'redis/private.key'],
  },
  minio: {
    uid: 0,
    gid: 0,
    files: ['minio-password', 'ca.crt', 'minio/public.crt', 'minio/private.key'],
  },
  storage: { uid: 0, gid: 0, files: ['minio-password', 's3-password', 'ca.crt'] },
};

/** canonical 缺失时只允许全新空视图；已有派生内容必须先恢复源卷，禁止生成替代密钥。 */
export async function assertEmptySecretViews(views) {
  for (const name of Object.keys(SECRET_VIEWS)) {
    try {
      const directory = join(views, name);
      if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).length > 0) {
        throw new Error(
          'Canonical secrets are missing while derived volumes exist; restore the canonical backup',
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/** 收紧源卷权限但不改变内容或所有者；符号链接、设备和其他非普通文件显式拒绝。 */
export async function restrictSecretTree(directory) {
  const entry = await lstat(directory);
  if (entry.isFile()) {
    await chmod(directory, 0o400);
    return;
  }
  if (!entry.isDirectory()) throw new Error('Secret paths must be regular files or directories');
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) await restrictSecretTree(join(directory, name));
}

/** 创建或验证真实目录，禁止跟随预先植入的符号链接。 */
async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Secret directory is not a directory');
  await chmod(directory, 0o700);
}

/** 返回普通文件内容；仅文件不存在时返回 undefined，其他错误直接失败。 */
async function readSecretFile(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Secret path is not a regular file');
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 拒绝视图内白名单以外的文件和目录，避免历史错误挂载留下额外密钥。 */
async function validateViewEntries(directory, allowed, prefix = '') {
  for (const name of await readdir(directory)) {
    const path = prefix ? `${prefix}/${name}` : name;
    const entry = await lstat(join(directory, name));
    if (entry.isDirectory() && allowed.some((file) => file.startsWith(`${path}/`))) {
      await validateViewEntries(join(directory, name), allowed, path);
    } else if (!entry.isFile() || !allowed.includes(path)) {
      throw new Error(`Unexpected secret view entry: ${path}`);
    }
  }
}

/**
 * 从 canonical 卷恢复五个服务视图；仅补齐缺失文件，内容不一致即失败且不覆盖。
 * @param {string} source 已校验的 canonical secrets 目录。
 * @param {string} views 五个派生卷的父目录。
 * @param {{ setOwner?: typeof chown }} options 测试可注入所有者操作；生产默认真实 chown。
 * @returns {Promise<void>} 全部视图内容一致且权限为目录 0700、文件 0400 后完成。
 * @throws {Error} 内容冲突、额外文件、符号链接或权限/文件操作失败时终止。
 */
export async function createSecretViews(source, views, { setOwner = chown } = {}) {
  await validateSecrets(source);
  await ensureDirectory(views);
  for (const [name, { uid, gid, files }] of Object.entries(SECRET_VIEWS)) {
    const volume = join(views, name);
    const published = join(volume, 'secrets');
    const pending = join(volume, '.pending');
    await ensureDirectory(volume);
    for (const entry of await readdir(volume)) {
      if (!['secrets', '.pending'].includes(entry))
        throw new Error(`Unexpected secret volume entry: ${name}`);
    }
    await ensureDirectory(published);
    await ensureDirectory(pending);
    await validateViewEntries(published, files);
    const pendingNames = files.map((file) => file.replaceAll('/', '_'));
    await validateViewEntries(pending, pendingNames);
    // 只移除本脚本尚未发布的临时文件；已发布的文件永不删除或覆盖。
    for (const entry of await readdir(pending)) await unlink(join(pending, entry));
    for (const file of files) {
      const content = await readSecretFile(join(source, file));
      if (!content) throw new Error(`Missing canonical secret: ${file}`);
      const target = join(published, file);
      const existing = await readSecretFile(target);
      if (existing && !existing.equals(content))
        throw new Error(`Secret view differs from canonical: ${name}/${file}`);
      await ensureDirectory(dirname(target));
      if (!existing) {
        const temporary = join(pending, file.replaceAll('/', '_'));
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(content);
          await setOwner(temporary, uid, gid);
          await chmod(temporary, 0o400);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          // hard link 为原子、禁止覆盖的发布；崩溃只会留下可恢复的 .pending 文件。
          await link(temporary, target);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const concurrent = await readSecretFile(target);
          if (!concurrent?.equals(content))
            throw new Error(`Secret view differs from canonical: ${name}/${file}`);
        } finally {
          await unlink(temporary);
        }
      }
      await setOwner(target, uid, gid);
      await chmod(target, 0o400);
      await setOwner(dirname(target), uid, gid);
    }
    await setOwner(published, uid, gid);
    await setOwner(volume, uid, gid);
  }
}

/** 检查必需文件存在且非空；部分初始化失败时保持失败，不生成替代密钥。 */
export async function validateSecrets(directory) {
  for (const name of [
    'runtime.json',
    'ca.key',
    'postgres-password',
    'redis-password',
    'minio-password',
    's3-password',
    'ca.crt',
    'minio/public.crt',
    'minio/private.key',
    'redis/public.crt',
    'redis/private.key',
    'redis.conf',
  ]) {
    const content = await readSecretFile(join(directory, name));
    if (!content?.length) throw new Error(`Empty or missing secret file: ${name}`);
  }
  const configuration = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  for (const name of ['postgres', 'redis', 's3', 'jwt', 'encryption', 'webhook']) {
    if (!/^[a-f0-9]{64}$/.test(configuration[name] ?? '')) {
      throw new Error(`Invalid secret field: ${name}`);
    }
  }
  for (const name of ['postgres', 'redis', 's3']) {
    if ((await readFile(join(directory, `${name}-password`), 'utf8')) !== configuration[name]) {
      throw new Error(`Inconsistent secret field: ${name}`);
    }
  }
}

/** 执行证书工具，不将私钥或命令输出写入容器日志。 */
function openssl(args) {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

/** 首次初始化密钥卷；重复运行不修改已有身份、证书或加密密钥。 */
async function initialize() {
  await mkdir(root, { recursive: true });
  try {
    await lstat(destination);
    await restrictSecretTree(root);
    await validateSecrets(destination);
    await createSecretViews(destination, viewRoot);
    console.log('Docker secrets verified; existing identities preserved.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 若目录已存在而内部文件缺失，禁止重新生成，防止历史凭据无法解密。
    try {
      await lstat(destination);
      throw new Error('Secret volume is incomplete; restore its backup before starting.');
    } catch (directoryError) {
      if (directoryError.code !== 'ENOENT') throw directoryError;
    }
  }
  await assertEmptySecretViews(viewRoot);
  const staging = join(root, `initializing-${randomBytes(8).toString('hex')}`);
  await mkdir(staging, { mode: 0o700 });
  const configuration = Object.fromEntries(
    ['postgres', 'redis', 's3', 'jwt', 'encryption', 'webhook'].map((name) => [
      name,
      randomBytes(32).toString('hex'),
    ]),
  );
  const minioPassword = randomBytes(32).toString('hex');
  await writeFile(join(staging, 'runtime.json'), JSON.stringify(configuration), { mode: 0o400 });
  for (const [name, value] of Object.entries({
    'postgres-password': configuration.postgres,
    'redis-password': configuration.redis,
    'minio-password': minioPassword,
    's3-password': configuration.s3,
  })) {
    await writeFile(join(staging, name), value, { mode: 0o400 });
  }
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-sha256',
    '-days',
    '3650',
    '-subj',
    '/CN=Multimodal Canvas Local CA',
    '-keyout',
    join(staging, 'ca.key'),
    '-out',
    join(staging, 'ca.crt'),
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  await chmod(join(staging, 'ca.key'), 0o600);
  for (const name of ['redis', 'minio']) {
    const directory = join(staging, name);
    await mkdir(directory, { mode: 0o700 });
    const key = join(directory, 'private.key');
    const csr = join(directory, 'request.csr');
    const extensions = join(directory, 'extensions.cnf');
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${name}`,
      '-keyout',
      key,
      '-out',
      csr,
    ]);
    await writeFile(
      extensions,
      `subjectAltName=DNS:${name},DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n`,
    );
    openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      join(staging, 'ca.crt'),
      '-CAkey',
      join(staging, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(directory, 'public.crt'),
      '-days',
      '3650',
      '-sha256',
      '-extfile',
      extensions,
    ]);
    await chmod(key, 0o400);
    await chmod(join(directory, 'public.crt'), 0o400);
  }
  await writeFile(
    join(staging, 'redis.conf'),
    [
      'bind 0.0.0.0',
      'protected-mode yes',
      'port 0',
      'tls-port 6379',
      'tls-cert-file /run/multimodal/secrets/redis/public.crt',
      'tls-key-file /run/multimodal/secrets/redis/private.key',
      'tls-ca-cert-file /run/multimodal/secrets/ca.crt',
      'tls-auth-clients no',
      `requirepass ${configuration.redis}`,
      'dir /data',
      'appendonly yes',
      'appendfsync everysec',
    ].join('\n') + '\n',
    { mode: 0o400 },
  );
  await restrictSecretTree(staging);
  await validateSecrets(staging);
  await rename(staging, destination);
  await restrictSecretTree(root);
  await createSecretViews(destination, viewRoot);
  console.log('Docker secrets initialized in the dedicated volume.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initialize().catch(() => {
    console.error(
      'Secret initialization failed. Check the canonical volume, isolated views and openssl; existing secrets were not replaced.',
    );
    process.exitCode = 1;
  });
}

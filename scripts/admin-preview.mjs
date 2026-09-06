/** 在专用合成数据库启动后台验收预览，不访问现有业务数据库或 Provider。 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEmailEnvironment } from './email-config.mjs';

/** 预览入口只接受明确动作和配置路径，秘密值不放命令行。 */
const { values } = parseArgs({
  options: {
    action: { type: 'string', default: 'start' },
    'email-file': { type: 'string' },
    'api-port': { type: 'string', default: '3081' },
    'web-port': { type: 'string', default: '5187' },
  },
});
/** 稳定的仓库目录和 API 项目的本地依赖解析器。 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(resolve(root, 'apps/api/package.json'));
/** 仅用于隔离验收的已公开合成身份，不得用于正式部署。 */
const syntheticSecret = createHash('sha256')
  .update('multimodal-canvas-admin-review-synthetic')
  .digest('hex');
/** 仅内存保存用户提供的 SMTP 配置；没有文件时允许预览页面显示配置缺失。 */
const mail = values['email-file'] ? await readEmailEnvironment(values['email-file']) : {};
for (const key of ['api-port', 'web-port']) {
  if (!/^\d+$/.test(values[key]) || Number(values[key]) < 1024 || Number(values[key]) > 65535)
    throw new Error(`无效预览端口：${key}`);
}
/** 强制覆盖生产连接与收费执行配置，所有业务数据仅写专用数据库/目录。 */
const environment = {
  ...process.env,
  ...mail,
  NODE_ENV: 'development',
  DATABASE_URL:
    'postgresql://test_user:synthetic-test-password@127.0.0.1:19432/admin_review?schema=public',
  API_HOST: '127.0.0.1',
  API_PORT: values['api-port'],
  WEB_PORT: values['web-port'],
  API_AUTH_TOKEN: '',
  API_JWT_SECRET: syntheticSecret,
  AI_CREDENTIAL_ENCRYPTION_KEY: syntheticSecret,
  API_TRUST_PROXY_HOPS: '0',
  ADMIN_SETUP_TOKEN: '',
  CORS_ORIGIN: `http://127.0.0.1:${values['web-port']}`,
  APP_PUBLIC_URL: `http://127.0.0.1:${values['web-port']}`,
  VITE_API_BASE_URL: `http://127.0.0.1:${values['api-port']}`,
  RUN_SERVICE: 'memory',
  WORKER_PROVIDER: 'mock',
  NEW_API_API_KEY: '',
  NEW_API_BASE_URL: '',
  S3_BUCKET: '',
  API_RATE_LIMIT_REDIS_ENABLED: 'false',
  ASSET_STORAGE_ROOT: resolve(root, '.data/admin-review-assets'),
};

/** 通过项目内 Node CLI 执行命令；不拼接 shell，不输出环境值。 */
function run(args, cwd = root) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`预览子进程退出：${code}`)),
    );
  });
}

if (values.action === 'prepare') {
  // 旧迁移显式使用 public，必须隔离数据库而不能只改连接的 schema 参数。
  const { PrismaClient } = apiRequire('@prisma/client');
  const control = new PrismaClient({
    datasourceUrl:
      'postgresql://test_user:synthetic-test-password@127.0.0.1:19432/postgres?schema=public',
  });
  try {
    const databases =
      await control.$queryRaw`SELECT datname FROM pg_database WHERE datname = 'admin_review'`;
    if (databases.length === 0) await control.$executeRawUnsafe('CREATE DATABASE "admin_review"');
  } finally {
    await control.$disconnect();
  }
  await run([resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy']);
} else if (values.action === 'check-mail') {
  if (!values['email-file']) throw new Error('check-mail 需要 --email-file');
  const nodemailer = apiRequire('nodemailer');
  const transport = nodemailer.createTransport({
    host: mail.EMAIL_HOST,
    port: Number(mail.EMAIL_PORT),
    secure: mail.EMAIL_SECURE === 'true',
    requireTLS: mail.EMAIL_SECURE !== 'true',
    auth: { user: mail.EMAIL_USER, pass: mail.EMAIL_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    ...(environment.EMAIL_PROXY ? { proxy: environment.EMAIL_PROXY } : {}),
  });
  try {
    await transport.verify();
    console.log('SMTP 连接、TLS 与认证校验通过；未发送邮件。');
  } catch (error) {
    console.error(
      `SMTP 校验失败（${typeof error.code === 'string' ? error.code : 'unknown'}）；未发送邮件。`,
    );
    process.exitCode = 1;
  } finally {
    transport.close();
  }
} else if (values.action === 'web') {
  await run(
    [
      resolve(root, 'apps/web/node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      values['web-port'],
      '--strictPort',
    ],
    resolve(root, 'apps/web'),
  );
} else if (values.action === 'start') {
  console.log(
    `隔离后台预览 API：http://127.0.0.1:${values['api-port']}；仅使用 admin_review 合成数据。`,
  );
  await run([apiRequire.resolve('tsx/cli'), 'src/index.ts'], resolve(root, 'apps/api'));
} else throw new Error('未知预览动作');

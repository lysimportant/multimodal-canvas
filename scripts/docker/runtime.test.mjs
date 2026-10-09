/** R2 必选配置、可选外部数据库和持久密钥测试；仅使用临时合成文件，不连接设施。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runtimeEnvironment } from './runtime.mjs';

/** 为单个用例创建稳定合成密钥，结束时精确清理临时目录。 */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-r2-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = Object.fromEntries(
    ['postgres', 'redis', 'jwt', 'encryption', 'webhook'].map((name, index) => [
      name,
      String(index + 1).repeat(64),
    ]),
  );
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(secret));
  const environment = {
    S3_ENDPOINT: 'https://synthetic.r2.cloudflarestorage.com',
    S3_BUCKET: 'synthetic-bucket',
    S3_ACCESS_KEY: 'synthetic-access',
    S3_SECRET_KEY: 'synthetic-secret',
  };
  return { directory, secret, environment };
}

test('R2 环境固定 region 与校验和，默认数据库和 TLS Redis 使用稳定密钥', async (t) => {
  const options = await fixture(t);
  const before = await readFile(join(options.directory, 'runtime.json'), 'utf8');
  const runtime = await runtimeEnvironment(options);
  assert.equal(runtime.S3_REGION, 'auto');
  assert.equal(runtime.AWS_REQUEST_CHECKSUM_CALCULATION, 'WHEN_REQUIRED');
  assert.equal(runtime.AWS_RESPONSE_CHECKSUM_VALIDATION, 'WHEN_REQUIRED');
  assert.equal(runtime.API_JWT_SECRET, options.secret.jwt);
  assert.equal(runtime.AI_CREDENTIAL_ENCRYPTION_KEY, options.secret.encryption);
  assert.equal(new URL(runtime.DATABASE_URL).hostname, 'postgres');
  assert.equal(new URL(runtime.REDIS_URL).protocol, 'rediss:');
  assert.equal(runtime.WORKER_PROVIDER, 'newapi');
  assert.equal(runtime.RUN_SERVICE, 'bullmq');
  assert.equal(await readFile(join(options.directory, 'runtime.json'), 'utf8'), before);
});

test('外部数据库连接串保持完整，迁移和应用不重写 Neon TLS 查询参数', async (t) => {
  const options = await fixture(t);
  options.environment.DATABASE_URL =
    'postgresql://synthetic:synthetic@ep-synthetic.neon.tech/neondb?sslmode=require';
  assert.equal((await runtimeEnvironment(options)).DATABASE_URL, options.environment.DATABASE_URL);
  for (const value of [
    'postgresql://synthetic:synthetic@ep-synthetic-pooler.neon.tech/neondb?sslmode=require',
    'postgresql://synthetic:synthetic@ep-synthetic.neon.tech/neondb',
  ]) {
    await assert.rejects(
      runtimeEnvironment({
        ...options,
        environment: { ...options.environment, DATABASE_URL: value },
      }),
      { code: 'INVALID_RUNTIME_DATABASE_URL' },
    );
  }
});

test('缺少 R2 字段或使用其他 endpoint 时失败且不在错误中回显秘密', async (t) => {
  const options = await fixture(t);
  for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
    await assert.rejects(
      runtimeEnvironment({ ...options, environment: { ...options.environment, [name]: '' } }),
      { code: `INVALID_RUNTIME_${name}` },
    );
  }
  for (const endpoint of [
    'https://storage.example.com',
    'http://synthetic.r2.cloudflarestorage.com',
    'https://secret:password@synthetic.r2.cloudflarestorage.com',
    'https://synthetic.r2.cloudflarestorage.com/bucket',
    'https://synthetic.r2.cloudflarestorage.com?token=secret',
  ]) {
    await assert.rejects(
      runtimeEnvironment({
        ...options,
        environment: { ...options.environment, S3_ENDPOINT: endpoint },
      }),
      (error) =>
        error.code === 'INVALID_RUNTIME_S3_ENDPOINT' &&
        !error.message.includes('password') &&
        !error.message.includes('token='),
    );
  }
});

test('R2 jurisdiction 主机有效，region 和数据库错误明确失败', async (t) => {
  const options = await fixture(t);
  const runtime = await runtimeEnvironment({
    ...options,
    environment: {
      ...options.environment,
      S3_ENDPOINT: 'https://synthetic.eu.r2.cloudflarestorage.com',
    },
  });
  assert.equal(runtime.S3_REGION, 'auto');
  await assert.rejects(
    runtimeEnvironment({
      ...options,
      environment: { ...options.environment, S3_REGION: 'us-east-1' },
    }),
    { code: 'INVALID_RUNTIME_S3_REGION' },
  );
  await assert.rejects(
    runtimeEnvironment({
      ...options,
      environment: { ...options.environment, DATABASE_URL: 'https://secret:password@example.com' },
    }),
    { code: 'INVALID_RUNTIME_DATABASE_URL' },
  );
});

test('现有密钥格式损坏时拒绝启动且不生成新密钥', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.directory, 'runtime.json'), '{}');
  await assert.rejects(runtimeEnvironment(options), { code: 'INVALID_RUNTIME_postgres' });
  assert.equal(await readFile(join(options.directory, 'runtime.json'), 'utf8'), '{}');
});

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { migrateAssets, parseArguments, readConfiguration } from './migrate-assets.mjs';

function storageFixture(sourceObjects, targetObjects = {}) {
  const source = new Map(Object.entries(sourceObjects));
  const target = new Map(Object.entries(targetObjects));
  const sourceAdapter = {
    identifier: { id: 'source-test', kind: 'adapter' },
    async *list(prefix) {
      for (const [key, body] of source) {
        if (key.startsWith(prefix)) yield { key, sizeBytes: body.length };
      }
    },
    async head(key) {
      const body = source.get(key);
      return body === undefined ? undefined : { sizeBytes: body.length };
    },
    async get(key) {
      const body = source.get(key);
      return body === undefined
        ? undefined
        : { body: Readable.from(body), sizeBytes: body.length, contentType: 'text/plain' };
    },
  };
  const targetAdapter = {
    identifier: { id: 'target-test', kind: 'adapter' },
    async head(key) {
      const body = target.get(key);
      return body === undefined ? undefined : { sizeBytes: body.length };
    },
    async get(key) {
      const body = target.get(key);
      return body === undefined ? undefined : { body: Readable.from(body), sizeBytes: body.length };
    },
    async put(key, object) {
      const chunks = [];
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
      target.set(key, Buffer.concat(chunks));
    },
  };
  return { sourceAdapter, targetAdapter, target };
}

test('解析迁移参数和配置时拒绝危险默认值', async () => {
  assert.deepEqual(parseArguments(['--apply', '--prefix', 'assets/']), {
    apply: true,
    prefix: 'assets/',
    workDirectory: '.data/asset-migration',
    help: false,
  });
  assert.throws(() => parseArguments(['--unknown']), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseArguments(['--prefix', '']), /MISSING_ARGUMENT_VALUE/);

  const environment = {
    MIGRATION_SOURCE_S3_ENDPOINT: 'http://minio:9000',
    MIGRATION_SOURCE_S3_BUCKET: 'old-assets',
    MIGRATION_SOURCE_S3_ACCESS_KEY: 'source-key',
    MIGRATION_SOURCE_S3_SECRET_KEY: 'source-secret',
    S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    S3_BUCKET: 'new-assets',
    S3_ACCESS_KEY: 'target-key',
    S3_SECRET_KEY: 'target-secret',
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
  };
  const configuration = await readConfiguration({}, environment);
  assert.equal(configuration.source.bucket, 'old-assets');
  assert.equal(configuration.target.region, 'auto');
  await assert.rejects(
    readConfiguration({}, { ...environment, NODE_TLS_REJECT_UNAUTHORIZED: '0' }),
    /TLS_VERIFICATION_DISABLED/,
  );
});

test('检查模式不读取内容，执行模式复制并可安全重跑', async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'asset-migration-test-'));
  try {
    const fixture = storageFixture({ 'assets/hello.txt': Buffer.from('hello') });
    const dryRun = await migrateAssets({
      source: fixture.sourceAdapter,
      target: fixture.targetAdapter,
      workDirectory,
    });
    assert.deepEqual(dryRun.counts, {
      listed: 1,
      wouldCopy: 1,
      uncheckedExisting: 0,
      created: 0,
      verifiedExisting: 0,
      failed: 0,
    });
    assert.equal(fixture.target.size, 0);

    const applied = await migrateAssets({
      source: fixture.sourceAdapter,
      target: fixture.targetAdapter,
      workDirectory,
      apply: true,
    });
    assert.equal(applied.counts.created, 1);
    assert.equal(applied.failed, false);
    assert.deepEqual(fixture.target.get('assets/hello.txt'), Buffer.from('hello'));

    const rerun = await migrateAssets({
      source: fixture.sourceAdapter,
      target: fixture.targetAdapter,
      workDirectory,
      apply: true,
    });
    assert.equal(rerun.counts.verifiedExisting, 1);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

test('目标同名内容不同会失败且不覆盖目标', async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'asset-migration-conflict-'));
  try {
    const fixture = storageFixture(
      { 'assets/conflict.txt': Buffer.from('source') },
      { 'assets/conflict.txt': Buffer.from('target') },
    );
    const result = await migrateAssets({
      source: fixture.sourceAdapter,
      target: fixture.targetAdapter,
      workDirectory,
      apply: true,
    });
    assert.equal(result.failed, true);
    assert.equal(result.counts.failed, 1);
    assert.deepEqual(fixture.target.get('assets/conflict.txt'), Buffer.from('target'));

    const report = await readFile(result.reportPath, 'utf8');
    assert.match(report, /TARGET_CONTENT_CONFLICT/);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

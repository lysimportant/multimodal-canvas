/**
 * 专用 MinIO 权限验收 fixture，仅由 verify-s3-permissions.ps1 在 Docker 所有权校验后调用。
 * 从标准输入接收本轮配置；标准输出只返回无凭据 JSON，失败退出非零。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:http';
import { createRequire } from 'node:module';

/** 复用 API 已锁定的 AWS SDK，不依赖全局模块或额外安装。 */
const requireApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
/** S3 官方命令用于保留原始服务错误码及 HTTP 状态，不依赖 mc 的错误文案。 */
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} = requireApi('@aws-sdk/client-s3');

/** 已通过检查、客户端和脱敏错误的本轮状态。 */
const checks = [];
/** 所有本轮客户端，结束时统一销毁连接资源。 */
const clients = [];
/** 最终失败诊断；仅保留断言内容或服务错误码，不保留原始服务响应。 */
let failure = null;
/** 精确记录实际 Node 和已安装 SDK 版本。 */
const versions = {
  node: process.version,
  awsSdk: requireApi('@aws-sdk/client-s3/package.json').version,
};

/**
 * 构造固定本机 endpoint 的客户端；使用显式测试凭据，不查找共享配置或实例角色。
 * @param {string} accessKeyId 本轮测试身份。
 * @param {string} secretAccessKey 合成 secret，仅驻留内存。
 * @returns {import('@aws-sdk/client-s3').S3Client} 最多尝试一次、请求限时十秒的客户端。
 */
function createClient(accessKeyId, secretAccessKey) {
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:19900',
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey },
    /** 权限反例使用独立连接，避免前一个拒绝响应的连接状态干扰后续断言。 */
    requestHandler: {
      connectionTimeout: 3000,
      requestTimeout: 10000,
      httpAgent: new Agent({ keepAlive: false }),
    },
  });
  clients.push(client);
  return client;
}

/**
 * 记录成功检查，不输出响应体、认证头、secret 或服务原始错误信息。
 * @param {string} name 检查标识。
 * @param {string} evidence 已验证的错误码及状态或 success。
 * @returns {void} 仅追加本轮检查列表。
 */
function record(name, evidence = 'success') {
  checks.push({ name, evidence });
}

/**
 * 读取并释放对象流，返回完整 UTF-8 内容用于精确对比。
 * @param {import('@aws-sdk/client-s3').S3Client} client 本轮显式身份的客户端。
 * @param {{ Bucket: string, Key: string }} object 本轮精确对象路径。
 * @returns {Promise<string>} 对象内容；S3 或传输错误原样交由上层断言处理。
 */
async function readObject(client, object) {
  const response = await client.send(new GetObjectCommand(object));
  return response.Body.transformToString();
}

/**
 * 必须同时匹配服务错误码和 HTTP 状态；网络错误、意外成功均抛出断言错误。
 * @param {string} label 检查名称。
 * @param {() => Promise<unknown>} action 一次 S3 操作。
 * @param {string} code 预期服务错误码。
 * @param {number} status 预期 HTTP 状态。
 */
async function expectError(label, action, code, status = 403) {
  await assert.rejects(
    action,
    (error) => {
      assert.equal(error.name, code, `${label}: unexpected S3 error code`);
      assert.equal(error.$metadata?.httpStatusCode, status, `${label}: unexpected HTTP status`);
      return true;
    },
    `${label}: operation unexpectedly succeeded`,
  );
  record(label, `HTTP ${status} / ${code}`);
}

try {
  const configuration = JSON.parse(readFileSync(0, 'utf8'));
  assert.equal(configuration.project, 'mc-acceptance-test-p0p1');
  assert.equal(configuration.endpoint, 'http://127.0.0.1:19900/');
  assert.match(configuration.runId, /^[a-f0-9]{32}$/);
  assert.match(configuration.userSecret, /^synthetic-[a-f0-9]{32}$/);
  assert.ok(['Preflight', 'Test', 'Inspect', 'Cleanup'].includes(configuration.phase));
  const runId = configuration.runId;
  const bucket = `mc-s3-acl-${runId}`;
  const otherBucket = `mc-s3-other-${runId}`;
  const allowed = { Bucket: bucket, Key: 'allowed/read-write.txt' };
  const seeds = [
    { Bucket: bucket, Key: 'forbidden/seed.txt' },
    { Bucket: otherBucket, Key: 'allowed/seed.txt' },
  ];
  const rejectedObjects = [
    { Bucket: bucket, Key: 'forbidden/rejected-write.txt' },
    { Bucket: bucket, Key: 'allowed-sibling/rejected-write.txt' },
    { Bucket: otherBucket, Key: 'allowed/rejected-write.txt' },
    { Bucket: bucket, Key: 'allowed/wrong-secret-write.txt' },
    { Bucket: bucket, Key: 'allowed/unknown-key-write.txt' },
    { Bucket: bucket, Key: 'allowed/anonymous-write.txt' },
  ];
  const payload = `synthetic-s3-permissions-${runId}`;
  const admin = createClient('synthetic-test-user', 'synthetic-test-password');
  const limited = createClient(`s3-user-${runId}`, configuration.userSecret);

  if (configuration.phase === 'Preflight') {
    record('local-sdk-dependency-check');
  } else if (configuration.phase === 'Test') {
    for (const seed of seeds) {
      await admin.send(new PutObjectCommand({ ...seed, Body: payload }));
    }
    await limited.send(new PutObjectCommand({ ...allowed, Body: payload }));
    record('allowed-prefix-put');
    assert.equal(await readObject(limited, allowed), payload);
    record('allowed-prefix-get-content-match');
    const listing = await limited.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'allowed/' }),
    );
    assert.deepEqual(
      listing.Contents?.map((object) => object.Key),
      [allowed.Key],
    );
    record('allowed-prefix-list');
    await expectError('cross-prefix-get', () => readObject(limited, seeds[0]), 'AccessDenied');
    for (const [index, label] of [
      'cross-prefix-put',
      'prefix-boundary-put',
      'cross-bucket-put',
    ].entries()) {
      await expectError(
        label,
        () => limited.send(new PutObjectCommand({ ...rejectedObjects[index], Body: payload })),
        'AccessDenied',
      );
    }
    for (const [label, prefix] of [
      ['cross-prefix-list', 'forbidden/'],
      ['bucket-root-list', ''],
    ]) {
      await expectError(
        label,
        () => limited.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })),
        'AccessDenied',
      );
    }
    await expectError('cross-bucket-get', () => readObject(limited, seeds[1]), 'AccessDenied');
    await expectError(
      'delete-not-granted',
      () => limited.send(new DeleteObjectCommand(allowed)),
      'AccessDenied',
    );
    const wrong = createClient(`s3-user-${runId}`, `synthetic-wrong-${runId}`);
    const unknown = createClient(`unknown-${runId}`, `synthetic-wrong-${runId}`);
    for (const [client, label, code, object] of [
      [wrong, 'wrong-secret', 'SignatureDoesNotMatch', rejectedObjects[3]],
      [unknown, 'unknown-key', 'InvalidAccessKeyId', rejectedObjects[4]],
    ]) {
      await expectError(`${label}-get`, () => readObject(client, allowed), code);
      await expectError(
        `${label}-put`,
        () => client.send(new PutObjectCommand({ ...object, Body: payload })),
        code,
      );
    }
  } else if (configuration.phase === 'Inspect') {
    for (const object of rejectedObjects) {
      await expectError(
        `no-denied-object:${object.Bucket}/${object.Key}`,
        () => readObject(admin, object),
        'NoSuchKey',
        404,
      );
    }
    for (const object of [allowed, ...seeds]) {
      assert.equal(await readObject(admin, object), payload);
    }
    record('seed-and-allowed-objects-unchanged');
  } else {
    assert.ok(Array.isArray(configuration.createdBuckets));
    assert.ok(
      configuration.createdBuckets.every((created) => [bucket, otherBucket].includes(created)),
    );
    const cleanupErrors = [];
    for (const created of configuration.createdBuckets) {
      for (const object of [allowed, ...seeds, ...rejectedObjects].filter(
        (item) => item.Bucket === created,
      )) {
        try {
          await admin.send(new DeleteObjectCommand(object));
        } catch (error) {
          cleanupErrors.push(`object ${object.Bucket}/${object.Key}: ${error.name}`);
        }
      }
      try {
        await admin.send(new DeleteBucketCommand({ Bucket: created }));
        await expectError(
          `cleaned-bucket:${created}`,
          () => admin.send(new ListObjectsV2Command({ Bucket: created })),
          'NoSuchBucket',
          404,
        );
      } catch (error) {
        cleanupErrors.push(`bucket ${created}: ${error.name}`);
      }
    }
    assert.equal(cleanupErrors.length, 0, cleanupErrors.join('; '));
  }
} catch (error) {
  failure =
    error.code === 'ERR_ASSERTION'
      ? error.message
      : `${error.name}: HTTP ${error.$metadata?.httpStatusCode ?? 'unavailable'}`;
  process.exitCode = 1;
} finally {
  for (const client of clients) client.destroy();
  process.stdout.write(`${JSON.stringify({ checks, versions, failure })}\n`);
}

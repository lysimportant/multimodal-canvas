#!/usr/bin/env node
/**
 * 通过源 S3 API 将旧素材复制到 R2；不修改数据库、源对象或已存在的目标内容。
 * 默认只列举和 HEAD，执行模式逐项落盘并校验 SHA-256，报告不能代替重跑时的内容验证。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** 单次 PutObject 的最大字节数；不自动改用多段上传。 */
const MAX_OBJECT_BYTES = 5 * 1024 ** 3;

/** 只携带阶段和固定错误码，防止 SDK 错误中的端点、签名或凭据进入日志。 */
class MigrationError extends Error {
  constructor(stage, code) {
    super(`${stage}: ${code}`);
    this.name = 'MigrationError';
    this.stage = stage;
    this.code = code;
  }
}

/** 将外部错误限制为可公开的固定错误码；不保存原始 message 或 cause。 */
function safeError(error, stage) {
  if (error instanceof MigrationError) return error;
  const names = [error?.name, error?.code, error?.Code];
  const status = error?.$metadata?.httpStatusCode;
  let code = 'STORAGE_ERROR';
  if (names.includes('NoSuchBucket')) code = 'STORAGE_BUCKET_MISSING';
  else if (status === 401 || status === 403 || names.includes('AccessDenied'))
    code = 'STORAGE_ACCESS_DENIED';
  else if (status === 412 || names.includes('PreconditionFailed'))
    code = 'STORAGE_PRECONDITION_FAILED';
  else if (names.some((name) => ['TimeoutError', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(name)))
    code = 'STORAGE_TIMEOUT';
  else if (
    names.some((name) => ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'].includes(name))
  )
    code = 'STORAGE_CONNECTION_FAILED';
  else if (names.includes('ENOSPC')) code = 'LOCAL_DISK_FULL';
  else if (names.some((name) => ['EACCES', 'EPERM'].includes(name))) code = 'LOCAL_ACCESS_DENIED';
  else if (names.includes('EEXIST')) code = 'LOCAL_FILE_EXISTS';
  else if (names.includes('ENOENT')) code = 'LOCAL_PATH_MISSING';
  else if (names.some((name) => ['EIO', 'EROFS', 'EMFILE', 'ENFILE'].includes(name)))
    code = 'LOCAL_IO_ERROR';
  return new MigrationError(stage, code);
}

/** 在保留已知安全错误的同时给适配器操作标注失败阶段。 */
async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw safeError(error, stage);
  }
}

/** 空前缀会扩大到整个 bucket，因此所有入口都显式拒绝。 */
function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.trim())
    throw new MigrationError('arguments', 'EMPTY_PREFIX');
  return prefix;
}

/**
 * 解析 CLI 参数，保留对象前缀原文；未知、重复和缺值参数均失败。
 * @param {string[]} argv 不含 Node 和脚本路径的参数列表。
 * @returns {{apply:boolean,prefix:string,workDirectory:string,help:boolean,sourceEnvFile?:string,targetEnvFile?:string,reportPath?:string}} 执行选项。
 * @throws {MigrationError} 参数不合法时返回 arguments 阶段的安全错误。
 */
export function parseArguments(argv) {
  const options = {
    apply: false,
    prefix: 'assets/',
    workDirectory: '.data/asset-migration',
    help: false,
  };
  const valueArguments = new Map([
    ['--prefix', 'prefix'],
    ['--source-env-file', 'sourceEnvFile'],
    ['--target-env-file', 'targetEnvFile'],
    ['--work-dir', 'workDirectory'],
    ['--report', 'reportPath'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--apply' && argument !== '--help' && !valueArguments.has(argument))
      throw new MigrationError('arguments', 'UNKNOWN_ARGUMENT');
    if (seen.has(argument)) throw new MigrationError('arguments', 'DUPLICATE_ARGUMENT');
    seen.add(argument);
    if (argument === '--apply') options.apply = true;
    else if (argument === '--help') options.help = true;
    else {
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--'))
        throw new MigrationError('arguments', 'MISSING_ARGUMENT_VALUE');
      options[valueArguments.get(argument)] = value;
      index += 1;
    }
  }
  validatePrefix(options.prefix);
  return options;
}

/** 按角色读取私有环境文件；文件只覆盖对应角色的进程配置，不执行其中内容。 */
async function readEnvironment(path, environment, role) {
  if (!path) return environment;
  const contents = await atStage(`configuration.${role}.file`, () => readFile(path, 'utf8'));
  try {
    return { ...environment, ...parseEnv(contents) };
  } catch {
    throw new MigrationError(`configuration.${role}.file`, 'INVALID_ENV_FILE');
  }
}

/** 验证 S3 endpoint 并生成仅用于区分配置的非秘密标识，不输出连接原值。 */
function storageConfiguration(environment, role) {
  const prefix = role === 'source' ? 'MIGRATION_SOURCE_S3_' : 'S3_';
  const stage = `configuration.${role}`;
  const value = (suffix) => environment[`${prefix}${suffix}`];
  for (const suffix of ['ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY']) {
    if (typeof value(suffix) !== 'string' || !value(suffix).trim())
      throw new MigrationError(stage, 'MISSING_CONFIGURATION');
  }
  let endpoint;
  try {
    endpoint = new URL(value('ENDPOINT').trim());
  } catch {
    throw new MigrationError(stage, 'INVALID_ENDPOINT');
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.href.includes('?') ||
    endpoint.href.includes('#') ||
    endpoint.pathname !== '/'
  )
    throw new MigrationError(stage, 'INVALID_ENDPOINT');
  if (
    role === 'target' &&
    (endpoint.protocol !== 'https:' ||
      !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') ||
      endpoint.port)
  )
    throw new MigrationError(stage, 'INVALID_R2_ENDPOINT');
  const bucket = value('BUCKET').trim();
  const canonicalEndpoint = endpoint.origin;
  return {
    endpoint: canonicalEndpoint,
    bucket,
    accessKey: value('ACCESS_KEY'),
    secretKey: value('SECRET_KEY'),
    region: value('REGION')?.trim() || (role === 'target' ? 'auto' : 'us-east-1'),
    identifier: {
      id: createHash('sha256').update(`${canonicalEndpoint}\n${bucket}`).digest('hex').slice(0, 16),
      kind: role === 'target' ? 'cloudflare-r2' : 's3-compatible',
    },
  };
}

/**
 * 读取源 MIGRATION_SOURCE_S3_* 与目标 S3_*，私有文件的对应字段优先。
 * @param {object} options CLI 选项，可含 sourceEnvFile 和 targetEnvFile。
 * @param {Record<string,string|undefined>} environment 可注入的进程环境，不被修改。
 * @returns {Promise<{source:object,target:object}>} 两端的 endpoint、bucket、凭据、region 和非秘密 identifier。
 * @throws {MigrationError} 配置缺失、endpoint 不合规、两端相同或 TLS 校验被关闭。
 */
export async function readConfiguration(options, environment = process.env) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new MigrationError('configuration', 'TLS_VERIFICATION_DISABLED');
  const sourceEnvironment = await readEnvironment(options.sourceEnvFile, environment, 'source');
  const targetEnvironment = await readEnvironment(options.targetEnvFile, environment, 'target');
  const source = storageConfiguration(sourceEnvironment, 'source');
  const target = storageConfiguration(targetEnvironment, 'target');
  if (source.endpoint === target.endpoint && source.bucket === target.bucket)
    throw new MigrationError('configuration', 'SAME_STORAGE');
  return { source, target };
}

/** 只将已知对象缺失视为 undefined；NoSuchBucket、权限和未知 404 继续失败。 */
function isMissingObject(error) {
  const names = [error?.name, error?.code, error?.Code];
  const status = error?.$metadata?.httpStatusCode;
  if (names.includes('NoSuchBucket') || (status !== undefined && status !== 404)) return false;
  return names.includes('NoSuchKey') || (names.includes('NotFound') && status === 404);
}

/**
 * 创建 S3 适配器；使用单次请求、TLS 默认校验和超时，上传永不覆盖已有键。
 * @param {object} config endpoint、bucket、accessKey、secretKey、region 和 identifier。
 * @param {object} sdk @aws-sdk/client-s3 模块或相同接口的隔离测试替身。
 * @returns {object} list、head、get、put、close 和非秘密 identifier；get 返回 Node 可读流。
 * @throws {Error} 非对象缺失的 SDK 错误由迁移调用方脱敏并记录。
 */
export function createS3Storage(config, sdk) {
  const client = new sdk.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: 10_000,
      socketTimeout: 120_000,
      requestTimeout: 900_000,
      throwOnRequestTimeout: true,
    },
  });
  return {
    identifier: config.identifier,
    async *list(prefix) {
      validatePrefix(prefix);
      let continuationToken;
      const seenTokens = new Set();
      do {
        const page = await client.send(
          new sdk.ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        for (const object of page.Contents ?? []) yield { key: object.Key, sizeBytes: object.Size };
        if (!page.IsTruncated) break;
        continuationToken = page.NextContinuationToken;
        if (!continuationToken || seenTokens.has(continuationToken))
          throw new MigrationError('source.list', 'INVALID_PAGINATION');
        seenTokens.add(continuationToken);
      } while (true);
    },
    async head(key) {
      try {
        const object = await client.send(
          new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return { sizeBytes: object.ContentLength };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        throw error;
      }
    },
    async get(key) {
      try {
        const object = await client.send(
          new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return {
          body: object.Body,
          sizeBytes: object.ContentLength,
          contentType: object.ContentType,
          metadata: object.Metadata,
          cacheControl: object.CacheControl,
          contentDisposition: object.ContentDisposition,
          contentEncoding: object.ContentEncoding,
        };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        throw error;
      }
    },
    async put(key, object) {
      validateSize(object.sizeBytes, 'target.put');
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          IfNoneMatch: '*',
          Body: object.body,
          ContentLength: object.sizeBytes,
          ...(object.contentType !== undefined ? { ContentType: object.contentType } : {}),
          ...(object.metadata !== undefined ? { Metadata: object.metadata } : {}),
          ...(object.cacheControl !== undefined ? { CacheControl: object.cacheControl } : {}),
          ...(object.contentDisposition !== undefined
            ? { ContentDisposition: object.contentDisposition }
            : {}),
          ...(object.contentEncoding !== undefined
            ? { ContentEncoding: object.contentEncoding }
            : {}),
        }),
      );
    },
    close() {
      client.destroy();
    },
  };
}

/** 校验字节长度；拒绝不可靠的数值和单次上传范围之外的对象。 */
function validateSize(sizeBytes, stage) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw new MigrationError(stage, 'INVALID_OBJECT_SIZE');
  if (sizeBytes > MAX_OBJECT_BYTES) throw new MigrationError(stage, 'OBJECT_TOO_LARGE');
}

/** 检查 GET 的声明长度和流接口；错误时释放连接。 */
function validateDownload(object, sizeBytes, stage, missingCode, lengthCode) {
  if (!object) throw new MigrationError(stage, missingCode);
  if (object.sizeBytes !== sizeBytes) {
    object.body?.destroy?.();
    throw new MigrationError(stage, lengthCode);
  }
  if (!object.body || typeof object.body[Symbol.asyncIterator] !== 'function') {
    object.body?.destroy?.();
    throw new MigrationError(stage, 'INVALID_OBJECT_BODY');
  }
}

/** 源素材逐块写入私有临时文件，同时计算长度和哈希，避免整段媒体驻留内存。 */
async function downloadSource(object, handle, sizeBytes) {
  const hash = createHash('sha256');
  let received = 0;
  const checker = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > sizeBytes) {
        callback(new MigrationError('source.download', 'SOURCE_LENGTH_MISMATCH'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await atStage('source.download', () =>
    pipeline(object.body, checker, handle.createWriteStream()),
  );
  if (received !== sizeBytes) throw new MigrationError('source.download', 'SOURCE_LENGTH_MISMATCH');
  return hash.digest('hex');
}

/** 读取目标实际内容逐块校验；不以 HEAD、ETag 或旧报告代替哈希。 */
async function targetHash(target, key, sizeBytes) {
  const object = await atStage('target.get', () => target.get(key));
  validateDownload(
    object,
    sizeBytes,
    'target.verify',
    'TARGET_OBJECT_MISSING',
    'TARGET_LENGTH_CONFLICT',
  );
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of object.body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      received += bytes.length;
      if (received > sizeBytes) throw new MigrationError('target.verify', 'TARGET_LENGTH_CONFLICT');
      hash.update(bytes);
    }
  } catch (error) {
    throw safeError(error, 'target.verify');
  } finally {
    object.body.destroy?.();
  }
  if (received !== sizeBytes) throw new MigrationError('target.verify', 'TARGET_LENGTH_CONFLICT');
  return hash.digest('hex');
}

/** 每个对象独立失败和清理；临时路径不使用对象键，且只删除本次成功创建的文件。 */
async function migrateObject({ source, target, object, prefix, apply, workDirectory }) {
  let record = {
    type: 'object',
    key: typeof object?.key === 'string' ? object.key : null,
    sizeBytes: object?.sizeBytes,
  };
  let temporaryPath;
  let temporaryCreated = false;
  let handle;
  try {
    if (typeof object?.key !== 'string' || !object.key.startsWith(prefix))
      throw new MigrationError('source.list', 'INVALID_OBJECT_KEY');
    validateSize(object.sizeBytes, 'source.list');
    const sourceHead = await atStage('source.head', () => source.head(object.key));
    if (!sourceHead) throw new MigrationError('source.head', 'SOURCE_OBJECT_MISSING');
    if (sourceHead.sizeBytes !== object.sizeBytes)
      throw new MigrationError('source.head', 'SOURCE_LENGTH_MISMATCH');
    const existing = await atStage('target.head', () => target.head(object.key));
    if (existing && existing.sizeBytes !== object.sizeBytes)
      throw new MigrationError('target.head', 'TARGET_LENGTH_CONFLICT');
    if (!apply) {
      record.status = existing ? 'unchecked_existing' : 'would_copy';
      return record;
    }

    temporaryPath = join(workDirectory, `object-${randomUUID()}.tmp`);
    handle = await atStage('local.temp.open', () => open(temporaryPath, 'wx', 0o600));
    temporaryCreated = true;
    const downloaded = await atStage('source.get', () => source.get(object.key));
    validateDownload(
      downloaded,
      object.sizeBytes,
      'source.download',
      'SOURCE_OBJECT_MISSING',
      'SOURCE_LENGTH_MISMATCH',
    );
    record.sha256 = await downloadSource(downloaded, handle, object.sizeBytes);
    await atStage('local.temp.close', () => handle.close());
    handle = undefined;

    let putFailed = false;
    if (!existing) {
      const body = createReadStream(temporaryPath);
      try {
        await target.put(object.key, {
          body,
          sizeBytes: object.sizeBytes,
          contentType: downloaded.contentType,
          metadata: downloaded.metadata,
          cacheControl: downloaded.cacheControl,
          contentDisposition: downloaded.contentDisposition,
          contentEncoding: downloaded.contentEncoding,
        });
      } catch (error) {
        // 412 和连接失败都可能已经留下对象；本次只读取核对，不再次 PUT。
        putFailed = true;
        const failure = safeError(error, 'target.put');
        record.putError = { stage: failure.stage, code: failure.code };
      } finally {
        // Windows 删除临时文件前需等待读流关闭；主动 destroy 的提前关闭不是上传结果。
        const closed = finished(body, { cleanup: true }).catch(() => undefined);
        body.destroy();
        await closed;
      }
    }
    const actualHash = await targetHash(target, object.key, object.sizeBytes);
    if (actualHash !== record.sha256) {
      record.targetSha256 = actualHash;
      throw new MigrationError('target.verify', 'TARGET_CONTENT_CONFLICT');
    }
    record.status = existing || putFailed ? 'verified_existing' : 'created';
  } catch (error) {
    const failure = safeError(error, 'migration.object');
    record = { ...record, status: 'failed', stage: failure.stage, code: failure.code };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        const failure = safeError(error, 'local.temp.close');
        record = { ...record, status: 'failed', stage: failure.stage, code: failure.code };
      }
    }
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        const failure = safeError(error, 'local.temp.cleanup');
        record = {
          ...record,
          ...(record.status !== 'failed' ? { completedStatus: record.status } : {}),
          status: 'failed',
          stage: failure.stage,
          code: failure.code,
        };
      }
    }
  }
  return record;
}

/** 报告只接受工厂生成的哈希标识；替身或外部适配器的自由文本不进入报告。 */
function reportIdentifier(storage, role) {
  const identifier = storage.identifier;
  if (
    /^[a-f0-9]{16}$/.test(identifier?.id ?? '') &&
    ['s3-compatible', 'cloudflare-r2'].includes(identifier?.kind)
  )
    return { id: identifier.id, kind: identifier.kind };
  return { id: role, kind: 'adapter' };
}

/**
 * 顺序迁移前缀内对象；检查模式只使用 list/head，执行模式将源内容落盘再比较目标哈希。
 * @param {object} options source/target 提供 list、head、get、put；prefix 默认 assets/，apply 默认 false。
 * @param {string} [options.workDirectory] 私有临时目录，默认 .data/asset-migration。
 * @param {string} [options.reportPath] 新 JSONL 路径，使用 wx 和 0600，既有报告不会覆盖。
 * @param {Function} [options.onProgress] 每条对象记录持久化后收到记录及累计 counts，不应输出连接或凭据。
 * @returns {Promise<{mode:string,prefix:string,reportPath:string,counts:object,failed:boolean}>} 汇总；对象或列举失败会设置 failed。
 * @throws {MigrationError} 本地目录/报告不可写或输入无效时失败，已完成对象仍可安全重跑。
 */
export async function migrateAssets({
  source,
  target,
  prefix = 'assets/',
  apply = false,
  workDirectory = '.data/asset-migration',
  reportPath,
  onProgress,
}) {
  validatePrefix(prefix);
  if (typeof apply !== 'boolean') throw new MigrationError('arguments', 'INVALID_APPLY');
  for (const [role, storage] of [
    ['source', source],
    ['target', target],
  ]) {
    const methods = role === 'source' ? ['list', 'head', 'get'] : ['head', 'get', 'put'];
    if (!storage || methods.some((method) => typeof storage[method] !== 'function'))
      throw new MigrationError('arguments', 'INVALID_STORAGE_ADAPTER');
  }
  const directory = resolve(workDirectory);
  await atStage('local.directory', () => mkdir(directory, { recursive: true, mode: 0o700 }));
  const path = resolve(
    reportPath ??
      join(
        directory,
        `migration-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`,
      ),
  );
  const report = await atStage('report.open', () => open(path, 'wx', 0o600));
  const mode = apply ? 'apply' : 'dry-run';
  const counts = {
    listed: 0,
    wouldCopy: 0,
    uncheckedExisting: 0,
    created: 0,
    verifiedExisting: 0,
    failed: 0,
  };
  const countStatus = {
    would_copy: 'wouldCopy',
    unchecked_existing: 'uncheckedExisting',
    created: 'created',
    verified_existing: 'verifiedExisting',
    failed: 'failed',
  };
  const writeRecord = async (record) => {
    await atStage('report.write', async () => {
      await report.writeFile(`${JSON.stringify(record)}\n`);
      await report.sync();
    });
  };
  try {
    await writeRecord({
      type: 'header',
      schemaVersion: 1,
      mode,
      prefix,
      source: reportIdentifier(source, 'source'),
      target: reportIdentifier(target, 'target'),
      startedAt: new Date().toISOString(),
    });
    let progress = onProgress;
    try {
      for await (const object of source.list(prefix)) {
        counts.listed += 1;
        const record = await migrateObject({
          source,
          target,
          object,
          prefix,
          apply,
          workDirectory: directory,
        });
        counts[countStatus[record.status]] += 1;
        await writeRecord(record);
        if (progress) {
          try {
            await progress(record, { ...counts });
          } catch {
            counts.failed += 1;
            await writeRecord({
              type: 'failure',
              stage: 'progress',
              code: 'PROGRESS_CALLBACK_FAILED',
            });
            progress = undefined;
          }
        }
      }
    } catch (error) {
      const failure = safeError(error, 'source.list');
      if (failure.stage.startsWith('report.')) throw failure;
      counts.failed += 1;
      await writeRecord({ type: 'failure', stage: failure.stage, code: failure.code });
    }
    const result = { mode, prefix, reportPath: path, counts, failed: counts.failed > 0 };
    await writeRecord({
      type: 'summary',
      mode,
      prefix,
      counts: { ...counts },
      failed: result.failed,
      finishedAt: new Date().toISOString(),
    });
    return result;
  } finally {
    await atStage('report.close', () => report.close());
  }
}

/** SDK 只在 CLI 执行时加载；支持仓库 API 依赖与 Docker /app/node_modules。 */
function loadSdk() {
  for (const require of [
    createRequire(import.meta.url),
    createRequire(new URL('../../apps/api/package.json', import.meta.url)),
  ]) {
    try {
      return require('@aws-sdk/client-s3');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND')
        throw new MigrationError('runtime', 'SDK_LOAD_FAILED');
    }
  }
  throw new MigrationError('runtime', 'SDK_DEPENDENCY_MISSING');
}

/** CLI 帮助不读取私有配置、加载 SDK 或请求网络。 */
function printHelp() {
  console.log(`旧 S3/MinIO 素材复制到 Cloudflare R2（默认只检查）

用法：node scripts/docker/migrate-assets.mjs [选项]
  --apply                  实际复制，保留源对象且拒绝覆盖目标冲突
  --prefix <前缀>          默认 assets/；必须非空，保留原始对象键
  --source-env-file <文件>  读取 MIGRATION_SOURCE_S3_* 私有配置
  --target-env-file <文件>  读取 S3_* 私有 R2 配置
  --work-dir <目录>        默认 .data/asset-migration，临时文件逐项清理
  --report <新文件>        JSONL 报告；存在则失败，默认自动生成唯一文件
  --help                   显示帮助

源配置：MIGRATION_SOURCE_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/REGION
目标配置：S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/REGION
目标仅接受 HTTPS R2 endpoint；源通过 S3 API 读取，不读取 MinIO 内部卷格式。
检查模式不读取素材内容，等长目标仅标记 unchecked_existing。
执行模式限制单对象 5 GiB，并用实际 GET 内容校验 SHA-256。
任何对象失败都会继续其余对象并最终返回非零退出码。`);
}

/** 执行 CLI 并只打印安全汇总；所有对象键与哈希保存在本地报告。 */
async function main() {
  let source;
  let target;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return 0;
    }
    const configuration = await readConfiguration(options);
    const sdk = loadSdk();
    source = createS3Storage(configuration.source, sdk);
    target = createS3Storage(configuration.target, sdk);
    const result = await migrateAssets({ ...options, source, target });
    console.log(
      `模式：${result.mode}；列举：${result.counts.listed}；待复制：${result.counts.wouldCopy}；未校验已有：${result.counts.uncheckedExisting}；新建：${result.counts.created}；已有且验证：${result.counts.verifiedExisting}；失败：${result.counts.failed}`,
    );
    console.log(`本地报告：${result.reportPath}`);
    return result.failed ? 1 : 0;
  } catch (error) {
    const failure = safeError(error, 'runtime');
    console.error(`${failure.stage}: ${failure.code}`);
    return 1;
  } finally {
    source?.close();
    target?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await main();

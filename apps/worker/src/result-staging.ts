import { createHash } from 'node:crypto';
import type { IRedisClient } from 'bullmq';
import type { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import { providerJobSchema, runResultSchema } from '@multimodal-canvas/domain';
import type { ProviderExecution } from './index';
import { normalizeProviderOutput, type ProviderOutput } from './result-output';

/** 首次写入后的保留秒数；重复保存和读取都不延长有效期。 */
export const RESULT_STAGING_TTL_SECONDS = 24 * 60 * 60;
/** 默认允许的原始内容字节数，base64 与密文膨胀另计。 */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Redis 单个字符串的协议上限，包括密文的 base64url 编码。 */
const REDIS_MAX_VALUE_BYTES = 512 * 1024 * 1024;
/** 为身份、结果与供应商元数据预留的 JSON 字节数。 */
const ENVELOPE_OVERHEAD_BYTES = 1024 * 1024;
/** 与凭据密文区分用途，避免同一密钥环下的跨用途重放。 */
const PURPOSE = 'worker-result-staging';
/** 当前加密明文结构版本；未知版本不尝试兼容读取。 */
const VERSION = 1;
/** 成功响应允许返回未补齐时间和进度的供应商任务。 */
const executionProviderJobSchema = providerJobSchema.partial().required({ provider: true });

/** 完整的冻结请求身份；缺省 userId 与任何已登录租户严格隔离。 */
export type ResultStagingIdentity = {
  runId: string;
  userId?: string;
  projectId: string;
  nodeId: string;
  snapshotFingerprint: string;
  requestProviderJobId: string;
};

/** 只承载受控加密结果；返回的原始输出只能交给归档器，不能进入普通任务 payload。 */
export interface ResultStagingStore {
  /** 加密保存首次成功值；重复保存不覆盖、不续期，非法输入或存储失败抛固定错误。 */
  save(identity: ResultStagingIdentity, execution: ProviderExecution): Promise<void>;
  /** 校验身份、版本、期限与结果；缺失或过期返回 undefined，损坏记录抛固定错误。 */
  load(identity: ResultStagingIdentity): Promise<ProviderExecution | undefined>;
  /** 幂等删除该完整身份的暂存值；Redis 失败抛固定错误。 */
  remove(identity: ResultStagingIdentity): Promise<void>;
}

/** 兼容 ioredis 的最小接口；set 必须支持原子的 EX/NX，不能退化为先读后写。 */
export interface ResultStagingRedisClient {
  /** 带固定秒级期限的首次写入；已存在时返回 null，不改变原值或 TTL。 */
  set(
    key: string,
    value: string,
    expiry: 'EX',
    seconds: number,
    condition: 'NX',
  ): Promise<string | null>;
  /** 读取密文，键不存在时返回 null。 */
  get(key: string): Promise<string | null>;
  /** 删除完整身份对应的键，返回删除数量。 */
  del(key: string): Promise<number>;
}

/** Queue.client 暴露的脚本与基本命令子集，不依赖缺失 NX 选项的 set。 */
type QueueResultStagingClient = Pick<IRedisClient, 'defineCommand' | 'runCommand' | 'get' | 'del'>;
/** 对同一连接的并发工厂实例只注册一次脚本，连接对象可被正常回收。 */
const registeredStagingClients = new WeakSet<QueueResultStagingClient>();
/** 独立于 BullMQ 内置脚本的版本化命令名。 */
const STAGING_SET_COMMAND = 'mcResultStagingSetNxV1';
/** 在 Redis 侧一次完成首次写入与过期设置，不存在先查后写竞态。 */
const STAGING_SET_LUA = "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')";

/**
 * 适配 BullMQ Queue.client；首次 set 才注册 Lua，复用连接且不发起新连接。
 * @param clientPromise 队列原有连接；脚本接收一个 key、密文和秒级 TTL。
 * @returns 具备原子 EX/NX 的最小客户端；所有失败均抛固定 storage_failed 错误。
 */
export function createResultStagingRedisAdapter(
  clientPromise: Promise<QueueResultStagingClient>,
): ResultStagingRedisClient {
  // 立即接住连接拒绝，避免首次操作前出现携带连接详情的未处理 rejection。
  const ready = clientPromise.catch(() => undefined);

  /** 保留连接失败为显式错误，不把它伪装成 get 缺失或 NX 冲突。 */
  async function resolveClient(): Promise<QueueResultStagingClient> {
    const client = await ready;
    if (!client) throw new ResultStagingError('storage_failed');
    return client;
  }

  return {
    async set(key, value, expiry, seconds, condition) {
      try {
        if (expiry !== 'EX' || seconds !== RESULT_STAGING_TTL_SECONDS || condition !== 'NX') {
          throw new ResultStagingError('storage_failed');
        }
        const client = await resolveClient();
        if (!registeredStagingClients.has(client)) {
          client.defineCommand(STAGING_SET_COMMAND, { numberOfKeys: 1, lua: STAGING_SET_LUA });
          registeredStagingClients.add(client);
        }
        const result: unknown = await client.runCommand(STAGING_SET_COMMAND, [key, value, seconds]);
        if (result !== 'OK' && result !== null) throw new ResultStagingError('storage_failed');
        return result;
      } catch {
        throw new ResultStagingError('storage_failed');
      }
    },
    async get(key) {
      try {
        const result = await (await resolveClient()).get(key);
        if (typeof result !== 'string' && result !== null)
          throw new ResultStagingError('storage_failed');
        return result;
      } catch {
        throw new ResultStagingError('storage_failed');
      }
    },
    async del(key) {
      try {
        const result = await (await resolveClient()).del(key);
        if (result !== 0 && result !== 1) throw new ResultStagingError('storage_failed');
        return result;
      } catch {
        throw new ResultStagingError('storage_failed');
      }
    },
  };
}

/** 构造独立暂存区；复用环境凭据密钥环，不创建连接、不读取生产数据。 */
export type RedisResultStagingStoreOptions = {
  client: ResultStagingRedisClient;
  /** 部署级 Redis 命名空间，同时绑定在加密记录中。 */
  namespace: string;
  /** 由 createCredentialEncryptionKeyringFromEnvironment 构造，允许历史密钥读取。 */
  keyring: CredentialEncryptionKeyring;
  /** 原始内容字节上限，默认与归档器一致为 50 MiB；密文必须小于 Redis 512 MiB 上限。 */
  maxBytes?: number;
  /** Unix 毫秒时钟，仅用于测试期限；默认 Date.now。 */
  now?: () => number;
};

/** 所有对外错误均使用固定消息，不保留原始异常、URL、明文或密文。 */
const ERROR_MESSAGES = {
  invalid_configuration: '结果暂存配置无效',
  invalid_identity: '结果暂存身份无效',
  invalid_execution: '结果暂存输出无效',
  too_large: '结果暂存超过体积上限',
  invalid_record: '结果暂存记录无法验证',
  storage_failed: '结果暂存存储操作失败',
} as const;

/** 可供 Worker 判定失败边界的脱敏错误，不携带原始 cause。 */
export class ResultStagingError extends Error {
  /** 根据固定错误码构造安全消息；不能传入供应商或 Redis 原始消息。 */
  constructor(public readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ResultStagingError';
  }
}

/**
 * 创建只写密文的 Redis 暂存区；同一身份采用首次值优先，读取不触发重加密或续期。
 * @throws ResultStagingError 配置无效时抛出；各操作的外部错误也统一脱敏。
 */
export function createRedisResultStagingStore(
  options: RedisResultStagingStoreOptions,
): ResultStagingStore {
  const { client, namespace, keyring } = options;
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (
    typeof namespace !== 'string' ||
    !namespace.trim() ||
    namespace.length > 256 ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    throw new ResultStagingError('invalid_configuration');
  }
  const maxPlaintextBytes = 4 * Math.ceil(maxBytes / 3) + ENVELOPE_OVERHEAD_BYTES;
  // AES-GCM 的 IV/tag 共 28 字节；密钥标识最多 64 字符，前缀与分隔符共 7 字符。
  const maxCiphertextBytes = 4 * Math.ceil((maxPlaintextBytes + 28) / 3) + 71;
  if (!Number.isSafeInteger(maxCiphertextBytes) || maxCiphertextBytes > REDIS_MAX_VALUE_BYTES) {
    throw new ResultStagingError('invalid_configuration');
  }

  /** 校验时钟，防止 NaN、回退到负数或不安全整数使期限检查失效。 */
  function currentTime(): number {
    const value = now();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      !Number.isSafeInteger(value + RESULT_STAGING_TTL_SECONDS * 1000)
    ) {
      throw new ResultStagingError('invalid_configuration');
    }
    return value;
  }

  /** 只在 key 中保留身份摘要，元数据和租户标识都留在密文内部。 */
  function redisKey(identity: ResultStagingIdentity): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([PURPOSE, VERSION, namespace, identity]))
      .digest('hex');
    return `${namespace}:result-staging:v${VERSION}:${digest}`;
  }

  /** 验证完整加密封装，任何损坏均终止恢复；已过期值不删除以免误删并发新值。 */
  async function loadRecord(
    identity: ResultStagingIdentity,
  ): Promise<ProviderExecution | undefined> {
    let ciphertext: string | null;
    try {
      ciphertext = await client.get(redisKey(identity));
    } catch {
      throw new ResultStagingError('storage_failed');
    }
    if (ciphertext === null) return undefined;
    try {
      if (
        typeof ciphertext !== 'string' ||
        Buffer.byteLength(ciphertext, 'utf8') > maxCiphertextBytes
      ) {
        throw new ResultStagingError('invalid_record');
      }
      const plaintext = keyring.decrypt(ciphertext).plaintext;
      if (Buffer.byteLength(plaintext, 'utf8') > maxPlaintextBytes) {
        throw new ResultStagingError('invalid_record');
      }
      const record: unknown = JSON.parse(plaintext);
      if (
        !isRecord(record) ||
        record.purpose !== PURPOSE ||
        record.version !== VERSION ||
        record.namespace !== namespace ||
        JSON.stringify(normalizeIdentity(record.identity)) !== JSON.stringify(identity) ||
        !Number.isSafeInteger(record.createdAt) ||
        !Number.isSafeInteger(record.expiresAt) ||
        (record.createdAt as number) < 0 ||
        record.expiresAt !== (record.createdAt as number) + RESULT_STAGING_TTL_SECONDS * 1000
      ) {
        throw new ResultStagingError('invalid_record');
      }
      const timestamp = currentTime();
      if ((record.createdAt as number) > timestamp) throw new ResultStagingError('invalid_record');
      if ((record.expiresAt as number) <= timestamp) return undefined;
      const execution = validateExecution(record.execution, identity, maxBytes);
      return (record.expiresAt as number) <= currentTime() ? undefined : execution;
    } catch {
      throw new ResultStagingError('invalid_record');
    }
  }

  return {
    async save(rawIdentity, execution) {
      const identity = normalizeIdentity(rawIdentity);
      let ciphertext: string;
      try {
        const createdAt = currentTime();
        const plaintext = JSON.stringify({
          purpose: PURPOSE,
          version: VERSION,
          namespace,
          identity,
          createdAt,
          expiresAt: createdAt + RESULT_STAGING_TTL_SECONDS * 1000,
          execution: validateExecution(execution, identity, maxBytes),
        });
        if (Buffer.byteLength(plaintext, 'utf8') > maxPlaintextBytes) {
          throw new ResultStagingError('too_large');
        }
        ciphertext = keyring.encrypt(plaintext);
      } catch (error) {
        if (error instanceof ResultStagingError) throw error;
        throw new ResultStagingError('invalid_execution');
      }
      let written: string | null;
      try {
        written = await client.set(
          redisKey(identity),
          ciphertext,
          'EX',
          RESULT_STAGING_TTL_SECONDS,
          'NX',
        );
      } catch {
        throw new ResultStagingError('storage_failed');
      }
      if (written === 'OK') return;
      if (written !== null) throw new ResultStagingError('storage_failed');
      // NX 冲突只接受可验证的原值；损坏、过期或并发删除都不能被本次候选值覆盖。
      if (!(await loadRecord(identity))) throw new ResultStagingError('invalid_record');
    },
    async load(rawIdentity) {
      return loadRecord(normalizeIdentity(rawIdentity));
    },
    async remove(rawIdentity) {
      const identity = normalizeIdentity(rawIdentity);
      try {
        await client.del(redisKey(identity));
      } catch {
        throw new ResultStagingError('storage_failed');
      }
    },
  };
}

/** 规范化字段顺序，不折叠匿名租户、空身份或拼接分隔符，防止跨身份串值。 */
function normalizeIdentity(value: unknown): ResultStagingIdentity {
  if (!isRecord(value)) throw new ResultStagingError('invalid_identity');
  for (const field of [
    'runId',
    'projectId',
    'nodeId',
    'snapshotFingerprint',
    'requestProviderJobId',
    'userId',
  ]) {
    const item = value[field];
    if (field === 'userId' && item === undefined) continue;
    if (typeof item !== 'string' || !item.trim() || item.length > 4096) {
      throw new ResultStagingError('invalid_identity');
    }
  }
  return {
    runId: value.runId as string,
    ...(value.userId !== undefined ? { userId: value.userId as string } : {}),
    projectId: value.projectId as string,
    nodeId: value.nodeId as string,
    snapshotFingerprint: value.snapshotFingerprint as string,
    requestProviderJobId: value.requestProviderJobId as string,
  };
}

/** 校验结果、节点和媒体输出，并恢复费用与供应商任务元数据，不把错误详情向外传播。 */
function validateExecution(
  value: unknown,
  identity: ResultStagingIdentity,
  maxBytes: number,
): ProviderExecution {
  if (!isRecord(value)) throw new ResultStagingError('invalid_execution');
  const result = runResultSchema.safeParse(value.result);
  if (!result.success || result.data.targetNodeId !== identity.nodeId) {
    throw new ResultStagingError('invalid_execution');
  }
  let output: ProviderOutput | undefined;
  if (value.output !== undefined) {
    const candidate = value.output;
    if (
      !isRecord(candidate) ||
      candidate.mediaType !== result.data.mediaType ||
      !['text', 'url', 'base64'].includes(candidate.kind as string) ||
      typeof candidate.mimeType !== 'string' ||
      !candidate.mimeType.trim() ||
      (candidate.format !== undefined && typeof candidate.format !== 'string')
    ) {
      throw new ResultStagingError('invalid_execution');
    }
    const field = candidate.kind === 'text' ? 'text' : candidate.kind === 'url' ? 'url' : 'base64';
    const content = candidate[field];
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      Object.keys(candidate).some(
        (key) => !['kind', 'mediaType', 'mimeType', 'format', field].includes(key),
      )
    ) {
      throw new ResultStagingError('invalid_execution');
    }
    if (
      Buffer.byteLength(content, 'utf8') >
      (field === 'base64' ? 4 * Math.ceil(maxBytes / 3) + ENVELOPE_OVERHEAD_BYTES : maxBytes)
    ) {
      throw new ResultStagingError('too_large');
    }
    if (field === 'base64') {
      const encoded = content
        .trim()
        .replace(/^data:[^;,]+;base64,/i, '')
        .replace(/\s+/g, '');
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      if (Math.floor((encoded.length * 3) / 4) - padding > maxBytes)
        throw new ResultStagingError('too_large');
    }
    try {
      const normalized = normalizeProviderOutput(candidate, result.data.mediaType);
      if (!normalized || normalized.kind !== candidate.kind)
        throw new ResultStagingError('invalid_execution');
    } catch {
      throw new ResultStagingError('invalid_execution');
    }
    // 只校验，不用 normalizer 的 trim/default 改写已经成功返回的原始内容。
    output = candidate as ProviderOutput;
  }
  let providerJob: ProviderExecution['providerJob'];
  if (value.providerJob !== undefined) {
    const parsed = executionProviderJobSchema.safeParse(value.providerJob);
    if (!parsed.success) throw new ResultStagingError('invalid_execution');
    providerJob = parsed.data;
  }
  let usage: ProviderExecution['usage'];
  if (value.usage !== undefined) {
    const candidate = value.usage;
    if (
      !isRecord(candidate) ||
      (candidate.amount !== undefined &&
        typeof candidate.amount !== 'string' &&
        !(typeof candidate.amount === 'number' && Number.isFinite(candidate.amount))) ||
      (candidate.currency !== undefined && typeof candidate.currency !== 'string') ||
      (candidate.userId !== undefined && typeof candidate.userId !== 'string') ||
      (candidate.metadata !== undefined && !isRecord(candidate.metadata))
    )
      throw new ResultStagingError('invalid_execution');
    usage = {
      ...(candidate.amount !== undefined ? { amount: candidate.amount as number | string } : {}),
      ...(candidate.currency !== undefined ? { currency: candidate.currency } : {}),
      ...(candidate.userId !== undefined ? { userId: candidate.userId } : {}),
      ...(candidate.metadata !== undefined
        ? { metadata: candidate.metadata as Record<string, unknown> }
        : {}),
    };
  }
  return {
    result: result.data,
    ...(output ? { output } : {}),
    ...(providerJob ? { providerJob } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** 只接受普通记录结构，拒绝 null 与数组。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

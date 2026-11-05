/** 生成资源固定保留窗口：从打上淘汰标记的时刻起算 72 小时。 */
export const RETENTION_WINDOW_MS = 72 * 60 * 60 * 1000;

/** 单个用户的存储配额；写死不做配置项。 */
export const USER_STORAGE_QUOTA_BYTES = 10 * 1024 ** 3;

/** 用户存储占用达到配额的该比例后，开始对最早的生成资源打淘汰倒计时。 */
export const STORAGE_EVICTION_THRESHOLD = 0.75;

/** 触发淘汰的最小占用字节数（配额 × 阈值）。 */
export const STORAGE_EVICTION_THRESHOLD_BYTES =
  USER_STORAGE_QUOTA_BYTES * STORAGE_EVICTION_THRESHOLD;

/** 淘汰原因：仅由用户存储占用越线触发。 */
export const STORAGE_PRESSURE_REASON = 'storage_pressure';

/** 一次存储水位检查的结果。 */
export type AssetEvictionResult = { evicted: number; bytes: number };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTime(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/**
 * 判断资源是否为生成资源；生成资源可被淘汰，上传与历史资源永不淘汰。
 * @param metadata 资源元数据。
 * @returns 带生成标记或生成时间时返回 true。
 */
export function isGeneratedAsset(metadata: unknown): boolean {
  const record = asRecord(metadata);
  if (!record) return false;
  return record.generated === true || Number.isFinite(parseTime(record.generatedAt));
}

/**
 * 读取淘汰倒计时的截止时间。
 * @param metadata 资源元数据。
 * @returns 已打上 72 小时保留标记时返回截止毫秒数，否则返回 undefined。
 */
export function retentionDeadline(metadata: unknown): number | undefined {
  const record = asRecord(metadata);
  if (!record || record.retentionHours !== 72) return undefined;
  const expiresAt = parseTime(record.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/**
 * 判断资源是否已带未到期的淘汰倒计时；这些字节仍占用空间但不再重复打标。
 * @param metadata 资源元数据。
 * @returns 有倒计时且尚未到期、尚未墓碑化时返回 true。
 */
export function hasActiveCountdown(metadata: unknown, now = Date.now()): boolean {
  const record = asRecord(metadata);
  if (!record || record.expiredAt) return false;
  const deadline = retentionDeadline(record);
  return deadline !== undefined && deadline > now;
}

/**
 * 生成淘汰标记：从现在起 72 小时后删除；已存在的倒计时不被覆盖。
 * @param metadata 资源当前元数据。
 * @param now 打标时刻的毫秒时间戳。
 * @returns 合并了倒计时字段后的新元数据（保持不可变，不修改入参）。
 */
export function withStorageEvictionMarker(
  metadata: unknown,
  now = Date.now(),
): Record<string, unknown> {
  const record = { ...asRecord(metadata) };
  if (hasActiveCountdown(record, now)) return record;
  const startedAt = new Date(now).toISOString();
  return {
    ...record,
    retentionHours: 72,
    evictionReason: STORAGE_PRESSURE_REASON,
    evictionStartedAt: startedAt,
    expiresAt: new Date(now + RETENTION_WINDOW_MS).toISOString(),
  };
}

/** 仅清理明确标记了保留策略的生成资源，历史资源和上传不追溯。 */
export function isGeneratedAssetExpired(metadata: unknown, now = Date.now()): boolean {
  const record = asRecord(metadata);
  if (!record || record.retentionHours !== 72) return false;
  const expiresAt = parseTime(record.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  // 新策略以打标时刻为起点；旧数据仍以生成时刻为起点，两者都要求恰好 72 小时窗口。
  const startedAt = parseTime(record.evictionStartedAt);
  const generatedAt = parseTime(record.generatedAt);
  const windowMatches = Number.isFinite(startedAt)
    ? expiresAt - startedAt === RETENTION_WINDOW_MS
    : expiresAt - generatedAt === RETENTION_WINDOW_MS;
  return windowMatches && expiresAt <= now;
}

export type AssetExpirationResult = { deleted: number; failed: number };

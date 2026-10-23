/** 仅清理明确标记了新保留策略的生成资源，历史资源和上传不追溯。 */
export function isGeneratedAssetExpired(metadata: unknown, now = Date.now()): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  if (record.retentionHours !== 72) return false;
  const generatedAt = typeof record.generatedAt === 'string' ? Date.parse(record.generatedAt) : NaN;
  const expiresAt = typeof record.expiresAt === 'string' ? Date.parse(record.expiresAt) : NaN;
  return (
    Number.isFinite(generatedAt) &&
    expiresAt - generatedAt === 72 * 60 * 60 * 1000 &&
    expiresAt <= now
  );
}

export type AssetExpirationResult = { deleted: number; failed: number };

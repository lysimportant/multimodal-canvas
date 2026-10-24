import type { Asset } from '@multimodal-canvas/domain';

type AssetSizeSource = Pick<Asset, 'id' | 'contentUrl' | 'latestVersion'> & {
  sizeBytes?: number;
};

/** 0 是旧节点的占位值，不能当成已获取的文件大小。 */
export function formatAssetFileSize(bytes?: number): string {
  if (!validSize(bytes)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** unit).toFixed(2))} ${units[unit]}`;
}

/** 仅从同一文件版本补全大小，避免把最新版本大小显示到历史预览。 */
export function resolveAssetFileSize(
  asset: AssetSizeSource,
  knownAsset?: AssetSizeSource,
): number | undefined {
  const version = contentVersion(asset.contentUrl) ?? asset.latestVersion;
  const directVersionMatches =
    version === undefined || asset.latestVersion === undefined || version === asset.latestVersion;
  if (directVersionMatches && validSize(asset.sizeBytes)) return asset.sizeBytes;
  if (!knownAsset || asset.id !== knownAsset.id || !validSize(knownAsset.sizeBytes))
    return undefined;
  const knownVersion = knownAsset.latestVersion ?? contentVersion(knownAsset.contentUrl);
  if (version !== undefined || knownVersion !== undefined) {
    if (version !== undefined && knownVersion !== undefined) {
      return version === knownVersion ? knownAsset.sizeBytes : undefined;
    }
    // 未冻结来源的 /content 始终指向索引当前文件；明确冻结版本则不能猜测。
    if (version !== undefined) return undefined;
  }
  return asset.contentUrl && asset.contentUrl === knownAsset.contentUrl
    ? knownAsset.sizeBytes
    : undefined;
}

function validSize(bytes?: number): bytes is number {
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0;
}

function contentVersion(url: string): number | undefined {
  const match = url.match(/\/versions\/(\d+)\/(?:content|derivatives\/thumbnail)(?:[/?#]|$)/);
  const version = match ? Number(match[1]) : undefined;
  return version !== undefined && Number.isSafeInteger(version) && version > 0
    ? version
    : undefined;
}

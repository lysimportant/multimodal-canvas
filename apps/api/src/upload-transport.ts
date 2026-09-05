/** S3 上传方式：direct 返回预签名地址，proxy 经 API 校验后写入对象存储。 */
export type S3UploadMode = 'proxy' | 'direct';

/** S3 下载方式：direct 优先使用对象存储签名，proxy 返回受控的 API 短期签名路径。 */
export type S3DownloadMode = S3UploadMode;

/**
 * 解析 S3_UPLOAD_MODE；仅未设置时默认 direct，以保持已有部署行为。
 * @param value 环境变量原值；不接受空串、空白或不同大小写。
 * @returns 明确的上传方式，不改变对象存储、认证或 TLS 配置。
 * @throws 配置不是 proxy 或 direct 时抛出固定错误，不回显环境变量内容。
 */
export function resolveS3UploadMode(value: string | undefined): S3UploadMode {
  return resolveS3TransferMode(value, 'S3_UPLOAD_MODE');
}

/**
 * 解析 S3_DOWNLOAD_MODE；未设置时保留原生签名优先的 direct 行为。
 * @param value 环境变量或注入配置原值，不修剪或忽略非法值。
 * @returns 下载方式，仅影响访问 URL 的生成，不改变存储与 TLS 配置。
 * @throws 配置不是 proxy 或 direct 时抛出固定错误，不回显配置内容。
 */
export function resolveS3DownloadMode(value: string | undefined): S3DownloadMode {
  return resolveS3TransferMode(value, 'S3_DOWNLOAD_MODE');
}

/** 共用严格的传输方式解析，保持上传与下载的默认值和错误规则一致。 */
function resolveS3TransferMode(
  value: string | undefined,
  variable: 'S3_UPLOAD_MODE' | 'S3_DOWNLOAD_MODE',
): S3UploadMode {
  if (value === undefined) return 'direct';
  if (value === 'proxy' || value === 'direct') return value;
  throw new Error(`${variable} must be "proxy" or "direct"`);
}

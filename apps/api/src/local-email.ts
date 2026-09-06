import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

/** 本地开发自动读取的邮件字段；生产仍可使用部署系统注入的配置。 */
const LOCAL_EMAIL_FIELDS = [
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_SECURE',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_FROM',
] as const;

/**
 * 读取仓库根目录的本地 email.txt，仅返回邮件白名单字段。
 * @param filePath 固定私有文件路径；文件缺失时返回空对象，由调用方显示未配置。
 * @returns 可交给邮件发送器的内存配置，不写入环境变量或构建产物。
 * @throws 文件存在但格式无效时抛出带字段名的校验错误。
 */
export async function readLocalEmailFile(filePath: string): Promise<NodeJS.ProcessEnv> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = parseEnv(source);
  const result: NodeJS.ProcessEnv = {};
  for (const field of LOCAL_EMAIL_FIELDS) {
    const value = parsed[field];
    if (value === undefined) throw new Error(`本地 email.txt 缺少字段：${field}`);
    if (!value.trim() || /[\r\n\0]/.test(value))
      throw new Error(`本地 email.txt 字段无效：${field}`);
    result[field] = value;
  }
  if (
    !/^\d+$/.test(result.EMAIL_PORT!) ||
    Number(result.EMAIL_PORT) < 1 ||
    Number(result.EMAIL_PORT) > 65535
  )
    throw new Error('本地 email.txt 的 EMAIL_PORT 无效');
  if (!['true', 'false'].includes(result.EMAIL_SECURE!))
    throw new Error('本地 email.txt 的 EMAIL_SECURE 无效');
  return result;
}

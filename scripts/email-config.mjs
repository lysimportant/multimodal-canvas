/** 邮件环境配置解析；仅将白名单字段传入服务端，永不输出字段值。 */
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

/** SMTP 配置允许使用的环境字段；其他文本不进入子进程环境。 */
const emailFields = [
  'EMAIL_HOST',
  'EMAIL_PORT',
  'EMAIL_SECURE',
  'EMAIL_USER',
  'EMAIL_PASS',
  'EMAIL_FROM',
];

/**
 * 解析 dotenv 格式的邮件配置并校验必需字段。
 * @param {string} source 配置文本，仅保留内存副本。
 * @returns {Record<string, string>} 已校验的 SMTP 环境变量，不含其他进程选项。
 * @throws {Error} 缺少字段、端口或 TLS 配置非法；错误不包含字段值。
 */
export function parseEmailEnvironment(source) {
  const parsed = parseEnv(source);
  const environment = {};
  for (const key of emailFields) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim())
      throw new Error(`缺少邮件配置字段：${key}`);
    if (/[\r\n\0]/.test(parsed[key])) throw new Error(`邮件配置字段包含非法字符：${key}`);
    environment[key] = parsed[key];
  }
  if (
    !/^\d+$/.test(environment.EMAIL_PORT) ||
    Number(environment.EMAIL_PORT) < 1 ||
    Number(environment.EMAIL_PORT) > 65535
  )
    throw new Error('EMAIL_PORT 必须是有效端口');
  if (!['true', 'false'].includes(environment.EMAIL_SECURE))
    throw new Error('EMAIL_SECURE 必须是 true 或 false');
  if (parsed.EMAIL_PROXY) {
    let proxy;
    try {
      proxy = new URL(parsed.EMAIL_PROXY);
    } catch {
      throw new Error('EMAIL_PROXY 必须是 HTTP 或 HTTPS 代理地址');
    }
    if (!['http:', 'https:'].includes(proxy.protocol))
      throw new Error('EMAIL_PROXY 必须是 HTTP 或 HTTPS 代理地址');
    environment.EMAIL_PROXY = parsed.EMAIL_PROXY;
  }
  return environment;
}

/** 从用户指定的只读文件加载 SMTP 参数，不复制到仓库或生成文件。 */
export async function readEmailEnvironment(filePath) {
  return parseEmailEnvironment(await readFile(filePath, 'utf8'));
}

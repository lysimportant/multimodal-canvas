/**
 * 读取节点当前回显正文，供文字「新节点」在建节点前拼接提示词。
 */
import { apiFetch } from '../auth-client';
import type { AssetFlowNode } from '../canvas-utils';
import { isApiOriginUrl, resolveUploadUrl } from '../upload-utils';

import { API_BASE_URL } from './contracts';

/**
 * 按资产 ID 和可选版本拼出内容 URL。
 * @param assetId 资产 ID。
 * @param version 已知版本；缺省走未版本化内容入口，由 API 解析。
 * @returns 相对 API 的内容路径。
 */
export function resultAssetContentUrl(assetId: string, version?: number): string {
  const encodedId = encodeURIComponent(assetId);
  return version === undefined
    ? `/v1/assets/${encodedId}/content`
    : `/v1/assets/${encodedId}/versions/${version}/content`;
}

/**
 * 解析节点当前回显的内容地址。
 * @param node 已有回显的节点。
 * @returns 相对或绝对内容 URL；没有可读取地址时为 undefined。
 */
export function nodeEchoContentUrl(node: AssetFlowNode): string | undefined {
  const result = node.data.resultAsset;
  if (result?.contentUrl) return result.contentUrl;
  if (result?.assetId) return resultAssetContentUrl(result.assetId, result.version);
  if (node.data.contentUrl) return node.data.contentUrl;
  if (node.data.assetId) return resultAssetContentUrl(node.data.assetId);
  return undefined;
}

/**
 * 下载并按 UTF-8 解码当前回显正文。
 * 读失败或正文为空时抛出错误，调用方不得建节点。
 * @param node 文字节点。
 * @param signal 取消信号。
 * @returns 解码后的正文。
 * @throws 地址无效、网络失败、HTTP 失败或正文为空。
 */
export async function fetchNodeEchoText(
  node: AssetFlowNode,
  signal?: AbortSignal,
): Promise<string> {
  const contentUrl = nodeEchoContentUrl(node);
  if (!contentUrl) throw new Error('无法读取当前回显正文');
  const resolved = resolveUploadUrl(contentUrl, API_BASE_URL);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(resolved, window.location.href);
  } catch {
    throw new Error('无法读取当前回显正文');
  }
  if (
    !['http:', 'https:', 'data:', 'blob:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error('无法读取当前回显正文');
  }
  const apiContent = isApiOriginUrl(resolved, API_BASE_URL, window.location.href);
  let response: Response;
  try {
    response = apiContent
      ? await apiFetch(resolved, { cache: 'no-store', signal })
      : await fetch(resolved, {
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal,
        });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new Error('无法读取当前回显正文', { cause });
  }
  if (!response.ok) throw new Error('无法读取当前回显正文');
  const text = await response.text();
  if (!text.trim()) throw new Error('无法读取当前回显正文');
  return text;
}

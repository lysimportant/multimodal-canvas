import type { MediaType } from '@multimodal-canvas/domain';
import { normalizeProviderAssetEndpoint } from './startup-config.js';

/** 单个签名素材的连接、响应头和首字节读取共用十五秒期限。 */
const PREFLIGHT_TIMEOUT_MS = 15_000;

/** 仅检查服务端刚签发的素材 URL；失败时抛出不含地址、令牌或响应正文的错误。 */
export type ProviderAssetPreflight = (url: string, mediaType: MediaType) => Promise<void>;

/** 预检自身的可公开诊断，避免底层网络错误回显签名 URL。 */
class ProviderAssetPreflightError extends Error {
  constructor(reason: string) {
    super(`参考素材公网可读性预检失败：${reason}；本次未提交生成请求。`);
    this.name = 'ProviderAssetPreflightError';
  }
}

/**
 * 创建生成前的只读素材检查器，不接收节点中的任意外部地址。
 *
 * @param fetchImpl 可注入的网络适配器；默认使用进程 fetch，不发送登录凭据。
 * @returns 检查本站或 S3 刚签发地址的函数；最多读取首个非空块，然后取消响应体。
 * @throws 非公网 HTTPS、跳转、鉴权/版本失败、非媒体响应、空内容或超时均阻止生成。
 */
export function createProviderAssetPreflight(
  fetchImpl: typeof fetch = fetch,
): ProviderAssetPreflight {
  return async (url, mediaType) => {
    assertPublicSignedUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await waitForPreflightStage<Response>(
        Promise.resolve().then(() =>
          fetchImpl(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            credentials: 'omit',
            redirect: 'manual',
            signal: controller.signal,
          }),
        ),
        controller.signal,
      );
      assertMediaResponse(response, mediaType);
      if (!response.body) throw new ProviderAssetPreflightError('素材响应为空');
      reader = response.body.getReader();
      for (;;) {
        const chunk = await waitForPreflightStage(reader.read(), controller.signal);
        if (chunk.done) throw new ProviderAssetPreflightError('素材响应为空');
        if (chunk.value.byteLength === 0) continue;
        if (response.status === 206 && chunk.value.byteLength !== 1) {
          throw new ProviderAssetPreflightError('素材服务返回的字节范围与请求不一致');
        }
        break;
      }
    } catch (error) {
      if (error instanceof ProviderAssetPreflightError) throw error;
      if (controller.signal.aborted) throw preflightTimeout();
      throw new ProviderAssetPreflightError('网络、DNS 或 TLS 连接不可用，请检查公网素材入口');
    } finally {
      clearTimeout(timeout);
      controller.abort();
      // 终止未读取的媒体内容；已关闭流的清理错误不能覆盖先前的可公开诊断。
      const cancellation = reader ? reader.cancel() : response?.body?.cancel();
      void cancellation?.catch(() => undefined);
    }
  };
}

/** 只剥除查询参数做静态来源校验；实际 GET 必须保留原始签名 URL。 */
function assertPublicSignedUrl(value: string): void {
  try {
    const endpoint = new URL(value);
    endpoint.search = '';
    normalizeProviderAssetEndpoint(endpoint.toString());
  } catch {
    throw new ProviderAssetPreflightError('素材签名地址必须使用公网 HTTPS');
  }
}

/** 验证 GET/Range 状态与媒体响应头，不解析或回显远端错误正文。 */
function assertMediaResponse(response: Response, mediaType: MediaType): void {
  if (response.status === 401 || response.status === 403) {
    throw new ProviderAssetPreflightError(
      `HTTP ${response.status}，请检查 API 与 Worker 的素材签名密钥，以及对象存储签名和读取权限`,
    );
  }
  if (response.status === 404 || response.status === 410) {
    throw new ProviderAssetPreflightError(
      `HTTP ${response.status}，请检查公网素材路由和所选冻结版本是否可用`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderAssetPreflightError(
      '素材地址发生跳转，请将公网入口配置为可直接读取的素材路由',
    );
  }
  if (response.status !== 200 && response.status !== 206) {
    throw new ProviderAssetPreflightError(`素材服务返回 HTTP ${response.status}`);
  }
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    throw new ProviderAssetPreflightError('素材入口返回 HTML 页面，请检查反向代理和登录拦截');
  }
  if (!mimeType?.startsWith(`${mediaType}/`)) {
    throw new ProviderAssetPreflightError('素材响应的媒体类型缺失或与参考素材不一致');
  }
  const rawLength = response.headers.get('content-length');
  const length = rawLength === null ? undefined : Number(rawLength);
  if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0)) {
    throw new ProviderAssetPreflightError('素材响应为空或长度无效');
  }
  if (response.status === 206) {
    const range = /^bytes 0-0\/([1-9]\d*)$/i.exec(response.headers.get('content-range') ?? '');
    if (
      !range ||
      !Number.isSafeInteger(Number(range[1])) ||
      (length !== undefined && length !== 1)
    ) {
      throw new ProviderAssetPreflightError('素材服务返回的字节范围与请求不一致');
    }
  }
}

/** 网络适配器或响应流未响应 abort 时，仍按整个预检的共同期限结束等待。 */
function waitForPreflightStage<Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(preflightTimeout());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** 返回固定超时诊断，不附带可能包含签名令牌的 abort reason。 */
function preflightTimeout(): ProviderAssetPreflightError {
  return new ProviderAssetPreflightError('访问超过 15 秒，请检查公网素材入口、网络和 TLS 配置');
}

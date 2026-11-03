import type { MediaType } from '@multimodal-canvas/domain';
import { normalizeProviderAssetEndpoint } from './startup-config.js';

/**
 * 单次尝试的连接、响应头和首字节读取共用十五秒期限；网络层失败最多尝试两次，
 * 整个预检最长约三十秒，避免无限重试或长期占用 Worker。
 */
const PREFLIGHT_TIMEOUT_MS = 15_000;
/** 只对可判定为瞬时的网络层失败重试一次；HTTP、媒体与范围校验失败立即终止。 */
const PREFLIGHT_MAX_ATTEMPTS = 2;
/** 原因链与 AggregateError 子项的遍历深度上限。 */
const MAX_ERROR_CAUSE_DEPTH = 6;

/** 诊断只回显常见错误码形态，不把任意错误文本带入面向用户的错误消息。 */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** 域名解析失败；能区分时说明主机名未被解析。 */
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA']);
/** 已解析到地址但 TCP 连接建立/维持失败。 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
/** TLS 握手或证书链校验失败；ERR_TLS_/ERR_SSL_/CERT_ 前缀另行匹配。 */
const TLS_CERTIFICATE_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** 按可公开诊断的阶段名生成失败原因；具体主机名与错误码由调用处补充。 */
const NETWORK_FAILURE_STAGE_LABELS = {
  dns: 'DNS 解析失败',
  connection: '网络连接失败',
  tls: 'TLS 握手或证书校验失败',
} as const;

/** 仅检查服务端刚签发的素材 URL；失败时抛出不含地址、令牌或响应正文的错误。 */
export type ProviderAssetPreflight = (url: string, mediaType: MediaType) => Promise<void>;

/** 预检在传输层可区分的失败阶段；timeout 保留既有的十五秒诊断文案。 */
export type PreflightNetworkFailureStage = 'dns' | 'connection' | 'tls' | 'timeout';

/** 预检自身的可公开诊断，避免底层网络错误回显签名 URL。 */
class ProviderAssetPreflightError extends Error {
  /** 网络层瞬时失败允许在总尝试次数内重试；其余预检失败立即终止。 */
  readonly retryable: boolean;

  constructor(reason: string, options: { retryable?: boolean } = {}) {
    super(`参考素材公网可读性预检失败：${reason}；本次未提交生成请求。`);
    this.name = 'ProviderAssetPreflightError';
    this.retryable = options.retryable ?? false;
  }
}

/**
 * 创建生成前的只读素材检查器，不接收节点中的任意外部地址。
 *
 * 网络层失败（DNS、TCP、TLS 或十五秒超时）自动重试一次，让瞬时抖动不至于
 * 直接判定素材不可读；HTTP 状态、媒体类型、长度、范围与跳转失败不重试。
 *
 * @param fetchImpl 可注入的网络适配器；默认使用进程 fetch，不发送登录凭据。
 * @returns 检查本站或 S3 刚签发地址的函数；最多读取首个非空块，然后取消响应体。
 * @throws 非公网 HTTPS、跳转、鉴权/版本失败、非媒体响应、空内容或超时均阻止生成；
 *   网络层失败时诊断会区分 DNS、连接与 TLS，只附带脱敏主机名和错误码。
 */
export function createProviderAssetPreflight(
  fetchImpl: typeof fetch = fetch,
): ProviderAssetPreflight {
  return async (url, mediaType) => {
    assertPublicSignedUrl(url);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runPreflightAttempt(fetchImpl, url, mediaType);
        return;
      } catch (error) {
        if (
          !(error instanceof ProviderAssetPreflightError) ||
          !error.retryable ||
          attempt >= PREFLIGHT_MAX_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  };
}

/**
 * 纯函数：仅凭错误对象及其 cause/AggregateError 子项判断网络失败阶段。
 * 便于单元测试以及后续在不发起请求的情况下复用分类规则。
 */
export function classifyPreflightNetworkFailure(
  error: unknown,
): PreflightNetworkFailureStage | undefined {
  const classified = findClassifiedErrorCode(collectErrorCodes(error));
  if (classified) return classified.stage;
  return isAbortError(error) ? 'timeout' : undefined;
}

/** 执行一次完整的预检尝试；每次尝试拥有独立的 AbortController 与超时计时器。 */
async function runPreflightAttempt(
  fetchImpl: typeof fetch,
  url: string,
  mediaType: MediaType,
): Promise<void> {
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
    throw describeNetworkFailure(error, url);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    // 终止未读取的媒体内容；已关闭流的清理错误不能覆盖先前的可公开诊断。
    const cancellation = reader ? reader.cancel() : response?.body?.cancel();
    void cancellation?.catch(() => undefined);
  }
}

/**
 * 把底层网络错误转换为可公开诊断，并标记是否允许重试。
 * 只保留主机名与受控形态的错误码，绝不拼接完整签名地址、查询参数或响应正文。
 */
function describeNetworkFailure(error: unknown, url: string): ProviderAssetPreflightError {
  const codes = collectErrorCodes(error);
  const classified = findClassifiedErrorCode(codes);
  const host = preflightHost(url);
  if (classified) {
    return new ProviderAssetPreflightError(
      `${NETWORK_FAILURE_STAGE_LABELS[classified.stage]}（${diagnosticTarget(host, classified.code)}）`,
      { retryable: true },
    );
  }
  if (isAbortError(error)) return preflightTimeout();
  return new ProviderAssetPreflightError(
    `网络、DNS 或 TLS 连接不可用（${diagnosticTarget(host, codes[0])}），请检查公网素材入口`,
  );
}

/** 只展示主机名和错误码；两者都缺失时给出固定说明，不退回原始错误文本。 */
function diagnosticTarget(host: string | undefined, code: string | undefined): string {
  const parts: string[] = [];
  if (host) parts.push(`素材主机 ${host}`);
  if (code) parts.push(`错误 ${code}`);
  return parts.length > 0 ? parts.join('，') : '未提供错误码';
}

/** 摘取 URL 主机名用于诊断；解析失败时退回不含地址的固定说明。 */
function preflightHost(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 选择最具体的错误码：能到达 TLS 说明 DNS 与 TCP 已成功，连接错误同样说明 DNS 已成功，
 * 因此优先级为 TLS > TCP > DNS。
 */
function findClassifiedErrorCode(
  codes: readonly string[],
): { readonly stage: 'dns' | 'connection' | 'tls'; readonly code: string } | undefined {
  for (const code of codes) {
    if (isTlsCertificateErrorCode(code)) return { stage: 'tls', code };
  }
  for (const code of codes) {
    if (CONNECTION_ERROR_CODES.has(code)) return { stage: 'connection', code };
  }
  for (const code of codes) {
    if (DNS_ERROR_CODES.has(code)) return { stage: 'dns', code };
  }
  return undefined;
}

/** TLS 证书/握手错误在 OpenSSL 与 Node 中同时存在前缀式与固定集合两种形态。 */
function isTlsCertificateErrorCode(code: string): boolean {
  return (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('CERT_') ||
    code.startsWith('ERR_SSL_') ||
    TLS_CERTIFICATE_ERROR_CODES.has(code)
  );
}

/** 从错误及其 cause/AggregateError 子项中收集受控形态的错误码，去重并保持发现顺序。 */
function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  walkError(error, (entry) => {
    const code = Reflect.get(entry, 'code');
    if (typeof code === 'string' && SAFE_ERROR_CODE.test(code) && !codes.includes(code)) {
      codes.push(code);
    }
  });
  return codes;
}

/** AbortError 可能经过 fetch 的 cause 包装，需沿原因链识别。 */
function isAbortError(error: unknown): boolean {
  let aborted = false;
  walkError(error, (entry) => {
    if (Reflect.get(entry, 'name') === 'AbortError') aborted = true;
    if (Reflect.get(entry, 'code') === 'ABORT_ERR') aborted = true;
  });
  return aborted;
}

/**
 * 深度优先遍历错误对象的原因链与 AggregateError 子项，避免异常结构导致无限循环。
 * 仅访问对象上的 code/name/cause/errors 字段，不读取错误消息正文。
 */
function walkError(error: unknown, visit: (entry: object) => void): void {
  const seen = new Set<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_ERROR_CAUSE_DEPTH || value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    visit(value);
    const nested = Reflect.get(value, 'errors');
    if (Array.isArray(nested)) {
      for (const item of nested) walk(item, depth + 1);
    }
    walk(Reflect.get(value, 'cause'), depth + 1);
  };
  walk(error, 0);
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

/** 网络适配器或响应流未响应 abort 时，仍按本次尝试的共同期限结束等待。 */
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

/** 返回固定超时诊断，不附带可能包含签名令牌的 abort reason；网络层超时允许再试一次。 */
function preflightTimeout(): ProviderAssetPreflightError {
  return new ProviderAssetPreflightError('访问超过 15 秒，请检查公网素材入口、网络和 TLS 配置', {
    retryable: true,
  });
}

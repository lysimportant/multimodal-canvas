import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPreflightNetworkFailure,
  createProviderAssetPreflight,
} from './provider-asset-preflight';

const signedUrl =
  'https://canvas.example.com/v1/provider-assets/asset/versions/2/content?access_token=synthetic-secret';

const r2SignedUrl =
  'https://b0ed4b98deadbeef.r2.cloudflarestorage.com/canvas/assets/frozen-v2' +
  '?X-Amz-Credential=synthetic-access-key&X-Amz-Signature=synthetic-signature&X-Amz-Expires=3600';

afterEach(() => vi.useRealTimers());

/** 构造带 Node/undici 风格错误码的底层异常。 */
function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(`network failure ${code}`), { code });
}

/** 构造 fetch 包装后的失败：TypeError: fetch failed，具体错误码在 cause 上。 */
function fetchFailure(code: string): TypeError {
  return Object.assign(new TypeError(`fetch failed for ${code}`), {
    cause: errorWithCode(code),
  });
}

/** 每个可分类错误码与其预期阶段；纯分类器与消息行为测试共用。 */
const failureClassificationCases = [
  { code: 'ENOTFOUND', stage: 'dns' },
  { code: 'EAI_AGAIN', stage: 'dns' },
  { code: 'EAI_FAIL', stage: 'dns' },
  { code: 'EAI_NODATA', stage: 'dns' },
  { code: 'ECONNREFUSED', stage: 'connection' },
  { code: 'ECONNRESET', stage: 'connection' },
  { code: 'ETIMEDOUT', stage: 'connection' },
  { code: 'EHOSTUNREACH', stage: 'connection' },
  { code: 'ENETUNREACH', stage: 'connection' },
  { code: 'EPIPE', stage: 'connection' },
  { code: 'UND_ERR_CONNECT_TIMEOUT', stage: 'connection' },
  { code: 'UND_ERR_SOCKET', stage: 'connection' },
  { code: 'ERR_TLS_CERT_ALTNAME_INVALID', stage: 'tls' },
  { code: 'CERT_HAS_EXPIRED', stage: 'tls' },
  { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', stage: 'tls' },
  { code: 'SELF_SIGNED_CERT_IN_CHAIN', stage: 'tls' },
  { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', stage: 'tls' },
  { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', stage: 'tls' },
  { code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', stage: 'tls' },
] as const;

/** 每类网络失败的代表性错误码与公开诊断文案；消息行为测试按类覆盖。 */
const networkFailureMessages = [
  { code: 'ENOTFOUND', message: 'DNS 解析失败' },
  { code: 'ECONNREFUSED', message: '网络连接失败' },
  { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'TLS 握手或证书校验失败' },
] as const;

describe('classifyPreflightNetworkFailure', () => {
  it.each(failureClassificationCases)('把 $code 归类为 $stage', ({ code, stage }) => {
    expect(classifyPreflightNetworkFailure(errorWithCode(code))).toBe(stage);
  });

  it('沿 cause 与 AggregateError 子项识别错误码', () => {
    expect(classifyPreflightNetworkFailure(fetchFailure('ENOTFOUND'))).toBe('dns');
    expect(
      classifyPreflightNetworkFailure(
        new AggregateError([errorWithCode('ECONNREFUSED')], 'All connection attempts failed'),
      ),
    ).toBe('connection');
  });

  it('AbortError 归入超时阶段，未知错误返回 undefined', () => {
    expect(
      classifyPreflightNetworkFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBe('timeout');
    expect(classifyPreflightNetworkFailure(new Error('unknown failure'))).toBeUndefined();
    expect(classifyPreflightNetworkFailure(undefined)).toBeUndefined();
  });
});

describe('Provider 素材公网预检', () => {
  it.each([200, 206])('以 GET 检查首字节并取消 HTTP %i 的剩余内容', async (status) => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([137]));
        },
        cancel,
      }),
      {
        status,
        headers: {
          'content-type': 'image/png',
          ...(status === 206 ? { 'content-range': 'bytes 0-0/1024', 'content-length': '1' } : {}),
        },
      },
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image');

    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(signedUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials: 'omit',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each([
    { mediaType: 'audio' as const, mimeType: 'audio/wav' },
    { mediaType: 'video' as const, mimeType: 'video/mp4; charset=binary' },
  ])('接受冻结 $mediaType 的媒体响应', async ({ mediaType, mimeType }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('x', {
        headers: { 'content-type': mimeType },
      }),
    );
    await expect(
      createProviderAssetPreflight(fetchImpl)(signedUrl, mediaType),
    ).resolves.toBeUndefined();
  });

  it.each([
    { status: 401, message: '素材签名密钥' },
    { status: 403, message: '素材签名密钥' },
    { status: 404, message: '所选冻结版本' },
    { status: 410, message: '所选冻结版本' },
    { status: 302, message: '发生跳转' },
    { status: 429, message: 'HTTP 429' },
    { status: 500, message: 'HTTP 500' },
  ])('拒绝 HTTP $status，诊断不包含响应正文或跳转地址', async ({ status, message }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`secret body ${signedUrl}`, {
        status,
        headers: { location: 'https://127.0.0.1/private?token=another-secret' },
      }),
    );
    const error = await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image').catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(message);
    expect(error.message).toContain('本次未提交生成请求');
    expect(error.message).not.toMatch(/synthetic-secret|another-secret|secret body|https:/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, message: 'HTTP 401' },
    { status: 404, message: 'HTTP 404' },
  ])('HTTP $status 属于确定性失败，不做网络重试', async ({ status, message }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status }));
    await expect(createProviderAssetPreflight(fetchImpl)(signedUrl, 'image')).rejects.toThrow(
      message,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { code: 'ENOTFOUND', message: 'DNS 解析失败' },
    { code: 'ECONNREFUSED', message: '网络连接失败' },
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'TLS 握手或证书校验失败' },
  ] as const)(
    '网络层失败 $code 输出「$message」并自动重试一次后失败',
    async ({ code, message }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(fetchFailure(code));
      const error = await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image').catch(
        (error) => error,
      );
      expect(error.message).toContain(`参考素材公网可读性预检失败：${message}`);
      expect(error.message).toContain('素材主机 canvas.example.com');
      expect(error.message).toContain(`错误 ${code}`);
      expect(error.message).toContain('；本次未提交生成请求。');
      expect(error.message).not.toMatch(/synthetic-secret|access_token|v1\/provider-assets/);
      expect(error.cause).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(networkFailureMessages)('$message 使用错误码 $code', async ({ code, message }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(errorWithCode(code));
    await expect(createProviderAssetPreflight(fetchImpl)(signedUrl, 'image')).rejects.toThrow(
      message,
    );
  });

  it('网络层失败第一次成功即不再重试', async () => {
    const response = new Response('x', {
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-range': 'bytes 0-0/1',
        'content-length': '1',
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(fetchFailure('ECONNRESET'))
      .mockResolvedValueOnce(response);

    await expect(
      createProviderAssetPreflight(fetchImpl)(signedUrl, 'image'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it('错误消息只保留脱敏主机名，不泄漏签名查询、路径或凭据', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(fetchFailure('ECONNREFUSED'));
    const error = await createProviderAssetPreflight(fetchImpl)(r2SignedUrl, 'image').catch(
      (error) => error,
    );
    expect(error.message).toContain('网络连接失败');
    expect(error.message).toContain('素材主机 b0ed4b98deadbeef.r2.cloudflarestorage.com');
    expect(error.message).toContain('错误 ECONNREFUSED');
    expect(error.message).not.toMatch(/https:|X-Amz|synthetic-access-key|synthetic-signature/);
    expect(error.message).not.toContain('/');
    expect(error.message).not.toContain('?');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('无法分类的底层异常只保留脱敏网络诊断且不重试', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`TLS failed ${signedUrl}`));
    const error = await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image').catch(
      (error) => error,
    );
    expect(error.message).toContain('网络、DNS 或 TLS 连接不可用');
    expect(error.message).toContain('素材主机 canvas.example.com');
    expect(error.message).not.toContain('synthetic-secret');
    expect(error.cause).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('AbortError 保留既有十五秒超时诊断并重试一次', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const error = await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image').catch(
      (error) => error,
    );
    expect(error.message).toContain('访问超过 15 秒，请检查公网素材入口、网络和 TLS 配置');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each<{ headers: Record<string, string>; body: BodyInit; message: string }>([
    { headers: { 'content-type': 'text/html; charset=utf-8' }, body: 'login', message: 'HTML' },
    { headers: { 'content-type': 'application/xhtml+xml' }, body: 'login', message: 'HTML' },
    { headers: { 'content-type': 'application/json' }, body: '{}', message: '媒体类型' },
    { headers: { 'content-type': 'video/mp4' }, body: 'x', message: '媒体类型' },
    { headers: {}, body: new Uint8Array([1]), message: '媒体类型' },
    { headers: { 'content-type': 'image/png', 'content-length': '0' }, body: '', message: '为空' },
    { headers: { 'content-type': 'image/png' }, body: '', message: '为空' },
  ])('阻止无效媒体响应 %#', async ({ headers, body, message }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers }));
    await expect(createProviderAssetPreflight(fetchImpl)(signedUrl, 'image')).rejects.toThrow(
      message,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { range: undefined, length: '1', body: 'x' },
    { range: 'bytes 1-1/100', length: '1', body: 'x' },
    { range: 'bytes 0-2/100', length: '3', body: 'xyz' },
    { range: 'bytes 0-0/0', length: '1', body: 'x' },
    { range: 'bytes 0-0/100', length: '2', body: 'xy' },
    { range: 'bytes 0-0/100', length: undefined, body: 'xy' },
  ])('拒绝不匹配的 206 Range 响应 %#', async ({ range, length, body }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 206,
        headers: {
          'content-type': 'image/png',
          ...(range ? { 'content-range': range } : {}),
          ...(length ? { 'content-length': length } : {}),
        },
      }),
    );
    await expect(createProviderAssetPreflight(fetchImpl)(signedUrl, 'image')).rejects.toThrow(
      '字节范围',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    'http://canvas.example.com/image?access_token=synthetic-secret',
    'https://127.0.0.1/image?access_token=synthetic-secret',
    'https://10.0.0.1/image?access_token=synthetic-secret',
    'https://localhost/image?access_token=synthetic-secret',
    'https://user:synthetic-secret@canvas.example.com/image',
    'https://canvas.example.com/image?access_token=synthetic-secret#fragment',
    'data:image/png;base64,synthetic-secret',
  ])('静态来源校验失败时不发请求 %#', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createProviderAssetPreflight(fetchImpl)(url, 'image')).rejects.toThrow(
      '公网 HTTPS',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'] as const)(
    '%s 阶段每次尝试共用十五秒上限，两次尝试后停止',
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const fetchImpl = vi.fn<typeof fetch>();
      if (stage === 'headers') fetchImpl.mockImplementation(() => new Promise(() => undefined));
      else
        fetchImpl.mockImplementation(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              headers: { 'content-type': 'image/png' },
            }),
        );
      const pending = createProviderAssetPreflight(fetchImpl)(signedUrl, 'image');
      const rejected = expect(pending).rejects.toThrow('访问超过 15 秒');
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(2);
    },
  );
});

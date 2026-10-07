import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAssetPreflight } from './provider-asset-preflight';

const signedUrl =
  'https://canvas.example.com/v1/provider-assets/asset/versions/2/content?access_token=synthetic-secret';

afterEach(() => vi.useRealTimers());

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

  it('底层异常只保留固定网络诊断', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`TLS failed ${signedUrl}`));
    const error = await createProviderAssetPreflight(fetchImpl)(signedUrl, 'image').catch(
      (error) => error,
    );
    expect(error.message).toContain('网络、DNS 或 TLS');
    expect(error.message).not.toContain('synthetic-secret');
    expect(error.cause).toBeUndefined();
  });

  it.each(['headers', 'body'] as const)('%s 阶段共用十五秒上限且停止响应体', async (stage) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    if (stage === 'headers') fetchImpl.mockImplementation(() => new Promise(() => undefined));
    else
      fetchImpl.mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-type': 'image/png' },
        }),
      );
    const pending = createProviderAssetPreflight(fetchImpl)(signedUrl, 'image');
    const rejected = expect(pending).rejects.toThrow('访问超过 15 秒');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
  });
});

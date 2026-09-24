/** HTTPS 图片/视频兼容的隔离 TLS 验收；仅连接本机服务器，不调用 Provider 或外网。 */
import { readFile } from 'node:fs/promises';
import { request as requestHttp, type IncomingMessage } from 'node:http';
import { createServer, request as requestHttps, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ProviderJob, RunResult, RunSnapshot } from '@multimodal-canvas/domain';
import { PrismaResultAssetArchiver, ResultUrlUnavailableError } from './result-archiver';

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: vi.fn(() => {
    throw new Error('测试禁止明文 HTTP 请求');
  }),
}));
vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: vi.fn(() => {
    throw new Error('测试禁止未隔离的 HTTPS 请求');
  }),
}));

/** 临时生成、无生产用途的合成私钥，仅用于本机 TLS 测试。 */
const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUqGG5jN+8HPXnVGT
/J2ptTDm+13N03L/BEth3b9VWoqhRANCAAQ6AvjS6X6oL9v+T0HwpF1XqrnrVDCR
UZT65hPe17WHE7a1jEqBwoSVnGsu1lT9gGKClGB5pR4uvSdZykdHuZn/
-----END PRIVATE KEY-----`;
/** 仅请求级信任的合成 cdn.example 证书，不修改全局 CA 或证书校验。 */
const testCertificate = `-----BEGIN CERTIFICATE-----
MIIBajCCAQ+gAwIBAgIUQEM5LibXjuJFubi0/45maacHdhkwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLY2RuLmV4YW1wbGUwIBcNMjYwOTI0MTAzMzQ3WhgPMjEyNjA4
MzExMDMzNDdaMBYxFDASBgNVBAMMC2Nkbi5leGFtcGxlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEOgL40ul+qC/b/k9B8KRdV6q561QwkVGU+uYT3te1hxO2tYxK
gcKElZxrLtZU/YBigpRgeaUeLr0nWcpHR7mZ/6M5MDcwFgYDVR0RBA8wDYILY2Ru
LmV4YW1wbGUwHQYDVR0OBBYEFOwJssPiJ8RXDCh41E1jmheH24RnMAoGCCqGSM49
BAMCA0kAMEYCIQCjHOyMDgUIBV87C21WmXPx0U39EeM68s8w66pKAsjBYAIhAPS1
NJ9VpA58HIVanAhtJk07bPLjfiwyYQ3z4P5I+RhZ
-----END CERTIFICATE-----`;
/** 小型 PNG 内容，归档字节必须与真实 TLS 响应一致。 */
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=',
  'base64',
);
/** 仓库已有的演示 MP4；真实视频经 TLS 完整读取，避免把合成文本当作视频验收。 */
const video = await readFile(new URL('../../web/public/demo/field-study.mp4', import.meta.url));

/** 合成归档身份，无真实用户或 Provider 任务。 */
const snapshot: RunSnapshot = {
  projectId: '123e4567-e89b-12d3-a456-426614174000',
  canvasRevision: 1,
  targetNodeId: 'node_image',
  modelAlias: 'synthetic-test',
  parameters: {},
  submittedAt: '2026-09-24T00:00:00.000Z',
  nodes: [],
  edges: [],
  inputs: [],
};
/** 本机测试的图片结果，不进行生成。 */
const result: RunResult = {
  provider: 'newapi',
  summary: 'synthetic',
  targetNodeId: 'node_image',
  mediaType: 'image',
  inputCount: 0,
};
/** 仅用于归档元数据的合成任务。 */
const providerJob: ProviderJob = {
  id: 'synthetic-tls-test',
  provider: 'newapi',
  status: 'running',
  progress: 80,
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe.each(['image', 'video'] as const)('HTTP %s 兼容的真实 TLS 下载', (mediaType) => {
  /** 响应字节与 MIME 一致，输入 URL 仅改变协议，保留编码路径与完整签名查询。 */
  const payload = mediaType === 'video' ? video : image;
  /** 下载响应中的真实 MIME。 */
  const mimeType = mediaType === 'video' ? 'video/mp4' : 'image/png';
  /** 包含转义路径、重复键的合成签名地址。 */
  const path = `/a%2Fb/${mediaType === 'video' ? 'video.mp4' : 'image.png'}?signature=synthetic-secret&part=1&part=2`;
  /** 图片保留既有文案，视频使用独立无 URL 文案。 */
  const failureMessage =
    mediaType === 'video'
      ? '上游返回HTTP视频地址且HTTPS安全读取失败'
      : '上游返回HTTP图片地址且HTTPS安全读取失败';
  it.each([
    'success',
    'untrusted-certificate',
    'hostname-mismatch',
    'private-dns',
    'dns-rebinding',
    'redirect',
    'timeout',
    401,
    403,
    404,
    410,
  ] as const)('%s：保留 DNS/socket/TLS 校验且绝不回退明文或访问外网', async (mode) => {
    const received: Array<{ host?: string; path?: string }> = [];
    const server = createServer({ key: testKey, cert: testCertificate }, (request, response) => {
      received.push({ host: request.headers.host, path: request.url });
      if (mode === 'redirect') {
        response.writeHead(302, {
          location: 'http://127.0.0.1/private?signature=synthetic-secret',
        });
        response.end();
        return;
      }
      if (typeof mode === 'number') {
        response.writeHead(mode, { 'content-type': 'text/html' });
        response.end('synthetic upstream failure with signed URL: ' + path);
        return;
      }
      response.writeHead(200, { 'content-type': mimeType, 'content-length': payload.byteLength });
      if (mode === 'timeout') {
        response.flushHeaders();
        return;
      }
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('本机 TLS 服务未绑定');
    const actualHttps = await vi.importActual<typeof import('node:https')>('node:https');
    const socketLookup = vi.fn();
    const tlsErrors: string[] = [];
    const authorizedResponses: boolean[] = [];
    vi.mocked(requestHttps).mockImplementation(((
      url: URL,
      options: RequestOptions,
      listener?: (response: IncomingMessage) => void,
    ) => {
      expect(url.protocol).toBe('https:');
      expect(url.port).toBe('');
      expect(url.pathname + url.search).toBe(path);
      expect(options.lookup).toBeTypeOf('function');
      expect(options.rejectUnauthorized).not.toBe(false);
      const productionLookup = options.lookup!;
      const request = actualHttps.request(
        url,
        {
          ...options,
          // 先执行生产 socket lookup 的全部地址校验，再将通过的测试地址映射到本机。
          port: address.port,
          headers: { ...options.headers, host: url.host },
          agent: false,
          ca: mode === 'untrusted-certificate' ? undefined : testCertificate,
          rejectUnauthorized: true,
          lookup(hostname, lookupOptions, callback) {
            socketLookup(hostname);
            productionLookup(hostname, lookupOptions, (error, _address, _family) => {
              if (error) {
                callback(error, '', 0);
                return;
              }
              if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
              else callback(null, '127.0.0.1', 4);
            });
          },
        },
        (response) => {
          const socket = response.socket as TLSSocket;
          authorizedResponses.push(socket.authorized);
          expect(socket.remoteAddress).toBe('127.0.0.1');
          listener?.(response);
        },
      );
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code) tlsErrors.push(error.code);
      });
      return request;
    }) as typeof requestHttps);
    const lookupHost = vi
      .fn()
      .mockResolvedValueOnce([
        { address: mode === 'private-dns' ? '10.0.0.1' : '203.0.113.1', family: 4 },
      ])
      .mockResolvedValue([
        { address: mode === 'dns-rebinding' ? '127.0.0.1' : '203.0.113.1', family: 4 },
      ]);
    const put = vi.fn(async (_key: string, _content: Buffer, _type?: string) => undefined);
    const create = vi.fn(async () => undefined);
    const transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback({
        asset: { create },
        assetVersion: { create },
      }),
    );
    const archiver = new PrismaResultAssetArchiver(
      { $transaction: transaction } as unknown as PrismaClient,
      {
        blobStore: { put, delete: vi.fn() },
        allowHttp: false,
        strictDns: true,
        lookupHost,
        fetchTimeoutMs: mode === 'timeout' ? 1000 : 2000,
      },
    );
    try {
      const hostname = mode === 'hostname-mismatch' ? 'wrong.example' : 'cdn.example';
      const pending = archiver.archive({
        runId: 'synthetic-tls',
        snapshot,
        result: { ...result, mediaType },
        providerJob,
        archiveInput: {
          mediaType,
          mimeType,
          contentUrl: 'http://' + hostname + ':80' + path,
        },
      });
      if (mode === 'success') {
        await expect(pending).resolves.toMatchObject({ mimeType, sizeBytes: payload.byteLength });
        expect(put).toHaveBeenCalledOnce();
        expect(put.mock.calls[0][0]).toEqual(expect.any(String));
        expect(put.mock.calls[0][1].equals(payload)).toBe(true);
        expect(put.mock.calls[0][2]).toBe(mimeType);
        expect(transaction).toHaveBeenCalledOnce();
        expect(received).toEqual([
          {
            host: 'cdn.example',
            path,
          },
        ]);
      } else {
        if (typeof mode === 'number' && mediaType === 'video') {
          await expect(pending).rejects.toBeInstanceOf(ResultUrlUnavailableError);
          await expect(pending).rejects.toMatchObject({
            status: mode,
            message: '上游视频结果地址已失效或不可访问',
          });
        } else {
          await expect(pending).rejects.toMatchObject({
            name: mode === 'timeout' ? 'AbortError' : 'Error',
            message: failureMessage,
          });
          await expect(pending).rejects.not.toBeInstanceOf(ResultUrlUnavailableError);
        }
        expect(put).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(received).toHaveLength(
          mode === 'redirect' || mode === 'timeout' || typeof mode === 'number' ? 1 : 0,
        );
      }
      if (mode === 'untrusted-certificate')
        expect(tlsErrors).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
      if (mode === 'hostname-mismatch') expect(tlsErrors).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
      expect(authorizedResponses).toEqual(received.length ? [true] : []);
      expect(lookupHost).toHaveBeenCalledTimes(mode === 'private-dns' ? 1 : 2);
      expect(socketLookup).toHaveBeenCalledTimes(mode === 'private-dns' ? 0 : 1);
      expect(requestHttps).toHaveBeenCalledTimes(mode === 'private-dns' ? 0 : 1);
      expect(requestHttp).not.toHaveBeenCalled();
    } finally {
      vi.mocked(requestHttps).mockImplementation(() => {
        throw new Error('测试禁止未隔离的 HTTPS 请求');
      });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
});

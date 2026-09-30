import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { PrismaClient } from '@prisma/client';
import type { ProviderJob, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { describe, expect, it, vi } from 'vitest';
import { PrismaResultAssetArchiver } from './result-archiver';
import { providerOutputToArchiveInput } from './result-output';

/** 为合成 PNG 数据块计算 CRC-32；不读取现场图片。 */
function pngChunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** 按像素宽高生成完整灰度 PNG，供原字节保真回归使用，不调用图像供应商。 */
function imageBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 构造无引用、无历史结果的新节点快照；请求值与现场一致，但身份和正文均为合成数据。 */
function imageSnapshot(): RunSnapshot {
  return {
    projectId: '123e4567-e89b-12d3-a456-426614174000',
    canvasRevision: 1,
    targetNodeId: 'synthetic-image',
    modelAlias: 'gpt-image-2.5-sunburst',
    parameters: { resolution: '4k', aspectRatio: '16:9' },
    submittedAt: '2026-09-30T00:00:00.000Z',
    nodes: [
      {
        id: 'synthetic-image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Synthetic image',
          prompt: 'Create a synthetic image.',
          mediaType: 'image',
          mode: 'generate',
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

describe.each(['base64', 'url'] as const)('图片原始输出归档（%s）', (kind) => {
  it.each([false, true])(
    '首次及后续请求保持 4K 参数和原始字节（重建 Provider=%s）',
    async (fresh) => {
      const originals = [imageBytes(1672, 941), imageBytes(3840, 2160)];
      const thumbnail = Buffer.from('synthetic-thumbnail');
      const previewUrl = 'https://cdn.example.test/preview.jpg';
      const urls = originals.map((_, index) => `https://cdn.example.test/original-${index}.png`);
      const providerFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        const index = providerFetch.mock.calls.length - 1;
        return new Response(
          JSON.stringify({
            data: [
              {
                ...(kind === 'base64'
                  ? { b64_json: originals[index]!.toString('base64'), url: previewUrl }
                  : { url: urls[index] }),
                preview_url: previewUrl,
                thumbnail_url: previewUrl,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const download = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const index = urls.indexOf(String(url));
        if (index < 0) throw new Error('测试禁止下载预览或访问任何未声明地址');
        return new Response(Uint8Array.from(originals[index]!), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      });
      const createRow = vi.fn(async (_input: unknown) => ({}));
      const prisma = {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({ asset: { create: createRow }, assetVersion: { create: createRow } }),
      } as unknown as PrismaClient;
      const put = vi.fn(async (_key: string, _content: Buffer, _mimeType?: string) => {});
      const metadataExtractor = {
        extract: vi.fn(async ({ content }: { content: Buffer }) => ({
          width: content.readUInt32BE(16),
          height: content.readUInt32BE(20),
        })),
      };
      const archiver = new PrismaResultAssetArchiver(prisma, {
        blobStore: { put, delete: vi.fn(async () => {}) },
        fetchImpl: download,
        allowHttp: false,
        strictDns: false,
        metadataExtractor,
        derivativeGenerator: {
          generate: async () => [{ kind: 'thumbnail', content: thumbnail, mimeType: 'image/jpeg' }],
        },
      });
      let provider = new NewApiProvider({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'synthetic-only-key',
        fetchImpl: providerFetch,
      });
      for (const [index, original] of originals.entries()) {
        if (fresh && index > 0)
          provider = new NewApiProvider({
            baseUrl: 'https://newapi.example.test/v1',
            apiKey: 'synthetic-only-key',
            fetchImpl: providerFetch,
          });
        const snapshot = imageSnapshot();
        const frozen = structuredClone(snapshot);
        const execution = await provider.execute({ snapshot });
        expect(snapshot).toEqual(frozen);
        expect(providerFetch).toHaveBeenCalledTimes(index + 1);
        const [endpoint, request] = providerFetch.mock.calls[index]!;
        expect(endpoint).toBe('https://newapi.example.test/v1/images/generations');
        expect(request?.method).toBe('POST');
        expect(JSON.parse(String(request?.body))).toEqual({
          model: 'gpt-image-2.5-sunburst',
          prompt: 'Create a synthetic image.',
          size: '3840x2160',
          n: 1,
        });
        expect(execution.output.kind).toBe(kind);
        const providerJob: ProviderJob = {
          id: `synthetic-job-${index}`,
          provider: 'newapi',
          status: 'running',
          progress: 100,
          createdAt: snapshot.submittedAt,
          updatedAt: snapshot.submittedAt,
        };
        const archived = await archiver.archive({
          runId: `synthetic-run-${index}`,
          snapshot,
          result: execution.result,
          providerJob,
          archiveInput: providerOutputToArchiveInput(execution.output, 'image'),
        });
        const [contentKey, content] = put.mock.calls[index * 2]!;
        expect(content).toEqual(original);
        expect(archived).toMatchObject({
          contentUrl: `/v1/assets/${archived!.assetId}/versions/1/content`,
          sizeBytes: original.byteLength,
          sha256: createHash('sha256').update(original).digest('hex'),
        });
        expect(put.mock.calls[index * 2 + 1]).toEqual([
          `${contentKey}.derivatives/thumbnail`,
          thumbnail,
          'image/jpeg',
        ]);
        for (const row of createRow.mock.calls.slice(index * 2, index * 2 + 2))
          expect(row[0]).toMatchObject({
            data: {
              contentKey,
              metadata: {
                width: index === 0 ? 1672 : 3840,
                height: index === 0 ? 941 : 2160,
                parameters: { resolution: '4k', aspectRatio: '16:9' },
                derivativeStatus: 'ready',
              },
            },
          });
      }
      expect(download).toHaveBeenCalledTimes(kind === 'url' ? 2 : 0);
      expect(put).toHaveBeenCalledTimes(4);
      expect(createRow).toHaveBeenCalledTimes(4);
    },
  );
});

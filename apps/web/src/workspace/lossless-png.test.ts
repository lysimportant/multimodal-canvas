import { Blob as NodeBlob } from 'node:buffer';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressPngLosslessly } from './lossless-png';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Independent, bit-by-bit CRC implementation for fixture creation and output validation.
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function header(width = 64, height = 64, depth = 8, color = 6, interlace = 0) {
  const result = Buffer.alloc(13);
  result.writeUInt32BE(width);
  result.writeUInt32BE(height, 4);
  result[8] = depth;
  result[9] = color;
  result[12] = interlace;
  return chunk('IHDR', result);
}

function fixture(
  options: {
    raw?: Buffer;
    ihdr?: Buffer;
    before?: Buffer[];
    after?: Buffer[];
    level?: number;
  } = {},
) {
  const raw = options.raw ?? Buffer.alloc(64 * (64 * 4 + 1));
  const compressed = deflateSync(raw, { level: options.level ?? 0 });
  const middle = Math.floor(compressed.length / 2);
  return new Blob(
    [
      signature,
      options.ihdr ?? header(),
      ...(options.before ?? []),
      chunk('IDAT', compressed.subarray(0, middle)),
      chunk('IDAT', compressed.subarray(middle)),
      ...(options.after ?? []),
      chunk('IEND'),
    ].map((part) => new Uint8Array(part)),
    { type: 'image/png' },
  );
}

async function readChunks(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(signature);
  const result: { type: string; data: Buffer; bytes: Buffer }[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const entire = bytes.subarray(offset, offset + length + 12);
    expect(entire.readUInt32BE(entire.length - 4)).toBe(crc32(entire.subarray(4, -4)));
    result.push({
      type: entire.toString('ascii', 4, 8),
      data: entire.subarray(8, -4),
      bytes: entire,
    });
    offset += entire.length;
  }
  return result;
}

beforeEach(() => vi.stubGlobal('Blob', NodeBlob));
afterEach(() => vi.unstubAllGlobals());

describe('compressPngLosslessly', () => {
  it('reduces IDAT while preserving decoded bytes and all metadata exactly', async () => {
    const raw = Buffer.alloc(64 * (64 * 4 + 1));
    for (let row = 0; row < 64; row += 1) {
      raw[row * 257] = row % 5;
      raw.fill(row, row * 257 + 1, (row + 1) * 257);
    }
    const original = fixture({
      raw,
      before: [chunk('tEXt', Buffer.from('Author\0Example'))],
      after: [chunk('tEXt', Buffer.from('Comment\0Keep this'))],
    });
    const result = await compressPngLosslessly(original);
    expect(result.improved).toBe(true);
    expect(result.originalBytes).toBe(original.size);
    expect(result.compressedBytes).toBe(result.blob.size);
    expect(result.compressedBytes).toBeLessThan(original.size);
    expect(result.blob.type).toBe('image/png');
    const originalChunks = await readChunks(original);
    const outputChunks = await readChunks(result.blob);
    expect(outputChunks.filter((item) => item.type !== 'IDAT')).toEqual(
      originalChunks.filter((item) => item.type !== 'IDAT'),
    );
    expect(
      inflateSync(
        Buffer.concat(outputChunks.filter((item) => item.type === 'IDAT').map((item) => item.data)),
      ),
    ).toEqual(raw);
  });

  it('returns the original Blob when another pass cannot reduce size', async () => {
    const first = await compressPngLosslessly(fixture());
    const second = await compressPngLosslessly(first.blob);
    expect(second).toEqual({
      blob: first.blob,
      originalBytes: first.blob.size,
      compressedBytes: first.blob.size,
      improved: false,
    });
    expect(second.blob).toBe(first.blob);
  });

  it('handles packed palette samples and Adam7 scanline lengths without changing data', async () => {
    // 1x1 Adam7 has only the first pass; one filter and one packed sample byte.
    const original = fixture({
      ihdr: header(1, 1, 1, 3, 1),
      raw: Buffer.from([0, 0x80]),
      before: [
        chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
        chunk('tRNS', Buffer.from([255, 0])),
      ],
    });
    const result = await compressPngLosslessly(original);
    const chunks = await readChunks(result.blob);
    expect(
      inflateSync(
        Buffer.concat(chunks.filter((item) => item.type === 'IDAT').map((item) => item.data)),
      ),
    ).toEqual(Buffer.from([0, 0x80]));
  });

  it('rejects corrupt CRC and truncated or trailing input', async () => {
    const bytes = Buffer.from(await fixture().arrayBuffer());
    const corrupt = Buffer.from(bytes);
    corrupt[30] ^= 1;
    for (const source of [
      corrupt,
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.from('not png'),
    ]) {
      await expect(compressPngLosslessly(new Blob([source]))).rejects.toThrow('PNG');
    }
  });

  it.each(['acTL', 'fcTL', 'fdAT'])('rejects animation chunk %s', async (type) => {
    await expect(compressPngLosslessly(fixture({ before: [chunk(type)] }))).rejects.toThrow(
      '动画 PNG',
    );
  });

  it('rejects invalid critical structure and palette order', async () => {
    const cases = [
      fixture({ before: [header()] }),
      fixture({ before: [chunk('ABCD')] }),
      fixture({ ihdr: header(64, 64, 8, 3) }),
      fixture({
        before: [chunk('PLTE', Buffer.from([0, 0, 0])), chunk('PLTE', Buffer.from([0, 0, 0]))],
      }),
      fixture({ after: [chunk('tEXt'), chunk('IDAT')] }),
      fixture({ ihdr: header(64, 64, 4, 6) }),
    ];
    for (const source of cases) await expect(compressPngLosslessly(source)).rejects.toThrow('PNG');
  });

  it('rejects incorrect decoded length, invalid scanline filters and invalid zlib', async () => {
    for (const raw of [Buffer.alloc(1), Buffer.alloc(64 * 257 + 1), Buffer.alloc(64 * 257, 5)]) {
      await expect(compressPngLosslessly(fixture({ raw }))).rejects.toThrow('PNG');
    }
    await expect(
      compressPngLosslessly(
        new Blob([signature, header(), chunk('IDAT', Buffer.from('invalid zlib')), chunk('IEND')]),
      ),
    ).rejects.toThrow();
  });

  it('rejects oversize input and IHDR expansion before decompression', async () => {
    await expect(
      compressPngLosslessly(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)])),
    ).rejects.toThrow('32 MiB');
    const decompress = vi.fn();
    vi.stubGlobal('DecompressionStream', decompress);
    await expect(compressPngLosslessly(fixture({ ihdr: header(100000, 100000) }))).rejects.toThrow(
      '128 MiB',
    );
    expect(decompress).not.toHaveBeenCalled();
  });

  it('rejects browsers without compression streams', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    await expect(compressPngLosslessly(fixture())).rejects.toThrow('浏览器不支持');
  });

  it('bounds chunk count to avoid excessive allocation from tiny chunks', async () => {
    const emptyText = chunk('tEXt');
    await expect(
      compressPngLosslessly(fixture({ before: Array.from({ length: 65536 }, () => emptyText) })),
    ).rejects.toThrow('数据块数量过多');
  });

  it('supports cancellation before work and during stream processing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(compressPngLosslessly(fixture(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const activeController = new AbortController();
    const OriginalDecompressionStream = DecompressionStream;
    vi.stubGlobal(
      'DecompressionStream',
      class {
        constructor(format: CompressionFormat) {
          queueMicrotask(() => activeController.abort());
          return new OriginalDecompressionStream(format);
        }
      },
    );
    await expect(compressPngLosslessly(fixture(), activeController.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

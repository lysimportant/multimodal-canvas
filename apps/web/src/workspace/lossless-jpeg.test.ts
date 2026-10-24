import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressJpegLosslessly } from './lossless-jpeg';

const soi = Buffer.from([0xff, 0xd8]);
const eoi = Buffer.from([0xff, 0xd9]);
function segment(marker: number, data: number[] | Buffer, fill = 0) {
  const payload = Buffer.from(data);
  const result = Buffer.alloc(4 + payload.length + fill, 0xff);
  result[fill + 1] = marker;
  result.writeUInt16BE(payload.length + 2, fill + 2);
  payload.copy(result, fill + 4);
  return result;
}
function quantization(value = 1) {
  return segment(0xdb, [0, ...Array<number>(64).fill(value)]);
}
function huffman(kind: number, symbol = 0) {
  return segment(0xc4, [kind << 4, 1, ...Array<number>(15).fill(0), symbol]);
}
function frame(marker = 0xc0, ids = [1], width = 8) {
  return segment(marker, [
    8,
    0,
    8,
    width >>> 8,
    width & 255,
    ids.length,
    ...ids.flatMap((id) => [id, 0x11, 0]),
  ]);
}
function scan(ids = [1], spectralStart = 0, spectralEnd = 63, approximation = 0, entropy = [0x3f]) {
  return Buffer.concat([
    segment(0xda, [
      ids.length,
      ...ids.flatMap((id) => [id, 0]),
      spectralStart,
      spectralEnd,
      approximation,
    ]),
    Buffer.from(entropy),
  ]);
}
function blob(parts: Buffer[]) {
  return new Blob(
    parts.map((part) => new Uint8Array(part)),
    { type: 'image/jpeg' },
  );
}
function jpeg(extra: Buffer[] = []) {
  return blob([soi, quantization(), huffman(0), huffman(1), frame(), ...extra, scan(), eoi]);
}

// Independent walker records the effective table state at every scan and all metadata.
async function snapshot(input: Blob) {
  const bytes = Buffer.from(await input.arrayBuffer());
  const tables = new Map<string, Buffer>();
  const metadata: Buffer[] = [];
  const scans: { header: Buffer; entropy: Buffer; tables: [string, Buffer][] }[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    const data = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)
      metadata.push(Buffer.concat([Buffer.from([marker]), data]));
    if (marker === 0xdb || marker === 0xc4) {
      let index = 0;
      while (index < data.length) {
        const start = index;
        const selector = data[index++]!;
        if (marker === 0xdb) index += 64 * ((selector >>> 4) + 1);
        else {
          const symbols = [...data.subarray(index, index + 16)].reduce(
            (sum, count) => sum + count,
            0,
          );
          index += 16 + symbols;
        }
        tables.set(
          `${marker}:${marker === 0xdb ? selector & 15 : selector}`,
          Buffer.from(data.subarray(start, index)),
        );
      }
    }
    if (marker === 0xda) {
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let codeOffset = offset + 1;
        while (bytes[codeOffset] === 0xff) codeOffset += 1;
        const code = bytes[codeOffset]!;
        if (code === 0 || (code >= 0xd0 && code <= 0xd7)) offset = codeOffset + 1;
        else break;
      }
      scans.push({
        header: Buffer.from(data),
        entropy: bytes.subarray(start, offset),
        tables: [...tables.entries()].sort(([left], [right]) => left.localeCompare(right)),
      });
    }
  }
  return { metadata, scans };
}

beforeEach(() => vi.stubGlobal('Blob', NodeBlob));
afterEach(() => vi.unstubAllGlobals());

describe('compressJpegLosslessly', () => {
  it('removes repeated tables and marker fill, retaining EXIF, ICC, COM and entropy', async () => {
    const input = jpeg([
      segment(0xe1, Buffer.from('Exif\0\0orientation fixture'), 3),
      segment(0xe2, Buffer.from('ICC_PROFILE\0profile fixture')),
      segment(0xfe, Buffer.from('keep comment')),
      quantization(),
      huffman(0),
      huffman(1),
    ]);
    const result = await compressJpegLosslessly(input);
    expect(result.improved).toBe(true);
    expect(result.originalBytes).toBe(input.size);
    expect(result.compressedBytes).toBe(result.blob.size);
    expect(result.compressedBytes).toBeLessThan(input.size);
    expect(result.blob.type).toBe('image/jpeg');
    expect(await snapshot(result.blob)).toEqual(await snapshot(input));
  });

  it('returns the original Blob for a normal JPEG with no redundant bytes', async () => {
    const input = jpeg();
    const result = await compressJpegLosslessly(input);
    expect(result).toEqual({
      blob: input,
      originalBytes: input.size,
      compressedBytes: input.size,
      improved: false,
    });
    expect(result.blob).toBe(input);
  });

  it('rejects MPF/MPO indexes whose absolute file offsets would become invalid', async () => {
    await expect(
      compressJpegLosslessly(
        jpeg([segment(0xe2, Buffer.from('MPF\0index fixture')), quantization()]),
      ),
    ).rejects.toThrow('MPF/MPO');
  });

  it('preserves sequential multiple scans and table redefinition order', async () => {
    const input = blob([
      soi,
      quantization(),
      huffman(0),
      huffman(1),
      frame(0xc0, [1, 2, 3]),
      scan([1]),
      quantization(2),
      quantization(2),
      scan([2]),
      quantization(1),
      scan([3]),
      eoi,
    ]);
    const result = await compressJpegLosslessly(input);
    expect(result.improved).toBe(true);
    expect(await snapshot(result.blob)).toEqual(await snapshot(input));
  });

  it('preserves progressive scans, refinement and Huffman table changes', async () => {
    const input = blob([
      soi,
      quantization(),
      huffman(0),
      huffman(1),
      frame(0xc2),
      scan([1], 0, 0, 1, [0x7f]),
      huffman(0),
      scan([1], 0, 0, 0x10, [0x7f]),
      huffman(1, 0xf0),
      huffman(1),
      huffman(1),
      scan([1], 1, 63, 0, [0x7f]),
      eoi,
    ]);
    const result = await compressJpegLosslessly(input);
    expect(result.improved).toBe(true);
    expect(await snapshot(result.blob)).toEqual(await snapshot(input));
  });

  it('preserves stuffed entropy bytes and restart marker bytes including fill', async () => {
    const input = blob([
      soi,
      quantization(),
      huffman(0),
      huffman(1),
      frame(0xc0, [1], 16),
      segment(0xdd, [0, 1]),
      quantization(),
      scan([1], 0, 63, 0, [0x3f, 0xff, 0xff, 0xd0, 0x3f, 0xff, 0]),
      eoi,
    ]);
    const result = await compressJpegLosslessly(input);
    expect(await snapshot(result.blob)).toEqual(await snapshot(input));
  });

  it('does not discard a partly redundant multi-table segment', async () => {
    const input = jpeg([
      segment(0xdb, [0, ...Array<number>(64).fill(1), 1, ...Array<number>(64).fill(2)]),
    ]);
    const result = await compressJpegLosslessly(input);
    expect(result.improved).toBe(false);
    expect(await snapshot(result.blob)).toEqual(await snapshot(input));
  });

  it('rejects missing frame, scans, tables, EOI, trailing bytes and invalid lengths', async () => {
    const bytes = Buffer.from(await jpeg().arrayBuffer());
    const cases = [
      Buffer.from('arbitrary bytes'),
      Buffer.concat([soi, eoi]),
      bytes.subarray(0, -1),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.concat([soi, frame(), scan(), eoi]),
      Buffer.concat([soi, segment(0xe1, []), eoi]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1, 0xff, 0xd9]),
    ];
    for (const data of cases) await expect(compressJpegLosslessly(blob([data]))).rejects.toThrow();
  });

  it('rejects invalid quantization/Huffman tables and unsupported arithmetic coding', async () => {
    for (const extra of [
      quantization(0),
      segment(0xc4, [0, 2, ...Array<number>(15).fill(0), 0, 1]),
      segment(0xc4, [0, 1, ...Array<number>(15).fill(0)]),
      frame(0xc9),
    ]) {
      await expect(compressJpegLosslessly(jpeg([extra]))).rejects.toThrow();
    }
  });

  it('rejects invalid progressive transitions, missing entropy and misplaced restart markers', async () => {
    const common = [soi, quantization(), huffman(0), huffman(1)];
    for (const parts of [
      [frame(0xc2), scan([1], 1, 63, 0)],
      [frame(0xc2), scan([1], 0, 0, 0x10)],
      [frame(0xc0), scan([1], 0, 63, 0, [])],
      [frame(0xc0), scan([1], 0, 63, 0, [0x3f, 0xff, 0xd0, 0x3f])],
      [frame(0xc0), segment(0xdd, [0, 1]), scan([1], 0, 63, 0, [0x3f, 0xff, 0xd1, 0x3f])],
    ])
      await expect(compressJpegLosslessly(blob([...common, ...parts, eoi]))).rejects.toThrow();
  });

  it('limits input size and supports cancellation before and after reading', async () => {
    await expect(
      compressJpegLosslessly(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)])),
    ).rejects.toThrow('32 MiB');
    const controller = new AbortController();
    controller.abort();
    await expect(compressJpegLosslessly(jpeg(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const active = new AbortController();
    const input = jpeg();
    const originalRead = input.arrayBuffer.bind(input);
    vi.spyOn(input, 'arrayBuffer').mockImplementation(async () => {
      const result = await originalRead();
      active.abort();
      return result;
    });
    await expect(compressJpegLosslessly(input, active.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

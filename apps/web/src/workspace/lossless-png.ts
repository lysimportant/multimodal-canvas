const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type Chunk = { type: string; bytes: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> };
type Pass = { rows: number; rowBytes: number };

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消压缩', 'AbortError');
}

function invalid(): never {
  throw new Error('PNG 文件损坏或结构不受支持');
}

function imagePasses(header: Uint8Array): Pass[] {
  if (header.length !== 13) invalid();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = header[8]!;
  const color = header[9]!;
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !width ||
    !height ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !depths[color]?.includes(depth) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    header[12]! > 1
  )
    invalid();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const layouts =
    header[12] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const passes: Pass[] = [];
  let expectedBytes = 0;
  for (const [x, y, dx, dy] of layouts) {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!));
    const rows = Math.max(0, Math.ceil((height - y!) / dy!));
    if (!columns || !rows) continue;
    const rowBytes = Math.ceil((columns * channels[color]! * depth) / 8);
    expectedBytes += (rowBytes + 1) * rows;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_DECODED_BYTES) {
      throw new Error('PNG 解压后超过 128 MiB，无法在浏览器中安全压缩');
    }
    passes.push({ rows, rowBytes });
  }
  return passes;
}

function parsePng(bytes: Uint8Array<ArrayBuffer>): { chunks: Chunk[]; passes: Pass[] } {
  if (!SIGNATURE.every((value, index) => bytes[index] === value)) invalid();
  const chunks: Chunk[] = [];
  let offset = SIGNATURE.length;
  let seenIdat = false;
  let endedIdat = false;
  let paletteEntries = 0;
  let seenTransparency = false;
  let passes: Pass[] = [];
  let color = -1;
  let depth = 0;
  while (offset < bytes.length) {
    if (chunks.length >= 65536) throw new Error('PNG 数据块数量过多，暂不支持压缩');
    if (bytes.length - offset < 12) invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const length = view.getUint32(0);
    if (length > 0x7fffffff || length + 12 > bytes.length - offset) invalid();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (
      !typeBytes.every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) ||
      (typeBytes[2]! & 32) !== 0
    )
      invalid();
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(8 + length))
      invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('暂不支持动画 PNG 无损压缩');
    if (!chunks.length && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (chunks.length) invalid();
      passes = imagePasses(data);
      depth = data[8]!;
      color = data[9]!;
    } else if (type === 'PLTE') {
      if (
        paletteEntries ||
        seenIdat ||
        seenTransparency ||
        color === 0 ||
        color === 4 ||
        !length ||
        length % 3 ||
        length > 768 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        invalid();
      paletteEntries = length / 3;
    } else if (type === 'tRNS') {
      if (
        seenTransparency ||
        seenIdat ||
        color === 4 ||
        color === 6 ||
        (color === 0 && length !== 2) ||
        (color === 2 && length !== 6) ||
        (color === 3 && (!paletteEntries || !length || length > paletteEntries))
      )
        invalid();
      seenTransparency = true;
    } else if (type === 'IDAT') {
      if (endedIdat || (color === 3 && !paletteEntries)) invalid();
      seenIdat = true;
    } else if (type === 'IEND') {
      if (length || !seenIdat || offset + 12 !== bytes.length) invalid();
    } else if ((typeBytes[0]! & 32) === 0) invalid();
    if (seenIdat && type !== 'IDAT') endedIdat = true;
    chunks.push({ type, data, bytes: bytes.subarray(offset, offset + length + 12) });
    offset += length + 12;
  }
  if (chunks.at(-1)?.type !== 'IEND') invalid();
  return { chunks, passes };
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    while (true) {
      const result = await reader.read();
      checkAbort(signal);
      if (result.done) break;
      length += result.value.length;
      if (length > limit) throw new Error('PNG 数据长度超过预期限制');
      parts.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    checkAbort(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function idatChunk(data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set([73, 68, 65, 84], 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}

/** Re-encode only the zlib stream: pixels, filters and ancillary chunks stay intact. */
export async function compressPngLosslessly(
  blob: Blob,
  signal?: AbortSignal,
): Promise<{
  blob: Blob;
  originalBytes: number;
  compressedBytes: number;
  improved: boolean;
}> {
  checkAbort(signal);
  if (blob.size > MAX_INPUT_BYTES) throw new Error('PNG 文件超过 32 MiB，暂不支持压缩');
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持无损压缩，请使用新版浏览器');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkAbort(signal);
  const { chunks, passes } = parsePng(bytes);
  const expectedBytes = passes.reduce((sum, pass) => sum + pass.rows * (pass.rowBytes + 1), 0);
  const source = new Blob(
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
  );
  const decoded = await collect(
    source.stream().pipeThrough(new DecompressionStream('deflate')),
    expectedBytes,
    signal,
  );
  if (decoded.length !== expectedBytes) invalid();
  let offset = 0;
  for (const pass of passes) {
    for (let row = 0; row < pass.rows; row += 1) {
      if (decoded[offset]! > 4) invalid();
      offset += pass.rowBytes + 1;
    }
  }
  checkAbort(signal);
  const compressed = await collect(
    new Blob([decoded]).stream().pipeThrough(new CompressionStream('deflate')),
    MAX_DECODED_BYTES + 1024 * 1024,
    signal,
  );
  const parts: BlobPart[] = [SIGNATURE];
  let wroteIdat = false;
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      if (!wroteIdat) parts.push(idatChunk(compressed));
      wroteIdat = true;
    } else parts.push(chunk.bytes);
  }
  checkAbort(signal);
  const candidate = new Blob(parts, { type: 'image/png' });
  const improved = candidate.size < blob.size;
  const result = improved ? candidate : blob;
  return { blob: result, originalBytes: blob.size, compressedBytes: result.size, improved };
}

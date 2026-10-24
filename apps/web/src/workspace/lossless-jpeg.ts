const MAX_INPUT_BYTES = 32 * 1024 * 1024;
type Bytes = Uint8Array<ArrayBuffer>;
type Component = { quantization: number; coefficients: number[] };

function invalid(): never {
  throw new Error('JPEG 文件损坏或结构不受支持');
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消压缩', 'AbortError');
}

function equal(left: Bytes | undefined, right: Bytes) {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

function updateTables(marker: number, data: Bytes, tables: Map<string, Bytes>) {
  let offset = 0;
  let redundant = true;
  if (!data.length) invalid();
  while (offset < data.length) {
    const start = offset;
    const selector = data[offset++]!;
    const kind = selector >>> 4;
    const id = selector & 15;
    if (id > 3 || kind > 1) invalid();
    if (marker === 0xdb) {
      const length = 64 * (kind + 1);
      if (offset + length > data.length) invalid();
      for (let index = 0; index < 64; index += 1) {
        const value =
          kind === 0
            ? data[offset + index]!
            : data[offset + index * 2]! * 256 + data[offset + index * 2 + 1]!;
        if (!value) invalid();
      }
      offset += length;
    } else {
      if (offset + 16 > data.length) invalid();
      let symbols = 0;
      let slots = 1;
      for (let index = 0; index < 16; index += 1) {
        const count = data[offset + index]!;
        symbols += count;
        slots = slots * 2 - count;
        // JPEG reserves the all-ones code for entropy padding.
        if (slots <= 0) invalid();
      }
      offset += 16;
      if (!symbols || symbols > (kind === 0 ? 12 : 256) || offset + symbols > data.length)
        invalid();
      const values = data.subarray(offset, offset + symbols);
      if (
        new Set(values).size !== symbols ||
        values.some((value) => (kind === 0 ? value > 11 : (value & 15) > 10))
      )
        invalid();
      offset += symbols;
    }
    const entry = data.subarray(start, offset);
    const key = marker === 0xdb ? `q${id}` : `h${kind}:${id}`;
    if (!equal(tables.get(key), entry)) redundant = false;
    tables.set(key, entry);
  }
  return redundant;
}

/** Preserve entropy bytes and metadata; remove only marker fill and redundant tables. */
export async function compressJpegLosslessly(
  blob: Blob,
  signal?: AbortSignal,
): Promise<{
  blob: Blob;
  originalBytes: number;
  compressedBytes: number;
  improved: boolean;
}> {
  checkAbort(signal);
  if (blob.size > MAX_INPUT_BYTES) throw new Error('JPEG 文件超过 32 MiB，暂不支持压缩');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkAbort(signal);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  const parts: BlobPart[] = [bytes.subarray(0, 2)];
  const tables = new Map<string, Bytes>();
  const components = new Map<number, Component>();
  let frame = -1;
  let scans = 0;
  let segments = 0;
  let restartInterval = 0;
  let ended = false;
  let offset = 2;
  while (offset < bytes.length) {
    checkAbort(signal);
    if (++segments > 65536) throw new Error('JPEG 数据段数量过多，暂不支持压缩');
    if (bytes[offset] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++]!;
    const start = offset - 2;
    if (marker === 0xd9) {
      if (
        !scans ||
        offset !== bytes.length ||
        [...components.values()].some((component) => component.coefficients[0] === -1)
      )
        invalid();
      parts.push(bytes.subarray(start, offset));
      ended = true;
      break;
    }
    if (offset + 2 > bytes.length) invalid();
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) invalid();
    const data = bytes.subarray(offset + 2, offset + length);
    offset += length;
    // MPF entries contain offsets into the original file, so moving segments is unsafe.
    if (
      marker === 0xe2 &&
      data[0] === 0x4d &&
      data[1] === 0x50 &&
      data[2] === 0x46 &&
      data[3] === 0
    ) {
      throw new Error('暂不支持包含 MPF/MPO 多图像索引的 JPEG');
    }
    let omit = false;
    if (marker === 0xdb || marker === 0xc4) {
      omit = updateTables(marker, data, tables);
    } else if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (
        frame !== -1 ||
        scans ||
        data.length < 6 ||
        data[0] !== 8 ||
        !(data[1]! * 256 + data[2]!) ||
        !(data[3]! * 256 + data[4]!)
      )
        invalid();
      const count = data[5]!;
      if (count < 1 || count > 4 || data.length !== 6 + count * 3) invalid();
      let samples = 0;
      for (let index = 0; index < count; index += 1) {
        const id = data[6 + index * 3]!;
        const sampling = data[7 + index * 3]!;
        const horizontal = sampling >>> 4;
        const vertical = sampling & 15;
        const quantization = data[8 + index * 3]!;
        if (
          components.has(id) ||
          horizontal < 1 ||
          horizontal > 4 ||
          vertical < 1 ||
          vertical > 4 ||
          quantization > 3
        )
          invalid();
        samples += horizontal * vertical;
        components.set(id, { quantization, coefficients: Array.from({ length: 64 }, () => -1) });
      }
      if (samples > 10) invalid();
      frame = marker;
    } else if (marker === 0xdd) {
      if (data.length !== 2) invalid();
      restartInterval = data[0]! * 256 + data[1]!;
    } else if (marker === 0xda) {
      if (frame === -1 || data.length < 6) invalid();
      const count = data[0]!;
      if (!count || count > 4 || data.length !== count * 2 + 4) invalid();
      const spectralStart = data[data.length - 3]!;
      const spectralEnd = data[data.length - 2]!;
      const approximation = data[data.length - 1]!;
      const high = approximation >>> 4;
      const low = approximation & 15;
      if (frame === 0xc2) {
        if (
          spectralStart > spectralEnd ||
          spectralEnd > 63 ||
          (spectralStart === 0 && spectralEnd !== 0) ||
          (spectralStart > 0 && count !== 1) ||
          high > 13 ||
          low > 13 ||
          (high !== 0 && high !== low + 1)
        )
          invalid();
      } else if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) invalid();
      const selected = new Set<number>();
      for (let index = 0; index < count; index += 1) {
        const id = data[1 + index * 2]!;
        const selector = data[2 + index * 2]!;
        const dc = selector >>> 4;
        const ac = selector & 15;
        const component = components.get(id);
        if (!component || selected.has(id) || dc > 3 || ac > 3) invalid();
        selected.add(id);
        const quantization = tables.get(`q${component.quantization}`);
        if (!quantization || (frame === 0xc0 && quantization[0]! >>> 4 !== 0)) invalid();
        if ((frame !== 0xc2 || (spectralStart === 0 && high === 0)) && !tables.has(`h0:${dc}`))
          invalid();
        if ((frame !== 0xc2 || spectralStart > 0) && !tables.has(`h1:${ac}`)) invalid();
        if (
          frame === 0xc2 &&
          ((spectralStart === 0 && ac !== 0) ||
            (spectralStart > 0 && dc !== 0) ||
            (spectralStart > 0 && component.coefficients[0] === -1))
        )
          invalid();
        for (let coefficient = spectralStart; coefficient <= spectralEnd; coefficient += 1) {
          if (component.coefficients[coefficient] !== (high === 0 ? -1 : high)) invalid();
          component.coefficients[coefficient] = low;
        }
      }
      scans += 1;
      parts.push(bytes.subarray(start, offset));
      const entropyStart = offset;
      let nextRestart = 0;
      let entropyBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        const markerStart = offset;
        while (bytes[offset] === 0xff) offset += 1;
        const code = bytes[offset];
        if (code === 0) {
          if (offset !== markerStart + 1) invalid();
          entropyBytes += 1;
          offset += 1;
        } else if (code !== undefined && code >= 0xd0 && code <= 0xd7) {
          if (!restartInterval || !entropyBytes || code !== 0xd0 + nextRestart) invalid();
          nextRestart = (nextRestart + 1) % 8;
          entropyBytes = 0;
          offset += 1;
        } else {
          offset = markerStart;
          break;
        }
      }
      if (!entropyBytes || offset >= bytes.length) invalid();
      parts.push(bytes.subarray(entropyStart, offset));
      continue;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      throw new Error('暂不支持该 JPEG 编码类型或数据段');
    }
    if (!omit) parts.push(bytes.subarray(start, offset));
  }
  if (!ended) invalid();
  checkAbort(signal);
  const candidate = new Blob(parts, { type: 'image/jpeg' });
  const improved = candidate.size < blob.size;
  const result = improved ? candidate : blob;
  return { blob: result, originalBytes: blob.size, compressedBytes: result.size, improved };
}

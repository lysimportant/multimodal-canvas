import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

import type { MediaType } from '@multimodal-canvas/domain';

const execFile = promisify(execFileCallback);

export type MediaProbeInput = {
  content: Buffer;
  mimeType: string;
  mediaType: MediaType;
};

export type MediaProbeMetadata = Record<string, unknown>;

export interface MediaMetadataExtractor {
  extract(input: MediaProbeInput): Promise<MediaProbeMetadata>;
}

export type MediaDerivativeKind = 'thumbnail' | 'poster' | 'waveform';

export type MediaDerivative = {
  kind: MediaDerivativeKind;
  mimeType: string;
  content: Buffer;
};

export interface MediaDerivativeGenerator {
  generate(input: MediaProbeInput): Promise<MediaDerivative[]>;
}

/** No-op default keeps uploads usable when ffmpeg is not installed. */
export class NoopMediaDerivativeGenerator implements MediaDerivativeGenerator {
  async generate(_input: MediaProbeInput): Promise<MediaDerivative[]> {
    return [];
  }
}

/** No-op default keeps uploads usable when the optional media toolchain is absent. */
export class NoopMediaMetadataExtractor implements MediaMetadataExtractor {
  async extract(_input: MediaProbeInput): Promise<MediaProbeMetadata> {
    return {};
  }
}

type FfprobeResult = {
  format?: {
    format_name?: string;
    duration?: string | number;
    size?: string | number;
  };
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string | number;
  }>;
};

type FfprobeRunner = (binary: string, args: string[], timeoutMs: number) => Promise<string>;

export type FfprobeMediaMetadataExtractorOptions = {
  binary?: string;
  timeoutMs?: number;
  runner?: FfprobeRunner;
};

/** Extracts stable, provider-neutral media metadata using the optional ffprobe binary. */
export class FfprobeMediaMetadataExtractor implements MediaMetadataExtractor {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runner: FfprobeRunner;

  constructor(options: FfprobeMediaMetadataExtractorOptions = {}) {
    this.binary = options.binary ?? process.env.FFPROBE_PATH ?? 'ffprobe';
    this.timeoutMs = validateTimeout(options.timeoutMs ?? 10_000);
    this.runner = options.runner ?? defaultFfprobeRunner;
  }

  async extract(input: MediaProbeInput): Promise<MediaProbeMetadata> {
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-canvas-probe-'));
    const extension = extensionForMime(input.mimeType, input.mediaType);
    const filePath = join(directory, `input${extension}`);
    try {
      await writeFile(filePath, input.content, { flag: 'wx' });
      const stdout = await this.runner(
        this.binary,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-of',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        this.timeoutMs,
      );
      return normalizeFfprobeOutput(JSON.parse(stdout) as FfprobeResult);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

type FfmpegRunner = (binary: string, args: string[], timeoutMs: number) => Promise<Buffer>;

export type FfmpegMediaDerivativeGeneratorOptions = {
  binary?: string;
  timeoutMs?: number;
  runner?: FfmpegRunner;
};

/** Generates provider-neutral previews with the optional ffmpeg binary. */
export class FfmpegMediaDerivativeGenerator implements MediaDerivativeGenerator {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runner: FfmpegRunner;

  constructor(options: FfmpegMediaDerivativeGeneratorOptions = {}) {
    this.binary = options.binary ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.timeoutMs = validateTimeout(options.timeoutMs ?? 30_000);
    const runner = options.runner ?? defaultFfmpegRunner;
    this.runner = async (binary, args, timeoutMs) => {
      const content = await runner(binary, args, timeoutMs);
      if (content.byteLength === 0) throw new Error('media derivative output is empty');
      return content;
    };
  }

  async generate(input: MediaProbeInput): Promise<MediaDerivative[]> {
    if (input.mediaType === 'text') return [];
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-canvas-derivatives-'));
    const extension = extensionForMime(input.mimeType, input.mediaType);
    const sourcePath = join(directory, `input${extension}`);
    try {
      await writeFile(sourcePath, input.content, { flag: 'wx' });
      if (input.mediaType === 'image') {
        return [
          {
            kind: 'thumbnail',
            mimeType: 'image/jpeg',
            content: await this.runner(
              this.binary,
              [
                '-v',
                'error',
                '-nostdin',
                '-protocol_whitelist',
                'file,pipe',
                '-i',
                sourcePath,
                '-vf',
                'scale=640:-2',
                '-frames:v',
                '1',
                '-f',
                'mjpeg',
                'pipe:1',
              ],
              this.timeoutMs,
            ),
          },
        ];
      }
      if (input.mediaType === 'video') {
        return [
          {
            kind: 'poster',
            mimeType: 'image/jpeg',
            content: await this.runner(
              this.binary,
              [
                '-v',
                'error',
                '-nostdin',
                '-protocol_whitelist',
                'file,pipe',
                '-ss',
                '0',
                '-i',
                sourcePath,
                '-vf',
                'scale=640:-2',
                '-frames:v',
                '1',
                '-f',
                'mjpeg',
                'pipe:1',
              ],
              this.timeoutMs,
            ),
          },
        ];
      }
      if (input.mediaType === 'audio') {
        return [
          {
            kind: 'waveform',
            mimeType: 'image/png',
            content: await this.runner(
              this.binary,
              [
                '-v',
                'error',
                '-nostdin',
                '-protocol_whitelist',
                'file,pipe',
                '-i',
                sourcePath,
                '-filter_complex',
                'aformat=channel_layouts=mono,showwavespic=s=640x160:colors=4f8f8b',
                '-frames:v',
                '1',
                '-c:v',
                'png',
                '-f',
                'image2pipe',
                'pipe:1',
              ],
              this.timeoutMs,
            ),
          },
        ];
      }
      return [];
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function normalizeFfprobeOutput(result: FfprobeResult): MediaProbeMetadata {
  const stream =
    result.streams?.find((candidate) => candidate.codec_type === 'video') ?? result.streams?.[0];
  const metadata: MediaProbeMetadata = {};
  const formatName = result.format?.format_name?.trim();
  if (formatName) metadata.format = formatName;
  const duration = finiteNumber(result.format?.duration);
  if (duration !== undefined) metadata.durationSeconds = duration;
  const sizeBytes = finiteNumber(result.format?.size);
  if (sizeBytes !== undefined) metadata.probeSizeBytes = Math.trunc(sizeBytes);
  if (stream?.codec_name) metadata.codec = stream.codec_name;
  if (stream?.width !== undefined && Number.isInteger(stream.width)) metadata.width = stream.width;
  if (stream?.height !== undefined && Number.isInteger(stream.height))
    metadata.height = stream.height;
  const frameRate = parseFrameRate(stream?.r_frame_rate);
  if (frameRate !== undefined) metadata.frameRate = frameRate;
  if (stream?.channels !== undefined && Number.isInteger(stream.channels))
    metadata.channels = stream.channels;
  const sampleRate = finiteNumber(stream?.sample_rate);
  if (sampleRate !== undefined) metadata.sampleRate = Math.trunc(sampleRate);
  return metadata;
}

function defaultFfprobeRunner(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return execFile(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  }).then(
    ({ stdout }) => String(stdout),
    () => {
      throw new Error('media metadata probe failed or timed out');
    },
  );
}

function defaultFfmpegRunner(binary: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error('media derivative generation failed or timed out'));
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

/** 校验子进程超时，单位毫秒；禁止零值、非整数和溢出使超时保护失效。 */
function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error('media timeout must be a positive integer within timer range');
  }
  return value;
}

function finiteNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return undefined;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? Number(rate.toFixed(6)) : undefined;
}

function extensionForMime(mimeType: string, mediaType: MediaType): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (subtype && /^[a-z0-9.+-]+$/.test(subtype)) return `.${subtype.replace(/^x-/, '')}`;
  return mediaType === 'video' ? '.mp4' : mediaType === 'audio' ? '.audio' : '.bin';
}

export { normalizeFfprobeOutput };

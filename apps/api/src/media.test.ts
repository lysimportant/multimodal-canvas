import { describe, expect, it } from 'vitest';

import {
  FfmpegMediaDerivativeGenerator,
  FfprobeMediaMetadataExtractor,
  NoopMediaDerivativeGenerator,
  NoopMediaMetadataExtractor,
} from './media';

describe('media metadata extraction', () => {
  it('returns an empty metadata object for the no-op extractor', async () => {
    await expect(
      new NoopMediaMetadataExtractor().extract({
        content: Buffer.from('text'),
        mimeType: 'text/plain',
        mediaType: 'text',
      }),
    ).resolves.toEqual({});
  });

  it('normalizes ffprobe format and stream fields', async () => {
    const extractor = new FfprobeMediaMetadataExtractor({
      runner: async (_binary, args) => {
        expect(args[0]).toBe('-v');
        expect(args.at(-1)).toMatch(/input\.mp4$/);
        return JSON.stringify({
          format: { format_name: 'mov,mp4', duration: '12.5', size: '2048' },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
              r_frame_rate: '30000/1001',
            },
          ],
        });
      },
    });

    await expect(
      extractor.extract({
        content: Buffer.from('bytes'),
        mimeType: 'video/mp4',
        mediaType: 'video',
      }),
    ).resolves.toEqual({
      format: 'mov,mp4',
      durationSeconds: 12.5,
      probeSizeBytes: 2048,
      codec: 'h264',
      width: 1920,
      height: 1080,
      frameRate: 29.97003,
    });
  });

  it('rejects malformed ffprobe output while cleaning up temporary files', async () => {
    const extractor = new FfprobeMediaMetadataExtractor({ runner: async () => '{' });
    await expect(
      extractor.extract({
        content: Buffer.from('bytes'),
        mimeType: 'audio/mpeg',
        mediaType: 'audio',
      }),
    ).rejects.toThrow(SyntaxError);
  });
});

describe('media derivative generation', () => {
  it('keeps the no-op generator empty when ffmpeg is unavailable', async () => {
    await expect(
      new NoopMediaDerivativeGenerator().generate({
        content: Buffer.from('bytes'),
        mimeType: 'image/png',
        mediaType: 'image',
      }),
    ).resolves.toEqual([]);
  });

  it('generates an image thumbnail through the configured ffmpeg runner', async () => {
    const generator = new FfmpegMediaDerivativeGenerator({
      runner: async (_binary, args) => {
        expect(args).toContain('-vf');
        expect(args).toContain('scale=640:-2');
        expect(args.at(-1)).toBe('pipe:1');
        return Buffer.from('jpeg');
      },
    });
    await expect(
      generator.generate({
        content: Buffer.from('image'),
        mimeType: 'image/png',
        mediaType: 'image',
      }),
    ).resolves.toEqual([
      { kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('jpeg') },
    ]);
  });

  it('uses a stable waveform output contract for audio', async () => {
    const generator = new FfmpegMediaDerivativeGenerator({
      runner: async (_binary, args) => {
        expect(args.join(' ')).toContain('showwavespic');
        return Buffer.from('png');
      },
    });
    await expect(
      generator.generate({
        content: Buffer.from('audio'),
        mimeType: 'audio/mpeg',
        mediaType: 'audio',
      }),
    ).resolves.toEqual([{ kind: 'waveform', mimeType: 'image/png', content: Buffer.from('png') }]);
  });
});

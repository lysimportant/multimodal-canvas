import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';

/** 使用已配置的本地工具合成媒体，不下载素材或调用 Provider。 */
const execFile = promisify(execFileCallback);

describe.skipIf(process.env.MEDIA_REAL_TESTS !== 'true')(
  'real ffmpeg/ffprobe media acceptance',
  () => {
    let directory: string;
    const inputs = new Map<string, Buffer>();
    const generator = new FfmpegMediaDerivativeGenerator();
    const extractor = new FfprobeMediaMetadataExtractor();

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'multimodal-media-acceptance-'));
      for (const [file, source, options] of [
        ['image.png', 'color=c=red:s=80x60', ['-frames:v', '1']],
        ['video.mp4', 'color=c=green:s=80x60:r=10', ['-t', '0.3', '-c:v', 'mpeg4']],
        ['audio.wav', 'sine=frequency=440:sample_rate=8000', ['-t', '0.2']],
      ] as const) {
        await execFile(
          process.env.FFMPEG_PATH ?? 'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-f',
            'lavfi',
            '-i',
            source,
            ...options,
            '-threads',
            '1',
            join(directory, file),
          ],
          { timeout: 10_000 },
        );
        inputs.set(file, await readFile(join(directory, file)));
      }
    });

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('terminates a real media subprocess at its deadline', async () => {
      await expect(
        new FfmpegMediaDerivativeGenerator({ timeoutMs: 1 }).generate({
          content: inputs.get('audio.wav')!,
          mimeType: 'audio/wav',
          mediaType: 'audio',
        }),
      ).rejects.toThrow('failed or timed out');
      await expect(
        new FfprobeMediaMetadataExtractor({ timeoutMs: 1 }).extract({
          content: inputs.get('video.mp4')!,
          mimeType: 'video/mp4',
          mediaType: 'video',
        }),
      ).rejects.toThrow('failed or timed out');
    });

    it('prevents media playlists from making secondary HTTP requests', async () => {
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const input = {
        content: Buffer.from(
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${address.port}/segment.ts?token=synthetic-secret\n#EXT-X-ENDLIST\n`,
        ),
        mimeType: 'video/m3u8',
        mediaType: 'video' as const,
      };
      try {
        await expect(generator.generate(input)).rejects.toThrow(
          'media derivative generation failed',
        );
        await expect(extractor.extract(input)).rejects.toThrow('media metadata probe failed');
        expect(requests).toBe(0);
      } finally {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
    });

    it.each([
      ['image.png', 'image', 'image/png', 'thumbnail', 'mjpeg'],
      ['video.mp4', 'video', 'video/mp4', 'poster', 'mjpeg'],
      ['audio.wav', 'audio', 'audio/wav', 'waveform', 'png'],
    ] as const)(
      'processes %s and verifies actual derivative encoding',
      async (file, mediaType, mimeType, kind, codec) => {
        const content = inputs.get(file)!;
        const metadata = await extractor.extract({ content, mimeType, mediaType });
        if (mediaType === 'audio')
          expect(metadata).toMatchObject({ sampleRate: 8000, channels: 1 });
        else expect(metadata).toMatchObject({ width: 80, height: 60 });
        const derivatives = await generator.generate({ content, mimeType, mediaType });
        expect(derivatives).toHaveLength(1);
        expect(derivatives[0].kind).toBe(kind);
        const derivative = derivatives[0];
        expect(await extractor.extract({ ...derivative, mediaType: 'image' })).toMatchObject({
          codec,
          width: 640,
          height: mediaType === 'audio' ? 160 : 480,
        });
        if (codec === 'png')
          expect(derivative.content.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      },
    );
  },
);

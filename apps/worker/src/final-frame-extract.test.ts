import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';

import { extractLastDecodableFrame } from './final-frame-extract';

describe('extractLastDecodableFrame', () => {
  it('keeps the last successful seek window and does not use a starting poster seek', async () => {
    const windows: string[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = await extractLastDecodableFrame({
      content: Buffer.from('fake-video'),
      mimeType: 'video/mp4',
      binary: 'ffmpeg',
      timeoutMs: 1000,
      runner: async (_binary, args) => {
        const sseof = args[args.indexOf('-sseof') + 1];
        windows.push(sseof);
        if (sseof === '-0.25') throw new Error('too close to damaged tail');
        const output = args.at(-1);
        if (!output || output.startsWith('-')) throw new Error('missing output file');
        await writeFile(output, jpeg);
      },
    });
    expect(windows).toEqual(['-0.25', '-1']);
    expect(result).toMatchObject({ mimeType: 'image/jpeg', seekWindowSeconds: 1 });
    expect(result.content.equals(jpeg)).toBe(true);
    expect(windows.every((value) => value.startsWith('-'))).toBe(true);
  });

  it('fails closed after every seek window without exposing tool stderr', async () => {
    await expect(
      extractLastDecodableFrame({
        content: Buffer.from('fake-video'),
        mimeType: 'video/mp4',
        binary: 'ffmpeg',
        timeoutMs: 1000,
        runner: async () => {
          throw new Error('ffmpeg stderr secret');
        },
      }),
    ).rejects.toThrow('final frame extraction failed or timed out');
  });
});

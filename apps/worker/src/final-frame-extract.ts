import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/** 末帧回溯窗口，单位秒；从短到长扩展。 */
const SEEK_WINDOWS_SECONDS = [0.25, 1, 3] as const;

export type FinalFrameExtractInput = {
  content: Buffer;
  mimeType: string;
  binary: string;
  timeoutMs: number;
  runner?: (binary: string, args: string[], timeoutMs: number) => Promise<void>;
};

export type FinalFrameExtractResult = {
  content: Buffer;
  mimeType: 'image/jpeg';
  seekWindowSeconds: number;
};

/**
 * 从视频字节中提取最后一张可解码 JPEG 帧。
 * 不使用起始 poster；工具缺失或无可解码帧时抛出固定诊断，不暴露 stderr。
 */
export async function extractLastDecodableFrame(
  input: FinalFrameExtractInput,
): Promise<FinalFrameExtractResult> {
  const directory = await mkdtemp(join(tmpdir(), 'multimodal-canvas-final-frame-'));
  const source = join(directory, `input${extensionFor(input.mimeType)}`);
  const output = join(directory, 'last.jpg');
  const runner = input.runner ?? defaultRunner;
  try {
    await writeFile(source, input.content, { flag: 'wx' });
    let lastError: unknown;
    for (const window of SEEK_WINDOWS_SECONDS) {
      try {
        await runner(
          input.binary,
          [
            '-v',
            'error',
            '-nostdin',
            '-protocol_whitelist',
            'file,pipe',
            '-sseof',
            `-${window}`,
            '-i',
            source,
            '-an',
            '-vf',
            'scale=640:-2',
            '-update',
            '1',
            '-q:v',
            '3',
            '-y',
            output,
          ],
          input.timeoutMs,
        );
        const content = await readFile(output);
        if (content.byteLength === 0) throw new Error('empty final frame');
        return { content, mimeType: 'image/jpeg', seekWindowSeconds: window };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('final frame extraction failed');
  } catch {
    throw new Error('final frame extraction failed or timed out');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('quicktime')) return '.mov';
  if (mimeType.includes('ogg')) return '.ogv';
  return '.mp4';
}

async function defaultRunner(binary: string, args: string[], timeoutMs: number): Promise<void> {
  await execFile(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
}

import { renderPromptDocument, type RunSnapshot } from '@multimodal-canvas/domain';
import type { ProviderOutput } from './result-output';

/** 内置 Mock 的可归档本地产物；真实或注入 Provider 缺少 output 时仍必须失败。 */
export function createMockWorkerOutput(snapshot: RunSnapshot): ProviderOutput {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  if (!target) throw new Error('Mock 输出缺少目标节点');
  const label = target.data.label;
  const prompt = target.data.promptDocument
    ? renderPromptDocument(target.data.promptDocument)
    : (target.data.prompt ?? '');
  if (snapshot.reversePrompt)
    return {
      mediaType: 'text',
      kind: 'text',
      mimeType: 'text/plain',
      text: JSON.stringify({
        summary: 'Mock 资源反推摘要',
        prompt: 'Mock 资源描述，仅用于本地功能验收。',
      }),
    };
  if (target.data.mediaType === 'text')
    return {
      mediaType: 'text',
      kind: 'text',
      mimeType: 'text/plain',
      format: 'txt',
      text: `Mock output for ${label}\n${prompt}`,
    };
  if (target.data.mediaType === 'image') {
    const escaped = label.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    const content = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#172033"/><text x="32" y="190" fill="#f8fafc" font-family="sans-serif" font-size="32">Mock · ${escaped}</text></svg>`;
    return {
      mediaType: 'image',
      kind: 'base64',
      base64: Buffer.from(content).toString('base64'),
      mimeType: 'image/svg+xml',
      format: 'svg',
    };
  }
  if (target.data.mediaType === 'audio')
    return {
      mediaType: 'audio',
      kind: 'base64',
      base64: createMockWav().toString('base64'),
      mimeType: 'audio/wav',
      format: 'wav',
    };
  return {
    mediaType: 'video',
    kind: 'base64',
    base64: MOCK_VIDEO_MP4_BASE64,
    mimeType: 'video/mp4',
    format: 'mp4',
  };
}

/** 125ms 单声道 8kHz 静音 PCM，使用真实 WAV 头保证归档媒体可解析。 */
function createMockWav(): Buffer {
  const sampleRate = 8_000;
  const dataSize = (sampleRate / 8) * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** 与内存 Mock 一致的 1 秒 H.264 MP4，既有 FFmpeg 生成夹具，无外部请求。 */
const MOCK_VIDEO_MP4_BASE64 =
  'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAv5tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACAXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAFIbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABCHN0YmwAAAC8c3RzZAAAAAAAAAABAAAArGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEWTGF2YzYwLjMuMTAwIGxpYm8yNjRydAAAAAAAAAAAAAAY//8AAAAyYXZjQwFkAAv/4QAXZ2QAC6wZGpyEAAADAAQAAAMACjwiEagBAARo7jyA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAw1AAAMNQAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjAuMy4xMDAAAABobW9vZgAAABBtZmhkAAAAAAAAAAEAAABQdHJhZwAAABx0ZmhkAAIAOAAAAAEAAEAAAAAAOgEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAABh0cnVuAAAABQAAAAEAAABwAgAAAAAAAEJtZGF0AAAAF2dkAAusGRqchAAAAwAEAAADAAo8IhGoAAAABGjuPIAAAAATZbgABAAAB3/6eB7n500Yldj/8AAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADGgEBAQAAABBtZnJvAAAAAAAAAEM=';

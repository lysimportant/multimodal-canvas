import { renderPromptDocument } from '@multimodal-canvas/domain';
import type { RunResult, RunSnapshot } from '@multimodal-canvas/domain';
import type { MockProviderRequest, ProviderExecution, ProviderUsage } from './index.js';
import WebSocket from 'ws';

/** 讯飞 WebSocket 客户端的最小可测试抽象。 */
export interface XfyunWebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** 创建 WebSocket，并将鉴权头交给 Node 端实现。 */
export type XfyunWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => XfyunWebSocketLike;

/** 讯飞在线 TTS 适配器配置；密钥只从运行时传入，不会持久化。 */
export type XfyunTtsProviderOptions = {
  /** 讯飞控制台 AppID。 */
  appId: string;
  /** APIPassword，作为 x-api-key 请求头发送。 */
  apiPassword: string;
  /** 发音人，默认 xiaoyan。 */
  voice?: string;
  /** WebSocket 地址，默认官方二进制输出地址。 */
  endpoint?: string;
  /** 单次调用超时，单位毫秒。 */
  timeoutMs?: number;
  /** WebSocket 工厂；生产环境应使用支持自定义请求头的实现。 */
  webSocketFactory?: XfyunWebSocketFactory;
};

/** 讯飞 TTS 调用产生的结构化错误。 */
export class XfyunTtsProviderError extends Error {
  /** 讯飞错误码（若服务端返回）。 */
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'XfyunTtsProviderError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const defaultXfyunEndpoint = 'wss://tts-api.xfyun.cn/v2/tts?output_proto=binary';

/**
 * 通过讯飞 WebSocket 在线合成 MP3 音频。
 * 请求只发送一次，收到 status=2 后返回拼接的二进制帧；取消或超时会关闭本地连接。
 */
export class XfyunTtsProvider {
  private readonly options: Required<
    Pick<XfyunTtsProviderOptions, 'voice' | 'endpoint' | 'timeoutMs'>
  > &
    Omit<XfyunTtsProviderOptions, 'voice' | 'endpoint' | 'timeoutMs'>;

  /** 校验运行时配置；不会发起网络请求。 */
  constructor(options: XfyunTtsProviderOptions) {
    if (!options.appId.trim()) throw new TypeError('讯飞 appId 不能为空');
    if (!options.apiPassword.trim()) throw new TypeError('讯飞 apiPassword 不能为空');
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
      throw new TypeError('timeoutMs 必须为正整数');
    this.options = {
      ...options,
      voice: options.voice ?? 'xiaoyan',
      endpoint: options.endpoint ?? defaultXfyunEndpoint,
      timeoutMs,
    };
  }

  /** 执行音频节点，返回标准 base64 音频输出。 */
  async execute({
    snapshot,
    reportProgress,
    signal,
  }: MockProviderRequest & { signal?: AbortSignal }): Promise<
    ProviderExecution<{
      mediaType: 'audio';
      kind: 'base64';
      base64: string;
      mimeType: 'audio/mpeg';
      format: 'mp3';
    }>
  > {
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new XfyunTtsProviderError('run target node is missing from snapshot');
    if (target.data.mediaType !== 'audio')
      throw new XfyunTtsProviderError('XfyunTtsProvider 只能执行音频节点');
    const input = resolveTtsText(
      snapshot,
      target.data.prompt,
      target.data.promptDocument,
      target.data.label,
    );
    if (!input.trim() || [...input].length > 4096)
      throw new XfyunTtsProviderError('讯飞 TTS 文本必须为 1 到 4096 个字符');
    if (signal?.aborted) throw new XfyunTtsProviderError('讯飞 TTS 请求已取消');
    await reportProgress?.(5);
    const bytes = await this.synthesize(input, signal);
    await reportProgress?.(100);
    const output = {
      mediaType: 'audio' as const,
      kind: 'base64' as const,
      base64: bytesToBase64(bytes),
      mimeType: 'audio/mpeg' as const,
      format: 'mp3' as const,
    };
    const result: RunResult = {
      provider: 'xfyun',
      summary: `讯飞 TTS 已完成 ${target.data.label}`,
      targetNodeId: target.id,
      mediaType: 'audio',
      inputCount: snapshot.inputs.length,
    };
    return {
      result,
      output,
      usage: { metadata: { provider: 'xfyun', bytes: bytes.byteLength } } satisfies ProviderUsage,
    };
  }

  private async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(this.options.endpoint, { 'x-api-key': this.options.apiPassword });
    const payload = {
      common: { app_id: this.options.appId, uid: 'multimodal-canvas' },
      business: {
        aue: 'lame',
        sfl: 1,
        auf: 'audio/L16;rate=16000',
        vcn: this.options.voice,
        speed: 50,
        volume: 50,
        pitch: 50,
        tte: 'utf8',
      },
      data: { status: 2, text: encodeBase64Utf8(text) },
    };
    return await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let messageChain = Promise.resolve();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          socket.close();
        } catch {}
        error ? reject(error) : resolve(concatBytes(chunks));
      };
      const onAbort = () => finish(new XfyunTtsProviderError('讯飞 TTS 请求已取消'));
      const timer = setTimeout(
        () => finish(new XfyunTtsProviderError('讯飞 TTS 请求超时')),
        this.options.timeoutMs,
      );
      socket.onopen = () => {
        try {
          socket.send(JSON.stringify(payload));
        } catch (error) {
          finish(
            new XfyunTtsProviderError(error instanceof Error ? error.message : '讯飞 TTS 发送失败'),
          );
        }
      };
      socket.onmessage = (event) => {
        messageChain = messageChain.then(() => handleXfyunMessage(event.data, chunks, finish));
      };
      socket.onerror = () => finish(new XfyunTtsProviderError('讯飞 TTS WebSocket 连接失败'));
      socket.onclose = () => {
        if (!settled) finish(new XfyunTtsProviderError('讯飞 TTS 连接意外关闭'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

/**
 * 从进程环境创建临时讯飞 TTS 适配器。
 *
 * 凭据只在调用期间从环境读取；缺少任一必填变量时立即失败，不会回退
 * 到源码、仓库文件或默认密钥。
 */
export function createXfyunTtsProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): XfyunTtsProvider {
  const appId = environment.XFUN_TTS_APP_ID?.trim();
  const apiPassword = environment.XFUN_TTS_API_PASSWORD?.trim();
  if (!appId) throw new Error('XFUN_TTS_APP_ID 未配置');
  if (!apiPassword) throw new Error('XFUN_TTS_API_PASSWORD 未配置');
  return new XfyunTtsProvider({
    appId,
    apiPassword,
    ...(environment.XFUN_TTS_VOICE?.trim() ? { voice: environment.XFUN_TTS_VOICE.trim() } : {}),
  });
}

function resolveTtsText(
  snapshot: RunSnapshot,
  prompt: string | undefined,
  promptDocument: RunSnapshot['nodes'][number]['data']['promptDocument'],
  label: string,
): string {
  const inputs = [...snapshot.inputs].sort((a, b) => a.sortOrder - b.sortOrder);
  const textInput = inputs.find((input) => input.role === 'prompt' || input.role === 'content');
  if (textInput) {
    const data = textInput.snapshot.data;
    if (data.mediaType !== 'text') throw new XfyunTtsProviderError('讯飞 TTS 输入必须是文本');
    return data.prompt ?? '';
  }
  return promptDocument ? renderPromptDocument(promptDocument) : (prompt ?? label);
}

async function handleXfyunMessage(
  data: unknown,
  chunks: Uint8Array[],
  finish: (error?: Error) => void,
): Promise<void> {
  if (typeof data === 'string') {
    try {
      const body = JSON.parse(data) as {
        code?: number;
        message?: string;
        data?: { audio?: string; status?: number };
      };
      if (body.code && body.code !== 0)
        return finish(new XfyunTtsProviderError(body.message ?? '讯飞 TTS 返回错误', body.code));
      if (body.data?.audio) chunks.push(base64ToBytes(body.data.audio));
      if (body.data?.status === 2) {
        if (chunks.length === 0)
          return finish(new XfyunTtsProviderError('讯飞 TTS 未返回音频数据'));
        finish();
      }
      return;
    } catch {
      return finish(new XfyunTtsProviderError('讯飞 TTS 文本帧格式无效'));
    }
  }
  const bytes = await toUint8Array(data);
  if (bytes) chunks.push(bytes);
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): XfyunWebSocketLike {
  return new WebSocket(url, { headers }) as unknown as XfyunWebSocketLike;
}

async function toUint8Array(value: unknown): Promise<Uint8Array | undefined> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob)
    return new Uint8Array(await value.arrayBuffer());
  return undefined;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

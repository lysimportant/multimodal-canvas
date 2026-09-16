import { renderPromptDocument } from '@multimodal-canvas/domain';
import type { RunResult, RunSnapshot } from '@multimodal-canvas/domain';
import { reportRequestPrompt } from './index.js';
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
  /** 发音人，当前仅开放已取证的 xiaoyan。 */
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

/** 讯飞一次执行只发送一帧合成文本，请求身份固定为 WebSocket 合成路径。 */
const xfyunRequestIdentity = 'WS /v2/tts#1';

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
    if (options.voice !== undefined && options.voice !== 'xiaoyan')
      throw new TypeError('讯飞 TTS 当前仅开放已确认音色：xiaoyan');
    const timeoutMs = options.timeoutMs ?? 900_000;
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
    runId,
    attempt,
    onRequestPrompt,
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
    validateXfyunParameters(snapshot.parameters);
    if (!['xfyun', 'online-tts'].includes(snapshot.modelAlias))
      throw new XfyunTtsProviderError('讯飞 TTS 模型未确认');
    if (snapshot.inputs.length > 1) throw new XfyunTtsProviderError('讯飞 TTS 仅支持一个文本输入');
    if (
      snapshot.promptMentions?.length ||
      target.data.promptDocument?.blocks.some((block) => block.type === 'mention')
    )
      throw new XfyunTtsProviderError('讯飞 TTS 不支持资源提及');
    for (const input of snapshot.inputs) {
      if (input.role !== 'prompt' && input.role !== 'content')
        throw new XfyunTtsProviderError(`讯飞 TTS 不支持输入角色：${input.role}`);
      if (input.snapshot.data.mediaType !== 'text')
        throw new XfyunTtsProviderError('讯飞 TTS 输入必须是文本');
    }
    const input = resolveTtsText(
      snapshot,
      target.data.prompt,
      target.data.promptDocument,
      target.data.label,
    );
    const inputBytes = new TextEncoder().encode(input);
    if (!input.trim() || inputBytes.byteLength >= 8000)
      throw new XfyunTtsProviderError('讯飞 TTS 文本 UTF-8 编码后必须小于 8000 字节');
    if (signal?.aborted) throw new XfyunTtsProviderError('讯飞 TTS 请求已取消');
    await reportProgress?.(5);
    if (signal?.aborted) throw new XfyunTtsProviderError('讯飞 TTS 请求已取消');
    // 记录的是真正写入 data.text 的同一份文本；失败时连 WebSocket 都不建立。
    // 未接线时不增加等待点，保持原有的发送时序。
    if (onRequestPrompt) {
      await reportRequestPrompt({
        snapshot,
        provider: 'xfyun',
        mediaType: 'audio',
        requestIdentity: xfyunRequestIdentity,
        onRequestPrompt,
        runId,
        attempt,
        format: 'plain',
        parts: [{ order: 0, text: input }],
        resources: [],
      });
    }
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
          socket.close(1000);
        } catch {}
        error ? reject(error) : resolve(concatBytes(chunks));
      };
      const onAbort = () => finish(new XfyunTtsProviderError('讯飞 TTS 请求已取消'));
      const timer = setTimeout(
        () => finish(new XfyunTtsProviderError('讯飞 TTS 请求超时')),
        this.options.timeoutMs,
      );
      socket.onopen = () => {
        if (settled) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch (error) {
          finish(
            new XfyunTtsProviderError(error instanceof Error ? error.message : '讯飞 TTS 发送失败'),
          );
        }
      };
      socket.onmessage = (event) => {
        messageChain = messageChain
          .then(() => handleXfyunMessage(event.data, chunks, finish))
          .catch(() => finish(new XfyunTtsProviderError('讯飞 TTS 音频帧格式无效')));
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
 * 校验讯飞临时适配器已取证的参数集合。
 * 未知参数、未取证音色和格式在建立 WebSocket 前失败，避免产生未授权请求。
 */
function validateXfyunParameters(parameters: Record<string, unknown>): void {
  const allowed = new Set(['prompt', 'input', 'voice', 'speed', 'response_format']);
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if (!allowed.has(name)) throw new XfyunTtsProviderError(`讯飞 TTS 不支持参数：${name}`);
    if (name === 'prompt' || name === 'input' || name === 'voice') {
      if (typeof value !== 'string' || !value.trim())
        throw new XfyunTtsProviderError(`讯飞 TTS 参数 ${name} 必须为非空字符串`);
    } else if (name === 'response_format') {
      if (value !== 'mp3') throw new XfyunTtsProviderError('讯飞 TTS 仅支持 mp3 输出');
    } else if (name === 'speed' && value !== 50) {
      throw new XfyunTtsProviderError('讯飞 TTS 当前仅开放已确认语速：50');
    }
  }
  if (parameters.voice !== undefined && parameters.voice !== 'xiaoyan')
    throw new XfyunTtsProviderError('讯飞 TTS 当前仅开放已确认音色：xiaoyan');
  if (
    parameters.prompt !== undefined &&
    parameters.input !== undefined &&
    parameters.prompt !== parameters.input
  )
    throw new XfyunTtsProviderError('讯飞 TTS prompt 与 input 冲突');
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

/** 解析唯一文本来源；参数优先，结构化文档其次，禁止以节点标签代替正文。 */
function resolveTtsText(
  snapshot: RunSnapshot,
  prompt: string | undefined,
  promptDocument: RunSnapshot['nodes'][number]['data']['promptDocument'],
  _label: string,
): string {
  const inputs = [...snapshot.inputs].sort((a, b) => a.sortOrder - b.sortOrder);
  const textInput = inputs.find((input) => input.role === 'prompt' || input.role === 'content');
  if (textInput) {
    if (snapshot.parameters.prompt !== undefined || snapshot.parameters.input !== undefined)
      throw new XfyunTtsProviderError('讯飞 TTS 连线文本与参数文本冲突');
    const data = textInput.snapshot.data;
    if (data.mediaType !== 'text') throw new XfyunTtsProviderError('讯飞 TTS 输入必须是文本');
    if (data.promptDocument?.blocks.some((block) => block.type === 'mention'))
      throw new XfyunTtsProviderError('讯飞 TTS 不支持资源提及');
    return data.promptDocument ? renderPromptDocument(data.promptDocument) : (data.prompt ?? '');
  }
  return (
    ((snapshot.parameters.prompt ?? snapshot.parameters.input) as string | undefined) ??
    (promptDocument ? renderPromptDocument(promptDocument) : (prompt ?? ''))
  );
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

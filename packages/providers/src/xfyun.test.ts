import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import {
  createXfyunTtsProviderFromEnvironment,
  XfyunTtsProvider,
  type XfyunWebSocketLike,
} from './xfyun.js';

function snapshot(prompt = '你好啊'): RunSnapshot {
  return {
    projectId: 'p',
    canvasRevision: 1,
    targetNodeId: 'audio',
    modelAlias: 'xfyun',
    parameters: {},
    submittedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'audio',
        type: 'audio',
        position: { x: 0, y: 0 },
        data: { label: '语音', mediaType: 'audio', mode: 'generate', prompt },
      },
    ],
    edges: [],
    inputs: [],
  };
}

function snapshotWithParameters(parameters: Record<string, unknown>): RunSnapshot {
  return { ...snapshot(), parameters };
}
class MockSocket implements XfyunWebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

describe('XfyunTtsProvider', () => {
  it('creates from explicit runtime environment variables', () => {
    expect(
      createXfyunTtsProviderFromEnvironment({
        XFUN_TTS_APP_ID: 'app',
        XFUN_TTS_API_PASSWORD: 'secret',
        XFUN_TTS_VOICE: 'xiaoyan',
      }),
    ).toBeInstanceOf(XfyunTtsProvider);
    expect(() => createXfyunTtsProviderFromEnvironment({})).toThrow('XFUN_TTS_APP_ID');
    expect(
      () =>
        new XfyunTtsProvider({ appId: 'app', apiPassword: 'secret', voice: 'unconfirmed-voice' }),
    ).toThrow('仅开放已确认音色：xiaoyan');
  });

  it('sends APIPassword header and collects binary audio frames', async () => {
    const socket = new MockSocket();
    const factory = vi.fn(() => socket);
    const promise = new XfyunTtsProvider({
      appId: 'app',
      apiPassword: 'secret',
      webSocketFactory: factory,
    }).execute({ snapshot: snapshot() });
    await Promise.resolve();
    socket.onopen?.();
    const request = JSON.parse(socket.sent[0]);
    expect(factory).toHaveBeenCalledWith(expect.stringContaining('output_proto=binary'), {
      'x-api-key': 'secret',
    });
    expect(request.common.app_id).toBe('app');
    expect(request.data.text).toBe('5L2g5aW95ZWK');
    socket.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
    socket.onmessage?.({ data: JSON.stringify({ code: 0, data: { status: 2 } }) });
    await expect(promise).resolves.toMatchObject({
      output: { kind: 'base64', base64: 'AQID', mimeType: 'audio/mpeg' },
    });
  });
  it('surfaces provider error code and supports cancellation', async () => {
    const socket = new MockSocket();
    const promise = new XfyunTtsProvider({
      appId: 'app',
      apiPassword: 'secret',
      webSocketFactory: () => socket,
    }).execute({ snapshot: snapshot() });
    await Promise.resolve();
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ code: 10105, message: 'bad text' }) });
    await expect(promise).rejects.toMatchObject({ code: 10105 });
    const socket2 = new MockSocket();
    const controller2 = new AbortController();
    const pending = new XfyunTtsProvider({
      appId: 'app',
      apiPassword: 'secret',
      webSocketFactory: () => socket2,
    }).execute({ snapshot: snapshot(), signal: controller2.signal });
    await Promise.resolve();
    socket2.onopen?.();
    controller2.abort();
    await expect(pending).rejects.toThrow('已取消');
  });

  it.each([
    [{ unsupported: true }, '不支持参数：unsupported'],
    [{ voice: 'ais' }, '仅开放已确认音色：xiaoyan'],
    [{ response_format: 'wav' }, '仅支持 mp3 输出'],
    [{ speed: 101 }, '当前仅开放已确认语速：50'],
  ])('rejects unconfirmed parameters before opening WebSocket', async (parameters, message) => {
    const factory = vi.fn(() => new MockSocket());
    await expect(
      new XfyunTtsProvider({
        appId: 'app',
        apiPassword: 'secret',
        webSocketFactory: factory,
      }).execute({ snapshot: snapshotWithParameters(parameters) }),
    ).rejects.toThrow(message);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects non-text input roles before opening WebSocket', async () => {
    const factory = vi.fn(() => new MockSocket());
    const current = snapshotWithParameters({});
    current.inputs.push({
      nodeId: 'image',
      role: 'content',
      sortOrder: 0,
      snapshot: {
        id: 'image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '图片',
          mediaType: 'image',
          mode: 'source',
          contentUrl: 'data:image/png;base64,AA==',
        },
      },
    });
    await expect(
      new XfyunTtsProvider({
        appId: 'app',
        apiPassword: 'secret',
        webSocketFactory: factory,
      }).execute({
        snapshot: current,
      }),
    ).rejects.toThrow('输入必须是文本');
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects text reaching the documented UTF-8 byte limit before opening WebSocket', async () => {
    const factory = vi.fn(() => new MockSocket());
    await expect(
      new XfyunTtsProvider({
        appId: 'app',
        apiPassword: 'secret',
        webSocketFactory: factory,
      }).execute({
        snapshot: snapshot('你'.repeat(2667)),
      }),
    ).rejects.toThrow('UTF-8 编码后必须小于 8000 字节');
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not send after cancellation before the socket opens', async () => {
    const socket = new MockSocket();
    const controller = new AbortController();
    const pending = new XfyunTtsProvider({
      appId: 'app',
      apiPassword: 'secret',
      webSocketFactory: () => socket,
    }).execute({ snapshot: snapshot(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('请求已取消');
    socket.onopen?.();
    expect(socket.sent).toEqual([]);
  });
});

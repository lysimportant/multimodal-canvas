import { describe, expect, it, vi } from 'vitest';
import type { CanvasNode, MediaType, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider, type NewApiVideoContract } from './index.js';

/** 已有文字结果连接到不同生成目标时，目标媒体及冻结合同决定的请求路径。 */
interface RouteCase {
  name: string;
  mediaType: MediaType;
  path: string;
  imageEdit?: boolean;
  videoContract?: NewApiVideoContract;
}

/** 仅枚举已有 Provider 合同，不按模型名称推断或新增端点。 */
const routeCases: RouteCase[] = [
  { name: 'text', mediaType: 'text', path: '/chat/completions' },
  { name: 'image', mediaType: 'image', path: '/images/generations' },
  { name: 'image-edit', mediaType: 'image', path: '/images/edits', imageEdit: true },
  { name: 'audio', mediaType: 'audio', path: '/audio/speech' },
  {
    name: 'video legacy-v1',
    mediaType: 'video',
    path: '/videos/generations',
    videoContract: 'legacy-v1',
  },
  {
    name: 'video newapi-video-v1',
    mediaType: 'video',
    path: '/videos',
    videoContract: 'newapi-video-v1',
  },
  {
    name: 'video newapi-unified-v1',
    mediaType: 'video',
    path: '/video/generations',
    videoContract: 'newapi-unified-v1',
  },
];

/** 模拟已由调用方水合的文字生成结果，不重新执行来源节点。 */
const generatedText = 'A lighthouse above a calm sea.';

/** 合成 PNG 仅供 multipart 序列化，不读取用户资产或下载远端素材。 */
const sourcePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 构造文字来源先于目标的冻结快照，保留来源模型及生成模式作为分派干扰项。
 * @param route 目标媒体、图片原图需求及已确认的视频合同。
 * @returns 包含已水合文字输入的合成快照；图片编辑额外携带本地 PNG。
 */
function connectedSnapshot(route: RouteCase): RunSnapshot {
  const source: CanvasNode = {
    id: 'generated-text',
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      label: 'Existing text result',
      mediaType: 'text',
      mode: 'generate',
      modelAlias: 'synthetic-upstream-text',
      prompt: 'Describe a coastal scene.',
    },
  };
  const modelAlias = `synthetic-${route.mediaType}-target（按次）`;
  const target: CanvasNode = {
    id: 'target',
    type: route.mediaType,
    position: { x: 300, y: 0 },
    data: {
      label: 'Connected target',
      mediaType: route.mediaType,
      mode: 'generate',
      modelAlias,
      ...(route.mediaType === 'video' ? { videoMode: 'text_to_video' as const } : {}),
    },
  };
  const snapshot: RunSnapshot = {
    projectId: 'cross-media-routing',
    canvasRevision: 1,
    targetNodeId: target.id,
    modelAlias,
    parameters: route.mediaType === 'audio' ? { voice: 'alloy' } : {},
    submittedAt: '2026-09-30T00:00:00.000Z',
    nodes: [source, target],
    edges: [],
    inputs: [
      {
        nodeId: source.id,
        role: 'content',
        sortOrder: 0,
        snapshot: { ...source, data: { ...source.data, prompt: generatedText } },
      },
    ],
  };
  if (route.imageEdit) {
    const image: CanvasNode = {
      id: 'source-image',
      type: 'image',
      position: { x: 0, y: 200 },
      data: {
        label: 'Edit source',
        mediaType: 'image',
        mode: 'source',
        contentUrl: `data:image/png;base64,${sourcePng}`,
        mimeType: 'image/png',
      },
    };
    snapshot.nodes.push(image);
    snapshot.inputs.push({
      nodeId: image.id,
      role: 'referenceImage',
      sortOrder: 1,
      snapshot: image,
    });
  }
  return snapshot;
}

/** 构造内存 JSON 响应；状态码仅用于本地成功或拒绝场景。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 注入唯一网络出口；视频仅使用用例明确选择的合同，不探测或切换接口。 */
function providerFor(route: RouteCase, fetchImpl: typeof fetch) {
  const options = {
    baseUrl: 'https://newapi.example/v1',
    apiKey: 'synthetic-routing-test-key',
    fetchImpl,
  };
  return route.mediaType === 'video'
    ? new NewApiVideoProvider({
        ...options,
        videoContract: route.videoContract,
        pollIntervalMs: 0,
        maxPollAttempts: 1,
      })
    : new NewApiProvider(options);
}

/** 按现有媒体合同返回合成结果；视频先受理，后续查询由用例单独提供。 */
function successResponse(route: RouteCase): Response {
  if (route.mediaType === 'text') {
    return jsonResponse({ choices: [{ message: { content: 'Generated text.' } }] });
  }
  if (route.mediaType === 'audio') {
    return new Response(new Uint8Array([0, 1, 2]), {
      headers: { 'content-type': 'audio/mpeg' },
    });
  }
  if (route.mediaType === 'image') {
    return jsonResponse({ data: [{ url: 'https://cdn.example/generated.png' }] });
  }
  return jsonResponse(
    route.videoContract === 'newapi-unified-v1'
      ? { task_id: 'routing-task', status: 'queued' }
      : route.videoContract === 'newapi-video-v1'
        ? { id: 'routing-task', status: 'queued' }
        : { request_id: 'routing-task' },
  );
}

describe('已有文字生成结果的跨媒体路由', () => {
  it.each(routeCases)('$name 按目标而非前置来源节点分派，保留目标模型', async (route) => {
    const snapshot = connectedSnapshot(route);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(successResponse(route));
    if (route.mediaType === 'video') {
      fetchImpl.mockResolvedValueOnce(
        jsonResponse(
          route.videoContract === 'newapi-unified-v1'
            ? {
                task_id: 'routing-task',
                status: 'completed',
                url: 'https://cdn.example/generated.mp4',
                format: 'mp4',
              }
            : {
                id: 'routing-task',
                status: route.videoContract === 'newapi-video-v1' ? 'completed' : 'done',
                video: { url: 'https://cdn.example/generated.mp4' },
              },
        ),
      );
    }

    const request = { snapshot, onProviderJob: vi.fn() };
    const result = await providerFor(route, fetchImpl).execute(request);

    const expectedRequests = [[`https://newapi.example/v1${route.path}`, 'POST']];
    if (route.mediaType === 'video') {
      const jobsPath =
        route.videoContract === 'newapi-unified-v1' ? '/video/generations' : '/videos';
      expectedRequests.push([`https://newapi.example/v1${jobsPath}/routing-task`, 'GET']);
    }
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual(
      expectedRequests,
    );
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    if (route.imageEdit) {
      expect(body).toBeInstanceOf(FormData);
      const form = body as FormData;
      expect(form.get('model')).toBe(snapshot.modelAlias);
      expect(form.get('prompt')).toBe(generatedText);
      expect(form.get('image')).toBeInstanceOf(File);
    } else {
      const payload = JSON.parse(String(body));
      expect(payload.model).toBe(snapshot.modelAlias);
      if (route.mediaType === 'text') {
        expect(payload.messages).toEqual([
          { role: 'user', name: 'canvas_content', content: generatedText },
        ]);
      } else {
        expect(payload[route.mediaType === 'audio' ? 'input' : 'prompt']).toBe(generatedText);
      }
    }
    expect(result.result).toMatchObject({ targetNodeId: 'target', mediaType: route.mediaType });
    expect(result.output.mediaType).toBe(route.mediaType);
  });

  it('文字目标误绑定图片模型时保留 400，不切换 Responses 或重试', async () => {
    const route = routeCases[0]!;
    const snapshot = connectedSnapshot(route);
    snapshot.modelAlias = 'synthetic-image-target（按次）';
    const message = 'This model is not supported on the Chat Completions endpoint';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message, code: 'unsupported_model' } }, 400));

    await expect(providerFor(route, fetchImpl).execute({ snapshot })).rejects.toMatchObject({
      status: 400,
      code: 'unsupported_model',
      retryable: false,
      message: expect.stringContaining(message),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://newapi.example/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).model).toBe(snapshot.modelAlias);
  });
});

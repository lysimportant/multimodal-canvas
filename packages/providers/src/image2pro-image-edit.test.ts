import { describe, expect, it, vi } from 'vitest';
import {
  IMAGE2PRO_IMAGE_EDIT_CONTRACT,
  IMAGE2PRO_IMAGE_TASK_CONTRACT,
  type RunInputSnapshot,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { NewApiProvider } from './index';

const inlinePng = 'data:image/png;base64,c3ludGhldGljLWltYWdl';

function reference(id: string, contentUrl = inlinePng, role = 'referenceImage'): RunInputSnapshot {
  return {
    nodeId: id,
    role,
    sortOrder: 0,
    snapshot: {
      id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: { label: id, mediaType: 'image', mode: 'source', contentUrl, mimeType: 'image/png' },
    },
  } as RunInputSnapshot;
}

function snapshot(
  parameters: Record<string, unknown> = {},
  inputs: RunInputSnapshot[] = [reference('source')],
  modelAlias = 'gpt-image-2.5-flare',
  contract = 'openai-images',
): RunSnapshot {
  return {
    projectId: 'synthetic-project',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias,
    parameters,
    submittedAt: '2026-10-22T00:00:00.000Z',
    nodes: [
      {
        id: 'target',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: '编辑图片',
          mediaType: 'image',
          mode: 'generate',
          prompt: '保留主体，修改背景',
        },
      },
    ],
    executionBindings: {
      target: {
        credentialId: 'synthetic-credential',
        credentialVersion: 1,
        mediaType: 'image',
        modelAlias,
        contract,
      },
    },
    edges: [],
    inputs,
  } as RunSnapshot;
}

function provider(baseUrl = 'https://api.image2pro.top/v1', payload: unknown = undefined) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json(payload ?? { data: [{ url: 'https://assets.example/result.png' }] }),
    );
  return {
    fetchImpl,
    instance: new NewApiProvider({
      baseUrl,
      apiKey: 'synthetic-key',
      fetchImpl,
      imageTaskPollIntervalMs: 0,
      imageTaskMaxPollAttempts: 2,
    }),
  };
}

describe('Image2Pro 独立同步图生图协议', () => {
  it.each(['gpt-image-2.5-flare', 'Nano-banana-2.1', '无限制-Qwen-2.1NEW'])(
    '官方端点的 %s 发送 JSON input_image，保持参考图顺序并独立发送蒙版',
    async (model) => {
      const { fetchImpl, instance } = provider('https://api.image2pro.top');
      const onRequestPrompt = vi.fn();
      const inputs = [
        reference('first', 'https://assets.example/first.png'),
        { ...reference('mask', inlinePng, 'mask'), sortOrder: 1 },
        { ...reference('second'), sortOrder: 2 },
      ];
      await instance.execute({
        snapshot: snapshot({}, inputs, model),
        onRequestPrompt,
        runId: 'synthetic-run',
      });

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://api.image2pro.top/v1/images/edits');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        model,
        prompt: '保留主体，修改背景',
        n: 1,
        input_image: ['https://assets.example/first.png', inlinePng],
        mask: inlinePng,
      });
      expect(onRequestPrompt).toHaveBeenCalledTimes(1);
      expect(onRequestPrompt.mock.calls[0]?.[0]).toMatchObject({
        requestIdentity: 'POST /images/edits#1',
        parts: [{ order: 0, text: '保留主体，修改背景' }],
        resources: [
          { name: 'first', role: 'referenceImage', sortOrder: 0 },
          { name: 'second', role: 'referenceImage', sortOrder: 1 },
          { name: 'mask', role: 'mask', sortOrder: 2 },
        ],
      });
    },
  );

  it.each([
    [{ aspectRatio: '9:16' }, { aspect_ratio: '9:16' }],
    [
      { size: '4K', aspectRatio: '1:1' },
      { resolution: '4K', aspect_ratio: '1:1' },
    ],
    [
      { imageSize: '2K', ratio: '3:2' },
      { image_size: '2K', aspect_ratio: '3:2' },
    ],
    [{ size: '4096×4096' }, { size: '4096x4096' }],
    [{ resolution: '1536x1024' }, { size: '1536x1024' }],
    [{ quality: '2k' }, { resolution: '2K' }],
  ])('独立映射尺寸与比例 %j，不继承其他渠道像素限制', async (parameters, expected) => {
    const { instance, fetchImpl } = provider();
    await instance.execute({ snapshot: snapshot(parameters) });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: '保留主体，修改背景',
      n: 1,
      input_image: [inlinePng],
      ...expected,
    });
  });

  it('网关显式声明编辑合同才启用专属 JSON，输入字段只取冻结参考图', async () => {
    const { instance, fetchImpl } = provider('https://gateway.example/v1');
    await instance.execute({
      snapshot: snapshot(
        {
          images: ['https://untrusted.example/injected.png'],
          quality: 'high',
          background: 'transparent',
          output_format: 'jpeg',
          user: 'ignored',
        },
        [reference('source')],
        'gpt-image-2.5-flare',
        IMAGE2PRO_IMAGE_EDIT_CONTRACT,
      ),
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: '保留主体，修改背景',
      n: 1,
      input_image: [inlinePng],
    });
  });

  it.each(['gpt-image-2.5-flare', '无限制-Qwen-2.1NEW'])(
    '其他渠道的同名模型 %s 保留 multipart 图生图',
    async (model) => {
      const { instance, fetchImpl } = provider('https://other.example/v1');
      await instance.execute({ snapshot: snapshot({}, [reference('source')], model) });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://other.example/v1/images/edits');
      const body = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get('image')).toBeInstanceOf(Blob);
      expect(body.get('input_image')).toBeNull();
    },
  );

  it('其他渠道 Nano Banana 保留聊天图片协议', async () => {
    const { instance, fetchImpl } = provider('https://other.example/v1', {
      choices: [{ message: { content: [{ type: 'image_url', image_url: { url: inlinePng } }] } }],
    });
    await instance.execute({ snapshot: snapshot({}, [reference('source')], 'Nano-banana-2.1') });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://other.example/v1/chat/completions');
  });

  it('相似域名不启用 Image2Pro 专属协议', async () => {
    const { instance, fetchImpl } = provider('https://api.image2pro.top.example/v1');
    await instance.execute({ snapshot: snapshot() });
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
  });

  it.each(['openai-images', IMAGE2PRO_IMAGE_EDIT_CONTRACT])(
    '无参考图时 %s 保留文生图路径',
    async (contract) => {
      const { instance, fetchImpl } = provider();
      await instance.execute({
        snapshot: snapshot({ size: '1024x1024' }, [], 'gpt-image-2.5-flare', contract),
      });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.image2pro.top/v1/images/generations');
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        model: 'gpt-image-2.5-flare',
        prompt: '保留主体，修改背景',
        size: '1024x1024',
        n: 1,
      });
    },
  );

  it('显式异步合同继续创建并查询原图片任务', async () => {
    const { instance, fetchImpl } = provider();
    fetchImpl.mockResolvedValueOnce(
      Response.json(
        { id: 'task-1', status: 'completed', data: [{ url: 'https://assets.example/result.png' }] },
        { status: 202 },
      ),
    );
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        id: 'task-1',
        status: 'completed',
        data: [{ url: 'https://assets.example/result.png' }],
      }),
    );
    await instance.execute({
      snapshot: snapshot(
        {},
        [reference('source')],
        'gpt-image-2.5-flare',
        IMAGE2PRO_IMAGE_TASK_CONTRACT,
      ),
      providerJob: { id: 'synthetic-job', provider: 'newapi' },
      onProviderJob: vi.fn(),
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.image2pro.top/v1/images/tasks');
  });

  it.each([
    { data: [{ url: 'https://assets.example/result.png' }] },
    { data: [{ b64_json: 'c3ludGhldGljLWltYWdl' }] },
  ])('按实际 data 解析返回值，不假设 response_format 会转码', async (payload) => {
    const { instance } = provider(undefined, payload);
    const result = await instance.execute({
      snapshot: snapshot({ response_format: 'url', output_format: 'jpeg' }),
    });
    expect(result.output.mimeType).toBe('image/png');
    expect(result.output.kind).toBe('url' in payload.data[0]! ? 'url' : 'base64');
  });

  it.each([0, 2, 5, 1.5])('无效或超出画布单结果能力的 n=%s 在发送前拒绝', async (n) => {
    const { instance, fetchImpl } = provider();
    await expect(instance.execute({ snapshot: snapshot({ n }) })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [reference('only-mask', inlinePng, 'mask')],
    Array.from({ length: 17 }, (_, index) => reference(`reference-${index}`)),
    [
      reference('source'),
      reference('mask-1', inlinePng, 'mask'),
      reference('mask-2', inlinePng, 'mask'),
    ],
    [
      reference('source'),
      {
        ...reference('mask', 'data:image/jpeg;base64,c3ludGhldGljLWltYWdl', 'mask'),
        snapshot: {
          ...reference('mask').snapshot,
          data: {
            ...reference('mask').snapshot.data,
            contentUrl: 'data:image/jpeg;base64,c3ludGhldGljLWltYWdl',
            mimeType: 'image/jpeg',
          },
        },
      },
    ],
    [reference('source', 'http://assets.example/source.png')],
    [reference('source', '/local/file.png')],
  ])('非法参考图组合在发送前拒绝（%#）', async (...inputs) => {
    const { instance, fetchImpl } = provider();
    await expect(instance.execute({ snapshot: snapshot({}, inputs) })).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

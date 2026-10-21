import { describe, expect, it, vi } from 'vitest';
import type { CanvasNode, RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider } from './index';

/** 构造独立图片请求；编辑仅使用合成 PNG，不读取真实项目或请求上游。 */
function imageSnapshot(parameters: Record<string, unknown>, edit = false): RunSnapshot {
  const source: CanvasNode = {
    id: 'source-image',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: 'Reference',
      mode: 'source',
      mediaType: 'image',
      assetId: 'synthetic-image',
      mimeType: 'image/png',
      contentUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    },
  };
  return {
    projectId: 'image-parameter-test',
    canvasRevision: 1,
    targetNodeId: 'target-image',
    modelAlias: 'gpt-image-2.5-sunburst',
    parameters: { prompt: 'Create a portrait.', ...parameters },
    submittedAt: '2026-09-29T00:00:00.000Z',
    nodes: [
      ...(edit ? [source] : []),
      {
        id: 'target-image',
        type: 'image',
        position: { x: 1, y: 0 },
        data: { label: 'Target', mediaType: 'image', mode: 'generate' },
      },
    ],
    edges: [],
    inputs: edit
      ? [
          {
            nodeId: source.id,
            role: 'referenceImage',
            sortOrder: 0,
            sourceAssetId: 'synthetic-image',
            sourceAssetVersion: 1,
            snapshot: source,
          },
        ]
      : [],
  };
}

/** 只记录请求体并返回合成响应，所有网络由本地 stub 截断。 */
function imageProvider() {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.test/result.png' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return {
    fetchImpl,
    provider: new NewApiProvider({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'test-only-key',
      fetchImpl,
    }),
  };
}

/** 八种现有比例的预期像素，短边按 16 像素对齐，不依赖被测算法计算期望值。 */
const cases = [
  ['1k', '1:1', '1024x1024'],
  ['1k', '16:9', '1024x576'],
  ['1k', '9:16', '576x1024'],
  ['1k', '4:3', '1024x768'],
  ['1k', '3:4', '768x1024'],
  ['1k', '3:2', '1024x688'],
  ['1k', '2:3', '688x1024'],
  ['1k', '21:9', '1024x432'],
  ['2k', '1:1', '2048x2048'],
  ['2k', '16:9', '2048x1152'],
  ['2k', '9:16', '1152x2048'],
  ['2k', '4:3', '2048x1536'],
  ['2k', '3:4', '1536x2048'],
  ['2k', '3:2', '2048x1360'],
  ['2k', '2:3', '1360x2048'],
  ['2k', '21:9', '2048x880'],
  ['3k', '1:1', '3072x3072'],
  ['3k', '16:9', '3072x1728'],
  ['3k', '9:16', '1728x3072'],
  ['3k', '4:3', '3072x2304'],
  ['3k', '3:4', '2304x3072'],
  ['3k', '3:2', '3072x2048'],
  ['3k', '2:3', '2048x3072'],
  ['3k', '21:9', '3072x1312'],
  ['4k', '1:1', '3840x3840'],
  ['4k', '16:9', '3840x2160'],
  ['4k', '9:16', '2160x3840'],
  ['4k', '4:3', '3840x2880'],
  ['4k', '3:4', '2880x3840'],
  ['4k', '3:2', '3840x2560'],
  ['4k', '2:3', '2560x3840'],
  ['4k', '21:9', '3840x1648'],
] as const;

describe.each([false, true])('image output parameters (edit=%s)', (edit) => {
  it.each(['1K', '2K', '4K'])(
    'sends unrestricted %s unchanged in the actual request',
    async (size) => {
      const { provider, fetchImpl } = imageProvider();
      const snapshot = imageSnapshot({ size, aspectRatio: '9:16', seed: 0 }, edit);
      snapshot.modelAlias = '完全无限制-Z-Image';
      const before = structuredClone(snapshot);
      await provider.execute({ snapshot });
      const init = fetchImpl.mock.calls[0]![1]!;
      const body = edit
        ? Object.fromEntries((init.body as FormData).entries())
        : JSON.parse(init.body as string);
      expect(body).toMatchObject({ size, aspect_ratio: '9:16', seed: edit ? '0' : 0 });
      for (const key of ['quality', 'resolution', 'aspectRatio', 'width', 'height'])
        expect(body).not.toHaveProperty(key);
      expect(snapshot).toEqual(before);
    },
  );

  it('maps an official OpenAI tier into pixels at the provider boundary', async () => {
    const { provider, fetchImpl } = imageProvider();
    await provider.execute({ snapshot: imageSnapshot({ size: '2K', aspectRatio: '16:9' }, edit) });
    const init = fetchImpl.mock.calls[0]![1]!;
    const body = edit
      ? Object.fromEntries((init.body as FormData).entries())
      : JSON.parse(init.body as string);
    expect(body.size).toBe('2048x1152');
    expect(body).not.toHaveProperty('aspectRatio');
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('sends canonical size and native quality without dimension aliases', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({ size: '2160x3840', quality: 'high' }, edit);
    snapshot.imageEditCapability = {
      declared: true,
      sizes: ['2160x3840'],
      parameters: ['size', 'quality'],
    };

    await provider.execute({ snapshot });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://newapi.example.test/v1/images/${edit ? 'edits' : 'generations'}`);
    const body = edit
      ? Object.fromEntries((init!.body as FormData).entries())
      : JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'Create a portrait.',
      n: edit ? '1' : 1,
      size: '2160x3840',
      quality: 'high',
    });
    expect(Object.keys(body).sort()).toEqual(
      [...(edit ? ['image'] : []), 'model', 'n', 'prompt', 'quality', 'size'].sort(),
    );
  });

  it.each(cases)(
    'sends legacy %s at %s as size %s, not quality',
    async (quality, aspectRatio, size) => {
      const { provider, fetchImpl } = imageProvider();
      const snapshot = imageSnapshot({ quality, aspectRatio }, edit);
      snapshot.modelAlias = 'image-size-contract-fixture';
      const before = structuredClone(snapshot);
      await provider.execute({ snapshot });
      expect(snapshot).toEqual(before);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(`https://newapi.example.test/v1/images/${edit ? 'edits' : 'generations'}`);
      const body = edit
        ? Object.fromEntries((init!.body as FormData).entries())
        : JSON.parse(init!.body as string);
      expect(body.size).toBe(size);
      expect(body.model).toBe('image-size-contract-fixture');
      for (const name of [
        'quality',
        'resolution',
        'aspectRatio',
        'aspect_ratio',
        'imageSize',
        'image_size',
      ])
        expect(body).not.toHaveProperty(name);
    },
  );

  it('keeps native quality separate from resolution and honors the edit parameter allowlist', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot(
      { resolution: '4k', quality: 'high', aspectRatio: '9:16' },
      edit,
    );
    snapshot.imageEditCapability = { declared: true, parameters: ['size', 'quality'] };
    await provider.execute({ snapshot });
    const init = fetchImpl.mock.calls[0]![1]!;
    const body = edit
      ? Object.fromEntries((init.body as FormData).entries())
      : JSON.parse(init.body as string);
    expect(body).toMatchObject({ size: '2160x3840', quality: 'high' });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('resolution');
  });
});

describe.each([false, true])('image model parameters (edit=%s)', (edit) => {
  it.each([
    { resolution: '8k', aspect_ratio: '16:9' },
    { aspect_ratio: 'panorama' },
    { size: '1280x720', aspect_ratio: 'panorama' },
    { resolution: '4k', aspect_ratio: 'adaptive' },
    { size: 'future-size', aspect_ratio: 'auto' },
    { image_size: 'future-size', aspect_ratio: 'auto' },
  ])('未知图片参数保持原值提交且不补默认像素：%j', async (parameters) => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({ ...parameters, quality: 'high', seed: 0 }, edit);
    const before = structuredClone(snapshot);
    await provider.execute({ snapshot });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1]!;
    const body = edit
      ? Object.fromEntries((init.body as FormData).entries())
      : JSON.parse(init.body as string);
    expect(body).toMatchObject(
      Object.fromEntries(
        Object.entries({ ...parameters, quality: 'high', seed: 0 }).map(([key, value]) => [
          key,
          edit ? String(value) : value,
        ]),
      ),
    );
    if (!('size' in parameters)) expect(body).not.toHaveProperty('size');
    expect(snapshot).toEqual(before);
  });

  it.each(['9:16', '16:9', '21:9'])(
    'sends supported UHD %s through the exact model',
    async (aspectRatio) => {
      const { provider, fetchImpl } = imageProvider();
      await provider.execute({
        snapshot: imageSnapshot({ resolution: '4k', aspectRatio, quality: 'xhigh' }, edit),
      });
      const init = fetchImpl.mock.calls[0]![1]!;
      const body = edit
        ? Object.fromEntries((init.body as FormData).entries())
        : JSON.parse(init.body as string);
      expect(body.model).toBe('gpt-image-2.5-sunburst');
      expect(body.quality).toBe('xhigh');
      expect(body.size).toBe(
        { '9:16': '2160x3840', '16:9': '3840x2160', '21:9': '3840x1648' }[aspectRatio],
      );
    },
  );
});

describe('frozen image edit size declarations', () => {
  it('accepts equivalent canonical size and resolution without sending aliases', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot(
      { size: '2160x3840', resolution: '4k', image_quality: 'high', aspect_ratio: '9:16' },
      true,
    );
    snapshot.imageEditCapability = {
      declared: true,
      sizes: ['2160x3840'],
      parameters: ['size', 'quality'],
    };
    await provider.execute({ snapshot });
    const body = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect(body.get('size')).toBe('2160x3840');
    expect(body.get('quality')).toBe('high');
    expect(body.has('image_quality')).toBe(false);
    expect(body.has('aspect_ratio')).toBe(false);
    expect(body.has('resolution')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('公网参考图的 edits 合同', () => {
  it('声明 public-url 时改用 JSON edits 并原样下发图片地址', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({}, true);
    snapshot.imageEditCapability = { declared: true, referenceImages: 'public-url' };
    snapshot.nodes.find((node) => node.id === 'source-image')!.data.contentUrl =
      'https://canvas.example.test/v1/assets/synthetic-image/versions/1/content?access_token=test';

    await provider.execute({ snapshot });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://newapi.example.test/v1/images/edits');
    expect((init!.headers as Record<string, string>)['content-type']).toContain('application/json');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'Create a portrait.',
      n: 1,
      image:
        'https://canvas.example.test/v1/assets/synthetic-image/versions/1/content?access_token=test',
    });
  });

  it('未声明时保持 multipart；声明后没有公网地址必须失败', async () => {
    const { provider, fetchImpl } = imageProvider();
    await provider.execute({ snapshot: imageSnapshot({}, true) });
    expect(fetchImpl.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);

    const strict = imageProvider();
    const strictSnapshot = imageSnapshot({}, true);
    strictSnapshot.imageEditCapability = { declared: true, referenceImages: 'public-url' };
    await expect(strict.provider.execute({ snapshot: strictSnapshot })).rejects.toThrow(
      /公网参考图/,
    );
    expect(strict.fetchImpl).not.toHaveBeenCalled();
  });

  it('多张参考图用 images 数组而不是 multipart 的 image[] 键', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({}, true);
    snapshot.imageEditCapability = { declared: true, referenceImages: 'public-url' };
    const first = snapshot.nodes.find((node) => node.id === 'source-image')!;
    first.data.contentUrl = 'https://canvas.example.test/v1/provider-assets/one/versions/1/content';
    const second = structuredClone(first);
    second.id = 'source-image-2';
    second.data.assetId = 'synthetic-image-2';
    second.data.contentUrl =
      'https://canvas.example.test/v1/provider-assets/two/versions/1/content';
    snapshot.nodes.push(second);
    snapshot.inputs.push({
      ...snapshot.inputs[0]!,
      sourceAssetId: 'synthetic-image-2',
      nodeId: second.id,
      sortOrder: 1,
      snapshot: second,
    });

    await provider.execute({ snapshot });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.image).toBeUndefined();
    expect(body.images).toEqual([
      'https://canvas.example.test/v1/provider-assets/one/versions/1/content',
      'https://canvas.example.test/v1/provider-assets/two/versions/1/content',
    ]);
  });
});

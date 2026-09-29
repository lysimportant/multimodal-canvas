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

  it.each([
    { size: '1024x1024', quality: '4k', aspectRatio: '9:16' },
    { size: '1024x1536', aspectRatio: '16:9' },
    { resolution: '8k', aspectRatio: '9:16' },
    { resolution: '4k', aspectRatio: '0:16' },
    { quality: '4k', resolution: '2k' },
  ])('rejects conflicting or invalid image dimensions before POST: %j', async (parameters) => {
    const { provider, fetchImpl } = imageProvider();
    await expect(
      provider.execute({ snapshot: imageSnapshot(parameters, edit) }),
    ).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe.each([false, true])('known image model boundaries (edit=%s)', (edit) => {
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

  it.each([
    { resolution: '4k', aspectRatio: '1:1' },
    { resolution: '3k', aspectRatio: '1:1' },
    { resolution: '1k', aspectRatio: '9:16' },
    { size: '1200x700' },
    { size: '4096x2160' },
  ])(
    'rejects known model size violations before creating or sending records: %j',
    async (parameters) => {
      const { provider, fetchImpl } = imageProvider();
      const onRequestPrompt = vi.fn();
      await expect(
        provider.execute({ snapshot: imageSnapshot(parameters, edit), onRequestPrompt }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER', retryable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(onRequestPrompt).not.toHaveBeenCalled();
    },
  );
});

describe('frozen image edit size declarations', () => {
  it('compares the resolved pixels with the declared sizes before upload', async () => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({ quality: '4k', aspectRatio: '9:16' }, true);
    snapshot.imageEditCapability = { declared: true, parameters: ['size'], sizes: ['1024x1024'] };
    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'IMAGE_EDIT_SIZE_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
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

describe('fixed-size image models reject automatic dimensions', () => {
  it.each(['dall-e-2', 'dall-e-3'])('rejects auto for %s before POST', async (modelAlias) => {
    const { provider, fetchImpl } = imageProvider();
    const snapshot = imageSnapshot({ size: 'auto' });
    snapshot.modelAlias = modelAlias;
    await expect(provider.execute({ snapshot })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

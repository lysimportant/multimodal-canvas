import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { NewApiProvider } from './index';

const png = 'aW1hZ2U=';
const dataUrl = `data:image/png;base64,${png}`;

function snapshot(modelAlias = 'gemini-3-pro-image-preview'): RunSnapshot {
  return {
    projectId: 'gemini-image-test',
    canvasRevision: 1,
    targetNodeId: 'image',
    modelAlias,
    parameters: { prompt: 'Draw a lighthouse.' },
    submittedAt: '2026-10-14T00:00:00.000Z',
    nodes: [
      {
        id: 'image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: 'Image', mediaType: 'image', mode: 'generate' },
      },
    ],
    edges: [],
    inputs: [],
  };
}

function setup(message: Record<string, unknown>) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ choices: [{ message }] }));
  return {
    fetchImpl,
    provider: new NewApiProvider({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'test-only-key',
      fetchImpl,
    }),
  };
}

describe('Gemini chat image generation', () => {
  it.each(['1K', '2K', '4K'])('sends native %s directly through image_config', async (size) => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const input = snapshot();
    input.parameters = { size, aspectRatio: '9:16' };
    await provider.execute({ snapshot: input });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.extra_body.google.image_config).toEqual({ image_size: size, aspect_ratio: '9:16' });
    expect(body).not.toHaveProperty('size');
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('does not invent a resolution when only the ratio is selected', async () => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const input = snapshot();
    input.parameters = { aspectRatio: '16:9' };
    await provider.execute({ snapshot: input });
    expect(
      JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).extra_body.google.image_config,
    ).toEqual({ aspect_ratio: '16:9' });
  });

  it.each([
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-preview',
    'gemini-nano-banana-2.1',
    'gemini-2.5-flash-image',
  ])('%s sends chat messages and archives the returned inline image', async (model) => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const onRequestPrompt = vi.fn();
    const result = await provider.execute({
      snapshot: snapshot(model),
      runId: 'run-image',
      onRequestPrompt,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/chat/completions');
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      model,
      messages: [{ role: 'user', content: 'Draw a lighthouse.' }],
    });
    expect(result.output).toEqual({
      mediaType: 'image',
      kind: 'base64',
      base64: png,
      mimeType: 'image/png',
      format: 'png',
    });
    expect(onRequestPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestIdentity: 'POST /chat/completions#1',
        mediaType: 'image',
        format: 'messages',
        parts: [{ order: 0, role: 'user', text: 'Draw a lighthouse.' }],
        resources: [],
      }),
    );
  });

  it('maps canvas image dimensions to Gemini image_config without forwarding GPT Image fields', async () => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const input = snapshot();
    input.parameters = {
      prompt: 'Draw a lighthouse.',
      size: '2048x1152',
      quality: 'high',
      extra_body: {
        google: {
          thinking_config: { include_thoughts: true },
          image_config: { existing_option: 'preserved' },
        },
        gateway_option: 'preserved',
      },
    };

    await provider.execute({ snapshot: input, runId: 'run-image' });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      model: input.modelAlias,
      messages: [{ role: 'user', content: 'Draw a lighthouse.' }],
      extra_body: {
        google: {
          thinking_config: { include_thoughts: true },
          image_config: {
            existing_option: 'preserved',
            aspect_ratio: '16:9',
            image_size: '2K',
          },
        },
        gateway_option: 'preserved',
      },
    });
    expect(body).not.toHaveProperty('size');
    expect(body).not.toHaveProperty('quality');
  });

  it('maps a vertical 4K canvas size to Gemini image_config', async () => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const input = snapshot();
    input.parameters = { prompt: 'Draw a lighthouse.', size: '2160x3840' };

    await provider.execute({ snapshot: input, runId: 'run-image' });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      extra_body: { google: { image_config: { aspect_ratio: '9:16', image_size: '4K' } } },
    });
  });

  it('rejects an unsupported Gemini 3K size before calling the gateway', async () => {
    const { provider, fetchImpl } = setup({ images: [{ image_url: { url: dataUrl } }] });
    const input = snapshot();
    input.parameters = { prompt: 'Draw a lighthouse.', size: '3072x1728' };

    await expect(provider.execute({ snapshot: input, runId: 'run-image' })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_PARAMETER',
      retryable: false,
      message: expect.stringContaining('仅支持 1K、2K、4K'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the hydrated reference image and records its frozen identity', async () => {
    const { provider, fetchImpl } = setup({
      content: [{ type: 'image_url', image_url: { url: dataUrl } }],
    });
    const input = snapshot();
    input.inputs = [
      {
        nodeId: 'reference',
        role: 'referenceImage',
        sortOrder: 0,
        sourceAssetId: 'asset-reference',
        sourceAssetVersion: 2,
        snapshot: {
          id: 'reference',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Reference',
            mediaType: 'image',
            mode: 'source',
            contentUrl: dataUrl,
            mimeType: 'image/png',
          },
        },
      },
    ];
    const onRequestPrompt = vi.fn();
    await provider.execute({ snapshot: input, runId: 'run-edit', onRequestPrompt });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Draw a lighthouse.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ]);
    expect(onRequestPrompt.mock.calls[0]?.[0].resources).toEqual([
      {
        assetId: 'asset-reference',
        assetVersion: 2,
        name: 'Reference',
        role: 'referenceImage',
        sortOrder: 0,
        mediaType: 'image',
      },
    ]);
  });

  it.each([
    { content: `Here is the image: ![result](${dataUrl})` },
    { content: dataUrl },
    { content: [{ inline_data: { mime_type: 'image/png', data: png } }] },
    { content: [{ inlineData: { mimeType: 'image/png', data: png } }] },
  ])('parses compatible inline image responses: %j', async (message) => {
    const { provider } = setup(message);
    expect((await provider.execute({ snapshot: snapshot() })).output).toMatchObject({
      kind: 'base64',
      base64: png,
      mimeType: 'image/png',
    });
  });

  it('archives a standalone generated image URL returned by the gateway', async () => {
    const { provider } = setup({
      content: 'https://cdn.example.test/images/2026/10/14/generated-result.jpg\n',
    });
    expect((await provider.execute({ snapshot: snapshot() })).output).toMatchObject({
      kind: 'url',
      url: 'https://cdn.example.test/images/2026/10/14/generated-result.jpg',
      mimeType: 'image/jpeg',
      format: 'jpeg',
    });
  });

  it('uses the frozen chat contract for a custom image alias', async () => {
    const input = snapshot('custom-image-alias');
    input.executionBindings = {
      image: {
        credentialId: 'credential',
        credentialVersion: 1,
        modelAlias: input.modelAlias,
        mediaType: 'image',
        contract: 'openai-chat-completions',
        authority: {
          issuer: 'https://newapi.example.test',
          externalUserId: 'user',
          instanceId: 'canvas',
          grantId: 'grant',
          tokenId: 'token',
          credentialRevision: '1',
          group: 'default',
          permissionRevision: '1',
          autoGroups: [],
        },
      },
    };
    const { provider, fetchImpl } = setup({
      content: '![result](https://cdn.example.test/result.webp)',
    });
    expect((await provider.execute({ snapshot: input })).output).toMatchObject({
      kind: 'url',
      url: 'https://cdn.example.test/result.webp',
      mimeType: 'image/webp',
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/chat/completions');
  });

  it.each([
    { content: `![image](<${dataUrl}> "Generated image")`, base64: png },
    { content: `![image]( ${dataUrl} 'Generated image' )`, base64: png },
    { content: '![image](data:image/png;base64,aW1h\nZ2U=)', base64: 'aW1h\nZ2U=' },
  ])('parses Markdown image destinations with formatting: %j', async ({ content, base64 }) => {
    const { provider } = setup({ content });
    expect((await provider.execute({ snapshot: snapshot() })).output).toMatchObject({
      kind: 'base64',
      base64,
      mimeType: 'image/png',
    });
  });

  it('parses a Markdown remote image with angle brackets and a title', async () => {
    const { provider } = setup({
      content: '![image](<https://cdn.example.test/result.webp> "Generated image")',
    });
    expect((await provider.execute({ snapshot: snapshot() })).output).toMatchObject({
      kind: 'url',
      url: 'https://cdn.example.test/result.webp',
      mimeType: 'image/webp',
    });
  });

  it('rejects malformed inline images rather than archiving them', async () => {
    const { provider } = setup({ content: '![image](<data:image/png;base64,%%%>)' });
    await expect(provider.execute({ snapshot: snapshot() })).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_BASE64_INVALID',
      retryable: false,
    });
  });

  it.each(['stop', 'length', 'content_filter', 'private-upstream-text'])(
    'retains safe diagnostics and header IDs for a %s response without an image',
    async (finishReason) => {
      const privateText = 'private response with https://signed.example.test/result?token=secret';
      const { provider, fetchImpl } = setup({});
      fetchImpl.mockResolvedValueOnce(
        Response.json(
          { choices: [{ finish_reason: finishReason, message: { content: privateText } }] },
          {
            headers: {
              'x-request-id': 'original-request',
              'x-oneapi-request-id': 'gateway-request',
            },
          },
        ),
      );
      const error = await provider.execute({ snapshot: snapshot() }).catch((error) => error);
      expect(error).toMatchObject({
        code: 'PROVIDER_IMAGE_OUTPUT_MISSING',
        retryable: false,
        requestId: 'original-request',
        newApiRequestId: 'gateway-request',
        providerPayload: {
          choiceCount: 1,
          contentType: 'string',
          textLength: privateText.length,
          contentPartCount: 0,
          imageEntryCount: 0,
          finishReason: finishReason === 'private-upstream-text' ? 'unknown' : finishReason,
          hasRefusal: false,
        },
      });
      expect(JSON.stringify(error)).not.toContain(privateText);
      expect(JSON.stringify(error)).not.toContain('private-upstream-text');
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('keeps Imagen on the Images endpoint', async () => {
    const { provider, fetchImpl } = setup({});
    fetchImpl.mockResolvedValueOnce(
      Response.json({ data: [{ url: 'https://cdn.example.test/result.png' }] }),
    );
    await provider.execute({ snapshot: snapshot('imagen-4.0-generate-001') });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://newapi.example.test/v1/images/generations');
  });

  it('rejects multiple generated images without silently discarding one or retrying', async () => {
    const { provider, fetchImpl } = setup({
      images: [
        { image_url: { url: dataUrl } },
        { image_url: { url: 'data:image/png;base64,b3RoZXI=' } },
      ],
    });
    await expect(provider.execute({ snapshot: snapshot() })).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_CARDINALITY_UNSUPPORTED',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an ordinary text link for a generated image', async () => {
    const { provider } = setup({ content: 'See https://example.test/help for instructions.' });
    await expect(provider.execute({ snapshot: snapshot() })).rejects.toThrow('缺少图片内容');
  });

  it('does not mistake a standalone non-image URL for a generated image', async () => {
    const { provider } = setup({ content: 'https://example.test/help' });
    await expect(provider.execute({ snapshot: snapshot() })).rejects.toThrow('缺少图片内容');
  });
});

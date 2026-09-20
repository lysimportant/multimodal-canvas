import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  normalizeModelsPayload,
  normalizeProviderTimeout,
} from './settings';

describe('Provider 超时合同', () => {
  it('使用 15 分钟默认值并接受 Node 定时器范围内的整数', () => {
    expect(normalizeProviderTimeout(undefined)).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
    expect(normalizeProviderTimeout(undefined, 1_200_000)).toBe(1_200_000);
    expect(normalizeProviderTimeout(1_000)).toBe(1_000);
    expect(normalizeProviderTimeout(2_147_483_647)).toBe(2_147_483_647);
  });

  it.each([0, 999, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '1000'])(
    '拒绝无效值 %s',
    (value) => {
      expect(() => normalizeProviderTimeout(value)).toThrow(
        'Provider timeout must be an integer between 1000 and 2147483647 ms',
      );
    },
  );
});

describe('New API 模型目录规范化', () => {
  it('合并同名模型的媒体类型、能力、限制和价格', () => {
    const models = normalizeModelsPayload({
      data: [
        {
          id: ' omni-1 ',
          name: 'Omni 1',
          media_type: 'image-generation',
          limits: { maxWidth: 2048 },
          pricing: { perRun: '0.01', currency: 'USD' },
        },
        {
          id: 'omni-1',
          modalities: ['text', 'audio'],
          capabilities: { streaming: true },
        },
        { id: 'text-only', type: 'chat' },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models.find((model) => model.id === 'omni-1')).toMatchObject({
      name: 'Omni 1',
      mediaTypes: ['image', 'text', 'audio'],
      capabilities: { streaming: true },
      limitations: { maxWidth: 2048 },
      price: { perRun: '0.01', currency: 'USD' },
    });
    expect(models.find((model) => model.id === 'text-only')?.mediaTypes).toEqual(['text']);
  });

  it('支持原始数组和常见包装字段，并忽略无效记录', () => {
    expect(
      normalizeModelsPayload([
        null,
        { id: '', type: 'image' },
        { id: 'valid-model', supported_endpoint_types: ['chat', 'image-generation'] },
      ]),
    ).toEqual([expect.objectContaining({ id: 'valid-model', mediaTypes: ['text', 'image'] })]);
    expect(normalizeModelsPayload({ models: [{ id: 'wrapped', type: 'video' }] })).toEqual([
      expect.objectContaining({ id: 'wrapped', mediaTypes: ['video'] }),
    ]);
    expect(normalizeModelsPayload({ results: [{ id: 'result', type: 'audio' }] })).toEqual([
      expect.objectContaining({ id: 'result', mediaTypes: ['audio'] }),
    ]);
    expect(normalizeModelsPayload({ data: 'not-an-array' })).toEqual([]);
  });

  it('从真实 New API 形状推断图像模型', () => {
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-image-2',
          object: 'model',
          owned_by: 'openai',
        },
      ],
    });

    expect(models).toEqual([expect.objectContaining({ id: 'gpt-image-2', mediaTypes: ['image'] })]);
  });

  it('推断常见视频别名并保留完整按次模型 ID', () => {
    const models = normalizeModelsPayload({
      data: [
        { id: 'sora-2-pro' },
        { id: 'grok-imagine-video-1.5（按次）' },
        { id: 'minimax-h3-video-test' },
      ],
    });

    expect(models.map((model) => model.id)).toEqual([
      'sora-2-pro',
      'grok-imagine-video-1.5（按次）',
      'minimax-h3-video-test',
    ]);
    expect(models.every((model) => model.mediaTypes.includes('video'))).toBe(true);
  });

  it.each([
    { capabilities: undefined },
    { capabilities: { reasoning_effort: ['low'] } },
    { capabilities: { reasoning_effort: ['LOW', ' low '] } },
    { capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } },
  ])('补齐 GPT-5.6 文本模型缺失或占位的推理强度', ({ capabilities }) => {
    const [model] = normalizeModelsPayload({
      data: [{ id: 'gpt-5.6-sol', type: 'chat', capabilities }],
    });

    expect(model?.capabilities?.reasoning_effort).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('保留 GPT-5.6 完整声明以及非 GPT 模型的上游声明', () => {
    const declared = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-5.6-terra',
          type: 'chat',
          capabilities: { reasoning_effort: declared, streaming: true },
        },
        {
          id: 'other-text-model',
          type: 'chat',
          capabilities: { reasoning_effort: ['low'] },
        },
      ],
    });

    expect(models[0]?.capabilities).toEqual({
      reasoning_effort: declared,
      streaming: true,
    });
    expect(models[1]?.capabilities?.reasoning_effort).toEqual(['low']);
  });

  it('重复记录不会用 low 占位覆盖已确认的推理强度', () => {
    const models = normalizeModelsPayload({
      data: [
        {
          id: 'gpt-5.6-sol',
          type: 'chat',
          capabilities: { reasoning_effort: ['medium', 'high'] },
        },
        {
          id: 'gpt-5.6-sol',
          type: 'chat',
          capabilities: { reasoning_effort: ['low'], streaming: true },
        },
      ],
    });

    expect(models[0]?.capabilities).toEqual({
      reasoning_effort: ['medium', 'high'],
      streaming: true,
    });
  });
});

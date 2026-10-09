import { describe, expect, it } from 'vitest';

import { checkResourceMentionCapabilities } from './resource-mention-capabilities';

/** 冻结图片预检样本；用例不读取真实资产或调用供应商。 */
const base = {
  node: { id: 'node-image', data: { mediaType: 'image' as const, mode: 'generate' as const } },
  modelAlias: 'image-v1',
  requestId: 'req-1',
  mentions: [
    {
      nodeId: 'node-image',
      mentionId: 'm-image',
      assetId: 'asset-image',
      assetVersion: 2,
      mediaType: 'image' as const,
      label: '产品图',
      blockOrder: 1,
    },
  ],
  allowMockPreview: false,
};

describe('resource mention capability preflight', () => {
  it.each([
    ['mentionMediaTypes', ['text']],
    ['mentionMediaTypes', []],
    ['mention_media_types', ['text']],
    ['supportedMentionMediaTypes', ['text']],
    ['supported_mention_media_types', ['text']],
    ['referenceMediaTypes', ['text']],
    ['reference_media_types', ['text']],
  ] as const)('图片引用不受目录媒体声明 %s=%j 拦截', (field, mediaTypes) => {
    for (const source of ['capabilities', 'limitations']) {
      const result = checkResourceMentionCapabilities({
        ...base,
        modelAlias: 'gpt-image-2.5-sunburst',
        model: { mediaTypes: ['image'], [source]: { [field]: mediaTypes } },
      });
      expect(result, source).toEqual({ issues: [], simulated: false });
    }
  });

  it('图片生成缺少能力声明时允许图片引用', () => {
    expect(checkResourceMentionCapabilities(base)).toEqual({ issues: [], simulated: false });
    expect(checkResourceMentionCapabilities({ ...base, model: { mediaTypes: ['image'] } })).toEqual(
      {
        issues: [],
        simulated: false,
      },
    );
  });

  it.each(['text', 'audio', 'video'] as const)('其他 %s 节点缺省声明不再阻断', (mediaType) => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-target', data: { mediaType, mode: 'generate' } },
    });
    expect(result).toEqual({ issues: [], simulated: false });
    expect(JSON.stringify(result)).not.toContain('data:');
  });

  it.each([
    undefined,
    { mediaTypes: ['text'] as const },
    { capabilities: { modes: ['generate'] } },
  ])('文字节点多次混合引用缺省数量、角色和媒体声明时仍放行', (model) => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-text', data: { mediaType: 'text', mode: 'generate' } },
      model,
      mentions: [
        { ...base.mentions[0], semanticRole: 'reference' },
        { ...base.mentions[0], mentionId: 'm-audio', mediaType: 'audio', blockOrder: 2 },
        { ...base.mentions[0], mentionId: 'm-text', mediaType: 'text', blockOrder: 3 },
      ],
    });
    expect(result).toEqual({ issues: [], simulated: false });
  });

  it('图片引用的角色和数量声明缺省时允许兼容编辑接口处理', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      model: { mediaTypes: ['image'] },
      mentions: [
        { ...base.mentions[0], semanticRole: 'reference' },
        { ...base.mentions[0], mentionId: 'm-second', assetId: 'asset-second' },
      ],
    });
    expect(result).toEqual({ issues: [], simulated: false });
  });

  it('allows explicitly marked mock preview when capability is unknown', () => {
    expect(checkResourceMentionCapabilities({ ...base, allowMockPreview: true })).toEqual({
      issues: [],
      simulated: true,
    });
  });

  it('marks partial capability declarations as simulated and does not block unknown fields', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      allowMockPreview: true,
      model: { capabilities: { mediaTypes: ['image'] } },
    });
    expect(result).toEqual({ issues: [], simulated: true });
  });

  it('accepts a fully declared compatible single-media request', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      model: {
        capabilities: {
          mediaTypes: ['image'],
          mentionMediaTypes: ['image'],
          semanticRoles: ['style'],
          maxMentions: 2,
          supportsMixedMentions: true,
          modes: ['generate'],
        },
      },
    });
    expect(result).toEqual({ issues: [], simulated: false });
  });

  it('模式声明缺省时不再推断为禁用', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-image', data: { mediaType: 'image', mode: 'source' } },
      model: { capabilities: { mentionMediaTypes: ['image'] } },
    });
    expect(result.issues).toEqual([]);
  });
});

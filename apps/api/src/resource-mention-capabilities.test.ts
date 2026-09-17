import { describe, expect, it } from 'vitest';

import { checkResourceMentionCapabilities } from './resource-mention-capabilities';

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

  it('文字节点的显式空列表和零上限在 Mock 中同样生效', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-text', data: { mediaType: 'text', mode: 'generate' } },
      model: { capabilities: { mentionMediaTypes: [], modes: [], maxMentions: 0 } },
      allowMockPreview: true,
    });
    expect(result.simulated).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'RESOURCE_MENTION_MODE_UNSUPPORTED',
      'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
      'RESOURCE_MENTION_COUNT_EXCEEDED',
    ]);
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

  it('文字节点仍遵守明确的角色、混合媒体和引用数量限制', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-text', data: { mediaType: 'text', mode: 'generate' } },
      model: {
        capabilities: {
          mention_media_types: ['image', 'audio'],
          semantic_roles: [],
          max_mentions: 1,
          supports_mixed_mentions: false,
        },
      },
      mentions: [
        { ...base.mentions[0], semanticRole: 'reference' },
        { ...base.mentions[0], mentionId: 'm-audio', mediaType: 'audio', blockOrder: 2 },
      ],
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'RESOURCE_MENTION_ROLE_UNSUPPORTED',
      'RESOURCE_MENTION_COUNT_EXCEEDED',
      'RESOURCE_MENTION_MIXED_UNSUPPORTED',
      'RESOURCE_MENTION_MIXED_UNSUPPORTED',
    ]);
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

  it.each([
    { capabilities: { mentionMediaTypes: ['text'] }, code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED' },
    { capabilities: { mentionMediaTypes: [] }, code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED' },
    { capabilities: { maxMentions: 0 }, code: 'RESOURCE_MENTION_COUNT_EXCEEDED' },
    { capabilities: { modes: [] }, code: 'RESOURCE_MENTION_MODE_UNSUPPORTED' },
  ])('图片兼容路径仍遵守显式限制 $code', ({ capabilities, code }) => {
    const result = checkResourceMentionCapabilities({ ...base, model: { capabilities } });
    expect(result.issues).toEqual([expect.objectContaining({ code })]);
  });

  it.each(['text', 'audio', 'video'] as const)(
    '图片生成不把 %s 提及当作图片编辑输入',
    (mediaType) => {
      const result = checkResourceMentionCapabilities({
        ...base,
        model: { capabilities: { mentionMediaTypes: [mediaType] } },
        mentions: [{ ...base.mentions[0], mediaType }],
      });
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'RESOURCE_MENTION_MEDIA_UNSUPPORTED' }),
      ]);
    },
  );

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

  it('validates media, roles, count, mode, and mixed-media combinations', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-image', data: { mediaType: 'image', mode: 'generate' } },
      mentions: [
        base.mentions[0],
        {
          ...base.mentions[0],
          mentionId: 'm-audio',
          assetId: 'asset-audio',
          mediaType: 'audio',
          semanticRole: 'characterVoice',
        },
      ],
      model: {
        capabilities: {
          mentionMediaTypes: ['image'],
          semanticRoles: ['style'],
          maxMentions: 1,
          supportsMixedMentions: false,
          modes: ['source'],
        },
      },
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'RESOURCE_MENTION_MODE_UNSUPPORTED',
        'RESOURCE_MENTION_MEDIA_UNSUPPORTED',
        'RESOURCE_MENTION_ROLE_UNSUPPORTED',
        'RESOURCE_MENTION_COUNT_EXCEEDED',
        'RESOURCE_MENTION_MIXED_UNSUPPORTED',
      ]),
    );
    expect(result.issues.every((issue) => issue.requestId === 'req-1')).toBe(true);
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

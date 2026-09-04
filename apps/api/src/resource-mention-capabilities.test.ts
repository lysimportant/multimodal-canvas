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
  it('fails closed with per-mention diagnostics when the model declaration is missing', () => {
    const result = checkResourceMentionCapabilities(base);
    expect(result.simulated).toBe(false);
    expect(result.issues).toMatchObject([
      {
        code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
        mentionId: 'm-image',
        assetId: 'asset-image',
        nodeId: 'node-image',
        modelAlias: 'image-v1',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('data:');
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

  it('validates media, roles, count, mode, and mixed-media combinations', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-image', data: { mediaType: 'image', mode: 'transform' } },
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
          modes: ['generate'],
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

  it('fails closed for transform mentions when modes are omitted', () => {
    const result = checkResourceMentionCapabilities({
      ...base,
      node: { id: 'node-image', data: { mediaType: 'image', mode: 'transform' } },
      model: { capabilities: { mentionMediaTypes: ['image'] } },
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE_MENTION_CAPABILITY_UNKNOWN',
          reason: 'capability_unknown',
          mentionId: 'm-image',
        }),
      ]),
    );
  });
});

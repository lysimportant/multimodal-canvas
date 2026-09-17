import { describe, expect, it } from 'vitest';

import {
  checkImageEditCapabilities,
  type ImageEditCapabilityNode,
} from './image-edit-capabilities';

const imageNode = (
  id: string,
  data: Partial<ImageEditCapabilityNode['data']> = {},
): ImageEditCapabilityNode => ({
  id,
  data: { mediaType: 'image', mode: 'generate', ...data },
});

const editEdge = {
  sourceNodeId: 'node_source',
  targetNodeId: 'node_edit',
  targetHandle: 'input:imageEdit',
};

const supportedModel = {
  mediaTypes: ['image'] as const,
  capabilities: { imageEdit: { supported: true, mimeTypes: ['image/png'] } },
};

describe('图片编辑能力预检', () => {
  it('普通图片生成节点不触发编辑能力预检', () => {
    const check = checkImageEditCapabilities({
      nodes: [imageNode('node_edit')],
      edges: [],
      targetNodeId: 'node_edit',
      modelAlias: 'image-v1',
      requestId: 'req_1',
    });

    expect(check.issues).toEqual([]);
    expect(check.frozenCapability).toBeUndefined();
  });

  it('目录未声明图片编辑时允许兼容接口处理并保留来源校验', () => {
    const nodes = [
      imageNode('node_source', { mode: 'source', assetId: 'asset_1', contentUrl: '/c' }),
      imageNode('node_edit', {
        imageEditSource: { sourceNodeId: 'node_source', assetId: 'asset_1', version: 2 },
      }),
    ];
    const check = checkImageEditCapabilities({
      nodes,
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-v1',
      model: { mediaTypes: ['image'] as const },
      requestId: 'req_2',
    });

    expect(check.issues).toEqual([]);
    expect(check.frozenCapability).toBeUndefined();
  });

  it('声明支持时冻结能力并把来源引用交回路由', () => {
    const check = checkImageEditCapabilities({
      nodes: [
        imageNode('node_source', { mode: 'source', assetId: 'asset_1', contentUrl: '/c' }),
        imageNode('node_edit', {
          imageEditSource: { sourceNodeId: 'node_source', assetId: 'asset_1', version: 2 },
        }),
      ],
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_3',
    });

    expect(check.issues).toEqual([]);
    expect(check.frozenCapability).toEqual({
      declared: true,
      mimeTypes: ['image/png'],
    });
    expect(check.source).toEqual({
      sourceNodeId: 'node_source',
      assetId: 'asset_1',
      version: 2,
    });
  });

  it('显式 false 仍阻止图片编辑', () => {
    for (const capabilities of [
      { imageEdit: false },
      { imageEdit: { supported: false } },
      { imageEdit: { supports: false } },
    ]) {
      const check = checkImageEditCapabilities({
        nodes: [
          imageNode('node_source', { mode: 'source', assetId: 'asset_1', contentUrl: '/c' }),
          imageNode('node_edit', {
            imageEditSource: { sourceNodeId: 'node_source', assetId: 'asset_1' },
          }),
        ],
        edges: [editEdge],
        targetNodeId: 'node_edit',
        modelAlias: 'image-v1',
        model: { mediaTypes: ['image'] as const, capabilities },
        requestId: 'req_4',
      });

      expect(check.issues[0]?.code).toBe('IMAGE_EDIT_CAPABILITY_UNSUPPORTED');
    }
  });

  it.each(['input:content', 'input:referenceImage'])(
    '图片 %s 连线也检查明确禁用',
    (targetHandle) => {
      const check = checkImageEditCapabilities({
        nodes: [
          imageNode('node_source', { mode: 'source', assetId: 'asset_1', contentUrl: '/c' }),
          imageNode('node_edit'),
        ],
        edges: [{ ...editEdge, targetHandle }],
        targetNodeId: 'node_edit',
        modelAlias: 'image-v1',
        model: { capabilities: { imageEdit: false } },
        requestId: 'req_ref',
      });
      expect(check.issues.map((issue) => issue.code)).toEqual([
        'IMAGE_EDIT_CAPABILITY_UNSUPPORTED',
      ]);
    },
  );

  it('只有图片提及的新节点仍冻结编辑限制，不要求原图连线', () => {
    const check = checkImageEditCapabilities({
      nodes: [imageNode('node_edit')],
      edges: [],
      targetNodeId: 'node_edit',
      modelAlias: 'image-v1',
      model: supportedModel,
      requestId: 'req_mention',
      mentions: [
        {
          nodeId: 'node_edit',
          mentionId: 'm1',
          assetId: 'asset_1',
          assetVersion: 1,
          mediaType: 'image',
          label: '原图',
          blockOrder: 0,
        },
      ],
    });
    expect(check.issues).toEqual([]);
    expect(check.frozenCapability).toEqual({ declared: true, mimeTypes: ['image/png'] });
  });

  it('来源节点被删除、换成非图片或换图时给出可修复诊断', () => {
    const editSource = { sourceNodeId: 'node_source', assetId: 'asset_1' };

    const missing = checkImageEditCapabilities({
      nodes: [imageNode('node_edit', { imageEditSource: editSource })],
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_5',
    });
    expect(missing.issues.map((issue) => issue.code)).toEqual(['IMAGE_EDIT_SOURCE_NODE_MISSING']);

    const wrongMedia = checkImageEditCapabilities({
      nodes: [
        {
          id: 'node_source',
          data: { mediaType: 'text', mode: 'source', assetId: 'asset_1' },
        },
        imageNode('node_edit', { imageEditSource: editSource }),
      ],
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_6',
    });
    expect(wrongMedia.issues.map((issue) => issue.code)).toEqual(['IMAGE_EDIT_SOURCE_NOT_IMAGE']);

    const noAsset = checkImageEditCapabilities({
      nodes: [
        imageNode('node_source', { mode: 'source' }),
        imageNode('node_edit', { imageEditSource: editSource }),
      ],
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_7',
    });
    expect(noAsset.issues.map((issue) => issue.code)).toEqual(['IMAGE_EDIT_SOURCE_ASSET_MISSING']);

    const replaced = checkImageEditCapabilities({
      nodes: [
        imageNode('node_source', {
          mode: 'source',
          assetId: 'asset_2',
          contentUrl: '/c2',
        }),
        imageNode('node_edit', { imageEditSource: editSource }),
      ],
      edges: [editEdge],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_8',
    });
    expect(replaced.issues.map((issue) => issue.code)).toEqual([
      'IMAGE_EDIT_SOURCE_ASSET_MISMATCH',
    ]);
  });

  it('有编辑来源却缺少 imageEdit 连线时阻止运行', () => {
    const check = checkImageEditCapabilities({
      nodes: [
        imageNode('node_source', { mode: 'source', assetId: 'asset_1', contentUrl: '/c' }),
        imageNode('node_edit', {
          imageEditSource: { sourceNodeId: 'node_source', assetId: 'asset_1' },
        }),
      ],
      edges: [],
      targetNodeId: 'node_edit',
      modelAlias: 'image-edit-v1',
      model: supportedModel,
      requestId: 'req_9',
    });

    expect(check.issues.map((issue) => issue.code)).toEqual(['IMAGE_EDIT_SOURCE_ASSET_MISSING']);
    expect(check.issues[0]?.message).toContain('缺少来源图连线');
  });
});

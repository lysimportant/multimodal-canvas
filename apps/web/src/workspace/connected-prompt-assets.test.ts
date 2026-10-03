import { describe, expect, it } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import {
  collectConnectedPromptAssets,
  createSelectedNodesPromptDocument,
} from './connected-prompt-assets';

const parent = {
  id: 'node_parent',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    label: '原图',
    mediaType: 'image',
    mode: 'generate',
    resultAsset: {
      assetId: 'asset_result',
      version: 2,
      contentUrl: '/v1/assets/asset_result/versions/2/content',
      mimeType: 'image/png',
    },
  },
} as AssetFlowNode;

const child = {
  id: 'node_child',
  type: 'image',
  position: { x: 120, y: 0 },
  data: {
    label: '修改 原图',
    mediaType: 'image',
    mode: 'generate',
    imageEditSource: { sourceNodeId: 'node_parent', assetId: 'asset_result', version: 2 },
  },
} as AssetFlowNode;

describe('collectConnectedPromptAssets', () => {
  it('生成结果缺少版本时不借用目录最新版本来伪造冻结身份', () => {
    const source = {
      ...parent,
      data: {
        ...parent.data,
        resultAsset: { assetId: 'asset_result', contentUrl: '/v1/assets/asset_result/content' },
      },
    };
    const catalog = {
      id: 'asset_result',
      name: 'generated',
      mediaType: 'image',
      mimeType: 'image/png',
      status: 'ready',
      sizeBytes: 1,
      tags: [],
      latestVersion: 9,
      contentUrl: '/v1/assets/asset_result/versions/9/content',
    } as Asset;
    const result = collectConnectedPromptAssets(
      child.id,
      [source, child],
      [{ id: 'input', source: parent.id, target: child.id, targetHandle: 'input:referenceImage' }],
      [catalog],
    );
    expect(result[0].assetVersion).toBeUndefined();
  });

  it('同名来源按节点连线和资产版本解析，冻结版本的预览不读取目录最新内容', () => {
    const second = {
      ...parent,
      id: 'other-source',
      data: { ...parent.data, resultAsset: { assetId: 'other-asset', version: 1 } },
    };
    const historical = {
      ...parent,
      id: 'historical-source',
      data: { ...parent.data, resultAsset: { assetId: 'asset_result', version: 1 } },
    };
    const sources = [parent, second, historical];
    const edges = sources.map((source) => ({
      id: source.id,
      source: source.id,
      target: child.id,
      targetHandle: 'input:referenceImage',
    }));
    const assets = [
      {
        id: 'asset_result',
        name: '同名',
        mediaType: 'image',
        mimeType: 'image/png',
        status: 'ready',
        sizeBytes: 1,
        tags: [],
        latestVersion: 9,
        contentUrl: '/v1/assets/asset_result/versions/9/content',
      },
    ] as Asset[];
    const result = collectConnectedPromptAssets(child.id, [...sources, child], edges, assets);
    expect(result.map((asset) => [asset.id, asset.assetVersion])).toEqual([
      ['asset_result', 2],
      ['other-asset', 1],
      ['asset_result', 1],
    ]);
    expect(result[0].contentUrl).toBe('/v1/assets/asset_result/versions/2/content');
    expect(result[2].contentUrl).toBe('/v1/assets/asset_result/versions/1/content');
  });

  it('目标引用已冻结的历史版本不被更新后的来源节点或目录覆盖', () => {
    const target = {
      ...child,
      data: {
        ...child.data,
        resourceRefs: [
          {
            id: 'connected:asset_result',
            assetId: 'asset_result',
            mediaType: 'image' as const,
            name: '良',
            assetVersion: 1,
          },
        ],
      },
    };
    const result = collectConnectedPromptAssets(
      child.id,
      [parent, target],
      [{ id: 'input', source: parent.id, target: child.id, targetHandle: 'input:referenceImage' }],
    );
    expect(result[0]).toMatchObject({
      id: 'asset_result',
      assetVersion: 1,
      referenceName: '良',
      contentUrl: '/v1/assets/asset_result/versions/1/content',
    });
  });

  it('目标节点的连线别名独立于源名称，断开连线后不留下资源', () => {
    const namedChild = {
      ...child,
      data: {
        ...child.data,
        resourceRefs: [
          {
            id: 'connected:asset_result',
            assetId: 'asset_result',
            mediaType: 'image' as const,
            name: '主角',
          },
        ],
      },
    };
    const edges = [
      { id: 'ref', source: parent.id, target: child.id, targetHandle: 'input:content' },
    ] as FlowEdge[];
    expect(collectConnectedPromptAssets(child.id, [parent, namedChild], edges)[0]).toMatchObject({
      id: 'asset_result',
      name: '原图',
      referenceName: '主角',
    });
    expect(collectConnectedPromptAssets(child.id, [parent, namedChild], [])).toEqual([]);
    expect(parent.data.label).toBe('原图');
  });
  it('兼容导入的引用身份，同时优先读取连线别名', () => {
    const legacyReference = {
      id: 'imported-reference',
      assetId: 'asset_result',
      mediaType: 'image' as const,
      name: '旧别名',
      assetVersion: 2,
    };
    const namedChild = {
      ...child,
      data: { ...child.data, resourceRefs: [legacyReference] },
    };
    const edges = [
      { id: 'ref', source: parent.id, target: child.id, targetHandle: 'input:content' },
    ] as FlowEdge[];
    expect(
      collectConnectedPromptAssets(child.id, [parent, namedChild], edges)[0]?.referenceName,
    ).toBe('旧别名');
    namedChild.data.resourceRefs.push({
      ...legacyReference,
      id: 'connected:asset_result',
      name: '主角',
    });
    expect(
      collectConnectedPromptAssets(child.id, [parent, namedChild], edges)[0]?.referenceName,
    ).toBe('主角');
  });

  it('does not put imageEdit originals into the prompt resource strip', () => {
    const edges = [
      {
        id: 'edge_edit',
        source: 'node_parent',
        target: 'node_child',
        targetHandle: 'input:imageEdit',
      },
    ] as FlowEdge[];
    expect(collectConnectedPromptAssets('node_child', [parent, child], edges)).toEqual([]);
  });

  it('fills generated result URLs so connected prompt inputs can preview', () => {
    const ref = {
      ...parent,
      id: 'node_ref',
      data: { ...parent.data, label: '参考图' },
    } as AssetFlowNode;
    const edges = [
      {
        id: 'edge_ref',
        source: 'node_ref',
        target: 'node_child',
        targetHandle: 'input:content',
      },
    ] as FlowEdge[];
    expect(collectConnectedPromptAssets('node_child', [ref, child], edges)).toEqual([
      {
        id: 'asset_result',
        sourceNodeId: 'node_ref',
        name: '参考图',
        assetVersion: 2,
        mediaType: 'image',
        contentUrl: '/v1/assets/asset_result/versions/2/content',
        mimeType: 'image/png',
        status: 'ready',
        sizeBytes: 0,
        tags: [],
      },
    ]);
  });

  it('prefers catalog identity when the connected result is a project asset', () => {
    const assets = [
      {
        id: 'asset_upload',
        name: 'catalog.png',
        mediaType: 'image',
        mimeType: 'image/png',
        sizeBytes: 12,
        status: 'ready',
        contentUrl: '/v1/assets/asset_upload/content',
        tags: ['ref'],
      },
    ] as Asset[];
    const source = {
      id: 'node_upload',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '上传图',
        mediaType: 'image',
        mode: 'source',
        assetId: 'asset_upload',
        contentUrl: '/v1/assets/asset_upload/content',
        mimeType: 'image/png',
      },
    } as AssetFlowNode;
    const edges = [
      {
        id: 'edge_content',
        source: 'node_upload',
        target: 'node_child',
        targetHandle: 'input:content',
      },
    ] as FlowEdge[];
    expect(
      collectConnectedPromptAssets('node_child', [source, child], edges, assets)[0],
    ).toMatchObject({
      id: 'asset_upload',
      name: 'catalog.png',
      status: 'ready',
      contentUrl: '/v1/assets/asset_upload/content',
    });
  });
});

/** 选区创建只绑定真实资产，正文、版本和来源节点都不可被替换。 */
describe('createSelectedNodesPromptDocument', () => {
  it('按资产和版本去重，同名不同身份及不同历史版本都保留', () => {
    const sources: AssetFlowNode[] = [
      parent,
      { ...parent, id: 'duplicate' },
      {
        ...parent,
        id: 'historical',
        data: { ...parent.data, resultAsset: { assetId: 'asset_result', version: 1 } },
      },
      {
        ...parent,
        id: 'another',
        data: { ...parent.data, resultAsset: { assetId: 'different-asset', version: 2 } },
      },
    ];
    const before = structuredClone(sources);
    const document = createSelectedNodesPromptDocument(sources, []);
    const mentions = document.blocks.filter((block) => block.type === 'mention');
    expect(mentions.map(({ assetId, assetVersion }) => [assetId, assetVersion])).toEqual([
      ['asset_result', 2],
      ['asset_result', 1],
      ['different-asset', 2],
    ]);
    expect(new Set(mentions.map((mention) => mention.mentionId)).size).toBe(3);
    expect(mentions.every((mention) => mention.label === parent.data.label)).toBe(true);
    expect(sources).toEqual(before);
  });

  it('四种媒体均保留结构化身份，不将来源提示词当成已生成素材', () => {
    const sources = (['text', 'image', 'audio', 'video'] as const).map((mediaType) => ({
      ...parent,
      id: mediaType,
      type: mediaType,
      data: {
        ...parent.data,
        mediaType,
        prompt: '不能复制的来源指令',
        resultAsset: { assetId: mediaType + '-asset', version: 3 },
      },
    }));
    const document = createSelectedNodesPromptDocument(sources, []);
    expect(
      document.blocks.filter((block) => block.type === 'mention').map((block) => block.mediaType),
    ).toEqual(['text', 'image', 'audio', 'video']);
    expect(JSON.stringify(document)).not.toContain('不能复制');
  });

  it('上传来源采用当前展示版本，没有版本 URL 时才用目录明确版本', () => {
    const catalog = {
      id: 'uploaded',
      name: '上传',
      mediaType: 'image',
      status: 'ready',
      latestVersion: 9,
    } as Asset;
    const source: AssetFlowNode = {
      ...parent,
      data: {
        label: '上传图片',
        mediaType: 'image',
        mode: 'source',
        assetId: 'uploaded',
        contentUrl: '/v1/assets/uploaded/versions/4/content',
      },
    };
    expect(createSelectedNodesPromptDocument([source], [catalog]).blocks[0]).toMatchObject({
      assetVersion: 4,
    });
    expect(
      createSelectedNodesPromptDocument(
        [{ ...source, data: { ...source.data, contentUrl: undefined } }],
        [catalog],
      ).blocks[0],
    ).toMatchObject({ assetVersion: 9 });
  });

  it('手动保存后的资源身份不被旧生成结果替代', () => {
    const source = {
      ...parent,
      data: {
        ...parent.data,
        manualOutput: true,
        assetId: 'manual',
        contentUrl: '/v1/assets/manual/versions/5/content',
      },
    };
    expect(createSelectedNodesPromptDocument([source], []).blocks[0]).toMatchObject({
      assetId: 'manual',
      assetVersion: 5,
    });
  });

  it('空素材、未归档文字和版本不明均整次拒绝，不返回部分引用或借用生成结果最新版', () => {
    const empty: AssetFlowNode = {
      ...parent,
      data: {
        label: '空节点',
        mediaType: 'text',
        mode: 'generate',
        prompt: '只有文字，没有真实素材',
      },
    };
    expect(() => createSelectedNodesPromptDocument([], [])).toThrow('请先选择');
    expect(() => createSelectedNodesPromptDocument([parent, empty], [])).toThrow('空节点');
    const unknown = {
      ...parent,
      data: { ...parent.data, resultAsset: { assetId: 'asset_result' } },
    };
    expect(() =>
      createSelectedNodesPromptDocument(
        [unknown],
        [{ id: 'asset_result', mediaType: 'image', status: 'ready', latestVersion: 99 } as Asset],
      ),
    ).toThrow('版本未知');
  });

  it.each([
    { status: 'failed' },
    { status: 'ready', archivedAt: '2026-10-01T00:00:00.000Z' },
    { status: 'ready', mediaType: 'audio' },
  ])('不使用不可用或类型不符的资源：%j', (override) => {
    const asset = { id: 'asset_result', mediaType: 'image', ...override } as Asset;
    expect(() => createSelectedNodesPromptDocument([parent], [asset])).toThrow('资源不可用');
  });
});

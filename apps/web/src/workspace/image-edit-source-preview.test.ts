import { describe, expect, it } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import {
  imageEditSourcePreviewAsset,
  resolveImageEditSourcePreview,
} from './image-edit-source-preview';

function imageNode(
  overrides: { id?: string; data?: Partial<AssetFlowNode['data']> } = {},
): AssetFlowNode {
  return {
    id: overrides.id ?? 'node_image',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      label: '原图',
      mediaType: 'image',
      mode: 'generate',
      ...overrides.data,
    },
  } as AssetFlowNode;
}

describe('resolveImageEditSourcePreview', () => {
  it('生成结果不在目录里时仍用来源节点回显地址', () => {
    const parent = imageNode({
      id: 'node_parent',
      data: {
        resultAsset: {
          assetId: 'asset_result',
          version: 2,
          contentUrl: '/v1/assets/asset_result/versions/2/content',
          mimeType: 'image/png',
        },
      },
    });
    const child = imageNode({
      id: 'node_child',
      data: {
        label: '修改 原图',
        imageEditSource: {
          sourceNodeId: 'node_parent',
          assetId: 'asset_result',
          version: 2,
          sourceKind: 'result',
        },
      },
    });
    expect(resolveImageEditSourcePreview(child, [parent, child])).toMatchObject({
      assetId: 'asset_result',
      sourceNodeId: 'node_parent',
      name: '原图',
      contentUrl: '/v1/assets/asset_result/versions/2/content',
      mimeType: 'image/png',
      version: 2,
      versionUnavailable: false,
    });
  });

  it('上传来源用节点 contentUrl，并补齐目录名', () => {
    const parent = imageNode({
      id: 'node_upload',
      data: {
        mode: 'source',
        label: '上传图',
        assetId: 'asset_upload',
        contentUrl: '/v1/assets/asset_upload/content',
        mimeType: 'image/png',
      },
    });
    const child = imageNode({
      id: 'node_child',
      data: {
        imageEditSource: {
          sourceNodeId: 'node_upload',
          assetId: 'asset_upload',
          sourceKind: 'asset',
        },
      },
    });
    const assets = [
      {
        id: 'asset_upload',
        name: 'catalog.png',
        mediaType: 'image',
        mimeType: 'image/png',
        sizeBytes: 12,
        status: 'ready',
        contentUrl: '/v1/assets/asset_upload/content',
        tags: [],
      },
    ] as Asset[];
    expect(resolveImageEditSourcePreview(child, [parent, child], assets)).toMatchObject({
      assetId: 'asset_upload',
      name: '上传图',
      contentUrl: '/v1/assets/asset_upload/content',
      versionUnavailable: false,
    });
  });

  it('没有 contentUrl 的结果也能拼出版本化内容路径', () => {
    const parent = imageNode({
      id: 'node_parent',
      data: {
        resultAsset: { assetId: 'asset_result', version: 3 },
      },
    });
    const child = imageNode({
      id: 'node_child',
      data: {
        imageEditSource: {
          sourceNodeId: 'node_parent',
          assetId: 'asset_result',
          version: 3,
          sourceKind: 'result',
        },
      },
    });
    expect(resolveImageEditSourcePreview(child, [parent, child])?.contentUrl).toBe(
      '/v1/assets/asset_result/versions/3/content',
    );
  });
});

describe('imageEditSourcePreviewAsset', () => {
  it('没有内容地址时不能预览', () => {
    expect(
      imageEditSourcePreviewAsset({
        assetId: 'asset_1',
        sourceNodeId: 'node_1',
        name: '原图',
      }),
    ).toBeUndefined();
  });

  it('收成可供 AssetPreview 签名的图片资源', () => {
    expect(
      imageEditSourcePreviewAsset({
        assetId: 'asset_1',
        sourceNodeId: 'node_1',
        name: '原图',
        contentUrl: '/v1/assets/asset_1/versions/2/content',
        mimeType: 'image/png',
        version: 2,
      }),
    ).toMatchObject({
      id: 'asset_1',
      name: '原图',
      mediaType: 'image',
      mimeType: 'image/png',
      status: 'ready',
      contentUrl: '/v1/assets/asset_1/versions/2/content',
      latestVersion: 2,
    });
  });
});

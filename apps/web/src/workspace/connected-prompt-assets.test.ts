import { describe, expect, it } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { collectConnectedPromptAssets } from './connected-prompt-assets';

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
        name: '参考图',
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

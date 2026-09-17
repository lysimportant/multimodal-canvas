import { describe, expect, it } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import { nodeEchoAssetVersion } from './node-echo-text';

/** 保存来源节点的固定版本，防止反推错误回退最新资产。 */
const source: AssetFlowNode = {
  id: 'node-a',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    mediaType: 'image',
    mode: 'source',
    label: '旧图',
    assetId: 'asset-a',
    contentUrl: '/v1/assets/asset-a/versions/1/content',
  },
};

describe('当前回显版本', () => {
  it('来源与手动覆盖使用明确版本 URL，忽略被覆盖的旧生成结果', () => {
    expect(nodeEchoAssetVersion(source)).toBe(1);
    expect(
      nodeEchoAssetVersion({
        ...source,
        data: {
          ...source.data,
          manualOutput: true,
          resultAsset: { assetId: 'other', version: 3, mimeType: 'image/png', sizeBytes: 1 },
        },
      }),
    ).toBe(1);
  });
  it('生成结果使用当前结果版本，未版本化或其他资产 URL 不假设版本', () => {
    expect(
      nodeEchoAssetVersion({
        ...source,
        data: {
          ...source.data,
          resultAsset: { assetId: 'other', version: 3, mimeType: 'image/png', sizeBytes: 1 },
        },
      }),
    ).toBe(3);
    for (const contentUrl of ['/v1/assets/other/versions/8/content', '/v1/assets/asset-a/content'])
      expect(
        nodeEchoAssetVersion({ ...source, data: { ...source.data, contentUrl } }),
      ).toBeUndefined();
  });
});

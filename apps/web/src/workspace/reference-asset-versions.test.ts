import { describe, expect, it, vi } from 'vitest';

import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { createSelectedNodesPromptDocument } from './connected-prompt-assets';
import { ensureReferenceAssetVersions } from './reference-asset-versions';

/** 画布上传来源：内容地址不带版本，索引里通常没有它的最新版。 */
const source = {
  id: 'node_source',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    label: '6.png',
    mediaType: 'image',
    mode: 'source',
    assetId: 'asset_6',
    mimeType: 'image/png',
    contentUrl: '/v1/assets/asset_6/content',
  },
} as AssetFlowNode;

/** 不带 latestVersion 的种子快照，模拟页外资源尚未加载。 */
const seed = {
  id: 'asset_6',
  name: '6.png',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 7,
  status: 'ready',
  contentUrl: '/v1/assets/asset_6/content',
  tags: [],
} as Asset;

function versionSummary(version: number) {
  return {
    id: `asset_6-v${version}`,
    assetId: 'asset_6',
    version,
    sizeBytes: 7,
    createdAt: '2026-10-25T05:41:29.504Z',
    contentUrl: `/v1/assets/asset_6/versions/${version}/content`,
  };
}

function fetcherReturning(versions: unknown[]) {
  return vi.fn<typeof fetch>(async () => Response.json({ versions }));
}

describe('ensureReferenceAssetVersions', () => {
  it('为页外来源读取最新版本并合并进本次引用目录', async () => {
    const fetcher = fetcherReturning([versionSummary(1), versionSummary(2)]);
    const result = await ensureReferenceAssetVersions([source], [seed], {
      apiBaseUrl: 'http://api.test/',
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('http://api.test/v1/assets/asset_6/versions');
    expect(result.resolved).toEqual([{ ...seed, latestVersion: 2 }]);
    expect(result.assets.find((asset) => asset.id === 'asset_6')?.latestVersion).toBe(2);
    expect(createSelectedNodesPromptDocument([source], result.assets).blocks[0]).toMatchObject({
      type: 'mention',
      assetId: 'asset_6',
      assetVersion: 2,
    });
  });

  it('目录已带最新版时不发请求也不改索引', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const assets = [{ ...seed, latestVersion: 1 }];
    const result = await ensureReferenceAssetVersions([source], assets, { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ assets, resolved: [] });
  });

  it('目录完全缺少该资源时用画布快照补齐内容地址', async () => {
    const fetcher = fetcherReturning([versionSummary(1)]);
    const result = await ensureReferenceAssetVersions([source], [], {
      apiBaseUrl: 'http://api.test',
      fetcher,
    });
    expect(result.resolved).toEqual([
      expect.objectContaining({
        id: 'asset_6',
        name: '6.png',
        mediaType: 'image',
        mimeType: 'image/png',
        status: 'ready',
        contentUrl: '/v1/assets/asset_6/content',
        latestVersion: 1,
      }),
    ]);
  });

  it('版本列表为空时仍按版本未知拒绝', async () => {
    const fetcher = fetcherReturning([]);
    await expect(
      ensureReferenceAssetVersions([source], [seed], { apiBaseUrl: 'http://api.test', fetcher }),
    ).rejects.toThrow('「6.png」的资源版本未知，请先确认当前素材');
  });

  it('版本读取失败时给出可展示的提示', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: '合成失败' }, { status: 500 }),
    );
    await expect(
      ensureReferenceAssetVersions([source], [seed], { apiBaseUrl: 'http://api.test', fetcher }),
    ).rejects.toThrow('「6.png」的资源版本读取失败，请稍后重试');
  });

  it('生成结果的冻结版本不能借目录最新版补齐', async () => {
    const generated = {
      ...source,
      data: {
        ...source.data,
        mode: 'generate',
        resultAsset: {
          assetId: 'asset_6',
          contentUrl: '/v1/assets/asset_6/content',
          mimeType: 'image/png',
        },
      },
    } as AssetFlowNode;
    const fetcher = vi.fn<typeof fetch>();
    const result = await ensureReferenceAssetVersions([generated], [seed], { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({ assets: [seed], resolved: [] });
  });
});

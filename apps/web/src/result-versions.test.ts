import { describe, expect, it, vi } from 'vitest';

import { fetchAssetVersions } from './result-versions';

const version = (number: number) => ({
  id: `asset-result_version_${number}`,
  assetId: 'asset-result',
  version: number,
  sizeBytes: number * 10,
  createdAt: `2026-08-26T00:0${number}:00.000Z`,
  contentUrl: `/v1/assets/asset-result/versions/${number}/content`,
});

describe('fetchAssetVersions', () => {
  it('loads and sorts immutable version summaries from the API', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ versions: [version(2), version(1)] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      fetchAssetVersions('asset-result', 'http://localhost:3000/', fetcher),
    ).resolves.toEqual([version(1), version(2)]);
    expect(fetcher).toHaveBeenCalledWith('http://localhost:3000/v1/assets/asset-result/versions');
  });

  it('returns a clear error for an unavailable or malformed response', async () => {
    const unavailable = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: 'asset not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      fetchAssetVersions('missing', 'http://localhost:3000', unavailable),
    ).rejects.toThrow('asset not found');

    const malformed = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ versions: [{ version: 1 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      fetchAssetVersions('asset-result', 'http://localhost:3000', malformed),
    ).rejects.toThrow('结果版本响应格式无效');
  });
});

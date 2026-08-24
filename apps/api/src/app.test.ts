import { afterAll, describe, expect, it } from 'vitest';

import { MemoryAssetStore } from './assets';
import { buildApp } from './app';

const app = buildApp({ logger: false, assetStore: new MemoryAssetStore() });

afterAll(async () => app.close());

describe('health endpoint', () => {
  it('reports that the API is available', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
  });
});

describe('asset endpoints', () => {
  it('starts with an empty asset collection', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/assets' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [] });
  });

  it('uploads an asset and serves its original content', async () => {
    const boundary = 'asset-test-boundary';
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(upload.statusCode).toBe(201);
    const uploadedAsset = upload.json().asset;
    expect(uploadedAsset).toMatchObject({
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: content.byteLength,
      status: 'ready',
    });

    const contentResponse = await app.inject({
      method: 'GET',
      url: uploadedAsset.contentUrl,
    });

    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.headers['content-type']).toContain('image/png');
    expect(contentResponse.rawPayload).toEqual(content);
  });

  it('rejects unsupported uploads', async () => {
    const boundary = 'unsupported-asset-boundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\narchive\r\n--${boundary}--\r\n`,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupported media type' });
  });
});

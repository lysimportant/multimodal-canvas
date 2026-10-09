import { describe, expect, it } from 'vitest';
import { verifyProviderAssetAccessToken } from '@multimodal-canvas/credential-crypto';
import { createProviderAssetUrlSignerFromEnvironment } from './provider-asset-url';

describe('本站 Provider 素材地址', () => {
  it('自动复用网站 HTTPS 来源和现有密钥，不需要 S3 公网配置', () => {
    const sign = createProviderAssetUrlSignerFromEnvironment({
      CANVAS_WEB_URL: 'https://canvas.example.com/workspace',
      API_JWT_SECRET: 'synthetic-provider-assets-secret',
    });
    const scope = { assetId: 'asset-1', version: 2, projectId: 'project-1', ownerId: 'owner-1' };
    const url = new URL(sign!(scope));
    expect(url.origin).toBe('https://canvas.example.com');
    expect(url.pathname).toBe('/v1/provider-assets/asset-1/versions/2/content');
    expect(
      verifyProviderAssetAccessToken(
        url.searchParams.get('access_token')!,
        'synthetic-provider-assets-secret',
      ),
    ).toMatchObject(scope);
    expect(url.toString()).not.toContain('synthetic-provider-assets-secret');
  });

  it('API 与 Worker 均优先复用专用素材密钥', () => {
    const sign = createProviderAssetUrlSignerFromEnvironment({
      CANVAS_WEB_URL: 'https://canvas.example.com',
      API_JWT_SECRET: 'synthetic-jwt-secret',
      ASSET_ACCESS_URL_SECRET: 'synthetic-asset-secret',
    });
    const token = new URL(
      sign!({ assetId: 'asset-1', version: 1, projectId: null, ownerId: 'owner-1' }),
    ).searchParams.get('access_token')!;
    expect(verifyProviderAssetAccessToken(token, 'synthetic-asset-secret')).toBeDefined();
    expect(verifyProviderAssetAccessToken(token, 'synthetic-jwt-secret')).toBeUndefined();
  });

  it.each([
    undefined,
    'http://localhost:8080',
    'https://localhost',
    'https://localhost.',
    'http://canvas.example.com',
    'https://10.0.0.1',
    'https://objects.internal:9000',
    'https://user:pass@canvas.example.com',
    'https://canvas.example.com?redirect=other',
    'https://canvas.example.com#fragment',
  ])('不为不可公开读取的网站来源 %s 生成链接', (webUrl) => {
    expect(
      createProviderAssetUrlSignerFromEnvironment({
        CANVAS_WEB_URL: webUrl,
        API_JWT_SECRET: 'synthetic-jwt-secret',
      }),
    ).toBeUndefined();
  });

  it('缺少稳定签名密钥时保持关闭', () => {
    expect(
      createProviderAssetUrlSignerFromEnvironment({ CANVAS_WEB_URL: 'https://canvas.example.com' }),
    ).toBeUndefined();
  });

  it('不采信请求来源一类的额外环境字段来推断域名', () => {
    expect(
      createProviderAssetUrlSignerFromEnvironment({
        HTTP_HOST: 'attacker.example.com',
        HTTP_X_FORWARDED_HOST: 'attacker.example.com',
        API_JWT_SECRET: 'synthetic-jwt-secret',
      }),
    ).toBeUndefined();
  });
});

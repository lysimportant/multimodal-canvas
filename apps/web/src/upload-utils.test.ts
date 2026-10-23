import { describe, expect, it } from 'vitest';

import {
  assertUploadSize,
  buildUploadCompletePayload,
  buildUploadInitPayload,
  isApiOriginUrl,
  resolveCompleteUrl,
  resolveUploadUrl,
  sha256Hex,
  uploadFailureMessage,
  MAX_UPLOAD_SIZE_BYTES,
} from './upload-utils';

const metadata = {
  name: 'sample.png',
  mimeType: 'image/png',
  sizeBytes: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
};

describe('upload protocol helpers', () => {
  it('accepts exactly 512 MB and rejects larger files before reading content', () => {
    expect(() =>
      assertUploadSize({ name: 'boundary.bin', size: MAX_UPLOAD_SIZE_BYTES }),
    ).not.toThrow();
    expect(() => assertUploadSize({ name: 'large.bin', size: MAX_UPLOAD_SIZE_BYTES + 1 })).toThrow(
      '512 MB',
    );
  });

  it('explains upload timeout, expired sessions and rejected sizes in Chinese', () => {
    expect(uploadFailureMessage('a.png', 410, 'upload_expired')).toContain('上传会话已过期');
    expect(uploadFailureMessage('a.png', 413)).toContain('512 MB');
    expect(uploadFailureMessage('a.png', 408)).toContain('上传超时');
    expect(uploadFailureMessage('a.png', 504)).toContain('上传超时');
    expect(uploadFailureMessage('a.png', 401)).toContain('重新登录');
    expect(uploadFailureMessage('a.png', 500, '服务器繁忙')).toBe('服务器繁忙');
  });
  it('computes the lowercase SHA-256 digest used for upload deduplication', async () => {
    expect(await sha256Hex(new TextEncoder().encode('hello'))).toBe(metadata.sha256);
  });

  it('builds matching init and completion payloads from one metadata snapshot', () => {
    expect(buildUploadInitPayload(metadata)).toEqual(metadata);
    expect(buildUploadCompletePayload('upload-123', metadata)).toEqual({
      uploadId: 'upload-123',
      ...metadata,
    });
  });

  it('resolves API-relative upload URLs without altering presigned absolute URLs', () => {
    expect(resolveUploadUrl('/uploads/object', 'https://api.example.test')).toBe(
      'https://api.example.test/uploads/object',
    );
    expect(
      resolveUploadUrl(
        'https://storage.example.test/object?signature=x',
        'https://api.example.test',
      ),
    ).toBe('https://storage.example.test/object?signature=x');
    expect(resolveCompleteUrl('v1/assets/uploads/complete', 'https://api.example.test')).toBe(
      'https://api.example.test/v1/assets/uploads/complete',
    );
    expect(resolveCompleteUrl('/v1/assets/uploads/complete', 'https://api.example.test')).toBe(
      'https://api.example.test/v1/assets/uploads/complete',
    );
  });

  it('空 API 基址把当前站点当作同源 API，不把当前页面路径当成 API 根', () => {
    const page = 'http://127.0.0.1:8080/projects/demo';
    expect(isApiOriginUrl('/v1/assets/asset_1/content', '', page)).toBe(true);
    expect(isApiOriginUrl('/v1/assets/asset_1/versions/2/content', '', page)).toBe(true);
    expect(isApiOriginUrl('https://cdn.example/result.png', '', page)).toBe(false);
    expect(
      isApiOriginUrl(
        '/v1/assets/asset_1/content',
        'http://localhost:3000',
        'http://127.0.0.1:5173/projects/demo',
      ),
    ).toBe(false);
    expect(
      isApiOriginUrl(
        'http://localhost:3000/v1/assets/asset_1/content',
        'http://localhost:3000',
        'http://127.0.0.1:5173/projects/demo',
      ),
    ).toBe(true);
  });
});

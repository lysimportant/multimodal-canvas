import { describe, expect, it } from 'vitest';

import {
  buildUploadCompletePayload,
  buildUploadInitPayload,
  resolveCompleteUrl,
  resolveUploadUrl,
  sha256Hex,
} from './upload-utils';

const metadata = {
  name: 'sample.png',
  mimeType: 'image/png',
  sizeBytes: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
};

describe('upload protocol helpers', () => {
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
});

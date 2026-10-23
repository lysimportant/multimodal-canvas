import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { DIRECT_UPLOAD_TTL_MS, MemoryUploadSessionStore } from './upload-sessions';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const content = Buffer.from('upload limit fixture');
const metadata = {
  name: 'fixture.txt',
  mimeType: 'text/plain',
  sizeBytes: content.byteLength,
  sha256: createHash('sha256').update(content).digest('hex'),
};

afterEach(() => vi.restoreAllMocks());

describe('asset upload limits', () => {
  it('accepts the 512 MB metadata boundary and rejects a byte above it before creating a session', async () => {
    const uploadSessionStore = new MemoryUploadSessionStore();
    const create = vi.spyOn(uploadSessionStore, 'create');
    const app = buildApp({ logger: false, uploadSessionStore });
    try {
      const boundary = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/init',
        payload: { ...metadata, sizeBytes: MAX_UPLOAD_BYTES },
      });
      expect(boundary.statusCode).toBe(201);
      const above = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/init',
        payload: { ...metadata, sizeBytes: MAX_UPLOAD_BYTES + 1 },
      });
      expect(above.statusCode).toBe(413);
      expect(above.json()).toMatchObject({ code: 'upload_too_large', maxBytes: MAX_UPLOAD_BYTES });
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects oversized completion metadata before fetching stored bytes', async () => {
    const uploadSessionStore = new MemoryUploadSessionStore();
    const getContent = vi.spyOn(uploadSessionStore, 'getContent');
    const app = buildApp({ logger: false, uploadSessionStore });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/complete',
        payload: { ...metadata, uploadId: 'upload_fixture', sizeBytes: MAX_UPLOAD_BYTES + 1 },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        code: 'upload_too_large',
        maxBytes: MAX_UPLOAD_BYTES,
      });
      expect(getContent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an oversized PUT content length without allocating a large payload', async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/assets/uploads/upload_fixture',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(MAX_UPLOAD_BYTES + 1),
        },
        payload: content,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        code: 'upload_too_large',
        maxBytes: MAX_UPLOAD_BYTES,
      });
    } finally {
      await app.close();
    }
  });

  it('returns an actionable upload error when the multipart file limit is reached', async () => {
    const app = buildApp({ logger: false });
    app.addHook('onRequest', async (request) => {
      if (request.url === '/v1/assets/uploads') {
        throw new app.multipartErrors.RequestFileTooLargeError();
      }
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/assets/uploads' });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        code: 'upload_too_large',
        maxBytes: MAX_UPLOAD_BYTES,
      });
    } finally {
      await app.close();
    }
  });

  it('checks external storage byte size again before completing and removes rejected content', async () => {
    const uploadSessionStore = new MemoryUploadSessionStore();
    const oversized = Buffer.from('small synthetic fixture');
    Object.defineProperty(oversized, 'byteLength', { value: MAX_UPLOAD_BYTES + 1 });
    vi.spyOn(uploadSessionStore, 'getContent').mockResolvedValue(oversized);
    const remove = vi.spyOn(uploadSessionStore, 'delete');
    const app = buildApp({ logger: false, uploadSessionStore });
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/init',
        payload: metadata,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/complete',
        payload: { ...metadata, uploadId: init.json().uploadId },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().code).toBe('upload_too_large');
      expect(remove).toHaveBeenCalledWith(init.json().uploadId, expect.any(Object));
    } finally {
      await app.close();
    }
  });

  it('rejects a stored payload whose byte count differs from the initialized metadata', async () => {
    const uploadSessionStore = new MemoryUploadSessionStore();
    const app = buildApp({ logger: false, uploadSessionStore });
    try {
      const init = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/init',
        payload: { ...metadata, sizeBytes: content.byteLength + 1 },
      });
      await uploadSessionStore.putContent(init.json().uploadId, content);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/assets/uploads/complete',
        payload: { ...metadata, uploadId: init.json().uploadId, sizeBytes: content.byteLength + 1 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('integrity');
    } finally {
      await app.close();
    }
  });

  it.each(['PUT', 'POST'] as const)(
    'reports expired %s sessions and removes only the expired session',
    async (method) => {
      const uploadSessionStore = new MemoryUploadSessionStore({
        now: () => Date.now() - DIRECT_UPLOAD_TTL_MS - 1,
      });
      const app = buildApp({ logger: false, uploadSessionStore });
      try {
        const init = await app.inject({
          method: 'POST',
          url: '/v1/assets/uploads/init',
          payload: metadata,
        });
        const { uploadId, uploadUrl, completeUrl } = init.json();
        const response = await app.inject(
          method === 'PUT'
            ? {
                method,
                url: uploadUrl,
                headers: { 'content-type': 'application/octet-stream' },
                payload: content,
              }
            : { method, url: completeUrl, payload: { ...metadata, uploadId } },
        );
        expect(response.statusCode).toBe(410);
        expect(response.json().code).toBe('upload_expired');
        expect(await uploadSessionStore.get(uploadId)).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );
});

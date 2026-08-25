import { describe, expect, it } from 'vitest';

import { MemoryBlobStore } from './assets';
import { MemoryUploadSessionStore, PrismaUploadSessionStore } from './upload-sessions';

const input = {
  name: 'reference.txt',
  mimeType: 'text/plain',
  mediaType: 'text' as const,
  sizeBytes: 5,
  sha256: 'a'.repeat(64),
  tags: ['reference'],
};

describe('UploadSessionStore', () => {
  it('keeps memory sessions isolated and returns a development upload URL', async () => {
    let now = 1_000;
    const store = new MemoryUploadSessionStore({
      now: () => now,
      uploadUrl: (uploadId) => `/v1/assets/uploads/${uploadId}`,
    });
    const session = await store.create(input);
    expect(session.expiresAt).toBe(1_000 + 15 * 60 * 1000);
    expect(await store.getUploadUrl(session.uploadId)).toBe(
      `/v1/assets/uploads/${session.uploadId}`,
    );

    const bytes = Buffer.from('hello');
    await store.putContent(session.uploadId, bytes);
    bytes[0] = 0;
    expect(await store.getContent(session.uploadId)).toEqual(Buffer.from('hello'));
    expect((await store.get(session.uploadId))?.tags).toEqual(['reference']);

    now += 15 * 60 * 1000;
    expect((await store.get(session.uploadId))?.expiresAt).toBe(901_000);
    await store.delete(session.uploadId);
    expect(await store.get(session.uploadId)).toBeUndefined();
  });

  it('does not let one owner read or complete another owner session', async () => {
    const store = new MemoryUploadSessionStore();
    const session = await store.create({ ...input, ownerId: 'user_a' });

    expect(await store.get(session.uploadId, { ownerId: 'user_b' })).toBeUndefined();
    await expect(
      store.putContent(session.uploadId, Buffer.from('hello'), { ownerId: 'user_b' }),
    ).rejects.toThrow('upload session not found');
    expect(await store.getUploadUrl(session.uploadId, { ownerId: 'user_b' })).toBeUndefined();

    await store.putContent(session.uploadId, Buffer.from('hello'), { ownerId: 'user_a' });
    expect(await store.getContent(session.uploadId, { ownerId: 'user_a' })).toEqual(
      Buffer.from('hello'),
    );
    await store.delete(session.uploadId, { ownerId: 'user_b' });
    expect(await store.get(session.uploadId, { ownerId: 'user_a' })).toBeDefined();
  });

  it('persists metadata in Prisma and bytes in the configured BlobStore', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const uploadSession = {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: 'db-id',
          ...data,
        };
        rows.set(String(data.uploadId), row);
        return row;
      },
      findUnique: async ({ where, select }: { where: { uploadId: string }; select?: unknown }) => {
        const row = rows.get(where.uploadId);
        if (!row) return null;
        if (select) return { contentKey: row.contentKey };
        return row;
      },
      findFirst: async ({
        where,
        select,
      }: {
        where: { uploadId: string; ownerId?: string };
        select?: unknown;
      }) => {
        const row = rows.get(where.uploadId);
        if (!row || (where.ownerId && row.ownerId !== where.ownerId)) return null;
        if (select) return { contentKey: row.contentKey };
        return row;
      },
      delete: async ({ where }: { where: { uploadId: string } }) => {
        const row = rows.get(where.uploadId);
        rows.delete(where.uploadId);
        return row;
      },
    };
    const blobStore = new MemoryBlobStore();
    const store = new PrismaUploadSessionStore({ uploadSession } as never, {
      blobStore,
      uploadUrlForKey: async (key) => `https://storage.test/${key}`,
    });

    const session = await store.create(input);
    expect(await store.getUploadUrl(session.uploadId)).toContain('/uploads/upload_');
    await store.putContent(session.uploadId, Buffer.from('hello'));
    expect(await store.getContent(session.uploadId)).toEqual(Buffer.from('hello'));
    await store.delete(session.uploadId);
    expect(await store.get(session.uploadId)).toBeUndefined();
    expect(await blobStore.get(`uploads/${session.uploadId}`)).toBeUndefined();
  });
});

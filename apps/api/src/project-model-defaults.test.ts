import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { FileProjectStore, MemoryProjectStore, PrismaProjectStore } from './projects';
import { AiSettingsStore } from './settings';

describe('project model defaults store', () => {
  it('supports partial updates and removal in memory', async () => {
    const store = new MemoryProjectStore();
    const project = await store.create({ name: 'Defaults' }, { ownerId: 'user-1' });

    await expect(store.getModelDefaults(project.id, { ownerId: 'user-1' })).resolves.toEqual({});
    await expect(
      store.updateModelDefaults(
        project.id,
        { text: ' text-v1 ', image: 'image-v1' },
        { ownerId: 'user-1' },
      ),
    ).resolves.toEqual({ text: 'text-v1', image: 'image-v1' });
    await expect(
      store.getModelDefaults(project.id, { ownerId: 'other-user' }),
    ).resolves.toBeUndefined();
    await expect(
      store.updateModelDefaults(project.id, { text: null, image: '' }, { ownerId: 'user-1' }),
    ).resolves.toEqual({});
    await expect(
      store.updateModelDefaults(project.id, { video: 'forbidden' }, { ownerId: 'other-user' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.getModelDefaults('missing')).resolves.toBeUndefined();
  });

  it('persists defaults in the file fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-project-defaults-'));
    const filePath = join(directory, 'projects.json');
    try {
      const first = new FileProjectStore({ filePath });
      const project = await first.create({ name: 'Persistent defaults' });
      await first.updateModelDefaults(project.id, { video: 'video-v1' });
      await first.close();

      const restarted = new FileProjectStore({ filePath });
      await expect(restarted.getModelDefaults(project.id)).resolves.toEqual({ video: 'video-v1' });
      await restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('project model defaults endpoints', () => {
  it('reads and patches defaults, and resolves node > project > global', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('project-default-test');
    settingsStore.update({ defaultModels: { image: 'global-image' } });
    const refreshedAt = new Date().toISOString();
    settingsStore.replaceModels(
      ['global-image', 'project-image', 'request-image', 'node-image'].map((id) => ({
        id,
        name: id,
        mediaTypes: ['image'],
        refreshedAt,
      })),
    );
    const app = buildApp({ logger: false, projectStore, settingsStore });
    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Model priority' },
      });
      const projectId = projectResponse.json().project.id as string;
      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node-image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { label: 'Image', mediaType: 'image', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });

      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: 'project-image' },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ defaults: { image: 'project-image' } });
      const get = await app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/models/defaults`,
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ defaults: { image: 'project-image' } });

      const run = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node-image/runs',
        payload: { projectId },
      });
      expect(run.statusCode).toBe(202);
      expect(run.json().run.modelAlias).toBe('project-image');

      const explicitRun = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node-image/runs',
        payload: { projectId, modelAlias: 'request-image' },
      });
      expect(explicitRun.statusCode).toBe(202);
      expect(explicitRun.json().run.modelAlias).toBe('request-image');

      const removeProjectDefault = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: null },
      });
      expect(removeProjectDefault.json()).toEqual({ defaults: {} });
      const globalRun = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node-image/runs',
        payload: { projectId },
      });
      expect(globalRun.statusCode).toBe(202);
      expect(globalRun.json().run.modelAlias).toBe('global-image');
      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/models/defaults`,
        payload: { image: 'project-image' },
      });

      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 1,
          nodes: [
            {
              id: 'node-image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: 'Image',
                mediaType: 'image',
                mode: 'generate',
                modelAlias: 'node-image',
              },
            },
          ],
          edges: [],
        },
      });
      const overrideRun = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node-image/runs',
        payload: { projectId },
      });
      expect(overrideRun.statusCode).toBe(202);
      expect(overrideRun.json().run.modelAlias).toBe('node-image');
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unknown project and 400 for malformed input', async () => {
    const app = buildApp({ logger: false });
    try {
      const missing = await app.inject({
        method: 'GET',
        url: '/v1/projects/missing/models/defaults',
      });
      expect(missing.statusCode).toBe(404);
      const malformed = await app.inject({
        method: 'PATCH',
        url: '/v1/projects/missing/models/defaults',
        payload: { text: 123 },
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('PrismaProjectStore model defaults', () => {
  it('maps Prisma rows and performs scoped upserts', async () => {
    const findFirst = async () => ({ id: 'project-1' });
    const findMany = async () => [
      { mediaType: 'TEXT', modelAlias: 'text-v1' },
      { mediaType: 'IMAGE', modelAlias: 'image-v1' },
    ];
    const transaction = {
      project: { findFirst, update: async () => undefined },
      projectModelDefault: {
        findMany,
        upsert: async () => undefined,
        deleteMany: async () => undefined,
      },
    };
    const prisma = {
      project: { findFirst, findUnique: findFirst },
      projectModelDefault: { findMany },
      $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
    };
    const store = new PrismaProjectStore(prisma as never);

    await expect(store.getModelDefaults('project-1', { ownerId: 'user-1' })).resolves.toEqual({
      text: 'text-v1',
      image: 'image-v1',
    });
    await expect(
      store.updateModelDefaults('project-1', { video: 'video-v1' }, { ownerId: 'user-1' }),
    ).resolves.toEqual({
      text: 'text-v1',
      image: 'image-v1',
    });
  });
});

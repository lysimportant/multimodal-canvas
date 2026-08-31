import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FileProjectStore, MemoryProjectStore, PrismaProjectStore } from './projects';

describe('MemoryProjectStore listing', () => {
  it('returns project summaries in updatedAt descending order', async () => {
    const store = new MemoryProjectStore();
    const first = await store.create({ name: 'First' });
    const second = await store.create({ name: 'Second' });

    const projects = await store.list();

    expect(projects).toHaveLength(2);
    expect(projects.map((project) => project.id)).toEqual([second.id, first.id]);
    expect(projects[0]).not.toHaveProperty('canvas');
  });

  it('renames projects and soft archives them without deleting their canvas', async () => {
    const store = new MemoryProjectStore();
    const project = await store.create({ name: 'Draft' });

    await expect(store.update(project.id, { name: 'Final' })).resolves.toMatchObject({
      id: project.id,
      name: 'Final',
    });
    await expect(store.setArchived(project.id, true)).resolves.toMatchObject({
      id: project.id,
      archivedAt: expect.any(String),
    });
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.list({}, { includeArchived: true })).resolves.toMatchObject([
      { id: project.id, name: 'Final', archivedAt: expect.any(String) },
    ]);
    await expect(store.getCanvas(project.id)).resolves.toMatchObject({ revision: 0 });

    await expect(store.setArchived(project.id, false)).resolves.toMatchObject({
      id: project.id,
      name: 'Final',
    });
    await expect(store.list()).resolves.toMatchObject([{ id: project.id, name: 'Final' }]);
  });
});

describe('FileProjectStore persistence', () => {
  it('recovers projects and canvases after the store is recreated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'multimodal-projects-'));
    const filePath = join(directory, 'projects.json');
    try {
      const first = new FileProjectStore({ filePath });
      const project = await first.create({ name: 'Persistent project' }, { ownerId: 'user-1' });
      await first.updateCanvas(
        project.id,
        {
          revision: 0,
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 12, y: 24 },
              data: { label: 'Prompt', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
        { ownerId: 'user-1' },
      );
      await first.close();

      const restarted = new FileProjectStore({ filePath });
      await expect(restarted.get(project.id, { ownerId: 'user-1' })).resolves.toMatchObject({
        id: project.id,
        name: 'Persistent project',
      });
      await expect(restarted.getCanvas(project.id, { ownerId: 'user-1' })).resolves.toMatchObject({
        revision: 1,
        nodes: [{ id: 'node_text', data: { label: 'Prompt' } }],
      });
      await expect(restarted.get(project.id, { ownerId: 'other-user' })).resolves.toBeUndefined();
      await restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('PrismaProjectStore canvas mapping', () => {
  it('preserves valid node data fields and strips internal dimensions when loading a persisted canvas', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      revision: 4,
      nodes: [
        {
          id: 'node_image',
          type: 'IMAGE',
          mode: 'GENERATE',
          label: 'Image generator',
          positionX: 10,
          positionY: 20,
          assetId: null,
          contentUrl: null,
          data: {
            label: 'Image generator',
            mediaType: 'image',
            mode: 'generate',
            enabled: false,
            stale: true,
            prompt: 'A detailed mountain landscape',
            inferenceStrength: 'high',
            modelAlias: 'image-special',
            credentialId: 'credential-1',
            assetId: 'asset-from-data',
            contentUrl: 'https://example.test/image.png',
            mimeType: 'image/png',
            __canvasWidth: 640,
            __canvasHeight: 480,
            internalOnly: 'must not leak',
          },
        },
      ],
      edges: [],
    });
    const store = new PrismaProjectStore({ canvas: { findUnique } } as never);

    const canvas = await store.getCanvas('project-id');

    expect(canvas?.nodes[0]).toMatchObject({
      type: 'image',
      width: 640,
      height: 480,
      data: {
        label: 'Image generator',
        mediaType: 'image',
        mode: 'generate',
        enabled: false,
        stale: true,
        prompt: 'A detailed mountain landscape',
        inferenceStrength: 'high',
        modelAlias: 'image-special',
        credentialId: 'credential-1',
        assetId: 'asset-from-data',
        contentUrl: 'https://example.test/image.png',
        mimeType: 'image/png',
      },
    });
    expect(canvas?.nodes[0].data).not.toHaveProperty('__canvasWidth');
    expect(canvas?.nodes[0].data).not.toHaveProperty('__canvasHeight');
    expect(canvas?.nodes[0].data).not.toHaveProperty('internalOnly');
  });

  it('falls back to legacy node columns while retaining valid JSON fields', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      revision: 2,
      nodes: [
        {
          id: 'legacy-node',
          type: 'TEXT',
          mode: 'TRANSFORM',
          label: 'Legacy column label',
          positionX: 1,
          positionY: 2,
          assetId: 'asset-from-column',
          contentUrl: 'https://example.test/legacy.txt',
          data: {
            prompt: 'Keep this prompt',
            stale: true,
            enabled: 'invalid',
            promptMetadata: 'must not leak',
          },
        },
      ],
      edges: [],
    });
    const store = new PrismaProjectStore({ canvas: { findUnique } } as never);

    await expect(store.getCanvas('project-id')).resolves.toMatchObject({
      revision: 2,
      nodes: [
        {
          type: 'text',
          data: {
            label: 'Legacy column label',
            mediaType: 'text',
            mode: 'transform',
            prompt: 'Keep this prompt',
            stale: true,
            assetId: 'asset-from-column',
            contentUrl: 'https://example.test/legacy.txt',
          },
        },
      ],
    });
  });

  it('lists project summaries ordered by most recently updated', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'project_2',
        name: 'Second',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T02:00:00.000Z'),
        archivedAt: null,
      },
      {
        id: 'project_1',
        name: 'First',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T01:00:00.000Z'),
        archivedAt: null,
      },
    ]);
    const store = new PrismaProjectStore({ project: { findMany } } as never);

    await expect(store.list()).resolves.toMatchObject([
      { id: 'project_2', name: 'Second' },
      { id: 'project_1', name: 'First' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { archivedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, createdAt: true, updatedAt: true, archivedAt: true },
    });
  });

  it('scopes project and global asset references to the authenticated owner', async () => {
    const assetId = '11111111-1111-4111-8111-111111111111';
    const assetFindMany = vi.fn().mockResolvedValue([{ id: assetId }]);
    const transaction = {
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: 'project-1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      canvas: {
        findUnique: vi.fn().mockResolvedValue({ id: 'canvas-1', revision: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      asset: { findMany: assetFindMany },
      canvasEdge: { deleteMany: vi.fn(), createMany: vi.fn() },
      canvasNode: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const store = new PrismaProjectStore(prisma as never);

    await store.updateCanvas(
      'project-1',
      {
        revision: 0,
        nodes: [
          {
            id: 'node-source',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              label: 'Reference',
              mediaType: 'image',
              mode: 'source',
              assetId,
            },
          },
        ],
        edges: [],
      },
      { ownerId: 'user-1' },
    );

    expect(assetFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: [assetId] },
        OR: [
          { projectId: 'project-1', ownerId: 'user-1' },
          { projectId: null, ownerId: 'user-1' },
        ],
      },
      select: { id: true },
    });
  });
});

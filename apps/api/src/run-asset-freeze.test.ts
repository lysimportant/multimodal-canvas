import type { CanvasDocument } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { signHs256Jwt } from './auth';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

const jwtSecret = 'run-asset-freeze-jwt-secret';

function assetCanvas(assetId: string): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_source',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: 'Frozen source',
          mediaType: 'text',
          mode: 'source',
          assetId,
          contentUrl: `/v1/assets/${encodeURIComponent(assetId)}/content`,
          mimeType: 'text/plain',
        },
      },
      {
        id: 'node_target',
        type: 'text',
        position: { x: 240, y: 0 },
        data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
      },
    ],
    edges: [
      {
        id: 'edge_source_target',
        sourceNodeId: 'node_source',
        sourceHandle: 'output:text',
        targetNodeId: 'node_target',
        targetHandle: 'input:prompt',
        order: 0,
      },
    ],
  };
}

function bearerHeaders(ownerId: string) {
  const token = signHs256Jwt({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + 300 }, jwtSecret);
  return { authorization: `Bearer ${token}` };
}

describe('run asset version snapshots', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'mock');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', '');
    for (const mediaType of ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']) {
      vi.stubEnv(`NEW_API_${mediaType}_MODEL`, '');
    }
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
  });

  it('freezes the queued asset version in nodes and inputs when a newer version is added', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Version freeze' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'prompt.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('version one'),
    });
    await projectStore.updateCanvas(project.id, assetCanvas(asset.id));
    const runService = new MemoryRunService({ stepDelayMs: 25 });
    const app = buildApp({ logger: false, assetStore, projectStore, runService });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    const submittedRun = submitted.json().run;
    expect(submittedRun.status).toBe('queued');
    const frozenUrl = `/v1/assets/${encodeURIComponent(asset.id)}/versions/1/content`;
    expect(submittedRun.snapshot.nodes[0].data.contentUrl).toBe(frozenUrl);
    expect(submittedRun.snapshot.inputs[0]).toMatchObject({
      sourceAssetId: asset.id,
      snapshot: { data: { assetId: asset.id, contentUrl: frozenUrl } },
    });

    await assetStore.createVersion(
      asset.id,
      { content: Buffer.from('version two') },
      { projectId: project.id },
    );
    const persisted = await runService.get(submittedRun.id);
    expect(persisted?.snapshot.nodes[0]?.data.contentUrl).toBe(frozenUrl);
    expect(persisted?.snapshot.inputs[0]?.snapshot.data.contentUrl).toBe(frozenUrl);
    expect((await projectStore.getCanvas(project.id))?.nodes[0]?.data.contentUrl).toBe(
      `/v1/assets/${encodeURIComponent(asset.id)}/content`,
    );
  });

  it('allows an authenticated owner to freeze a global asset', async () => {
    vi.stubEnv('API_JWT_SECRET', jwtSecret);
    const ownerId = '123e4567-e89b-42d3-a456-426614174001';
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Owner project' }, { ownerId });
    const asset = await assetStore.create({
      ownerId,
      name: 'global-prompt.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('owner global asset'),
    });
    const listVersions = vi.spyOn(assetStore, 'listVersions');
    await projectStore.updateCanvas(project.id, assetCanvas(asset.id), { ownerId });
    const app = buildApp({ logger: false, assetStore, projectStore });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      headers: bearerHeaders(ownerId),
      payload: { projectId: project.id },
    });

    expect(submitted.statusCode).toBe(202);
    expect(listVersions).toHaveBeenCalledWith(asset.id, { projectId: null, ownerId });
    expect(submitted.json().run.snapshot.inputs[0]).toMatchObject({
      sourceAssetId: asset.id,
      snapshot: {
        data: {
          contentUrl: `/v1/assets/${encodeURIComponent(asset.id)}/versions/1/content`,
        },
      },
    });
  });

  it('rejects an authorized asset that has no immutable version', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Missing version' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'versionless.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('content'),
    });
    await projectStore.updateCanvas(project.id, assetCanvas(asset.id));
    vi.spyOn(assetStore, 'listVersions').mockResolvedValue([]);
    const app = buildApp({ logger: false, assetStore, projectStore });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });

    expect(submitted.statusCode).toBe(400);
    expect(submitted.json()).toMatchObject({ code: 'asset_version_unavailable' });
  });

  it('rejects missing and unauthorized asset references before queueing', async () => {
    vi.stubEnv('API_JWT_SECRET', jwtSecret);
    const ownerId = '123e4567-e89b-42d3-a456-426614174002';
    const otherOwnerId = '123e4567-e89b-42d3-a456-426614174003';
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Current project' }, { ownerId });
    const otherProject = await projectStore.create({ name: 'Other project' }, { ownerId });
    const crossProjectAsset = await assetStore.create({
      projectId: otherProject.id,
      ownerId,
      name: 'other-project.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('other project'),
    });
    const otherOwnerAsset = await assetStore.create({
      ownerId: otherOwnerId,
      name: 'other-owner.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('other owner'),
    });
    const app = buildApp({ logger: false, assetStore, projectStore });
    apps.push(app);
    const headers = bearerHeaders(ownerId);

    for (const assetId of [crossProjectAsset.id, otherOwnerAsset.id, 'asset_missing']) {
      const currentCanvas = await projectStore.getCanvas(project.id, { ownerId });
      await projectStore.updateCanvas(
        project.id,
        { ...assetCanvas(assetId), revision: currentCanvas?.revision ?? 0 },
        { ownerId },
      );
      const submitted = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_target/runs',
        headers,
        payload: { projectId: project.id },
      });
      expect(submitted.statusCode).toBe(400);
      expect(submitted.json()).toMatchObject({ code: 'asset_unavailable' });
    }

    const runs = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/runs`,
      headers,
    });
    expect(runs.json()).toEqual({ runs: [] });
  });
});

import type { CanvasDocument, MediaType } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryAuthStore } from './auth-store';
import { AuthService } from './auth-service';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

const jwtSecret = 'run-asset-freeze-jwt-secret';

function assetCanvas(assetId: string, mediaType: MediaType = 'text'): CanvasDocument {
  const mimeType = mediaType === 'video' ? 'video/mp4' : 'text/plain';
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_source',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: 'Frozen source',
          mediaType,
          mode: 'source',
          assetId,
          contentUrl: `/v1/assets/${encodeURIComponent(assetId)}/content`,
          mimeType,
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
        sourceHandle: `output:${mediaType}`,
        targetNodeId: 'node_target',
        targetHandle: mediaType === 'text' ? 'input:prompt' : 'input:content',
        order: 0,
      },
    ],
  };
}

/** 资源冻结回归使用真实可撤销会话，不依赖已移除的默认无 sid JWT 接入口。 */
async function authenticatedOwner() {
  const authStore = new MemoryAuthStore();
  const auth = new AuthService({ store: authStore, jwtSecret });
  const session = await auth.register({
    email: 'freeze-owner@example.test',
    password: 'synthetic-owner-password',
  });
  return {
    authStore,
    ownerId: session.user.id,
    headers: { authorization: `Bearer ${session.accessToken}` },
  };
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
    expect(submittedRun.snapshot).toEqual({
      canvasRevision: 1,
      inputCount: 1,
      inputs: [null],
    });
    const internalRun = await runService.get(submittedRun.id);
    expect(internalRun).toBeDefined();
    const frozenUrl = `/v1/assets/${encodeURIComponent(asset.id)}/versions/1/content`;
    expect(internalRun!.snapshot.nodes[0].data.contentUrl).toBe(frozenUrl);
    expect(internalRun!.snapshot.inputs[0]).toMatchObject({
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

  it('freezes video duration from the selected immutable version', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Video duration freeze' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'reference.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      content: Buffer.from('version one'),
      metadata: { durationSeconds: 4.5 },
    });
    await projectStore.updateCanvas(project.id, assetCanvas(asset.id, 'video'));
    const runService = new MemoryRunService({ stepDelayMs: 25 });
    const app = buildApp({ logger: false, assetStore, projectStore, runService });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    const runId = submitted.json().run.id;
    expect((await runService.get(runId))?.snapshot.inputs[0]).toMatchObject({
      sourceAssetVersion: 1,
      sourceDurationSeconds: 4.5,
    });

    await assetStore.createVersion(
      asset.id,
      { content: Buffer.from('version two'), metadata: { durationSeconds: 9.25 } },
      { projectId: project.id },
    );
    expect((await runService.get(runId))?.snapshot.inputs[0]).toMatchObject({
      sourceAssetVersion: 1,
      sourceDurationSeconds: 4.5,
    });
  });

  it('allows an authenticated owner to freeze a global asset', async () => {
    vi.stubEnv('API_JWT_SECRET', jwtSecret);
    const { authStore, ownerId, headers } = await authenticatedOwner();
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
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, assetStore, projectStore, runService, authStore });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      headers,
      payload: { projectId: project.id },
    });

    expect(submitted.statusCode).toBe(202);
    expect(listVersions).toHaveBeenCalledWith(asset.id, { projectId: null, ownerId });
    const submittedRun = submitted.json().run;
    expect(submittedRun.snapshot).toEqual({ canvasRevision: 1, inputCount: 1, inputs: [null] });
    const internalRun = await runService.get(submittedRun.id);
    expect(internalRun).toBeDefined();
    expect(internalRun!.snapshot.inputs[0]).toMatchObject({
      sourceAssetId: asset.id,
      snapshot: {
        data: {
          contentUrl: `/v1/assets/${encodeURIComponent(asset.id)}/versions/1/content`,
        },
      },
    });
  });

  it('freezes manual upstream output while excluding its model, mentions and ancestors', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Manual output' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'manual.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('manually edited output'),
    });
    const canvas = assetCanvas(asset.id);
    canvas.nodes[0].data = {
      ...canvas.nodes[0].data,
      mode: 'generate',
      manualOutput: true,
      manualOutputRunId: 'old_run',
      modelAlias: 'missing-model',
      credentialId: 'missing-credential',
      prompt: 'old prompt',
      promptDocument: {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'old_mention',
            assetId: 'missing_mention',
            mediaType: 'image',
            label: 'Old input',
          },
        ],
      },
    };
    canvas.nodes.push({
      id: 'ancestor',
      type: 'text',
      position: { x: -240, y: 0 },
      data: {
        label: 'Unneeded ancestor',
        mediaType: 'text',
        mode: 'generate',
        modelAlias: 'unavailable-model',
        assetId: 'missing-asset',
      },
    });
    canvas.edges.push({
      id: 'ancestor_manual',
      sourceNodeId: 'ancestor',
      sourceHandle: 'output:text',
      targetNodeId: 'node_source',
      targetHandle: 'input:prompt',
      order: 0,
    });
    const runService = new MemoryRunService({ stepDelayMs: 25 });
    const app = buildApp({ logger: false, assetStore, projectStore, runService });
    apps.push(app);
    const saved = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: canvas,
    });
    expect(saved.statusCode).toBe(200);
    const loaded = await app.inject({ method: 'GET', url: `/v1/projects/${project.id}/canvas` });
    expect(loaded.json().canvas.nodes[0].data).toMatchObject({
      manualOutput: true,
      manualOutputRunId: 'old_run',
      mode: 'generate',
      assetId: asset.id,
    });
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    const run = await runService.get(submitted.json().run.id);
    expect(run?.snapshot.nodes.map((node) => node.id)).toEqual(['node_source', 'node_target']);
    expect(run?.snapshot.nodes[0].data).toMatchObject({
      mode: 'source',
      manualOutput: true,
      assetId: asset.id,
    });
    expect(run?.snapshot.nodes[0].data).not.toHaveProperty('promptDocument');
    expect(run?.snapshot.nodes[0].data).not.toHaveProperty('modelAlias');
    expect(run?.snapshot.promptMentions ?? []).toEqual([]);
    expect(run?.snapshot.edges).toHaveLength(1);
    expect(run?.snapshot.inputs[0].snapshot.data.contentUrl).toBe(
      `/v1/assets/${asset.id}/versions/1/content`,
    );
    await assetStore.createVersion(
      asset.id,
      { content: Buffer.from('later version') },
      { projectId: project.id },
    );
    expect(
      (await runService.get(submitted.json().run.id))?.snapshot.inputs[0].snapshot.data.contentUrl,
    ).toBe(`/v1/assets/${asset.id}/versions/1/content`);
    expect((await projectStore.getCanvas(project.id))?.nodes[0].data).toMatchObject({
      mode: 'generate',
      manualOutput: true,
      manualOutputRunId: 'old_run',
      modelAlias: 'missing-model',
    });
  });

  it('runs a manual target with its original model and upstream inputs', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Regenerate manual output' });
    const asset = await assetStore.create({
      projectId: project.id,
      name: 'input.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('upstream'),
    });
    const canvas = assetCanvas(asset.id);
    canvas.nodes[1].data = {
      ...canvas.nodes[1].data,
      manualOutput: true,
      assetId: 'old-missing-manual-asset',
      modelAlias: 'mock-text',
      prompt: 'regenerate this',
    };
    await projectStore.updateCanvas(project.id, canvas);
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, assetStore, projectStore, runService });
    apps.push(app);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    const run = await runService.get(submitted.json().run.id);
    expect(run?.snapshot.nodes[1].data).toMatchObject({
      mode: 'generate',
      modelAlias: 'mock-text',
      prompt: 'regenerate this',
    });
    expect(run?.snapshot.inputs[0].sourceAssetId).toBe(asset.id);
    expect(run?.snapshot.modelAlias).toBe('mock-text');
  });

  it('rejects manual upstream output without an asset reference', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Missing manual asset' });
    const canvas = assetCanvas('unused');
    canvas.nodes[0].data = {
      label: 'Manual',
      mediaType: 'text',
      mode: 'generate',
      manualOutput: true,
    };
    await projectStore.updateCanvas(project.id, canvas);
    const app = buildApp({ logger: false, projectStore });
    apps.push(app);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(400);
    expect(submitted.json()).toMatchObject({ code: 'asset_unavailable' });
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

  it.each([false, true])(
    'rejects missing and unauthorized asset references before queueing (manual=%s)',
    async (manualOutput) => {
      vi.stubEnv('API_JWT_SECRET', jwtSecret);
      const { authStore, ownerId, headers } = await authenticatedOwner();
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
      const app = buildApp({ logger: false, assetStore, projectStore, authStore });
      apps.push(app);

      for (const assetId of [crossProjectAsset.id, otherOwnerAsset.id, 'asset_missing']) {
        const currentCanvas = await projectStore.getCanvas(project.id, { ownerId });
        const manualCanvas = assetCanvas(assetId);
        manualCanvas.nodes[0].data.mode = manualOutput ? 'generate' : 'source';
        manualCanvas.nodes[0].data.manualOutput = manualOutput;
        await projectStore.updateCanvas(
          project.id,
          { ...manualCanvas, revision: currentCanvas?.revision ?? 0 },
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
    },
  );
});

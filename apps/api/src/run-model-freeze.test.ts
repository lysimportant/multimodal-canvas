import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';

import { buildApp } from './app';
import { MemoryProjectStore } from './projects';
import { AiSettingsStore, type ModelCatalogEntry } from './settings';
import { createRunSnapshot, MemoryRunService } from './runs';

const now = new Date().toISOString();

function model(id: string, mediaType: ModelCatalogEntry['mediaTypes'][number]): ModelCatalogEntry {
  return { id, name: id, mediaTypes: [mediaType], refreshedAt: now };
}

function workflowCanvas(): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_source',
        type: 'text' as const,
        position: { x: -240, y: 0 },
        data: { label: 'Source', mediaType: 'text' as const, mode: 'source' as const },
      },
      {
        id: 'node_text',
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: { label: 'Text', mediaType: 'text' as const, mode: 'generate' as const },
      },
      {
        id: 'node_text_second',
        type: 'text' as const,
        position: { x: 0, y: 120 },
        data: { label: 'Text two', mediaType: 'text' as const, mode: 'generate' as const },
      },
      {
        id: 'node_image',
        type: 'image' as const,
        position: { x: 240, y: 0 },
        data: {
          label: 'Image',
          mediaType: 'image' as const,
          mode: 'generate' as const,
          modelAlias: 'image-node',
        },
      },
      {
        id: 'node_audio',
        type: 'audio' as const,
        position: { x: 240, y: 180 },
        data: { label: 'Audio', mediaType: 'audio' as const, mode: 'generate' as const },
      },
      {
        id: 'node_video',
        type: 'video' as const,
        position: { x: 480, y: 80 },
        data: { label: 'Video', mediaType: 'video' as const, mode: 'generate' as const },
      },
    ],
    edges: [
      {
        id: 'edge_source_text',
        sourceNodeId: 'node_source',
        sourceHandle: 'output:text',
        targetNodeId: 'node_text',
        targetHandle: 'input:prompt',
        order: 0,
      },
      {
        id: 'edge_text_image',
        sourceNodeId: 'node_text',
        sourceHandle: 'output:text',
        targetNodeId: 'node_image',
        targetHandle: 'input:prompt',
        order: 0,
      },
      {
        id: 'edge_text_second_image',
        sourceNodeId: 'node_text_second',
        sourceHandle: 'output:text',
        targetNodeId: 'node_image',
        targetHandle: 'input:prompt',
        order: 1,
      },
      {
        id: 'edge_image_video',
        sourceNodeId: 'node_image',
        sourceHandle: 'output:image',
        targetNodeId: 'node_video',
        targetHandle: 'input:firstFrame',
        order: 0,
      },
      {
        id: 'edge_audio_video',
        sourceNodeId: 'node_audio',
        sourceHandle: 'output:audio',
        targetNodeId: 'node_video',
        targetHandle: 'input:audioTrack',
        order: 1,
      },
    ],
  };
}

async function createProject(app: ReturnType<typeof buildApp>, canvas = workflowCanvas()) {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: { name: 'Model freeze' },
  });
  const projectId = created.json().project.id as string;
  const saved = await app.inject({
    method: 'PATCH',
    url: `/v1/projects/${projectId}/canvas`,
    payload: canvas,
  });
  expect(saved.statusCode).toBe(200);
  return projectId;
}

async function waitForStatus(
  service: MemoryRunService,
  runId: string,
  status: 'failed' | 'succeeded',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.get(runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`run ${runId} did not reach ${status}`);
}

describe('per-node run model snapshots', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'mock');
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
  });

  it('freezes every executable node in a cross-media closure with the documented priority', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('model-freeze-priority');
    settingsStore.update({
      defaultModels: {
        text: 'global-text',
        image: 'global-image',
        audio: 'global-audio',
        video: 'global-video',
      },
    });
    settingsStore.replaceModels([
      model('project-text', 'text'),
      model('image-node', 'image'),
      model('global-audio', 'audio'),
      model('request-video', 'video'),
    ]);
    const listModels = vi.spyOn(settingsStore, 'listModels');
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, projectStore, settingsStore, runService });
    apps.push(app);
    const projectId = await createProject(app);
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/models/defaults`,
      payload: { text: 'project-text' },
    });
    // Saving a project default validates its catalog entry before the run;
    // keep the assertion below focused on submission-time resolution calls.
    listModels.mockClear();

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video/runs',
      payload: { projectId, modelAlias: 'request-video' },
    });

    expect(submitted.statusCode).toBe(202);
    const publicRun = submitted.json().run;
    expect(publicRun.modelAlias).toBe('request-video');
    expect(publicRun.snapshot).toEqual({ canvasRevision: 1, inputCount: 2, inputs: [null, null] });
    const run = await runService.get(publicRun.id);
    expect(run).toBeDefined();
    expect(
      Object.fromEntries(
        run!.snapshot.nodes.map((node: { id: string; data: { modelAlias?: string } }) => [
          node.id,
          node.data.modelAlias,
        ]),
      ),
    ).toEqual({
      node_source: undefined,
      node_text: 'project-text',
      node_text_second: 'project-text',
      node_image: 'image-node',
      node_audio: 'global-audio',
      node_video: 'request-video',
    });
    expect(run!.snapshot.inputs.map((input: { nodeId: string }) => input.nodeId)).toEqual([
      'node_image',
      'node_audio',
    ]);

    const canvas = await projectStore.getCanvas(projectId);
    expect(canvas?.nodes.map((node) => node.data.modelAlias)).toEqual([
      undefined,
      undefined,
      undefined,
      'image-node',
      undefined,
      undefined,
    ]);
    expect(listModels.mock.calls.filter(([mediaType]) => mediaType !== undefined)).toHaveLength(4);
    expect(listModels.mock.calls.filter(([mediaType]) => mediaType === 'text')).toHaveLength(1);
    expect(listModels.mock.calls.filter(([mediaType]) => mediaType === 'image')).toHaveLength(1);
    expect(listModels.mock.calls.filter(([mediaType]) => mediaType === 'audio')).toHaveLength(1);
    expect(listModels.mock.calls.filter(([mediaType]) => mediaType === 'video')).toHaveLength(1);
  });

  it('freezes mixed per-node credentials without inheriting the target credential upstream', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('model-freeze-mixed-credentials');
    settingsStore.update({
      baseUrl: 'https://chat-credential.example/v1',
      apiKey: 'synthetic-chat-credential-key',
    });
    const chatCredential = settingsStore
      .listCredentials()
      .find((credential) => credential.baseUrl === 'https://chat-credential.example/v1');
    if (!chatCredential) throw new Error('chat credential fixture was not created');
    settingsStore.replaceModels([model('chat-text', 'text')], chatCredential.id);

    settingsStore.update({
      baseUrl: 'https://video-credential.example/v1',
      apiKey: 'synthetic-video-credential-key',
    });
    const videoCredential = settingsStore
      .listCredentials()
      .find((credential) => credential.baseUrl === 'https://video-credential.example/v1');
    if (!videoCredential) throw new Error('video credential fixture was not created');
    settingsStore.replaceModels([model('video-target', 'video')], videoCredential.id);

    const runService = new MemoryRunService({ providerName: 'newapi' });
    const app = buildApp({ logger: false, projectStore, settingsStore, runService });
    apps.push(app);
    const projectId = await createProject(app, {
      revision: 0,
      nodes: [
        {
          id: 'node_chat_text',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: 'Chat text',
            mediaType: 'text',
            mode: 'generate',
            modelAlias: 'chat-text',
            credentialId: chatCredential.id,
          },
        },
        {
          id: 'node_video_target',
          type: 'video',
          position: { x: 240, y: 0 },
          data: {
            label: 'Video target',
            mediaType: 'video',
            mode: 'generate',
            modelAlias: 'video-target',
            credentialId: videoCredential.id,
          },
        },
      ],
      edges: [
        {
          id: 'edge_chat_text_video',
          sourceNodeId: 'node_chat_text',
          sourceHandle: 'output:text',
          targetNodeId: 'node_video_target',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
    });

    const chatReference = settingsStore.getCredentialReference(chatCredential.id);
    const videoReference = settingsStore.getCredentialReference(videoCredential.id);
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video_target/runs',
      payload: {
        projectId,
        modelAlias: 'video-target',
        credentialId: videoCredential.id,
      },
    });

    expect(submitted.statusCode).toBe(202);
    const publicRun = submitted.json().run;
    expect(publicRun).toMatchObject({
      modelAlias: 'video-target',
      snapshot: { canvasRevision: 1, inputCount: 1, inputs: [null] },
    });
    const storedRun = await runService.get(publicRun.id);
    expect(storedRun).toBeDefined();
    const snapshot = storedRun!.snapshot;
    expect(snapshot).toMatchObject({
      modelAlias: 'video-target',
      credentialId: videoReference.credentialId,
      credentialVersion: videoReference.credentialVersion,
      nodeCredentialReferences: {
        node_chat_text: chatReference,
        node_video_target: videoReference,
      },
    });
    expect(snapshot.nodeCredentialReferences!.node_chat_text.credentialId).toBe(chatCredential.id);
    expect(snapshot.nodeCredentialReferences!.node_chat_text.credentialId).not.toBe(
      videoCredential.id,
    );
  });

  it('rejects an unavailable intermediate model before creating a run', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('model-freeze-unavailable');
    settingsStore.replaceModels([model('text-ok', 'text'), model('video-ok', 'video')]);
    const app = buildApp({ logger: false, projectStore, settingsStore });
    apps.push(app);
    const canvas = workflowCanvas();
    canvas.nodes = canvas.nodes.map((node) =>
      node.id === 'node_text' || node.id === 'node_text_second'
        ? { ...node, data: { ...node.data, modelAlias: 'text-ok' } }
        : node.id === 'node_image'
          ? { ...node, data: { ...node.data, modelAlias: 'image-missing' } }
          : node,
    );
    const projectId = await createProject(app, canvas);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video/runs',
      payload: { projectId, modelAlias: 'video-ok' },
    });

    expect(submitted.statusCode).toBe(400);
    expect(submitted.json()).toMatchObject({
      code: 'model_unavailable',
      error: expect.stringContaining('image-missing'),
    });
    expect(submitted.json().error).toContain('node_image');
    const runs = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/runs` });
    expect(runs.json()).toEqual({ runs: [] });
  });

  it.each([
    { nodeEnvironment: 'test', workerProvider: 'newapi', label: 'New API mode' },
    { nodeEnvironment: 'production', workerProvider: 'mock', label: 'production mode' },
  ])('rejects virtual mock fallbacks in $label', async ({ nodeEnvironment, workerProvider }) => {
    vi.stubEnv('NODE_ENV', nodeEnvironment);
    vi.stubEnv('WORKER_PROVIDER', workerProvider);
    vi.stubEnv('NEW_API_TEXT_MODEL', '');
    vi.stubEnv('API_AUTH_TOKEN', nodeEnvironment === 'production' ? 'model-test-token' : '');
    vi.stubEnv('API_JWT_SECRET', '');
    const app = buildApp({
      logger: false,
      projectStore: new MemoryProjectStore(),
      settingsStore: new AiSettingsStore(`model-freeze-${nodeEnvironment}-${workerProvider}`),
    });
    apps.push(app);
    const headers =
      nodeEnvironment === 'production' ? { authorization: 'Bearer model-test-token' } : undefined;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      ...(headers ? { headers } : {}),
      payload: { name: 'No virtual model' },
    });
    const projectId = created.json().project.id as string;
    const saved = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      ...(headers ? { headers } : {}),
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_text',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Text', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
    });
    expect(saved.statusCode).toBe(200);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_text/runs',
      ...(headers ? { headers } : {}),
      payload: { projectId },
    });

    expect(submitted.statusCode).toBe(400);
    expect(submitted.json()).toMatchObject({
      code: 'model_unavailable',
      error: expect.stringContaining('node_text'),
    });
  });

  it('keeps the frozen aliases when retrying after defaults and canvas changes', async () => {
    const projectStore = new MemoryProjectStore();
    const settingsStore = new AiSettingsStore('model-freeze-retry');
    settingsStore.update({
      defaultModels: {
        text: 'text-old',
        image: 'image-old',
        audio: 'audio-old',
        video: 'video-old',
      },
    });
    settingsStore.replaceModels([
      model('text-old', 'text'),
      model('image-old', 'image'),
      model('image-node', 'image'),
      model('audio-old', 'audio'),
      model('video-old', 'video'),
      model('text-new', 'text'),
      model('image-new', 'image'),
      model('audio-new', 'audio'),
      model('video-new', 'video'),
    ]);
    let executions = 0;
    const runService = new MemoryRunService({
      stepDelayMs: 0,
      executor: async ({ snapshot }) => {
        executions += 1;
        if (executions === 1) throw new Error('first attempt fails');
        const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId)!;
        return {
          result: {
            provider: 'mock',
            summary: 'retry succeeded',
            targetNodeId: target.id,
            mediaType: target.data.mediaType,
            inputCount: snapshot.inputs.length,
          },
        };
      },
    });
    const app = buildApp({ logger: false, projectStore, settingsStore, runService });
    apps.push(app);
    const projectId = await createProject(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video/runs',
      payload: { projectId },
    });
    expect(submitted.statusCode).toBe(202);
    const first = await waitForStatus(runService, submitted.json().run.id, 'failed');
    const frozenSnapshot = first.snapshot;

    settingsStore.update({
      defaultModels: {
        text: 'text-new',
        image: 'image-new',
        audio: 'audio-new',
        video: 'video-new',
      },
    });
    await projectStore.updateModelDefaults(projectId, { text: 'text-new', image: 'image-new' });
    const currentCanvas = (await projectStore.getCanvas(projectId))!;
    await projectStore.updateCanvas(projectId, {
      ...currentCanvas,
      nodes: currentCanvas.nodes.map((node) =>
        node.id === 'node_image'
          ? { ...node, data: { ...node.data, modelAlias: 'image-new' } }
          : node,
      ),
    });

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/runs/${first.id}/retry`,
    });
    expect(retried.statusCode).toBe(202);
    const retriedPublicRun = retried.json().run;
    expect(retriedPublicRun.snapshot).toEqual({
      canvasRevision: frozenSnapshot.canvasRevision,
      inputCount: frozenSnapshot.inputs.length,
      inputs: Array.from({ length: frozenSnapshot.inputs.length }, () => null),
    });
    const retriedInternalRun = await runService.get(retriedPublicRun.id);
    expect(retriedInternalRun?.snapshot).toEqual(frozenSnapshot);
    const succeeded = await waitForStatus(runService, retriedPublicRun.id, 'succeeded');
    expect(succeeded.snapshot).toEqual(frozenSnapshot);
    expect(succeeded.snapshot.nodes.map((node) => node.data.modelAlias)).toEqual([
      undefined,
      'text-old',
      'text-old',
      'image-node',
      'audio-old',
      'video-old',
    ]);
  });
});

describe('createRunSnapshot model alias overlay', () => {
  it('does not mutate the canvas and applies aliases to node and input clones', () => {
    const canvas = workflowCanvas();
    const snapshot = createRunSnapshot('project_snapshot', canvas, 'node_video', {
      nodeModelAliases: {
        node_text: 'text-frozen',
        node_image: 'image-frozen',
        node_video: 'video-frozen',
      },
    });

    expect(snapshot.modelAlias).toBe('video-frozen');
    expect(snapshot.nodes.find((node) => node.id === 'node_text')?.data.modelAlias).toBe(
      'text-frozen',
    );
    expect(snapshot.nodes.find((node) => node.id === 'node_image')?.data.modelAlias).toBe(
      'image-frozen',
    );
    expect(snapshot.nodes.find((node) => node.id === 'node_video')?.data.modelAlias).toBe(
      'video-frozen',
    );
    expect(
      snapshot.inputs.find((input) => input.nodeId === 'node_image')?.snapshot.data.modelAlias,
    ).toBe('image-frozen');
    expect(canvas.nodes.find((node) => node.id === 'node_text')?.data.modelAlias).toBeUndefined();
    expect(canvas.nodes.find((node) => node.id === 'node_video')?.data.modelAlias).toBeUndefined();
  });
});

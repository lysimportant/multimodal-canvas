import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { MemoryAssetStore } from './assets';
import { buildApp } from './app';
import { MemoryProjectStore } from './projects';
import { AiSettingsStore } from './settings';

const app = buildApp({ logger: false, assetStore: new MemoryAssetStore() });

afterAll(async () => app.close());

describe('health endpoint', () => {
  it('reports that the API is available', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
  });
});

describe('OpenAPI endpoint', () => {
  it('publishes the documented retry and credential routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/documentation/json' });

    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/v1/runs/{runId}/retry']).toBeDefined();
    expect(response.json().paths['/v1/projects/{projectId}/runs']).toBeDefined();
    expect(response.json().paths['/v1/settings/ai/credentials'].delete).toBeDefined();
    expect(response.json().paths['/v1/runs/{runId/retry}']).toBeUndefined();
  });
});

describe('AI settings endpoints', () => {
  it('never returns the configured API key and exposes model defaults', async () => {
    const update = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/ai',
      payload: {
        baseUrl: 'https://newapi.example.com/v1',
        apiKey: 'secret-test-key',
        defaultModels: { text: 'text-model', video: 'video-model' },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject({
      baseUrl: 'https://newapi.example.com/v1',
      configured: true,
      keyFingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
      defaultModels: { text: 'text-model', video: 'video-model' },
    });
    expect(JSON.stringify(update.json())).not.toContain('secret-test-key');

    const get = await app.inject({ method: 'GET', url: '/v1/settings/ai' });
    expect(get.json().settings.configured).toBe(true);
  });

  it('rejects insecure remote base URLs', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/ai',
      payload: { baseUrl: 'http://api.example.com/v1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps the previous model catalog when refresh fails', async () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'secret-test-key' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'image-v1', mediaType: 'image' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockRejectedValueOnce(new Error('upstream unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(store.refreshModels()).resolves.toMatchObject([{ id: 'image-v1' }]);
      await expect(store.refreshModels()).rejects.toThrow('upstream unavailable');
      expect(store.listModels()).toMatchObject([{ id: 'image-v1', mediaTypes: ['image'] }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves a media-compatible default or explicit model at submission time', async () => {
    const store = new AiSettingsStore('test-encryption-secret');
    store.update({ defaultModels: { image: 'image-v2' } });
    expect(store.resolveModel('image')).toBe('image-v2');
    expect(store.resolveModel('image', 'mock-image')).toBe('mock-image');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'image-v2', mediaType: 'image' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      store.update({ baseUrl: 'https://newapi.example.com/v1', apiKey: 'secret-test-key' });
      await store.refreshModels();
      expect(() => store.resolveModel('text', 'image-v2')).toThrow('不支持 text');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('asset endpoints', () => {
  it('starts with an empty asset collection', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/assets' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assets: [] });
  });

  it('uploads an asset and serves its original content', async () => {
    const boundary = 'asset-test-boundary';
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(upload.statusCode).toBe(201);
    const uploadedAsset = upload.json().asset;
    expect(uploadedAsset).toMatchObject({
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: content.byteLength,
      status: 'ready',
    });

    const contentResponse = await app.inject({
      method: 'GET',
      url: uploadedAsset.contentUrl,
    });

    expect(contentResponse.statusCode).toBe(200);
    expect(contentResponse.headers['content-type']).toContain('image/png');
    expect(contentResponse.rawPayload).toEqual(content);
  });

  it('stores and serves generated media derivatives through the asset boundary', async () => {
    const derivativeApp = buildApp({
      logger: false,
      mediaDerivativeGenerator: {
        generate: async () => [
          { kind: 'thumbnail', mimeType: 'image/jpeg', content: Buffer.from('thumbnail') },
        ],
      },
    });
    try {
      const boundary = 'derivative-boundary';
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n--${boundary}--\r\n`,
      );
      const upload = await derivativeApp.inject({
        method: 'POST',
        url: '/v1/assets/uploads',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(upload.statusCode).toBe(201);
      const asset = upload.json().asset;
      expect(asset.metadata.derivatives.thumbnail).toMatchObject({
        mimeType: 'image/jpeg',
        contentUrl: `/v1/assets/${asset.id}/derivatives/thumbnail`,
      });
      const derivative = await derivativeApp.inject({
        method: 'GET',
        url: asset.metadata.derivatives.thumbnail.contentUrl,
      });
      expect(derivative.statusCode).toBe(200);
      expect(derivative.headers['content-type']).toContain('image/jpeg');
      expect(derivative.rawPayload).toEqual(Buffer.from('thumbnail'));
    } finally {
      await derivativeApp.close();
    }
  });

  it('rejects unsupported uploads', async () => {
    const boundary = 'unsupported-asset-boundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\narchive\r\n--${boundary}--\r\n`,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupported media type' });
  });

  it('updates, archives, restores, and searches assets without deleting content', async () => {
    const boundary = 'lifecycle-boundary';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    const asset = upload.json().asset;

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/assets/${asset.id}`,
      payload: { name: 'prompt.txt', tags: ['prompt', 'draft'] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().asset).toMatchObject({ name: 'prompt.txt', tags: ['prompt', 'draft'] });

    const search = await app.inject({ method: 'GET', url: '/v1/assets?query=draft' });
    expect(search.json().assets).toHaveLength(1);

    const archive = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/archive` });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().asset.status).toBe('archived');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/assets?status=ready' }))
        .json()
        .assets.some((item: { id: string }) => item.id === asset.id),
    ).toBe(false);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/assets?status=archived' }))
        .json()
        .assets.some((item: { id: string }) => item.id === asset.id),
    ).toBe(true);

    const restore = await app.inject({ method: 'POST', url: `/v1/assets/${asset.id}/restore` });
    expect(restore.json().asset.status).toBe('ready');
    const content = await app.inject({ method: 'GET', url: `/v1/assets/${asset.id}/content` });
    expect(content.rawPayload.toString()).toBe('hello');
  });

  it('supports an integrity-checked direct upload session', async () => {
    const content = Buffer.from('direct upload payload');
    const digest = createHash('sha256').update(content).digest('hex');
    const init = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads/init',
      payload: {
        name: 'direct.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: digest,
        tags: ['direct'],
      },
    });
    expect(init.statusCode).toBe(201);
    const upload = init.json();

    const put = await app.inject({
      method: 'PUT',
      url: upload.uploadUrl,
      headers: { 'content-type': 'application/octet-stream' },
      payload: content,
    });
    expect(put.statusCode).toBe(204);

    const complete = await app.inject({
      method: 'POST',
      url: upload.completeUrl,
      payload: {
        uploadId: upload.uploadId,
        name: 'direct.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: digest,
      },
    });
    expect(complete.statusCode).toBe(201);
    expect(complete.json().asset).toMatchObject({
      name: 'direct.txt',
      mediaType: 'text',
      sha256: digest,
      tags: ['direct'],
    });
  });

  it('rejects direct upload bytes whose digest differs from initialization', async () => {
    const content = Buffer.from('expected');
    const init = await app.inject({
      method: 'POST',
      url: '/v1/assets/uploads/init',
      payload: {
        name: 'mismatch.txt',
        mimeType: 'text/plain',
        sizeBytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    const upload = init.json();
    const put = await app.inject({
      method: 'PUT',
      url: upload.uploadUrl,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('tampered'),
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toContain('SHA-256');
  });
});

describe('project and canvas endpoints', () => {
  it('lists project summaries in updated order', async () => {
    const projectStore = new MemoryProjectStore();
    const listApp = buildApp({ logger: false, projectStore });
    try {
      const first = await listApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'First project' },
      });
      const second = await listApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Second project' },
      });

      const response = await listApp.inject({ method: 'GET', url: '/v1/projects' });

      expect(response.statusCode).toBe(200);
      const projects = response.json().projects;
      expect(projects).toHaveLength(2);
      expect(projects.map((project: { id: string }) => project.id)).toEqual(
        expect.arrayContaining([first.json().project.id, second.json().project.id]),
      );
      expect(projects[0]).not.toHaveProperty('canvas');
      expect(projects).toEqual(
        [...projects].sort((left, right) => {
          const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
          return updatedOrder !== 0 ? updatedOrder : right.id.localeCompare(left.id);
        }),
      );
    } finally {
      await listApp.close();
    }
  });

  it('creates a project and saves its canvas with an incremented revision', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Storyboard' },
    });

    expect(create.statusCode).toBe(201);
    const project = create.json().project;
    expect(project).toMatchObject({ name: 'Storyboard' });

    const initial = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/canvas`,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().canvas).toEqual({ revision: 0, nodes: [], edges: [] });

    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_prompt',
            type: 'text',
            position: { x: 40, y: 60 },
            data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
          },
        ],
        edges: [],
      },
    });

    expect(save.statusCode).toBe(200);
    expect(save.json().canvas.revision).toBe(1);
    expect(save.json().canvas.nodes).toHaveLength(1);
  });

  it('rejects a stale canvas revision without overwriting the current canvas', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Revision test' },
    });
    const projectId = create.json().project.id;
    const canvas = { revision: 0, nodes: [], edges: [] };

    const firstSave = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(firstSave.statusCode).toBe(200);

    const staleSave = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(staleSave.statusCode).toBe(409);
    expect(staleSave.json()).toMatchObject({ revision: 1 });

    const current = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/canvas`,
    });
    expect(current.json().canvas).toEqual({ revision: 1, nodes: [], edges: [] });
  });

  it('rejects an invalid canvas before it reaches the project store', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Validation test' },
    });
    const projectId = create.json().project.id;

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_audio',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { label: 'Audio', mediaType: 'audio', mode: 'source' },
          },
          {
            id: 'node_image',
            type: 'image',
            position: { x: 200, y: 0 },
            data: { label: 'Image', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [
          {
            id: 'edge_invalid',
            sourceNodeId: 'node_audio',
            sourceHandle: 'output:audio',
            targetNodeId: 'node_image',
            targetHandle: 'input:style',
            order: 0,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid canvas');
  });
});

describe('run endpoints', () => {
  it('lists run history after checking project access', async () => {
    const historyApp = buildApp({ logger: false });
    try {
      const create = await historyApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Run history test' },
      });
      const projectId = create.json().project.id as string;
      await historyApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_history_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const submit = await historyApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_history_text/runs',
        payload: { projectId },
      });
      const runId = submit.json().run.id as string;

      const response = await historyApp.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/runs`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().runs).toEqual([expect.objectContaining({ id: runId, projectId })]);

      const missing = await historyApp.inject({
        method: 'GET',
        url: '/v1/projects/project_missing/runs',
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'project not found' });
    } finally {
      await historyApp.close();
    }
  });

  it('rejects a priced run above the configured per-run ceiling', async () => {
    vi.stubEnv('MAX_RUN_COST', '1.00');
    vi.stubEnv('RUN_COST_CURRENCY', 'USD');
    const settingsStore = new AiSettingsStore('cost-policy-test-secret');
    settingsStore.replaceModels([
      {
        id: 'priced-image',
        name: 'Priced image',
        mediaTypes: ['image'],
        price: { currency: 'USD', perRun: '1.01' },
        refreshedAt: new Date().toISOString(),
      },
    ]);
    const costApp = buildApp({ logger: false, settingsStore });
    try {
      const create = await costApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Cost policy test' },
      });
      const projectId = create.json().project.id;
      await costApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'priced_image',
              type: 'image',
              position: { x: 0, y: 0 },
              data: {
                label: 'Priced image',
                mediaType: 'image',
                mode: 'generate',
                modelAlias: 'priced-image',
              },
            },
          ],
          edges: [],
        },
      });

      const response = await costApp.inject({
        method: 'POST',
        url: '/v1/nodes/priced_image/runs',
        payload: { projectId },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: 'cost_limit_exceeded' });
    } finally {
      await costApp.close();
      vi.unstubAllEnvs();
    }
  });

  it('uses a node model override when the request does not provide one', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Node model override' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_image_override',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              label: 'Override image',
              mediaType: 'image',
              mode: 'generate',
              modelAlias: 'image-node-model',
            },
          },
        ],
        edges: [],
      },
    });
    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_image_override/runs',
      payload: { projectId },
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json().run.modelAlias).toBe('image-node-model');
  });

  it('rejects source nodes and runs a generated node from an immutable input snapshot', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Run test' },
    });
    const projectId = create.json().project.id;
    const canvas = {
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 240, y: 0 },
          data: { label: 'Generate image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
    };
    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: canvas,
    });
    expect(save.statusCode).toBe(200);

    const sourceRun = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_prompt/runs',
      payload: { projectId },
    });
    expect(sourceRun.statusCode).toBe(400);

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_image/runs',
      payload: { projectId, modelAlias: 'image-special', parameters: { width: 1024 } },
    });
    expect(submit.statusCode).toBe(202);
    const run = submit.json().run;
    expect(run.status).toBe('queued');
    expect(run.modelAlias).toBe('image-special');
    expect(run.snapshot.canvasRevision).toBe(1);
    expect(run.snapshot.inputs).toMatchObject([
      { nodeId: 'node_prompt', role: 'prompt', sortOrder: 0 },
    ]);

    const update = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        ...canvas,
        revision: 1,
        nodes: canvas.nodes.map((node) =>
          node.id === 'node_prompt'
            ? { ...node, data: { ...node.data, label: 'Changed after submit' } }
            : node,
        ),
      },
    });
    expect(update.statusCode).toBe(200);

    const completed = await waitForRun(run.id, 'succeeded');
    expect(completed.result).toMatchObject({
      provider: 'mock',
      targetNodeId: 'node_image',
      inputCount: 1,
    });
    expect(completed.snapshot.inputs[0].snapshot.data.label).toBe('Prompt');
  });

  it('cancels a queued run and retries it without changing its attempt snapshot', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Cancel test' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_video',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Generate video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
    });

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_video/runs',
      payload: { projectId },
    });
    const run = submit.json().run;
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(202);

    const cancelled = await waitForRun(run.id, 'cancelled');
    expect(cancelled.progress).toBe(0);

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/retry`,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().run).toMatchObject({ attempt: 2, retryOf: run.id });

    const completed = await waitForRun(retry.json().run.id, 'succeeded');
    expect(completed.snapshot).toEqual(run.snapshot);
  });
});

describe('project event stream', () => {
  it('returns not found for an unknown project', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/projects/project_missing/events',
    });
    expect(response.statusCode).toBe(404);
  });

  it('publishes a ready event and the current run snapshot', async () => {
    const streamApp = buildApp({ logger: false });
    const address = await streamApp.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    try {
      const create = await streamApp.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Event stream test' },
      });
      const projectId = create.json().project.id;
      await streamApp.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: {
          revision: 0,
          nodes: [
            {
              id: 'node_text',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { label: 'Generate text', mediaType: 'text', mode: 'generate' },
            },
          ],
          edges: [],
        },
      });
      const runResponse = await streamApp.inject({
        method: 'POST',
        url: '/v1/nodes/node_text/runs',
        payload: { projectId },
      });
      expect(runResponse.statusCode).toBe(202);

      const response = await fetch(`${address}/v1/projects/${projectId}/events`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await Promise.race([
        reader!.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SSE stream did not publish an initial event')), 1_000),
        ),
      ]);
      const text = new TextDecoder().decode(firstChunk.value);
      expect(text).toContain('event: ready');
      expect(text).toContain('event: run.updated');
      await reader!.cancel();
    } finally {
      controller.abort();
      await streamApp.close();
    }
  });
});

describe('webhook and run idempotency boundaries', () => {
  it('deduplicates New API webhook event ids', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/newapi',
      headers: { 'x-newapi-event-id': 'event_1' },
      payload: { type: 'video.completed' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/newapi',
      headers: { 'x-newapi-event-id': 'event_1' },
      payload: { type: 'video.completed' },
    });
    expect(first.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ accepted: true, deduplicated: true, eventId: 'event_1' });
  });

  it('returns the same run for repeated idempotency keys', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { name: 'Idempotent run' },
    });
    const projectId = create.json().project.id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}/canvas`,
      payload: {
        revision: 0,
        nodes: [
          {
            id: 'node_text_idempotent',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
    });
    const payload = { projectId, idempotencyKey: 'client-run-1' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_text_idempotent/runs',
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_text_idempotent/runs',
      headers: { 'idempotency-key': 'client-run-1' },
      payload: { projectId },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().run.id).toBe(first.json().run.id);
  });
});

async function waitForRun(runId: string, expectedStatus: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const run = response.json().run;
    if (run.status === expectedStatus) return run;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}

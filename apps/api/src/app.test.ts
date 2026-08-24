import { afterAll, describe, expect, it } from 'vitest';

import { MemoryAssetStore } from './assets';
import { buildApp } from './app';

const app = buildApp({ logger: false, assetStore: new MemoryAssetStore() });

afterAll(async () => app.close());

describe('health endpoint', () => {
  it('reports that the API is available', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
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
});

describe('project and canvas endpoints', () => {
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
      payload: { projectId, parameters: { width: 1024 } },
    });
    expect(submit.statusCode).toBe(202);
    const run = submit.json().run;
    expect(run.status).toBe('queued');
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

async function waitForRun(runId: string, expectedStatus: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const run = response.json().run;
    if (run.status === expectedStatus) return run;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';

/** 等待本地 Mock 运行终态；失败时返回实际状态，便于保留错误证据。 */
async function completedRun(service: MemoryRunService, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.get(runId);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Mock run did not complete');
}

/** 合成外部 JWT，仅用于验证资产读取与写入的用户隔离。 */
function authorization(userId: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 }),
  ).toString('base64url');
  const signature = createHmac('sha256', 'prompt-routes-test-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `Bearer ${header}.${payload}.${signature}`;
}

afterEach(() => vi.unstubAllEnvs());

describe('asset-version request prompts', () => {
  it('returns frozen legacy input only for the exact generated asset version', async () => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', '');
    const projectStore = new MemoryProjectStore();
    const assetStore = new MemoryAssetStore();
    const service = new MemoryRunService({
      stepDelayMs: 0,
      executor: async (request) => ({
        result: {
          provider: 'mock',
          summary: 'Legacy output',
          targetNodeId: request.snapshot.targetNodeId,
          mediaType: 'text',
          inputCount: 0,
        },
        output: { text: 'Generated result', mimeType: 'text/plain' },
      }),
    });
    const app = buildApp({ logger: false, projectStore, assetStore, runService: service });
    try {
      const project = await projectStore.create({ name: 'Legacy generation' });
      const snapshot = createRunSnapshot(
        project.id,
        {
          revision: 0,
          nodes: [
            {
              id: 'legacy_node',
              type: 'text',
              position: { x: 0, y: 0 },
              data: {
                label: 'Legacy draft',
                mediaType: 'text',
                mode: 'generate',
                prompt: 'Frozen historical input',
              },
            },
          ],
          edges: [],
        },
        'legacy_node',
      );
      const submitted = await service.create(snapshot);
      snapshot.nodes[0]!.data.prompt = 'Edited current input';
      const run = await completedRun(service, submitted.id);
      expect(run.status).toBe('succeeded');
      const assetId = run.result!.asset!.assetId;
      const versions = await assetStore.listVersions(assetId);
      expect(versions[0]?.metadata?.runId).toBe(run.id);
      const original = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/1/request-prompts`,
      });
      expect(original.statusCode).toBe(200);
      expect(original.json()).toMatchObject({
        records: [],
        inputSnapshot: { text: 'Frozen historical input', nodeId: 'legacy_node', runId: run.id },
        timing: { nodeId: 'legacy_node', outcome: 'succeeded' },
      });
      expect(original.body).not.toContain('Edited current input');

      await assetStore.createVersion(assetId, {
        content: Buffer.from('Manual replacement'),
        metadata: { runId: run.id },
      });
      const manual = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/2/request-prompts`,
      });
      expect(manual.statusCode).toBe(200);
      expect(manual.json()).toEqual({ records: [] });

      const unrelated = await assetStore.create({
        name: 'Other asset',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('Imported content'),
        metadata: { runId: run.id },
      });
      const mismatched = await app.inject({
        method: 'GET',
        url: `/v1/assets/${unrelated.id}/versions/1/request-prompts`,
      });
      expect(mismatched.statusCode).toBe(200);
      expect(mismatched.json()).toEqual({ records: [] });

      const oldVersion = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/1/request-prompts`,
      });
      expect(oldVersion.json().inputSnapshot?.text).toBe('Frozen historical input');
    } finally {
      await app.close();
      await service.close();
    }
  });

  it('keeps the sent prompt and timing after edits and node deletion, and saves only the summary', async () => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', '');
    const projectStore = new MemoryProjectStore();
    const assetStore = new MemoryAssetStore();
    const service = new MemoryRunService({ stepDelayMs: 0 });
    const app = buildApp({ logger: false, projectStore, assetStore, runService: service });
    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { name: 'Prompt provenance' },
      });
      const projectId = projectResponse.json().project.id as string;
      const snapshot = createRunSnapshot(
        projectId,
        {
          revision: 0,
          nodes: [
            {
              id: 'source_node',
              type: 'text',
              position: { x: 0, y: 0 },
              data: {
                label: 'Draft',
                mediaType: 'text',
                mode: 'generate',
                prompt: 'Frozen prompt before editing',
              },
            },
          ],
          edges: [],
        },
        'source_node',
      );
      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: { revision: 0, nodes: snapshot.nodes, edges: [] },
      });
      const submitted = await service.create(snapshot);
      snapshot.nodes[0]!.data.prompt = 'Edited after submission';
      const run = await completedRun(service, submitted.id);
      expect(run.status).toBe('succeeded');
      const assetId = run.result!.asset!.assetId;
      const url = `/v1/assets/${assetId}/versions/1/request-prompts`;
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(Date.parse(response.headers['x-server-time'] as string)).toBeGreaterThan(0);
      const record = response.json().records[0];
      expect(record).toMatchObject({
        runId: run.id,
        nodeId: 'source_node',
        assetId,
        assetVersion: 1,
        sendStatus: 'sent',
        parts: [{ order: 0, text: 'Frozen prompt before editing' }],
      });
      expect(response.json().timing).toMatchObject({ nodeId: 'source_node', outcome: 'succeeded' });
      expect(Date.parse(response.json().timing.finishedAt)).toBeGreaterThanOrEqual(
        Date.parse(response.json().timing.startedAt),
      );
      const summaries = await app.inject({
        method: 'GET',
        url: `/v1/runs/${run.id}/request-prompts`,
      });
      expect(summaries.json().records).toHaveLength(1);
      expect(summaries.body).not.toContain('Frozen prompt before editing');
      const saved = await app.inject({
        method: 'PATCH',
        url: `${url}/${record.id}`,
        payload: { summary: '完整手动摘要' },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().record).toMatchObject({
        summary: '完整手动摘要',
        summarySource: 'manual',
        parts: record.parts,
      });
      const overwrite = await app.inject({
        method: 'PATCH',
        url: `${url}/${record.id}`,
        payload: { summary: 'Changed', parts: [{ order: 0, text: 'overwrite' }] },
      });
      expect(overwrite.statusCode).toBe(400);
      const oversized = await app.inject({
        method: 'PATCH',
        url: `${url}/${record.id}`,
        payload: { summary: 'x'.repeat(2001) },
      });
      expect(oversized.statusCode).toBe(400);
      await assetStore.createVersion(assetId, { content: Buffer.from('manual result') });
      const manualVersion = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/2/request-prompts`,
      });
      expect(manualVersion.json()).toEqual({ records: [] });
      const wrongVersion = await app.inject({
        method: 'PATCH',
        url: `/v1/assets/${assetId}/versions/2/request-prompts/${record.id}`,
        payload: { summary: 'wrong version' },
      });
      expect(wrongVersion.statusCode).toBe(404);
      const deleted = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}/canvas`,
        payload: { revision: 1, nodes: [], edges: [] },
      });
      expect(deleted.statusCode).toBe(200);
      const afterDeletion = await app.inject({ method: 'GET', url });
      expect(afterDeletion.json().records[0]).toMatchObject({
        summary: '完整手动摘要',
        parts: record.parts,
      });
      const missingVersion = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/9/request-prompts`,
      });
      expect(missingVersion.statusCode).toBe(404);
      const invalidVersion = await app.inject({
        method: 'GET',
        url: `/v1/assets/${assetId}/versions/1.1/request-prompts`,
      });
      expect(invalidVersion.statusCode).toBe(400);
    } finally {
      await app.close();
      await service.close();
    }
  });

  it('rejects another owner before reading or modifying a prompt and exposes clock headers through CORS', async () => {
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', 'prompt-routes-test-secret');
    vi.stubEnv('CORS_ORIGIN', 'http://localhost:5173');
    const owner = '123e4567-e89b-42d3-a456-426614174001';
    const other = '123e4567-e89b-42d3-a456-426614174002';
    const assetStore = new MemoryAssetStore();
    const asset = await assetStore.create({
      name: 'Private result',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('private result'),
      ownerId: owner,
    });
    const persistence = {
      upsertProviderJob: vi.fn(),
      updateRun: vi.fn(),
      listAssetRequestPromptRecords: vi.fn(async () => []),
      updateAssetRequestPromptSummary: vi.fn(),
    };
    const app = buildApp({
      logger: false,
      assetStore,
      runPersistence: persistence,
      userExists: async () => true,
    });
    try {
      const url = `/v1/assets/${asset.id}/versions/1/request-prompts`;
      const deniedRead = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: authorization(other) },
      });
      const deniedWrite = await app.inject({
        method: 'PATCH',
        url: `${url}/record_1`,
        headers: { authorization: authorization(other) },
        payload: { summary: 'blocked' },
      });
      expect(deniedRead.statusCode).toBe(404);
      expect(deniedWrite.statusCode).toBe(404);
      expect(persistence.listAssetRequestPromptRecords).not.toHaveBeenCalled();
      expect(persistence.updateAssetRequestPromptSummary).not.toHaveBeenCalled();
      const ownRead = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: authorization(owner), origin: 'http://localhost:5173' },
      });
      expect(ownRead.statusCode).toBe(200);
      expect(ownRead.headers['access-control-expose-headers']).toContain('x-server-time');
      expect(persistence.listAssetRequestPromptRecords).toHaveBeenCalledWith(asset.id, 1);
    } finally {
      await app.close();
    }
  });
});

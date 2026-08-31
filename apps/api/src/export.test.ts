import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '@multimodal-canvas/domain';

import { MemoryAssetStore } from './assets';
import { buildApp } from './app';
import {
  attachmentDisposition,
  createWorkflowExport,
  prepareResultsExport,
  sanitizeExportValue,
} from './export';
import { MemoryProjectStore } from './projects';
import type { RunService } from './runs';

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeCanvas() {
  return {
    revision: 0,
    nodes: [
      {
        id: 'target',
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Generated text',
          mediaType: 'text' as const,
          mode: 'generate' as const,
          prompt: 'write a short note',
          contentUrl: 'https://signed.example.invalid/token',
        },
      },
    ],
    edges: [],
  };
}

function makeRun(
  projectId: string,
  assetId: string,
  overrides: Partial<RunRecord> = {},
): RunRecord {
  const timestamp = '2026-08-26T00:00:00.000Z';
  return {
    id: overrides.id ?? 'run-1',
    projectId,
    targetNodeId: 'target',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'text-model',
    snapshot: {
      projectId,
      canvasRevision: 1,
      targetNodeId: 'target',
      modelAlias: 'text-model',
      credentialId: 'credential-secret-id',
      credentialVersion: 4,
      nodeCredentialReferences: {
        target: { credentialId: 'credential-node-secret-id', credentialVersion: 5 },
      },
      parameters: { apiKey: 'do-not-export', temperature: 0.2 },
      submittedAt: timestamp,
      nodes: makeCanvas().nodes,
      edges: [],
      inputs: [],
    },
    result: {
      provider: 'mock',
      summary: 'done',
      targetNodeId: 'target',
      mediaType: 'text',
      inputCount: 0,
      asset: {
        assetId,
        version: 1,
        contentUrl: 'https://signed.example.invalid/result',
        mimeType: 'text/plain',
      },
      providerJob: {
        id: 'provider-job',
        provider: 'mock',
        platformJobId: 'platform-id',
        status: 'succeeded',
        progress: 100,
        payload: { apiKey: 'also-do-not-export' },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function fakeRunService(runs: readonly RunRecord[]): RunService {
  return {
    create: vi.fn(),
    get: vi.fn(async (id: string) => runs.find((run) => run.id === id)),
    listByProject: vi.fn(async (projectId: string) =>
      runs.filter((run) => run.projectId === projectId),
    ),
    retry: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as RunService;
}

describe('workflow export sanitization', () => {
  it('omits credentials, secret fields, and URL values while retaining graph metadata', () => {
    const run = makeRun('project-1', 'asset-1');
    const workflow = createWorkflowExport({
      project: {
        id: 'project-1',
        name: 'Demo',
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
      canvas: makeCanvas(),
      runs: [run],
    });
    const serialized = JSON.stringify(workflow);
    expect(serialized).not.toContain('credential-secret-id');
    expect(serialized).not.toContain('credential-node-secret-id');
    expect(serialized).not.toContain('do-not-export');
    expect(serialized).not.toContain('signed.example.invalid');
    expect(workflow.canvas.nodes[0]?.data.prompt).toBe('write a short note');
    expect(workflow.results[0]?.asset).toMatchObject({ assetId: 'asset-1', version: 1 });
    expect(workflow.results[0]?.asset).not.toHaveProperty('contentUrl');
    expect(sanitizeExportValue({ apiKey: 'secret', value: 1 })).toEqual({ value: 1 });
    expect(attachmentDisposition('工作流.results.zip')).toContain("filename*=UTF-8''");
    expect(attachmentDisposition('工作流.results.zip')).toContain('filename="__');
  });
});

describe('project export routes', () => {
  it('requires project authorization before returning workflow data', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'export-test-token');
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Private project' }, { ownerId: 'owner-1' });
    const app = buildApp({ logger: false, projectStore });
    try {
      const missing = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/export/workflow`,
      });
      expect(missing.statusCode).toBe(401);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/export/workflow`,
        headers: { authorization: 'Bearer export-test-token' },
      });
      // API tokens are not owner-scoped, so the service token can access the
      // project; the unauthenticated request above is still rejected.
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });

  it('returns a ZIP with workflow, manifest, and deduplicated result bytes', async () => {
    const assetStore = new MemoryAssetStore();
    const asset = await assetStore.create({
      name: '../../unsafe/report.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('result bytes'),
    });
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Export demo' });
    const canvas = makeCanvas();
    await projectStore.updateCanvas(project.id, canvas);
    const runs = [
      makeRun(project.id, asset.id, { id: 'run-1' }),
      makeRun(project.id, asset.id, { id: 'run-2' }),
    ];
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService: fakeRunService(runs),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/export/results`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/zip');
      expect(response.headers['content-disposition']).toContain('attachment');
      const files = unzipSync(response.rawPayload);
      const names = Object.keys(files).sort();
      expect(names).toContain('workflow.json');
      expect(names).toContain('manifest.json');
      const resultNames = names.filter((name) => name.startsWith('results/'));
      expect(resultNames).toHaveLength(1);
      expect(Buffer.from(files[resultNames[0]] ?? []).toString('utf8')).toBe('result bytes');
      const manifest = JSON.parse(Buffer.from(files['manifest.json'] ?? []).toString('utf8')) as {
        fileCount: number;
        totalBytes: number;
        files: Array<{ runIds: string[]; path: string }>;
      };
      expect(manifest.fileCount).toBe(1);
      expect(manifest.totalBytes).toBe(Buffer.byteLength('result bytes'));
      expect(manifest.files[0]?.runIds.sort()).toEqual(['run-1', 'run-2']);
      expect(manifest.files[0]?.path).toBe(resultNames[0]);
      const workflow = JSON.parse(Buffer.from(files['workflow.json'] ?? []).toString('utf8')) as {
        results: Array<{ asset?: { path?: string } }>;
      };
      expect(workflow.results.every((result) => result.asset?.path === resultNames[0])).toBe(true);
      expect(resultNames[0]).not.toContain('..');
    } finally {
      await app.close();
    }
  });

  it('rejects a result export that exceeds the configured byte limit', async () => {
    vi.stubEnv('EXPORT_MAX_RESULT_BYTES', '4');
    const assetStore = new MemoryAssetStore();
    const asset = await assetStore.create({
      name: 'large.txt',
      mediaType: 'text',
      mimeType: 'text/plain',
      content: Buffer.from('12345'),
    });
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'Limited export' });
    const app = buildApp({
      logger: false,
      assetStore,
      projectStore,
      runService: fakeRunService([makeRun(project.id, asset.id)]),
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/export/results`,
      });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ code: 'export_limit_exceeded' });
    } finally {
      await app.close();
    }
  });

  it('can prepare an empty results archive while retaining the workflow', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: 'No results' });
    const prepared = await prepareResultsExport({
      project,
      canvas: makeCanvas(),
      runs: [],
      assetStore: new MemoryAssetStore(),
    });
    expect(prepared.manifest.fileCount).toBe(0);
    expect(prepared.entries.map((entry) => entry.path)).toEqual(['workflow.json', 'manifest.json']);
  });
});

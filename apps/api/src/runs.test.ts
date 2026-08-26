import { afterEach, describe, expect, it } from 'vitest';

import {
  createIdempotentRunId,
  createRunSnapshot,
  MemoryRunService,
  type RunExecutorRequest,
} from './runs';

function snapshot() {
  return createRunSnapshot(
    'project_1',
    {
      revision: 2,
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
    'node_text',
  );
}

describe('run idempotency', () => {
  const services: MemoryRunService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it('returns the original memory run for a repeated project-scoped key', async () => {
    const service = new MemoryRunService({ stepDelayMs: 100 });
    services.push(service);
    const [first, repeated] = await Promise.all([
      service.create(snapshot(), { idempotencyKey: ' submit-1 ' }),
      service.create(snapshot(), { idempotencyKey: 'submit-1' }),
    ]);

    expect(repeated.id).toBe(first.id);
    expect(repeated.idempotencyKey).toBe('submit-1');
    expect(await service.listByProject('project_1')).toHaveLength(1);
  });

  it('creates a stable BullMQ-compatible id from project and key', () => {
    expect(createIdempotentRunId('project_1', 'submit-1')).toBe(
      createIdempotentRunId('project_1', 'submit-1'),
    );
    expect(createIdempotentRunId('project_1', 'submit-1')).not.toBe(
      createIdempotentRunId('project_2', 'submit-1'),
    );
  });

  it('rejects reuse of a key for a different request', async () => {
    const service = new MemoryRunService({ stepDelayMs: 100 });
    services.push(service);
    await service.create(snapshot(), { idempotencyKey: 'submit-2' });
    const changed = { ...snapshot(), canvasRevision: 3 };

    await expect(service.create(changed, { idempotencyKey: 'submit-2' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
});

describe('run credential snapshots', () => {
  it('stores only the credential reference and version', () => {
    const result = createRunSnapshot(
      'project_1',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_text',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_text',
      { credentialId: 'credential_1', credentialVersion: 3 },
    );

    expect(result).toMatchObject({ credentialId: 'credential_1', credentialVersion: 3 });
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });
});

describe('disabled canvas nodes', () => {
  it('excludes disabled references and rejects a disabled target', () => {
    const canvas = {
      revision: 1,
      nodes: [
        {
          id: 'source_enabled',
          type: 'text' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Enabled', mediaType: 'text' as const, mode: 'source' as const },
        },
        {
          id: 'source_disabled',
          type: 'text' as const,
          position: { x: 0, y: 80 },
          data: {
            label: 'Disabled',
            mediaType: 'text' as const,
            mode: 'source' as const,
            enabled: false,
          },
        },
        {
          id: 'target',
          type: 'text' as const,
          position: { x: 240, y: 40 },
          data: { label: 'Target', mediaType: 'text' as const, mode: 'generate' as const },
        },
        {
          id: 'disabled_target',
          type: 'text' as const,
          position: { x: 240, y: 140 },
          data: {
            label: 'Disabled target',
            mediaType: 'text' as const,
            mode: 'generate' as const,
            enabled: false,
          },
        },
      ],
      edges: [
        {
          id: 'edge_enabled',
          sourceNodeId: 'source_enabled',
          sourceHandle: 'output:text',
          targetNodeId: 'target',
          targetHandle: 'input:content',
          order: 0,
        },
        {
          id: 'edge_disabled',
          sourceNodeId: 'source_disabled',
          sourceHandle: 'output:text',
          targetNodeId: 'target',
          targetHandle: 'input:content',
          order: 1,
        },
      ],
    };

    const result = createRunSnapshot('project_1', canvas, 'target');
    expect(result.inputs.map((input) => input.nodeId)).toEqual(['source_enabled']);
    expect(result.nodes.map((node) => node.id)).not.toContain('source_disabled');

    expect(() => createRunSnapshot('project_1', canvas, 'disabled_target')).toThrow(
      'disabled nodes cannot be run',
    );
  });
});

describe('asynchronous provider recovery', () => {
  const services: MemoryRunService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it('persists a platform task callback and reuses it on retry', async () => {
    const videoSnapshot = createRunSnapshot(
      'project_video',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_video',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_video',
      { modelAlias: 'video-model' },
    );
    const requests: RunExecutorRequest[] = [];
    let attempt = 0;
    const service = new MemoryRunService({
      stepDelayMs: 0,
      providerName: 'newapi',
      executor: async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) {
          await request.onProviderJob?.({
            provider: 'newapi',
            platformJobId: 'platform-video-1',
            status: 'submitted',
            progress: 5,
          });
          throw Object.assign(new Error('poll timeout'), {
            platformJobId: 'platform-video-1',
            providerPayload: { phase: 'polling' },
          });
        }
        expect(request.providerJob).toMatchObject({ platformJobId: 'platform-video-1' });
        return {
          result: {
            provider: 'newapi',
            summary: 'resumed video',
            targetNodeId: 'node_video',
            mediaType: 'video',
            inputCount: 0,
          },
        };
      },
    });
    services.push(service);

    const first = await service.create(videoSnapshot);
    const failed = await waitForTerminalRun(service, first.id);
    expect(failed.status).toBe('failed');
    expect(failed.providerJob).toMatchObject({ platformJobId: 'platform-video-1' });

    const retry = await service.retry(first.id);
    expect(retry.providerJob).toMatchObject({
      platformJobId: 'platform-video-1',
      status: 'submitted',
    });
    const succeeded = await waitForTerminalRun(service, retry.id);
    expect(succeeded.status).toBe('succeeded');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.providerJob).toMatchObject({ platformJobId: 'platform-video-1' });
  });

  it('starts a fresh platform task after a confirmed terminal provider failure', async () => {
    const videoSnapshot = createRunSnapshot(
      'project_video_terminal',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_video_terminal',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_video_terminal',
      { modelAlias: 'video-model' },
    );
    let attempt = 0;
    const requests: RunExecutorRequest[] = [];
    const service = new MemoryRunService({
      stepDelayMs: 0,
      providerName: 'newapi',
      executor: async (request) => {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) {
          await request.onProviderJob?.({
            provider: 'newapi',
            platformJobId: 'terminal-video',
            status: 'failed',
            progress: 100,
            payload: { phase: 'failed', providerStatus: 'failed' },
          });
          throw Object.assign(new Error('provider rejected content'), {
            platformJobId: 'terminal-video',
            providerPayload: { phase: 'failed', providerStatus: 'failed' },
          });
        }
        expect(request.providerJob?.platformJobId).toBeUndefined();
        return {
          result: {
            provider: 'newapi',
            summary: 'fresh video task',
            targetNodeId: 'node_video_terminal',
            mediaType: 'video',
            inputCount: 0,
          },
        };
      },
    });
    services.push(service);

    const first = await service.create(videoSnapshot);
    const failed = await waitForTerminalRun(service, first.id);
    expect(failed.status).toBe('failed');
    const retry = await service.retry(first.id);
    expect(retry.providerJob?.platformJobId).toBeUndefined();
    const succeeded = await waitForTerminalRun(service, retry.id);
    expect(succeeded.status).toBe('succeeded');
    expect(requests).toHaveLength(2);
  });
});

async function waitForTerminalRun(service: MemoryRunService, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.get(runId);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}

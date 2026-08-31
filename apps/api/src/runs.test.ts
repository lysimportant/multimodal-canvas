import { afterEach, describe, expect, it } from 'vitest';

import {
  createIdempotentRunId,
  createRunSnapshot,
  MemoryRunService,
  snapshotFingerprint,
  type RunExecutorRequest,
} from './runs';
import { runSnapshotFingerprintMaterial } from '@multimodal-canvas/domain';
import { createHash } from 'node:crypto';

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

  it('coalesces semantically identical snapshots despite timestamp and key-order changes', async () => {
    const service = new MemoryRunService({ stepDelayMs: 100 });
    services.push(service);
    const firstSnapshot = {
      ...snapshot(),
      parameters: {
        nested: { first: 'one', second: 'two' },
        list: ['first', 'second'],
      },
    };
    const equivalentSnapshot = {
      ...firstSnapshot,
      submittedAt: '2026-08-24T00:01:00.000Z',
      parameters: {
        list: ['first', 'second'],
        nested: { second: 'two', first: 'one' },
      },
    };

    const first = await service.create(firstSnapshot, { idempotencyKey: 'semantic-1' });
    const repeated = await service.create(equivalentSnapshot, {
      idempotencyKey: 'semantic-1',
    });

    expect(repeated.id).toBe(first.id);
    expect(await service.listByProject('project_1')).toHaveLength(1);
  });

  it('hashes the shared v2 fingerprint material used by the Worker', () => {
    const value = snapshot();
    const expected = createHash('sha256')
      .update(runSnapshotFingerprintMaterial(value))
      .digest('hex');

    expect(snapshotFingerprint(value)).toBe(expected);
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

  it('coalesces concurrent retries of the same failed run', async () => {
    let executions = 0;
    const service = new MemoryRunService({
      stepDelayMs: 0,
      executor: async () => {
        executions += 1;
        throw new Error('retryable failure');
      },
    });
    services.push(service);
    const first = await service.create(snapshot());
    const failed = await waitForTerminalRun(service, first.id);
    expect(failed.status).toBe('failed');

    const [left, right] = await Promise.all([service.retry(first.id), service.retry(first.id)]);

    expect(right.id).toBe(left.id);
    expect(left).toMatchObject({ attempt: 2, retryOf: first.id });
    await waitForTerminalRun(service, left.id);
    expect(await service.listByProject(first.projectId)).toHaveLength(2);
    expect(executions).toBe(2);
  });

  it('redacts complete authorization bearer values before storing run errors', async () => {
    const service = new MemoryRunService({
      stepDelayMs: 0,
      executor: async () => {
        throw new Error(
          'provider authorization: Bearer synthetic-bearer-secret; Authorization=Bearer synthetic-header-secret',
        );
      },
    });
    services.push(service);

    const created = await service.create(snapshot());
    const failed = await waitForTerminalRun(service, created.id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('authorization: Bearer [redacted]');
    expect(failed.error).toContain('Authorization=Bearer [redacted]');
    expect(failed.error).not.toContain('synthetic-bearer-secret');
    expect(failed.error).not.toContain('synthetic-header-secret');
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

describe('provider webhook lifecycle updates', () => {
  it('updates the matching platform job without regressing or leaking payload fields', async () => {
    let releaseExecutor!: () => void;
    let signalProviderReady!: () => void;
    const executorReleased = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const providerReady = new Promise<void>((resolve) => {
      signalProviderReady = resolve;
    });
    const service = new MemoryRunService({
      stepDelayMs: 0,
      providerName: 'newapi',
      executor: async (request) => {
        await request.onProviderJob?.({
          provider: 'newapi',
          platformJobId: 'platform-webhook-1',
          status: 'submitted',
          progress: 5,
        });
        signalProviderReady();
        await executorReleased;
        return {
          result: {
            provider: 'newapi',
            summary: 'webhook result',
            targetNodeId: 'node_video_webhook',
            mediaType: 'video',
            inputCount: 0,
          },
        };
      },
    });

    const videoSnapshot = createRunSnapshot(
      'project_webhook',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_video_webhook',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_video_webhook',
    );

    try {
      const run = await service.create(videoSnapshot);
      await providerReady;

      const running = await service.applyProviderWebhook({
        provider: 'newapi',
        platformJobId: 'platform-webhook-1',
        status: 'running',
        progress: 95,
        payload: {
          providerStatus: 'processing',
          contentUrl: 'https://provider.example/video.mp4',
          authorization: 'must-not-persist',
        },
      });
      expect(running).toMatchObject({
        id: run.id,
        status: 'processing',
        progress: 95,
        providerJob: {
          platformJobId: 'platform-webhook-1',
          status: 'running',
          progress: 95,
          payload: { providerStatus: 'processing' },
        },
      });

      const succeeded = await service.applyProviderWebhook({
        provider: 'newapi',
        platformJobId: 'platform-webhook-1',
        status: 'succeeded',
      });
      expect(succeeded).toMatchObject({
        id: run.id,
        status: 'succeeded',
        progress: 100,
        providerJob: { status: 'succeeded', progress: 100 },
      });
      releaseExecutor();
    } finally {
      releaseExecutor();
      await service.close();
    }
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

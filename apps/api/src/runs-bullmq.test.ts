import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  job: undefined as any,
  getJob: undefined as any,
  add: undefined as any,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(..._args: unknown[]) {}
    async getJob(...args: unknown[]) {
      return state.getJob ? state.getJob(...args) : state.job;
    }
    async add(...args: unknown[]) {
      if (!state.add) throw new Error('queue add is not configured');
      return state.add(...args);
    }
    async close() {}
  }
  return { Queue };
});

import { BullMqRunService, createIdempotentRunId, createRunSnapshot } from './runs';

afterEach(() => {
  state.job = undefined;
  state.getJob = undefined;
  state.add = undefined;
});

describe('BullMQ run result integrity', () => {
  it('falls back to durable persistence when the BullMQ job has expired', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 4,
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
    );
    state.getJob = vi.fn(async () => undefined);
    const durableRun = {
      id: 'run_expired',
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'succeeded' as const,
      progress: 100,
      attempt: 1,
      provider: 'mock',
      modelAlias: snapshot.modelAlias,
      snapshot,
      result: {
        provider: 'mock',
        summary: 'durable result',
        targetNodeId: snapshot.targetNodeId,
        mediaType: 'text' as const,
        inputCount: 0,
      },
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      getRun: vi.fn(async () => durableRun),
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    await expect(service.get(durableRun.id)).resolves.toEqual(durableRun);
    expect(persistence.getRun).toHaveBeenCalledWith(durableRun.id);
    await service.close();
  });

  it('marks a completed job with an invalid result envelope as failed', async () => {
    const snapshot = createRunSnapshot(
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
    );
    state.job = {
      id: 'run_1',
      data: {
        runId: 'run_1',
        snapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      progress: undefined,
      returnvalue: { status: 'succeeded', progress: 100, result: { malformed: true } },
      timestamp: Date.now(),
      async getState() {
        return 'completed';
      },
    };

    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });
    await expect(service.get('run_1')).resolves.toMatchObject({
      status: 'failed',
      error: 'worker returned an invalid run result',
    });
    await service.close();
  });

  it('recovers an idempotent request when BullMQ rejects a concurrent duplicate add', async () => {
    const snapshot = createRunSnapshot(
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
    );
    const existingJob = {
      id: createIdempotentRunId('project_1', 'same-request'),
      data: {
        runId: createIdempotentRunId('project_1', 'same-request'),
        snapshot,
        attempt: 1,
        provider: 'mock',
        idempotencyKey: 'same-request',
        cancelRequested: false,
      },
      progress: undefined,
      returnvalue: undefined,
      timestamp: Date.now(),
      async getState() {
        return 'waiting';
      },
    };
    state.getJob = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(existingJob);
    state.add = vi.fn().mockRejectedValue(new Error('job already exists'));
    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });

    await expect(
      service.create(snapshot, { idempotencyKey: 'same-request' }),
    ).resolves.toMatchObject({
      id: createIdempotentRunId('project_1', 'same-request'),
      status: 'queued',
    });
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.getJob).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('publishes only one BullMQ job for concurrent retries of the same run', async () => {
    const snapshot = createRunSnapshot(
      'project_retry',
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
    );
    const previous = {
      id: 'run_failed',
      data: {
        runId: 'run_failed',
        snapshot,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      },
      progress: { status: 'failed', progress: 80, updatedAt: new Date().toISOString() },
      returnvalue: undefined,
      failedReason: 'provider failed',
      timestamp: Date.now(),
      async getState() {
        return 'failed';
      },
    };
    let retryJob: any;
    let createdJobs = 0;
    state.getJob = vi.fn(async (id: string) => (id === previous.id ? previous : retryJob));
    state.add = vi.fn(async (_name: string, data: any) => {
      if (retryJob) throw new Error('job already exists');
      createdJobs += 1;
      retryJob = {
        id: data.runId,
        data,
        progress: undefined,
        returnvalue: undefined,
        timestamp: Date.now(),
        async getState() {
          return 'waiting';
        },
      };
      return retryJob;
    });
    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });

    const [left, right] = await Promise.all([
      service.retry(previous.id),
      service.retry(previous.id),
    ]);

    expect(right.id).toBe(left.id);
    expect(left).toMatchObject({ attempt: 2, retryOf: previous.id });
    expect(createdJobs).toBe(1);
    await service.close();
  });
});

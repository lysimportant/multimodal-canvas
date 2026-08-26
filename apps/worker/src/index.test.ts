import { describe, expect, it, vi } from 'vitest';

const bullmqState = vi.hoisted(() => ({
  job: undefined as
    | {
        id: string;
        data: Record<string, unknown>;
        updateData(data: Record<string, unknown>): Promise<void>;
        updateProgress(progress: unknown): Promise<void>;
      }
    | undefined,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(..._args: unknown[]) {}
  }

  class Worker {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      bullmqState.processor = processor;
    }
  }

  class Job {
    static async fromId() {
      return bullmqState.job;
    }
  }

  return { Job, Queue, Worker };
});

import {
  attachProviderErrorMetadata,
  createProviderJobRecord,
  createRunWorker,
  normalizeProviderExecution,
  resolveDatabaseRunId,
  sanitizeProviderJobPayload,
} from './index';
import { serializeWorkerError } from './logger';

const result = {
  provider: 'mock',
  summary: 'done',
  targetNodeId: 'node_text',
  mediaType: 'text' as const,
  inputCount: 0,
};

describe('worker provider job boundary', () => {
  it('redacts credential-like values from error diagnostics', () => {
    expect(
      serializeWorkerError(
        new Error('upstream rejected Authorization: Bearer secret-token apiKey=secret-key'),
      ),
    ).toMatchObject({
      errorName: 'Error',
      errorMessage: expect.not.stringContaining('secret-token'),
    });
    expect(serializeWorkerError(new Error('apiKey=secret-key')).errorMessage).not.toContain(
      'secret-key',
    );
  });

  it('creates a stable local provider job record', () => {
    expect(
      createProviderJobRecord('run_1', 'newapi', 'running', 45, '2026-08-25T00:00:00.000Z'),
    ).toEqual({
      id: 'provider_job_run_1',
      provider: 'newapi',
      status: 'running',
      progress: 45,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
  });

  it('keeps a submitted platform job identity on provider failure', () => {
    const providerJob = createProviderJobRecord(
      'run_video',
      'newapi',
      'running',
      85,
      '2026-08-25T00:00:00.000Z',
    );
    const error = Object.assign(new Error('polling failed'), {
      platformJobId: 'platform-video-1',
      providerPayload: { status: 'processing', progress: 60 },
    });

    expect(attachProviderErrorMetadata(providerJob, error)).toEqual({
      ...providerJob,
      platformJobId: 'platform-video-1',
      payload: { statusResponse: { status: 'processing', progress: 60 } },
    });
  });

  it('stores only a safe provider summary and drops signed output URLs', () => {
    expect(
      sanitizeProviderJobPayload({
        contract: 'newapi-video-v1',
        phase: 'completed',
        statusResponse: {
          status: 'done',
          progress: 100,
          video_url: 'https://signed.example/video.mp4?signature=secret',
          response: { raw: 'must not persist' },
        },
        result: {
          provider: 'newapi',
          summary: 'done',
          targetNodeId: 'node_video',
          mediaType: 'video',
          inputCount: 0,
          asset: {
            assetId: 'asset-1',
            contentUrl: 'https://signed.example/video.mp4?signature=secret',
            mimeType: 'video/mp4',
          },
        },
        usage: {
          prompt_tokens: 10,
          total_tokens: 20,
          signed_url: 'https://signed.example/usage.json',
        },
      }),
    ).toEqual({
      contract: 'newapi-video-v1',
      phase: 'completed',
      statusResponse: { status: 'done', progress: 100 },
      result: {
        provider: 'newapi',
        summary: 'done',
        targetNodeId: 'node_video',
        mediaType: 'video',
        inputCount: 0,
        asset: { assetId: 'asset-1', mimeType: 'video/mp4' },
      },
      usage: { prompt_tokens: 10, total_tokens: 20 },
    });
  });

  it('normalizes legacy providers and provider execution envelopes', () => {
    expect(normalizeProviderExecution(result)).toEqual({ result });
    expect(
      normalizeProviderExecution({
        result,
        output: {
          mediaType: 'text',
          kind: 'text',
          text: 'generated text',
          mimeType: 'text/plain',
          format: 'txt',
        },
        providerJob: { provider: 'newapi', platformJobId: 'platform-1' },
        usage: { amount: '1.25', currency: 'usd', metadata: { requestId: 'req-1' } },
      }),
    ).toMatchObject({
      result,
      output: {
        mediaType: 'text',
        kind: 'text',
        text: 'generated text',
        mimeType: 'text/plain',
        format: 'txt',
      },
      providerJob: { platformJobId: 'platform-1' },
      usage: { amount: '1.25', metadata: { requestId: 'req-1' } },
    });
  });

  it('accepts provider usage without a reported price', () => {
    expect(
      normalizeProviderExecution({
        result,
        usage: { metadata: { prompt_tokens: 12, total_tokens: 12 } },
      }),
    ).toEqual({
      result,
      usage: { metadata: { prompt_tokens: 12, total_tokens: 12 } },
    });
  });

  it('only enables database persistence for a resolved PostgreSQL UUID', async () => {
    const snapshot = {} as never;
    const databaseRunId = '123e4567-e89b-12d3-a456-426614174000';

    await expect(resolveDatabaseRunId(undefined, databaseRunId, snapshot)).resolves.toBe(
      databaseRunId,
    );
    await expect(resolveDatabaseRunId(undefined, 'run_123', snapshot)).resolves.toBeUndefined();
    await expect(
      resolveDatabaseRunId(async () => databaseRunId, 'run_123', snapshot),
    ).resolves.toBe(databaseRunId);
    await expect(
      resolveDatabaseRunId(async () => 'run_123', 'run_123', snapshot),
    ).resolves.toBeUndefined();
  });

  it('routes video runs to the async provider and preserves its job identity', async () => {
    const databaseRunId = '123e4567-e89b-12d3-a456-426614174000';
    const progressUpdates: Array<{ progress: number }> = [];
    const providerJobs: Array<Record<string, unknown>> = [];
    const providerRequests: Array<Record<string, unknown>> = [];
    const usage: Array<Record<string, unknown>> = [];
    const archiveCalls: Array<Record<string, unknown>> = [];
    const standardExecute = vi.fn();
    const videoExecute = vi.fn(async (request) => {
      providerRequests.push(request as unknown as Record<string, unknown>);
      await request.onProviderJob?.({
        provider: 'newapi',
        platformJobId: 'platform-video-1',
        status: 'submitted',
        progress: 5,
        payload: { contract: 'newapi-video-v1', phase: 'submitted' },
      });
      const { reportProgress } = request;
      await reportProgress?.(5);
      await reportProgress?.(55);
      await reportProgress?.(100);
      return {
        result: {
          provider: 'newapi',
          summary: 'video generated',
          targetNodeId: 'node_video',
          mediaType: 'video' as const,
          inputCount: 0,
        },
        output: {
          mediaType: 'video' as const,
          kind: 'url' as const,
          url: 'https://cdn.example/video.mp4',
          mimeType: 'video/mp4',
          format: 'mp4',
        },
        providerJob: {
          provider: 'newapi',
          platformJobId: 'platform-video-1',
          status: 'succeeded' as const,
          progress: 100,
          payload: {
            contract: 'newapi-video-v1',
            phase: 'completed',
            providerStatus: 'done',
          },
        },
        usage: { amount: '2.5', currency: 'USD' },
      };
    });
    const videoSnapshot = {
      projectId: databaseRunId,
      canvasRevision: 1,
      targetNodeId: 'node_video',
      modelAlias: 'video-model',
      parameters: {},
      submittedAt: '2026-08-26T00:00:00.000Z',
      nodes: [
        {
          id: 'node_video',
          type: 'video' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Video', mediaType: 'video' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [],
    };
    const job: NonNullable<typeof bullmqState.job> = {
      id: databaseRunId,
      data: {
        runId: databaseRunId,
        snapshot: videoSnapshot,
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(
          databaseRunId,
          'newapi',
          'queued',
          0,
          '2026-08-26T00:00:00.000Z',
        ),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress(progress) {
        if (progress && typeof progress === 'object' && 'progress' in progress) {
          progressUpdates.push(progress as { progress: number });
        }
      },
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: standardExecute },
      videoProvider: { execute: videoExecute },
      stepDelayMs: 0,
      persistence: {
        async upsertProviderJob(input) {
          providerJobs.push(input.providerJob);
        },
        async recordUsage(input) {
          usage.push(input);
        },
      },
      resultArchiver: async (input) => {
        archiveCalls.push(input as unknown as Record<string, unknown>);
        return { assetId: 'asset-video', version: 1, mimeType: 'video/mp4' };
      },
    });

    const processed = await bullmqState.processor?.(job);

    expect(standardExecute).not.toHaveBeenCalled();
    expect(videoExecute).toHaveBeenCalledOnce();
    expect(providerRequests[0]).toMatchObject({
      providerJob: {
        id: `provider_job_${databaseRunId}`,
        provider: 'newapi',
      },
    });
    expect(progressUpdates.map((entry) => entry.progress)).toEqual(
      expect.arrayContaining([10, 45, 80, 81, 90, 99]),
    );
    expect(archiveCalls[0]).toMatchObject({
      providerJob: { platformJobId: 'platform-video-1' },
      output: { mediaType: 'video', kind: 'url' },
      archiveInput: {
        mediaType: 'video',
        contentUrl: 'https://cdn.example/video.mp4',
      },
    });
    expect(providerJobs.at(-1)).toMatchObject({
      platformJobId: 'platform-video-1',
      status: 'succeeded',
      progress: 100,
    });
    expect(job.data.providerJob).toMatchObject({
      platformJobId: 'platform-video-1',
      payload: { contract: 'newapi-video-v1', phase: 'completed' },
    });
    expect(usage).toEqual([
      {
        runId: databaseRunId,
        providerJobId: 'platform-video-1',
        kind: 'generation',
        amount: '2.5',
        currency: 'USD',
      },
    ]);
    expect(processed).toMatchObject({
      status: 'succeeded',
      providerJob: { platformJobId: 'platform-video-1' },
      result: { asset: { assetId: 'asset-video' } },
    });
  });

  it('recovers a predecessor platform task for retries before provider execution', async () => {
    const runId = '123e4567-e89b-12d3-a456-426614174010';
    const predecessorRunId = '123e4567-e89b-12d3-a456-426614174011';
    const retrySnapshot = {
      projectId: runId,
      canvasRevision: 2,
      targetNodeId: 'node_video_retry',
      modelAlias: 'video-model',
      parameters: {},
      submittedAt: '2026-08-26T00:00:00.000Z',
      nodes: [
        {
          id: 'node_video_retry',
          type: 'video' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Retry video', mediaType: 'video' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [],
    };
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        retryOf: predecessorRunId,
        snapshot: retrySnapshot,
        attempt: 2,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi', 'queued', 0),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;
    const recovered = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'failed', 86),
      platformJobId: 'platform-video-retry',
      payload: { contract: 'newapi-video-v1', phase: 'polling' },
    };
    const providerRequests: Array<Record<string, unknown>> = [];
    const findProviderJobByRunId = vi.fn(async (sourceRunId: string) => {
      expect(sourceRunId).toBe(predecessorRunId);
      return recovered;
    });
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      videoProvider: {
        async execute(request) {
          providerRequests.push(request as unknown as Record<string, unknown>);
          return {
            result: {
              provider: 'newapi',
              summary: 'resumed',
              targetNodeId: 'node_video_retry',
              mediaType: 'video' as const,
              inputCount: 0,
            },
          };
        },
      },
      stepDelayMs: 0,
      persistence: {
        findProviderJobByRunId,
        async upsertProviderJob() {},
        async recordUsage() {},
      },
    });

    await bullmqState.processor?.(job);

    expect(findProviderJobByRunId).toHaveBeenCalledWith(predecessorRunId);
    expect(providerRequests[0]).toMatchObject({
      providerJob: { platformJobId: 'platform-video-retry' },
    });
    expect(job.data.providerJob).toMatchObject({ platformJobId: 'platform-video-retry' });
  });
});

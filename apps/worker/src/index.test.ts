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
import { workflowSnapshotFingerprint, workflowSnapshotFingerprintV1 } from './workflow-dag';

const result = {
  provider: 'mock',
  summary: 'done',
  targetNodeId: 'node_text',
  mediaType: 'text' as const,
  inputCount: 0,
};

function createBoundarySnapshot(targetNodeId = 'node_boundary') {
  return {
    projectId: 'project_provider_job_boundary',
    canvasRevision: 1,
    targetNodeId,
    modelAlias: 'text-model',
    parameters: {},
    submittedAt: '2026-08-28T00:00:00.000Z',
    nodes: [
      {
        id: targetNodeId,
        type: 'text' as const,
        position: { x: 0, y: 0 },
        data: {
          label: 'Boundary text',
          mediaType: 'text' as const,
          mode: 'generate' as const,
        },
      },
    ],
    edges: [],
    inputs: [],
  };
}

function createBoundaryJob(
  runId: string,
  snapshot: ReturnType<typeof createBoundarySnapshot>,
  provider: 'mock' | 'newapi',
  providerJob: ReturnType<typeof createProviderJobRecord>,
) {
  const job: NonNullable<typeof bullmqState.job> = {
    id: runId,
    data: {
      runId,
      snapshot,
      attempt: 1,
      provider,
      providerJob,
      cancelRequested: false,
    },
    async updateData(data) {
      this.data = data;
    },
    async updateProgress() {},
  };
  return job;
}

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

  it('does not require credentials for a mock run with an empty credential map', async () => {
    const providerRequests: Array<Record<string, unknown>> = [];
    const runId = 'run_mock_empty_credentials';
    const snapshot = {
      projectId: 'project_mock',
      canvasRevision: 1,
      targetNodeId: 'node_mock_empty_credentials',
      modelAlias: 'mock-text',
      nodeCredentialReferences: {},
      parameters: {},
      submittedAt: '2026-08-27T00:00:00.000Z',
      nodes: [
        {
          id: 'node_mock_empty_credentials',
          type: 'text' as const,
          position: { x: 0, y: 0 },
          data: {
            label: 'Mock text',
            mediaType: 'text' as const,
            mode: 'generate' as const,
          },
        },
      ],
      edges: [],
      inputs: [],
    };
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        snapshot,
        attempt: 1,
        provider: 'mock',
        providerJob: createProviderJobRecord(runId, 'mock', 'queued', 0),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'mock',
      provider: {
        async execute(request) {
          providerRequests.push(request as unknown as Record<string, unknown>);
          return {
            result: { ...result, targetNodeId: snapshot.targetNodeId },
            output: {
              mediaType: 'text' as const,
              kind: 'text' as const,
              text: 'mock output',
              mimeType: 'text/plain',
            },
          };
        },
      },
      stepDelayMs: 0,
      persistence: {
        async upsertProviderJob() {},
        async recordUsage() {},
      },
      resultArchiver: async () => ({
        assetId: 'asset_mock_empty_credentials',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await expect(bullmqState.processor?.(job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(providerRequests[0]?.snapshot).not.toHaveProperty('nodeCredentialReferences');
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
      credentialId: '123e4567-e89b-12d3-a456-426614174020',
      credentialVersion: 1,
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
        async getProviderCredentials() {
          return { baseUrl: 'https://newapi.example/v1', apiKey: 'synthetic-test-key' };
        },
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

  it('aborts built-in video polling on worker cancellation without inventing a cancel request', async () => {
    const runId = '123e4567-e89b-12d3-a456-426614174020';
    const credentialId = '123e4567-e89b-12d3-a456-426614174021';
    let pollSignal: AbortSignal | undefined;
    let markPollStarted: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/video/generations')) {
        return new Response(
          JSON.stringify({ task_id: 'platform-video-cancel', status: 'queued' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (requestUrl.endsWith('/video/generations/platform-video-cancel')) {
        pollSignal = init?.signal ?? undefined;
        markPollStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          pollSignal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected New API request: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('NEW_API_VIDEO_POLL_INTERVAL_MS', '0');
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        snapshot: {
          projectId: runId,
          canvasRevision: 1,
          targetNodeId: 'node_video_cancel',
          modelAlias: 'video-model',
          credentialId,
          credentialVersion: 1,
          parameters: {},
          submittedAt: '2026-08-26T00:00:00.000Z',
          nodes: [
            {
              id: 'node_video_cancel',
              type: 'video' as const,
              position: { x: 0, y: 0 },
              data: {
                label: 'Cancelable video',
                mediaType: 'video' as const,
                mode: 'generate' as const,
                prompt: 'A gentle camera move through the scene',
              },
            },
          ],
          edges: [],
          inputs: [],
        },
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi'),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;
    const resultArchiver = vi.fn();

    try {
      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        providerName: 'newapi',
        stepDelayMs: 0,
        cancellationPollMs: 1,
        persistence: {
          async getProviderCredentials() {
            return { baseUrl: 'https://newapi.example/v1', apiKey: 'test-key' };
          },
          async upsertProviderJob() {},
          async recordUsage() {},
        },
        resultArchiver,
      });

      const processing = bullmqState.processor?.(job);
      await Promise.race([
        pollStarted,
        Promise.resolve(processing).then(() => {
          throw new Error('video processing ended before the cancellation boundary');
        }),
      ]);
      job.data.cancelRequested = true;

      await expect(processing).resolves.toMatchObject({ status: 'cancelled' });
      expect(pollSignal?.aborted).toBe(true);
      expect(resultArchiver).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/content'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('recovers a predecessor platform task for retries before provider execution', async () => {
    const runId = '123e4567-e89b-12d3-a456-426614174010';
    const predecessorRunId = '123e4567-e89b-12d3-a456-426614174011';
    const retrySnapshot = {
      projectId: runId,
      canvasRevision: 2,
      targetNodeId: 'node_video_retry',
      modelAlias: 'video-model',
      credentialId: '123e4567-e89b-12d3-a456-426614174021',
      credentialVersion: 1,
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
      payload: {
        contract: 'newapi-video-v1',
        phase: 'polling',
        snapshotFingerprint: workflowSnapshotFingerprintV1(retrySnapshot),
      },
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
            output: {
              mediaType: 'video' as const,
              kind: 'url' as const,
              url: 'https://assets.example/resumed.mp4',
              mimeType: 'video/mp4',
            },
          };
        },
      },
      stepDelayMs: 0,
      persistence: {
        findProviderJobByRunId,
        async getProviderCredentials() {
          return { baseUrl: 'https://newapi.example/v1', apiKey: 'synthetic-test-key' };
        },
        async upsertProviderJob() {},
        async recordUsage() {},
      },
      resultArchiver: async () => ({
        assetId: 'asset-video-retry',
        version: 1,
        mimeType: 'video/mp4',
      }),
    });

    await bullmqState.processor?.(job);

    expect(findProviderJobByRunId).toHaveBeenCalledWith(predecessorRunId);
    expect(providerRequests[0]).toMatchObject({
      providerJob: { platformJobId: 'platform-video-retry' },
    });
    expect(job.data.providerJob).toMatchObject({ platformJobId: 'platform-video-retry' });
  });

  it.each(['missing', 'current', 'legacy'] as const)(
    'reuses an initial platform task with a $fingerprintState snapshot fingerprint state on a fresh run',
    async (fingerprintState) => {
      const runId = `run_initial_${fingerprintState}_fingerprint`;
      const snapshot = createBoundarySnapshot();
      const providerJob = {
        ...createProviderJobRecord(runId, 'mock', 'running', 40),
        platformJobId: `platform-${fingerprintState}`,
        ...(fingerprintState === 'missing'
          ? {}
          : {
              payload: {
                snapshotFingerprint:
                  fingerprintState === 'current'
                    ? workflowSnapshotFingerprint(snapshot)
                    : workflowSnapshotFingerprintV1(snapshot),
              },
            }),
      };
      const providerRequests: Array<Record<string, unknown>> = [];
      const job = createBoundaryJob(runId, snapshot, 'mock', providerJob);
      bullmqState.job = job;

      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        providerName: 'mock',
        provider: {
          async execute(request) {
            providerRequests.push(request as unknown as Record<string, unknown>);
            return {
              result: { ...result, targetNodeId: snapshot.targetNodeId },
              output: {
                mediaType: 'text' as const,
                kind: 'text' as const,
                text: 'boundary output',
                mimeType: 'text/plain',
              },
            };
          },
        },
        stepDelayMs: 0,
        resultArchiver: async () => ({
          assetId: `asset-${fingerprintState}`,
          version: 1,
          mimeType: 'text/plain',
        }),
      });

      await expect(bullmqState.processor?.(job)).resolves.toMatchObject({ status: 'succeeded' });
      expect(providerRequests[0]?.providerJob).toMatchObject({
        platformJobId: `platform-${fingerprintState}`,
      });
    },
  );

  it.each([
    {
      name: 'a different provider',
      providerJob: (runId: string) => ({
        ...createProviderJobRecord(runId, 'newapi', 'running', 40),
        platformJobId: 'platform-wrong-provider',
      }),
    },
    {
      name: 'a different snapshot fingerprint',
      providerJob: (runId: string) => ({
        ...createProviderJobRecord(runId, 'mock', 'running', 40),
        platformJobId: 'platform-wrong-snapshot',
        payload: { snapshotFingerprint: 'f'.repeat(64) },
      }),
    },
    {
      name: 'a malformed snapshot fingerprint',
      providerJob: (runId: string) => ({
        ...createProviderJobRecord(runId, 'mock', 'running', 40),
        platformJobId: 'platform-malformed-fingerprint',
        payload: { snapshotFingerprint: 'not-a-sha256' },
      }),
    },
  ])(
    'does not reuse an initial platform task with $name',
    async ({ name, providerJob: createJob }) => {
      const runId = `run_reject_initial_${name.replaceAll(' ', '_')}`;
      const snapshot = createBoundarySnapshot();
      const providerRequests: Array<Record<string, unknown>> = [];
      const job = createBoundaryJob(runId, snapshot, 'mock', createJob(runId));
      bullmqState.job = job;

      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        providerName: 'mock',
        provider: {
          async execute(request) {
            providerRequests.push(request as unknown as Record<string, unknown>);
            return {
              result: { ...result, targetNodeId: snapshot.targetNodeId },
              output: {
                mediaType: 'text' as const,
                kind: 'text' as const,
                text: 'boundary output',
                mimeType: 'text/plain',
              },
            };
          },
        },
        stepDelayMs: 0,
        resultArchiver: async () => ({
          assetId: 'asset-rejected-initial',
          version: 1,
          mimeType: 'text/plain',
        }),
      });

      await expect(bullmqState.processor?.(job)).resolves.toMatchObject({ status: 'succeeded' });
      expect(providerRequests[0]?.providerJob).not.toHaveProperty('platformJobId');
      expect(job.data.providerJob).not.toHaveProperty('platformJobId');
    },
  );

  it('persists a failed run when its immutable credential snapshot is unavailable', async () => {
    const runId = '123e4567-e89b-12d3-a456-426614174013';
    const credentialId = '123e4567-e89b-12d3-a456-426614174014';
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        snapshot: {
          projectId: runId,
          canvasRevision: 1,
          targetNodeId: 'node_text_credentials',
          modelAlias: 'text-model',
          credentialId,
          credentialVersion: 4,
          parameters: {},
          submittedAt: '2026-08-26T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text_credentials',
              type: 'text' as const,
              position: { x: 0, y: 0 },
              data: {
                label: 'Text',
                mediaType: 'text' as const,
                mode: 'generate' as const,
              },
            },
          ],
          edges: [],
          inputs: [],
        },
        attempt: 1,
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
    const provider = { execute: vi.fn(async () => ({ result })) };
    const getProviderCredentials = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials,
        async upsertProviderJob() {},
        async recordUsage() {},
        updateRun,
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('credential snapshot');
    expect(getProviderCredentials).toHaveBeenCalledWith({
      credentialId,
      credentialVersion: 4,
    });
    expect(job.data.providerJob).toMatchObject({ status: 'failed' });
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('unavailable') }),
    );
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing credential snapshot resolver',
      snapshot: {},
      expectedError: 'persistent New API worker requires a credential snapshot resolver',
    },
    {
      name: 'missing credential ID',
      snapshot: { credentialVersion: 1 },
      expectedError: 'run snapshot is missing an immutable New API credential reference',
    },
    {
      name: 'missing credential version',
      snapshot: { credentialId: '123e4567-e89b-12d3-a456-426614174022' },
      expectedError: 'run snapshot is missing an immutable New API credential reference',
    },
  ])(
    'fails closed for $name before an injected provider or environment fallback',
    async ({ snapshot: credentialSnapshot, expectedError }) => {
      const runId = '123e4567-e89b-42d3-a456-426614174023';
      const provider = { execute: vi.fn(async () => ({ result })) };
      const getProviderCredentials = vi.fn(async () => ({
        baseUrl: 'https://newapi.example/v1',
        apiKey: 'synthetic-test-key',
      }));
      const job: NonNullable<typeof bullmqState.job> = {
        id: runId,
        data: {
          runId,
          snapshot: {
            projectId: 'project_credential_boundary',
            canvasRevision: 1,
            targetNodeId: 'node_credential_boundary',
            modelAlias: 'text-model',
            ...credentialSnapshot,
            parameters: {},
            submittedAt: '2026-08-27T00:00:00.000Z',
            nodes: [
              {
                id: 'node_credential_boundary',
                type: 'text' as const,
                position: { x: 0, y: 0 },
                data: {
                  label: 'Credential boundary',
                  mediaType: 'text' as const,
                  mode: 'generate' as const,
                },
              },
            ],
            edges: [],
            inputs: [],
          },
          attempt: 1,
          provider: 'newapi',
          providerJob: createProviderJobRecord(runId, 'newapi'),
          cancelRequested: false,
        },
        async updateData(data) {
          this.data = data;
        },
        async updateProgress() {},
      };
      bullmqState.job = job;

      createRunWorker({
        connection: { host: '127.0.0.1', port: 6379 },
        providerName: 'newapi',
        provider,
        stepDelayMs: 0,
        persistence: {
          ...(expectedError.includes('resolver') ? {} : { getProviderCredentials }),
          async upsertProviderJob() {},
          async recordUsage() {},
        },
      });

      await expect(bullmqState.processor?.(job)).rejects.toThrow(expectedError);
      expect(provider.execute).not.toHaveBeenCalled();
      if (expectedError.includes('resolver')) {
        expect(getProviderCredentials).not.toHaveBeenCalled();
      } else {
        expect(getProviderCredentials).not.toHaveBeenCalled();
      }
    },
  );

  it('fails closed before provider execution when the initial run snapshot cannot be persisted', async () => {
    const runId = '123e4567-e89b-42d3-a456-426614174015';
    const provider = { execute: vi.fn(async () => ({ result })) };
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        snapshot: {
          projectId: runId,
          canvasRevision: 1,
          targetNodeId: 'node_initial_persistence',
          modelAlias: 'text-model',
          parameters: {},
          submittedAt: '2026-08-26T00:00:00.000Z',
          nodes: [
            {
              id: 'node_initial_persistence',
              type: 'text' as const,
              position: { x: 0, y: 0 },
              data: {
                label: 'Text',
                mediaType: 'text' as const,
                mode: 'generate' as const,
              },
            },
          ],
          edges: [],
          inputs: [],
        },
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi'),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;
    const ensureRun = vi.fn(async () => {
      throw new Error('initial run snapshot unavailable');
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      persistence: {
        ensureRun,
        async upsertProviderJob() {},
        async recordUsage() {},
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('initial run snapshot unavailable');
    expect(ensureRun).toHaveBeenCalledOnce();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('fails closed when durable run ID resolution fails before provider execution', async () => {
    const runId = 'run_initial_resolver_failure';
    const provider = { execute: vi.fn(async () => ({ result })) };
    const persistenceError = new Error('run ID resolver unavailable');
    const onPersistenceError = vi.fn();
    const ensureRun = vi.fn(async () => undefined);
    const job: NonNullable<typeof bullmqState.job> = {
      id: runId,
      data: {
        runId,
        snapshot: {
          projectId: 'project_initial_resolver_failure',
          canvasRevision: 1,
          targetNodeId: 'node_initial_resolver_failure',
          modelAlias: 'text-model',
          parameters: {},
          submittedAt: '2026-08-26T00:00:00.000Z',
          nodes: [
            {
              id: 'node_initial_resolver_failure',
              type: 'text' as const,
              position: { x: 0, y: 0 },
              data: {
                label: 'Text',
                mediaType: 'text' as const,
                mode: 'generate' as const,
              },
            },
          ],
          edges: [],
          inputs: [],
        },
        attempt: 1,
        provider: 'newapi',
        providerJob: createProviderJobRecord(runId, 'newapi'),
        cancelRequested: false,
      },
      async updateData(data) {
        this.data = data;
      },
      async updateProgress() {},
    };
    bullmqState.job = job;

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      resolveDatabaseRunId: async () => {
        throw persistenceError;
      },
      onPersistenceError,
      stepDelayMs: 0,
      persistence: {
        ensureRun,
        async upsertProviderJob() {},
        async recordUsage() {},
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow(
      'durable run persistence requires a resolvable database run id',
    );
    expect(onPersistenceError).toHaveBeenCalledWith(persistenceError);
    expect(ensureRun).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });
});

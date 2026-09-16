import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { nodeTimingDuration } from '@multimodal-canvas/domain';

import {
  databaseRunId,
  isPrismaUuid,
  PrismaRunPersistence,
  RunPersistenceError,
  stableProviderJobId,
  stableUsageLedgerId,
  stableUsageLedgerIdempotencyKey,
} from './run-persistence';

const runId = '123e4567-e89b-12d3-a456-426614174000';
const providerJob = {
  id: 'provider_job_run_123',
  provider: 'newapi',
  status: 'running' as const,
  progress: 45,
  platformJobId: 'platform-123',
  payload: { attempt: 1 },
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:01:00.000Z',
};

function createPersistence() {
  const findRun = vi.fn<(args: unknown) => Promise<unknown>>(async () => undefined);
  const findProviderJob = vi.fn<(args: unknown) => Promise<unknown>>(async () => undefined);
  const prisma = {
    run: {
      upsert: vi.fn(async (args) => args.create),
      update: vi.fn(async (args) => args.data),
      findUnique: findRun,
      findMany: vi.fn(async () => [] as unknown[]),
    },
    providerJob: {
      upsert: vi.fn(async (args) => args.create),
      findUnique: findProviderJob,
    },
    usageLedger: {
      create: vi.fn(async (args) => ({ id: 'usage-1', ...args.data })),
      upsert: vi.fn(async (args) => ({ id: args.create.id, ...args.create })),
    },
  };
  return { prisma, persistence: new PrismaRunPersistence(prisma as never) };
}

describe('PrismaRunPersistence', () => {
  it('restores a run by durable provider job identity', async () => {
    const { prisma, persistence } = createPersistence();
    const projectId = '123e4567-e89b-12d3-a456-426614174010';
    const snapshot = {
      projectId,
      canvasRevision: 1,
      targetNodeId: 'node_video',
      modelAlias: 'video-model',
      parameters: {},
      submittedAt: '2026-08-25T00:00:00.000Z',
      nodes: [
        {
          id: 'node_video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: { label: 'Video', mediaType: 'video', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    };
    prisma.providerJob.findUnique.mockResolvedValue({
      id: stableProviderJobId('newapi', 'platform-lookup'),
      provider: 'newapi',
      platformJobId: 'platform-lookup',
      status: 'running',
      progress: 45,
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      updatedAt: new Date('2026-08-25T00:01:00.000Z'),
      run: {
        id: databaseRunId('run-lookup'),
        projectId,
        status: 'RUNNING',
        modelAlias: 'video-model',
        snapshot,
        attempt: 1,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T00:01:00.000Z'),
        providerJobs: [
          {
            id: stableProviderJobId('newapi', 'platform-lookup'),
            provider: 'newapi',
            platformJobId: 'platform-lookup',
            status: 'running',
            progress: 45,
            createdAt: new Date('2026-08-25T00:00:00.000Z'),
            updatedAt: new Date('2026-08-25T00:01:00.000Z'),
          },
          {
            id: stableProviderJobId('newapi', 'platform-newer'),
            provider: 'newapi',
            platformJobId: 'platform-newer',
            status: 'succeeded',
            progress: 100,
            createdAt: new Date('2026-08-25T00:00:00.000Z'),
            updatedAt: new Date('2026-08-25T00:02:00.000Z'),
          },
        ],
      },
    });

    await expect(
      persistence.getRunByProviderJob('newapi', 'platform-lookup'),
    ).resolves.toMatchObject({
      projectId,
      targetNodeId: 'node_video',
      status: 'running',
      providerJob: { platformJobId: 'platform-lookup', progress: 45 },
    });
    expect(prisma.providerJob.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_platformJobId: { provider: 'newapi', platformJobId: 'platform-lookup' },
        },
      }),
    );
  });

  it('restores a completed run and its real result after the queue job expires', async () => {
    const { prisma, persistence } = createPersistence();
    const externalRunId = 'run_expired_1';
    const projectId = '123e4567-e89b-12d3-a456-426614174010';
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const updatedAt = new Date('2026-08-25T00:02:00.000Z');
    prisma.run.findUnique.mockResolvedValue({
      id: databaseRunId(externalRunId),
      projectId,
      userId: null,
      status: 'SUCCEEDED',
      modelAlias: 'mock-text',
      snapshot: {
        projectId,
        canvasRevision: 7,
        targetNodeId: 'node_text',
        modelAlias: 'mock-text',
        parameters: {},
        submittedAt: createdAt.toISOString(),
        nodes: [
          {
            id: 'node_text',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: '文案', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
      result: {
        provider: 'mock',
        summary: '真实生成文本',
        targetNodeId: 'node_text',
        mediaType: 'text',
        inputCount: 0,
        asset: {
          assetId: '123e4567-e89b-12d3-a456-426614174012',
          version: 1,
          contentUrl: '/v1/assets/result/content',
          mimeType: 'text/plain; charset=utf-8',
          sizeBytes: 18,
        },
      },
      attempt: 1,
      retryOf: null,
      idempotencyKey: 'request-1',
      error: null,
      createdAt,
      updatedAt,
      providerJobs: [],
    });

    await expect(persistence.getRun(externalRunId)).resolves.toMatchObject({
      id: externalRunId,
      projectId,
      targetNodeId: 'node_text',
      status: 'succeeded',
      progress: 100,
      result: { summary: '真实生成文本', asset: { version: 1 } },
    });
    expect(prisma.run.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: databaseRunId(externalRunId) } }),
    );
  });

  it('rejects BullMQ/API run IDs instead of writing an invalid UUID foreign key', async () => {
    const { prisma, persistence } = createPersistence();

    await expect(
      persistence.upsertProviderJob({ runId: 'run_123', providerJob }),
    ).rejects.toMatchObject({ code: 'invalid_uuid' });
    expect(prisma.providerJob.upsert).not.toHaveBeenCalled();
  });

  it('creates a stable Run snapshot and ordered RunInput rows before queue publication', async () => {
    const { prisma, persistence } = createPersistence();
    const projectId = '123e4567-e89b-12d3-a456-426614174010';
    const snapshot = {
      projectId,
      canvasRevision: 7,
      targetNodeId: 'node_target',
      modelAlias: 'mock-image',
      credentialId: '123e4567-e89b-12d3-a456-426614174011',
      credentialVersion: 2,
      parameters: { strength: 0.8 },
      submittedAt: '2026-08-25T00:00:00.000Z',
      nodes: [
        {
          id: 'node_target',
          type: 'image' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Target', mediaType: 'image' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [
        {
          nodeId: 'node_ref',
          role: 'style' as const,
          sortOrder: 3,
          sourceAssetId: '123e4567-e89b-12d3-a456-426614174012',
          snapshot: {
            id: 'node_ref',
            type: 'image' as const,
            position: { x: 0, y: 0 },
            data: { label: 'Ref', mediaType: 'image' as const, mode: 'source' as const },
          },
        },
      ],
    };

    await persistence.ensureRun({
      runId: 'run_queue_1',
      snapshot,
      status: 'queued',
      attempt: 1,
      provider: 'mock',
    });

    expect(prisma.run.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: databaseRunId('run_queue_1') },
        create: expect.objectContaining({
          id: databaseRunId('run_queue_1'),
          projectId,
          status: 'QUEUED',
          modelAlias: 'mock-image',
          inputs: {
            create: [expect.objectContaining({ nodeId: 'node_ref', role: 'style', sortOrder: 3 })],
          },
        }),
      }),
    );
  });

  it('updates only lifecycle fields and leaves the immutable snapshot untouched', async () => {
    const { prisma, persistence } = createPersistence();
    await persistence.updateRun({
      runId,
      status: 'succeeded',
      result: {
        provider: 'mock',
        summary: 'done',
        targetNodeId: 'node_text',
        mediaType: 'text',
        inputCount: 0,
      },
    });
    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: runId },
      data: {
        status: 'SUCCEEDED',
        result: {
          provider: 'mock',
          summary: 'done',
          targetNodeId: 'node_text',
          mediaType: 'text',
          inputCount: 0,
        },
      },
    });
  });

  it('updates the stable local provider job when a callback adds its platform ID', async () => {
    const { prisma, persistence } = createPersistence();
    const queuedProviderJob = {
      id: 'provider_job_run_123',
      provider: 'newapi',
      status: 'queued' as const,
      progress: 0,
      payload: { attempt: 1 },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    const saved = await persistence.upsertProviderJob({ runId, providerJob: queuedProviderJob });
    const updated = await persistence.upsertProviderJob({
      runId,
      providerJob,
    });

    const stableId = stableProviderJobId('newapi', providerJob.id);
    expect(saved.id).toBe(stableId);
    expect(saved.runId).toBe(runId);
    expect(updated.id).toBe(stableId);
    expect(prisma.providerJob.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.providerJob.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: stableId },
      }),
    );
    expect(prisma.providerJob.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: stableId },
        update: expect.objectContaining({ platformJobId: 'platform-123' }),
      }),
    );
    expect(prisma.providerJob.upsert.mock.calls[0]?.[0]?.create).not.toHaveProperty(
      'platformJobId',
    );
  });

  it('reassociates a reused platform task with a retry run after the local-ID insert conflicts', async () => {
    const { prisma, persistence } = createPersistence();
    const retryRunId = '123e4567-e89b-12d3-a456-426614174020';
    const uniqueError = Object.assign(new Error('unique'), { code: 'P2002' });
    prisma.providerJob.upsert.mockRejectedValueOnce(uniqueError).mockResolvedValueOnce({
      id: stableProviderJobId('newapi', 'provider_job_original'),
      runId: retryRunId,
    });

    await persistence.upsertProviderJob({
      runId: retryRunId,
      providerJob: {
        ...providerJob,
        id: 'provider_job_retry_1',
        status: 'running',
        progress: 60,
        updatedAt: '2026-08-25T00:02:00.000Z',
      },
    });

    expect(prisma.providerJob.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: stableProviderJobId('newapi', 'provider_job_retry_1') },
      }),
    );
    expect(prisma.providerJob.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          provider_platformJobId: { provider: 'newapi', platformJobId: 'platform-123' },
        },
        update: expect.objectContaining({ runId: retryRunId, progress: 60 }),
      }),
    );
    expect(prisma.providerJob.upsert).toHaveBeenCalledTimes(2);
  });

  it('records normalized usage with optional run and user UUIDs', async () => {
    const { prisma, persistence } = createPersistence();

    await persistence.recordUsage({
      runId,
      userId: '123e4567-e89b-12d3-a456-426614174001',
      amount: '1.250000',
      currency: 'usd',
      metadata: { provider: 'newapi' },
    });

    expect(prisma.usageLedger.create).toHaveBeenCalledWith({
      data: {
        runId,
        userId: '123e4567-e89b-12d3-a456-426614174001',
        amount: '1.250000',
        currency: 'USD',
        metadata: { provider: 'newapi' },
      },
    });
  });

  it('links usage to the run owner when the provider omits userId', async () => {
    const { prisma, persistence } = createPersistence();
    prisma.run.findUnique.mockResolvedValue({
      userId: '123e4567-e89b-12d3-a456-426614174001',
    });

    await persistence.recordUsage({ runId, amount: '0.500000' });

    expect(prisma.usageLedger.create).toHaveBeenCalledWith({
      data: {
        runId,
        userId: '123e4567-e89b-12d3-a456-426614174001',
        amount: '0.500000',
        currency: 'USD',
      },
    });
  });

  it('upserts identified usage using provider job identity and kind', async () => {
    const { prisma, persistence } = createPersistence();
    const key = stableUsageLedgerIdempotencyKey({
      providerJobId: ' platform-job-1 ',
      eventId: 'event-ignored-for-provider-job',
      kind: 'Generation',
    });

    await persistence.recordUsage({
      runId,
      amount: '0.125000',
      currency: 'usd',
      providerJobId: ' platform-job-1 ',
      eventId: 'event-ignored-for-provider-job',
      kind: 'Generation',
      metadata: { providerJobId: 'metadata-value-ignored', requestId: 'req-1' },
    });

    expect(key).toBeDefined();
    expect(prisma.usageLedger.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: key },
      create: {
        id: stableUsageLedgerId(key!),
        runId,
        providerJobId: 'platform-job-1',
        eventId: 'event-ignored-for-provider-job',
        kind: 'generation',
        idempotencyKey: key,
        amount: '0.125000',
        currency: 'USD',
        metadata: { providerJobId: 'metadata-value-ignored', requestId: 'req-1' },
      },
      update: {},
    });
    expect(prisma.usageLedger.create).not.toHaveBeenCalled();
  });

  it('extracts an event identity from metadata when explicit fields are omitted', async () => {
    const { prisma, persistence } = createPersistence();
    const key = stableUsageLedgerIdempotencyKey({ eventId: 'evt-42', kind: 'completion' });

    await persistence.recordUsage({
      amount: 2,
      metadata: { eventId: ' evt-42 ', kind: 'Completion', prompt_tokens: 12 },
    });

    expect(prisma.usageLedger.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: key },
      create: expect.objectContaining({
        id: stableUsageLedgerId(key!),
        eventId: 'evt-42',
        kind: 'completion',
        idempotencyKey: key,
        amount: '2',
        currency: 'USD',
      }),
      update: {},
    });
    expect(prisma.usageLedger.create).not.toHaveBeenCalled();
  });

  it('keeps unidentified usage append-only for legacy callers', async () => {
    const { prisma, persistence } = createPersistence();

    await persistence.recordUsage({ amount: '0.500000', metadata: { prompt_tokens: 4 } });

    expect(prisma.usageLedger.create).toHaveBeenCalledTimes(1);
    expect(prisma.usageLedger.upsert).not.toHaveBeenCalled();
  });

  it('uses distinct keys for provider job, event, and kind combinations', () => {
    expect(
      stableUsageLedgerIdempotencyKey({ providerJobId: 'job-1', kind: 'generation' }),
    ).not.toBe(stableUsageLedgerIdempotencyKey({ providerJobId: 'job-1', kind: 'completion' }));
    expect(
      stableUsageLedgerIdempotencyKey({ providerJobId: 'job-1', kind: 'generation' }),
    ).not.toBe(stableUsageLedgerIdempotencyKey({ eventId: 'job-1', kind: 'generation' }));
    expect(stableUsageLedgerIdempotencyKey({})).toBeUndefined();
  });

  it('rejects malformed amounts before touching Prisma', async () => {
    const { prisma, persistence } = createPersistence();

    await expect(persistence.recordUsage({ amount: '1.1234567' })).rejects.toMatchObject({
      code: 'invalid_amount',
    });
    expect(prisma.usageLedger.create).not.toHaveBeenCalled();
  });

  it('sanitizes provider diagnostics and run errors before durable writes', async () => {
    const { prisma, persistence } = createPersistence();
    const projectId = '123e4567-e89b-12d3-a456-426614174010';
    const snapshot = {
      projectId,
      canvasRevision: 1,
      targetNodeId: 'node_text',
      modelAlias: 'text-model',
      parameters: {},
      submittedAt: '2026-08-25T00:00:00.000Z',
      nodes: [
        {
          id: 'node_text',
          type: 'text' as const,
          position: { x: 0, y: 0 },
          data: { label: 'Text', mediaType: 'text' as const, mode: 'generate' as const },
        },
      ],
      edges: [],
      inputs: [],
    };

    await persistence.ensureRun({
      runId: 'run_sensitive_write',
      snapshot,
      error:
        'Authorization: Bearer write-secret https://newapi.example.com/debug?token=query-secret#trace',
    });
    const ensureCall = prisma.run.upsert.mock.calls[0]?.[0];
    expect(ensureCall.create.error).toEqual({
      message: 'Authorization: [REDACTED] https://newapi.example.com/debug',
    });
    expect(JSON.stringify(ensureCall.create.error)).not.toContain('write-secret');
    expect(JSON.stringify(ensureCall.create.error)).not.toContain('query-secret');

    await persistence.upsertProviderJob({
      runId,
      providerJob: {
        ...providerJob,
        payload: {
          providerStatus: 'processing',
          authorization: 'Bearer provider-secret',
          signedUrl: 'https://cdn.example.com/output.mp4?signature=secret',
          nested: { token: 'nested-secret', safe: 'kept' },
          items: [{ safe: true }, { password: 'item-secret' }],
        },
      },
    });
    const providerCall = prisma.providerJob.upsert.mock.calls[0]?.[0];
    expect(providerCall.create.payload).toEqual({
      providerStatus: 'processing',
      nested: { safe: 'kept' },
      items: [{ safe: true }],
    });
    expect(JSON.stringify(providerCall.create.payload)).not.toContain('provider-secret');
    expect(JSON.stringify(providerCall.create.payload)).not.toContain('signature=secret');
  });

  it('sanitizes nested provider jobs on run updates while preserving asset URLs', async () => {
    const { prisma, persistence } = createPersistence();
    await persistence.updateRun({
      runId,
      status: 'failed',
      error: 'token=update-secret https://newapi.example.com/error?key=query-secret',
      result: {
        provider: 'newapi',
        summary: 'failed',
        targetNodeId: 'node_video',
        mediaType: 'video',
        inputCount: 1,
        asset: {
          assetId: 'asset-1',
          contentUrl: 'https://cdn.example.com/video.mp4?signature=asset-secret',
        },
        providerJob: {
          id: 'provider-job-1',
          provider: 'newapi',
          status: 'failed',
          progress: 100,
          payload: {
            phase: 'failed',
            authorization: 'Bearer result-secret',
            statusUrl: 'https://newapi.example.com/status?token=result-query',
          },
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:01:00.000Z',
        },
      },
    });

    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: runId },
      data: expect.objectContaining({
        status: 'FAILED',
        error: { message: 'token=[REDACTED] https://newapi.example.com/error' },
        result: expect.objectContaining({
          asset: {
            assetId: 'asset-1',
            contentUrl: 'https://cdn.example.com/video.mp4?signature=asset-secret',
          },
          providerJob: {
            id: 'provider-job-1',
            provider: 'newapi',
            status: 'failed',
            progress: 100,
            payload: { phase: 'failed' },
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:01:00.000Z',
          },
        }),
      }),
    });
  });

  it('re-sanitizes legacy provider diagnostics while restoring a durable run', async () => {
    const { prisma, persistence } = createPersistence();
    const projectId = '123e4567-e89b-12d3-a456-426614174010';
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const updatedAt = new Date('2026-08-25T00:01:00.000Z');
    const durableProviderJob = {
      id: stableProviderJobId('newapi', 'legacy-platform-1'),
      provider: 'newapi',
      platformJobId: 'legacy-platform-1',
      status: 'succeeded',
      progress: 100,
      payload: {
        phase: 'completed',
        authorization: 'Bearer legacy-secret',
        outputUrl: 'https://cdn.example.com/video.mp4?signature=legacy-secret',
      },
      createdAt,
      updatedAt,
    };
    const snapshot = {
      projectId,
      canvasRevision: 1,
      targetNodeId: 'node_video',
      modelAlias: 'video-model',
      parameters: {},
      submittedAt: createdAt.toISOString(),
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
    prisma.run.findUnique.mockResolvedValue({
      id: databaseRunId('legacy_run'),
      projectId,
      status: 'SUCCEEDED',
      modelAlias: 'video-model',
      snapshot,
      result: {
        provider: 'newapi',
        summary: 'done',
        targetNodeId: 'node_video',
        mediaType: 'video',
        inputCount: 0,
        asset: {
          assetId: 'asset-legacy',
          contentUrl: 'https://cdn.example.com/video.mp4?signature=asset-secret',
        },
        providerJob: {
          ...durableProviderJob,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      },
      attempt: 1,
      createdAt,
      updatedAt,
      providerJobs: [durableProviderJob],
    });

    const restored = await persistence.getRun('legacy_run');
    expect(restored).toMatchObject({
      status: 'succeeded',
      providerJob: { payload: { phase: 'completed' } },
      result: {
        asset: {
          contentUrl: 'https://cdn.example.com/video.mp4?signature=asset-secret',
        },
        providerJob: { payload: { phase: 'completed' } },
      },
    });
    expect(JSON.stringify(restored)).not.toContain('legacy-secret');
  });

  it('recognizes only PostgreSQL UUID-shaped identifiers', () => {
    expect(isPrismaUuid(runId)).toBe(true);
    expect(isPrismaUuid('run_idem_abc123')).toBe(false);
  });
});

const runSnapshot = {
  projectId: '123e4567-e89b-12d3-a456-426614174010',
  canvasRevision: 3,
  targetNodeId: 'node_image',
  modelAlias: 'grok-image-1',
  parameters: {},
  submittedAt: '2026-09-17T10:00:00.000Z',
  nodes: [
    {
      id: 'node_image',
      type: 'image' as const,
      position: { x: 0, y: 0 },
      data: { label: 'Image', mediaType: 'image' as const, mode: 'generate' as const },
    },
  ],
  edges: [],
  inputs: [],
};

/** 请求提示词记录的持久化行形状，与 Worker 写入的列一致。 */
function requestPromptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '223e4567-e89b-42d3-a456-426614174050',
    runId: databaseRunId('run_prompt_1'),
    requestRunId: 'run_prompt_1',
    nodeId: 'node_image',
    attempt: 1,
    requestIdentity: 'POST /images/generations#1',
    schemaVersion: 1,
    provider: 'newapi',
    modelAlias: 'grok-image-1',
    credentialId: null,
    credentialVersion: null,
    mediaType: 'IMAGE',
    format: 'plain',
    parts: [{ order: 0, text: '月白布衫，青裙' }],
    negativeText: null,
    resources: [
      {
        assetId: 'asset_source',
        assetVersion: 2,
        role: 'imageEdit',
        sortOrder: 0,
        mediaType: 'image',
      },
    ],
    sendStatus: 'sent',
    assetId: 'asset_result',
    assetVersion: 3,
    summary: '整体为素雅的古风配色。',
    summarySource: 'manual',
    createdAt: new Date('2026-09-17T10:00:00.000Z'),
    updatedAt: new Date('2026-09-17T10:00:04.000Z'),
    ...overrides,
  };
}

function createRequestPromptPersistence(rows: unknown[]) {
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({
        id: databaseRunId('run_prompt_1'),
        projectId: runSnapshot.projectId,
        userId: null,
        status: 'SUCCEEDED',
        modelAlias: 'grok-image-1',
        snapshot: runSnapshot,
        result: null,
        attempt: 1,
        retryOf: null,
        idempotencyKey: null,
        error: null,
        nodeTimings: {
          node_image: {
            nodeId: 'node_image',
            queuedAt: '2026-09-17T10:00:00.100Z',
            startedAt: '2026-09-17T10:00:00.500Z',
            finishedAt: '2026-09-17T10:00:03.500Z',
            outcome: 'succeeded',
          },
          node_ghost: { nodeId: 'node_other', startedAt: 'not-a-time' },
        },
        createdAt: new Date('2026-09-17T10:00:00.000Z'),
        updatedAt: new Date('2026-09-17T10:00:05.000Z'),
        providerJobs: [],
      })),
      findMany: vi.fn(async () => rows),
      upsert: vi.fn(async (args) => args.create),
      update: vi.fn(async (args) => args.data),
    },
    providerJob: { upsert: vi.fn(), findUnique: vi.fn() },
    usageLedger: { create: vi.fn(), upsert: vi.fn() },
    runRequestPrompt: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(
        async (args: { where: { id: string; runId: string } }) =>
          rows.find(
            (row) =>
              (row as { id: string }).id === args.where.id &&
              (row as { runId: string }).runId === args.where.runId,
          ) ?? null,
      ),
    },
  };
  return { prisma, persistence: new PrismaRunPersistence(prisma as never) };
}

describe('PrismaRunPersistence 请求提示词与节点时间读取', () => {
  it('占位行不泄露正文，摘要只携带 ID 与计数', async () => {
    const { persistence } = createRequestPromptPersistence([requestPromptRow()]);

    const summaries = await persistence.listRequestPromptRecords('run_prompt_1');

    expect(summaries).toEqual([
      {
        id: '223e4567-e89b-42d3-a456-426614174050',
        runId: 'run_prompt_1',
        nodeId: 'node_image',
        attempt: 1,
        requestIdentity: 'POST /images/generations#1',
        provider: 'newapi',
        modelAlias: 'grok-image-1',
        mediaType: 'image',
        format: 'plain',
        sendStatus: 'sent',
        partCount: 1,
        resourceCount: 1,
        createdAt: '2026-09-17T10:00:00.000Z',
        assetId: 'asset_result',
        assetVersion: 3,
        summary: '整体为素雅的古风配色。',
        summarySource: 'manual',
      },
    ]);
    // 列表只带摘要与计数，真实请求文本绝不出现。
    expect(JSON.stringify(summaries)).not.toContain('月白布衫，青裙');
    expect(JSON.stringify(summaries)).not.toContain('parts');
  });

  it('按记录 ID 读取完整请求文本，并限定在该次运行内', async () => {
    const { persistence } = createRequestPromptPersistence([requestPromptRow()]);

    await expect(
      persistence.getRequestPromptRecord('run_prompt_1', '223e4567-e89b-42d3-a456-426614174050'),
    ).resolves.toMatchObject({
      runId: 'run_prompt_1',
      nodeId: 'node_image',
      format: 'plain',
      parts: [{ order: 0, text: '月白布衫，青裙' }],
      resources: [{ assetId: 'asset_source', assetVersion: 2, sortOrder: 0 }],
      sendStatus: 'sent',
      assetId: 'asset_result',
      assetVersion: 3,
    });
    // 同一次运行之外的读取与非法 ID 都不会返回记录。
    await expect(
      persistence.getRequestPromptRecord('run_other', '223e4567-e89b-42d3-a456-426614174050'),
    ).resolves.toBeUndefined();
    await expect(
      persistence.getRequestPromptRecord('run_prompt_1', 'not-a-uuid'),
    ).resolves.toBeUndefined();
  });

  it('返回节点时间并丢弃损坏条目，不会因此丢掉整条运行记录', async () => {
    const { persistence } = createRequestPromptPersistence([]);

    const restored = await persistence.getRun('run_prompt_1');

    expect(restored?.nodeTimings).toEqual({
      node_image: {
        nodeId: 'node_image',
        queuedAt: '2026-09-17T10:00:00.100Z',
        startedAt: '2026-09-17T10:00:00.500Z',
        finishedAt: '2026-09-17T10:00:03.500Z',
        outcome: 'succeeded',
      },
    });
    expect(restored?.status).toBe('succeeded');
  });

  it('结构损坏的请求记录行被跳过，不产生半截摘要', async () => {
    const { persistence } = createRequestPromptPersistence([
      requestPromptRow({ parts: 'not-an-array' }),
      requestPromptRow({ id: '323e4567-e89b-42d3-a456-426614174051', nodeId: 'node_video' }),
    ]);

    const summaries = await persistence.listRequestPromptRecords('run_prompt_1');

    expect(summaries.map((summary) => summary.nodeId)).toEqual(['node_video']);
  });
});

/**
 * 接受显式确认隔离的 TEST_DATABASE_URL，兼容原有本机 scratch 库；不使用生产连接。
 */
const scratchDatabasePattern =
  /^postgres(?:ql)?:\/\/scratch:scratch@(?:127\.0\.0\.1|localhost):55432\/scratch(?:\?|$)/;
const isolatedDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (isolatedDatabaseUrl && process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true') {
  throw new Error('TEST_DATABASE_URL requires TEST_DATABASE_CONFIRMED_ISOLATED=true');
}
const scratchDatabaseUrl =
  isolatedDatabaseUrl ??
  (scratchDatabasePattern.test(process.env.DATABASE_URL ?? '')
    ? process.env.DATABASE_URL
    : undefined);
const scratchDescribe = scratchDatabaseUrl ? describe : describe.skip;

scratchDescribe('PrismaRunPersistence against the scratch database', () => {
  const prisma = new PrismaClient(
    scratchDatabaseUrl ? { datasources: { db: { url: scratchDatabaseUrl } } } : undefined,
  );
  const persistence = new PrismaRunPersistence(prisma);
  const projectId = randomUUID();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const recordId = randomUUID();
  const otherRecordId = randomUUID();

  beforeAll(async () => {
    await prisma.project.create({ data: { id: projectId, name: 'run prompt persistence' } });
    for (const id of [runId, otherRunId]) {
      await prisma.run.create({
        data: {
          id,
          projectId,
          status: 'SUCCEEDED',
          modelAlias: 'grok-image-1',
          attempt: 1,
          snapshot: { ...runSnapshot, projectId, targetNodeId: 'node_image' },
          parameters: {},
        },
      });
    }
    await prisma.run.update({
      where: { id: runId },
      data: {
        nodeTimings: {
          node_image: {
            nodeId: 'node_image',
            queuedAt: '2026-09-17T10:00:00.100Z',
            startedAt: '2026-09-17T10:00:00.500Z',
            requestStartedAt: '2026-09-17T10:00:00.600Z',
            requestFinishedAt: '2026-09-17T10:00:03.000Z',
            finishedAt: '2026-09-17T10:00:03.500Z',
            outcome: 'succeeded',
          },
        },
      },
    });
    await prisma.runRequestPrompt.create({
      data: {
        id: recordId,
        runId,
        requestRunId: runId,
        nodeId: 'node_image',
        attempt: 1,
        requestIdentity: 'POST /images/generations#1',
        schemaVersion: 1,
        provider: 'newapi',
        modelAlias: 'grok-image-1',
        mediaType: 'IMAGE',
        format: 'plain',
        parts: [{ order: 0, text: '月白布衫，青裙' }],
        resources: [],
        sendStatus: 'sent',
        assetId: 'asset_result',
        assetVersion: 3,
        createdAt: new Date('2026-09-17T10:00:00.000Z'),
      },
    });
    await prisma.runRequestPrompt.create({
      data: {
        id: otherRecordId,
        runId: otherRunId,
        requestRunId: otherRunId,
        nodeId: 'node_image',
        attempt: 1,
        requestIdentity: 'POST /images/generations#1',
        schemaVersion: 1,
        provider: 'newapi',
        modelAlias: 'grok-image-1',
        mediaType: 'IMAGE',
        format: 'plain',
        parts: [{ order: 0, text: '另一个运行的提示词' }],
        resources: [],
        sendStatus: 'pending',
        createdAt: new Date('2026-09-17T10:01:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.$disconnect();
  });

  it('迁移后的表可读写，列表不带正文、完整文本按需读取', async () => {
    const summaries = await persistence.listRequestPromptRecords(runId);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: recordId,
      runId,
      nodeId: 'node_image',
      sendStatus: 'sent',
      partCount: 1,
      assetId: 'asset_result',
      assetVersion: 3,
    });
    expect(JSON.stringify(summaries)).not.toContain('月白布衫');
    // 其它运行的记录不会出现在本次运行的列表中。
    expect(summaries.map((summary) => summary.id)).not.toContain(otherRecordId);

    await expect(persistence.getRequestPromptRecord(runId, recordId)).resolves.toMatchObject({
      runId,
      parts: [{ order: 0, text: '月白布衫，青裙' }],
    });
    await expect(persistence.getRequestPromptRecord(runId, otherRecordId)).resolves.toBeUndefined();
  });

  it('从数据库读回节点时间并保持 nodeTimingDuration 的口径', async () => {
    const restored = await persistence.getRun(runId);

    const timing = restored?.nodeTimings?.node_image;
    expect(timing).toMatchObject({ outcome: 'succeeded' });
    expect(nodeTimingDuration(timing!, Date.parse('2026-09-17T10:05:00.000Z'))).toEqual({
      availability: 'recorded',
      milliseconds: 3_000,
    });
  });
});

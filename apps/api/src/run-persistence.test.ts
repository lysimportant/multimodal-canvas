import { describe, expect, it, vi } from 'vitest';

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
  const findRun = vi.fn<(args: unknown) => Promise<{ userId: string | null } | undefined>>(
    async () => undefined,
  );
  const prisma = {
    run: {
      upsert: vi.fn(async (args) => args.create),
      update: vi.fn(async (args) => args.data),
      findUnique: findRun,
    },
    providerJob: { upsert: vi.fn(async (args) => args.create) },
    usageLedger: {
      create: vi.fn(async (args) => ({ id: 'usage-1', ...args.data })),
      upsert: vi.fn(async (args) => ({ id: args.create.id, ...args.create })),
    },
  };
  return { prisma, persistence: new PrismaRunPersistence(prisma as never) };
}

describe('PrismaRunPersistence', () => {
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

  it('maps a provider job to a stable UUID and upserts its lifecycle fields', async () => {
    const { prisma, persistence } = createPersistence();

    const saved = await persistence.upsertProviderJob({ runId, providerJob });
    const second = await persistence.upsertProviderJob({
      runId,
      providerJob: { ...providerJob, status: 'succeeded', progress: 100 },
    });

    expect(saved.id).toBe(stableProviderJobId('newapi', providerJob.id));
    expect(saved.runId).toBe(runId);
    expect(second.id).toBe(saved.id);
    expect(prisma.providerJob.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.providerJob.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          provider_platformJobId: { provider: 'newapi', platformJobId: 'platform-123' },
        },
      }),
    );
  });

  it('reassociates a reused platform task with a retry run instead of creating a duplicate', async () => {
    const { prisma, persistence } = createPersistence();
    const retryRunId = '123e4567-e89b-12d3-a456-426614174020';

    await persistence.upsertProviderJob({ runId, providerJob });
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
      2,
      expect.objectContaining({
        where: {
          provider_platformJobId: { provider: 'newapi', platformJobId: 'platform-123' },
        },
        update: expect.objectContaining({ runId: retryRunId, progress: 60 }),
      }),
    );
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

  it('recognizes only PostgreSQL UUID-shaped identifiers', () => {
    expect(isPrismaUuid(runId)).toBe(true);
    expect(isPrismaUuid('run_idem_abc123')).toBe(false);
  });
});

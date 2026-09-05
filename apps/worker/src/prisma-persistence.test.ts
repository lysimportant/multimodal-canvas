import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  databaseRunId,
  stableUsageLedgerId,
  stableUsageLedgerIdempotencyKey,
  WorkerPrismaRunPersistence,
} from './prisma-persistence';

const runId = 'run_worker_usage_1';
const databaseId = databaseRunId(runId);
const userId = '123e4567-e89b-12d3-a456-426614174001';

afterEach(() => vi.unstubAllEnvs());

function createPersistence() {
  const prisma = {
    $disconnect: vi.fn(async () => undefined),
    run: {
      findUnique: vi.fn(async () => ({ userId })),
    },
    usageLedger: {
      create: vi.fn(async (args) => ({ id: 'usage-legacy', ...args.data })),
      upsert: vi.fn(async (args) => ({ ...args.create })),
    },
  };

  return {
    prisma,
    persistence: new WorkerPrismaRunPersistence(prisma as never),
  };
}

describe('WorkerPrismaRunPersistence usage idempotency', () => {
  it('upserts provider-job usage using the API-compatible stable key', async () => {
    const { prisma, persistence } = createPersistence();
    const idempotencyKey = '363c44bf65719b8a23f8316e489eec80a637dbc4014c4cc194dc19a3f72c2cd9';

    expect(
      stableUsageLedgerIdempotencyKey({
        providerJobId: ' job-1 ',
        eventId: 'event-is-secondary',
        kind: 'Generation',
      }),
    ).toBe(idempotencyKey);
    expect(stableUsageLedgerId(idempotencyKey)).toBe('67ff9807-c1fb-4627-a177-eb9ea70f21e4');

    await persistence.recordUsage({
      runId,
      providerJobId: ' job-1 ',
      eventId: 'event-is-secondary',
      kind: 'Generation',
      amount: '0.125000',
      currency: 'usd',
      metadata: { requestId: 'request-1' },
    });

    expect(prisma.usageLedger.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey },
      create: {
        id: '67ff9807-c1fb-4627-a177-eb9ea70f21e4',
        runId: databaseId,
        userId,
        providerJobId: 'job-1',
        eventId: 'event-is-secondary',
        kind: 'generation',
        idempotencyKey,
        amount: '0.125000',
        currency: 'USD',
        metadata: { requestId: 'request-1' },
      },
      update: {},
    });
    expect(prisma.usageLedger.create).not.toHaveBeenCalled();
  });

  it('falls back to event identity extracted from metadata', async () => {
    const { prisma, persistence } = createPersistence();
    const idempotencyKey = 'd566736acb54c907b328d8b0f836add5c705507b92251da7e0eef83781d121a0';

    await persistence.recordUsage({
      amount: 2,
      metadata: { eventId: ' evt-42 ', kind: 'Completion', prompt_tokens: 12 },
    });

    expect(prisma.usageLedger.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey },
      create: expect.objectContaining({
        eventId: 'evt-42',
        kind: 'completion',
        idempotencyKey,
        amount: '2',
        currency: 'USD',
      }),
      update: {},
    });
    expect(prisma.run.findUnique).not.toHaveBeenCalled();
    expect(prisma.usageLedger.create).not.toHaveBeenCalled();
  });

  it('keeps usage without a provider or event identity append-only', async () => {
    const { prisma, persistence } = createPersistence();

    await persistence.recordUsage({
      runId,
      amount: '0.500000',
      metadata: { prompt_tokens: 4 },
    });

    expect(prisma.usageLedger.create).toHaveBeenCalledWith({
      data: {
        runId: databaseId,
        userId,
        amount: '0.500000',
        currency: 'USD',
        metadata: { prompt_tokens: 4 },
      },
    });
    expect(prisma.usageLedger.upsert).not.toHaveBeenCalled();
  });

  it('keeps kind-specific usage events distinct and prefers provider-job identity', () => {
    expect(stableUsageLedgerIdempotencyKey({})).toBeUndefined();
    expect(stableUsageLedgerIdempotencyKey({ eventId: 'event-1', kind: 'start' })).not.toBe(
      stableUsageLedgerIdempotencyKey({ eventId: 'event-1', kind: 'complete' }),
    );
    expect(
      stableUsageLedgerIdempotencyKey({
        providerJobId: 'job-1',
        eventId: 'event-1',
        kind: 'complete',
      }),
    ).toBe(stableUsageLedgerIdempotencyKey({ providerJobId: 'job-1', kind: 'complete' }));
  });
});

describe('WorkerPrismaRunPersistence retry recovery', () => {
  it('updates the stable local provider job when a callback adds its platform ID', async () => {
    const upsert = vi.fn(async (args) => args);
    const prisma = { providerJob: { upsert } };
    const persistence = new WorkerPrismaRunPersistence(prisma as never);
    const queuedProviderJob = {
      id: 'provider_job_retry',
      provider: 'newapi',
      status: 'queued' as const,
      progress: 0,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };

    await persistence.upsertProviderJob({ runId, providerJob: queuedProviderJob });
    await persistence.upsertProviderJob({
      runId,
      providerJob: {
        ...queuedProviderJob,
        platformJobId: 'platform-video-42',
        status: 'running',
        progress: 60,
        updatedAt: '2026-08-26T00:01:00.000Z',
      },
    });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: expect.any(String) } }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: expect.any(String) },
        update: expect.objectContaining({ runId: databaseId, platformJobId: 'platform-video-42' }),
      }),
    );
    expect(upsert.mock.calls[1]?.[0]?.where).toEqual(upsert.mock.calls[0]?.[0]?.where);
    expect(upsert.mock.calls[0]?.[0]?.create).not.toHaveProperty('platformJobId');
  });

  it('reassociates a reused platform task with a retry run after the local-ID insert conflicts', async () => {
    const uniqueError = Object.assign(new Error('unique'), { code: 'P2002' });
    const upsert = vi.fn().mockRejectedValueOnce(uniqueError).mockResolvedValueOnce({});
    const persistence = new WorkerPrismaRunPersistence({ providerJob: { upsert } } as never);
    const retryRunId = 'run_worker_usage_retry';

    await persistence.upsertProviderJob({
      runId: retryRunId,
      providerJob: {
        id: 'provider_job_retry_new',
        provider: 'newapi',
        platformJobId: 'platform-video-42',
        status: 'running',
        progress: 60,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:01:00.000Z',
      },
    });

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: expect.any(String) } }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          provider_platformJobId: {
            provider: 'newapi',
            platformJobId: 'platform-video-42',
          },
        },
        update: expect.objectContaining({ runId: databaseRunId(retryRunId), progress: 60 }),
      }),
    );
  });

  it('returns the latest durable platform task for a predecessor run', async () => {
    const createdAt = new Date('2026-08-26T00:00:00.000Z');
    const updatedAt = new Date('2026-08-26T00:01:00.000Z');
    const prisma = {
      providerJob: {
        findFirst: vi.fn(async () => ({
          id: 'db-provider-job',
          runId: databaseId,
          provider: 'newapi',
          platformJobId: 'platform-video-42',
          status: 'FAILED',
          progress: 87,
          payload: { contract: 'newapi-video-v1', phase: 'polling' },
          createdAt,
          updatedAt,
        })),
      },
    };
    const persistence = new WorkerPrismaRunPersistence(prisma as never);

    await expect(persistence.findProviderJobByRunId(runId)).resolves.toMatchObject({
      provider: 'newapi',
      platformJobId: 'platform-video-42',
      status: 'failed',
      progress: 87,
      payload: { contract: 'newapi-video-v1', phase: 'polling' },
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(prisma.providerJob.findFirst).toHaveBeenCalledWith({
      where: { runId: databaseId, platformJobId: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('returns synchronous completed jobs and asynchronous tasks for workflow recovery', async () => {
    const createdAt = new Date('2026-08-27T00:00:00.000Z');
    const updatedAt = new Date('2026-08-27T00:01:00.000Z');
    const findMany = vi.fn(async () => [
      {
        provider: 'newapi',
        platformJobId: null,
        status: 'SUCCEEDED',
        progress: 100,
        payload: {
          workflowNodeId: 'node_text',
          result: {
            provider: 'newapi',
            model: 'text-model',
            mediaType: 'text',
            targetNodeId: 'node_text',
            asset: { assetId: 'asset_text', mimeType: 'text/plain' },
          },
        },
        createdAt,
        updatedAt,
      },
      {
        provider: 'newapi',
        platformJobId: 'platform-image-1',
        status: 'RUNNING',
        progress: 42,
        payload: { workflowNodeId: 'node_image', phase: 'polling' },
        createdAt,
        updatedAt,
      },
      {
        provider: 'newapi',
        platformJobId: 'platform-video-1',
        status: 'SUBMITTED',
        progress: 5,
        payload: { workflowNodeId: 'node_video', phase: 'submitted' },
        createdAt,
        updatedAt,
      },
    ]);
    const persistence = new WorkerPrismaRunPersistence({ providerJob: { findMany } } as never);

    const recoveredJobs = await persistence.findProviderJobsByRunId(runId);

    expect(recoveredJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'succeeded',
          payload: expect.objectContaining({
            workflowNodeId: 'node_text',
            result: expect.objectContaining({
              targetNodeId: 'node_text',
              asset: { assetId: 'asset_text', mimeType: 'text/plain' },
            }),
          }),
        }),
        expect.objectContaining({
          platformJobId: 'platform-image-1',
          payload: { workflowNodeId: 'node_image', phase: 'polling' },
        }),
        expect.objectContaining({
          platformJobId: 'platform-video-1',
          payload: { workflowNodeId: 'node_video', phase: 'submitted' },
        }),
      ]),
    );
    expect(
      recoveredJobs.find((job) => job.payload?.workflowNodeId === 'node_text'),
    ).not.toHaveProperty('platformJobId');
    expect(findMany).toHaveBeenCalledWith({
      where: { runId: databaseId },
      orderBy: { updatedAt: 'desc' },
    });
  });

  it('keeps singular retry recovery restricted to asynchronous platform tasks', async () => {
    const findFirst = vi.fn(async () => null);
    const persistence = new WorkerPrismaRunPersistence({ providerJob: { findFirst } } as never);

    await expect(persistence.findProviderJobByRunId(runId)).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { runId: databaseId, platformJobId: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });
  });
});

describe('WorkerPrismaRunPersistence run result persistence', () => {
  it('writes a versioned asset on success and a diagnostic error on failure', async () => {
    const update = vi.fn(async (args) => args);
    const persistence = new WorkerPrismaRunPersistence({ run: { update } } as never);
    const result = {
      provider: 'newapi',
      summary: 'synthetic text result',
      targetNodeId: 'node_text',
      mediaType: 'text' as const,
      inputCount: 1,
      asset: {
        assetId: 'asset_text_persisted',
        version: 3,
        mimeType: 'text/plain',
      },
    };

    await persistence.updateRun({
      runId,
      status: 'succeeded',
      result,
    });
    await persistence.updateRun({
      runId,
      status: 'failed',
      error: 'synthetic provider failure',
    });

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: databaseId },
      data: { status: 'SUCCEEDED', result },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: databaseId },
      data: { status: 'FAILED', error: { message: 'synthetic provider failure' } },
    });
  });
});

describe('WorkerPrismaRunPersistence credential snapshots', () => {
  const encryptionSecret = 'worker-test-encryption-secret';
  const credentialId = '123e4567-e89b-12d3-a456-426614174012';

  function encrypt(value: string) {
    const key = createHash('sha256').update(encryptionSecret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  it('resolves the exact credential id/version and decrypts only at the worker boundary', async () => {
    const findFirst = vi.fn(async () => ({
      baseUrl: 'https://historical.example/v1',
      encryptedApiKey: encrypt('historical-test-key'),
    }));
    const update = vi.fn(async () => undefined);
    const prisma = { aiCredential: { findFirst, update } };
    const persistence = new WorkerPrismaRunPersistence(prisma as never, encryptionSecret);

    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 7 }),
    ).resolves.toEqual({
      baseUrl: 'https://historical.example/v1',
      apiKey: 'historical-test-key',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: credentialId, version: 7, projectId: null },
      select: { baseUrl: true, encryptedApiKey: true, encryptionKeyId: true, updatedAt: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: credentialId, version: 7 }),
      data: expect.objectContaining({ encryptionKeyId: 'default' }),
    });
  });

  it('re-encrypts a legacy snapshot with the current deployment key before returning it', async () => {
    vi.stubEnv('AI_CREDENTIAL_ENCRYPTION_KEY_ID', 'current');
    vi.stubEnv(
      'AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS',
      JSON.stringify({ retired: encryptionSecret }),
    );
    const findFirst = vi.fn(async () => ({
      baseUrl: 'https://historical.example/v1',
      encryptedApiKey: encrypt('historical-test-key'),
      encryptionKeyId: null,
    }));
    const update = vi.fn(async () => undefined);
    const persistence = new WorkerPrismaRunPersistence(
      { aiCredential: { findFirst, update } } as never,
      'current-encryption-secret',
    );

    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 7 }),
    ).resolves.toEqual({
      baseUrl: 'https://historical.example/v1',
      apiKey: 'historical-test-key',
    });
    expect(update).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: credentialId, version: 7 }),
      data: expect.objectContaining({ encryptionKeyId: 'current' }),
    });
    expect(JSON.stringify(update.mock.calls)).not.toContain('historical-test-key');
  });

  it('fails closed when legacy credential rotation cannot be persisted', async () => {
    const findFirst = vi.fn(async () => ({
      baseUrl: 'https://historical.example/v1',
      encryptedApiKey: encrypt('historical-test-key'),
    }));
    const persistence = new WorkerPrismaRunPersistence(
      { aiCredential: { findFirst } } as never,
      encryptionSecret,
    );

    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 7 }),
    ).rejects.toThrow('AI credential rotation requires a durable credential update method');
  });

  it('并发写回被拒绝时不返回凭据且不泄露底层诊断', async () => {
    const updatedAt = new Date('2026-09-01T00:00:00.000Z');
    const ciphertext = encrypt('synthetic-rotation-key');
    const findFirst = vi.fn(async () => ({
      baseUrl: 'https://historical.example/v1',
      encryptedApiKey: ciphertext,
      encryptionKeyId: null,
      updatedAt,
    }));
    const update = vi.fn().mockRejectedValue(new Error(`sensitive diagnostic ${ciphertext}`));
    const persistence = new WorkerPrismaRunPersistence(
      { aiCredential: { findFirst, update } } as never,
      encryptionSecret,
    );
    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 7 }),
    ).rejects.toThrow('AI credential rotation could not be persisted');
    expect(update).toHaveBeenCalledWith({
      where: {
        id: credentialId,
        version: 7,
        encryptedApiKey: ciphertext,
        encryptionKeyId: null,
        updatedAt,
      },
      data: { encryptedApiKey: expect.any(String), encryptionKeyId: 'default', updatedAt },
    });
  });

  it('does not query or fall back when the snapshot reference is incomplete', async () => {
    const findFirst = vi.fn();
    const persistence = new WorkerPrismaRunPersistence(
      { aiCredential: { findFirst } } as never,
      encryptionSecret,
    );

    await expect(persistence.getProviderCredentials({ credentialId })).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('fails clearly when the shared encryption secret is unavailable', async () => {
    const findFirst = vi.fn();
    const persistence = new WorkerPrismaRunPersistence(
      { aiCredential: { findFirst } } as never,
      '',
    );

    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 1 }),
    ).rejects.toThrow('AI_CREDENTIAL_ENCRYPTION_KEY');
    expect(findFirst).not.toHaveBeenCalled();
  });
});

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  databaseRunId,
  stableUsageLedgerId,
  stableUsageLedgerIdempotencyKey,
  WorkerPrismaRunPersistence,
} from './prisma-persistence';

const runId = 'run_worker_usage_1';
const databaseId = databaseRunId(runId);
const userId = '123e4567-e89b-12d3-a456-426614174001';

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
  it('reuses the compound provider identity and moves it onto the retry run', async () => {
    const upsert = vi.fn(async (args) => args);
    const prisma = { providerJob: { upsert } };
    const persistence = new WorkerPrismaRunPersistence(prisma as never);
    const providerJob = {
      id: 'provider_job_retry',
      provider: 'newapi',
      platformJobId: 'platform-video-42',
      status: 'running' as const,
      progress: 60,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
    };

    await persistence.upsertProviderJob({ runId, providerJob });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_platformJobId: {
            provider: 'newapi',
            platformJobId: 'platform-video-42',
          },
        },
        update: expect.objectContaining({ runId: databaseId }),
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
    const prisma = { aiCredential: { findFirst } };
    const persistence = new WorkerPrismaRunPersistence(prisma as never, encryptionSecret);

    await expect(
      persistence.getProviderCredentials({ credentialId, credentialVersion: 7 }),
    ).resolves.toEqual({
      baseUrl: 'https://historical.example/v1',
      apiKey: 'historical-test-key',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: credentialId, version: 7 },
      select: { baseUrl: true, encryptedApiKey: true },
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

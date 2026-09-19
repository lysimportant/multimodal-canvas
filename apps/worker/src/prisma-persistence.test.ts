import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { nodeTimingDuration, type RequestPromptRecord } from '@multimodal-canvas/domain';

import {
  databaseRunId,
  stableRequestPromptRecordId,
  stableUsageLedgerId,
  stableUsageLedgerIdempotencyKey,
  WorkerPrismaRunPersistence,
} from './prisma-persistence';

const runId = 'run_worker_usage_1';
const databaseId = databaseRunId(runId);
const userId = '123e4567-e89b-12d3-a456-426614174001';

afterEach(() => vi.unstubAllEnvs());

describe('Worker 持久取消意图', () => {
  it('outbox 取消即使 Run 被写回处理中也仍然有效', async () => {
    const run = { findUnique: vi.fn(async () => ({ status: 'PROCESSING' })) };
    const runOutbox = { findUnique: vi.fn(async () => ({ payload: { cancelRequested: true } })) };
    const persistence = new WorkerPrismaRunPersistence({ run, runOutbox } as never);
    await expect(persistence.isCancellationRequested(runId)).resolves.toBe(true);
    expect(runOutbox.findUnique).toHaveBeenCalledWith({
      where: { runId },
      select: { payload: true },
    });
    expect(run.findUnique).toHaveBeenCalledWith({
      where: { id: databaseId },
      select: { status: true },
    });
  });

  it.each(['CANCEL_REQUESTED', 'CANCELLED', 'PROCESSING'])(
    '兼容无 outbox 的历史任务状态 %s',
    async (status) => {
      const persistence = new WorkerPrismaRunPersistence({
        run: { findUnique: vi.fn(async () => ({ status })) },
        runOutbox: { findUnique: vi.fn(async () => null) },
      } as never);
      await expect(persistence.isCancellationRequested(runId)).resolves.toBe(
        status !== 'PROCESSING',
      );
    },
  );
});

describe('Worker 节点超时设置', () => {
  it('从当前设置读取超时并兼容旧格式', async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ defaultModels: { text: 'old-model' } })
      .mockResolvedValueOnce({ defaultModels: { __timeoutMs: 1_800_000 } });
    const persistence = new WorkerPrismaRunPersistence({ aiCredential: { findFirst } } as never);
    await expect(persistence.getProviderTimeoutMs()).resolves.toBeUndefined();
    await expect(persistence.getProviderTimeoutMs()).resolves.toBe(1_800_000);
    expect(findFirst).toHaveBeenLastCalledWith({
      // 独立凭据行按构造是最新行且 defaultModels 为 NULL，必须排除在平台设置之外。
      where: {
        projectId: null,
        label: { notIn: ['independent', 'independent-deleted'] },
      },
      orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
      select: { defaultModels: true },
    });
  });

  it('最新的独立凭据行不会让平台超时退回默认值', async () => {
    // 内存行集按持久化行的排序与过滤语义回答查询：先排除独立凭据，再取最新行。
    const rows = [
      {
        label: 'platform',
        version: 3,
        updatedAt: new Date('2026-09-16T10:00:00.000Z'),
        defaultModels: { __timeoutMs: 1_800_000 },
      },
      {
        label: 'independent',
        version: 9,
        updatedAt: new Date('2026-09-17T10:00:00.000Z'),
        defaultModels: null,
      },
      {
        label: 'independent-deleted',
        version: 10,
        updatedAt: new Date('2026-09-17T11:00:00.000Z'),
        defaultModels: null,
      },
    ];
    const findFirst = vi.fn(async (args: { where: { label?: { notIn?: string[] } } }) => {
      const excluded = args.where.label?.notIn ?? [];
      return (
        rows
          .filter((row) => !excluded.includes(row.label))
          .sort(
            (left, right) =>
              right.updatedAt.getTime() - left.updatedAt.getTime() || right.version - left.version,
          )[0] ?? null
      );
    });
    const persistence = new WorkerPrismaRunPersistence({ aiCredential: { findFirst } } as never);

    await expect(persistence.getProviderTimeoutMs()).resolves.toBe(1_800_000);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it.each([0, 999, 2_147_483_648, '1800000'])('拒绝非法持久化超时 %s', async (timeoutMs) => {
    const persistence = new WorkerPrismaRunPersistence({
      aiCredential: {
        findFirst: vi.fn().mockResolvedValue({ defaultModels: { __timeoutMs: timeoutMs } }),
      },
    } as never);
    await expect(persistence.getProviderTimeoutMs()).rejects.toThrow('Provider timeout');
  });
});

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

/** 请求提示词记录的可控内存存储，复现主键幂等、列默认值与状态单调写入。 */
function createRequestPromptStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    // Prisma 会为未提供的可空列写入 NULL，内存存储必须保持同样的列形状。
    const row = {
      assetId: null,
      assetVersion: null,
      summary: null,
      summarySource: null,
      ...args.data,
    };
    rows.set(String(args.data.id), row);
    return row;
  });
  const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const next = { ...rows.get(args.where.id), ...args.data };
    rows.set(args.where.id, next);
    return next;
  });
  const prisma = {
    runRequestPrompt: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => rows.get(args.where.id) ?? null),
      create,
      update,
    },
  };
  return { rows, create, update, persistence: new WorkerPrismaRunPersistence(prisma as never) };
}

function requestPromptRecord(overrides: Partial<RequestPromptRecord> = {}): RequestPromptRecord {
  return {
    schemaVersion: 1,
    runId,
    nodeId: 'node_image',
    attempt: 1,
    requestIdentity: 'POST /images/generations#1',
    provider: 'newapi',
    modelAlias: 'grok-image-1',
    credentialId: '123e4567-e89b-12d3-a456-426614174012',
    credentialVersion: 3,
    mediaType: 'image',
    format: 'plain',
    parts: [{ order: 0, text: '月白布衫，青裙' }],
    resources: [
      {
        assetId: 'asset_source',
        assetVersion: 2,
        role: 'imageEdit',
        sortOrder: 0,
        mediaType: 'image',
      },
    ],
    sendStatus: 'pending',
    createdAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('WorkerPrismaRunPersistence 请求提示词记录', () => {
  it('发送前按记录身份落库，只保存身份与文本字段', async () => {
    const { persistence, create } = createRequestPromptStore();
    const record = requestPromptRecord();

    const stored = await persistence.upsertRequestPromptRecord({ record });

    const data = create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      id: stableRequestPromptRecordId(record),
      runId: databaseId,
      requestRunId: runId,
      nodeId: 'node_image',
      attempt: 1,
      requestIdentity: 'POST /images/generations#1',
      schemaVersion: 1,
      provider: 'newapi',
      modelAlias: 'grok-image-1',
      credentialId: '123e4567-e89b-12d3-a456-426614174012',
      credentialVersion: 3,
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
      sendStatus: 'pending',
      createdAt: new Date('2026-09-17T10:00:00.000Z'),
    });
    // 结果身份只有在归档完成后才补写，发送前保持未绑定。
    expect(stored).toMatchObject({ assetId: null, assetVersion: null });
    // 原始 HTTP body、base64 与签名 URL 不会成为列值。
    expect(Object.keys(data ?? {})).not.toEqual(
      expect.arrayContaining(['body', 'requestBody', 'contentUrl', 'dataUrl']),
    );
  });

  it('同一身份键重放不新增行、不覆盖已落库状态', async () => {
    const { persistence, create, update, rows } = createRequestPromptStore();
    const record = requestPromptRecord();

    const first = await persistence.upsertRequestPromptRecord({ record });
    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'sent',
      assetId: 'asset_result',
      assetVersion: 4,
    });
    const replayed = await persistence.upsertRequestPromptRecord({
      record: { ...record, sendStatus: 'pending', parts: [{ order: 0, text: '被改写的文本' }] },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sendStatus: 'pending' }) }),
    );
    expect(replayed).toMatchObject({
      sendStatus: 'sent',
      assetId: 'asset_result',
      assetVersion: 4,
    });
    expect(first).toMatchObject({ sendStatus: 'pending' });
    expect(rows.get(stableRequestPromptRecordId(record))).toMatchObject({
      parts: [{ order: 0, text: '月白布衫，青裙' }],
      sendStatus: 'sent',
    });
  });

  it('并发创建冲突时读取既有行，不产生第二条记录', async () => {
    const existing = { id: stableRequestPromptRecordId(requestPromptRecord()), sendStatus: 'sent' };
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    const persistence = new WorkerPrismaRunPersistence({
      runRequestPrompt: { findUnique, create, update: vi.fn() },
    } as never);

    await expect(
      persistence.upsertRequestPromptRecord({ record: requestPromptRecord() }),
    ).resolves.toEqual(existing);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('第二个 attempt 与同一次执行的不同节点产生独立记录', async () => {
    const { persistence, create } = createRequestPromptStore();

    await persistence.upsertRequestPromptRecord({ record: requestPromptRecord() });
    await persistence.upsertRequestPromptRecord({ record: requestPromptRecord({ attempt: 2 }) });
    await persistence.upsertRequestPromptRecord({
      record: requestPromptRecord({ nodeId: 'node_upstream' }),
    });

    const ids = create.mock.calls.map((call) => String(call[0]?.data.id));
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      stableRequestPromptRecordId(requestPromptRecord()),
      stableRequestPromptRecordId(requestPromptRecord({ attempt: 2 })),
      stableRequestPromptRecordId(requestPromptRecord({ nodeId: 'node_upstream' })),
    ]);
  });

  it('只把 pending 推进到可观测终态，迟到的重复事件不改写终态', async () => {
    const { persistence } = createRequestPromptStore();
    const record = requestPromptRecord();
    await persistence.upsertRequestPromptRecord({ record });

    await persistence.recordRequestPromptOutcome({ identity: record, sendStatus: 'sent' });
    await persistence.recordRequestPromptOutcome({ identity: record, sendStatus: 'unknown' });

    const stored = await persistence.upsertRequestPromptRecord({ record });
    expect(stored).toMatchObject({ sendStatus: 'sent' });
  });

  it('归档后把结果身份绑定到本次执行的记录，且只绑定一次', async () => {
    const { persistence } = createRequestPromptStore();
    const record = requestPromptRecord();
    await persistence.upsertRequestPromptRecord({ record });

    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'sent',
      assetId: 'asset_result_v1',
      assetVersion: 2,
    });
    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'sent',
      assetId: 'asset_other',
      assetVersion: 9,
    });

    await expect(persistence.upsertRequestPromptRecord({ record })).resolves.toMatchObject({
      sendStatus: 'sent',
      assetId: 'asset_result_v1',
      assetVersion: 2,
    });
  });

  it('缺少结果版本时不写入孤立的结果 ID，也不伪造记录', async () => {
    const { persistence } = createRequestPromptStore();
    const record = requestPromptRecord();
    await persistence.upsertRequestPromptRecord({ record });

    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'sent',
      assetId: 'asset_without_version',
    });
    expect(await persistence.upsertRequestPromptRecord({ record })).toMatchObject({
      assetId: null,
      assetVersion: null,
      sendStatus: 'sent',
    });
    await expect(
      persistence.recordRequestPromptOutcome({
        identity: { ...record, nodeId: 'node_never_stored' },
        sendStatus: 'failed',
      }),
    ).resolves.toBeUndefined();
  });
});

/** 可控的 Run 行存储，复现 nodeTimings 单调合并的读写路径。 */
function createRunTimingStore(initialTimings?: unknown) {
  const state = { nodeTimings: initialTimings ?? null } as Record<string, unknown>;
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
    Object.assign(state, args.data);
    return state;
  });
  const findUnique = vi.fn(async () => ({ nodeTimings: state.nodeTimings }));
  const queryRaw = vi.fn(async () => []);
  const prisma = {
    run: { findUnique, update },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $queryRaw: queryRaw, run: { findUnique, update } }),
    ),
  };
  return {
    state,
    update,
    findUnique,
    prisma,
    persistence: new WorkerPrismaRunPersistence(prisma as never),
  };
}

describe('WorkerPrismaRunPersistence 节点时间单调写入', () => {
  it('写入开始时间并保持状态字段不变', async () => {
    const { persistence, update, prisma } = createRunTimingStore();

    await persistence.updateRun({
      runId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          queuedAt: '2026-09-17T10:00:00.000Z',
          startedAt: '2026-09-17T10:00:01.000Z',
        },
      },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: databaseId },
      data: {
        status: 'PROCESSING',
        nodeTimings: {
          node_image: {
            nodeId: 'node_image',
            queuedAt: '2026-09-17T10:00:00.000Z',
            startedAt: '2026-09-17T10:00:01.000Z',
          },
        },
      },
    });
  });

  it('重放不会重置开始时间，重复终态事件不会移动终态时间', async () => {
    const { persistence, state } = createRunTimingStore();

    await persistence.updateRun({
      runId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          queuedAt: '2026-09-17T10:00:00.000Z',
          startedAt: '2026-09-17T10:00:01.000Z',
        },
      },
    });
    await persistence.updateRun({
      runId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          startedAt: '2026-09-17T10:00:09.000Z',
          finishedAt: '2026-09-17T10:00:12.400Z',
          outcome: 'succeeded',
        },
      },
    });
    await persistence.updateRun({
      runId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          startedAt: '2026-09-17T10:05:00.000Z',
          finishedAt: '2026-09-17T10:05:30.000Z',
          outcome: 'cancelled',
        },
      },
    });

    expect((state.nodeTimings as Record<string, unknown>).node_image).toEqual({
      nodeId: 'node_image',
      queuedAt: '2026-09-17T10:00:00.000Z',
      startedAt: '2026-09-17T10:00:01.000Z',
      finishedAt: '2026-09-17T10:00:12.400Z',
      outcome: 'succeeded',
    });
    const timing = (state.nodeTimings as Record<string, { startedAt: string; finishedAt: string }>)
      .node_image;
    expect(nodeTimingDuration(timing as never, Date.parse('2026-09-17T10:06:00.000Z'))).toEqual({
      availability: 'recorded',
      milliseconds: 11_400,
    });
  });

  it('只保留合法条目，损坏的持久化时间不会丢弃整个时间表', async () => {
    const { persistence, state } = createRunTimingStore({
      node_broken: { nodeId: 'other_node', startedAt: 'not-a-time' },
      node_kept: {
        nodeId: 'node_kept',
        startedAt: '2026-09-17T10:00:01.000Z',
        finishedAt: '2026-09-17T10:00:02.500Z',
        outcome: 'succeeded',
      },
    });

    await persistence.updateRun({
      runId,
      status: 'processing',
      nodeTimings: {
        node_new: { nodeId: 'node_new', startedAt: '2026-09-17T10:00:03.000Z' },
      },
    });

    expect(state.nodeTimings).toEqual({
      node_kept: {
        nodeId: 'node_kept',
        startedAt: '2026-09-17T10:00:01.000Z',
        finishedAt: '2026-09-17T10:00:02.500Z',
        outcome: 'succeeded',
      },
      node_new: { nodeId: 'node_new', startedAt: '2026-09-17T10:00:03.000Z' },
    });
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

scratchDescribe('WorkerPrismaRunPersistence against the scratch database', () => {
  const prisma = new PrismaClient(
    scratchDatabaseUrl ? { datasources: { db: { url: scratchDatabaseUrl } } } : undefined,
  );
  const persistence = new WorkerPrismaRunPersistence(prisma);
  const projectId = randomUUID();
  const externalRunId = `run_${randomUUID()}`;
  const runRowId = databaseRunId(externalRunId);
  const snapshot = {
    projectId,
    canvasRevision: 1,
    targetNodeId: 'node_image',
    modelAlias: 'grok-image-1',
    parameters: {},
    submittedAt: '2026-09-17T10:00:00.000Z',
    nodes: [
      {
        id: 'node_image',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: 'Image', mediaType: 'image', mode: 'generate' },
      },
    ],
    edges: [],
    inputs: [],
  };

  beforeAll(async () => {
    await prisma.project.create({ data: { id: projectId, name: 'worker prompt persistence' } });
    await prisma.run.create({
      data: {
        id: runRowId,
        projectId,
        status: 'PROCESSING',
        modelAlias: 'grok-image-1',
        attempt: 1,
        snapshot,
        parameters: {},
      },
    });
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.$disconnect();
  });

  it('按身份键落库请求文本并在重放时保持既有状态', async () => {
    const record = requestPromptRecord({
      runId: externalRunId,
      parts: [{ order: 0, text: '月白布衫，青裙，袖口有薄面灰' }],
    });

    await persistence.upsertRequestPromptRecord({ record });
    // 重放（含被改写的内容）不得新增行，也不得覆盖已落库的正文。
    await persistence.upsertRequestPromptRecord({
      record: { ...record, parts: [{ order: 0, text: '被改写的文本' }] },
    });

    const rows = await prisma.runRequestPrompt.findMany({ where: { runId: runRowId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: stableRequestPromptRecordId(record),
      requestRunId: externalRunId,
      nodeId: 'node_image',
      attempt: 1,
      mediaType: 'IMAGE',
      sendStatus: 'pending',
      assetId: null,
      assetVersion: null,
    });
    expect(rows[0]?.parts).toEqual([{ order: 0, text: '月白布衫，青裙，袖口有薄面灰' }]);
  });

  it('只写入一次发送终态与结果身份，且按 attempt 与节点区分记录', async () => {
    const record = requestPromptRecord({ runId: externalRunId });
    await persistence.upsertRequestPromptRecord({ record });
    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'sent',
      assetId: 'asset_result_v1',
      assetVersion: 2,
    });
    await persistence.recordRequestPromptOutcome({
      identity: record,
      sendStatus: 'unknown',
      assetId: 'asset_other',
      assetVersion: 9,
    });
    // 第二次 attempt 是独立记录，不受第一次的绑定影响。
    await persistence.upsertRequestPromptRecord({ record: { ...record, attempt: 2 } });

    const rows = await prisma.runRequestPrompt.findMany({
      where: { runId: runRowId },
      orderBy: [{ attempt: 'asc' }],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      sendStatus: 'sent',
      assetId: 'asset_result_v1',
      assetVersion: 2,
    });
    expect(rows[1]).toMatchObject({ attempt: 2, sendStatus: 'pending', assetId: null });
  });

  it('在数据库里按最早时刻合并节点时间', async () => {
    await persistence.updateRun({
      runId: externalRunId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          queuedAt: '2026-09-17T10:00:00.100Z',
          startedAt: '2026-09-17T10:00:01.000Z',
        },
      },
    });
    await persistence.updateRun({
      runId: externalRunId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          startedAt: '2026-09-17T10:00:09.000Z',
          finishedAt: '2026-09-17T10:00:12.400Z',
          outcome: 'succeeded',
        },
      },
    });
    // 迟到或重复的终态事件不能移动已经写入的时间。
    await persistence.updateRun({
      runId: externalRunId,
      status: 'processing',
      nodeTimings: {
        node_image: {
          nodeId: 'node_image',
          startedAt: '2026-09-17T10:05:00.000Z',
          finishedAt: '2026-09-17T10:05:30.000Z',
          outcome: 'cancelled',
        },
      },
    });

    const row = await prisma.run.findUnique({
      where: { id: runRowId },
      select: { nodeTimings: true },
    });
    const timings = row?.nodeTimings as Record<string, Record<string, string>> | null;
    expect(timings?.node_image).toEqual({
      nodeId: 'node_image',
      queuedAt: '2026-09-17T10:00:00.100Z',
      startedAt: '2026-09-17T10:00:01.000Z',
      finishedAt: '2026-09-17T10:00:12.400Z',
      outcome: 'succeeded',
    });
    expect(nodeTimingDuration(timings?.node_image as never, Date.now())).toEqual({
      availability: 'recorded',
      milliseconds: 11_400,
    });
  });
});

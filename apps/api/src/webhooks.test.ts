import { describe, expect, it, vi } from 'vitest';

import {
  MemoryWebhookEventStore,
  PrismaWebhookEventStore,
  type WebhookEventPayload,
} from './webhooks';

function createClock(start = '2026-08-29T00:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe('MemoryWebhookEventStore', () => {
  it('keeps a successfully processed event idempotent', async () => {
    const clock = createClock();
    const store = new MemoryWebhookEventStore({
      now: clock.now,
      leaseMs: 1_000,
      createLeaseToken: vi.fn().mockReturnValueOnce('lease-1'),
    });

    const first = await store.claim(' event-1 ', 'newapi', { value: 'original' });
    expect(first).toMatchObject({
      deduplicated: false,
      status: 'processing',
      attempt: 1,
      leaseToken: 'lease-1',
    });

    await expect(store.markProcessed('event-1', first.leaseToken!)).resolves.toMatchObject({
      applied: true,
      status: 'processed',
      attempt: 1,
    });
    await expect(store.claim('event-1', 'newapi', { value: 'replacement' })).resolves.toEqual({
      deduplicated: true,
      status: 'processed',
      attempt: 1,
    });
    await expect(store.markProcessed('event-1', first.leaseToken!)).resolves.toMatchObject({
      applied: false,
      status: 'processed',
    });
  });

  it('moves a failed event back to processing on the next delivery', async () => {
    const clock = createClock();
    const store = new MemoryWebhookEventStore({
      now: clock.now,
      createLeaseToken: vi
        .fn()
        .mockReturnValueOnce('lease-failed')
        .mockReturnValueOnce('lease-retry'),
    });

    const first = await store.claim('event-failed', 'newapi', { value: 'payload' });
    await expect(
      store.markFailed('event-failed', first.leaseToken!, new Error('temporary')),
    ).resolves.toMatchObject({
      applied: true,
      status: 'failed',
      attempt: 1,
    });
    await expect(store.get('event-failed')).resolves.toMatchObject({
      status: 'failed',
      lastError: 'temporary',
    });

    const retry = await store.claim('event-failed', 'newapi', { value: 'ignored-on-retry' });
    expect(retry).toMatchObject({
      deduplicated: false,
      status: 'processing',
      attempt: 2,
      leaseToken: 'lease-retry',
    });
    await expect(store.markProcessed('event-failed', retry.leaseToken!)).resolves.toMatchObject({
      applied: true,
      status: 'processed',
      attempt: 2,
    });
    await expect(store.get('event-failed')).resolves.toMatchObject({
      status: 'processed',
      payload: { value: 'payload' },
    });
  });

  it('allows only one concurrent worker to claim a new event', async () => {
    const store = new MemoryWebhookEventStore({
      createLeaseToken: vi.fn().mockReturnValueOnce('lease-a').mockReturnValueOnce('lease-b'),
    });

    const claims = await Promise.all([
      store.claim('event-concurrent', 'newapi', {}),
      store.claim('event-concurrent', 'newapi', {}),
    ]);

    expect(claims.filter((claim) => !claim.deduplicated)).toHaveLength(1);
    expect(claims.filter((claim) => claim.deduplicated)).toHaveLength(1);
    expect(claims.map((claim) => claim.attempt)).toEqual([1, 1]);
  });

  it('reclaims an expired lease and rejects the stale worker transition', async () => {
    const clock = createClock();
    const store = new MemoryWebhookEventStore({
      now: clock.now,
      leaseMs: 100,
      createLeaseToken: vi.fn().mockReturnValueOnce('lease-old').mockReturnValueOnce('lease-new'),
    });

    const first = await store.claim('event-expired', 'newapi', {});
    clock.advance(100);
    const second = await store.claim('event-expired', 'newapi', {});

    expect(second).toMatchObject({
      deduplicated: false,
      status: 'processing',
      attempt: 2,
      leaseToken: 'lease-new',
    });
    await expect(
      store.markFailed('event-expired', first.leaseToken!, 'stale'),
    ).resolves.toMatchObject({
      applied: false,
      status: 'processing',
      attempt: 2,
    });
    await expect(store.markProcessed('event-expired', second.leaseToken!)).resolves.toMatchObject({
      applied: true,
      status: 'processed',
    });
  });
});

describe('PrismaWebhookEventStore', () => {
  it('uses an atomic claim predicate and retries a failed row', async () => {
    const clock = createClock();
    const mock = createPrismaWebhookClient(clock);
    const store = new PrismaWebhookEventStore(mock.prisma, {
      now: clock.now,
      leaseMs: 1_000,
      createLeaseToken: vi.fn().mockReturnValueOnce('prisma-1').mockReturnValueOnce('prisma-2'),
    });

    const first = await store.claim('event-prisma', 'newapi', { ok: true });
    await store.markFailed('event-prisma', first.leaseToken!, 'temporary failure');
    const retry = await store.claim('event-prisma', 'newapi', { ok: false });

    expect(retry).toMatchObject({ deduplicated: false, status: 'processing', attempt: 2 });
    expect(mock.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: 'event-prisma',
          OR: expect.arrayContaining([
            { status: 'failed', processedAt: null },
            { status: 'processing', processedAt: null, processingLeaseExpiresAt: null },
          ]),
        }),
      }),
    );
  });

  it('deduplicates concurrent and completed rows while reclaiming expired processing', async () => {
    const clock = createClock();
    const mock = createPrismaWebhookClient(clock);
    const store = new PrismaWebhookEventStore(mock.prisma, {
      now: clock.now,
      leaseMs: 100,
      createLeaseToken: vi
        .fn()
        .mockReturnValueOnce('prisma-old')
        .mockReturnValueOnce('prisma-duplicate')
        .mockReturnValueOnce('prisma-new')
        .mockReturnValueOnce('prisma-completed'),
    });

    const first = await store.claim('event-prisma-expired', 'newapi', {});
    const concurrent = await store.claim('event-prisma-expired', 'newapi', {});
    expect(concurrent).toMatchObject({ deduplicated: true, status: 'processing', attempt: 1 });

    clock.advance(100);
    const reclaimed = await store.claim('event-prisma-expired', 'newapi', {});
    expect(reclaimed).toMatchObject({ deduplicated: false, status: 'processing', attempt: 2 });
    await expect(
      store.markProcessed('event-prisma-expired', first.leaseToken!),
    ).resolves.toMatchObject({
      applied: false,
      status: 'processing',
      attempt: 2,
    });
    await expect(
      store.markProcessed('event-prisma-expired', reclaimed.leaseToken!),
    ).resolves.toMatchObject({
      applied: true,
      status: 'processed',
    });
    await expect(store.claim('event-prisma-expired', 'newapi', {})).resolves.toMatchObject({
      deduplicated: true,
      status: 'processed',
      attempt: 2,
    });
  });

  it('maps a legacy processedAt-only row to a terminal processed event', async () => {
    const processedAt = new Date('2026-08-29T00:01:00.000Z');
    const mock = createPrismaWebhookClient(createClock(), {
      eventId: 'legacy-event',
      provider: 'newapi',
      payload: { legacy: true },
      receivedAt: new Date('2026-08-29T00:00:00.000Z'),
      processedAt,
      status: undefined,
      attemptCount: 0,
    });
    const store = new PrismaWebhookEventStore(mock.prisma, {
      createLeaseToken: () => 'unused',
    });

    await expect(store.get('legacy-event')).resolves.toMatchObject({
      status: 'processed',
      attempt: 1,
      processedAt,
    });
    await expect(store.claim('legacy-event', 'newapi', {})).resolves.toMatchObject({
      deduplicated: true,
      status: 'processed',
    });
  });
});

type MockWebhookRow = {
  eventId: string;
  provider: string;
  payload: WebhookEventPayload;
  status?: string;
  attemptCount?: number;
  processingToken?: string | null;
  processingStartedAt?: Date | null;
  processingLeaseExpiresAt?: Date | null;
  lastError?: string | null;
  receivedAt?: Date;
  processedAt?: Date | null;
};

function createPrismaWebhookClient(clock: { now: () => Date }, initial?: MockWebhookRow) {
  const rows = new Map<string, MockWebhookRow>();
  if (initial) rows.set(initial.eventId, cloneRow(initial));

  const webhookEvent = {
    create: vi.fn(async ({ data }: { data: MockWebhookRow }) => {
      if (rows.has(data.eventId)) throw { code: 'P2002' };
      const row: MockWebhookRow = {
        ...data,
        receivedAt: data.receivedAt ?? clock.now(),
        processedAt: null,
      };
      rows.set(data.eventId, row);
      return cloneRow(row);
    }),
    findUnique: vi.fn(async ({ where }: { where: { eventId: string } }) => {
      const row = rows.get(where.eventId);
      return row ? cloneRow(row) : null;
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(String(where.eventId));
        if (!row || !matchesWhere(row, where)) return { count: 0 };
        applyUpdate(row, data);
        return { count: 1 };
      },
    ),
  };

  return { prisma: { webhookEvent } as never, webhookEvent };
}

function matchesWhere(row: MockWebhookRow, where: Record<string, unknown>): boolean {
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.processedAt === null && row.processedAt !== null && row.processedAt !== undefined) {
    return false;
  }
  if (where.processingToken !== undefined && row.processingToken !== where.processingToken) {
    return false;
  }
  const lease = row.processingLeaseExpiresAt?.getTime();
  const leaseFilter = where.processingLeaseExpiresAt as
    { lte?: Date; gt?: Date } | null | undefined;
  if (leaseFilter === null && lease !== undefined) return false;
  if (leaseFilter?.lte && (lease === undefined || lease > leaseFilter.lte.getTime())) return false;
  if (leaseFilter?.gt && (lease === undefined || lease <= leaseFilter.gt.getTime())) return false;
  const alternatives = where.OR;
  return (
    !Array.isArray(alternatives) ||
    alternatives.some((item) => matchesWhere(row, item as Record<string, unknown>))
  );
}

function applyUpdate(row: MockWebhookRow, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (isIncrement(value)) {
      row.attemptCount = (row.attemptCount ?? 0) + value.increment;
    } else {
      (row as Record<string, unknown>)[key] = value;
    }
  }
}

function isIncrement(value: unknown): value is { increment: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'increment' in value &&
    typeof value.increment === 'number'
  );
}

function cloneRow(row: MockWebhookRow): MockWebhookRow {
  return {
    ...row,
    payload: structuredClone(row.payload),
    ...(row.receivedAt ? { receivedAt: new Date(row.receivedAt) } : {}),
    ...(row.processedAt ? { processedAt: new Date(row.processedAt) } : {}),
    ...(row.processingStartedAt ? { processingStartedAt: new Date(row.processingStartedAt) } : {}),
    ...(row.processingLeaseExpiresAt
      ? { processingLeaseExpiresAt: new Date(row.processingLeaseExpiresAt) }
      : {}),
  };
}

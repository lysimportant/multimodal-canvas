import { Prisma, PrismaClient } from '@prisma/client';

export type WebhookEventPayload = Record<string, unknown>;

export interface WebhookEventStore {
  accept(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
  ): Promise<{ deduplicated: boolean }>;
  close?(): Promise<void>;
}

/** In-memory event store used by tests and local development without PostgreSQL. */
export class MemoryWebhookEventStore implements WebhookEventStore {
  private readonly eventIds = new Set<string>();

  async accept(eventId: string): Promise<{ deduplicated: boolean }> {
    if (this.eventIds.has(eventId)) return { deduplicated: true };
    this.eventIds.add(eventId);
    return { deduplicated: false };
  }
}

/** PostgreSQL-backed webhook idempotency store. */
export class PrismaWebhookEventStore implements WebhookEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async accept(
    eventId: string,
    provider: string,
    payload: WebhookEventPayload,
  ): Promise<{ deduplicated: boolean }> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventId,
          provider,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      return { deduplicated: false };
    } catch (error) {
      if (isUniqueConstraintError(error)) return { deduplicated: true };
      throw error;
    }
  }
}

function isUniqueConstraintError(value: unknown): value is Prisma.PrismaClientKnownRequestError {
  return value instanceof Prisma.PrismaClientKnownRequestError && value.code === 'P2002';
}

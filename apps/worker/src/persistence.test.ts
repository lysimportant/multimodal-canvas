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

import { createRunWorker } from './index';
import type { WorkerLogger } from './logger';
import type { Observability } from '@multimodal-canvas/observability';

const databaseRunId = '123e4567-e89b-12d3-a456-426614174000';
const snapshot = {
  projectId: 'project_1',
  canvasRevision: 1,
  targetNodeId: 'node_text',
  modelAlias: 'mock-text',
  parameters: {},
  submittedAt: '2026-08-25T00:00:00.000Z',
  nodes: [
    {
      id: 'node_text',
      type: 'text' as const,
      position: { x: 0, y: 0 },
      data: { label: 'Hello', mediaType: 'text' as const, mode: 'generate' as const },
    },
  ],
  edges: [],
  inputs: [],
};

describe('worker run persistence boundary', () => {
  it('persists provider lifecycle and usage only after resolving a database run id', async () => {
    const providerJobs: Array<{ runId: string; providerJob: Record<string, unknown> }> = [];
    const runLifecycle: Array<{ runId: string; status: string }> = [];
    const usageEntries: Array<Record<string, unknown>> = [];
    const logEvents: Array<{
      level: string;
      bindings: Record<string, unknown>;
      message?: string;
    }> = [];
    const spans: Array<{
      name: string;
      attributes: Record<string, string | number | boolean>;
      status?: string;
    }> = [];
    const observability: Observability = {
      startSpan(name, attributes = {}) {
        const record = { name, attributes: { ...attributes } } as (typeof spans)[number];
        spans.push(record);
        return {
          setAttribute(key, value) {
            record.attributes[key] = value;
          },
          recordException: vi.fn(),
          end(status) {
            record.status = status;
          },
        };
      },
      captureException: vi.fn(),
    };
    const createTestLogger = (bindings: Record<string, unknown> = {}): WorkerLogger => ({
      child: (childBindings) => createTestLogger({ ...bindings, ...childBindings }),
      debug: (data, message) =>
        logEvents.push({ level: 'debug', bindings: { ...bindings, ...toBindings(data) }, message }),
      info: (data, message) =>
        logEvents.push({ level: 'info', bindings: { ...bindings, ...toBindings(data) }, message }),
      warn: (data, message) =>
        logEvents.push({ level: 'warn', bindings: { ...bindings, ...toBindings(data) }, message }),
      error: (data, message) =>
        logEvents.push({ level: 'error', bindings: { ...bindings, ...toBindings(data) }, message }),
    });
    const job: NonNullable<typeof bullmqState.job> = {
      id: 'run_queue_1',
      data: {
        runId: 'run_queue_1',
        snapshot,
        attempt: 1,
        provider: 'mock',
        providerJob: {
          id: 'provider_job_run_queue_1',
          provider: 'mock',
          status: 'queued' as const,
          progress: 0,
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
        cancelRequested: false,
      } as Record<string, unknown>,
      async updateData(data: Record<string, unknown>) {
        this.data = data;
      },
      async updateProgress(_progress: unknown) {},
    };
    bullmqState.job = job;

    const { worker } = createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      resolveDatabaseRunId: async (runId) => (runId === job.id ? databaseRunId : undefined),
      persistence: {
        async ensureRun(input) {
          runLifecycle.push({ runId: input.runId, status: input.status ?? 'queued' });
        },
        async updateRun(input) {
          runLifecycle.push({ runId: input.runId, status: input.status });
        },
        async upsertProviderJob(input) {
          providerJobs.push(input as { runId: string; providerJob: Record<string, unknown> });
        },
        async recordUsage(input) {
          usageEntries.push(input);
        },
      },
      provider: {
        async execute() {
          return {
            result: {
              provider: 'mock',
              summary: 'done',
              targetNodeId: 'node_text',
              mediaType: 'text' as const,
              inputCount: 0,
            },
            usage: { amount: '1.250000', currency: 'USD', metadata: { requestId: 'req_1' } },
          };
        },
      },
      logger: createTestLogger(),
      observability,
    });

    expect(bullmqState.processor).toBeDefined();
    await bullmqState.processor?.(job);

    expect(providerJobs.length).toBeGreaterThanOrEqual(4);
    expect(providerJobs.every((entry) => entry.runId === databaseRunId)).toBe(true);
    expect(providerJobs.at(-1)?.providerJob).toMatchObject({ status: 'succeeded', progress: 100 });
    expect(runLifecycle[0]).toEqual({ runId: databaseRunId, status: 'queued' });
    expect(runLifecycle.at(-1)).toEqual({ runId: databaseRunId, status: 'succeeded' });
    expect(usageEntries).toEqual([
      {
        runId: databaseRunId,
        amount: '1.250000',
        currency: 'USD',
        metadata: { requestId: 'req_1' },
      },
    ]);
    expect(logEvents.map((event) => event.message)).toContain('run started');
    expect(logEvents.map((event) => event.message)).toContain('run succeeded');
    expect(logEvents.filter((event) => event.bindings.runId !== 'run_queue_1')).toHaveLength(0);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'run.process',
      status: 'ok',
      attributes: { 'run.id': 'run_queue_1', 'run.status': 'succeeded' },
    });
    void worker;
  });

  it('does not turn a late provider response into success after cancellation', async () => {
    const job: NonNullable<typeof bullmqState.job> = {
      id: 'run_queue_cancelled',
      data: {
        runId: 'run_queue_cancelled',
        snapshot,
        attempt: 1,
        provider: 'mock',
        providerJob: {
          id: 'provider_job_run_queue_cancelled',
          provider: 'mock',
          status: 'queued' as const,
          progress: 0,
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        },
        cancelRequested: false,
      } as Record<string, unknown>,
      async updateData(data: Record<string, unknown>) {
        this.data = data;
      },
      async updateProgress(_progress: unknown) {},
    };
    bullmqState.job = job;

    const { worker } = createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      stepDelayMs: 0,
      provider: {
        async execute() {
          job.data.cancelRequested = true;
          return {
            provider: 'mock',
            summary: 'late response',
            targetNodeId: 'node_text',
            mediaType: 'text' as const,
            inputCount: 0,
          };
        },
      },
    });

    const result = await bullmqState.processor?.(job);
    expect(result).toMatchObject({ status: 'cancelled' });
    void worker;
  });
});

function toBindings(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

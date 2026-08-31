import { beforeEach, describe, expect, it, vi } from 'vitest';

const bullmqState = vi.hoisted(() => ({
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
      return undefined;
    }
  }

  return { Job, Queue, Worker };
});

import { createProviderJobRecord, createRunWorker } from './index';

function diagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: cause ? { name: cause.name, message: cause.message, stack: cause.stack } : error.cause,
  });
}

beforeEach(() => {
  bullmqState.processor = undefined;
});

describe('Worker observability boundary', () => {
  it('passes only a redacted diagnostic copy to span and exception adapters', async () => {
    const runId = '123e4567-e89b-12d3-a456-426614174090';
    const recordException = vi.fn();
    const captureException = vi.fn();
    const source = new Error(
      'generation failed Authorization: Bearer synthetic-worker-bearer after submission',
      { cause: new Error('provider refused apiKey=synthetic-worker-key during polling') },
    );
    const job = {
      id: runId,
      data: {
        runId,
        snapshot: {
          projectId: runId,
          canvasRevision: 1,
          targetNodeId: 'node_text_observability',
          modelAlias: 'text-model',
          parameters: {},
          submittedAt: '2026-08-28T00:00:00.000Z',
          nodes: [
            {
              id: 'node_text_observability',
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
      async updateData(data: Record<string, unknown>) {
        this.data = data as typeof this.data;
      },
      async updateProgress() {},
    };

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: vi.fn(async () => Promise.reject(source)) },
      stepDelayMs: 0,
      observability: {
        startSpan: () => ({ setAttribute: vi.fn(), recordException, end: vi.fn() }),
        captureException,
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toBe(source);
    expect(recordException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledOnce();
    const spanError = recordException.mock.calls[0][0];
    const capturedError = captureException.mock.calls[0][0];
    expect(spanError).toBe(capturedError);
    expect(spanError).not.toBe(source);
    expect(diagnosticText(spanError)).toContain('generation failed');
    expect(diagnosticText(spanError)).toContain('after submission');
    expect(diagnosticText(spanError)).toContain('during polling');
    expect(diagnosticText(spanError)).toContain('[REDACTED]');
    expect(diagnosticText(spanError)).not.toMatch(/synthetic-worker-(?:bearer|key)/);
    expect(captureException.mock.calls[0][1]).toMatchObject({ component: 'worker' });
  });
});

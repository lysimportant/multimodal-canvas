import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ job: undefined as any }));

vi.mock('bullmq', () => {
  class Queue {
    constructor(..._args: unknown[]) {}
    async getJob() {
      return state.job;
    }
    async close() {}
  }
  return { Queue };
});

import { BullMqRunService, createRunSnapshot } from './runs';

describe('BullMQ run result integrity', () => {
  it('marks a completed job with an invalid result envelope as failed', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_text',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'text', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_text',
    );
    state.job = {
      id: 'run_1',
      data: {
        runId: 'run_1',
        snapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      progress: undefined,
      returnvalue: { status: 'succeeded', progress: 100, result: { malformed: true } },
      timestamp: Date.now(),
      async getState() {
        return 'completed';
      },
    };

    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });
    await expect(service.get('run_1')).resolves.toMatchObject({
      status: 'failed',
      error: 'worker returned an invalid run result',
    });
    await service.close();
  });
});

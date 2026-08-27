import { describe, expect, it } from 'vitest';

import type { RunRecord } from '@multimodal-canvas/domain';
import { shouldApplyRunUpdate, shouldClearNodeStale } from './run-update-utils';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    projectId: 'project-1',
    targetNodeId: 'node-1',
    status: 'queued',
    progress: 0,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'mock-text',
    snapshot: {
      projectId: 'project-1',
      canvasRevision: 3,
      targetNodeId: 'node-1',
      modelAlias: 'mock-text',
      parameters: {},
      submittedAt: '2026-08-27T01:00:00.000Z',
      nodes: [],
      edges: [],
      inputs: [],
    },
    createdAt: '2026-08-27T01:00:00.000Z',
    updatedAt: '2026-08-27T01:00:00.000Z',
    ...overrides,
  };
}

describe('run update ordering', () => {
  it('rejects a late event from an older run', () => {
    const current = run({
      id: 'run-new',
      status: 'succeeded',
      createdAt: '2026-08-27T01:02:00.000Z',
      updatedAt: '2026-08-27T01:03:00.000Z',
    });
    const incoming = run({
      id: 'run-old',
      status: 'succeeded',
      createdAt: '2026-08-27T01:00:00.000Z',
      updatedAt: '2026-08-27T01:04:00.000Z',
    });
    expect(shouldApplyRunUpdate(current, incoming)).toBe(false);
  });

  it('accepts forward progress for the same run but rejects an older snapshot', () => {
    const current = run({ status: 'running', progress: 40, updatedAt: '2026-08-27T01:01:00.000Z' });
    expect(
      shouldApplyRunUpdate(
        current,
        run({ status: 'processing', progress: 70, updatedAt: '2026-08-27T01:02:00.000Z' }),
      ),
    ).toBe(true);
    expect(
      shouldApplyRunUpdate(
        current,
        run({ status: 'queued', progress: 0, updatedAt: '2026-08-27T00:59:00.000Z' }),
      ),
    ).toBe(false);
  });

  it('only clears stale for a successful result from the current saved revision', () => {
    const succeeded = run({
      status: 'succeeded',
      snapshot: { ...run().snapshot, canvasRevision: 4 },
    });
    expect(shouldClearNodeStale(succeeded, 4, false)).toBe(true);
    expect(shouldClearNodeStale(succeeded, 5, false)).toBe(false);
    expect(shouldClearNodeStale(succeeded, 4, true)).toBe(false);
    expect(shouldClearNodeStale(run({ status: 'failed' }), 3, false)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { createProviderJobRecord, normalizeProviderExecution, resolveDatabaseRunId } from './index';
import { serializeWorkerError } from './logger';

const result = {
  provider: 'mock',
  summary: 'done',
  targetNodeId: 'node_text',
  mediaType: 'text' as const,
  inputCount: 0,
};

describe('worker provider job boundary', () => {
  it('redacts credential-like values from error diagnostics', () => {
    expect(
      serializeWorkerError(
        new Error('upstream rejected Authorization: Bearer secret-token apiKey=secret-key'),
      ),
    ).toMatchObject({
      errorName: 'Error',
      errorMessage: expect.not.stringContaining('secret-token'),
    });
    expect(serializeWorkerError(new Error('apiKey=secret-key')).errorMessage).not.toContain(
      'secret-key',
    );
  });

  it('creates a stable local provider job record', () => {
    expect(
      createProviderJobRecord('run_1', 'newapi', 'running', 45, '2026-08-25T00:00:00.000Z'),
    ).toEqual({
      id: 'provider_job_run_1',
      provider: 'newapi',
      status: 'running',
      progress: 45,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
  });

  it('normalizes legacy providers and provider execution envelopes', () => {
    expect(normalizeProviderExecution(result)).toEqual({ result });
    expect(
      normalizeProviderExecution({
        result,
        output: {
          mediaType: 'text',
          kind: 'text',
          text: 'generated text',
          mimeType: 'text/plain',
          format: 'txt',
        },
        providerJob: { provider: 'newapi', platformJobId: 'platform-1' },
        usage: { amount: '1.25', currency: 'usd', metadata: { requestId: 'req-1' } },
      }),
    ).toMatchObject({
      result,
      output: {
        mediaType: 'text',
        kind: 'text',
        text: 'generated text',
        mimeType: 'text/plain',
        format: 'txt',
      },
      providerJob: { platformJobId: 'platform-1' },
      usage: { amount: '1.25', metadata: { requestId: 'req-1' } },
    });
  });

  it('only enables database persistence for a resolved PostgreSQL UUID', async () => {
    const snapshot = {} as never;
    const databaseRunId = '123e4567-e89b-12d3-a456-426614174000';

    await expect(resolveDatabaseRunId(undefined, databaseRunId, snapshot)).resolves.toBe(
      databaseRunId,
    );
    await expect(resolveDatabaseRunId(undefined, 'run_123', snapshot)).resolves.toBeUndefined();
    await expect(
      resolveDatabaseRunId(async () => databaseRunId, 'run_123', snapshot),
    ).resolves.toBe(databaseRunId);
    await expect(
      resolveDatabaseRunId(async () => 'run_123', 'run_123', snapshot),
    ).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { createIdempotentRunId, createRunSnapshot, MemoryRunService } from './runs';

function snapshot() {
  return createRunSnapshot(
    'project_1',
    {
      revision: 2,
      nodes: [
        {
          id: 'node_text',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Generate text', mediaType: 'text', mode: 'generate' },
        },
      ],
      edges: [],
    },
    'node_text',
  );
}

describe('run idempotency', () => {
  const services: MemoryRunService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it('returns the original memory run for a repeated project-scoped key', async () => {
    const service = new MemoryRunService({ stepDelayMs: 100 });
    services.push(service);
    const [first, repeated] = await Promise.all([
      service.create(snapshot(), { idempotencyKey: ' submit-1 ' }),
      service.create(snapshot(), { idempotencyKey: 'submit-1' }),
    ]);

    expect(repeated.id).toBe(first.id);
    expect(repeated.idempotencyKey).toBe('submit-1');
    expect(await service.listByProject('project_1')).toHaveLength(1);
  });

  it('creates a stable BullMQ-compatible id from project and key', () => {
    expect(createIdempotentRunId('project_1', 'submit-1')).toBe(
      createIdempotentRunId('project_1', 'submit-1'),
    );
    expect(createIdempotentRunId('project_1', 'submit-1')).not.toBe(
      createIdempotentRunId('project_2', 'submit-1'),
    );
  });

  it('rejects reuse of a key for a different request', async () => {
    const service = new MemoryRunService({ stepDelayMs: 100 });
    services.push(service);
    await service.create(snapshot(), { idempotencyKey: 'submit-2' });
    const changed = { ...snapshot(), canvasRevision: 3 };

    await expect(service.create(changed, { idempotencyKey: 'submit-2' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
});

describe('run credential snapshots', () => {
  it('stores only the credential reference and version', () => {
    const result = createRunSnapshot(
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
      { credentialId: 'credential_1', credentialVersion: 3 },
    );

    expect(result).toMatchObject({ credentialId: 'credential_1', credentialVersion: 3 });
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });
});

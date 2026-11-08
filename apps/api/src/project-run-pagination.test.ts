import type { RunRecord } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { MemoryAssetStore } from './assets';
import { TestAuthContext } from './fixtures/auth-session';
import { buildApp } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';
import { InvalidProjectRunCursorError, listProjectRunsPage } from './project-run-pagination';

function run(index: number, projectId = 'project', nodeId = 'target'): RunRecord {
  const createdAt = new Date(Date.UTC(2026, 10, 6, 0, 0, index)).toISOString();
  return {
    id: `run-${String(index).padStart(3, '0')}`,
    projectId,
    targetNodeId: nodeId,
    status: 'failed',
    progress: 0,
    attempt: 1,
    provider: 'mock',
    modelAlias: 'synthetic-video',
    createdAt,
    updatedAt: createdAt,
    snapshot: {
      projectId,
      targetNodeId: nodeId,
      modelAlias: 'synthetic-video',
      canvasRevision: 0,
      parameters: {},
      submittedAt: createdAt,
      nodes: [
        {
          id: nodeId,
          type: 'video',
          position: { x: 0, y: 0 },
          data: { label: 'Synthetic video', mediaType: 'video', mode: 'generate' },
        },
      ],
      edges: [],
      inputs: [],
    },
  };
}

describe('project run keyset pagination', () => {
  it('reads the newest records from unordered history and traverses over 50 without loss', () => {
    const history = Array.from({ length: 73 }, (_, index) => run(index));
    const shuffled = [...history.filter((_, i) => i % 2), ...history.filter((_, i) => !(i % 2))];
    const first = listProjectRunsPage(shuffled, 'project', { limit: 50 });
    expect(first.runs.map((entry) => entry.id)).toEqual(
      history
        .slice(23)
        .reverse()
        .map((entry) => entry.id),
    );
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    // 插入最新运行、删除上一页边界记录均不改变下一页已有记录。
    const second = listProjectRunsPage(
      [...shuffled.filter((entry) => entry.id !== 'run-023'), run(100)],
      'project',
      { limit: 50, cursor: first.nextCursor! },
    );
    expect(second.runs.map((entry) => entry.id)).toEqual(
      history
        .slice(0, 23)
        .reverse()
        .map((entry) => entry.id),
    );
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.runs, ...second.runs].map((entry) => entry.id)).size).toBe(73);
  });

  it('uses a stable ID order for equal timestamps and filters node and project before paging', () => {
    const history = Array.from({ length: 7 }, (_, index) => ({
      ...run(index, 'project', index % 2 ? 'other' : 'target'),
      createdAt: run(0).createdAt,
    }));
    history.unshift(run(99, 'foreign-project'));
    const first = listProjectRunsPage(history, 'project', { limit: 2, nodeId: 'target' });
    expect(first.runs.map((entry) => entry.id)).toEqual(['run-006', 'run-004']);
    const second = listProjectRunsPage(history.reverse(), 'project', {
      limit: 2,
      nodeId: 'target',
      cursor: first.nextCursor!,
    });
    expect(second.runs.map((entry) => entry.id)).toEqual(['run-002', 'run-000']);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('keeps the unpaged legacy response and defaults filtered pages to 20', () => {
    const history = Array.from({ length: 55 }, (_, index) => run(index));
    expect(listProjectRunsPage(history, 'project', {})).toEqual({ runs: history });
    const filtered = listProjectRunsPage(history, 'project', { nodeId: 'target' });
    expect(filtered.runs).toHaveLength(20);
    expect(filtered.runs[0]!.id).toBe('run-054');
    expect(filtered.hasMore).toBe(true);
    expect(listProjectRunsPage(history, 'project', { nodeId: 'missing' })).toEqual({
      runs: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('rejects invalid cursors and cursors borrowed from another project or filter', () => {
    const history = [run(0), run(1)];
    const cursor = listProjectRunsPage(history, 'project', {
      limit: 1,
      nodeId: 'target',
    }).nextCursor!;
    for (const query of [
      { limit: 1, cursor: 'invalid!cursor' },
      { limit: 1, cursor: Buffer.from('{}').toString('base64url') },
      { limit: 1, cursor },
      { limit: 1, nodeId: 'other', cursor },
    ])
      expect(() => listProjectRunsPage(history, 'project', query)).toThrow(
        InvalidProjectRunCursorError,
      );
    expect(() =>
      listProjectRunsPage(history, 'other-project', { limit: 1, nodeId: 'target', cursor }),
    ).toThrow(InvalidProjectRunCursorError);
  });
});

const applications: FastifyInstance[] = [];
beforeEach(() => {
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', 'synthetic-project-run-pagination-secret');
});
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const auth = new TestAuthContext();
  const owner = await auth.session({ email: 'run-page-owner@example.test' });
  const other = await auth.session({ email: 'run-page-other@example.test' });
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: 'Runs' }, { ownerId: owner.user.id });
  const foreign = await projectStore.create({ name: 'Foreign' }, { ownerId: other.user.id });
  const runService = new MemoryRunService();
  const history = Array.from({ length: 55 }, (_, index) =>
    run(index, project.id, index % 2 ? 'other' : 'target'),
  );
  const list = vi
    .spyOn(runService, 'listByProject')
    .mockResolvedValue([...history, run(99, foreign.id)]);
  const app = buildApp({
    logger: false,
    assetStore: new MemoryAssetStore(),
    projectStore,
    runService,
    ...auth.appOptions,
  });
  applications.push(app);
  return { app, list, project, foreign, headers: { authorization: `Bearer ${owner.accessToken}` } };
}

describe('GET project runs pagination', () => {
  it('preserves the full legacy list, exposes filtered pages, and redacts snapshots', async () => {
    const { app, project, headers } = await fixture();
    const url = `/v1/projects/${project.id}/runs`;
    const legacy = await app.inject({ method: 'GET', url, headers });
    expect(legacy.statusCode).toBe(200);
    expect(Object.keys(legacy.json())).toEqual(['runs']);
    expect(legacy.json().runs).toHaveLength(55);
    const first = await app.inject({
      method: 'GET',
      url: `${url}?nodeId=target&limit=20`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    expect(first.json().runs).toHaveLength(20);
    expect(first.json().runs[0]).toMatchObject({ id: 'run-054', targetNodeId: 'target' });
    expect(first.json().runs[0].snapshot).not.toHaveProperty('nodes');
    const cursor = first.json().nextCursor as string;
    const second = await app.inject({
      method: 'GET',
      url: `${url}?nodeId=target&limit=20&cursor=${encodeURIComponent(cursor)}`,
      headers,
    });
    expect(second.json()).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.json().runs).toHaveLength(8);
    expect(second.json().runs[0].id).toBe('run-014');
  });

  it('validates pagination and keeps project authorization before history lookup', async () => {
    const { app, list, project, foreign, headers } = await fixture();
    for (const query of ['limit=51', 'limit=0', 'limit=no', 'nodeId=', 'cursor=bad!']) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/projects/${project.id}/runs?${query}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
    }
    list.mockClear();
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/projects/${foreign.id}/runs?limit=20`,
      headers,
    });
    expect(denied.statusCode).toBe(404);
    expect(list).not.toHaveBeenCalled();
  });
});

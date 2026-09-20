import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  job: undefined as any,
  getJob: undefined as any,
  getJobs: undefined as any,
  add: undefined as any,
  queueConstructorArgs: undefined as unknown[] | undefined,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(...args: unknown[]) {
      state.queueConstructorArgs = args;
    }
    async getJob(...args: unknown[]) {
      return state.getJob ? state.getJob(...args) : state.job;
    }
    async getJobs(...args: unknown[]) {
      return state.getJobs ? state.getJobs(...args) : [];
    }
    async add(...args: unknown[]) {
      if (!state.add) throw new Error('queue add is not configured');
      return state.add(...args);
    }
    async close() {}
  }
  return { Queue };
});

import { BullMqRunService, createIdempotentRunId, createRunSnapshot } from './runs';
import { databaseRunId } from './run-persistence';
import {
  createPromptOptimizationCanvas,
  PROMPT_OPTIMIZATION_NODE_ID,
  PROMPT_SKILLS,
  type PromptDocument,
  type RunRecord,
} from '@multimodal-canvas/domain';

afterEach(() => {
  state.job = undefined;
  state.getJob = undefined;
  state.getJobs = undefined;
  state.add = undefined;
  state.queueConstructorArgs = undefined;
});

describe('BullMQ run result integrity', () => {
  it('Skill 并发补建遇到不同冻结快照时，在发布前拒绝', async () => {
    const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '场景要求' }] };
    const skill = PROMPT_SKILLS[0]!;
    const snapshot = {
      ...createRunSnapshot(
        'project_1',
        createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' }),
        PROMPT_OPTIMIZATION_NODE_ID,
      ),
      promptOptimization: {
        nodeId: 'source',
        skillId: skill.id,
        skillVersion: skill.version,
        input,
      },
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: {
        getRun: vi.fn(async () => undefined),
        ensureRun: vi.fn(async () => ({ snapshot: { ...snapshot, modelAlias: 'another-model' } })),
      } as never,
    });
    state.add = vi.fn();
    await expect(
      service.create(snapshot, { idempotencyKey: 'concurrent-skill' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(state.add).not.toHaveBeenCalled();
    await service.close();
  });

  it('Skill 发布失败后同键补发原任务，不重置数据库或重复有效任务', async () => {
    const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '完善场景' }] };
    const skill = PROMPT_SKILLS[0]!;
    const snapshot = {
      ...createRunSnapshot(
        'project_1',
        createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' }),
        PROMPT_OPTIMIZATION_NODE_ID,
      ),
      promptOptimization: {
        nodeId: 'source',
        skillId: skill.id,
        skillVersion: skill.version,
        input,
      },
    };
    let durable: RunRecord | undefined;
    const persistence = {
      getRun: vi.fn(async () => durable),
      ensureRun: vi.fn(async (request) => {
        durable = {
          id: request.runId,
          projectId: snapshot.projectId,
          targetNodeId: snapshot.targetNodeId,
          modelAlias: snapshot.modelAlias,
          snapshot,
          idempotencyKey: request.idempotencyKey,
          status: 'queued',
          progress: 0,
          attempt: 1,
          provider: 'mock',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }),
      upsertProviderJob: vi.fn(async ({ providerJob }) => {
        durable!.providerJob = providerJob;
      }),
    };
    state.add = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic Redis disconnect'))
      .mockImplementation(async (_name, data, options) => {
        state.job ??= {
          id: options.jobId,
          data,
          timestamp: Date.now(),
          progress: 0,
          getState: async () => 'waiting',
        };
        return state.job;
      });
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'mock',
      persistence: persistence as never,
    });
    await expect(service.create(snapshot, { idempotencyKey: 'skill-recovery' })).rejects.toThrow(
      'disconnect',
    );
    expect(durable?.status).toBe('queued');
    const recovered = await service.create(snapshot, { idempotencyKey: 'skill-recovery' });
    expect(recovered.id).toBe(durable!.id);
    expect(recovered.snapshot).toEqual(snapshot);
    expect(recovered.provider).toBe('mock');
    await service.create(snapshot, { idempotencyKey: 'skill-recovery' });
    expect(state.add).toHaveBeenCalledTimes(2);
    expect(persistence.ensureRun).toHaveBeenCalledTimes(1);
    expect(persistence.upsertProviderJob).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it.each([undefined, 'synthetic-credential'])(
    'Skill Provider 身份未落库时禁止补发，不凭凭据升级执行模式：%s',
    async (credentialId) => {
      const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '完善场景' }] };
      const skill = PROMPT_SKILLS[0]!;
      const snapshot = {
        ...createRunSnapshot(
          'project_1',
          createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' }),
          PROMPT_OPTIMIZATION_NODE_ID,
        ),
        ...(credentialId ? { credentialId } : {}),
        promptOptimization: {
          nodeId: 'source',
          skillId: skill.id,
          skillVersion: skill.version,
          input,
        },
      };
      let durable: RunRecord | undefined;
      const persistence = {
        getRun: vi.fn(async () => durable),
        ensureRun: vi.fn(async (request) => {
          durable = {
            id: request.runId,
            projectId: snapshot.projectId,
            targetNodeId: snapshot.targetNodeId,
            modelAlias: snapshot.modelAlias,
            snapshot,
            idempotencyKey: request.idempotencyKey,
            status: 'queued',
            progress: 0,
            attempt: 1,
            provider: 'mock',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }),
        upsertProviderJob: vi.fn(async () => {
          throw new Error('synthetic ProviderJob persistence failure');
        }),
      };
      state.add = vi.fn();
      const service = new BullMqRunService({
        connection: { host: '127.0.0.1', port: 6379 },
        providerName: 'mock',
        persistence: persistence as never,
      });
      await expect(
        service.create(snapshot, { idempotencyKey: 'missing-provider' }),
      ).rejects.toThrow('ProviderJob persistence failure');
      await expect(
        service.create(snapshot, { idempotencyKey: 'missing-provider' }),
      ).rejects.toMatchObject({
        code: 'invalid_state',
        message: '优化任务缺少可靠的 Provider 身份，无法自动补发',
      });
      expect(state.add).not.toHaveBeenCalled();
      expect(persistence.ensureRun).toHaveBeenCalledTimes(1);
      expect(persistence.upsertProviderJob).toHaveBeenCalledTimes(1);
      await service.close();
    },
  );

  it.each(['succeeded', 'failed', 'cancelled', 'processing', 'provider-started', 'node-started'])(
    'Skill 队列丢失后不重发已执行或终态任务：%s',
    async (condition) => {
      const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '完善场景' }] };
      const skill = PROMPT_SKILLS[0]!;
      const snapshot = {
        ...createRunSnapshot(
          'project_1',
          createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' }),
          PROMPT_OPTIMIZATION_NODE_ID,
        ),
        promptOptimization: {
          nodeId: 'source',
          skillId: skill.id,
          skillVersion: skill.version,
          input,
        },
      };
      const now = new Date().toISOString();
      const durable: RunRecord = {
        id: createIdempotentRunId(snapshot.projectId, 'skill-existing'),
        projectId: snapshot.projectId,
        targetNodeId: snapshot.targetNodeId,
        modelAlias: snapshot.modelAlias,
        snapshot,
        idempotencyKey: 'skill-existing',
        status: condition.endsWith('started') ? 'queued' : (condition as RunRecord['status']),
        progress: 0,
        attempt: 1,
        provider: 'newapi',
        createdAt: now,
        updatedAt: now,
        ...(condition === 'provider-started'
          ? {
              providerJob: {
                id: 'provider_started',
                provider: 'newapi',
                status: 'running' as const,
                progress: 0,
                createdAt: now,
                updatedAt: now,
              },
            }
          : {}),
        ...(condition === 'node-started'
          ? {
              nodeTimings: {
                [snapshot.targetNodeId]: { nodeId: snapshot.targetNodeId, startedAt: now },
              },
            }
          : {}),
      };
      const persistence = {
        getRun: vi.fn(async () => durable),
        ensureRun: vi.fn(),
        upsertProviderJob: vi.fn(),
      };
      state.add = vi.fn();
      const service = new BullMqRunService({
        connection: { host: '127.0.0.1', port: 6379 },
        persistence,
      });
      expect(await service.create(snapshot, { idempotencyKey: 'skill-existing' })).toEqual(durable);
      await expect(
        service.create(
          { ...snapshot, modelAlias: 'changed' },
          { idempotencyKey: 'skill-existing' },
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(state.add).not.toHaveBeenCalled();
      expect(persistence.ensureRun).not.toHaveBeenCalled();
      expect(persistence.upsertProviderJob).not.toHaveBeenCalled();
      await service.close();
    },
  );

  it('队列过期后仍从持久记录读取独立优化并拒绝通用重试', async () => {
    const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '人物近景' }] };
    const skill = PROMPT_SKILLS[0]!;
    const canvas = createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType: 'image' });
    const snapshot = {
      ...createRunSnapshot('project_1', canvas, PROMPT_OPTIMIZATION_NODE_ID),
      promptOptimization: {
        nodeId: 'unsaved',
        skillId: skill.id,
        skillVersion: skill.version,
        input,
      },
    };
    const durableRun = {
      id: 'run_optimization',
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'failed' as const,
      progress: 80,
      attempt: 1,
      provider: 'newapi',
      modelAlias: snapshot.modelAlias,
      snapshot,
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:01:00.000Z',
    };
    state.getJob = vi.fn(async () => undefined);
    state.add = vi.fn();
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: { getRun: vi.fn(async () => durableRun) } as never,
    });
    await expect(service.get(durableRun.id)).resolves.toEqual(durableRun);
    await expect(service.retry(durableRun.id)).rejects.toThrow('提示词优化窗口');
    expect(state.add).not.toHaveBeenCalled();
    await service.close();
  });

  it('uses the configured queue name and preserves the default when omitted', async () => {
    const configured = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      queueName: 'custom-runs',
    });
    expect(state.queueConstructorArgs?.[0]).toBe('custom-runs');
    await configured.close();

    const defaultQueue = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
    });
    expect(state.queueConstructorArgs?.[0]).toBe('multimodal-canvas-runs');
    await defaultQueue.close();
  });

  it('falls back to durable persistence when the BullMQ job has expired', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 4,
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
    state.getJob = vi.fn(async () => undefined);
    const durableRun = {
      id: 'run_expired',
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'succeeded' as const,
      progress: 100,
      attempt: 1,
      provider: 'mock',
      modelAlias: snapshot.modelAlias,
      snapshot,
      result: {
        provider: 'mock',
        summary: 'durable result',
        targetNodeId: snapshot.targetNodeId,
        mediaType: 'text' as const,
        inputCount: 0,
      },
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      getRun: vi.fn(async () => durableRun),
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    await expect(service.get(durableRun.id)).resolves.toEqual(durableRun);
    expect(persistence.getRun).toHaveBeenCalledWith(durableRun.id);
    await service.close();
  });

  it('fills queue-backed run reads with durable node timings', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 4,
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
      id: 'run_timings',
      data: {
        runId: 'run_timings',
        snapshot,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      },
      progress: { status: 'processing', progress: 80, updatedAt: '2026-09-17T10:00:05.000Z' },
      timestamp: Date.parse('2026-09-17T10:00:00.000Z'),
      async getState() {
        return 'active';
      },
    };
    const nodeTimings = {
      node_text: {
        nodeId: 'node_text',
        queuedAt: '2026-09-17T10:00:00.500Z',
        startedAt: '2026-09-17T10:00:01.000Z',
      },
    };
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      getRun: vi.fn(async () => ({
        id: 'run_timings',
        projectId: snapshot.projectId,
        targetNodeId: 'node_text',
        status: 'processing' as const,
        progress: 80,
        attempt: 1,
        provider: 'newapi',
        modelAlias: snapshot.modelAlias,
        snapshot,
        nodeTimings,
        createdAt: '2026-09-17T10:00:00.000Z',
        updatedAt: '2026-09-17T10:00:05.000Z',
      })),
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    await expect(service.get('run_timings')).resolves.toMatchObject({
      id: 'run_timings',
      status: 'processing',
      nodeTimings,
    });
    expect(persistence.getRun).toHaveBeenCalledWith('run_timings');
    await service.close();
  });

  it('keeps persisted node timings in project run lists used by the Web client', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 5,
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
    const runId = 'run_list_timings';
    const nodeTimings = {
      node_text: {
        nodeId: 'node_text',
        queuedAt: '2026-09-17T10:00:00.500Z',
        startedAt: '2026-09-17T10:00:01.000Z',
        finishedAt: '2026-09-17T10:00:03.500Z',
        outcome: 'succeeded' as const,
      },
    };
    state.getJobs = vi.fn(async () => [
      {
        id: runId,
        data: { runId, snapshot, attempt: 1, provider: 'newapi', cancelRequested: false },
        progress: { status: 'processing', progress: 90, updatedAt: '2026-09-17T10:00:03.000Z' },
        returnvalue: undefined,
        timestamp: Date.parse('2026-09-17T10:00:00.000Z'),
        async getState() {
          return 'active';
        },
      },
    ]);
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      listRunsByProject: vi.fn(async () => [
        {
          id: databaseRunId(runId),
          projectId: snapshot.projectId,
          targetNodeId: 'node_text',
          status: 'processing' as const,
          progress: 80,
          attempt: 1,
          provider: 'newapi',
          modelAlias: snapshot.modelAlias,
          snapshot,
          nodeTimings,
          createdAt: '2026-09-17T10:00:00.000Z',
          updatedAt: '2026-09-17T10:00:03.000Z',
        },
      ]),
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    const runs = await service.listByProject('project_1');

    // 项目列表与 SSE 都走这条路径：队列记录必须带上只写入数据库的节点时间，
    // 同时保留队列自己的实时状态与进度，且不重复返回持久化行。
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      status: 'processing',
      progress: 90,
      nodeTimings,
    });
    expect(persistence.listRunsByProject).toHaveBeenCalledWith('project_1');
    await service.close();
  });

  it('lets a queue-backed run keep its live fields while durable-only fields survive', async () => {
    const snapshot = createRunSnapshot(
      'project_1',
      {
        revision: 6,
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
    const runId = 'run_merge_fields';
    const nodeTimings = {
      node_text: { nodeId: 'node_text', startedAt: '2026-09-17T10:00:01.000Z' },
    };
    state.getJobs = vi.fn(async () => [
      {
        id: runId,
        data: { runId, snapshot, attempt: 1, provider: 'newapi', cancelRequested: false },
        progress: { status: 'running', progress: 45, updatedAt: '2026-09-17T10:00:02.000Z' },
        returnvalue: undefined,
        timestamp: Date.parse('2026-09-17T10:00:00.000Z'),
        async getState() {
          return 'active';
        },
      },
    ]);
    // 持久化行故意更旧：它只能补写队列记录缺失的字段，不能覆盖实时状态。
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      listRunsByProject: vi.fn(async () => [
        {
          id: databaseRunId(runId),
          userId: '123e4567-e89b-42d3-a456-426614174001',
          projectId: snapshot.projectId,
          targetNodeId: 'node_text',
          status: 'queued' as const,
          progress: 0,
          attempt: 1,
          provider: 'newapi',
          modelAlias: snapshot.modelAlias,
          snapshot,
          nodeTimings,
          createdAt: '2026-09-17T10:00:00.000Z',
          updatedAt: '2026-09-17T10:00:00.500Z',
        },
      ]),
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    const runs = await service.listByProject('project_1');

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      status: 'running',
      progress: 45,
      updatedAt: '2026-09-17T10:00:02.000Z',
      userId: '123e4567-e89b-42d3-a456-426614174001',
      nodeTimings,
    });
    await service.close();
  });

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

  it('keeps the worker failedReason string as the run error', async () => {
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
      id: 'run_failed_reason',
      data: {
        runId: 'run_failed_reason',
        snapshot,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      },
      progress: { status: 'failed', progress: 80, updatedAt: new Date().toISOString() },
      returnvalue: undefined,
      failedReason: 'New API 视频任务失败（status=failed, task=task_demo）',
      timestamp: Date.now(),
      async getState() {
        return 'failed';
      },
    };
    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });
    await expect(service.get('run_failed_reason')).resolves.toMatchObject({
      status: 'failed',
      error: 'New API 视频任务失败（status=failed, task=task_demo）',
    });
    await service.close();
  });

  it('recovers an idempotent request when BullMQ rejects a concurrent duplicate add', async () => {
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
    const existingJob = {
      id: createIdempotentRunId('project_1', 'same-request'),
      data: {
        runId: createIdempotentRunId('project_1', 'same-request'),
        snapshot,
        attempt: 1,
        provider: 'mock',
        idempotencyKey: 'same-request',
        cancelRequested: false,
      },
      progress: undefined,
      returnvalue: undefined,
      timestamp: Date.now(),
      async getState() {
        return 'waiting';
      },
    };
    state.getJob = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(existingJob);
    state.add = vi.fn().mockRejectedValue(new Error('job already exists'));
    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });

    await expect(
      service.create(snapshot, { idempotencyKey: 'same-request' }),
    ).resolves.toMatchObject({
      id: createIdempotentRunId('project_1', 'same-request'),
      status: 'queued',
    });
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.getJob).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('cancels a durable run after its BullMQ job has expired', async () => {
    const snapshot = createRunSnapshot(
      'project_cancel',
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
    const durableRun = {
      id: 'run_expired_cancel',
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'running' as const,
      progress: 45,
      attempt: 1,
      provider: 'newapi' as const,
      modelAlias: snapshot.modelAlias,
      snapshot,
      providerJob: {
        id: 'provider_job_run_expired_cancel',
        provider: 'newapi' as const,
        platformJobId: 'platform-cancel-1',
        status: 'running' as const,
        progress: 45,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };
    state.getJob = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      getRun: vi.fn(async () => durableRun),
      updateRun,
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    await expect(service.cancel(durableRun.id)).resolves.toMatchObject({
      id: durableRun.id,
      status: 'cancel_requested',
      progress: 45,
    });
    expect(updateRun).toHaveBeenCalledWith({ runId: durableRun.id, status: 'cancel_requested' });
    await service.close();
  });

  it('applies a provider webhook from durable provider-job state after queue cleanup', async () => {
    const snapshot = createRunSnapshot(
      'project_webhook_expired',
      {
        revision: 1,
        nodes: [
          {
            id: 'node_video',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { label: 'Video', mediaType: 'video', mode: 'generate' },
          },
        ],
        edges: [],
      },
      'node_video',
    );
    const durableRun = {
      id: 'run_db_uuid',
      projectId: snapshot.projectId,
      targetNodeId: snapshot.targetNodeId,
      status: 'running' as const,
      progress: 45,
      attempt: 1,
      provider: 'newapi' as const,
      modelAlias: snapshot.modelAlias,
      snapshot,
      providerJob: {
        id: 'provider_job_run_db_uuid',
        provider: 'newapi' as const,
        platformJobId: 'platform-webhook-expired-1',
        status: 'submitted' as const,
        progress: 5,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:01:00.000Z',
    };
    state.getJobs = vi.fn(async () => []);
    const upsertProviderJob = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => undefined);
    const getRunByProviderJob = vi.fn(async () => durableRun);
    const persistence = {
      ensureRun: vi.fn(async () => undefined),
      getRunByProviderJob,
      upsertProviderJob,
      updateRun,
    };
    const service = new BullMqRunService({
      connection: { host: '127.0.0.1', port: 6379 },
      persistence: persistence as never,
    });

    await expect(
      service.applyProviderWebhook({
        provider: 'newapi',
        platformJobId: durableRun.providerJob.platformJobId,
        status: 'succeeded',
      }),
    ).resolves.toMatchObject({
      id: durableRun.id,
      status: 'succeeded',
      providerJob: { status: 'succeeded', progress: 100 },
    });
    expect(getRunByProviderJob).toHaveBeenCalledWith(
      'newapi',
      durableRun.providerJob.platformJobId,
    );
    expect(upsertProviderJob).toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith({ runId: durableRun.id, status: 'succeeded' });
    await service.close();
  });

  it('publishes only one BullMQ job for concurrent retries of the same run', async () => {
    const snapshot = createRunSnapshot(
      'project_retry',
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
    const previous = {
      id: 'run_failed',
      data: {
        runId: 'run_failed',
        snapshot,
        attempt: 1,
        provider: 'mock',
        cancelRequested: false,
      },
      progress: { status: 'failed', progress: 80, updatedAt: new Date().toISOString() },
      returnvalue: undefined,
      failedReason: 'provider failed',
      timestamp: Date.now(),
      async getState() {
        return 'failed';
      },
    };
    let retryJob: any;
    let createdJobs = 0;
    state.getJob = vi.fn(async (id: string) => (id === previous.id ? previous : retryJob));
    state.add = vi.fn(async (_name: string, data: any) => {
      if (retryJob) throw new Error('job already exists');
      createdJobs += 1;
      retryJob = {
        id: data.runId,
        data,
        progress: undefined,
        returnvalue: undefined,
        timestamp: Date.now(),
        async getState() {
          return 'waiting';
        },
      };
      return retryJob;
    });
    const service = new BullMqRunService({ connection: { host: '127.0.0.1', port: 6379 } });

    const [left, right] = await Promise.all([
      service.retry(previous.id),
      service.retry(previous.id),
    ]);

    expect(right.id).toBe(left.id);
    expect(left).toMatchObject({ attempt: 2, retryOf: previous.id });
    expect(createdJobs).toBe(1);
    await service.close();
  });
});
